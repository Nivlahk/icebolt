/**
 * Browser-only Google sign-in for Icebolt, built on Google Identity Services
 * (GIS) token model.
 *
 * Design constraints:
 * - No server, no client secret, no refresh token. The access token lives in
 *   memory in the user's tab; the developer never holds anything that can
 *   reach the user's Drive.
 * - Browser tokens last ~1 hour and cannot be renewed silently in the
 *   background: renewal opens a (usually instantly closing) Google popup,
 *   which browsers block unless it happens inside a user gesture. So this
 *   class renews *during* user activity shortly before expiry, and when that
 *   isn't possible it reports `needs-reconnect` so the app can show a button.
 */
import { IceboltSyncError } from '../sync/GoogleDriveSyncManager.js';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

// ----------------------------------------------------- GIS structural types

export interface GisTokenResponse {
  access_token?: string;
  expires_in?: string | number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface GisErrorEvent {
  /** e.g. `popup_failed_to_open`, `popup_closed`, `unknown`. */
  type?: string;
  message?: string;
}

export interface GisTokenClientConfig {
  client_id: string;
  scope: string;
  login_hint?: string;
  callback: (response: GisTokenResponse) => void;
  error_callback?: (error: GisErrorEvent) => void;
}

export interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

/** The subset of `google.accounts.oauth2` this module uses. */
export interface GisOAuth2 {
  initTokenClient(config: GisTokenClientConfig): GisTokenClient;
  hasGrantedAllScopes(response: GisTokenResponse, firstScope: string, ...restScopes: string[]): boolean;
  revoke(token: string, done?: () => void): void;
}

// --------------------------------------------------------------- public API

export type AuthState = 'signed-out' | 'signing-in' | 'signed-in' | 'needs-reconnect';

export type AuthEvent =
  | { type: 'state'; state: AuthState; previous: AuthState }
  | { type: 'token'; expiresAt: number }
  | { type: 'error'; error: IceboltAuthError };

export type AuthListener = (event: AuthEvent) => void;

export type AuthErrorCode =
  /** A popup is needed but the browser blocked it (no user gesture). Show a reconnect button. */
  | 'interaction-required'
  /** The user closed the popup or declined. */
  | 'cancelled'
  /** The user signed in but unchecked Drive access on Google's consent screen. */
  | 'scope-denied'
  | 'gis-unavailable'
  | 'failed';

export class IceboltAuthError extends IceboltSyncError {
  readonly authCode: AuthErrorCode;

  constructor(authCode: AuthErrorCode, message: string, cause?: unknown) {
    // Surfaces in the sync manager as a non-retryable `auth` error.
    super('auth', message, cause === undefined ? {} : { cause });
    this.name = 'IceboltAuthError';
    this.authCode = authCode;
  }
}

export interface GoogleDriveAuthOptions {
  /** OAuth 2.0 Web client ID from Google Cloud Console. No secret is needed or used. */
  clientId: string;
  /** Default `[drive.file]`. Add `DRIVE_APPDATA_SCOPE` only if you sync with `space: 'appDataFolder'`. */
  scopes?: string[];
  /** Pre-select an account in Google's chooser. */
  loginHint?: string;
  /** Start renewing this long before expiry. Default 5 minutes. */
  refreshWindowMs?: number;
  /** Renew the token inside user clicks/keypresses near expiry (keeps the popup unblocked). Default true. */
  refreshOnInteraction?: boolean;
  /** Document to watch for interaction. Defaults to the global document. */
  doc?: Document;
  /** Override how GIS is obtained (tests, CSP-controlled loading). */
  loadGis?: () => Promise<GisOAuth2>;
  /**
   * Load GIS immediately (default true). The popup must open synchronously inside
   * the user's click; if GIS is still loading at that moment the browser blocks it.
   */
  preload?: boolean;
  /** Clock override for tests. */
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Loads the GIS script once and resolves `google.accounts.oauth2`. */
export function loadGoogleIdentityServices(doc: Document = document): Promise<GisOAuth2> {
  const existing = (globalThis as { google?: { accounts?: { oauth2?: GisOAuth2 } } }).google?.accounts?.oauth2;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const done = (): void => {
      const api = (globalThis as { google?: { accounts?: { oauth2?: GisOAuth2 } } }).google?.accounts?.oauth2;
      if (api) resolve(api);
      else reject(new IceboltAuthError('gis-unavailable', 'Google Identity Services loaded but google.accounts.oauth2 is missing'));
    };
    let script = doc.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (!script) {
      script = doc.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      doc.head.append(script);
    }
    script.addEventListener('load', done, { once: true });
    const tag = script;
    tag.addEventListener(
      'error',
      () => {
        tag.remove(); // let a later attempt inject a fresh tag instead of waiting on a dead one
        reject(new IceboltAuthError('gis-unavailable', 'Could not load Google sign-in (blocked by network, CSP, or an extension)'));
      },
      { once: true },
    );
  });
}

