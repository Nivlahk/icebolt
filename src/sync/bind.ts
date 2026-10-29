import type { SchemaMeta } from '../runtime/client.js';
import { buildNdjsonExports, type ExportableClient } from './export.js';
import { IceboltSyncError, type GoogleDriveSyncManager, type PushPayload } from './GoogleDriveSyncManager.js';
import { readStorageSettings, type SettingsStore } from './settings.js';

/** Structural view of `IceboltClient` needed for auto-sync. */
export interface SyncableClient extends SettingsStore, ExportableClient {
  readonly revision: number;
  readonly isDirty: boolean;
  export(): Uint8Array;
  markClean(upToRevision?: number): void;
  onChange(listener: () => void): () => void;
}

export interface AutoSyncOptions {
  /** Return a valid `drive.file` access token (refresh it here when it expires). */
  getAccessToken: () => string | Promise<string>;
  /** The user's passphrase. Only consulted while the encryption setting is on. */
  getEncryptionKey?: () => string | null | Promise<string | null>;
  /** The generated `schemaMeta`; needed for readable copies. */
  schemaMeta: SchemaMeta;
  /** Human label used in the readable-copies README. Default "app". */
  appLabel?: string;
  /** Flush pending writes when the tab is hidden (default `true` in browsers). */
  flushOnHide?: boolean;
}

/** Build the push payload for the client's current state and storage settings. */
export async function buildPushPayload(client: SyncableClient, options: Pick<AutoSyncOptions, 'getEncryptionKey' | 'schemaMeta' | 'appLabel'>): Promise<PushPayload> {
  const settings = readStorageSettings(client);
  const revision = client.revision;
  const bytes = client.export();

  let encryption: PushPayload['encryption'];
  if (settings.encryption === 'passphrase') {
    const key = (await options.getEncryptionKey?.()) ?? null;
    if (!key) throw new IceboltSyncError('crypto', 'encryption is on but no passphrase is available; ask the user to unlock');
    encryption = { mode: 'passphrase', key };
  } else {
    encryption = { mode: 'none' };
  }

  return {
    bytes,
    encryption,
    exports: settings.readableExport === 'ndjson' ? buildNdjsonExports(client, options.schemaMeta, options.appLabel ?? 'app') : null,
    commit: () => client.markClean(revision),
  };
}

/**
 * Wire a client to a sync manager: every committed mutation — including a
 * settings change — schedules a debounced push that applies the current
 * storage settings. `isDirty` is cleared only for the exact revision that
 * reached Drive, so writes made during an upload stay dirty.
 */
export function bindAutoSync(client: SyncableClient, sync: GoogleDriveSyncManager, options: AutoSyncOptions): () => void {
  const schedule = (): void =>
    sync.schedulePush({
      getAccessToken: options.getAccessToken,
      snapshot: () => buildPushPayload(client, options),
    });

  const unsubscribe = client.onChange(schedule);
  if (client.isDirty) schedule();

  let removeVisibility: (() => void) | null = null;
  const doc = (globalThis as { document?: Document }).document;
  if ((options.flushOnHide ?? true) && doc) {
    const onVisibility = (): void => {
      if (doc.visibilityState === 'hidden' && sync.hasPendingPush) void sync.flush().catch(() => undefined);
    };
    doc.addEventListener('visibilitychange', onVisibility);
    removeVisibility = () => doc.removeEventListener('visibilitychange', onVisibility);
  }

  return () => {
    unsubscribe();
    removeVisibility?.();
  };
}
