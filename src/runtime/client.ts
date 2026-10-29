import type { ValueKind } from '../types.js';
import type { SqlRow, SqlValue, SqliteDriver } from './driver.js';
import { IceboltQueryError, IceboltValidationError } from './errors.js';

// -------------------------------------------------------------------- meta

export interface ColumnMeta {
  readonly kind: ValueKind;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly generated: boolean;
  readonly enumValues?: readonly string[];
}

export interface TableMeta {
  readonly primaryKey: readonly string[];
  readonly columns: { readonly [column: string]: ColumnMeta };
}

export type SchemaMeta = { readonly [table: string]: TableMeta };

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Each generated table maps to `{ row, insert }` types. */
export type DatabaseShape<DB> = { [K in keyof DB]: { row: object; insert: object } };

// ------------------------------------------------------------------- where

export interface Comparison<T> {
  eq?: T | null;
  ne?: T | null;
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
  in?: readonly T[];
  notIn?: readonly T[];
  like?: string;
  isNull?: boolean;
}

/** Equality by value (`null` → IS NULL) or an operator object. Multiple keys are ANDed. */
export type Where<Row> = { [K in keyof Row]?: Row[K] | Comparison<NonNullable<Row[K]>> };

const COMPARISON_KEYS: ReadonlySet<string> = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'like', 'isNull']);

// ------------------------------------------------------------------ events

export type MutationKind = 'insert' | 'update' | 'delete';

export interface ChangeEvent {
  table: string;
  kind: MutationKind;
  changes: number;
  /** Client revision after this change was committed. */
  revision: number;
}

export type ChangeListener = (event: ChangeEvent) => void;

// --------------------------------------------------------------- utilities

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function encodeValue(table: string, column: string, meta: ColumnMeta, value: unknown): SqlValue {
  const where = `${table}.${column}`;
  if (value === undefined || value === null) {
    if (!meta.nullable && !meta.hasDefault && !meta.generated) throw new IceboltValidationError(`${where} cannot be null`);
    return null;
  }
  switch (meta.kind) {
    case 'boolean':
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value === 0 || value === 1) return value;
      break;
    case 'integer':
      if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
      if (typeof value === 'bigint') return value;
      break;
    case 'real':
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      break;
    case 'enum':
      if (typeof value === 'string') {
        if (meta.enumValues && !meta.enumValues.includes(value)) {
          throw new IceboltValidationError(`${where}: '${value}' is not one of ${meta.enumValues.join(', ')}`);
        }
        return value;
      }
      break;
    case 'text':
      if (typeof value === 'string') return value;
      break;
    case 'date':
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) throw new IceboltValidationError(`${where}: invalid Date`);
        return value.toISOString().slice(0, 10);
      }
      if (typeof value === 'string') return value;
      break;
    case 'datetime':
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) throw new IceboltValidationError(`${where}: invalid Date`);
        return value.toISOString();
      }
      if (typeof value === 'string') return value;
      break;
    case 'json':
      return JSON.stringify(value);
    case 'blob':
      if (value instanceof Uint8Array) return value;
      break;
  }
  throw new IceboltValidationError(`${where}: ${typeof value} is not valid for a ${meta.kind} column`);
}

function decodeValue(meta: ColumnMeta | undefined, value: SqlValue): unknown {
  if (value === null || meta === undefined) return value;
  switch (meta.kind) {
    case 'boolean':
      return value !== 0 && value !== 0n;
    case 'json':
      return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    case 'integer':
      if (typeof value === 'bigint') {
        if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw new RangeError(`integer ${value} exceeds Number.MAX_SAFE_INTEGER`);
        }
        return Number(value);
      }
      return value;
    default:
      return value;
  }
}

// ------------------------------------------------------------ query builder

interface QueryState {
  readonly conditions: readonly Record<string, unknown>[];
  readonly order: readonly { column: string; dir: 'ASC' | 'DESC' }[];
  readonly limit: number | null;
  readonly offset: number | null;
}

const EMPTY_STATE: QueryState = { conditions: [], order: [], limit: null, offset: null };

/** Immutable fluent query over one table. Every builder method returns a new instance. */
export class TableQuery<Row extends object, Insert extends object> {
  /** @internal */
  constructor(
    private readonly client: IceboltClient<never>,
    readonly tableName: string,
    private readonly meta: TableMeta,
    private readonly state: QueryState = EMPTY_STATE,
  ) {}

