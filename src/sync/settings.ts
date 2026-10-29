/**
 * User-facing storage settings. They are stored inside the database
 * (`__icebolt_meta`), so they travel with the data to every device.
 *
 * Note what is *not* a setting: developer access. No Icebolt code path sends
 * data or tokens to the developer, so there is nothing to switch off — the
 * custody statement is shown as a fixed fact instead of a toggle.
 */

/** `passphrase`: AES-256-GCM, key derived from a passphrase only the user holds. `none`: a bare SQLite file. */
export type EncryptionSetting = 'passphrase' | 'none';

/** `ndjson`: one readable JSON-lines file per table (+ BigQuery schema), regenerated on every sync. */
export type ReadableExportSetting = 'none' | 'ndjson';

export interface StorageSettings {
  encryption: EncryptionSetting;
  readableExport: ReadableExportSetting;
}

export const DEFAULT_STORAGE_SETTINGS: Readonly<StorageSettings> = Object.freeze({
  encryption: 'passphrase',
  readableExport: 'none',
});

/** Shown verbatim in the settings UI. True for every combination of settings. */
export const DATA_CUSTODY_STATEMENT =
  'Your data moves only between this device and your own Google Drive. The developer of this app runs no server that receives it and has no access to your Google account.';

const META_KEY = 'storage';

export interface SettingsStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export function parseStorageSettings(raw: string | null): StorageSettings {
  if (raw === null) return { ...DEFAULT_STORAGE_SETTINGS };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof StorageSettings, unknown>>;
    return {
      encryption: v.encryption === 'none' ? 'none' : 'passphrase',
      readableExport: v.readableExport === 'ndjson' ? 'ndjson' : 'none',
    };
  } catch {
    return { ...DEFAULT_STORAGE_SETTINGS };
  }
}

export function readStorageSettings(store: SettingsStore): StorageSettings {
  return parseStorageSettings(store.getMeta(META_KEY));
}

/** Persist settings. Because this is a database write, it schedules a sync that applies them. */
export function writeStorageSettings(store: SettingsStore, settings: StorageSettings): void {
  store.setMeta(META_KEY, JSON.stringify({ encryption: settings.encryption, readableExport: settings.readableExport }));
}

export interface StorageSettingsSummary {
  /** Who can read the main database file. */
  database: string;
  /** Who can read the readable copies, or null when they are off. */
  readableCopies: string | null;
  warnings: string[];
}

/** Plain-language consequences of a settings combination, for display next to the controls. */
export function describeStorageSettings(s: StorageSettings): StorageSettingsSummary {
  const warnings: string[] = [];
  const database =
    s.encryption === 'passphrase'
      ? 'Only someone with your passphrase. Google stores it but cannot read it; neither can the developer.'
      : 'You, and Google (like any file in your Drive). Not the developer. You can download it and open it in any SQLite tool.';
  if (s.encryption === 'passphrase') {
    warnings.push('If you lose your passphrase, your data cannot be recovered by anyone.');
  }
  let readableCopies: string | null = null;
  if (s.readableExport === 'ndjson') {
    readableCopies =
      'You, Google, and anyone you share the folder with. They are plain JSON files you can query with BigQuery or open in other tools.';
    if (s.encryption === 'passphrase') {
      warnings.push('Readable copies are not encrypted, so Google can read them even though the main database is encrypted.');
    }
  }
  return { database, readableCopies, warnings };
}
