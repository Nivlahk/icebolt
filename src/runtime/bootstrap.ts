import { IceboltMigrationError, planMigration, type MigrationPlan, type SchemaHistoryEntry, type SchemaSnapshot } from '../schema/migrate.js';
import { schemaMetaSql } from '../schema/sql.js';
import type { SqliteDriver } from './driver.js';
import { IceboltSchemaMismatchError, IceboltSchemaTooNewError } from './errors.js';

export interface MigrationBundle {
  migrationSql: string;
  schemaHash: string;
  /** Current schema snapshot (from the compiler). Enables upgrades. */
  snapshot?: SchemaSnapshot;
  /** Earlier schema versions by hash, for databases created before snapshots were stored. */
  history?: Readonly<Record<string, SchemaHistoryEntry>>;
}

export type SchemaOpenResult =
  | { status: 'created'; version: number }
  | { status: 'opened'; version: number }
  | {
      status: 'migrated';
      fromVersion: number;
      version: number;
      /** What changed, in plain language. */
      steps: string[];
      warnings: string[];
      /** The database exactly as it was before the upgrade. Keep it until the upgrade has synced. */
      backup: Uint8Array;
    };

/** @deprecated use SchemaOpenResult['status'] */
export type BootstrapOutcome = SchemaOpenResult['status'];

function meta(driver: SqliteDriver, key: string): string | null {
  const v = driver.all(`SELECT "value" FROM "__icebolt_meta" WHERE "key" = ?`, [key])[0]?.['value'];
  return typeof v === 'string' ? v : null;
}

function parseSnapshot(json: string | null): SchemaSnapshot | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as SchemaSnapshot;
    return s && s.format === 1 && Array.isArray(s.schema?.tables) ? s : null;
  } catch {
    return null;
  }
}

/** Run a migration plan in one transaction; on any failure the database is left exactly as it was. */
export function applyMigration(driver: SqliteDriver, plan: MigrationPlan): void {
  // Foreign keys must be off while tables are rebuilt (SQLite's documented procedure);
  // integrity is checked explicitly before committing.
  driver.exec('PRAGMA foreign_keys = OFF;');
  driver.exec('BEGIN;');
  try {
    for (const step of plan.steps) {
      for (const sql of step.sql) {
        try {
          driver.exec(sql);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new IceboltMigrationError([`${step.description}: ${reason}`], `Upgrading this database from schema v${plan.fromVersion} to v${plan.toVersion} failed, so nothing was changed`);
        }
      }
    }
    const violations = driver.all('PRAGMA foreign_key_check', []);
    if (violations.length) {
      const tables = [...new Set(violations.map((v) => String(v['table'])))];
      throw new IceboltMigrationError(
        [`${violations.length} row(s) in ${tables.join(', ')} would point at rows that no longer exist`],
        `Upgrading this database from schema v${plan.fromVersion} to v${plan.toVersion} failed, so nothing was changed`,
      );
    }
    driver.exec('COMMIT;');
  } catch (err) {
    try {
      driver.exec('ROLLBACK;');
    } catch {
      /* already rolled back */
    }
    throw err;
  } finally {
    driver.exec('PRAGMA foreign_keys = ON;');
  }
}

/**
 * Prepare a database for the compiled schema:
 * - empty database → create the schema;
 * - same schema → open as-is;
 * - older schema of this app → upgrade it in place (one transaction, rolled back on any failure);
 * - newer schema, or a database from another app → refuse, never rewriting user data.
 */
export function ensureSchema(driver: SqliteDriver, bundle: MigrationBundle): SchemaOpenResult {
  const current = bundle.snapshot?.version ?? 1;
  const tables = driver.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'", []);
  const names = tables.map((r) => String(r['name']));

  if (names.length === 0) {
    driver.exec(bundle.migrationSql);
    if (bundle.snapshot) {
      for (const sql of schemaMetaSql(bundle.snapshot.hash, bundle.snapshot.version, JSON.stringify(bundle.snapshot))) driver.exec(sql);
    }
    driver.exec('PRAGMA foreign_keys = ON;');
    return { status: 'created', version: current };
  }
  if (!names.includes('__icebolt_meta')) throw new IceboltSchemaMismatchError(bundle.schemaHash, null);

  const storedHash = meta(driver, 'schema_hash');
  const storedSnapshot = parseSnapshot(meta(driver, 'schema_snapshot'));

  if (storedHash === bundle.schemaHash) {
    // Databases created before snapshots existed get one now, so later upgrades can diff from it.
    if (!storedSnapshot && bundle.snapshot) {
      for (const sql of schemaMetaSql(bundle.snapshot.hash, bundle.snapshot.version, JSON.stringify(bundle.snapshot))) driver.exec(sql);
    }
    driver.exec('PRAGMA foreign_keys = ON;');
    const violations = driver.all('PRAGMA foreign_key_check', []);
    if (violations.length > 0) throw new Error(`Opened database has ${violations.length} foreign-key violation(s); refusing to continue.`);
    return { status: 'opened', version: current };
  }

  if (!bundle.snapshot) throw new IceboltSchemaMismatchError(bundle.schemaHash, storedHash);

  const from =
    storedSnapshot && storedSnapshot.hash === storedHash
      ? storedSnapshot
      : storedHash && bundle.history?.[storedHash]
        ? bundle.history[storedHash]!
        : null;
  if (!from) {
    // Unknown schema: either made by a newer version of this app, or something else entirely.
    if (storedSnapshot && storedSnapshot.version > current) throw new IceboltSchemaTooNewError(storedSnapshot.version, current);
    throw new IceboltSchemaMismatchError(bundle.schemaHash, storedHash);
  }
  if (from.version > current) throw new IceboltSchemaTooNewError(from.version, current);

  const plan = planMigration(from, bundle.snapshot);
  const backup = driver.export();
  applyMigration(driver, plan);
  return {
    status: 'migrated',
    fromVersion: from.version,
    version: current,
    steps: plan.steps.filter((s) => s.kind !== 'record-version').map((s) => s.description),
    warnings: plan.warnings,
    backup,
  };
}
