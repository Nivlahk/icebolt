/**
 * "Your data" settings panel. The custody statement is rendered as a fixed
 * fact, not a control: no setting could give the developer access, so a
 * toggle would misrepresent the system.
 */
import {
  DATA_CUSTODY_STATEMENT,
  describeStorageSettings,
  type ReadableExportSetting,
  type StorageSettings,
} from '../sync/settings.js';

export interface RenderStorageSettingsOptions {
  settings: StorageSettings;
  /**
   * Called with the new settings. Persist with `writeStorageSettings(client, next)`;
   * the resulting database write schedules the sync that applies them.
   * Turning encryption on should first make sure a passphrase is set.
   */
  onChange: (next: StorageSettings) => void | Promise<void>;
  doc?: Document;
}

const EXPORT_CHOICES: Array<{ value: ReadableExportSetting; label: string; help: string }> = [
  { value: 'none', label: 'Off', help: 'Only the app database is stored.' },
  {
    value: 'ndjson',
    label: 'JSON files (works with BigQuery)',
    help: 'One file per table in a “Readable copies” folder inside the app’s Drive folder, updated on every sync.',
  },
];

export function renderStorageSettings(options: RenderStorageSettingsOptions): HTMLElement {
  const doc = options.doc ?? document;
  let current: StorageSettings = { ...options.settings };

  const root = doc.createElement('section');
  root.className = 'icebolt-storage-settings';
  root.setAttribute('aria-labelledby', 'icebolt-storage-title');

  const title = doc.createElement('h2');
  title.id = 'icebolt-storage-title';
  title.textContent = 'Your data';

  const custody = doc.createElement('p');
  custody.className = 'icebolt-custody';
  custody.textContent = DATA_CUSTODY_STATEMENT;

  // Encryption -------------------------------------------------------------
  const encField = doc.createElement('div');
  encField.className = 'icebolt-setting';
  const enc = doc.createElement('input');
  enc.type = 'checkbox';
  enc.id = 'icebolt-setting-encryption';
  enc.checked = current.encryption === 'passphrase';
  const encLabel = doc.createElement('label');
  encLabel.htmlFor = enc.id;
  encLabel.textContent = 'Encrypt with my passphrase';
  const encHelp = doc.createElement('small');
  encHelp.id = `${enc.id}-help`;
  encHelp.textContent = 'On: nobody without your passphrase can read the database, including Google. Off: the database is a normal SQLite file you can open yourself.';
  enc.setAttribute('aria-describedby', encHelp.id);
  encField.append(enc, encLabel, encHelp);

  // Readable copies --------------------------------------------------------
  const exportSet = doc.createElement('fieldset');
  exportSet.className = 'icebolt-setting';
  const legend = doc.createElement('legend');
  legend.textContent = 'Readable copies for analysis';
  exportSet.append(legend);
  const radios: HTMLInputElement[] = [];
  for (const choice of EXPORT_CHOICES) {
    const id = `icebolt-setting-export-${choice.value}`;
    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.name = 'icebolt-readable-export';
    radio.id = id;
    radio.value = choice.value;
    radio.checked = current.readableExport === choice.value;
    const label = doc.createElement('label');
    label.htmlFor = id;
    label.textContent = choice.label;
    const help = doc.createElement('small');
    help.textContent = choice.help;
    const row = doc.createElement('div');
    row.append(radio, label, help);
    exportSet.append(row);
    radios.push(radio);
  }

  // Consequences -----------------------------------------------------------
  const summary = doc.createElement('dl');
  summary.className = 'icebolt-who-can-read';
  summary.setAttribute('aria-live', 'polite');

  const renderSummary = (): void => {
    const s = describeStorageSettings(current);
    summary.replaceChildren();
    const add = (term: string, text: string, cls?: string): void => {
      const dt = doc.createElement('dt');
      dt.textContent = term;
      const dd = doc.createElement('dd');
      dd.textContent = text;
      if (cls) dd.className = cls;
      summary.append(dt, dd);
    };
    add('Who can read the database', s.database);
    if (s.readableCopies) add('Who can read the readable copies', s.readableCopies);
    for (const w of s.warnings) add('Note', w, 'icebolt-warning');
  };

  const commit = async (next: StorageSettings, revert: () => void): Promise<void> => {
    const previous = current;
    current = next;
    renderSummary();
    try {
      await options.onChange(next);
    } catch (err) {
      current = previous;
      revert();
      renderSummary();
      throw err;
    }
  };

  enc.addEventListener('change', () => {
    const was = !enc.checked;
    void commit({ ...current, encryption: enc.checked ? 'passphrase' : 'none' }, () => (enc.checked = was));
  });
  for (const radio of radios) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const prev = current.readableExport;
      void commit({ ...current, readableExport: radio.value as ReadableExportSetting }, () => {
        for (const r of radios) r.checked = r.value === prev;
      });
    });
  }

  renderSummary();
  root.append(title, custody, encField, exportSet, summary);
  return root;
}
