/** Small, accessible <dialog>-based prompts used by the app shell. textContent only, never innerHTML. */
import type { StorageSettings } from '../sync/settings.js';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

/** Resolves with the clicked button's value, or null if dismissed with Escape. */
export function modal<T extends string>(
  title: string,
  body: Node[],
  buttons: Array<{ value: T; label: string; primary?: boolean }>,
  validate?: (value: T) => string | null,
): Promise<T | null> {
  return new Promise((resolve) => {
    const err = el('p', { className: 'icebolt-err' });
    err.setAttribute('role', 'alert');
    const row = el('div', { className: 'icebolt-dialog-actions' });
    const dlg = el('dialog', { className: 'icebolt-dialog' }, el('h3', { textContent: title }), ...body, err, row);
    for (const b of buttons) {
      row.append(
        el('button', {
          type: 'button',
          className: b.primary ? 'icebolt-btn icebolt-btn--primary' : 'icebolt-btn',
          textContent: b.label,
          onclick: () => {
            const problem = validate?.(b.value) ?? null;
            if (problem) {
              err.textContent = problem;
              return;
            }
            dlg.close();
            resolve(b.value);
          },
        }),
      );
    }
    dlg.addEventListener('cancel', () => resolve(null));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    (dlg.querySelector('input') ?? dlg.querySelector('button'))?.focus();
  });
}

export function passwordField(label: string, autocomplete: 'new-password' | 'current-password'): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { type: 'password', className: 'icebolt-input' });
  input.setAttribute('autocomplete', autocomplete);
  return { wrap: el('label', { className: 'icebolt-field' }, el('span', { textContent: label }), input), input };
}

const newPassphraseProblem = (a: string, b: string): string | null =>
  a.length < 8 ? 'Use at least 8 characters.' : a !== b ? 'The passphrases don’t match.' : null;

/** First connection: the user decides how their data is stored. */
export async function chooseStorage(appName: string): Promise<{ settings: StorageSettings; passphrase: string | null } | null> {
  const p1 = passwordField('Passphrase', 'new-password');
  const p2 = passwordField('Repeat passphrase', 'new-password');
  const choice = await modal(
    'Where your data lives',
    [
      el('p', { textContent: `Your data goes in a “${appName}” folder in your own Google Drive. This app's developer never receives it.` }),
      el('p', { className: 'icebolt-small', textContent: 'Encrypted: only your passphrase opens it, not even Google. Lose the passphrase and the data is gone for good.' }),
      p1.wrap,
      p2.wrap,
      el('p', { className: 'icebolt-small', textContent: 'Plain file: you can open it yourself in any SQLite tool; Google can read it like any file in your Drive.' }),
      el('p', { className: 'icebolt-small', textContent: 'You can change this later under Storage.' }),
    ],
    [
      { value: 'plain', label: 'Plain file' },
      { value: 'encrypted', label: 'Encrypt it', primary: true },
    ],
    (v) => (v === 'encrypted' ? newPassphraseProblem(p1.input.value, p2.input.value) : null),
  );
  if (choice === null) return null;
  return choice === 'encrypted'
    ? { settings: { encryption: 'passphrase', readableExport: 'none' }, passphrase: p1.input.value }
    : { settings: { encryption: 'none', readableExport: 'none' }, passphrase: null };
}

export async function askPassphrase(message: string): Promise<string | null> {
  const p = passwordField('Passphrase', 'current-password');
  const ok = await modal('Unlock your data', [el('p', { textContent: message }), p.wrap], [
    { value: 'cancel', label: 'Cancel' },
    { value: 'unlock', label: 'Unlock', primary: true },
  ], (v) => (v === 'unlock' && !p.input.value ? 'Enter your passphrase.' : null));
  return ok === 'unlock' ? p.input.value : null;
}

export async function newPassphrase(message: string): Promise<string | null> {
  const p1 = passwordField('Passphrase', 'new-password');
  const p2 = passwordField('Repeat passphrase', 'new-password');
  const ok = await modal('Choose a passphrase', [el('p', { textContent: message }), p1.wrap, p2.wrap], [
    { value: 'cancel', label: 'Cancel' },
    { value: 'ok', label: 'Encrypt', primary: true },
  ], (v) => (v === 'ok' ? newPassphraseProblem(p1.input.value, p2.input.value) : null));
  return ok === 'ok' ? p1.input.value : null;
}
