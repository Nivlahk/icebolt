/** Raw DBML AST, as close to the source as practical. */

export type RefOp = '>' | '<' | '-' | '<>';

export interface DbmlDefault {
  kind: 'string' | 'number' | 'boolean' | 'null' | 'expression';
  value: string;
}

export interface DbmlEndpoint {
  schema?: string;
  table: string;
  columns: string[];
  line: number;
}

export interface DbmlInlineRef {
  op: RefOp;
  target: DbmlEndpoint;
}

export interface DbmlColumn {
  name: string;
  /** Raw type text, e.g. `varchar(255)` or `core.status`. */
  type: string;
  /** Unqualified type name, original case (enum lookup needs it). */
  typeName: string;
  /** Schema qualifier of the type, if any (`core` in `core.status`). */
  typeSchema?: string;
  typeArgs: string[];
  isArray: boolean;
  pk: boolean;
  notNull: boolean;
  unique: boolean;
  increment: boolean;
  default?: DbmlDefault;
  note?: string;
  checks: string[];
  inlineRefs: DbmlInlineRef[];
  line: number;
}

export interface DbmlIndexPart {
  kind: 'column' | 'expression';
  value: string;
}

export interface DbmlIndex {
  parts: DbmlIndexPart[];
  pk: boolean;
  unique: boolean;
  name?: string;
  line: number;
}

export interface DbmlTable {
  name: string;
  schema?: string;
  alias?: string;
  columns: DbmlColumn[];
  indexes: DbmlIndex[];
  note?: string;
  line: number;
}

export interface DbmlEnum {
  name: string;
  schema?: string;
  values: string[];
  line: number;
}

export type DbmlReferentialAction = 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action';

export interface DbmlRef {
  name?: string;
  op: RefOp;
  left: DbmlEndpoint;
  right: DbmlEndpoint;
  onDelete?: DbmlReferentialAction;
  onUpdate?: DbmlReferentialAction;
  line: number;
}

export interface DbmlDocument {
  tables: DbmlTable[];
  enums: DbmlEnum[];
  refs: DbmlRef[];
}
