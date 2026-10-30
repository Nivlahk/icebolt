import type { ValueKind } from '../types.js';

export type UiInputType =
  | 'text'
  | 'email'
  | 'url'
  | 'tel'
  | 'password'
  | 'search'
  | 'number'
  | 'date'
  | 'datetime-local'
  | 'time'
  | 'color'
  | 'checkbox';

export type UiPrimitive = string | number | boolean | null;

export interface UiSelectOption {
  value: string;
  label: string;
}

/** A foreign-key field: its options are rows of another table, looked up when the form is shown. */
export interface UiReference {
  /** Referenced table. */
  table: string;
  /** Referenced column (the stored value). */
  column: string;
  /** Column shown to the user for each option. */
  labelColumn: string;
}

/** One HTML form control bound to one database column. */
export interface UiFormFieldConfig {
  /** Database column this control reads/writes. */
  column: string;
  /** DOM `id`, unique per manifest. */
  id: string;
  /** DOM `name`, equal to the column name. */
  name: string;
  element: 'input' | 'textarea' | 'select';
  /** Present when `element === 'input'`. */
  inputType: UiInputType | null;
  label: string;
  placeholder: string | null;
  description: string | null;
  required: boolean;
  /** Column accepts NULL; empty inputs submit `null`. */
  nullable: boolean;
  kind: ValueKind;
  options: UiSelectOption[] | null;
  /** Set for foreign-key columns: a <select> of rows from another table. */
  references: UiReference | null;
  /** Extra whitelisted HTML attributes (maxlength, min, max, step, pattern, autocomplete). */
  attributes: Record<string, string>;
  order: number;
}

export interface UiFormConfig {
  id: string;
  table: string;
  submitLabel: string;
  fields: UiFormFieldConfig[];
}

export type UiActionName = 'toggleRow' | 'setValue' | 'increment' | 'decrement' | 'deleteRow';

/** Normalized, executable behavior of a button — the runtime never re-interprets raw props. */
export type UiActionBehavior =
  | { type: 'toggle-boolean' }
  | { type: 'cycle'; values: Array<string | number> }
  | { type: 'set'; value: UiPrimitive }
  | { type: 'increment'; by: number }
  | { type: 'delete' };

export interface UiActionButtonConfig {
  id: string;
  table: string;
  action: UiActionName;
  /** Column whose note declared the button. */
  sourceColumn: string;
  /** Column mutated by the action (`null` for deleteRow). */
  target: string | null;
  label: string;
  behavior: UiActionBehavior;
  confirm: string | null;
  variant: 'primary' | 'secondary' | 'danger';
}

export interface UiTableManifest {
  table: string;
  primaryKey: string[];
  form: UiFormConfig | null;
  actions: UiActionButtonConfig[];
}

export interface UiManifest {
  version: 1;
  schemaHash: string;
  tables: Record<string, UiTableManifest>;
}
