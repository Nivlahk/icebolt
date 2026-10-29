/**
 * The whole "your data, your Drive" experience in one call.
 *
 *   createIceboltApp({ appId, appName, clientId, open: openIceboltClient, schemaMeta, sqlite, mount, onReady })
 *
 * - The app works immediately with an in-memory database (nothing to set up).
 * - "Connect Google Drive" signs in, then either opens the user's existing data
 *   (unlocking it if encrypted, upgrading it if the schema changed) or asks how
 *   to store a new library and saves what they have done so far.
 * - Every change then syncs automatically; a Storage dropdown shows status,
 *   storage settings and Disconnect.
 *
 * `onReady(client)` runs whenever the active database changes (local start,
 * after connecting, after disconnecting): re-render from it.
 */
import { GoogleDriveAuth, IceboltAuthError } from '../auth/GoogleDriveAuth.js';
import { linkAuthToSync } from '../auth/link.js';
import { renderDriveConnectButton } from '../auth/connectButton.js';
import { IceboltMigrationError } from '../schema/migrate.js';
import type { SchemaOpenResult } from '../runtime/bootstrap.js';
import type { SchemaMeta } from '../runtime/client.js';
import { createSqlJsDriver, type SqlJsDatabaseLike, type SqliteDriver } from '../runtime/driver.js';
import { IceboltSchemaMismatchError, IceboltSchemaTooNewError } from '../runtime/errors.js';
import { bindAutoSync, type SyncableClient } from '../sync/bind.js';
import { GoogleDriveSyncManager, IceboltSyncError, type SyncEvent } from '../sync/GoogleDriveSyncManager.js';
import { DATA_CUSTODY_STATEMENT, readStorageSettings, writeStorageSettings, type StorageSettings } from '../sync/settings.js';
import { renderStorageSettings } from '../ui/settingsPanel.js';
import { askPassphrase, chooseStorage, el, newPassphrase } from './dialogs.js';
import { injectStyles } from './styles.js';

type Migrated = Extract<SchemaOpenResult, { status: 'migrated' }>;

/** What `initSqlJs(...)` from the sql.js package resolves to (structurally). */
export interface SqlJsLike {
  Database: new (data?: Uint8Array) => SqlJsDatabaseLike;
}

/** Type of the sql.js default export, for apps without sql.js type definitions. */
export type SqlJsInit = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsLike>;

export interface IceboltAppOptions<C extends SyncableClient> {
  /** Stable id; tags the app's Drive files. Letters, digits, . _ - */
  appId: string;
  /** Shown to users; also the name of the app's folder in their Drive. */
  appName: string;
  /** OAuth Web client ID. Empty → the app runs locally and says Drive saving is not set up. */
  clientId?: string | null;
  /** The generated `openIceboltClient`. */
  open: (driver: SqliteDriver, options?: { onMigrated?: (result: Migrated) => void }) => C;
  /** The generated `schemaMeta` (for readable copies). */
  schemaMeta: SchemaMeta;
  /** Load SQLite: e.g. `() => initSqlJs({ locateFile: () => wasmUrl })`. */
  sqlite: () => Promise<SqlJsLike>;
  /** Where to put the Connect / Storage controls. */
  mount: HTMLElement;
  /** Called with the active database whenever it changes. */
  onReady: (client: C) => void;
  /** Inject the default styles (default true). */
  styles?: boolean;
  /** Show a short message to the user (default: the status line in the dropdown, plus alert for errors). */
  notify?: (message: string, kind: 'info' | 'error') => void;
}

export interface IceboltApp<C> {
  /** The active database (null until SQLite has loaded). */
  readonly client: C | null;
  readonly connected: boolean;
  /** Start the Google sign-in. Call from a click handler. */
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  /** Resolves once the local database is ready. */
  readonly ready: Promise<C>;
}

