import type { CompiledColumn, CompiledSchema, CompiledTable, Diagnostic } from '../types.js';
import { parseUiDirectives, type UiProps, type UiValue } from './directives.js';
import type {
  UiActionBehavior,
  UiActionButtonConfig,
  UiActionName,
  UiFormFieldConfig,
  UiInputType,
  UiManifest,
  UiPrimitive,
  UiReference,
  UiSelectOption,
  UiTableManifest,
} from './types.js';

type Report = (severity: Diagnostic['severity'], message: string) => void;

const INPUT_TYPES: ReadonlySet<string> = new Set<UiInputType>([
  'text',
  'email',
  'url',
  'tel',
  'password',
  'search',
  'number',
  'date',
  'datetime-local',
  'time',
  'color',
  'checkbox',
]);

const FORM_INPUT_KEYS: ReadonlySet<string> = new Set([
  'label',
  'labelColumn',
  'placeholder',
  'type',
  'multiline',
  'required',
  'order',
  'help',
  'min',
  'max',
  'step',
  'pattern',
  'maxLength',
  'autocomplete',
  'optionLabels',
]);

const ACTION_KEYS: ReadonlySet<string> = new Set(['action', 'target', 'label', 'value', 'values', 'by', 'confirm', 'variant']);
const ACTIONS: ReadonlySet<string> = new Set<UiActionName>(['toggleRow', 'setValue', 'increment', 'decrement', 'deleteRow']);

export function humanize(identifier: string): string {
  const spaced = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function domId(...parts: string[]): string {
  return parts.map((p) => p.replace(/[^A-Za-z0-9_-]/g, '_')).join('-');
}

// --------------------------------------------------------------- prop access

function optString(props: UiProps, key: string, report: Report): string | null {
  const v = props[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    report('error', `'${key}' must be a string`);
    return null;
  }
  return v;
}

function optNumber(props: UiProps, key: string, report: Report): number | null {
  const v = props[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number') {
    report('error', `'${key}' must be a number`);
    return null;
  }
  return v;
}

function optBoolean(props: UiProps, key: string, report: Report): boolean | null {
  const v = props[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') {
    report('error', `'${key}' must be true or false`);
    return null;
  }
  return v;
}

function warnUnknownKeys(props: UiProps, allowed: ReadonlySet<string>, directive: string, report: Report): void {
  for (const key of Object.keys(props)) {
    if (!allowed.has(key)) report('warning', `@ui:${directive}: unknown property '${key}' ignored`);
  }
}

/** Validate a literal against a column's kind; returns the coerced primitive or `undefined` on failure. */
function coerceForColumn(value: UiValue, column: CompiledColumn, report: Report, what: string): UiPrimitive | undefined {
  if (value === null) {
    if (!column.nullable) {
      report('error', `${what}: column '${column.name}' is NOT NULL`);
      return undefined;
    }
    return null;
  }
  switch (column.kind) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      break;
    case 'integer':
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      break;
    case 'real':
      if (typeof value === 'number') return value;
      break;
    case 'enum':
      if (typeof value === 'string' && column.enumValues?.includes(value)) return value;
      report('error', `${what}: '${String(value)}' is not a value of enum column '${column.name}' (${column.enumValues?.join(', ')})`);
      return undefined;
    case 'text':
    case 'date':
    case 'datetime':
      if (typeof value === 'string') return value;
      break;
    case 'json':
    case 'blob':
      report('error', `${what}: ${column.kind} columns cannot be targeted by UI actions`);
      return undefined;
  }
  report('error', `${what}: ${JSON.stringify(value)} is not valid for ${column.kind} column '${column.name}'`);
  return undefined;
}

// ---------------------------------------------------------------- form input

function inferControl(column: CompiledColumn): { element: UiFormFieldConfig['element']; inputType: UiInputType | null } {
  switch (column.kind) {
    case 'boolean':
      return { element: 'input', inputType: 'checkbox' };
    case 'integer':
    case 'real':
      return { element: 'input', inputType: 'number' };
    case 'date':
      return { element: 'input', inputType: 'date' };
    case 'datetime':
      return { element: 'input', inputType: 'datetime-local' };
    case 'enum':
      return { element: 'select', inputType: null };
    case 'json':
      return { element: 'textarea', inputType: null };
    default:
      return { element: 'input', inputType: 'text' };
  }
}

