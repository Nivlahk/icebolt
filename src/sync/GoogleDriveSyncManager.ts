import {
  DEFAULT_PBKDF2_ITERATIONS,
  IceboltDecryptionError,
  KeyCache,
  freshKdfParams,
  openEnvelope,
  randomBytes,
  sealEnvelope,
  toArrayBuffer,
  type KdfParams,
} from './crypto.js';
import type { ExportFile } from './export.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
/** Google's ceiling for multipart uploads; larger bodies use a resumable session. */
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;
const FILE_FIELDS = 'id,name,modifiedTime,headRevisionId,size,trashed,appProperties,parents';
const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** First 16 bytes of every SQLite database file. */
const SQLITE_MAGIC = new TextEncoder().encode('SQLite format 3\0');

// --------------------------------------------------------------------- types

export type SyncState = 'idle' | 'pulling' | 'scheduled' | 'pushing' | 'backoff' | 'error' | 'disposed';

export type SyncErrorCode = 'auth' | 'rate-limit' | 'conflict' | 'not-found' | 'forbidden' | 'network' | 'timeout' | 'http' | 'crypto';

export class IceboltSyncError extends Error {
  readonly code: SyncErrorCode;
  readonly status: number | null;
  readonly reason: string | null;
  readonly retryable: boolean;

  constructor(code: SyncErrorCode, message: string, opts: { status?: number | null; reason?: string | null; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'IceboltSyncError';
    this.code = code;
    this.status = opts.status ?? null;
    this.reason = opts.reason ?? null;
    this.retryable = opts.retryable ?? false;
  }
}

export interface RemoteFileInfo {
  id: string;
  name: string;
  modifiedTime: string | null;
  headRevisionId: string | null;
  size: number | null;
  /** From the private `iceboltEncryption` tag; `null` if the file carries no tag. */
  encrypted: boolean | null;
  appProperties: Record<string, string>;
  parents: string[];
}

export interface PullResult {
  bytes: Uint8Array;
  /** Whether the remote file was encrypted (detected from its contents, not metadata). */
  encrypted: boolean;
  file: RemoteFileInfo;
}

/** How to store the main database file on this push. */
export type EncryptionChoice = { mode: 'passphrase'; key: string } | { mode: 'none' };

export interface PushRequest {
  bytes: Uint8Array;
  encryption: EncryptionChoice;
  /**
   * Readable copies: an array writes/updates them (unchanged files are skipped),
   * `null` moves any existing copies to the Drive trash, `undefined` leaves them alone.
   */
  exports?: ExportFile[] | null;
}

export type SyncEvent =
  | { type: 'state'; state: SyncState; previous: SyncState }
  | { type: 'pulled'; file: RemoteFileInfo | null; bytes: number; encrypted: boolean | null }
  | { type: 'pushed'; file: RemoteFileInfo; bytes: number; encrypted: boolean }
  | { type: 'exports'; uploaded: number; unchanged: number; trashed: number }
  | { type: 'revisions-purged'; deleted: number; failed: number }
  | { type: 'progress'; direction: 'download'; loaded: number; total: number | null }
  | { type: 'retry'; attempt: number; delayMs: number; error: IceboltSyncError }
  | { type: 'warning'; message: string }
  | { type: 'error'; error: unknown };

export type SyncListener = (event: SyncEvent) => void;

export interface GoogleDriveSyncOptions {
  /** Stable app identifier, stored as a private `appProperties` tag on every file the app writes. */
  appId: string;
  /**
   * Name of the folder that holds everything this app writes to My Drive, so its
   * files never mix with the user's own. Use the app's display name. Default: appId.
   */
  folderName?: string;
  /** Main file name without extension; `.icebolt` (encrypted) or `.sqlite` (plain) is appended. Default: appId. */
  fileBaseName?: string;
  /** Subfolder (inside the app folder) for readable copies. Default `Readable copies`. */
  exportFolderName?: string;
  /**
   * `'drive'` (default) works with the `drive.file` scope: the main file lives in
   * My Drive and only this OAuth client can list it. `'appDataFolder'` hides the
   * main file from the Drive UI but requires the `drive.appdata` scope.
   * Readable copies always go to My Drive — they exist to be seen.
   */
  space?: 'drive' | 'appDataFolder';
  /** Where to create the app folder in My Drive (folder ids). Default: My Drive root. */
  parents?: string[];
  /** Quiet period before a scheduled push fires. Default 2 000 ms. */
  debounceMs?: number;
  /** Upper bound a push can be deferred by continuous edits. Default 15 000 ms. */
  maxWaitMs?: number;
  /** Retries for 403 rate-limit / 429 / 5xx / network errors. Default 5. */
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Per-request timeout. Default 60 000 ms. */
  requestTimeoutMs?: number;
  /** `'reject'` (default) refuses to overwrite a remote revision this session has not seen. */
  conflictPolicy?: 'reject' | 'overwrite';
  /**
   * When encryption is turned on for a file that previously held plaintext,
   * delete its older Drive revisions so the unencrypted versions don't linger
   * in version history. Default `true`.
   */
  purgePlaintextRevisions?: boolean;
  pbkdf2Iterations?: number;
  /** Injectable for tests / non-browser runtimes. */
  fetch?: typeof fetch;
}

export type PushPayload = PushRequest & { commit?: () => void };

/** What a scheduled push needs at fire time (token and payload are read lazily, never at schedule time). */
export interface PushSource {
  getAccessToken: () => string | Promise<string>;
  /** Capture what to upload; `commit` runs only after the upload succeeded. */
  snapshot: () => PushPayload | Promise<PushPayload>;
}

interface RemoteCursor {
  known: boolean;
  fileId: string | null;
  revision: string | null;
}

type ResolvedOptions = Required<Omit<GoogleDriveSyncOptions, 'parents'>> & { parents: string[] | null };

// ------------------------------------------------------------------ helpers

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function revisionOf(file: RemoteFileInfo): string | null {
  return file.headRevisionId ?? file.modifiedTime;
}

function toFileInfo(raw: unknown): RemoteFileInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r['id'] !== 'string') throw new IceboltSyncError('http', 'Drive response did not include a file id');
  const props: Record<string, string> = {};
  const rawProps = r['appProperties'];
  if (rawProps && typeof rawProps === 'object') {
    for (const [k, v] of Object.entries(rawProps)) if (typeof v === 'string') props[k] = v;
  }
  const enc = props['iceboltEncryption'];
  return {
    id: r['id'],
    name: typeof r['name'] === 'string' ? r['name'] : '',
    modifiedTime: typeof r['modifiedTime'] === 'string' ? r['modifiedTime'] : null,
    headRevisionId: typeof r['headRevisionId'] === 'string' ? r['headRevisionId'] : null,
    size: typeof r['size'] === 'string' || typeof r['size'] === 'number' ? Number(r['size']) : null,
    encrypted: enc === undefined ? null : enc !== 'none',
    appProperties: props,
    parents: Array.isArray(r['parents']) ? (r['parents'] as unknown[]).filter((p): p is string => typeof p === 'string') : [],
  };
}

