export {
  IceboltClient,
  TableQuery,
  type ChangeEvent,
  type ChangeListener,
  type ColumnMeta,
  type Comparison,
  type DatabaseShape,
  type JsonValue,
  type MutationKind,
  type SchemaMeta,
  type TableMeta,
  type Where,
} from './client.js';
export {
  createOo1Driver,
  createSqlJsDriver,
  type Oo1DatabaseLike,
  type SqlJsDatabaseLike,
  type SqlJsStatementLike,
  type SqlRow,
  type SqlValue,
  type SqliteDriver,
} from './driver.js';
export { applyMigration, ensureSchema, type BootstrapOutcome, type MigrationBundle, type SchemaOpenResult } from './bootstrap.js';
export { executeAction, type ActionResult } from './actions.js';
export { IceboltQueryError, IceboltSchemaMismatchError, IceboltSchemaTooNewError, IceboltValidationError } from './errors.js';
export {
  IceboltMigrationError,
  describeMigration,
  planMigration,
  type MigrationPlan,
  type MigrationStep,
  type SchemaHistoryEntry,
  type SchemaLock,
  type SchemaSnapshot,
} from '../schema/migrate.js';