export class GoogleDriveAuth {
  readonly #clientId: string;
  readonly #scopes: string[];
  readonly #loginHint: string | undefined;
  readonly #refreshWindowMs: number;
  readonly #now: () => number;
  readonly #loadGis: () => Promise<GisOAuth2>;
  readonly #listeners = new Set<AuthListener>();
  readonly #doc: Document | undefined;

  #state: AuthState = 'signed-out';
  #token: CachedToken | null = null;
  #gis: GisOAuth2 | null = null;
  #client: GisTokenClient | null = null;
  #inflight: Promise<string> | null = null;
  #pending: { resolve: (t: string) => void; reject: (e: IceboltAuthError) => void } | null = null;
  #removeInteraction: (() => void) | null = null;
  #everSignedIn = false;
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: GoogleDriveAuthOptions) {
    if (!options.clientId || !options.clientId.endsWith('.apps.googleusercontent.com')) {
      throw new TypeError('clientId must be an OAuth Web client ID ending in .apps.googleusercontent.com');
    }
    this.#clientId = options.clientId;
    this.#scopes = options.scopes?.length ? [...options.scopes] : [DRIVE_FILE_SCOPE];
    this.#loginHint = options.loginHint;
    this.#refreshWindowMs = options.refreshWindowMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#doc = options.doc ?? (globalThis as { document?: Document }).document;
    const doc = this.#doc;
    this.#loadGis =
      options.loadGis ??
      (() => {
        if (!doc) return Promise.reject(new IceboltAuthError('gis-unavailable', 'no document available to load Google sign-in'));
        return loadGoogleIdentityServices(doc);
      });
    if ((options.refreshOnInteraction ?? true) && doc) this.#watchInteraction(doc);
    if (options.preload ?? true) this.preload().catch(() => undefined); // signIn() reports load failures
  }

  get state(): AuthState {
    return this.#state;
  }

  /** Epoch ms when the current token expires, or null. */
  get expiresAt(): number | null {
    return this.#token?.expiresAt ?? null;
  }

  subscribe(listener: AuthListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Start fetching the GIS script early (e.g. on page load) so the first click opens the popup instantly. */
  async preload(): Promise<void> {
    await this.#ensureClient();
  }

  /**
   * Interactive sign-in / reconnect. Call from a click handler: browsers only
   * allow the Google popup inside a user gesture.
   */
  signIn(): Promise<string> {
    return this.#requestToken(this.#everSignedIn ? '' : undefined);
  }

  /** Alias for clarity in "Reconnect Google Drive" buttons. */
  reconnect(): Promise<string> {
    return this.signIn();
  }

  /**
   * Token for API calls. Returns the cached token while it is valid; once
   * expired it attempts a renewal, which succeeds when called during a user
   * gesture and otherwise rejects with `interaction-required`.
   * Pass this function to `bindAutoSync({ getAccessToken })`.
   */
  getAccessToken = async (): Promise<string> => {
    const t = this.#token;
    if (t && this.#now() < t.expiresAt - 30_000) return t.token;
    if (!this.#everSignedIn) {
      throw new IceboltAuthError('interaction-required', 'Not signed in to Google Drive yet; call signIn() from a click');
    }
    return this.#requestToken('');
  };

  /** Drop the cached token (e.g. Drive answered 401 because the user revoked access). */
  invalidate(): void {
    this.#token = null;
    if (this.#state === 'signed-in') this.#setState('needs-reconnect');
  }

  /** Revoke the token with Google and forget it. */
  signOut(): void {
    const t = this.#token;
    this.#token = null;
    this.#everSignedIn = false;
    this.#clearExpiryTimer();
    if (t && this.#gis) this.#gis.revoke(t.token, () => undefined);
    this.#setState('signed-out');
  }

  dispose(): void {
    this.#clearExpiryTimer();
    this.#removeInteraction?.();
    this.#removeInteraction = null;
    this.#listeners.clear();
  }

  // --------------------------------------------------------------- internals

  #emit(event: AuthEvent): void {
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

  #setState(next: AuthState): void {
    if (next === this.#state) return;
    const previous = this.#state;
    this.#state = next;
    this.#emit({ type: 'state', state: next, previous });
  }

  async #ensureClient(): Promise<GisTokenClient> {
    if (this.#client) return this.#client;
    const gis = await this.#loadGis();
    this.#gis = gis;
    const config: GisTokenClientConfig = {
      client_id: this.#clientId,
      scope: this.#scopes.join(' '),
      callback: (res) => this.#onResponse(res),
      error_callback: (err) => this.#onPopupError(err),
    };
    if (this.#loginHint) config.login_hint = this.#loginHint;
    this.#client = gis.initTokenClient(config);
    return this.#client;
  }

  /**
   * Must call `requestAccessToken` synchronously within the caller's gesture
   * when the client is already initialised — awaiting first would lose the
   * gesture and get the popup blocked.
   */
  #requestToken(prompt: string | undefined): Promise<string> {
    if (this.#inflight) return this.#inflight;
    const run = new Promise<string>((resolve, reject) => {
      this.#pending = { resolve, reject };
      const open = (client: GisTokenClient): void => {
        try {
          client.requestAccessToken(prompt === undefined ? {} : { prompt });
        } catch (err) {
          this.#settleError(new IceboltAuthError('failed', `Google sign-in failed to start: ${String(err)}`, err));
        }
      };
      this.#setState('signing-in');
      if (this.#client) open(this.#client);
      else
        this.#ensureClient().then(open, (err: unknown) =>
          this.#settleError(err instanceof IceboltAuthError ? err : new IceboltAuthError('gis-unavailable', String(err), err)),
        );
    });
    this.#inflight = run;
    const clear = (): void => {
      if (this.#inflight === run) this.#inflight = null;
    };
    run.then(clear, clear);
    return run;
  }

  #onResponse(res: GisTokenResponse): void {
    if (res.error || !res.access_token) {
      const code: AuthErrorCode = res.error === 'access_denied' ? 'cancelled' : 'failed';
      this.#settleError(new IceboltAuthError(code, `Google sign-in failed: ${res.error_description ?? res.error ?? 'no token returned'}`));
      return;
    }
    const gis = this.#gis;
    const [first, ...rest] = this.#scopes as [string, ...string[]];
    if (gis && !gis.hasGrantedAllScopes(res, first, ...rest)) {
      gis.revoke(res.access_token, () => undefined);
      this.#settleError(
        new IceboltAuthError('scope-denied', 'Google Drive access was not granted. Connect again and leave the Google Drive permission checked on Google\'s screen.'),
        'signed-out',
      );
      return;
    }
    const seconds = Number(res.expires_in);
    const expiresAt = this.#now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
    this.#token = { token: res.access_token, expiresAt };
    this.#everSignedIn = true;
    this.#armExpiryTimer(expiresAt);
    this.#setState('signed-in');
    this.#emit({ type: 'token', expiresAt });
    const p = this.#pending;
    this.#pending = null;
    p?.resolve(res.access_token);
  }

  #onPopupError(err: GisErrorEvent): void {
    const code: AuthErrorCode = err.type === 'popup_failed_to_open' ? 'interaction-required' : err.type === 'popup_closed' ? 'cancelled' : 'failed';
    const message =
      code === 'interaction-required'
        ? 'Google Drive session expired and the browser blocked the sign-in popup; reconnect from a button'
        : code === 'cancelled'
          ? 'Google sign-in was closed before finishing'
          : `Google sign-in failed: ${err.message ?? err.type ?? 'unknown error'}`;
    this.#settleError(new IceboltAuthError(code, message));
  }

  #settleError(error: IceboltAuthError, forceState?: AuthState): void {
    const valid = this.#token !== null && this.#now() < this.#token.expiresAt;
    this.#setState(forceState ?? (valid ? 'signed-in' : this.#everSignedIn ? 'needs-reconnect' : 'signed-out'));
    this.#emit({ type: 'error', error });
    const p = this.#pending;
    this.#pending = null;
    p?.reject(error);
  }

  /** Flip to `needs-reconnect` when the token lapses, so the UI can prompt before the next write fails. */
  #armExpiryTimer(expiresAt: number): void {
    this.#clearExpiryTimer();
    const timer = setTimeout(() => {
      this.#expiryTimer = null;
      if (this.#token && this.#now() >= this.#token.expiresAt && !this.#inflight) this.#setState('needs-reconnect');
    }, Math.max(0, expiresAt - this.#now()));
    (timer as { unref?: () => void }).unref?.();
    this.#expiryTimer = timer;
  }

  #clearExpiryTimer(): void {
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
  }

  #watchInteraction(doc: Document): void {
    const onActivity = (): void => {
      const t = this.#token;
      if (!this.#everSignedIn || this.#inflight || !this.#client) return;
      const expiring = !t || this.#now() >= t.expiresAt - this.#refreshWindowMs;
      if (expiring) this.#requestToken('').catch(() => undefined); // inside the gesture → popup allowed
    };
    doc.addEventListener('pointerdown', onActivity, true);
    doc.addEventListener('keydown', onActivity, true);
    this.#removeInteraction = () => {
      doc.removeEventListener('pointerdown', onActivity, true);
      doc.removeEventListener('keydown', onActivity, true);
    };
  }
}
