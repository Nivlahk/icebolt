/**
 * Shared, compiler-wide types. Everything downstream of the DBML parser
 * (SQL emitter, client generator, UI manifest builder, runtime) speaks this
 * normalized model rather than raw DBML.
 */

/** Logical value kind of a column, independent of SQLite storage class. */
export type ValueKind =
  | 'integer'
  | 'real'
  | 'text'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json'
  | 'blob'
  | 'enum';

/** SQLite STRICT-table storage types. */
export type SqliteStorageType = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB';

export type ReferentialAction = 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';

export interface CompiledColumn {
  name: string;
  kind: ValueKind;
  sqlType: SqliteStorageType;
  /** The type as written in DBML, e.g. `varchar(255)`. */
  sourceType: string;
  nullable: boolean;
  /** Column has a DEFAULT clause. */
  hasDefault: boolean;
  /** Value is produced by SQLite (INTEGER PRIMARY KEY rowid alias / AUTOINCREMENT). */
  generated: boolean;
  /** Emit AUTOINCREMENT (never reuse rowids). Only valid on a single INTEGER PRIMARY KEY. */
  autoIncrement: boolean;
  primaryKey: boolean;
  unique: boolean;
  /** From varchar(n)/char(n); enforced with a CHECK constraint. */
  maxLength: number | null;
  enumValues: string[] | null;
  /** Raw SQL fragment for DEFAULT, already SQLite-translated. */
  defaultSql: string | null;
  /** Column-level CHECK expressions (raw SQL). */
  checks: string[];
  note: string | null;
  ordinal: number;
}

export interface CompiledForeignKey {
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: ReferentialAction | null;
  onUpdate: ReferentialAction | null;
}

export interface CompiledIndexPart {
  kind: 'column' | 'expression';
  value: string;
}

export interface CompiledIndex {
  name: string;
  unique: boolean;
  parts: CompiledIndexPart[];
}

export interface CompiledTable {
  name: string;
  columns: CompiledColumn[];
  primaryKey: string[];
  foreignKeys: CompiledForeignKey[];
  indexes: CompiledIndex[];
  note: string | null;
  /** True for compiler-generated junction tables (many-to-many refs). */
  synthetic: boolean;
}

export interface CompiledSchema {
  tables: CompiledTable[];
  enums: Record<string, string[]>;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  table?: string;
  column?: string;
  line?: number;
}

export class IceboltCompileError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    const errors = diagnostics.filter((d) => d.severity === 'error');
    super(
      `Icebolt schema compilation failed with ${errors.length} error(s):\n` +
        errors.map((d) => `  - ${formatDiagnostic(d)}`).join('\n'),
    );
    this.name = 'IceboltCompileError';
    this.diagnostics = diagnostics;
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = [d.line !== undefined ? `line ${d.line}` : null, d.table ? (d.column ? `${d.table}.${d.column}` : d.table) : null]
    .filter((x): x is string => x !== null)
    .join(', ');
  return where ? `[${where}] ${d.message}` : d.message;
}
