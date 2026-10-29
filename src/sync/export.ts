/**
 * Readable per-table copies for analysis tools.
 *
 * For every table: `<table>.ndjson` (newline-delimited JSON — a format
 * BigQuery can query directly from Drive) and `<table>.bigquery-schema.json`
 * (exact column types for `bq mk --external_table_definition`). Rows are
 * ordered by primary key so unchanged tables produce identical bytes and are
 * skipped on upload.
 */
import type { SchemaMeta } from '../runtime/client.js';
import type { ValueKind } from '../types.js';

export interface ExportFile {
  /** Stable identity across syncs (stored as a private appProperty). */
  key: string;
  name: string;
  mimeType: string;
  content: Uint8Array;
}

/** Structural subset of `IceboltClient` the exporter reads through. */
export interface ExportQuery {
  orderBy(column: string, direction?: 'asc' | 'desc'): ExportQuery;
  select(): Record<string, unknown>[];
}

export interface ExportableClient {
  tableUnsafe(name: string): ExportQuery;
}

const BIGQUERY_TYPE: Record<ValueKind, string> = {
  integer: 'INTEGER',
  real: 'FLOAT',
  text: 'STRING',
  enum: 'STRING',
  boolean: 'BOOLEAN',
  // Stored as ISO-8601 text; STRING never fails to load. Use SAFE_CAST / PARSE_TIMESTAMP in queries.
  date: 'STRING',
  datetime: 'STRING',
  json: 'JSON',
  blob: 'BYTES',
};

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) return toBase64(value); // BigQuery expects base64 for BYTES
  if (typeof value === 'bigint') return value.toString();
  return value;
}

const encoder = new TextEncoder();

export function buildNdjsonExports(client: ExportableClient, meta: SchemaMeta, appLabel: string): ExportFile[] {
  const files: ExportFile[] = [];
  const tableNames = Object.keys(meta).sort();

  for (const table of tableNames) {
    const tableMeta = meta[table]!;
    let query = client.tableUnsafe(table);
    for (const col of tableMeta.primaryKey) query = query.orderBy(col);
    const lines = query.select().map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = jsonSafe(v);
      return JSON.stringify(out);
    });
    files.push({
      key: `table:${table}`,
      name: `${table}.ndjson`,
      mimeType: 'application/x-ndjson',
      content: encoder.encode(lines.length ? `${lines.join('\n')}\n` : ''),
    });

    const schema = Object.entries(tableMeta.columns).map(([name, c]) => ({
      name,
      type: BIGQUERY_TYPE[c.kind],
      mode: c.nullable ? 'NULLABLE' : 'REQUIRED',
      ...(c.kind === 'date' || c.kind === 'datetime' ? { description: 'ISO-8601 text' } : {}),
      ...(c.enumValues ? { description: `one of: ${c.enumValues.join(', ')}` } : {}),
    }));
    files.push({
      key: `schema:${table}`,
      name: `${table}.bigquery-schema.json`,
      mimeType: 'application/json',
      content: encoder.encode(`${JSON.stringify(schema, null, 2)}\n`),
    });
  }

  const about = [
    `Readable copies of your ${appLabel} data.`,
    '',
    'These files are regenerated each time the app syncs; edits made here are overwritten.',
    'The app itself reads only its main database file, so deleting this folder loses nothing.',
    'To stop producing them, turn off "Readable copies" in the app settings; the app then moves them to your Drive trash.',
    '',
    'Query with BigQuery (in your own Google Cloud project):',
    '  gcloud auth login --enable-gdrive-access',
    '  bq mkdef --source_format=NEWLINE_DELIMITED_JSON "https://drive.google.com/open?id=<FILE_ID>" <table>.bigquery-schema.json > def.json',
    '  bq mk --external_table_definition=def.json <dataset>.<table>',
    '',
    'Each <table>.ndjson file has one JSON object per line. Binary columns are base64.',
    '',
  ].join('\n');
  files.push({ key: 'about', name: 'README.txt', mimeType: 'text/plain', content: encoder.encode(about) });
  return files;
}
