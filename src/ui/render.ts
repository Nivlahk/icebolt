/**
 * DOM construction from a UI manifest. Uses createElement/textContent only —
 * no innerHTML — so labels and placeholders authored in DBML cannot inject markup.
 */
import type { UiActionButtonConfig, UiFormFieldConfig, UiTableManifest } from './types.js';

export type FormValues = Record<string, unknown>;

export interface RenderFormOptions {
  onSubmit: (values: FormValues, form: HTMLFormElement) => void | Promise<void>;
  /** Pre-fill values (e.g. for an edit form). */
  initialValues?: Readonly<Record<string, unknown>>;
  /** Called with submit errors (validation from the client, constraint failures). */
  onError?: (error: unknown, form: HTMLFormElement) => void;
  resetOnSuccess?: boolean;
  doc?: Document;
}

export interface RenderActionsOptions {
  onAction: <Row extends object>(action: UiActionButtonConfig, row: Row) => void | Promise<void>;
  /** Confirmation prompt; defaults to `window.confirm`. Return false to cancel. */
  confirm?: (message: string) => boolean | Promise<boolean>;
  doc?: Document;
}

function controlFor(doc: Document, field: UiFormFieldConfig): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  let el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (field.element === 'select') {
    const select = doc.createElement('select');
    if (field.nullable || !field.required) {
      const blank = doc.createElement('option');
      blank.value = '';
      blank.textContent = '—';
      select.append(blank);
    }
    for (const opt of field.options ?? []) {
      const o = doc.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      select.append(o);
    }
    el = select;
  } else if (field.element === 'textarea') {
    el = doc.createElement('textarea');
  } else {
    const input = doc.createElement('input');
    input.type = field.inputType ?? 'text';
    el = input;
  }
  el.id = field.id;
  el.name = field.name;
  if (field.required && field.inputType !== 'checkbox') el.required = true;
  if (field.placeholder !== null && !(el instanceof HTMLSelectElement)) el.placeholder = field.placeholder;
  for (const [k, v] of Object.entries(field.attributes)) el.setAttribute(k, v);
  el.dataset['icebolt'] = 'field';
  el.dataset['column'] = field.column;
  return el;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, field: UiFormFieldConfig, value: unknown): void {
  if (value === undefined || value === null) return;
  if (el instanceof HTMLInputElement && el.type === 'checkbox') {
    el.checked = Boolean(value);
    return;
  }
  if (field.kind === 'json') {
    el.value = JSON.stringify(value, null, 2);
    return;
  }
  if (field.inputType === 'datetime-local' && typeof value === 'string') {
    el.value = value.slice(0, 16); // ISO → yyyy-MM-ddTHH:mm
    return;
  }
  el.value = String(value);
}

function readValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, field: UiFormFieldConfig): unknown {
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked;
  const raw = el.value;
  if (raw === '') return field.nullable ? null : undefined; // undefined → column default applies
  switch (field.kind) {
    case 'integer':
    case 'real': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${field.label} must be a number`);
      return n;
    }
    case 'boolean':
      return raw === 'true' || raw === '1' || raw === 'on';
    case 'json':
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new Error(`${field.label} must be valid JSON`);
      }
    case 'datetime':
      return field.inputType === 'datetime-local' ? new Date(raw).toISOString() : raw;
    default:
      return raw;
  }
}

/** Build a `<form>` for a table manifest. Returns `null` if the table declares no form inputs. */
export function renderForm(table: UiTableManifest, options: RenderFormOptions): HTMLFormElement | null {
  const config = table.form;
  if (!config) return null;
  const doc = options.doc ?? document;
  const form = doc.createElement('form');
  form.id = config.id;
  form.className = 'icebolt-form';
  form.noValidate = false;

  const controls: Array<{ field: UiFormFieldConfig; el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement }> = [];
  for (const field of config.fields) {
    const wrapper = doc.createElement('div');
    wrapper.className = `icebolt-field icebolt-field--${field.element}`;
    const label = doc.createElement('label');
    label.htmlFor = field.id;
    label.textContent = field.label;
    const el = controlFor(doc, field);
    setValue(el, field, options.initialValues?.[field.column]);
    if (field.inputType === 'checkbox') wrapper.append(el, label);
    else wrapper.append(label, el);
    if (field.description) {
      const help = doc.createElement('small');
      help.id = `${field.id}-help`;
      help.textContent = field.description;
      el.setAttribute('aria-describedby', help.id);
      wrapper.append(help);
    }
    form.append(wrapper);
    controls.push({ field, el });
  }

  const submit = doc.createElement('button');
  submit.type = 'submit';
  submit.textContent = config.submitLabel;
  submit.className = 'icebolt-submit';
  form.append(submit);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      submit.disabled = true;
      try {
        const values: FormValues = {};
        for (const { field, el } of controls) {
          const v = readValue(el, field);
          if (v !== undefined) values[field.column] = v;
        }
        await options.onSubmit(values, form);
        if (options.resetOnSuccess ?? true) form.reset();
      } catch (err) {
        if (options.onError) options.onError(err, form);
        else throw err;
      } finally {
        submit.disabled = false;
      }
    })();
  });
  return form;
}

/** Build the action buttons declared for a table, bound to one row. */
export function renderActionButtons<Row extends object>(table: UiTableManifest, row: Row, options: RenderActionsOptions): HTMLElement {
  const fields = row as Readonly<Record<string, unknown>>;
  const doc = options.doc ?? document;
  const group = doc.createElement('div');
  group.className = 'icebolt-actions';
  group.setAttribute('role', 'group');
  const confirmFn = options.confirm ?? ((m: string) => (typeof window !== 'undefined' ? window.confirm(m) : true));

  for (const action of table.actions) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.id = `${action.id}-${table.primaryKey.map((k) => String(fields[k])).join('_')}`.replace(/[^A-Za-z0-9_-]/g, '_');
    btn.className = `icebolt-action icebolt-action--${action.variant}`;
    btn.textContent = action.label;
    btn.dataset['action'] = action.action;
    if (action.target !== null) {
      btn.dataset['target'] = action.target;
      const current = fields[action.target];
      if (action.behavior.type === 'toggle-boolean') btn.setAttribute('aria-pressed', String(Boolean(current)));
    }
    btn.addEventListener('click', () => {
      void (async () => {
        if (action.confirm !== null && !(await confirmFn(action.confirm))) return;
        btn.disabled = true;
        try {
          await options.onAction(action, row);
        } finally {
          btn.disabled = false;
        }
      })();
    });
    group.append(btn);
  }
  return group;
}
