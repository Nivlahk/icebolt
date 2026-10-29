/**
 * Schema migrations: diff two compiled schemas and produce the SQL that turns
 * a database holding the old one into the new one, without losing rows.
 *
 * Pure (no Node APIs): the same planner runs at compile time, to check a
 * change and report problems, and in the user's browser, to upgrade the
 * database they already have.
 *
 * Strategy per table:
 *  - only new nullable / constant-default columns  → ALTER TABLE … ADD COLUMN
 *  - only renamed columns                          → ALTER TABLE … RENAME COLUMN
 *  - anything else (type, constraint, key, foreign key, dropped column)
 *                                                  → SQLite's documented table
 *    rebuild: create the new shape, copy rows across, drop the old, rename.
 * Renames need a `@renamed-from: old_name` note; a diff alone cannot tell a
 * rename from "dropped one column, added another". Drops must be acknowledged,
 * so data never disappears by accident.
 */
import type { CompiledColumn, CompiledSchema, CompiledTable } from '../types.js';
import { columnDefinition, createIndexSql, createTableSql, quoteIdent, schemaMetaSql } from './sql.js';

export interface RenameMap {
  /** new table name → earlier names, most recent first */
  tables: Record<string, string[]>;
  /** table (current name) → new column name → earlier names */
  columns: Record<string, Record<string, string[]>>;
}

export interface DropList {
  /** tables the developer confirmed may be deleted (old names) */
  tables: string[];
  /** table → columns confirmed for deletion (old names) */
  columns: Record<string, string[]>;
}

/** Everything needed to upgrade from this schema later. Stored in each database and in the lockfile. */
export interface SchemaSnapshot {
  format: 1;
  version: number;
  hash: string;
  strict: boolean;
  schema: CompiledSchema;
  renames: RenameMap;
  drops: DropList;
}

export interface SchemaHistoryEntry {
  version: number;
  hash: string;
  strict: boolean;
  schema: CompiledSchema;
}

/** `icebolt.schema.lock.json` — commit it with the app. */
export interface SchemaLock {
  format: 1;
  current: SchemaSnapshot;
  history: SchemaHistoryEntry[];
}

export type MigrationStepKind =
  | 'rename-table'
  | 'create-table'
  | 'rename-column'
  | 'add-column'
  | 'rebuild-table'
  | 'drop-table'
  | 'drop-index'
  | 'create-index'
  | 'record-version';

export interface MigrationStep {
  kind: MigrationStepKind;
  table: string | null;
  description: string;
  sql: string[];
}

export interface MigrationPlan {
  fromVersion: number;
  toVersion: number;
  fromHash: string;
  toHash: string;
  steps: MigrationStep[];
  /** Changes that can fail on some data (the upgrade then rolls back) or lose precision. */
  warnings: string[];
}