  private with(patch: Partial<QueryState>): TableQuery<Row, Insert> {
    return new TableQuery<Row, Insert>(this.client, this.tableName, this.meta, { ...this.state, ...patch });
  }

  private column(name: string): ColumnMeta {
    const m = this.meta.columns[name];
    if (!m || !Object.prototype.hasOwnProperty.call(this.meta.columns, name)) {
      throw new IceboltQueryError(`unknown column '${name}' on table '${this.tableName}'`);
    }
    return m;
  }

  // ----- builders

  where(condition: Where<Row>): TableQuery<Row, Insert> {
    for (const key of Object.keys(condition)) this.column(key);
    return this.with({ conditions: [...this.state.conditions, { ...(condition as Record<string, unknown>) }] });
  }

  orderBy(column: keyof Row & string, direction: 'asc' | 'desc' = 'asc'): TableQuery<Row, Insert> {
    this.column(column);
    return this.with({ order: [...this.state.order, { column, dir: direction === 'desc' ? 'DESC' : 'ASC' }] });
  }

  limit(n: number): TableQuery<Row, Insert> {
    if (!Number.isSafeInteger(n) || n < 0) throw new IceboltQueryError('limit must be a non-negative integer');
    return this.with({ limit: n });
  }

  offset(n: number): TableQuery<Row, Insert> {
    if (!Number.isSafeInteger(n) || n < 0) throw new IceboltQueryError('offset must be a non-negative integer');
    return this.with({ offset: n });
  }

  // ----- reads

