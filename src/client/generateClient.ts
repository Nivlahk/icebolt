import type { SchemaLock, SchemaSnapshot } from '../schema/migrate.js';
import type { UiManifest } from '../ui/types.js';
import type { CompiledColumn, CompiledSchema, CompiledTable } from '../types.js';

export interface GenerateClientInput {
  schema: CompiledSchema;
  sqlMigration: string;
  schemaHash: string;
  /** Current schema snapshot; enables in-place upgrades of older databases. */
  snapshot?: SchemaSnapshot;
  /** The lockfile; its history lets databases from any earlier version upgrade. */
  lock?: SchemaLock;
  /** Also export the UI manifest (forms and buttons from @ui notes) as UI_MANIFEST. */
  uiManifest?: UiManifest;
}

export interface GenerateClientOptions {
  /** Module specifier for the runtime. Default `@icebolt/compiler-core/runtime`. */
  runtimeImport?: string;
  /** Name of the generated database type. Default `IceboltDatabase`. */
  databaseTypeName?: string;
}

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);

function pascal(name: string): string {
  const p = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
  return /^[0-9]/.test(p) || p === '' ? `T${p}` : p;
}

function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : JSON.stringify(name);
}

function tsType(col: CompiledColumn, forInsert: boolean): string {
  let t: string;
  switch (col.kind) {
    case 'integer':
    case 'real':
      t = 'number';
      break;
    case 'boolean':
      t = 'boolean';
      break;
    case 'json':
      t = 'JsonValue';
      break;
    case 'blob':
      t = 'Uint8Array';
      break;
    case 'enum':
      t = (col.enumValues ?? []).map((v) => JSON.stringify(v)).join(' | ') || 'string';
      break;
    case 'date':
    case 'datetime':
      t = forInsert ? 'string | Date' : 'string';
      break;
    default:
      t = 'string';
  }
  return col.nullable ? `${t} | null` : t;
}

function docComment(lines: string[], indent = ''): string {
  const clean = lines.filter(Boolean).map((l) => l.replace(/\*\//g, '* /'));
  if (clean.length === 0) return '';
  if (clean.length === 1) return `${indent}/** ${clean[0]} */\n`;
  return `${indent}/**\n${clean.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

function columnDoc(col: CompiledColumn): string[] {
  const facts = [col.sourceType];
  if (col.primaryKey) facts.push('primary key');
  if (col.generated) facts.push('generated');
  if (col.unique) facts.push('unique');
  if (col.defaultSql !== null) facts.push(col.defaultSql.length <= 48 ? `default ${col.defaultSql}` : col.defaultSql.includes('randomblob') ? 'default uuid v4' : 'has default');
  const note = col.note?.replace(/@ui:[\s\S]*$/, '').trim();
  return [note ?? '', `\`${facts.join(', ')}\``];
}

function tableTypes(table: CompiledTable, typeName: string): string {
  const rowFields = table.columns.map((c) => `${docComment(columnDoc(c), '  ')}  ${propKey(c.name)}: ${tsType(c, false)};`).join('\n');
  const insertFields = table.columns
    .map((c) => {
      const optional = c.nullable || c.hasDefault || c.generated;
      return `  ${propKey(c.name)}${optional ? '?' : ''}: ${tsType(c, true)};`;
    })
    .join('\n');
  const header = docComment([table.note ?? '', `Table \`${table.name}\`${table.synthetic ? ' (junction)' : ''}`]);
  return `${header}export interface ${typeName}Row {\n${rowFields}\n}\n\nexport interface ${typeName}Insert {\n${insertFields}\n}`;
}

/** The snapshot row is written by ensureSchema from SCHEMA_SNAPSHOT; no need to ship the JSON twice. */
function stripSnapshotRow(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.startsWith(`INSERT OR REPLACE INTO "__icebolt_meta" ("key", "value") VALUES ('schema_snapshot',`))
    .join('\n');
}

/**
 * Emit a self-describing TypeScript module exposing a strongly typed client:
 *
 *   const client = openIceboltClient(createSqlJsDriver(new SQL.Database()));
 *   client.table('projects').insert({ name: 'Bronze Age Mod' });
 *   client.isDirty; // true
 */