export function createIceboltApp<C extends SyncableClient>(options: IceboltAppOptions<C>): IceboltApp<C> {
  if (options.styles ?? true) injectStyles();
  const auth = options.clientId ? new GoogleDriveAuth({ clientId: options.clientId }) : null;
  const notify = options.notify ?? ((m: string, kind: 'info' | 'error') => (kind === 'error' ? window.alert(m) : undefined));

  let SQL: SqlJsLike | null = null;
  let client: C | null = null;
  let sync: GoogleDriveSyncManager | null = null;
  let passphrase: string | null = null;
  let connecting: Promise<boolean> | null = null;

  const bar = el('div', { className: 'icebolt-bar' });
  const status = el('p', { className: 'icebolt-status' });
  status.setAttribute('role', 'status');
  const summary = el('summary', { className: 'icebolt-btn', textContent: 'Storage' });
  const panel = el('div', { className: 'icebolt-pop' });
  const menu = el('details', { className: 'icebolt-menu' }, summary, panel);
  options.mount.append(bar);

  const setStatus = (text: string, kind: 'ok' | 'busy' | 'err' = 'ok'): void => {
    status.textContent = text;
    status.dataset['kind'] = kind;
  };

  const activate = (next: C): void => {
    client = next;
    options.onReady(next);
  };

  const openLocal = (): C => {
    const c = options.open(createSqlJsDriver(new SQL!.Database()));
    activate(c);
    return c;
  };

  // ---------------------------------------------------------------- render

  const renderBar = (): void => {
    if (!auth) {
      bar.replaceChildren(el('span', { className: 'icebolt-small', textContent: 'Saving to Google Drive is not set up yet (developer: run npx icebolt setup google).' }));
      return;
    }
    if (!sync) {
      bar.replaceChildren(el('button', { type: 'button', className: 'icebolt-btn icebolt-btn--primary', textContent: 'Connect Google Drive', title: DATA_CUSTODY_STATEMENT, onclick: () => void app.connect() }));
      return;
    }
    renderPanel();
    bar.replaceChildren(menu);
  };

  const renderPanel = (): void => {
    if (!sync || !client) return;
    const settingsOpen = panel.querySelector<HTMLDetailsElement>('.icebolt-settings')?.open ?? false;
    const settings = el(
      'details',
      { className: 'icebolt-settings', open: settingsOpen },
      el('summary', { textContent: 'Storage settings' }),
      renderStorageSettings({ settings: readStorageSettings(client), onChange: (next) => changeSettings(next) }),
    );
    const disconnect = el('button', { type: 'button', className: 'icebolt-btn', textContent: 'Disconnect Google Drive', onclick: () => void app.disconnect() });
    panel.replaceChildren(status, settings, disconnect);
  };

  menu.addEventListener('toggle', () => {
    if (menu.open) renderPanel();
  });
  document.addEventListener('click', (e) => {
    const path = e.composedPath();
    if (menu.open && !path.includes(menu) && !path.some((n) => n instanceof HTMLDialogElement)) menu.open = false;
  });

  const changeSettings = async (next: StorageSettings): Promise<void> => {
    if (next.encryption === 'passphrase' && !passphrase) {
      const p = await newPassphrase('Only this passphrase will open your data. If you lose it, nobody can recover it.');
      if (!p) throw new Error('Encryption not turned on.');
      passphrase = p;
    }
    writeStorageSettings(client!, next);
  };

  const onSync = (e: SyncEvent): void => {
    if (e.type === 'state') {
      if (e.state === 'scheduled' || e.state === 'pushing') setStatus('Saving to your Drive…', 'busy');
      else if (e.state === 'backoff') setStatus('Google asked us to slow down; retrying…', 'busy');
    } else if (e.type === 'pushed') {
      summary.classList.remove('icebolt-attn');
      setStatus(`Saved to “${options.appName}” in your Drive (${e.encrypted ? 'encrypted' : 'plain file'}) · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    } else if (e.type === 'error') {
      summary.classList.add('icebolt-attn');
      const err = e.error;
      if (err instanceof IceboltAuthError || (err instanceof IceboltSyncError && err.code === 'auth')) {
        setStatus('Your Google session expired. Reconnect to keep saving; nothing is lost.', 'err');
        if (auth && !panel.querySelector('.icebolt-reconnect')) {
          const b = renderDriveConnectButton(auth);
          b.classList.add('icebolt-reconnect');
          status.after(b);
        }
      } else if (err instanceof IceboltSyncError && err.code === 'conflict') {
        setStatus('Your data changed on another device. Reload to get the latest before making changes here.', 'err');
      } else {
        setStatus(`Couldn’t save to Drive: ${err instanceof Error ? err.message : String(err)}`, 'err');
      }
    }
  };

  // ---------------------------------------------------------------- connect

  const openRemote = async (token: string): Promise<boolean> => {
    const s = new GoogleDriveSyncManager({ appId: options.appId, folderName: options.appName, fileBaseName: options.appId });
    let pulled = await s.pull(token, null).catch(async (err: unknown) => {
      if (!(err instanceof IceboltSyncError && err.code === 'crypto')) throw err;
      let message = 'Your data is encrypted. Enter the passphrase you chose.';
      for (;;) {
        const p = await askPassphrase(message);
        if (p === null) return 'cancelled' as const;
        try {
          const r = await s.pull(token, p);
          passphrase = p;
          return r;
        } catch (e) {
          if (!(e instanceof IceboltSyncError && e.code === 'crypto')) throw e;
          message = 'That passphrase didn’t open it. Try again.';
        }
      }
    });
    if (pulled === 'cancelled') return false;

    let target: C;
    let migrated: Migrated | null = null;
    if (pulled) {
      if (client?.isDirty && !window.confirm('You already have saved data in Google Drive. Open it? What you did here before connecting will be replaced.')) return false;
      target = options.open(createSqlJsDriver(new SQL!.Database(pulled.bytes)), { onMigrated: (r) => (migrated = r) });
    } else {
      const choice = await chooseStorage(options.appName);
      if (!choice) return false;
      passphrase = choice.passphrase;
      target = client ?? openLocal();
      writeStorageSettings(target, choice.settings); // first write: creates the file in Drive
    }

    linkAuthToSync(auth!, s);
    bindAutoSync(target, s, { getAccessToken: auth!.getAccessToken, getEncryptionKey: () => passphrase, schemaMeta: options.schemaMeta, appLabel: options.appName });
    s.subscribe(onSync);
    sync = s;
    setStatus('Connected to your Google Drive.');
    if (target !== client) activate(target);
    const up = migrated as Migrated | null;
    if (up) {
      const encryption = readStorageSettings(target).encryption === 'passphrase' && passphrase ? { mode: 'passphrase' as const, key: passphrase } : { mode: 'none' as const };
      await s.backup(token, { bytes: up.backup, encryption, label: `before update v${up.version} ${new Date().toISOString().slice(0, 10)}` });
      notify('Your data was updated for this version of the app. A copy of the old version is in Backups in your Drive.', 'info');
    }
    renderBar();
    return true;
  };

  const ready = options.sqlite().then((sql) => {
    SQL = sql;
    renderBar();
    return openLocal();
  });

  const app: IceboltApp<C> = {
    get client() {
      return client;
    },
    get connected() {
      return sync !== null;
    },
    ready,
    connect() {
      if (!auth) return Promise.resolve(false);
      if (sync) return Promise.resolve(true);
      connecting ??= auth
        .signIn() // synchronous inside the click, so the popup is allowed
        .then(async (token) => {
          await ready;
          return openRemote(token);
        })
        .catch((err: unknown) => {
          auth.signOut();
          if (err instanceof IceboltAuthError && err.authCode === 'cancelled') return false;
          const msg =
            err instanceof IceboltSchemaTooNewError
              ? 'Your data was updated by a newer version of this app. Reload to get it; nothing was changed.'
              : err instanceof IceboltMigrationError
                ? 'Your data could not be updated for this version of the app, so nothing was changed.'
                : err instanceof IceboltSchemaMismatchError
                  ? 'The file in your Drive was not made by this app.'
                  : err instanceof Error
                    ? err.message
                    : String(err);
          notify(msg, 'error');
          return false;
        })
        .finally(() => {
          connecting = null;
        });
      return connecting;
    },
    async disconnect() {
      await sync?.flush().catch(() => undefined);
      sync?.dispose();
      sync = null;
      passphrase = null;
      auth?.signOut();
      setStatus('');
      menu.open = false;
      openLocal();
      renderBar();
    },
  };
  return app;
}