  select(): Row[] {
    const params: SqlValue[] = [];
    let sql = `SELECT * FROM ${quoteIdent(this.tableName)}${this.whereSql(params)}`;
    if (this.state.order.length) sql += ` ORDER BY ${this.state.order.map((o) => `${quoteIdent(o.column)} ${o.dir}`).join(', ')}`;
    if (this.state.limit !== null || this.state.offset !== null) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(this.state.limit ?? -1, this.state.offset ?? 0);
    }
    return this.client.driverInternal().all(sql, params).map((r) => this.decodeRow(r));
  }

  first(): Row | undefined {
    return this.limit(1).select()[0];
  }

  count(): number {
    const params: SqlValue[] = [];
    const rows = this.client.driverInternal().all(`SELECT COUNT(*) AS "n" FROM ${quoteIdent(this.tableName)}${this.whereSql(params)}`, params);
    return Number(rows[0]?.['n'] ?? 0);
  }

  // ----- writes

  insert(row: Insert): Row {
    const record = row as Record<string, unknown>;
    if (!isPlainObject(record)) throw new IceboltValidationError('insert() expects a plain object');
    const cols: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      cols.push(key);
      params.push(encodeValue(this.tableName, key, this.column(key), value));
    }
    for (const [name, m] of Object.entries(this.meta.columns)) {
      if (!m.nullable && !m.hasDefault && !m.generated && !cols.includes(name)) {
        throw new IceboltValidationError(`${this.tableName}.${name} is required`);
      }
    }
    const sql = cols.length
      ? `INSERT INTO ${quoteIdent(this.tableName)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`
      : `INSERT INTO ${quoteIdent(this.tableName)} DEFAULT VALUES RETURNING *`;
    const rows = this.client.driverInternal().all(sql, params);
    this.client.recordChange(this.tableName, 'insert', rows.length);
    return this.decodeRow(rows[0]!);
  }

  insertMany(rows: readonly Insert[]): Row[] {
    return this.client.transaction(() => rows.map((r) => this.insert(r)));
  }

  /** Update matching rows and return them. Refuses to touch every row unless `{ allRows: true }`. */
  update(patch: Partial<Insert>, options: { allRows?: boolean } = {}): Row[] {
    this.assertScoped('update', options.allRows);
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === undefined) continue;
      const m = this.column(key);
      if (value === null && !m.nullable) throw new IceboltValidationError(`${this.tableName}.${key} cannot be null`);
      sets.push(`${quoteIdent(key)} = ?`);
      params.push(encodeValue(this.tableName, key, m, value));
    }
    if (sets.length === 0) return [];
    const sql = `UPDATE ${quoteIdent(this.tableName)} SET ${sets.join(', ')}${this.whereSql(params)} RETURNING *`;
    const rows = this.client.driverInternal().all(sql, params);
    this.client.recordChange(this.tableName, 'update', rows.length);
    return rows.map((r) => this.decodeRow(r));
  }

  /** Delete matching rows and return the count. Refuses to delete every row unless `{ allRows: true }`. */
  delete(options: { allRows?: boolean } = {}): number {
    this.assertScoped('delete', options.allRows);
    const params: SqlValue[] = [];
    const { changes } = this.client.driverInternal().run(`DELETE FROM ${quoteIdent(this.tableName)}${this.whereSql(params)}`, params);
    this.client.recordChange(this.tableName, 'delete', changes);
    return changes;
  }

  // ----- internals

  private assertScoped(op: string, allRows: boolean | undefined): void {
    if (this.state.order.length || this.state.limit !== null || this.state.offset !== null) {
      throw new IceboltQueryError(`${op}() does not support orderBy/limit/offset`);
    }
    const hasConditions = this.state.conditions.some((c) => Object.keys(c).length > 0);
    if (!hasConditions && !allRows) {
      throw new IceboltQueryError(`${op}() without where() would affect every row of '${this.tableName}'; pass { allRows: true } to confirm`);
    }
  }

  private whereSql(params: SqlValue[]): string {
    const clauses: string[] = [];
    for (const cond of this.state.conditions) {
      for (const [col, raw] of Object.entries(cond)) {
        if (raw === undefined) continue;
        const m = this.column(col);
        const q = quoteIdent(col);
        const enc = (v: unknown): SqlValue => encodeValue(this.tableName, col, { ...m, nullable: true }, v);

        if (raw === null) {
          clauses.push(`${q} IS NULL`);
          continue;
        }
        const isOp = m.kind !== 'json' && isPlainObject(raw) && Object.keys(raw).length > 0 && Object.keys(raw).every((k) => COMPARISON_KEYS.has(k));
        if (!isOp) {
          clauses.push(`${q} = ?`);
          params.push(enc(raw));
          continue;
        }
        const op = raw as Comparison<unknown>;
        if (op.eq !== undefined) {
          if (op.eq === null) clauses.push(`${q} IS NULL`);
          else {
            clauses.push(`${q} = ?`);
            params.push(enc(op.eq));
          }
        }
        if (op.ne !== undefined) {
          if (op.ne === null) clauses.push(`${q} IS NOT NULL`);
          else {
            clauses.push(`${q} IS NOT ?`);
            params.push(enc(op.ne));
          }
        }
        for (const [key, sqlOp] of [
          ['gt', '>'],
          ['gte', '>='],
          ['lt', '<'],
          ['lte', '<='],
        ] as const) {
          if (op[key] !== undefined) {
            clauses.push(`${q} ${sqlOp} ?`);
            params.push(enc(op[key]));
          }
        }
        for (const [key, sqlOp] of [
          ['in', 'IN'],
          ['notIn', 'NOT IN'],
        ] as const) {
          const list = op[key];
          if (list === undefined) continue;
          if (!Array.isArray(list)) throw new IceboltQueryError(`${col}.${key} must be an array`);
          if (list.length === 0) {
            clauses.push(key === 'in' ? '0' : '1');
            continue;
          }
          clauses.push(`${q} ${sqlOp} (${list.map(() => '?').join(', ')})`);
          for (const v of list) params.push(enc(v));
        }
        if (op.like !== undefined) {
          if (typeof op.like !== 'string') throw new IceboltQueryError(`${col}.like must be a string`);
          clauses.push(`${q} LIKE ? ESCAPE '\\'`);
          params.push(op.like);
        }
        if (op.isNull !== undefined) clauses.push(op.isNull ? `${q} IS NULL` : `${q} IS NOT NULL`);
      }
    }
    return clauses.length ? ` WHERE ${clauses.map((c) => `(${c})`).join(' AND ')}` : '';
  }

  private decodeRow(row: SqlRow): Row {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = decodeValue(this.meta.columns[k], v);
    return out as Row;
  }
}

// ------------------------------------------------------------------- client

/**
 * Typed façade over a synchronous in-memory SQLite connection.
 *
 * `isDirty` flips to `true` on every committed mutation that changed at least
 * one row; `revision` increments with it so a sync layer can mark the exact
 * snapshot it uploaded as clean without racing later writes.
 */
