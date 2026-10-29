// Verbatim from docs/sync-and-storage.md ("Wiring it by hand"); type-checked by npm test.
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { createSqlJsDriver } from 'nivlahkicebolt/runtime';
import { GoogleDriveSyncManager, IceboltSyncError, bindAutoSync, readStorageSettings, writeStorageSettings } from 'nivlahkicebolt/sync';
import { GoogleDriveAuth, linkAuthToSync, renderDriveConnectButton } from 'nivlahkicebolt/auth';
import { renderStorageSettings } from 'nivlahkicebolt/ui';
import { openIceboltClient, schemaMeta } from './db/icebolt-client';

const auth = new GoogleDriveAuth({ clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID }); // loads Google's script now
const sync = new GoogleDriveSyncManager({ appId: 'my-app', folderName: 'My App' });
linkAuthToSync(auth, sync);           // expired token → "Reconnect"; reconnect → pending writes flushed
let passphrase: string | null = null; // memory only

document.body.append(renderDriveConnectButton(auth, {
  onConnected: async (token) => {
    if (db) return; // a reconnect: linkAuthToSync already flushed
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    let remote;
    try {
      remote = await sync.pull(token, null);              // plain file, or nothing saved yet
    } catch (e) {
      if (!(e instanceof IceboltSyncError && e.code === 'crypto')) throw e;
      passphrase = await askPassphrase('Enter your passphrase');
      remote = await sync.pull(token, passphrase);
    }
    db = openIceboltClient(createSqlJsDriver(new SQL.Database(remote?.bytes)));
    bindAutoSync(db, sync, { getAccessToken: auth.getAccessToken, getEncryptionKey: () => passphrase, schemaMeta, appLabel: 'My App' });
    document.body.append(renderStorageSettings({ settings: readStorageSettings(db), onChange: (next) => writeStorageSettings(db!, next) }));
  },
}));

let db: ReturnType<typeof openIceboltClient> | null = null;
declare function askPassphrase(message: string): Promise<string>; // your dialog
