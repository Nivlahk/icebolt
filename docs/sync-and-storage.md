# Sync and storage

## Where the data goes

Everything an app writes goes into one folder named after it, at the top of the user's My Drive:

```
My Drive/
└── My App/
    ├── my-app.icebolt            the database (my-app.sqlite when not encrypted)
    ├── Readable copies/          only if the user turns it on
    │   ├── notes.ndjson
    │   └── notes.bigquery-schema.json
    └── Backups/                  pre-upgrade copies, see migrations.md
```

The app asks only for the `drive.file` scope: it can see the files it created and nothing else in the user's Drive. Files are tagged with private `appProperties`, so renaming or moving them in Drive doesn't break anything. Files saved by older versions of an app are moved into the folder automatically.

## Storage settings (the user's choice)

| Setting | Values | Effect on Drive |
|---|---|---|
| Encrypt with my passphrase | on / off | On: `my-app.icebolt`, AES-256-GCM, unreadable to Google. Off: `my-app.sqlite`, a normal SQLite file the user can download and open. |
| Readable copies for analysis | off / JSON files | A “Readable copies” folder with `<table>.ndjson` and `<table>.bigquery-schema.json` per table, regenerated on sync (unchanged tables skipped). Turning it off moves them to Drive's trash. |

The first time a user connects, the app shell asks which they want. They can change it any time under **Storage → Storage settings**. The settings are stored inside the database itself, so they follow the user to every device.

Developer access is deliberately **not** a setting: no code path sends data or tokens to the developer, so the panel states it as a fixed fact (`DATA_CUSTODY_STATEMENT`). That guarantee rests on the shipped client code; publishing your app's code is what lets users verify it.

Turning encryption on also deletes the file's older Drive revisions, so unencrypted versions don't survive in version history (`purgePlaintextRevisions`, on by default). Readable copies are plaintext by design; the panel warns when they're on alongside encryption.

### Querying readable copies with BigQuery

From the user's own Google Cloud project:

```bash
gcloud auth login --enable-gdrive-access
bq mkdef --source_format=NEWLINE_DELIMITED_JSON "https://drive.google.com/open?id=FILE_ID" notes.bigquery-schema.json > notes_def.json
bq mk --external_table_definition=notes_def.json mydataset.notes
```

## How syncing works

- **Saves are automatic.** Every write marks the database dirty; a push is scheduled after 2 s of quiet (`debounceMs`), and never later than 15 s after the first change (`maxWaitMs`). Pushes are serialized, and the dirty flag is only cleared for the revision that was actually uploaded.
- **Rate limits and outages:** 403 `rateLimitExceeded` / `userRateLimitExceeded`, 429, 5xx and network errors retry with jittered exponential backoff and honor `Retry-After` (`maxRetries`, default 5).
- **Two devices:** before each push the remote revision is compared with the one this session last saw. If another device wrote in between, the push is refused and the user is told to reload, rather than silently overwriting. (`conflictPolicy: 'overwrite'` turns this off.)
- **Uploads:** multipart `POST` / `PATCH` up to 5 MB, resumable uploads above.

## Encryption

PBKDF2-SHA256 (600,000 iterations, per-file random salt) derives a non-extractable AES-256-GCM key; every write uses a fresh 96-bit IV. The 38-byte header (magic `ICEB`, version, KDF parameters, salt, IV) is authenticated as additional data, so it can't be altered. Iteration counts outside 100k–10M are rejected on read. The passphrase lives only in memory; it is never stored or sent anywhere. Lose it and the data is gone; that is the point.

## Wiring it by hand

`createIceboltApp` (what `icebolt init` sets up) covers the usual flow. If you want your own UI, the pieces are separate:

```ts
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
```

Lower level still, `sync.pullAndDecrypt(token, passphrase)` and `sync.encryptAndPush(token, bytes, passphrase)` move raw bytes, and `sync.schedulePush(...)` / `flush()` control timing yourself.