export class IceboltClient<DB extends DatabaseShape<DB>> {
  #dirty = false;
  #revision = 0;
  #txDepth = 0;
  #pending: Omit<ChangeEvent, 'revision'>[] = [];
  readonly #listeners = new Set<ChangeListener>();
  readonly #driver: SqliteDriver;
  readonly #meta: SchemaMeta;

  constructor(driver: SqliteDriver, meta: SchemaMeta) {
    this.#driver = driver;
    this.#meta = meta;
  }

  get isDirty(): boolean {
    return this.#dirty;
  }

  /** Monotonic counter of committed mutations. */
  get revision(): number {
    return this.#revision;
  }

  get inTransaction(): boolean {
    return this.#txDepth > 0;
  }

  /** Clear the dirty flag. When `upToRevision` is given, only clears if no newer writes landed since. */
  markClean(upToRevision?: number): void {
    if (upToRevision === undefined || upToRevision >= this.#revision) this.#dirty = false;
  }

  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  table<K extends keyof DB & string>(name: K): TableQuery<DB[K]['row'], DB[K]['insert']> {
    return this.tableUnsafe(name) as unknown as TableQuery<DB[K]['row'], DB[K]['insert']>;
  }

  /** Name-validated but untyped table access, for manifest-driven code paths. */
  tableUnsafe(name: string): TableQuery<Record<string, unknown>, Record<string, unknown>> {
    const meta = Object.prototype.hasOwnProperty.call(this.#meta, name) ? this.#meta[name] : undefined;
    if (!meta) throw new IceboltQueryError(`unknown table '${name}'`);
    return new TableQuery(this as unknown as IceboltClient<never>, name, meta);
  }

  /** Synchronous transaction; nests via SAVEPOINTs. Change events fire only after the outermost commit. */
  transaction<T>(fn: () => T): T {
    const depth = this.#txDepth;
    const savepoint = `icebolt_sp_${depth}`;
    const pendingMark = this.#pending.length;
    this.#driver.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
    this.#txDepth++;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) {
        throw new IceboltQueryError('transaction() callbacks must be synchronous');
      }
    } catch (err) {
      this.#txDepth--;
      this.#driver.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      this.#pending.length = pendingMark;
      throw err;
    }
    this.#txDepth--;
    this.#driver.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    if (depth === 0) this.#flushChanges();
    return result;
  }

  /** Serialize the database file (for sync). Not allowed mid-transaction. */
  export(): Uint8Array {
    if (this.#txDepth > 0) throw new IceboltQueryError('cannot export during a transaction');
    return this.#driver.export();
  }

  /** Mark the database changed without a row edit (e.g. after a schema upgrade) so it syncs. */
  markDirty(): void {
    this.recordChange('__icebolt_meta', 'update', 1);
  }

  /** Read an app-level setting stored (and synced) inside the database. */
  getMeta(key: string): string | null {
    const rows = this.#driver.all(`SELECT "value" FROM "__icebolt_meta" WHERE "key" = ?`, [`user:${key}`]);
    const v = rows[0]?.['value'];
    return typeof v === 'string' ? v : null;
  }

  /** Write an app-level setting. Counts as a mutation (marks dirty, schedules sync). */
  setMeta(key: string, value: string): void {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) throw new IceboltQueryError(`invalid meta key '${key}'`);
    if (this.getMeta(key) === value) return;
    const { changes } = this.#driver.run(`INSERT OR REPLACE INTO "__icebolt_meta" ("key", "value") VALUES (?, ?)`, [`user:${key}`, value]);
    this.recordChange('__icebolt_meta', 'update', changes);
  }

  /** Raw parameterized read for queries the fluent API does not cover. Never marks dirty. */
  rawQuery(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    return this.#driver.all(sql, params);
  }

  /** @internal */
  driverInternal(): SqliteDriver {
    return this.#driver;
  }

  /** @internal */
  recordChange(table: string, kind: MutationKind, changes: number): void {
    if (changes <= 0) return;
    this.#pending.push({ table, kind, changes });
    if (this.#txDepth === 0) this.#flushChanges();
  }

  #flushChanges(): void {
    if (this.#pending.length === 0) return;
    const batch = this.#pending.splice(0);
    this.#dirty = true;
    for (const change of batch) {
      this.#revision++;
      const event: ChangeEvent = { ...change, revision: this.#revision };
      for (const l of this.#listeners) {
        try {
          l(event);
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    }
  }
}