/** The referenced row's column to show in a foreign-key <select>: a unique text column, else any text column, else the key. */
function resolveReference(schema: CompiledSchema, table: CompiledTable, column: CompiledColumn, props: UiProps, report: Report): UiReference | null {
  const fk = table.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === column.name);
  if (!fk) {
    if (props['labelColumn'] !== undefined) report('warning', `'labelColumn' ignored: '${column.name}' is not a foreign key`);
    return null;
  }
  const target = schema.tables.find((t) => t.name === fk.refTable);
  const refColumn = fk.refColumns[0]!;
  if (!target) return null;
  const explicit = optString(props, 'labelColumn', report);
  if (explicit !== null) {
    if (target.columns.some((c) => c.name === explicit)) return { table: target.name, column: refColumn, labelColumn: explicit };
    report('error', `labelColumn: '${target.name}' has no column '${explicit}'`);
  }
  const texts = target.columns.filter((c) => c.kind === 'text' && !c.primaryKey);
  const label = texts.find((c) => c.unique) ?? texts.find((c) => !c.nullable) ?? texts[0];
  return { table: target.name, column: refColumn, labelColumn: label?.name ?? refColumn };
}

function buildFormField(schema: CompiledSchema, table: CompiledTable, column: CompiledColumn, props: UiProps, report: Report): UiFormFieldConfig | null {
  warnUnknownKeys(props, FORM_INPUT_KEYS, 'form-input', report);
  if (column.kind === 'blob') {
    report('error', '@ui:form-input is not supported on blob columns');
    return null;
  }
  if (column.generated) {
    report('warning', `@ui:form-input on '${column.name}', which SQLite generates; the field is rendered but optional`);
  }

  let { element, inputType } = inferControl(column);
  const references = resolveReference(schema, table, column, props, report);
  if (references) {
    element = 'select';
    inputType = null;
  }

  const explicitType = optString(props, 'type', report);
  if (explicitType !== null) {
    if (explicitType === 'textarea') {
      element = 'textarea';
      inputType = null;
    } else if (!INPUT_TYPES.has(explicitType)) {
      report('error', `@ui:form-input: unsupported type '${explicitType}'`);
    } else if (column.kind === 'enum') {
      report('warning', `@ui:form-input: 'type' is ignored on enum column (rendered as <select>)`);
    } else {
      element = 'input';
      inputType = explicitType as UiInputType;
    }
  }
  if (optBoolean(props, 'multiline', report) === true) {
    if (column.kind === 'text' || column.kind === 'json') {
      element = 'textarea';
      inputType = null;
    } else report('warning', `'multiline' ignored on ${column.kind} column`);
  }

  const attributes: Record<string, string> = {};
  const maxLength = optNumber(props, 'maxLength', report) ?? column.maxLength;
  if (maxLength !== null && (element === 'textarea' || inputType === 'text' || inputType === 'search' || inputType === 'email' || inputType === 'url' || inputType === 'tel' || inputType === 'password')) {
    attributes['maxlength'] = String(Math.trunc(maxLength));
  }
  for (const key of ['min', 'max'] as const) {
    const v = props[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' || typeof v === 'string') attributes[key] = String(v);
    else report('error', `'${key}' must be a number or string`);
  }
  const step = props['step'];
  if (step !== undefined && step !== null) {
    if (typeof step === 'number' || step === 'any') attributes['step'] = String(step);
    else report('error', `'step' must be a number or 'any'`);
  } else if (inputType === 'number') {
    attributes['step'] = column.kind === 'integer' ? '1' : 'any';
  }
  const pattern = optString(props, 'pattern', report);
  if (pattern !== null) {
    try {
      new RegExp(pattern, 'v');
      attributes['pattern'] = pattern;
    } catch {
      try {
        new RegExp(pattern, 'u');
        attributes['pattern'] = pattern;
      } catch {
        report('error', `'pattern' is not a valid regular expression`);
      }
    }
  }
  const autocomplete = optString(props, 'autocomplete', report);
  if (autocomplete !== null) attributes['autocomplete'] = autocomplete;

  let options: UiSelectOption[] | null = null;
  if (element === 'select' && !references) {
    const labelsRaw = props['optionLabels'];
    const labels: Record<string, string> = {};
    if (labelsRaw !== undefined) {
      if (labelsRaw === null || typeof labelsRaw !== 'object' || Array.isArray(labelsRaw)) {
        report('error', `'optionLabels' must be an object mapping enum values to labels`);
      } else {
        for (const [k, v] of Object.entries(labelsRaw)) {
          if (!column.enumValues?.includes(k)) report('warning', `optionLabels: '${k}' is not a value of this enum`);
          else if (typeof v !== 'string') report('error', `optionLabels.${k} must be a string`);
          else labels[k] = v;
        }
      }
    }
    options = (column.enumValues ?? []).map((value) => ({ value, label: labels[value] ?? humanize(value) }));
  }

  const required = optBoolean(props, 'required', report) ?? (!column.nullable && !column.hasDefault && !column.generated && column.kind !== 'boolean');

  return {
    column: column.name,
    id: domId('icebolt', table.name, column.name),
    name: column.name,
    element,
    inputType: element === 'input' ? inputType : null,
    label: optString(props, 'label', report) ?? humanize(references ? column.name.replace(/_?id$/i, '') || column.name : column.name),
    placeholder: element === 'select' || inputType === 'checkbox' ? null : optString(props, 'placeholder', report),
    description: optString(props, 'help', report),
    required,
    nullable: column.nullable,
    kind: column.kind,
    options,
    references,
    attributes,
    order: optNumber(props, 'order', report) ?? column.ordinal,
  };
}

// ------------------------------------------------------------- action button

function buildAction(table: CompiledTable, column: CompiledColumn, props: UiProps, index: number, report: Report): UiActionButtonConfig | null {
  warnUnknownKeys(props, ACTION_KEYS, 'action-button', report);
  const action = optString(props, 'action', report);
  if (action === null) {
    report('error', `@ui:action-button requires 'action' (${[...ACTIONS].join(', ')})`);
    return null;
  }
  if (!ACTIONS.has(action)) {
    report('error', `@ui:action-button: unknown action '${action}' (expected ${[...ACTIONS].join(', ')})`);
    return null;
  }
  if (table.primaryKey.length === 0) {
    report('error', `@ui:action-button requires table '${table.name}' to have a primary key to address rows`);
    return null;
  }
  const name = action as UiActionName;

  let target: CompiledColumn | null = null;
  if (name !== 'deleteRow') {
    const targetName = optString(props, 'target', report) ?? column.name;
    target = table.columns.find((c) => c.name === targetName) ?? null;
    if (!target) {
      report('error', `@ui:action-button: target column '${targetName}' does not exist on '${table.name}'`);
      return null;
    }
    if (target.primaryKey) {
      report('error', `@ui:action-button: cannot mutate primary-key column '${target.name}'`);
      return null;
    }
  }

  let behavior: UiActionBehavior | null = null;
  const what = `@ui:action-button(${name})`;
  switch (name) {
    case 'toggleRow': {
      const t = target!;
      const valuesRaw = props['values'];
      if (valuesRaw !== undefined) {
        if (!Array.isArray(valuesRaw) || valuesRaw.length < 2) {
          report('error', `${what}: 'values' must be an array of at least two values to cycle through`);
          return null;
        }
        const values: Array<string | number> = [];
        for (const v of valuesRaw) {
          const c = coerceForColumn(v, t, report, what);
          if (c === undefined) return null;
          if (typeof c !== 'string' && typeof c !== 'number') {
            report('error', `${what}: cycle values must be strings or numbers`);
            return null;
          }
          values.push(c);
        }
        behavior = { type: 'cycle', values };
      } else if (t.kind === 'boolean') {
        behavior = { type: 'toggle-boolean' };
      } else if (t.kind === 'enum' && t.enumValues && t.enumValues.length >= 2) {
        behavior = { type: 'cycle', values: [...t.enumValues] };
      } else {
        report('error', `${what}: target '${t.name}' is ${t.kind}; toggleRow needs a boolean or enum column, or explicit 'values'`);
        return null;
      }
      break;
    }
    case 'setValue': {
      if (!Object.prototype.hasOwnProperty.call(props, 'value')) {
        report('error', `${what}: 'value' is required`);
        return null;
      }
      const v = coerceForColumn(props['value']!, target!, report, what);
      if (v === undefined) return null;
      behavior = { type: 'set', value: v };
      break;
    }
    case 'increment':
    case 'decrement': {
      if (target!.kind !== 'integer' && target!.kind !== 'real') {
        report('error', `${what}: target '${target!.name}' must be numeric`);
        return null;
      }
      const by = optNumber(props, 'by', report) ?? 1;
      if (target!.kind === 'integer' && !Number.isInteger(by)) {
        report('error', `${what}: 'by' must be an integer for integer columns`);
        return null;
      }
      behavior = { type: 'increment', by: name === 'decrement' ? -by : by };
      break;
    }
    case 'deleteRow':
      behavior = { type: 'delete' };
      break;
  }

  const variantRaw = optString(props, 'variant', report);
  let variant: UiActionButtonConfig['variant'] = name === 'deleteRow' ? 'danger' : 'secondary';
  if (variantRaw !== null) {
    if (variantRaw === 'primary' || variantRaw === 'secondary' || variantRaw === 'danger') variant = variantRaw;
    else report('warning', `${what}: unknown variant '${variantRaw}'`);
  }

  const defaultLabel: Record<UiActionName, string> = {
    toggleRow: `Toggle ${humanize(target?.name ?? '').toLowerCase()}`,
    setValue: `Set ${humanize(target?.name ?? '').toLowerCase()}`,
    increment: `+${Math.abs(behavior.type === 'increment' ? behavior.by : 1)}`,
    decrement: `−${Math.abs(behavior.type === 'increment' ? behavior.by : 1)}`,
    deleteRow: 'Delete',
  };

  return {
    id: domId('icebolt', table.name, 'action', String(index)),
    table: table.name,
    action: name,
    sourceColumn: column.name,
    target: target?.name ?? null,
    label: optString(props, 'label', report) ?? defaultLabel[name],
    behavior,
    confirm: optString(props, 'confirm', report) ?? (name === 'deleteRow' ? 'Delete this row?' : null),
    variant,
  };
}

// ----------------------------------------------------------------- manifest

/** Scan every column note for `@ui:` directives and build the layout manifest. */
export function buildUiManifest(schema: CompiledSchema, schemaHash: string, diagnostics: Diagnostic[]): UiManifest {
  const tables: Record<string, UiTableManifest> = {};

  for (const table of schema.tables) {
    if (table.synthetic) continue;
    const fields: UiFormFieldConfig[] = [];
    const actions: UiActionButtonConfig[] = [];

    for (const column of table.columns) {
      if (!column.note || !column.note.includes('@ui:')) continue;
      const report: Report = (severity, message) => diagnostics.push({ severity, message, table: table.name, column: column.name });
      const { directives, errors } = parseUiDirectives(column.note);
      for (const e of errors) report('error', e);

      for (const d of directives) {
        if (d.name === 'form-input') {
          if (fields.some((f) => f.column === column.name)) {
            report('error', `duplicate @ui:form-input for column '${column.name}'`);
            continue;
          }
          const field = buildFormField(schema, table, column, d.props, report);
          if (field) fields.push(field);
        } else if (d.name === 'action-button') {
          const btn = buildAction(table, column, d.props, actions.length, report);
          if (btn) actions.push(btn);
        } else {
          report('warning', `unknown directive @ui:${d.name} ignored`);
        }
      }
    }

    fields.sort((a, b) => a.order - b.order || a.column.localeCompare(b.column));
    tables[table.name] = {
      table: table.name,
      primaryKey: [...table.primaryKey],
      form:
        fields.length > 0
          ? { id: domId('icebolt', 'form', table.name), table: table.name, submitLabel: `Add ${singular(humanize(table.name).toLowerCase())}`, fields }
          : null,
      actions,
    };
  }

  return { version: 1, schemaHash, tables };
}

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  people: 'person', children: 'child', men: 'man', women: 'woman', mice: 'mouse', geese: 'goose',
  teeth: 'tooth', feet: 'foot', knives: 'knife', wives: 'wife', lives: 'life', leaves: 'leaf',
  wolves: 'wolf', shelves: 'shelf', halves: 'half', calves: 'calf', elves: 'elf', selves: 'self', criteria: 'criterion', phenomena: 'phenomenon', indices: 'index', matrices: 'matrix',
};
const UNCOUNTABLE = new Set(['data', 'news', 'series', 'species', 'information', 'equipment', 'sheep', 'fish', 'media', 'settings']);

/** Singular of the last word: "notes" → "note", "order items" → "order item", "people" → "person", "data" stays. */
export function singular(phrase: string): string {
  const m = /^(.*?)([a-z]+)$/i.exec(phrase);
  if (!m) return phrase;
  const [, head, word] = m as unknown as [string, string, string];
  const lower = word.toLowerCase();
  let out: string;
  if (IRREGULAR_PLURALS[lower]) out = IRREGULAR_PLURALS[lower]!;
  else if (UNCOUNTABLE.has(lower) || /(ss|us|is)$/.test(lower)) out = lower;
  else if (/[^aeiou]ies$/.test(lower)) out = `${lower.slice(0, -3)}y`;
  else if (/(x|ch|sh|ss|zz)es$/.test(lower)) out = lower.slice(0, -2);
  else if (/s$/.test(lower)) out = lower.slice(0, -1);
  else out = lower;
  return head + (word === lower ? out : out.charAt(0).toUpperCase() + out.slice(1));
}
