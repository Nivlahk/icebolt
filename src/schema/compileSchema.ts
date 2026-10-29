import type { DbmlColumn, DbmlDefault, DbmlDocument, DbmlEndpoint, DbmlReferentialAction, DbmlTable, RefOp } from '../dbml/ast.js';
import { DbmlSyntaxError, parseDbml } from '../dbml/parser.js';
import {
  IceboltCompileError,
  type CompiledColumn,
  type CompiledForeignKey,
  type CompiledIndex,
  type CompiledSchema,
  type CompiledTable,
  type Diagnostic,
  type ReferentialAction,
  type SqliteStorageType,
  type ValueKind,
} from '../types.js';
import { buildUiManifest } from '../ui/manifest.js';
import type { UiManifest } from '../ui/types.js';
import { schemaFingerprint } from './hash.js';
import {
  EMPTY_DROPS,
  EMPTY_RENAMES,
  IceboltMigrationError,
  collectRenames,
  mergeDrops,
  planMigration,
  type MigrationPlan,
  type SchemaLock,
  type SchemaSnapshot,
} from './migrate.js';
import { META_TABLE, emitDdl, emitMigration, quoteLiteral } from './sql.js';

export interface CompileOptions {
  /** Emit SQLite STRICT tables (requires SQLite ≥ 3.37; sql.js and sqlite-wasm both qualify). Default `true`. */
  strict?: boolean;
  /**
   * The lockfile from the last compile (`icebolt.schema.lock.json`). With it,
   * the schema change is checked and a migration is planned so users' existing
   * databases upgrade; without it this compile starts version history at 1.
   */
  previous?: SchemaLock | null;
  /** Confirm data deletions: `'table'` or `'table.column'` (old names). Remembered in the lock. */
  allowDrop?: readonly string[];
}

export interface CompileResult {
  /** Idempotent migration script: run once against an empty (or same-hash) database. */
  sqlMigration: string;
  /** DOM layout configuration extracted from `@ui:` directives. */
  uiManifest: UiManifest;
  /** Normalized schema model consumed by the client generator and runtime. */
  schema: CompiledSchema;
  /** Fingerprint of the DDL; stored in `__icebolt_meta` to detect drift. */
  schemaHash: string;
  /** Warnings (errors throw {@link IceboltCompileError}). */
  diagnostics: Diagnostic[];
  /** This version of the schema, as stored in every database it creates. */
  snapshot: SchemaSnapshot;
  /** Write this back to `icebolt.schema.lock.json`. */
  lock: SchemaLock;
  /** How databases on the previous version upgrade (null when the schema did not change). */
  migration: MigrationPlan | null;
}

// -------------------------------------------------------------- type system

interface TypeInfo {
  kind: ValueKind;
  sqlType: SqliteStorageType;
  maxLength: number | null;
  enumValues: string[] | null;
  serial: boolean;
}

