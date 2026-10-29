/**
 * Minimal synchronous SQLite driver contract. Both sql.js and the official
 * @sqlite.org/sqlite-wasm "oo1" API run synchronously on the calling thread,
 * so the client can expose a synchronous fluent API.
 */
export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqliteDriver {
  /** Execute one or more statements without parameters (DDL, PRAGMA, transaction control). */
  exec(sql: string): void;
  /** Execute a single parameterized statement that returns no rows. */
  run(sql: string, params: readonly SqlValue[]): { changes: number };
  /** Execute a single parameterized statement and return every row as an object. */
  all(sql: string, params: readonly SqlValue[]): SqlRow[];
  /** Serialize the full database file. */
  export(): Uint8Array;
}

// ------------------------------------------------------------------- sql.js

type SqlJsBindValue = string | number | Uint8Array | null;

/** Structural subset of sql.js `Statement` (no dependency on its typings). */
export interface SqlJsStatementLike {
  bind(values?: SqlJsBindValue[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, SqlJsBindValue>;
  free(): boolean;
}

/** Structural subset of sql.js `Database`. */
export interface SqlJsDatabaseLike {
  exec(sql: string): unknown;
  run(sql: string, params?: SqlJsBindValue[]): unknown;
  prepare(sql: string): SqlJsStatementLike;
  getRowsModified(): number;
  export(): Uint8Array;
}

function toSqlJs(v: SqlValue): SqlJsBindValue {
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`bigint ${v} exceeds the safe integer range supported by sql.js bindings`);
    }
    return Number(v);
  }
  return v;
}

/**
 * Adapter for sql.js (`new SQL.Database(bytes?)`).
 *
 * sql.js' `export()` closes and reopens the connection, which silently resets
 * `PRAGMA foreign_keys`; the adapter re-enables it after every export.
 */
export function createSqlJsDriver(db: SqlJsDatabaseLike): SqliteDriver {
  db.exec('PRAGMA foreign_keys = ON;');
  return {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params) {
      db.run(sql, params.map(toSqlJs));
      return { changes: db.getRowsModified() };
    },
    all(sql, params) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params.map(toSqlJs));
        const rows: SqlRow[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },
    export() {
      const bytes = db.export();
      db.exec('PRAGMA foreign_keys = ON;');
      return bytes;
    },
  };
}

// ------------------------------------------------------- @sqlite.org/sqlite-wasm

/** Structural subset of sqlite-wasm's `oo1.DB`. */
export interface Oo1DatabaseLike {
  exec(options: { sql: string; bind?: readonly SqlValue[]; rowMode?: 'object'; returnValue?: 'resultRows' }): unknown;
  changes(): number;
}

/**
 * Adapter for the official SQLite Wasm build.
 *
 * @param exportBytes e.g. `() => sqlite3.capi.sqlite3_js_db_export(db)`
 */
export function createOo1Driver(db: Oo1DatabaseLike, exportBytes: () => Uint8Array): SqliteDriver {
  db.exec({ sql: 'PRAGMA foreign_keys = ON;' });
  return {
    exec(sql) {
      db.exec({ sql });
    },
    run(sql, params) {
      db.exec({ sql, bind: [...params] });
      return { changes: db.changes() };
    },
    all(sql, params) {
      return db.exec({ sql, bind: [...params], rowMode: 'object', returnValue: 'resultRows' }) as SqlRow[];
    },
    export: exportBytes,
  };
}