export class IceboltMigrationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[], prefix = 'This schema change cannot be applied safely') {
    super(`${prefix}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'IceboltMigrationError';
    this.problems = problems;
  }
}

export const EMPTY_RENAMES: RenameMap = { tables: {}, columns: {} };
export const EMPTY_DROPS: DropList = { tables: [], columns: {} };

// ------------------------------------------------------------------ helpers

const RENAMED_FROM = /@renamed-from:\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)/;

/** Earlier names declared in a note: `@renamed-from: old_name, older_name`. */
export function parseRenamedFrom(note: string | null | undefined): string[] {
  const m = note ? RENAMED_FROM.exec(note) : null;
  return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Rename hints from the schema's notes, merged with hints remembered from earlier versions. */
export function collectRenames(schema: CompiledSchema, previous: RenameMap = EMPTY_RENAMES): RenameMap {
  const tables: Record<string, string[]> = {};
  const columns: Record<string, Record<string, string[]>> = {};
  for (const t of schema.tables) {
    const tHints = uniq([...parseRenamedFrom(t.note), ...(previous.tables[t.name] ?? [])]).filter((n) => n !== t.name);
    if (tHints.length) tables[t.name] = tHints;
    // Column history may be recorded under the table's earlier names too.
    const prevCols: Record<string, string[]> = {};
    for (const name of [t.name, ...tHints]) {
      for (const [col, olds] of Object.entries(previous.columns[name] ?? {})) prevCols[col] = uniq([...(prevCols[col] ?? []), ...olds]);
    }
    for (const c of t.columns) {
      const hints = uniq([...parseRenamedFrom(c.note), ...(prevCols[c.name] ?? [])]).filter((n) => n !== c.name);
      if (hints.length) (columns[t.name] ??= {})[c.name] = hints;
    }
  }
  return { tables, columns };
}

export function mergeDrops(previous: DropList, allowDrop: readonly string[]): DropList {
  const tables = new Set(previous.tables);
  const columns: Record<string, string[]> = {};
  for (const [t, cs] of Object.entries(previous.columns)) columns[t] = [...cs];
  for (const item of allowDrop) {
    const [t, c] = item.split('.') as [string, string | undefined];
    if (!t) continue;
    if (c) columns[t] = uniq([...(columns[t] ?? []), c]);
    else tables.add(t);
  }
  return { tables: [...tables], columns };
}

/** Column definition without its name, so a pure rename compares equal. */
function shape(table: CompiledTable, col: CompiledColumn): string {
  const def = columnDefinition(table, col);
  const q = quoteIdent(col.name);
  return def.slice(q.length).split(q).join('"§"');
}

function isConstantDefault(sql: string | null): boolean {
  return sql === null || !sql.startsWith('(');
}

// ------------------------------------------------------------------ planner

interface FromLike {
  version: number;
  hash: string;
  schema: CompiledSchema;
}

/**
 * Plan the upgrade from `from` to `to`. Throws {@link IceboltMigrationError}
 * listing every problem (unconfirmed drops, new required columns without a
 * default, …) instead of producing a plan that would lose data.
 */
export function planMigration(from: FromLike, to: SchemaSnapshot): MigrationPlan {
  const problems: string[] = [];
  const warnings: string[] = [];
  const steps: MigrationStep[] = [];
  const oldTables = new Map(from.schema.tables.map((t) => [t.name, t]));
  const usedOld = new Set<string>();

  // ---- match tables (same name, else a declared earlier name)
  const pairs: Array<{ next: CompiledTable; prev: CompiledTable | null }> = [];
  for (const t of to.schema.tables) {
    let prev = oldTables.get(t.name) ?? null;
    if (!prev) {
      for (const old of to.renames.tables[t.name] ?? []) {
        const candidate = oldTables.get(old);
        if (candidate && !to.schema.tables.some((x) => x.name === old)) {
          prev = candidate;
          break;
        }
      }
    }
    if (prev) usedOld.add(prev.name);
    pairs.push({ next: t, prev });
  }
  const tableNameMap = new Map<string, string>(pairs.filter((p) => p.prev).map((p) => [p.prev!.name, p.next.name]));

  // ---- table renames first, so everything below can use the new names
  for (const { next, prev } of pairs) {
    if (prev && prev.name !== next.name) {
      steps.push({
        kind: 'rename-table',
        table: next.name,
        description: `Rename table ${prev.name} → ${next.name}`,
        sql: [`ALTER TABLE ${quoteIdent(prev.name)} RENAME TO ${quoteIdent(next.name)};`],
      });
    }
  }

  // ---- new tables
  for (const { next, prev } of pairs) {
    if (!prev) steps.push({ kind: 'create-table', table: next.name, description: `Create table ${next.name}`, sql: [createTableSql(next, to.strict)] });
  }

  // ---- changed tables
  const rebuilt = new Set<string>();
  for (const { next, prev } of pairs) {
    if (!prev) continue;
    const oldCols = new Map(prev.columns.map((c) => [c.name, c]));
    const matched = new Map<string, CompiledColumn>(); // new name → old column
    const usedCols = new Set<string>();
    for (const c of next.columns) {
      let old = oldCols.get(c.name);
      if (!old) {
        for (const hint of to.renames.columns[next.name]?.[c.name] ?? []) {
          const cand = oldCols.get(hint);
          if (cand && !next.columns.some((x) => x.name === hint)) {
            old = cand;
            break;
          }
        }
      }
      if (old) {
        matched.set(c.name, old);
        usedCols.add(old.name);
      }
    }

    const dropped = prev.columns.filter((c) => !usedCols.has(c.name));
    for (const d of dropped) {
      const ok = (to.drops.columns[next.name] ?? []).includes(d.name) || (to.drops.columns[prev.name] ?? []).includes(d.name);
      if (!ok) {
        problems.push(
          `Column ${next.name}.${d.name} is gone. If it was renamed, add @renamed-from: ${d.name} to the new column's note; if its data should really be deleted, confirm with allowDrop: ['${next.name}.${d.name}'] (CLI: --allow-drop ${next.name}.${d.name}).`,
        );
      }
    }

    const renamedCols: Array<[string, string]> = [];
    const added: CompiledColumn[] = [];
    let needsRebuild = dropped.length > 0;
    for (const c of next.columns) {
      const old = matched.get(c.name);
      if (!old) {
        added.push(c);
        if (!c.nullable && c.defaultSql === null && !c.generated) {
          problems.push(`New column ${next.name}.${c.name} is required (not null) but has no default, so existing rows would have no value. Give it a default, or make it nullable.`);
        }
        const inFk = next.foreignKeys.some((fk) => fk.columns.includes(c.name));
        if (c.primaryKey || c.unique || inFk || !isConstantDefault(c.defaultSql) || (!c.nullable && c.defaultSql === null)) needsRebuild = true;
        continue;
      }
      if (old.name !== c.name) renamedCols.push([old.name, c.name]);
      if (shape(prev, old) !== shape(next, c)) {
        needsRebuild = true;
        if (old.nullable && !c.nullable && c.defaultSql === null) {
          problems.push(`Column ${next.name}.${c.name} became required (not null) without a default, so rows where it is empty cannot be kept. Give it a default.`);
        }
        if (old.sqlType !== c.sqlType) warnings.push(`${next.name}.${c.name} changes type ${old.sqlType} → ${c.sqlType}; values are converted with CAST, which can lose information.`);
        if (old.kind === 'enum' && c.kind === 'enum' && (old.enumValues ?? []).some((v) => !(c.enumValues ?? []).includes(v))) {
          warnings.push(`${next.name}.${c.name} no longer allows ${(old.enumValues ?? []).filter((v) => !(c.enumValues ?? []).includes(v)).join(', ')}; the upgrade rolls back if any row still uses those values.`);
        }
        if (c.maxLength !== null && (old.maxLength === null || c.maxLength < old.maxLength)) {
          warnings.push(`${next.name}.${c.name} is now limited to ${c.maxLength} characters; the upgrade rolls back if any row is longer.`);
        }
      }
    }

    // Keys and foreign keys, compared through the rename maps.
    const mapCol = (n: string): string => [...matched.entries()].find(([, o]) => o.name === n)?.[0] ?? n;
    const pkChanged = JSON.stringify(prev.primaryKey.map(mapCol)) !== JSON.stringify(next.primaryKey);
    const fkKey = (t: CompiledTable, mapCols: (n: string) => string, mapTable: (n: string) => string): string =>
      JSON.stringify(
        t.foreignKeys
          .map((f) => ({ c: f.columns.map(mapCols), t: mapTable(f.refTable), r: f.refColumns, d: f.onDelete, u: f.onUpdate }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
    const fkChanged = fkKey(prev, mapCol, (n) => tableNameMap.get(n) ?? n) !== fkKey(next, (n) => n, (n) => n);
    // A renamed parent's referenced columns may also be renamed; the rebuild handles that too.
    const refColsRenamed = next.foreignKeys.some((f) => {
      const parent = pairs.find((p) => p.next.name === f.refTable);
      return !!parent?.prev && f.refColumns.some((rc) => !parent.prev!.columns.some((pc) => pc.name === rc));
    });
    if (pkChanged || fkChanged || refColsRenamed) needsRebuild = true;

    if (needsRebuild) {
      rebuilt.add(next.name);
      const tmp = `__icebolt_new_${next.name}`;
      const into: string[] = [];
      const select: string[] = [];
      for (const c of next.columns) {
        const old = matched.get(c.name);
        if (!old) continue; // new column: its default (or NULL) applies
        let expr = quoteIdent(old.name);
        if (old.sqlType !== c.sqlType) expr = `CAST(${expr} AS ${c.sqlType})`;
        if (!c.nullable && old.nullable && c.defaultSql !== null) expr = `COALESCE(${expr}, ${c.defaultSql})`;
        into.push(quoteIdent(c.name));
        select.push(expr);
      }
      const sourceName = next.name; // the table rename (if any) already ran
      const sql = [
        createTableSql({ ...next, name: tmp }, to.strict),
        into.length
          ? `INSERT INTO ${quoteIdent(tmp)} (${into.join(', ')}) SELECT ${select.join(', ')} FROM ${quoteIdent(sourceName)};`
          : `-- no columns carried over from ${next.name}`,
        `DROP TABLE ${quoteIdent(sourceName)};`,
        `ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(next.name)};`,
      ].filter((s) => !s.startsWith('--'));
      const what = [
        ...renamedCols.map(([a, b]) => `${a} → ${b}`),
        ...added.map((c) => `+${c.name}`),
        ...dropped.map((c) => `−${c.name}`),
        ...next.columns.filter((c) => matched.get(c.name) && shape(prev, matched.get(c.name)!) !== shape(next, c)).map((c) => `~${c.name}`),
        ...(pkChanged ? ['primary key'] : []),
        ...(fkChanged || refColsRenamed ? ['foreign keys'] : []),
      ];
      steps.push({ kind: 'rebuild-table', table: next.name, description: `Rebuild ${next.name} keeping its rows (${what.join(', ')})`, sql });
    } else {
      for (const [a, b] of renamedCols) {
        steps.push({
          kind: 'rename-column',
          table: next.name,
          description: `Rename ${next.name}.${a} → ${b}`,
          sql: [`ALTER TABLE ${quoteIdent(next.name)} RENAME COLUMN ${quoteIdent(a)} TO ${quoteIdent(b)};`],
        });
      }
      for (const c of added) {
        steps.push({
          kind: 'add-column',
          table: next.name,
          description: `Add column ${next.name}.${c.name}`,
          sql: [`ALTER TABLE ${quoteIdent(next.name)} ADD COLUMN ${columnDefinition(next, c)};`],
        });
      }
    }
  }

  // ---- dropped tables
  for (const t of from.schema.tables) {
    if (usedOld.has(t.name)) continue;
    if (!to.drops.tables.includes(t.name)) {
      problems.push(
        `Table ${t.name} is gone. If it was renamed, add @renamed-from: ${t.name} to the new table's Note; if its data should really be deleted, confirm with allowDrop: ['${t.name}'] (CLI: --allow-drop ${t.name}).`,
      );
      continue;
    }
    steps.push({ kind: 'drop-table', table: t.name, description: `Delete table ${t.name} (confirmed)`, sql: [`DROP TABLE IF EXISTS ${quoteIdent(t.name)};`] });
  }

  // ---- indexes: compare by name and definition
  const oldIdx = new Map<string, string>();
  for (const t of from.schema.tables) {
    const renamedTo = tableNameMap.get(t.name);
    if (!renamedTo || rebuilt.has(renamedTo)) continue; // gone with the table or rebuilt from scratch
    const asNew = { ...t, name: renamedTo };
    t.indexes.forEach((idx, i) => oldIdx.set(idx.name, createIndexSql(asNew)[i]!));
  }
  const newIdx = new Map<string, { sql: string; table: string }>();
  for (const t of to.schema.tables) t.indexes.forEach((idx, i) => newIdx.set(idx.name, { sql: createIndexSql(t)[i]!, table: t.name }));
  for (const [name, sql] of oldIdx) {
    const n = newIdx.get(name);
    if (!n || n.sql !== sql) steps.push({ kind: 'drop-index', table: null, description: `Drop index ${name}`, sql: [`DROP INDEX IF EXISTS ${quoteIdent(name)};`] });
  }
  for (const [name, n] of newIdx) {
    const isNewTable = pairs.some((p) => p.next.name === n.table && !p.prev);
    if (oldIdx.get(name) === n.sql) continue;
    steps.push({ kind: 'create-index', table: n.table, description: `${isNewTable || rebuilt.has(n.table) ? 'Create' : 'Recreate'} index ${name}`, sql: [n.sql] });
  }

  if (problems.length) throw new IceboltMigrationError(problems);

  steps.push({
    kind: 'record-version',
    table: null,
    description: `Record schema version ${to.version}`,
    sql: schemaMetaSql(to.hash, to.version, JSON.stringify(to)),
  });
  return { fromVersion: from.version, toVersion: to.version, fromHash: from.hash, toHash: to.hash, steps, warnings };
}

/** Readable summary for logs and CLI output. */
export function describeMigration(plan: MigrationPlan): string {
  const lines = [`Schema v${plan.fromVersion} → v${plan.toVersion}`];
  for (const s of plan.steps) if (s.kind !== 'record-version') lines.push(`  • ${s.description}`);
  for (const w of plan.warnings) lines.push(`  ! ${w}`);
  return lines.join('\n');
}