const INTEGER_TYPES = new Set(['int', 'integer', 'int2', 'int4', 'int8', 'smallint', 'bigint', 'tinyint', 'mediumint', 'long']);
const SERIAL_TYPES = new Set(['serial', 'serial4', 'serial8', 'bigserial', 'smallserial']);
const BOOLEAN_TYPES = new Set(['bool', 'boolean']);
const REAL_TYPES = new Set(['float', 'float4', 'float8', 'real', 'double', 'decimal', 'numeric', 'money', 'number']);
const LENGTH_TYPES = new Set(['varchar', 'char', 'character', 'nvarchar', 'nchar', 'varchar2', 'bpchar']);
const TEXT_TYPES = new Set([
  ...LENGTH_TYPES,
  'text', 'string', 'uuid', 'citext', 'tinytext', 'mediumtext', 'longtext', 'clob',
  'inet', 'cidr', 'macaddr', 'time', 'timetz', 'interval', 'xml', 'email', 'url',
]);
const DATE_TYPES = new Set(['date']);
const DATETIME_TYPES = new Set(['timestamp', 'timestamptz', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset']);
const JSON_TYPES = new Set(['json', 'jsonb']);
const BLOB_TYPES = new Set(['blob', 'bytea', 'binary', 'varbinary', 'longblob', 'mediumblob', 'tinyblob', 'image']);

const ACTION_MAP: Record<DbmlReferentialAction, ReferentialAction> = {
  cascade: 'CASCADE',
  restrict: 'RESTRICT',
  'set null': 'SET NULL',
  'set default': 'SET DEFAULT',
  'no action': 'NO ACTION',
};

const UUID_V4_SQL =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || " +
  "substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";

const ISO_NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

type Report = (d: Omit<Diagnostic, 'severity'> & { severity?: Diagnostic['severity'] }) => void;

function mapType(col: DbmlColumn, enums: Map<string, string[]>, report: Report, table: string): TypeInfo {
  const enumKey = col.typeSchema ? `${col.typeSchema}.${col.typeName}` : col.typeName;
  const enumValues = enums.get(enumKey) ?? (col.typeSchema === 'public' ? enums.get(col.typeName) : undefined);
  if (col.isArray) {
    report({ severity: 'warning', message: `array type '${col.type}' stored as JSON text`, table, column: col.name, line: col.line });
    return { kind: 'json', sqlType: 'TEXT', maxLength: null, enumValues: null, serial: false };
  }
  if (enumValues) return { kind: 'enum', sqlType: 'TEXT', maxLength: null, enumValues: [...enumValues], serial: false };

  const base = col.typeName.toLowerCase();
  const simple = (kind: ValueKind, sqlType: SqliteStorageType): TypeInfo => ({ kind, sqlType, maxLength: null, enumValues: null, serial: false });

  if (INTEGER_TYPES.has(base)) return simple('integer', 'INTEGER');
  if (SERIAL_TYPES.has(base)) return { ...simple('integer', 'INTEGER'), serial: true };
  if (BOOLEAN_TYPES.has(base)) return simple('boolean', 'INTEGER');
  if (REAL_TYPES.has(base)) return simple('real', 'REAL');
  if (DATE_TYPES.has(base)) return simple('date', 'TEXT');
  if (DATETIME_TYPES.has(base)) return simple('datetime', 'TEXT');
  if (JSON_TYPES.has(base)) return simple('json', 'TEXT');
  if (BLOB_TYPES.has(base)) return simple('blob', 'BLOB');
  if (TEXT_TYPES.has(base)) {
    let maxLength: number | null = null;
    if (LENGTH_TYPES.has(base) && col.typeArgs.length === 1 && /^\d+$/.test(col.typeArgs[0]!)) maxLength = Number(col.typeArgs[0]);
    return { ...simple('text', 'TEXT'), maxLength };
  }
  report({
    severity: 'warning',
    message: `unknown type '${col.type}' mapped to TEXT (declare an Enum or use a standard type)`,
    table,
    column: col.name,
    line: col.line,
  });
  return simple('text', 'TEXT');
}

function translateExpression(expr: string, kind: ValueKind, report: Report, table: string, column: string): string {
  const norm = expr.trim().toLowerCase().replace(/\s+/g, '');
  if (['now()', 'current_timestamp', 'current_timestamp()', 'getdate()', 'localtimestamp', 'sysdate', 'sysdate()'].includes(norm)) {
    if (kind === 'date') return "(date('now'))";
    if (kind === 'integer') return "(CAST(strftime('%s', 'now') AS INTEGER))";
    return ISO_NOW_SQL;
  }
  if (norm === 'current_date' || norm === 'current_date()') return "(date('now'))";
  if (norm === 'current_time' || norm === 'current_time()') return "(time('now'))";
  if (['gen_random_uuid()', 'uuid_generate_v4()', 'uuid()', 'newid()'].includes(norm)) return UUID_V4_SQL;
  report({ severity: 'warning', message: `default expression \`${expr}\` passed through verbatim; it must be valid SQLite`, table, column });
  return `(${expr})`;
}

function translateDefault(d: DbmlDefault, col: Omit<CompiledColumn, 'defaultSql'>, report: Report, table: string): string | null {
  const fail = (message: string): null => {
    report({ message, table, column: col.name });
    return null;
  };
  switch (d.kind) {
    case 'null':
      return col.nullable ? 'NULL' : fail('default null on a NOT NULL column');
    case 'expression':
      return translateExpression(d.value, col.kind, report, table, col.name);
    case 'boolean':
      if (col.kind === 'boolean' || col.kind === 'integer') return d.value === 'true' ? '1' : '0';
      return fail(`boolean default on ${col.kind} column`);
    case 'number': {
      if (col.kind === 'boolean') return d.value === '0' || d.value === '1' ? d.value : fail('boolean default must be true/false/0/1');
      if (col.kind === 'integer') return /^-?\d+$/.test(d.value) ? d.value : fail(`'${d.value}' is not an integer`);
      if (col.kind === 'real') return d.value;
      if (col.kind === 'text') return quoteLiteral(d.value);
      return fail(`numeric default on ${col.kind} column`);
    }
    case 'string': {
      if (col.kind === 'boolean') {
        const v = d.value.toLowerCase();
        return v === 'true' || v === '1' ? '1' : v === 'false' || v === '0' ? '0' : fail(`'${d.value}' is not a boolean`);
      }
      if (col.kind === 'integer') return /^-?\d+$/.test(d.value) ? d.value : fail(`'${d.value}' is not an integer`);
      if (col.kind === 'real') return Number.isFinite(Number(d.value)) && d.value.trim() !== '' ? String(Number(d.value)) : fail(`'${d.value}' is not a number`);
      if (col.kind === 'enum' && !col.enumValues?.includes(d.value)) return fail(`default '${d.value}' is not a value of the enum (${col.enumValues?.join(', ')})`);
      if (col.kind === 'json') {
        try {
          JSON.parse(d.value);
        } catch {
          return fail('default is not valid JSON');
        }
      }
      if (col.kind === 'blob') return fail('string default on blob column');
      if (col.maxLength !== null && d.value.length > col.maxLength) return fail(`default exceeds varchar(${col.maxLength})`);
      return quoteLiteral(d.value);
    }
  }
}

// ---------------------------------------------------------------- resolution

interface TableEntry {
  dbml: DbmlTable;
  compiled: CompiledTable;
  uniqueSets: string[][];
}

function flattenName(schema: string | undefined, name: string): string {
  return schema && schema.toLowerCase() !== 'public' ? `${schema}_${name}` : name;
}

function sanitizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function topoSort(tables: CompiledTable[]): CompiledTable[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: CompiledTable[] = [];
  const visit = (t: CompiledTable): void => {
    if (visited.has(t.name) || visiting.has(t.name)) return; // cycles are legal in SQLite; keep declaration order
    visiting.add(t.name);
    for (const fk of t.foreignKeys) {
      const parent = byName.get(fk.refTable);
      if (parent && parent !== t) visit(parent);
    }
    visiting.delete(t.name);
    visited.add(t.name);
    out.push(t);
  };
  tables.forEach(visit);
  return out;
}

function resolveSchema(doc: DbmlDocument, diagnostics: Diagnostic[]): CompiledSchema {
  const report: Report = (d) => diagnostics.push({ severity: 'error', ...d });

  // Enums -------------------------------------------------------------------
  const enums = new Map<string, string[]>();
  const enumsOut: Record<string, string[]> = {};
  for (const e of doc.enums) {
    const key = e.schema && e.schema !== 'public' ? `${e.schema}.${e.name}` : e.name;
    if (enums.has(key)) report({ message: `duplicate enum '${key}'`, line: e.line });
    if (e.values.length === 0) report({ message: `enum '${key}' has no values`, line: e.line });
    const dupes = e.values.filter((v, i) => e.values.indexOf(v) !== i);
    if (dupes.length) report({ message: `enum '${key}' has duplicate values: ${dupes.join(', ')}`, line: e.line });
    enums.set(key, e.values);
    if (e.schema) enums.set(`${e.schema}.${e.name}`, e.values);
    enumsOut[key] = [...e.values];
  }

  // Tables ------------------------------------------------------------------
  const entries: TableEntry[] = [];
  const lookup = new Map<string, TableEntry | 'ambiguous'>();
  const register = (key: string, entry: TableEntry): void => {
    const existing = lookup.get(key);
    lookup.set(key, existing && existing !== entry ? 'ambiguous' : entry);
  };

  for (const t of doc.tables) {
    const name = flattenName(t.schema, t.name);
    if (entries.some((e) => e.compiled.name === name)) {
      report({ message: `duplicate table '${name}'`, line: t.line });
      continue;
    }
    if (name === META_TABLE || name.toLowerCase().startsWith('sqlite_')) {
      report({ message: `table name '${name}' is reserved`, line: t.line });
      continue;
    }
    if (t.columns.length === 0) report({ message: `table '${name}' has no columns`, table: name, line: t.line });

    const colNames = new Set<string>();
    for (const c of t.columns) {
      if (colNames.has(c.name)) report({ message: `duplicate column '${c.name}'`, table: name, line: c.line });
      colNames.add(c.name);
    }

    // Primary key: inline `pk` flags or `indexes { (a, b) [pk] }`.
    const inlinePk = t.columns.filter((c) => c.pk).map((c) => c.name);
    const indexPks = t.indexes.filter((i) => i.pk);
    let primaryKey = inlinePk;
    if (indexPks.length > 1) report({ message: 'multiple [pk] indexes', table: name, line: indexPks[1]!.line });
    if (indexPks.length > 0) {
      const idx = indexPks[0]!;
      if (idx.parts.some((p) => p.kind !== 'column')) report({ message: 'primary key cannot contain expressions', table: name, line: idx.line });
      const cols = idx.parts.filter((p) => p.kind === 'column').map((p) => p.value);
      if (inlinePk.length && !sameSet(inlinePk, cols)) report({ message: 'inline pk and indexes [pk] disagree', table: name, line: idx.line });
      primaryKey = cols;
    }
    for (const pk of primaryKey) if (!colNames.has(pk)) report({ message: `primary key column '${pk}' does not exist`, table: name, line: t.line });

    const compiledColumns: CompiledColumn[] = t.columns.map((c, ordinal) => {
      const info = mapType(c, enums, report, name);
      const isPk = primaryKey.includes(c.name);
      const generated = primaryKey.length === 1 && isPk && info.sqlType === 'INTEGER' && info.kind === 'integer';
      const autoIncrement = generated && (c.increment || info.serial);
      if ((c.increment || info.serial) && !generated) {
        report({
          severity: 'warning',
          message: 'increment/serial is only honored on a single INTEGER primary key; ignored',
          table: name,
          column: c.name,
          line: c.line,
        });
      }
      const partial: Omit<CompiledColumn, 'defaultSql'> = {
        name: c.name,
        kind: info.kind,
        sqlType: info.sqlType,
        sourceType: c.type,
        nullable: !(c.notNull || isPk),
        hasDefault: c.default !== undefined && c.default.kind !== 'null',
        generated,
        autoIncrement,
        primaryKey: isPk,
        unique: c.unique,
        maxLength: info.maxLength,
        enumValues: info.enumValues,
        checks: [...c.checks],
        note: c.note ?? null,
        ordinal,
      };
      const defaultSql = c.default ? translateDefault(c.default, partial, (d) => report({ line: c.line, ...d }), name) : null;
      if (c.default?.kind === 'null' && partial.nullable) partial.hasDefault = false;
      return { ...partial, defaultSql };
    });

    const compiled: CompiledTable = {
      name,
      columns: compiledColumns,
      primaryKey,
      foreignKeys: [],
      indexes: [],
      note: t.note ?? null,
      synthetic: false,
    };
    const uniqueSets: string[][] = [];
    if (primaryKey.length) uniqueSets.push(primaryKey);
    for (const c of compiledColumns) if (c.unique) uniqueSets.push([c.name]);

    // Secondary indexes.
    for (const idx of t.indexes) {
      if (idx.pk) continue;
      for (const p of idx.parts) {
        if (p.kind === 'column' && !colNames.has(p.value)) report({ message: `index column '${p.value}' does not exist`, table: name, line: idx.line });
      }
      const label = idx.parts.map((p, i) => (p.kind === 'column' ? p.value : `expr${i}`)).join('_');
      compiled.indexes.push({
        name: idx.name ?? sanitizeName(`${idx.unique ? 'ux' : 'ix'}_${name}_${label}`),
        unique: idx.unique,
        parts: idx.parts.map((p) => ({ ...p })),
      });
      if (idx.unique && idx.parts.every((p) => p.kind === 'column')) uniqueSets.push(idx.parts.map((p) => p.value));
    }

    const entry: TableEntry = { dbml: t, compiled, uniqueSets };
    entries.push(entry);
    register(`${t.schema ?? 'public'}.${t.name}`, entry);
    register(t.name, entry);
    if (t.alias) register(t.alias, entry);
  }

  // References -------------------------------------------------------------
  interface PendingRef {
    op: RefOp;
    left: { entry: TableEntry; columns: string[] };
    right: DbmlEndpoint;
    onDelete?: DbmlReferentialAction;
    onUpdate?: DbmlReferentialAction;
    line: number;
  }

  const resolveEndpoint = (ep: DbmlEndpoint): TableEntry | null => {
    const key = ep.schema ? `${ep.schema}.${ep.table}` : ep.table;
    const hit = lookup.get(key);
    if (hit === 'ambiguous') {
      report({ message: `table reference '${key}' is ambiguous; qualify it with its schema`, line: ep.line });
      return null;
    }
    if (!hit) {
      report({ message: `reference to unknown table '${key}'`, line: ep.line });
      return null;
    }
    for (const c of ep.columns) {
      if (!hit.compiled.columns.some((col) => col.name === c)) {
        report({ message: `reference to unknown column '${hit.compiled.name}.${c}'`, line: ep.line });
        return null;
      }
    }
    return hit;
  };

  const pending: PendingRef[] = [];
  for (const entry of entries) {
    for (const c of entry.dbml.columns) {
      for (const r of c.inlineRefs) pending.push({ op: r.op, left: { entry, columns: [c.name] }, right: r.target, line: c.line });
    }
  }
  for (const r of doc.refs) {
    const leftEntry = resolveEndpoint(r.left);
    if (!leftEntry) continue;
    const p: PendingRef = { op: r.op, left: { entry: leftEntry, columns: r.left.columns }, right: r.right, line: r.line };
    if (r.onDelete) p.onDelete = r.onDelete;
    if (r.onUpdate) p.onUpdate = r.onUpdate;
    pending.push(p);
  }

  const junctions: CompiledTable[] = [];

  for (const p of pending) {
    const rightEntry = resolveEndpoint(p.right);
    if (!rightEntry) continue;
    const left = p.left;
    const right = { entry: rightEntry, columns: p.right.columns };
    if (left.columns.length !== right.columns.length) {
      report({ message: 'composite reference column counts differ', line: p.line });
      continue;
    }

    if (p.op === '<>') {
      junctions.push(...buildJunction(left, right, entries, junctions, report, p.line));
      continue;
    }

    const [child, parent] = p.op === '<' ? [right, left] : [left, right];
    const parentUnique = parent.entry.uniqueSets.some((s) => sameSet(s, parent.columns));
    if (!parentUnique) {
      report({
        message: `foreign key target ${parent.entry.compiled.name}(${parent.columns.join(', ')}) must be a primary key or unique; SQLite rejects writes otherwise`,
        line: p.line,
      });
      continue;
    }

    child.columns.forEach((cName, i) => {
      const cc = child.entry.compiled.columns.find((c) => c.name === cName)!;
      const pc = parent.entry.compiled.columns.find((c) => c.name === parent.columns[i])!;
      if (cc.sqlType !== pc.sqlType) {
        report({
          severity: 'warning',
          message: `type mismatch: ${child.entry.compiled.name}.${cc.name} (${cc.sourceType}) → ${parent.entry.compiled.name}.${pc.name} (${pc.sourceType})`,
          line: p.line,
        });
      }
      if (p.onDelete === 'set null' && !cc.nullable) {
        report({ message: `ON DELETE SET NULL on NOT NULL column ${child.entry.compiled.name}.${cc.name}`, line: p.line });
      }
    });

    const fk: CompiledForeignKey = {
      columns: [...child.columns],
      refTable: parent.entry.compiled.name,
      refColumns: [...parent.columns],
      onDelete: p.onDelete ? ACTION_MAP[p.onDelete] : null,
      onUpdate: p.onUpdate ? ACTION_MAP[p.onUpdate] : null,
    };
    const fks = child.entry.compiled.foreignKeys;
    const dup = fks.find((f) => sameSet(f.columns, fk.columns) && f.refTable === fk.refTable && sameSet(f.refColumns, fk.refColumns));
    if (dup) {
      dup.onDelete ??= fk.onDelete;
      dup.onUpdate ??= fk.onUpdate;
    } else {
      fks.push(fk);
    }

    // One-to-one: enforce uniqueness on the child side.
    if (p.op === '-' && !child.entry.uniqueSets.some((s) => sameSet(s, child.columns))) {
      const t = child.entry.compiled;
      t.indexes.push({ name: sanitizeName(`ux_${t.name}_${child.columns.join('_')}`), unique: true, parts: child.columns.map((value) => ({ kind: 'column', value })) });
      child.entry.uniqueSets.push([...child.columns]);
    }
  }

  // Index every FK child column set (SQLite does not do this automatically).
  const allTables = [...entries.map((e) => e.compiled), ...junctions];
  for (const t of allTables) {
    for (const fk of t.foreignKeys) {
      const covered =
        t.primaryKey.slice(0, fk.columns.length).every((c, i) => c === fk.columns[i]) && t.primaryKey.length >= fk.columns.length
          ? true
          : t.indexes.some((idx) => fk.columns.every((c, i) => idx.parts[i]?.kind === 'column' && idx.parts[i]?.value === c));
      if (!covered) {
        t.indexes.push({ name: sanitizeName(`ix_${t.name}_${fk.columns.join('_')}_fk`), unique: false, parts: fk.columns.map((value) => ({ kind: 'column', value })) });
      }
    }
  }

  // Index names are database-global in SQLite.
  const indexNames = new Map<string, string>();
  for (const t of allTables) {
    for (const idx of t.indexes) {
      const owner = indexNames.get(idx.name);
      if (owner) report({ message: `index name '${idx.name}' is used by both '${owner}' and '${t.name}'`, table: t.name });
      indexNames.set(idx.name, t.name);
    }
  }

  return { tables: topoSort(allTables), enums: enumsOut };
}

function buildJunction(
  left: { entry: TableEntry; columns: string[] },
  right: { entry: TableEntry; columns: string[] },
  entries: TableEntry[],
  existing: CompiledTable[],
  report: Report,
  line: number,
): CompiledTable[] {
  for (const side of [left, right]) {
    if (!side.entry.uniqueSets.some((s) => sameSet(s, side.columns))) {
      report({ message: `many-to-many endpoint ${side.entry.compiled.name}(${side.columns.join(', ')}) must be a primary key or unique`, line });
      return [];
    }
  }
  const a = left.entry.compiled;
  const b = right.entry.compiled;
  const name = sanitizeName(`${a.name}_${b.name}`);
  if (entries.some((e) => e.compiled.name === name) || existing.some((t) => t.name === name)) {
    report({ message: `cannot create junction table '${name}' for ${a.name} <> ${b.name}: name already taken`, line });
    return [];
  }
  const selfRef = a === b;
  const mk = (src: CompiledTable, col: string, prefix: string, ordinal: number): CompiledColumn => {
    const s = src.columns.find((c) => c.name === col)!;
    return {
      name: sanitizeName(`${prefix}${src.name}_${col}`),
      kind: s.kind,
      sqlType: s.sqlType,
      sourceType: s.sourceType,
      nullable: false,
      hasDefault: false,
      generated: false,
      autoIncrement: false,
      primaryKey: true,
      unique: false,
      maxLength: null,
      enumValues: s.enumValues ? [...s.enumValues] : null,
      defaultSql: null,
      checks: [],
      note: null,
      ordinal,
    };
  };
  const leftCols = left.columns.map((c, i) => mk(a, c, '', i));
  const rightCols = right.columns.map((c, i) => mk(b, c, selfRef ? 'related_' : '', leftCols.length + i));
  const columns = [...leftCols, ...rightCols];
  return [
    {
      name,
      columns,
      primaryKey: columns.map((c) => c.name),
      foreignKeys: [
        { columns: leftCols.map((c) => c.name), refTable: a.name, refColumns: [...left.columns], onDelete: 'CASCADE', onUpdate: null },
        { columns: rightCols.map((c) => c.name), refTable: b.name, refColumns: [...right.columns], onDelete: 'CASCADE', onUpdate: null },
      ],
      indexes: [] as CompiledIndex[],
      note: `Junction table for ${a.name} <> ${b.name}`,
      synthetic: true,
    },
  ];
}

// --------------------------------------------------------------- entry point

/**
 * Compile a DBML document into a SQLite/Wasm migration plus a UI manifest.
 *
 * Throws {@link IceboltCompileError} (with every diagnostic) on syntax errors,
 * unresolved references, invalid defaults, or malformed `@ui:` directives.
 */
export function compileSchema(dbmlInput: string, options: CompileOptions = {}): CompileResult {
  const strict = options.strict ?? true;
  const diagnostics: Diagnostic[] = [];

  let doc: DbmlDocument;
  try {
    doc = parseDbml(dbmlInput);
  } catch (err) {
    if (err instanceof DbmlSyntaxError) throw new IceboltCompileError([{ severity: 'error', message: err.message, line: err.line }]);
    throw err;
  }

  const schema = resolveSchema(doc, diagnostics);
  if (diagnostics.some((d) => d.severity === 'error')) throw new IceboltCompileError(diagnostics);

  const ddl = emitDdl(schema, strict);
  const schemaHash = schemaFingerprint(`${strict ? 'strict' : 'loose'}\n${ddl}`);

  // ---- versioning + migration from the previous lock
  const prev = options.previous ?? null;
  if (prev && prev.format !== 1) throw new IceboltCompileError([{ severity: 'error', message: `unsupported lockfile format ${String(prev.format)}` }]);
  const changed = !!prev && prev.current.hash !== schemaHash;
  const version = prev ? prev.current.version + (changed ? 1 : 0) : 1;
  const snapshot: SchemaSnapshot = {
    format: 1,
    version,
    hash: schemaHash,
    strict,
    schema,
    renames: collectRenames(schema, prev?.current.renames ?? EMPTY_RENAMES),
    drops: mergeDrops(prev?.current.drops ?? EMPTY_DROPS, options.allowDrop ?? []),
  };
  let migration: MigrationPlan | null = null;
  if (changed) {
    try {
      migration = planMigration(prev.current, snapshot);
    } catch (err) {
      if (!(err instanceof IceboltMigrationError)) throw err;
      throw new IceboltCompileError([
        ...diagnostics,
        ...err.problems.map((message): Diagnostic => ({ severity: 'error', message: `migration from v${prev.current.version}: ${message}` })),
      ]);
    }
    for (const w of migration.warnings) diagnostics.push({ severity: 'warning', message: `migration from v${prev.current.version}: ${w}` });
  }
  const history = (prev?.history ?? []).filter((h) => h.hash !== schemaHash);
  history.push({ version, hash: schemaHash, strict, schema });
  history.sort((a, b) => a.version - b.version);
  const lock: SchemaLock = { format: 1, current: snapshot, history };

  const sqlMigration = emitMigration(ddl, schemaHash, strict, { version, json: JSON.stringify(snapshot) });
  const uiManifest = buildUiManifest(schema, schemaHash, diagnostics);
  if (diagnostics.some((d) => d.severity === 'error')) throw new IceboltCompileError(diagnostics);

  return { sqlMigration, uiManifest, schema, schemaHash, diagnostics, snapshot, lock, migration };
}
