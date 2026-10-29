/**
 * `icebolt compile` — compile a DBML file into the typed client, UI manifest
 * and migration SQL, keeping `icebolt.schema.lock.json` (commit it) up to date
 * so every schema change gets an upgrade path for users' existing databases.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateClientSource } from '../client/generateClient.js';
import { compileSchema, type CompileResult } from '../schema/compileSchema.js';
import type { SchemaLock } from '../schema/migrate.js';

export interface CompileProjectOptions {
  /** Path to the .dbml file. */
  schemaPath: string;
  /** Directory for icebolt-client.ts, ui-manifest.json and migration.sql. */
  outDir: string;
  /** Default: icebolt.schema.lock.json next to the schema. */
  lockPath?: string;
  /** Confirm deletions: 'table' or 'table.column'. Remembered in the lock. */
  allowDrop?: string[];
  /** Module specifier the generated client imports the runtime from. */
  runtimeImport?: string;
}

export interface CompileProjectResult {
  result: CompileResult;
  lockPath: string;
  /** True when this compile created a new schema version. */
  newVersion: boolean;
  written: string[];
}

export function readLock(path: string): SchemaLock | null {
  if (!existsSync(path)) return null;
  const lock = JSON.parse(readFileSync(path, 'utf8')) as SchemaLock;
  if (lock.format !== 1 || !lock.current || !Array.isArray(lock.history)) throw new Error(`${path} is not an Icebolt schema lockfile`);
  return lock;
}

export function compileProject(opts: CompileProjectOptions): CompileProjectResult {
  const lockPath = opts.lockPath ?? join(dirname(opts.schemaPath), 'icebolt.schema.lock.json');
  const previous = readLock(lockPath);
  const result = compileSchema(readFileSync(opts.schemaPath, 'utf8'), { previous, allowDrop: opts.allowDrop ?? [] });
  mkdirSync(opts.outDir, { recursive: true });
  const files: Array<[string, string]> = [
    [join(opts.outDir, 'icebolt-client.ts'), generateClientSource(result, opts.runtimeImport ? { runtimeImport: opts.runtimeImport } : {})],
    [join(opts.outDir, 'ui-manifest.json'), `${JSON.stringify(result.uiManifest, null, 2)}\n`],
    [join(opts.outDir, 'migration.sql'), result.sqlMigration],
    [lockPath, `${JSON.stringify(result.lock, null, 2)}\n`],
  ];
  const written: string[] = [];
  for (const [path, content] of files) {
    if (existsSync(path) && readFileSync(path, 'utf8') === content) continue;
    writeFileSync(path, content);
    written.push(path);
  }
  return { result, lockPath, newVersion: !previous || previous.current.hash !== result.schemaHash, written };
}