export function generateClientSource(input: GenerateClientInput, options: GenerateClientOptions = {}): string {
  const runtime = options.runtimeImport ?? '@icebolt/compiler-core/runtime';
  const dbType = options.databaseTypeName ?? 'IceboltDatabase';

  const used = new Set<string>([dbType, 'IceboltClient', 'SchemaMeta', 'SqliteDriver', 'JsonValue']);
  const typeNames = new Map<string, string>();
  for (const t of input.schema.tables) {
    let n = pascal(t.name);
    let i = 2;
    while (used.has(n) || used.has(`${n}Row`)) n = `${pascal(t.name)}${i++}`;
    used.add(n);
    typeNames.set(t.name, n);
  }

  const meta: Record<string, { primaryKey: string[]; columns: Record<string, Record<string, unknown>> }> = {};
  for (const t of input.schema.tables) {
    const columns: Record<string, Record<string, unknown>> = {};
    for (const c of t.columns) {
      const m: Record<string, unknown> = { kind: c.kind, nullable: c.nullable, hasDefault: c.hasDefault, generated: c.generated };
      if (c.enumValues) m['enumValues'] = c.enumValues;
      columns[c.name] = m;
    }
    meta[t.name] = { primaryKey: t.primaryKey, columns };
  }

  const tables = input.schema.tables.map((t) => tableTypes(t, typeNames.get(t.name)!)).join('\n\n');
  const dbFields = input.schema.tables
    .map((t) => {
      const n = typeNames.get(t.name)!;
      return `  ${propKey(t.name)}: { row: ${n}Row; insert: ${n}Insert };`;
    })
    .join('\n');

  return `/* eslint-disable */
// AUTO-GENERATED by @icebolt/compiler-core — do not edit.
// schema-hash: ${input.schemaHash}

import {
  IceboltClient,
  ensureSchema,
  type JsonValue,
  type SchemaHistoryEntry,
  type SchemaMeta,
  type SchemaOpenResult,
  type SchemaSnapshot,
  type SqliteDriver,
} from ${JSON.stringify(runtime)};${input.uiManifest ? `\nimport type { UiManifest } from ${JSON.stringify(runtime.replace(/runtime$/, 'ui'))};` : ''}

export type { JsonValue };

${tables}

export interface ${dbType} {
${dbFields}
}

export type TableName = keyof ${dbType};

export const SCHEMA_HASH = ${JSON.stringify(input.schemaHash)};

export const MIGRATION_SQL = ${JSON.stringify(stripSnapshotRow(input.sqlMigration))};

/** Schema version ${input.snapshot?.version ?? 1}. Older databases are upgraded to it when opened. */
export const SCHEMA_SNAPSHOT: SchemaSnapshot | undefined = ${input.snapshot ? JSON.stringify(input.snapshot) : 'undefined'};

/** Every earlier schema version, by hash, for databases that predate stored snapshots. */
export const SCHEMA_HISTORY: Readonly<Record<string, SchemaHistoryEntry>> = ${JSON.stringify(Object.fromEntries((input.lock?.history ?? []).filter((h) => h.hash !== input.schemaHash).map((h) => [h.hash, h])))};

export const schemaMeta = ${JSON.stringify(meta, null, 2)} as const satisfies SchemaMeta;
${input.uiManifest ? `\n/** Forms and buttons declared with @ui notes; render with @icebolt/compiler-core/ui. */\nexport const UI_MANIFEST: UiManifest = ${JSON.stringify(input.uiManifest, null, 2)};\n` : ''}
/** Wrap an already-migrated connection. */
export function createIceboltClient(driver: SqliteDriver): IceboltClient<${dbType}> {
  return new IceboltClient<${dbType}>(driver, schemaMeta);
}

export interface OpenOptions {
  /** Called after an older database was upgraded in place; \`backup\` is the database as it was before. */
  onMigrated?: (result: Extract<SchemaOpenResult, { status: 'migrated' }>) => void;
}

/**
 * Open a connection (empty or previously synced): creates the schema in an
 * empty database, upgrades a database from an earlier schema version in place
 * (one transaction; nothing changes if any step fails), and refuses databases
 * from a newer version or another app.
 */
export function openIceboltClient(driver: SqliteDriver, options: OpenOptions = {}): IceboltClient<${dbType}> {
  const result = ensureSchema(driver, { migrationSql: MIGRATION_SQL, schemaHash: SCHEMA_HASH, snapshot: SCHEMA_SNAPSHOT, history: SCHEMA_HISTORY });
  const client = createIceboltClient(driver);
  if (result.status === 'migrated') {
    client.markDirty(); // the upgraded database syncs, so other devices see the new version
    options.onMigrated?.(result);
  }
  return client;
}
`;
}
