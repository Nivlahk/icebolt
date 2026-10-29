/**
 * nivlahkicebolt
 *
 *   DBML ──compileSchema──▶ { sqlMigration, uiManifest, schema }
 *                │
 *                ├─ generateClientSource ──▶ typed client module (runtime: ./runtime)
 *                ├─ ui/render ──▶ <form> + action <button>s
 *                └─ sync ──▶ AES-GCM envelope ⇄ user's Google Drive (drive.file)
 */
export { compileSchema, type CompileOptions, type CompileResult } from './schema/compileSchema.js';
export { generateClientSource, type GenerateClientInput, type GenerateClientOptions } from './client/generateClient.js';
export { parseDbml, DbmlSyntaxError } from './dbml/parser.js';
export type * from './dbml/ast.js';
export * from './types.js';
export * from './ui/index.js';
export * from './runtime/index.js';
export * from './sync/index.js';
export * from './auth/index.js';
export * from './app/index.js';