async function parseDriveError(res: Response): Promise<IceboltSyncError> {
  let message = `${res.status} ${res.statusText}`.trim();
  let reason: string | null = null;
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    if (body.error?.message) message = `${res.status}: ${body.error.message}`;
    reason = body.error?.errors?.[0]?.reason ?? null;
  } catch {
    /* non-JSON error body */
  }
  const opts = { status: res.status, reason };
  if (res.status === 401) return new IceboltSyncError('auth', `Google access token rejected (${message}); re-authenticate`, opts);
  if (res.status === 429 || (res.status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason))) {
    return new IceboltSyncError('rate-limit', `Google Drive rate limit (${message})`, { ...opts, retryable: true });
  }
  if (res.status === 403) return new IceboltSyncError('forbidden', `Google Drive refused the request (${message})`, opts);
  if (res.status === 404) return new IceboltSyncError('not-found', `Google Drive file not found (${message})`, opts);
  if (res.status === 408 || res.status >= 500) return new IceboltSyncError('http', `Google Drive server error (${message})`, { ...opts, retryable: true });
  return new IceboltSyncError('http', `Google Drive request failed (${message})`, opts);
}

function retryAfterMs(res: Response | null): number | null {
  const h = res?.headers.get('Retry-After');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isPlainSqlite(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SQLITE_MAGIC.byteLength) return false;
  for (let i = 0; i < SQLITE_MAGIC.byteLength; i++) if (bytes[i] !== SQLITE_MAGIC[i]) return false;
  return true;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function readBody(res: Response, onProgress: (loaded: number, total: number | null) => void): Promise<Uint8Array> {
  const lenHeader = res.headers.get('Content-Length');
  const total = lenHeader !== null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.byteLength, total);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// ------------------------------------------------------------------ manager

/**
 * Client-side sync of a SQLite database to the user's own Google Drive.
 *
 * Every request goes straight from the browser to Google with the user's
 * token; no developer server is in the path. Depending on the user's
 * settings the main file is AES-256-GCM encrypted with a passphrase only the
 * user holds, or stored as a bare SQLite file; optional readable copies
 * (NDJSON per table) can be kept in a visible folder for BigQuery & co.
 *
 * All Drive operations are serialized through a single queue.
 */
export class GoogleDriveSyncManager {
  readonly #o: ResolvedOptions;
  readonly #keys = new KeyCache();
  readonly #listeners = new Set<SyncListener>();
  #state: SyncState = 'idle';
  #queue: Promise<unknown> = Promise.resolve();
  #remote: RemoteCursor = { known: false, fileId: null, revision: null };
  #kdf: KdfParams | null = null;
  #kdfPassphrase: string | null = null;
  #exportsCleared = false;
  #appFolderId: string | null = null;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #firstScheduledAt: number | null = null;
  #pendingSource: PushSource | null = null;
  #failedSource: PushSource | null = null;
  readonly #inflight = new Set<Promise<void>>();

  constructor(options: GoogleDriveSyncOptions) {
    if (!options.appId || !/^[A-Za-z0-9._-]{1,100}$/.test(options.appId)) {
      throw new TypeError('appId must be 1–100 characters of [A-Za-z0-9._-]');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) throw new TypeError('fetch is not available in this runtime');
    this.#o = {
      appId: options.appId,
      folderName: options.folderName ?? options.appId,
      fileBaseName: options.fileBaseName ?? options.appId,
      exportFolderName: options.exportFolderName ?? 'Readable copies',
      space: options.space ?? 'drive',
      parents: options.parents ?? null,
      debounceMs: options.debounceMs ?? 2_000,
      maxWaitMs: options.maxWaitMs ?? 15_000,
      maxRetries: options.maxRetries ?? 5,
      baseBackoffMs: options.baseBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 32_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      conflictPolicy: options.conflictPolicy ?? 'reject',
      purgePlaintextRevisions: options.purgePlaintextRevisions ?? true,
      pbkdf2Iterations: options.pbkdf2Iterations ?? DEFAULT_PBKDF2_ITERATIONS,
      fetch: fetchImpl,
    };
  }

  // ---------------------------------------------------------------- public

  get state(): SyncState {
    return this.#state;
  }

  /** True while a debounced push is waiting or a previous scheduled push failed. */
  get hasPendingPush(): boolean {
    return this.#pendingSource !== null || this.#failedSource !== null;
  }

  get remoteFile(): Readonly<{ id: string | null; revision: string | null }> {
    return { id: this.#remote.fileId, revision: this.#remote.revision };
  }

  subscribe(listener: SyncListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Download the main database file. Encrypted vs. plain is detected from the
   * file's own bytes; `encryptionKey` may be `null` for a plain file. Returns
   * `null` when no remote database exists yet.
   */
  pull(accessToken: string, encryptionKey: string | null): Promise<PullResult | null> {
    this.#assertAlive();
    return this.#exclusive('pulling', async () => {
      const file = (await this.#list(accessToken, { iceboltRole: 'primary' }, [], this.#o.space, 'pulling'))[0] ?? null;
      if (!file) {
        this.#remote = { known: true, fileId: null, revision: null };
        this.#emit({ type: 'pulled', file: null, bytes: 0, encrypted: null });
        return null;
      }
      const res = await this.#request(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, { method: 'GET' }, accessToken, 'pulling');
      const raw = await readBody(res, (loaded, total) => this.#emit({ type: 'progress', direction: 'download', loaded, total }));

      let bytes: Uint8Array;
      let encrypted: boolean;
      if (isPlainSqlite(raw)) {
        bytes = raw;
        encrypted = false;
      } else {
        if (encryptionKey === null) throw new IceboltSyncError('crypto', 'this database is encrypted; a passphrase is required to open it');
        try {
          const opened = await openEnvelope(raw, encryptionKey, this.#keys);
          this.#kdf = opened.kdf;
          this.#kdfPassphrase = encryptionKey;
          bytes = opened.plaintext;
          encrypted = true;
        } catch (err) {
          throw err instanceof IceboltDecryptionError ? new IceboltSyncError('crypto', err.message, { cause: err }) : err;
        }
      }
      this.#remote = { known: true, fileId: file.id, revision: revisionOf(file) };
      this.#emit({ type: 'pulled', file, bytes: bytes.byteLength, encrypted });
      return { bytes, encrypted, file };
    });
  }

  /** Back-compatible: pull and return the database bytes (decrypting if needed). */
  async pullAndDecrypt(accessToken: string, encryptionKey: string | null): Promise<Uint8Array | null> {
    return (await this.pull(accessToken, encryptionKey))?.bytes ?? null;
  }

  /**
   * Upload the database according to `request.encryption`, then reconcile
   * readable copies. `PATCH` when the file exists, `POST` when new; multipart
   * ≤ 5 MB, resumable above. Rate-limit and transient errors retry with
   * jittered exponential backoff.
   */
  push(accessToken: string, request: PushRequest): Promise<RemoteFileInfo> {
    this.#assertAlive();
    return this.#exclusive('pushing', async () => {
      const encrypted = request.encryption.mode === 'passphrase';
      let body: Uint8Array;
      if (request.encryption.mode === 'passphrase') {
        const key = request.encryption.key;
        if (!key) throw new IceboltSyncError('crypto', 'encryption is on but no passphrase was provided');
        if (this.#kdf === null || this.#kdfPassphrase !== key) {
          this.#kdf = freshKdfParams(this.#o.pbkdf2Iterations);
          this.#kdfPassphrase = key;
        }
        body = await sealEnvelope(request.bytes, key, this.#kdf, this.#keys);
      } else {
        if (!isPlainSqlite(request.bytes)) throw new IceboltSyncError('crypto', 'refusing to upload: bytes are not a SQLite database');
        body = request.bytes;
      }

      const target = await this.#resolvePushTarget(accessToken);
      const metadata = this.#primaryMetadata(encrypted);
      const contentType = encrypted ? 'application/octet-stream' : 'application/vnd.sqlite3';
      const inDrive = this.#o.space === 'drive';
      const parents = inDrive ? [await this.#ensureAppFolder(accessToken)] : ['appDataFolder'];
      let file: RemoteFileInfo;
      try {
        file = await this.#uploadFile(accessToken, body, target?.id ?? null, metadata, contentType, parents);
      } catch (err) {
        if (!(target && err instanceof IceboltSyncError && err.code === 'not-found')) throw err;
        file = await this.#uploadFile(accessToken, body, null, metadata, contentType, parents);
      }
      if (inDrive) file = await this.#moveInto(accessToken, file, parents[0]!);
      this.#remote = { known: true, fileId: file.id, revision: revisionOf(file) };
      this.#emit({ type: 'pushed', file, bytes: body.byteLength, encrypted });

      if (encrypted && target?.encrypted === false && this.#o.purgePlaintextRevisions) {
        await this.#purgeOlderRevisions(accessToken, file);
      }
      if (request.exports !== undefined) await this.#syncExports(accessToken, request.exports);
      return file;
    });
  }

  /**
   * Save a separate copy (e.g. the database as it was before a schema upgrade)
   * into a "Backups" folder inside the app folder. Backups are never read back
   * as the live database and are never overwritten.
   */
  backup(accessToken: string, request: { bytes: Uint8Array; encryption: EncryptionChoice; label: string }): Promise<RemoteFileInfo> {
    this.#assertAlive();
    return this.#exclusive('pushing', async () => {
      const encrypted = request.encryption.mode === 'passphrase';
      let body = request.bytes;
      if (request.encryption.mode === 'passphrase') {
        const key = request.encryption.key;
        if (this.#kdf === null || this.#kdfPassphrase !== key) {
          this.#kdf = freshKdfParams(this.#o.pbkdf2Iterations);
          this.#kdfPassphrase = key;
        }
        body = await sealEnvelope(request.bytes, key, this.#kdf, this.#keys);
      }
      const appFolder = await this.#ensureAppFolder(accessToken);
      const folder =
        (await this.#list(accessToken, { iceboltRole: 'backup-folder' }, [`mimeType = '${FOLDER_MIME}'`], 'drive', 'pushing'))[0] ??
        (await this.#createFolder(accessToken, 'Backups', 'backup-folder', [appFolder], 'Copies kept before upgrades. Safe to delete once you no longer need them.'));
      const safeLabel = request.label.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
      return this.#uploadFile(
        accessToken,
        body,
        null,
        {
          name: `${this.#o.fileBaseName} ${safeLabel}.${encrypted ? 'icebolt' : 'sqlite'}`,
          mimeType: encrypted ? 'application/octet-stream' : 'application/vnd.sqlite3',
          appProperties: { icebolt: this.#o.appId, iceboltRole: 'backup', iceboltEncryption: encrypted ? 'aes-256-gcm' : 'none' },
        },
        encrypted ? 'application/octet-stream' : 'application/vnd.sqlite3',
        [folder.id],
      );
    });
  }

  /** Back-compatible: encrypted push that leaves readable copies untouched. */
  encryptAndPush(accessToken: string, dbBytes: Uint8Array, encryptionKey: string): Promise<RemoteFileInfo> {
    return this.push(accessToken, { bytes: dbBytes, encryption: { mode: 'passphrase', key: encryptionKey } });
  }

  /**
   * Debounced push. Rapid calls collapse into one upload that fires after
   * `debounceMs` of quiet, but never later than `maxWaitMs` after the first
   * call. The payload and token are captured at fire time, so the newest state wins.
   */
  schedulePush(source: PushSource): void {
    this.#assertAlive();
    this.#pendingSource = source;
    this.#failedSource = null;
    const now = Date.now();
    this.#firstScheduledAt ??= now;
    const deadline = this.#firstScheduledAt + this.#o.maxWaitMs;
    const wait = Math.max(0, Math.min(this.#o.debounceMs, deadline - now));
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#runScheduled();
    }, wait);
    if (this.#state === 'idle' || this.#state === 'error') this.#setState('scheduled');
  }

  /** Fire any pending (or previously failed) scheduled push immediately and wait for it. */
  async flush(): Promise<void> {
    this.#assertAlive();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#pendingSource === null && this.#failedSource !== null) {
      this.#pendingSource = this.#failedSource;
      this.#failedSource = null;
    }
    await Promise.all([...this.#inflight]);
    if (this.#pendingSource !== null) await this.#runScheduled();
  }

  cancelScheduled(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pendingSource = null;
    this.#failedSource = null;
    this.#firstScheduledAt = null;
    if (this.#state === 'scheduled') this.#setState('idle');
  }

  /** Forget the remote cursor (e.g. on sign-out). The next push behaves like a first push. */
  resetRemoteCursor(): void {
    this.#remote = { known: false, fileId: null, revision: null };
    this.#kdf = null;
    this.#kdfPassphrase = null;
    this.#exportsCleared = false;
    this.#appFolderId = null;
  }

  dispose(): void {
    this.cancelScheduled();
    this.#keys.clear();
    this.#kdf = null;
    this.#kdfPassphrase = null;
    this.#setState('disposed');
    this.#listeners.clear();
  }

  // --------------------------------------------------------------- internals

  #assertAlive(): void {
    if (this.#state === 'disposed') throw new Error('GoogleDriveSyncManager has been disposed');
  }

  #emit(event: SyncEvent): void {
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  #setState(next: SyncState): void {
    if (this.#state === next || this.#state === 'disposed') return;
    const previous = this.#state;
    this.#state = next;
    this.#emit({ type: 'state', state: next, previous });
  }

  #settledState(): SyncState {
    return this.#timer !== null || this.#pendingSource !== null ? 'scheduled' : 'idle';
  }

  #exclusive<T>(state: 'pulling' | 'pushing', fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      this.#assertAlive();
      this.#setState(state);
      try {
        const result = await fn();
        this.#setState(this.#settledState());
        return result;
      } catch (err) {
        this.#setState('error');
        this.#emit({ type: 'error', error: err });
        throw err;
      }
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #runScheduled(): Promise<void> {
    const source = this.#pendingSource;
    this.#pendingSource = null;
    this.#firstScheduledAt = null;
    if (!source || this.#state === 'disposed') return;

    const task = (async () => {
      try {
        let token: string;
        let payload: PushPayload;
        try {
          [token, payload] = await Promise.all([source.getAccessToken(), source.snapshot()]);
        } catch (err) {
          // Failures before the upload (missing passphrase, token refresh) must surface too.
          this.#setState('error');
          this.#emit({ type: 'error', error: err });
          throw err;
        }
        const { commit, ...request } = payload;
        await this.push(token, request);
        commit?.();
      } catch (err) {
        if (this.#state === 'disposed' || this.#pendingSource !== null) return; // newer edits supersede this attempt
        if (err instanceof IceboltSyncError && err.retryable) {
          // Per-request retries are exhausted; cool down, then try the whole push again.
          this.#pendingSource = source;
          if (this.#timer !== null) clearTimeout(this.#timer);
          this.#timer = setTimeout(() => {
            this.#timer = null;
            void this.#runScheduled();
          }, this.#o.maxBackoffMs);
          this.#setState('scheduled');
        } else {
          this.#failedSource = source; // auth / conflict / crypto: wait for flush() or a new schedulePush()
        }
      }
    })();
    this.#inflight.add(task);
    try {
      await task;
    } finally {
      this.#inflight.delete(task);
    }
  }

  async #request(url: string, init: RequestInit, accessToken: string, resumeState: SyncState): Promise<Response> {
    if (!accessToken) throw new IceboltSyncError('auth', 'missing Google access token');
    const maxAttempts = this.#o.maxRetries + 1;
    for (let attempt = 1; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${accessToken}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#o.requestTimeoutMs);

      let res: Response | null = null;
      let error: IceboltSyncError;
      try {
        res = await this.#o.fetch(url, { ...init, headers, signal: controller.signal, cache: 'no-store' });
        if (res.ok) return res;
        error = await parseDriveError(res);
      } catch (err) {
        error =
          err instanceof IceboltSyncError
            ? err
            : controller.signal.aborted
              ? new IceboltSyncError('timeout', `request timed out after ${this.#o.requestTimeoutMs} ms`, { retryable: true, cause: err })
              : new IceboltSyncError('network', `network error: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, cause: err });
      } finally {
        clearTimeout(timeout);
      }

      if (!error.retryable || attempt >= maxAttempts) throw error;
      const cap = Math.min(this.#o.maxBackoffMs, this.#o.baseBackoffMs * 2 ** (attempt - 1));
      const delayMs = Math.min(this.#o.maxBackoffMs, retryAfterMs(res) ?? cap / 2 + Math.random() * (cap / 2));
      this.#emit({ type: 'retry', attempt, delayMs, error });
      this.#setState('backoff');
      await sleep(delayMs);
      this.#assertAlive();
      this.#setState(resumeState);
    }
  }

  /** List this app's non-trashed files carrying the given private tags. Newest first. */
  async #list(
    accessToken: string,
    props: Record<string, string>,
    extraClauses: string[],
    space: 'drive' | 'appDataFolder',
    state: SyncState,
  ): Promise<RemoteFileInfo[]> {
    const clauses = [
      'trashed = false',
      `appProperties has { key='icebolt' and value='${escapeQuery(this.#o.appId)}' }`,
      ...Object.entries(props).map(([k, v]) => `appProperties has { key='${escapeQuery(k)}' and value='${escapeQuery(v)}' }`),
      ...extraClauses,
    ];
    const out: RemoteFileInfo[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: clauses.join(' and '),
        spaces: space,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        orderBy: 'modifiedTime desc',
        pageSize: '100',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.#request(`${DRIVE_API}/files?${params.toString()}`, { method: 'GET' }, accessToken, state);
      const body = (await res.json()) as { files?: unknown[]; nextPageToken?: string };
      out.push(...(body.files ?? []).map(toFileInfo));
      pageToken = body.nextPageToken;
    } while (pageToken);
    if (props['iceboltRole'] === 'primary' && out.length > 1) {
      this.#emit({ type: 'warning', message: `found ${out.length} database files on Drive; using the most recently modified (${out[0]!.id})` });
    }
    return out;
  }

  async #getMetadata(accessToken: string, fileId: string): Promise<(RemoteFileInfo & { trashed: boolean }) | null> {
    try {
      const res = await this.#request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`, { method: 'GET' }, accessToken, 'pushing');
      const raw = (await res.json()) as Record<string, unknown>;
      return { ...toFileInfo(raw), trashed: raw['trashed'] === true };
    } catch (err) {
      if (err instanceof IceboltSyncError && err.code === 'not-found') return null;
      throw err;
    }
  }

  /** The existing main file to PATCH, or null to POST a new one. Enforces the conflict policy. */
  async #resolvePushTarget(accessToken: string): Promise<RemoteFileInfo | null> {
    const reject = this.#o.conflictPolicy === 'reject';

    if (!this.#remote.known || this.#remote.fileId === null) {
      const existing = (await this.#list(accessToken, { iceboltRole: 'primary' }, [], this.#o.space, 'pushing'))[0] ?? null;
      if (existing && reject && revisionOf(existing) !== this.#remote.revision) {
        throw new IceboltSyncError('conflict', 'a remote database exists that this session has not pulled; call pull() first (or use conflictPolicy: "overwrite")');
      }
      return existing;
    }

    const meta = await this.#getMetadata(accessToken, this.#remote.fileId);
    if (!meta || meta.trashed) {
      this.#emit({ type: 'warning', message: 'remote database was deleted or trashed; creating a new file' });
      return null;
    }
    if (reject && this.#remote.revision !== null && revisionOf(meta) !== this.#remote.revision) {
      throw new IceboltSyncError('conflict', 'the remote database changed since the last sync (another device wrote it); pull and merge before pushing');
    }
    return meta;
  }

  #primaryMetadata(encrypted: boolean): Record<string, unknown> {
    return {
      name: `${this.#o.fileBaseName}.${encrypted ? 'icebolt' : 'sqlite'}`,
      mimeType: encrypted ? 'application/octet-stream' : 'application/vnd.sqlite3',
      description: encrypted
        ? 'Encrypted app database. Readable only with your passphrase.'
        : 'App database (SQLite). Open with any SQLite tool, e.g. DB Browser for SQLite.',
      appProperties: { icebolt: this.#o.appId, iceboltRole: 'primary', iceboltEncryption: encrypted ? 'aes-256-gcm' : 'none' },
    };
  }

  /** Create (fileId null) or replace content + metadata of a file. */
  async #uploadFile(
    accessToken: string,
    content: Uint8Array,
    fileId: string | null,
    metadata: Record<string, unknown>,
    contentType: string,
    parentsOnCreate: string[] | null,
  ): Promise<RemoteFileInfo> {
    const fields = `fields=${encodeURIComponent(FILE_FIELDS)}`;
    const path = fileId === null ? `${DRIVE_UPLOAD}/files` : `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}`;
    const method = fileId === null ? 'POST' : 'PATCH';
    // `parents` may only be set on create; moves need addParents/removeParents.
    const meta = fileId === null && parentsOnCreate ? { ...metadata, parents: parentsOnCreate } : metadata;
    const body = toArrayBuffer(content);

    if (content.byteLength > SIMPLE_UPLOAD_LIMIT) {
      const init = await this.#request(
        `${path}?uploadType=resumable&${fields}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': contentType,
            'X-Upload-Content-Length': String(content.byteLength),
          },
          body: JSON.stringify(meta),
        },
        accessToken,
        'pushing',
      );
      const session = init.headers.get('Location');
      if (!session) throw new IceboltSyncError('http', 'resumable upload session URL missing (Location header not exposed)');
      const res = await this.#request(session, { method: 'PUT', headers: { 'Content-Type': contentType }, body }, accessToken, 'pushing');
      return toFileInfo(await res.json());
    }

    const boundary = `icebolt-${Array.from(randomBytes(12), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const multipart = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      body,
      `\r\n--${boundary}--`,
    ]);
    const res = await this.#request(
      `${path}?uploadType=multipart&${fields}`,
      { method, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart },
      accessToken,
      'pushing',
    );
    return toFileInfo(await res.json());
  }

  async #createFolder(accessToken: string, name: string, role: string, parents: string[] | null, description: string): Promise<RemoteFileInfo> {
    const meta: Record<string, unknown> = { name, mimeType: FOLDER_MIME, description, appProperties: { icebolt: this.#o.appId, iceboltRole: role } };
    if (parents?.length) meta['parents'] = parents;
    const res = await this.#request(
      `${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(meta) },
      accessToken,
      'pushing',
    );
    return toFileInfo(await res.json());
  }

  /** The folder named after the app that holds everything it writes to My Drive. Created on first use. */
  async #ensureAppFolder(accessToken: string): Promise<string> {
    if (this.#appFolderId) return this.#appFolderId;
    const found = (await this.#list(accessToken, { iceboltRole: 'app-folder' }, [`mimeType = '${FOLDER_MIME}'`], 'drive', 'pushing'))[0];
    const folder = found ?? (await this.#createFolder(accessToken, this.#o.folderName, 'app-folder', this.#o.parents, 'Files saved by this app. Your data, in your Drive.'));
    this.#appFolderId = folder.id;
    return folder.id;
  }

  /** Move a file this app created into its folder (files from earlier versions may sit at the root). */
  async #moveInto(accessToken: string, file: RemoteFileInfo, folderId: string): Promise<RemoteFileInfo> {
    if (file.parents.includes(folderId) || !file.parents.length) return file;
    const params = new URLSearchParams({ addParents: folderId, removeParents: file.parents.join(','), fields: FILE_FIELDS });
    const res = await this.#request(
      `${DRIVE_API}/files/${encodeURIComponent(file.id)}?${params.toString()}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: '{}' },
      accessToken,
      'pushing',
    );
    return toFileInfo(await res.json());
  }

  async #trash(accessToken: string, fileId: string): Promise<void> {
    try {
      await this.#request(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ trashed: true }) },
        accessToken,
        'pushing',
      );
    } catch (err) {
      if (!(err instanceof IceboltSyncError && err.code === 'not-found')) throw err;
    }
  }

  /** Delete every revision except the current head, so earlier plaintext versions don't survive in version history. */
  async #purgeOlderRevisions(accessToken: string, file: RemoteFileInfo): Promise<void> {
    const base = `${DRIVE_API}/files/${encodeURIComponent(file.id)}/revisions`;
    const res = await this.#request(`${base}?fields=${encodeURIComponent('revisions(id)')}&pageSize=1000`, { method: 'GET' }, accessToken, 'pushing');
    const body = (await res.json()) as { revisions?: Array<{ id?: string }> };
    let deleted = 0;
    let failed = 0;
    for (const rev of body.revisions ?? []) {
      if (!rev.id || rev.id === file.headRevisionId) continue;
      try {
        await this.#request(`${base}/${encodeURIComponent(rev.id)}`, { method: 'DELETE' }, accessToken, 'pushing');
        deleted++;
      } catch {
        failed++;
      }
    }
    this.#emit({ type: 'revisions-purged', deleted, failed });
    if (failed > 0) {
      this.#emit({ type: 'warning', message: `${failed} earlier unencrypted version(s) could not be deleted from Drive version history` });
    }
  }

  async #syncExports(accessToken: string, exports: ExportFile[] | null): Promise<void> {
    if (exports === null) {
      if (this.#exportsCleared) return;
      const files = await this.#list(accessToken, { iceboltRole: 'export' }, [], 'drive', 'pushing');
      const folders = await this.#list(accessToken, { iceboltRole: 'export-folder' }, [], 'drive', 'pushing');
      for (const f of [...files, ...folders]) await this.#trash(accessToken, f.id);
      this.#exportsCleared = true;
      if (files.length + folders.length > 0) this.#emit({ type: 'exports', uploaded: 0, unchanged: 0, trashed: files.length + folders.length });
      return;
    }
    this.#exportsCleared = false;

    const appFolder = await this.#ensureAppFolder(accessToken);
    let folder = (await this.#list(accessToken, { iceboltRole: 'export-folder' }, [`mimeType = '${FOLDER_MIME}'`], 'drive', 'pushing'))[0];
    if (!folder) {
      folder = await this.#createFolder(accessToken, this.#o.exportFolderName, 'export-folder', [appFolder], 'Readable copies of your app data, regenerated on every sync.');
    } else {
      folder = await this.#moveInto(accessToken, folder, appFolder);
    }

    const existing = new Map<string, RemoteFileInfo>();
    for (const f of await this.#list(accessToken, { iceboltRole: 'export' }, [`'${escapeQuery(folder.id)}' in parents`], 'drive', 'pushing')) {
      const key = f.appProperties['iceboltExport'];
      if (key && !existing.has(key)) existing.set(key, f);
    }

    let uploaded = 0;
    let unchanged = 0;
    for (const file of exports) {
      const hash = await sha256Hex(file.content);
      const current = existing.get(file.key);
      if (current && current.appProperties['iceboltSha256'] === hash) {
        unchanged++;
        continue;
      }
      const meta = {
        name: file.name,
        mimeType: file.mimeType,
        appProperties: { icebolt: this.#o.appId, iceboltRole: 'export', iceboltExport: file.key, iceboltSha256: hash },
      };
      await this.#uploadFile(accessToken, file.content, current?.id ?? null, meta, file.mimeType, [folder.id]);
      uploaded++;
    }

    const keep = new Set(exports.map((e) => e.key));
    let trashed = 0;
    for (const [key, f] of existing) {
      if (keep.has(key)) continue;
      await this.#trash(accessToken, f.id);
      trashed++;
    }
    this.#emit({ type: 'exports', uploaded, unchanged, trashed });
  }
}
