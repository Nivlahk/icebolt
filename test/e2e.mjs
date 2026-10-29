// End-to-end verification for nivlahkicebolt (runs against dist/).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import {
  compileSchema,
  generateClientSource,
  IceboltCompileError,
  IceboltClient,
  createSqlJsDriver,
  ensureSchema,
  executeAction,
  IceboltValidationError,
  IceboltQueryError,
  IceboltSchemaMismatchError,
  GoogleDriveSyncManager,
  IceboltSyncError,
  bindAutoSync,
  KeyCache,
  sealEnvelope,
  openEnvelope,
  freshKdfParams,
  IceboltDecryptionError,
  renderForm,
  renderActionButtons,
  renderStorageSettings,
  readStorageSettings,
  writeStorageSettings,
  describeStorageSettings,
  buildPushPayload,
  DATA_CUSTODY_STATEMENT,
  GoogleDriveAuth,
  IceboltAuthError,
  linkAuthToSync,
  renderDriveConnectButton,
  DRIVE_FILE_SCOPE,
} from '../dist/index.js';

const isSqliteBytes = (b) => Buffer.from(b.slice(0, 16)).toString('latin1') === 'SQLite format 3\0';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = await initSqlJs();
let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────── 1. compiler
console.log('Schema compiler');
const dbml = readFileSync(join(here, 'fixture.dbml'), 'utf8');
const result = compileSchema(dbml);
writeFileSync(join(here, 'out.migration.sql'), result.sqlMigration);
writeFileSync(join(here, 'out.manifest.json'), JSON.stringify(result.uiManifest, null, 2));

await test('emits tables in FK dependency order incl. junction', () => {
  const order = result.schema.tables.map((t) => t.name);
  assert.ok(order.indexOf('users') < order.indexOf('projects'));
  assert.ok(order.indexOf('projects') < order.indexOf('tasks'));
  assert.ok(order.includes('tasks_tags'));
  assert.ok(order.indexOf('tags') < order.indexOf('tasks_tags'));
});

await test('warnings only, no errors', () => {
  assert.ok(result.diagnostics.every((d) => d.severity === 'warning'), JSON.stringify(result.diagnostics));
});

await test('migration runs on a blank sql.js database and is idempotent', () => {
  const db = new SQL.Database();
  db.exec(result.sqlMigration);
  db.exec(result.sqlMigration);
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat();
  assert.deepEqual(tables, ['__icebolt_meta', 'project_settings', 'projects', 'sqlite_sequence', 'tags', 'tasks', 'tasks_tags', 'users']);
  const idx = db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")[0].values.flat();
  assert.ok(idx.includes('ix_tasks_project_status'));
  assert.ok(idx.includes('ix_projects_owner_id_fk'));
  assert.ok(idx.includes('ix_tasks_tags_tags_id_fk'));
  const strict = db.exec("SELECT strict FROM pragma_table_list WHERE name='tasks'")[0].values[0][0];
  assert.equal(strict, 1);
});

await test('rejects malformed DBML with line numbers', () => {
  assert.throws(() => compileSchema('Table a {\n  id int [pk\n}'), (e) => e instanceof IceboltCompileError && /line/.test(e.message));
  assert.throws(() => compileSchema('Table a { id int [pk]\n b int [ref: > nope.id] }'), /unknown table 'nope'/);
  assert.throws(() => compileSchema('Table a { id int [pk]\n x int }\nTable b { a_x int [ref: > a.x] }'), /must be a primary key or unique/);
  assert.throws(() => compileSchema("Enum s { a\n b }\nTable a { id int [pk]\n s s [default: 'zzz'] }"), /not a value of the enum/);
});

await test('rejects bad @ui directives', () => {
  assert.throws(() => compileSchema("Table a { id int [pk]\n n text [note: '@ui:form-input { label: Task }'] }"), /strings must be quoted/);
  assert.throws(() => compileSchema("Table a { id int [pk]\n n text [note: '@ui:action-button { action: \"toggleRow\" }'] }"), /toggleRow needs a boolean or enum/);
  assert.throws(() => compileSchema("Table a { n text [note: '@ui:action-button { action: \"deleteRow\" }'] }"), /primary key/);
  assert.throws(() => compileSchema("Table a { id int [pk]\n b bool [note: '@ui:action-button { action: \"explode\" }'] }"), /unknown action/);
  assert.throws(() => compileSchema("Table a { id int [pk]\n n text [note: '@ui:form-input { __proto__: 1 }'] }"), /forbidden key/);
});

// ─────────────────────────────────────────────────────────── 2. UI manifest
console.log('UI manifest');
const tasksUi = result.uiManifest.tables.tasks;
await test('form-input fields mapped to DOM controls', () => {
  const byCol = Object.fromEntries(tasksUi.form.fields.map((f) => [f.column, f]));
  assert.equal(byCol.title.label, 'Task');
  assert.equal(byCol.title.placeholder, 'What needs doing?');
  assert.equal(byCol.title.inputType, 'text');
  assert.equal(byCol.title.attributes.maxlength, '140');
  assert.equal(byCol.title.required, true);
  assert.equal(byCol.status.element, 'select');
  assert.deepEqual(byCol.status.options.map((o) => o.label), ['To do', 'In progress', 'Done']);
  assert.equal(byCol.status.required, false, 'has default');
  assert.equal(byCol.priority.inputType, 'number');
  assert.deepEqual(byCol.priority.attributes, { min: '0', max: '5', step: '1' });
  assert.equal(result.uiManifest.tables.projects.form.fields[1].element, 'textarea');
  assert.equal(result.uiManifest.tables.users.form.fields[0].inputType, 'email');
});

await test('action-button bindings normalized to behaviors', () => {
  const a = Object.fromEntries(tasksUi.actions.map((x) => [x.label, x]));
  assert.deepEqual(a.Advance.behavior, { type: 'cycle', values: ['todo', 'doing', 'done'] });
  assert.deepEqual(a['Toggle done'].behavior, { type: 'toggle-boolean' });
  assert.deepEqual(a.Bump.behavior, { type: 'increment', by: 1 });
  assert.equal(a.Delete.behavior.type, 'delete');
  assert.equal(a.Delete.confirm, 'Delete task?');
  assert.equal(a.Delete.variant, 'danger');
  assert.equal(result.uiManifest.tables.projects.actions[0].target, 'archived');
  assert.equal(result.uiManifest.tables.tasks_tags, undefined);
});

// ───────────────────────────────────────────────────────── 3. typed client
console.log('Typed client');
const genDir = join(here, 'generated');
mkdirSync(genDir, { recursive: true });
writeFileSync(join(genDir, 'icebolt-client.ts'), generateClientSource(result));

const meta = Object.fromEntries(
  result.schema.tables.map((t) => [
    t.name,
    {
      primaryKey: t.primaryKey,
      columns: Object.fromEntries(t.columns.map((c) => [c.name, { kind: c.kind, nullable: c.nullable, hasDefault: c.hasDefault, generated: c.generated, ...(c.enumValues ? { enumValues: c.enumValues } : {}) }])),
    },
  ]),
);

const driver = createSqlJsDriver(new SQL.Database());
assert.equal(ensureSchema(driver, { migrationSql: result.sqlMigration, schemaHash: result.schemaHash }).status, 'created');
const client = new IceboltClient(driver, meta);
let user, project, task;

await test('insert returns decoded row and flips isDirty', () => {
  assert.equal(client.isDirty, false);
  user = client.table('users').insert({ email: 'niv@example.com' });
  assert.equal(client.isDirty, true);
  assert.equal(client.revision, 1);
  assert.equal(user.id, 1);
  assert.match(user.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  project = client.table('projects').insert({ owner_id: user.id, name: 'Bronze Age Mod' });
  assert.match(project.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(project.archived, false);
  assert.deepEqual(project.settings, {});
});

await test('fluent where / orderBy / limit / count', () => {
  const t = client.table('tasks');
  t.insertMany([
    { project_id: project.id, title: 'Spearmen', priority: 2 },
    { project_id: project.id, title: 'Chariots', priority: 4, status: 'doing' },
    { project_id: project.id, title: 'Bronze casting', priority: 1, due_on: new Date('2026-11-01T00:00:00Z') },
  ]);
  assert.equal(t.count(), 3);
  assert.deepEqual(t.where({ priority: { gte: 2 } }).orderBy('priority', 'desc').select().map((r) => r.title), ['Chariots', 'Spearmen']);
  assert.equal(t.where({ status: { in: ['todo'] } }).count(), 2);
  assert.equal(t.where({ due_on: null }).count(), 2);
  assert.equal(t.where({ title: { like: 'Bronze%' } }).first().due_on, '2026-11-01');
  assert.equal(t.orderBy('id').limit(1).offset(1).first().title, 'Chariots');
  task = t.where({ title: 'Spearmen' }).first();
  assert.equal(task.done, false);
});

await test('validation, constraints and safety rails', () => {
  assert.throws(() => client.table('tasks').insert({ project_id: project.id }), IceboltValidationError);
  assert.throws(() => client.table('tasks').insert({ project_id: project.id, title: 'x', status: 'nope' }), /not one of/);
  assert.throws(() => client.table('tasks').insert({ project_id: project.id, title: 'x', priority: 9 }), /CHECK constraint/);
  assert.throws(() => client.table('tasks').insert({ project_id: 'missing', title: 'x' }), /FOREIGN KEY/);
  assert.throws(() => client.table('tasks').insert({ project_id: project.id, title: 'x'.repeat(141) }), /CHECK constraint/);
  assert.throws(() => client.table('tasks').where({ 'title; DROP TABLE tasks': 1 }), IceboltQueryError);
  assert.throws(() => client.table('tasks').update({ done: true }), /allRows/);
  assert.throws(() => client.table('tasks').delete(), /allRows/);
  assert.throws(() => client.table('nope'), /unknown table/);
});

await test('transactions roll back and only commit events fire', () => {
  const before = client.revision;
  const events = [];
  const off = client.onChange((e) => events.push(e));
  assert.throws(() =>
    client.transaction(() => {
      client.table('tags').insert({ id: 1, label: 'army' });
      client.transaction(() => client.table('tags').insert({ id: 2, label: 'economy' }));
      throw new Error('abort');
    }),
  );
  assert.equal(client.table('tags').count(), 0);
  assert.equal(client.revision, before);
  assert.equal(events.length, 0);
  client.transaction(() => client.table('tags').insert({ id: 1, label: 'army' }));
  assert.equal(events.length, 1);
  off();
  client.table('tasks_tags').insert({ tasks_id: task.id, tags_id: 1 });
});

await test('markClean(revision) does not hide newer writes', () => {
  const rev = client.revision;
  client.table('tags').insert({ id: 3, label: 'religion' });
  client.markClean(rev);
  assert.equal(client.isDirty, true);
  client.markClean(client.revision);
  assert.equal(client.isDirty, false);
});

await test('executeAction drives toggle / cycle / increment / delete by primary key', () => {
  const ui = result.uiManifest.tables.tasks;
  const act = (label, row) => executeAction(client, ui.actions.find((a) => a.label === label), row, ui.primaryKey);
  let r = act('Toggle done', task).row;
  assert.equal(r.done, true);
  r = act('Advance', r).row;
  assert.equal(r.status, 'doing');
  r = act('Advance', act('Advance', r).row).row;
  assert.equal(r.status, 'todo');
  r = act('Bump', r).row;
  assert.equal(r.priority, 3);
  assert.equal(client.isDirty, true);
  assert.equal(act('Delete', r).deleted, true);
  assert.equal(client.table('tasks_tags').count(), 0, 'junction cascades');
});

await test('cascade delete + export/reopen + schema hash verification', () => {
  const bytes = client.export();
  const reopened = createSqlJsDriver(new SQL.Database(bytes));
  assert.equal(ensureSchema(reopened, { migrationSql: result.sqlMigration, schemaHash: result.schemaHash }).status, 'opened');
  const c2 = new IceboltClient(reopened, meta);
  assert.equal(c2.table('tasks').count(), 2);
  c2.table('projects').where({ id: project.id }).delete();
  assert.equal(c2.table('tasks').count(), 0);
  assert.throws(() => ensureSchema(createSqlJsDriver(new SQL.Database(bytes)), { migrationSql: '', schemaHash: 'deadbeef' }), IceboltSchemaMismatchError);
});

// ────────────────────────────────────────────────────────────── 4. crypto
console.log('Crypto envelope');
const ITER = 100_000;
await test('AES-GCM round trip, wrong key, tamper, header binding', async () => {
  const cache = new KeyCache();
  const kdf = freshKdfParams(ITER);
  const plain = new TextEncoder().encode('SQLite format 3\0 payload');
  const sealed = await sealEnvelope(plain, 'correct horse battery staple', kdf, cache);
  assert.equal(new TextDecoder().decode(sealed.slice(0, 4)), 'ICEB');
  assert.ok(!Buffer.from(sealed).includes(Buffer.from('SQLite format')));
  const opened = await openEnvelope(sealed, 'correct horse battery staple', cache);
  assert.deepEqual(opened.plaintext, plain);
  await assert.rejects(openEnvelope(sealed, 'wrong', new KeyCache()), IceboltDecryptionError);
  const flipped = sealed.slice();
  flipped[flipped.length - 1] ^= 1;
  await assert.rejects(openEnvelope(flipped, 'correct horse battery staple', cache), IceboltDecryptionError);
  const header = sealed.slice();
  header[12] ^= 1; // salt byte → different key
  await assert.rejects(openEnvelope(header, 'correct horse battery staple', cache), IceboltDecryptionError);
  const lowIter = sealed.slice();
  new DataView(lowIter.buffer).setUint32(6, 1000);
  await assert.rejects(openEnvelope(lowIter, 'correct horse battery staple', cache), /iteration count/);
  const again = await sealEnvelope(plain, 'correct horse battery staple', kdf, cache);
  assert.notDeepEqual(again.slice(26, 38), sealed.slice(26, 38), 'fresh IV per encryption');
});

// ──────────────────────────────────────────────────────── 5. Drive sync
console.log('Google Drive sync');

/** In-memory Google Drive v3 that validates request shapes the way the real API would. */
function createMockDrive() {
  const files = new Map();
  let nextId = 1;
  let nextRev = 1;
  const log = [];
  const faults = [];
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const meta = (f) => ({
    id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, headRevisionId: f.revisions.at(-1) ?? null,
    size: String(f.content.byteLength), trashed: f.trashed, appProperties: f.appProperties, parents: f.parents,
  });
  const create = (m, content = new Uint8Array()) => {
    const f = { id: `f${nextId++}`, name: m.name, mimeType: m.mimeType, appProperties: { ...(m.appProperties ?? {}) }, parents: m.parents ?? ['root'], trashed: false, content, revisions: [] };
    if (m.mimeType !== 'application/vnd.google-apps.folder') f.revisions.push(`r${nextRev++}`);
    f.modifiedTime = new Date(Date.now() + nextRev).toISOString();
    files.set(f.id, f);
    return f;
  };
  const update = (f, m, content) => {
    assert.equal(m.parents, undefined, 'parents cannot be set in an update');
    if (m.name) f.name = m.name;
    if (m.mimeType) f.mimeType = m.mimeType;
    if (m.appProperties) Object.assign(f.appProperties, m.appProperties);
    if (m.trashed !== undefined) {
      f.trashed = m.trashed;
      if (f.mimeType === 'application/vnd.google-apps.folder') for (const c of files.values()) if (c.parents.includes(f.id)) c.trashed = m.trashed;
    }
    if (content) {
      f.content = content;
      f.revisions.push(`r${nextRev++}`);
    }
    f.modifiedTime = new Date(Date.now() + nextRev).toISOString();
  };
  const parseMultipart = (init, body) => {
    const boundary = new Headers(init.headers).get('Content-Type').match(/boundary=(.+)$/)[1];
    const parts = Buffer.from(body).toString('latin1').split(`--${boundary}`);
    assert.equal(parts.length, 4, 'two parts plus preamble/epilogue');
    assert.equal(parts[3], '--');
    const m = JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
    const start = parts[2].indexOf('\r\n\r\n') + 4;
    return { meta: m, content: new Uint8Array(Buffer.from(parts[2].slice(start, -2), 'latin1')) };
  };
  const matches = (f, q) => {
    for (const [, k, v] of q.matchAll(/appProperties has \{ key='([^']+)' and value='([^']+)' \}/g)) if (f.appProperties[k] !== v) return false;
    const parent = q.match(/'([^']+)' in parents/);
    if (parent && !f.parents.includes(parent[1])) return false;
    const mime = q.match(/mimeType = '([^']+)'/);
    if (mime && f.mimeType !== mime[1]) return false;
    return q.includes('trashed = false') ? !f.trashed : true;
  };
  const sessions = new Map();

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    log.push(`${method} ${url.pathname}${url.searchParams.get('uploadType') ? `?uploadType=${url.searchParams.get('uploadType')}` : ''}`);
    if (new Headers(init.headers).get('Authorization') !== 'Bearer tok') return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
    if (faults.length) return faults.shift()();
    const body = init.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : init.body;

    if (url.host === 'upload.session') {
      const s = sessions.get(url.pathname);
      assert.equal(body.byteLength, s.length);
      const f = s.fileId ? files.get(s.fileId) : create(s.meta, body);
      if (s.fileId) update(f, s.meta, body);
      return json(200, meta(f));
    }
    const rev = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/revisions(?:\/([^/]+))?$/);
    if (rev) {
      const f = files.get(rev[1]);
      if (method === 'GET') return json(200, { revisions: f.revisions.map((id) => ({ id })) });
      assert.equal(method, 'DELETE');
      assert.notEqual(rev[2], f.revisions.at(-1), 'must not delete head revision');
      f.revisions = f.revisions.filter((r) => r !== rev[2]);
      return new Response(null, { status: 204 });
    }
    const m = url.pathname.match(/^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?$/);
    assert.ok(m, `unexpected URL ${url}`);
    const [, upload, id] = m;
    const type = url.searchParams.get('uploadType');
    if (!upload && method === 'GET' && !id) {
      return json(200, { files: [...files.values()].filter((f) => matches(f, url.searchParams.get('q'))).reverse().map(meta) });
    }
    if (!upload && method === 'GET') {
      const f = files.get(id);
      if (!f) return json(404, { error: { code: 404, message: 'File not found' } });
      if (url.searchParams.get('alt') === 'media') return new Response(f.content, { status: 200, headers: { 'Content-Length': String(f.content.byteLength) } });
      return json(200, meta(f));
    }
    if (!upload && method === 'POST') return json(200, meta(create(JSON.parse(init.body))));
    if (!upload && method === 'PATCH') {
      const f = files.get(id);
      const add = url.searchParams.get('addParents');
      if (add) {
        const remove = (url.searchParams.get('removeParents') ?? '').split(',');
        f.parents = [...f.parents.filter((p) => !remove.includes(p)), add];
      }
      update(f, JSON.parse(init.body));
      return json(200, meta(f));
    }
    if (upload && type === 'multipart') {
      const { meta: mm, content } = parseMultipart(init, body);
      if (method === 'POST') return json(200, meta(create(mm, content)));
      const f = files.get(id);
      if (!f) return json(404, { error: { code: 404, message: 'File not found' } });
      update(f, mm, content);
      return json(200, meta(f));
    }
    if (upload && type === 'resumable') {
      const key = `/s${sessions.size}`;
      sessions.set(key, { fileId: id ?? null, meta: JSON.parse(init.body), length: Number(new Headers(init.headers).get('X-Upload-Content-Length')) });
      return new Response(null, { status: 200, headers: { Location: `https://upload.session${key}` } });
    }
    throw new Error(`unhandled ${method} ${url}`);
  }
  const live = (role) => [...files.values()].filter((f) => !f.trashed && f.appProperties.iceboltRole === role);
  return { fetch: fetchImpl, files, log, faults, json, live };
}

const KEY = 'user-held passphrase 7f3a';
const mk = (drive, extra = {}) => new GoogleDriveSyncManager({ appId: 'demo-app', fetch: drive.fetch, pbkdf2Iterations: ITER, baseBackoffMs: 5, maxBackoffMs: 40, debounceMs: 30, maxWaitMs: 120, ...extra });
const uploads = (drive) => drive.log.filter((l) => l.includes('/upload/') || l.startsWith('PUT')).length;
const freshClient = () => new IceboltClient(createSqlJsDriver(new SQL.Database(client.export())), meta);

await test('first pull → null, POST multipart, PATCH update, second device decrypts', async () => {
  const drive = createMockDrive();
  const a = mk(drive);
  const states = [];
  a.subscribe((e) => e.type === 'state' && states.push(e.state));
  assert.equal(await a.pullAndDecrypt('tok', KEY), null);
  const dbBytes = client.export();
  const f1 = await a.encryptAndPush('tok', dbBytes, KEY);
  assert.deepEqual(drive.log.slice(-3), ['GET /drive/v3/files', 'POST /drive/v3/files', 'POST /upload/drive/v3/files?uploadType=multipart'], 'app folder created, then the file inside it');
  const stored = drive.files.get(f1.id);
  assert.equal(stored.name, 'demo-app.icebolt');
  assert.equal(stored.appProperties.iceboltEncryption, 'aes-256-gcm');
  assert.ok(!Buffer.from(stored.content).includes(Buffer.from('SQLite format 3')), 'Drive only sees ciphertext');
  const f2 = await a.encryptAndPush('tok', dbBytes, KEY);
  assert.equal(f2.id, f1.id);
  assert.deepEqual(drive.log.slice(-2), [`GET /drive/v3/files/${f1.id}`, `PATCH /upload/drive/v3/files/${f1.id}?uploadType=multipart`]);
  assert.deepEqual(states.slice(0, 4), ['pulling', 'idle', 'pushing', 'idle']);

  const b = mk(drive);
  const pulled = await b.pull('tok', KEY);
  assert.equal(pulled.encrypted, true);
  assert.deepEqual(pulled.bytes, dbBytes);
  await assert.rejects(mk(drive).pull('tok', 'wrong key'), (e) => e instanceof IceboltSyncError && e.code === 'crypto');
  await assert.rejects(mk(drive).pull('tok', null), /passphrase is required/);
});

await test('conflict detection: stale device cannot clobber newer remote', async () => {
  const drive = createMockDrive();
  const a = mk(drive);
  const b = mk(drive);
  await a.pull('tok', KEY);
  await a.encryptAndPush('tok', new Uint8Array([1, 2, 3]), KEY);
  await b.pull('tok', KEY);
  await a.encryptAndPush('tok', new Uint8Array([4, 5, 6]), KEY);
  await assert.rejects(b.encryptAndPush('tok', new Uint8Array([7]), KEY), (e) => e.code === 'conflict');
  await assert.rejects(mk(drive).encryptAndPush('tok', new Uint8Array([7]), KEY), (e) => e.code === 'conflict', 'never-pulled session');
  await mk(drive, { conflictPolicy: 'overwrite' }).encryptAndPush('tok', new Uint8Array([8]), KEY);
  assert.deepEqual(await mk(drive).pullAndDecrypt('tok', KEY), new Uint8Array([8]));
});

await test('403 userRateLimitExceeded / 429 / 503 retried with backoff; 401 not retried', async () => {
  const drive = createMockDrive();
  const a = mk(drive);
  const retries = [];
  a.subscribe((e) => e.type === 'retry' && retries.push(e));
  await a.pull('tok', KEY);
  drive.faults.push(
    () => drive.json(403, { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } }),
    () => drive.json(429, { error: { code: 429, message: 'Too Many Requests' } }, { 'Retry-After': '0' }),
    () => drive.json(503, { error: { code: 503, message: 'Backend Error' } }),
  );
  await a.encryptAndPush('tok', new Uint8Array([1]), KEY);
  assert.equal(retries.length, 3);
  assert.equal(retries[0].error.code, 'rate-limit');
  assert.equal(retries[1].delayMs, 0, 'Retry-After honored');
  drive.faults.push(() => drive.json(403, { error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } }));
  await assert.rejects(a.encryptAndPush('tok', new Uint8Array([2]), KEY), (e) => e.code === 'forbidden' && !e.retryable);
  await assert.rejects(a.encryptAndPush('expired', new Uint8Array([2]), KEY), (e) => e.code === 'auth');
  assert.equal(retries.length, 3);
});

await test('debounce collapses a burst of writes into one upload; isDirty cleared', async () => {
  const drive = createMockDrive();
  const a = mk(drive);
  await a.pull('tok', KEY);
  const c = freshClient();
  const unbind = bindAutoSync(c, a, { getAccessToken: () => 'tok', getEncryptionKey: () => KEY, schemaMeta: meta });
  for (let i = 10; i < 30; i++) c.table('tags').insert({ id: i, label: `tag${i}` });
  assert.equal(c.isDirty, true);
  assert.equal(a.state, 'scheduled');
  const before = uploads(drive);
  await new Promise((r) => setTimeout(r, 60));
  await a.flush();
  assert.equal(uploads(drive) - before, 1);
  assert.equal(c.isDirty, false);
  assert.equal(a.state, 'idle');
  const remote = new SQL.Database(await mk(drive).pullAndDecrypt('tok', KEY));
  assert.equal(remote.exec('SELECT COUNT(*) FROM tags')[0].values[0][0], c.table('tags').count());
  unbind();
});

await test('maxWait forces a push during continuous edits', async () => {
  const drive = createMockDrive();
  const a = mk(drive, { debounceMs: 40, maxWaitMs: 100 });
  await a.pull('tok', KEY);
  let n = 0;
  const src = { getAccessToken: () => 'tok', snapshot: () => ({ bytes: new Uint8Array([n]), encryption: { mode: 'passphrase', key: KEY } }) };
  const start = Date.now();
  while (Date.now() - start < 260) {
    n++;
    a.schedulePush(src);
    await new Promise((r) => setTimeout(r, 15));
  }
  await a.flush();
  assert.ok(uploads(drive) >= 2 && uploads(drive) <= 4, `expected 2-4 uploads, saw ${uploads(drive)}`);
});

await test('large payload (>5 MB) uses resumable upload for create and update', async () => {
  const drive = createMockDrive();
  const a = mk(drive);
  await a.pull('tok', KEY);
  const big = new Uint8Array(6 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
  await a.encryptAndPush('tok', big, KEY);
  await a.encryptAndPush('tok', big, KEY);
  assert.deepEqual(
    drive.log.filter((l) => l.includes('/upload/') || l.startsWith('PUT')),
    ['POST /upload/drive/v3/files?uploadType=resumable', 'PUT /s0', `PATCH /upload/drive/v3/files/${drive.live('primary')[0].id}?uploadType=resumable`, 'PUT /s1'],
  );
  assert.deepEqual(await mk(drive).pullAndDecrypt('tok', KEY), big);
});

// ───────────────────────────────────────────────────── 6. storage settings
console.log('Storage settings');

await test('defaults to encrypted, no readable copies; settings writes mark dirty and sync', () => {
  const c = freshClient();
  c.markClean();
  assert.deepEqual(readStorageSettings(c), { encryption: 'passphrase', readableExport: 'none' });
  writeStorageSettings(c, { encryption: 'none', readableExport: 'none' });
  assert.equal(c.isDirty, true);
  const rev = c.revision;
  writeStorageSettings(c, { encryption: 'none', readableExport: 'none' });
  assert.equal(c.revision, rev, 'no-op write does not bump revision');
  assert.equal(c.table('tasks').count() > 0, true);
});

await test('encryption off: bare SQLite file anyone with Drive access can open; no key needed to pull', async () => {
  const drive = createMockDrive();
  const a = mk(drive);
  await a.pull('tok', null);
  const c = freshClient();
  writeStorageSettings(c, { encryption: 'none', readableExport: 'none' });
  const unbind = bindAutoSync(c, a, { getAccessToken: () => 'tok', schemaMeta: meta });
  await a.flush();
  const [primary] = drive.live('primary');
  assert.equal(primary.name, 'demo-app.sqlite');
  assert.equal(primary.mimeType, 'application/vnd.sqlite3');
  assert.equal(primary.appProperties.iceboltEncryption, 'none');
  assert.equal(Buffer.from(primary.content.slice(0, 15)).toString(), 'SQLite format 3');
  const other = await mk(drive).pull('tok', null);
  assert.equal(other.encrypted, false);
  const replica = new IceboltClient(createSqlJsDriver(new SQL.Database(other.bytes)), meta);
  assert.equal(readStorageSettings(replica).encryption, 'none', 'settings travel with the data');
  unbind();
});

await test('encryption on (passphrase required) and older plaintext versions purged from Drive history', async () => {
  const drive = createMockDrive();
  const a = mk(drive);
  await a.pull('tok', null);
  const c = freshClient();
  writeStorageSettings(c, { encryption: 'none', readableExport: 'none' });
  const events = [];
  a.subscribe((e) => events.push(e));
  let key = null;
  bindAutoSync(c, a, { getAccessToken: () => 'tok', getEncryptionKey: () => key, schemaMeta: meta });
  await a.flush();
  c.table('tags').insert({ id: 99, label: 'plain-era' });
  await a.flush();
  const [primary] = drive.live('primary');
  assert.equal(primary.revisions.length, 2);

  writeStorageSettings(c, { encryption: 'passphrase', readableExport: 'none' });
  await a.flush();
  assert.ok(events.some((e) => e.type === 'error' && /no passphrase/.test(e.error.message)), 'refuses to push without a key');
  assert.equal(c.isDirty, true);
  assert.ok(isSqliteBytes(primary.content), 'remote unchanged after refused push');

  key = KEY;
  await a.flush();
  assert.equal(c.isDirty, false);
  assert.equal(primary.name, 'demo-app.icebolt');
  assert.ok(!isSqliteBytes(primary.content));
  assert.equal(primary.revisions.length, 1, 'only the encrypted head revision remains');
  assert.deepEqual(events.find((e) => e.type === 'revisions-purged'), { type: 'revisions-purged', deleted: 2, failed: 0 });
  await assert.rejects(mk(drive).pull('tok', null), /passphrase is required/);
});

await test('readable copies: NDJSON + BigQuery schema per table, unchanged tables skipped, removal trashes them', async () => {
  const drive = createMockDrive();
  const a = mk(drive);
  await a.pull('tok', KEY);
  const c = freshClient();
  writeStorageSettings(c, { encryption: 'passphrase', readableExport: 'ndjson' });
  const exportEvents = [];
  a.subscribe((e) => e.type === 'exports' && exportEvents.push(e));
  const unbind = bindAutoSync(c, a, { getAccessToken: () => 'tok', getEncryptionKey: () => KEY, schemaMeta: meta, appLabel: 'Mod Tracker' });
  await a.flush();

  const [folder] = drive.live('export-folder');
  assert.equal(folder.name, 'Readable copies');
  assert.equal(folder.parents[0], drive.live('app-folder')[0].id, 'readable copies live inside the app folder');
  const exported = drive.live('export');
  const tableCount = Object.keys(meta).length;
  assert.equal(exported.length, tableCount * 2 + 1);
  assert.ok(exported.every((f) => f.parents[0] === folder.id));
  assert.ok(!isSqliteBytes(drive.live('primary')[0].content), 'main file still encrypted');

  const byName = Object.fromEntries(exported.map((f) => [f.name, f]));
  const taskLines = Buffer.from(byName['tasks.ndjson'].content).toString().trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(taskLines.length, c.table('tasks').count());
  assert.equal(typeof taskLines[0].done, 'boolean');
  const projects = Buffer.from(byName['projects.ndjson'].content).toString().trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(projects[0].settings, {}, 'JSON columns stay structured');
  const schema = JSON.parse(Buffer.from(byName['tasks.bigquery-schema.json'].content).toString());
  assert.deepEqual(schema.find((s) => s.name === 'done'), { name: 'done', type: 'BOOLEAN', mode: 'REQUIRED' });
  assert.deepEqual(schema.find((s) => s.name === 'priority'), { name: 'priority', type: 'INTEGER', mode: 'REQUIRED' });
  assert.equal(schema.find((s) => s.name === 'status').description, 'one of: todo, doing, done');
  assert.match(Buffer.from(byName['README.txt'].content).toString(), /Mod Tracker[\s\S]*NEWLINE_DELIMITED_JSON/);
  assert.deepEqual(exportEvents.at(-1), { type: 'exports', uploaded: tableCount * 2 + 1, unchanged: 0, trashed: 0 });

  c.table('tags').insert({ id: 500, label: 'fresh' });
  await a.flush();
  assert.deepEqual(exportEvents.at(-1), { type: 'exports', uploaded: 1, unchanged: tableCount * 2, trashed: 0 }, 'only tags.ndjson re-uploaded');

  // A brand-new session (other device) also skips unchanged files: hashes live on Drive.
  const b = mk(drive);
  await b.pull('tok', KEY);
  await b.push('tok', await buildPushPayload(c, { getEncryptionKey: () => KEY, schemaMeta: meta, appLabel: 'Mod Tracker' }));
  const bEvents = [];
  b.subscribe((e) => e.type === 'exports' && bEvents.push(e));
  await b.push('tok', await buildPushPayload(c, { getEncryptionKey: () => KEY, schemaMeta: meta, appLabel: 'Mod Tracker' }));
  assert.equal(bEvents[0].uploaded, 0);

  unbind();
  const a2 = mk(drive);
  await a2.pull('tok', KEY);
  writeStorageSettings(c, { encryption: 'passphrase', readableExport: 'none' });
  await a2.push('tok', await buildPushPayload(c, { getEncryptionKey: () => KEY, schemaMeta: meta }));
  assert.equal(drive.live('export').length, 0);
  assert.equal(drive.live('export-folder').length, 0);
  assert.equal(drive.live('primary').length, 1, 'main database untouched');
});

await test('everything lands in one folder named after the app; files from older versions are moved in', async () => {
  const drive = createMockDrive();
  // A database left at the Drive root by an earlier version (no app folder yet).
  const legacy = await mk(drive);
  await legacy.pull('tok', KEY);
  await legacy.encryptAndPush('tok', new Uint8Array([1]), KEY);
  const [appFolder0] = drive.live('app-folder');
  const [primary0] = drive.live('primary');
  primary0.parents = ['root'];
  drive.files.delete(appFolder0.id);

  const a = new GoogleDriveSyncManager({ appId: 'demo-app', folderName: 'Syntax Tree Sandbox', fetch: drive.fetch, pbkdf2Iterations: ITER, baseBackoffMs: 5, maxBackoffMs: 40 });
  await a.pull('tok', KEY);
  const c = freshClient();
  writeStorageSettings(c, { encryption: 'passphrase', readableExport: 'ndjson' });
  await a.push('tok', await buildPushPayload(c, { getEncryptionKey: () => KEY, schemaMeta: meta }));

  const [appFolder] = drive.live('app-folder');
  assert.equal(appFolder.name, 'Syntax Tree Sandbox');
  assert.deepEqual(appFolder.parents, ['root'], 'one folder at the top of My Drive');
  const [primary] = drive.live('primary');
  assert.deepEqual(primary.parents, [appFolder.id], 'legacy database moved into the app folder');
  const [exportsFolder] = drive.live('export-folder');
  assert.deepEqual(exportsFolder.parents, [appFolder.id]);
  assert.ok(drive.live('export').every((f) => f.parents[0] === exportsFolder.id));
  const atRoot = [...drive.files.values()].filter((f) => !f.trashed && f.parents.includes('root'));
  assert.deepEqual(atRoot.map((f) => f.name), ['Syntax Tree Sandbox'], 'nothing else at the root of the user\'s Drive');

  // Later pushes reuse the folder without extra lookups.
  const before = drive.log.length;
  await a.encryptAndPush('tok', c.export(), KEY);
  assert.ok(!drive.log.slice(before).some((l) => l === 'POST /drive/v3/files'), 'no new folders');
});

await test('describeStorageSettings states consequences plainly', () => {
  const enc = describeStorageSettings({ encryption: 'passphrase', readableExport: 'none' });
  assert.match(enc.database, /Only someone with your passphrase/);
  assert.equal(enc.readableCopies, null);
  assert.match(enc.warnings[0], /cannot be recovered/);
  const mixed = describeStorageSettings({ encryption: 'passphrase', readableExport: 'ndjson' });
  assert.ok(mixed.warnings.some((w) => /Readable copies are not encrypted/.test(w)));
  const open = describeStorageSettings({ encryption: 'none', readableExport: 'ndjson' });
  assert.match(open.database, /Google/);
  assert.match(open.readableCopies, /BigQuery/);
  for (const d of [enc, mixed, open]) assert.match(d.database, /developer/i);
});

// ───────────────────────────────────────────────────────── 7. DOM renderer
console.log('DOM renderer');
const { JSDOM } = await import('jsdom');
await test('renders labelled controls, coerces values, no HTML injection', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.HTMLSelectElement = window.HTMLSelectElement;
  const doc = window.document;
  const evil = compileSchema(`Table x { id int [pk]\n n text [note: '@ui:form-input { label: "<img src=x onerror=alert(1)>" }'] }`);
  const f0 = renderForm(evil.uiManifest.tables.x, { onSubmit() {}, doc });
  assert.equal(f0.querySelector('img'), null);
  assert.equal(f0.querySelector('label').textContent, '<img src=x onerror=alert(1)>');

  let submitted;
  const form = renderForm(tasksUi, { onSubmit: (v) => (submitted = v), doc });
  doc.body.append(form);
  assert.equal(form.querySelector('#icebolt-tasks-title').getAttribute('placeholder'), 'What needs doing?');
  assert.equal(form.querySelector('label[for="icebolt-tasks-title"]').textContent, 'Task');
  assert.equal(form.querySelectorAll('#icebolt-tasks-status option').length, 4);
  form.querySelector('#icebolt-tasks-title').value = 'Siege towers';
  form.querySelector('#icebolt-tasks-priority').value = '3';
  form.querySelector('#icebolt-tasks-status').value = 'doing';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(submitted, { title: 'Siege towers', status: 'doing', priority: 3 });

  const row = client.table('tasks').first();
  const clicked = [];
  const group = renderActionButtons(tasksUi, row, { onAction: (a) => clicked.push(a.action), confirm: () => true, doc });
  assert.deepEqual([...group.querySelectorAll('button')].map((b) => b.textContent), ['Advance', 'Toggle done', 'Bump', 'Delete']);
  group.querySelectorAll('button')[1].click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(clicked, ['toggleRow']);
});

await test('settings panel: custody is a fixed statement, toggles report consequences', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const doc = window.document;
  const changes = [];
  const panel = renderStorageSettings({ settings: { encryption: 'passphrase', readableExport: 'none' }, onChange: (n) => changes.push(n), doc });
  assert.equal(panel.querySelector('.icebolt-custody').textContent, DATA_CUSTODY_STATEMENT);
  const inputs = [...panel.querySelectorAll('input')];
  assert.equal(inputs.length, 3, 'one encryption checkbox + two export radios; no developer-access control');
  const enc = panel.querySelector('#icebolt-setting-encryption');
  assert.equal(enc.checked, true);
  panel.querySelector('#icebolt-setting-export-ndjson').checked = true;
  panel.querySelector('#icebolt-setting-export-ndjson').dispatchEvent(new window.Event('change'));
  assert.match(panel.querySelector('.icebolt-who-can-read').textContent, /Readable copies are not encrypted/);
  enc.checked = false;
  enc.dispatchEvent(new window.Event('change'));
  assert.deepEqual(changes, [
    { encryption: 'passphrase', readableExport: 'ndjson' },
    { encryption: 'none', readableExport: 'ndjson' },
  ]);
  assert.match(panel.querySelector('.icebolt-who-can-read').textContent, /open it in any SQLite tool/);
});

// ───────────────────────────────────────────────────────────── 8. auth
console.log('Google sign-in');

function createFakeGis() {
  let config = null;
  const fake = {
    allowPopup: true,
    closePopup: false,
    grantScopes: true,
    nextToken: 'tok',
    expiresIn: 3600,
    requests: [],
    revoked: [],
    initTokenClient(c) {
      config = c;
      fake.config = c;
      return {
        requestAccessToken(overrides) {
          fake.requests.push(overrides);
          if (!fake.allowPopup) return queueMicrotask(() => config.error_callback({ type: 'popup_failed_to_open' }));
          if (fake.closePopup) return queueMicrotask(() => config.error_callback({ type: 'popup_closed' }));
          queueMicrotask(() =>
            config.callback({ access_token: fake.nextToken, expires_in: String(fake.expiresIn), scope: fake.grantScopes ? DRIVE_FILE_SCOPE : 'openid' }),
          );
        },
      };
    },
    hasGrantedAllScopes: (res, ...scopes) => scopes.every((s) => (res.scope ?? '').split(' ').includes(s)),
    revoke: (token, done) => {
      fake.revoked.push(token);
      done?.();
    },
  };
  return fake;
}

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const makeAuth = (gis, extra = {}) => {
  const clock = { t: 1_000_000 };
  const auth = new GoogleDriveAuth({ clientId: CLIENT_ID, loadGis: async () => gis, now: () => clock.t, refreshOnInteraction: false, ...extra });
  return { auth, clock };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

await test('rejects a malformed client ID; never needs a client secret', () => {
  assert.throws(() => new GoogleDriveAuth({ clientId: 'not-a-client-id', loadGis: async () => createFakeGis() }), /apps\.googleusercontent\.com/);
});

await test('sign-in caches the token; only drive.file is requested; concurrent renewals share one popup', async () => {
  const gis = createFakeGis();
  const { auth, clock } = makeAuth(gis);
  await tick();
  assert.equal(gis.config.scope, DRIVE_FILE_SCOPE);
  assert.equal(auth.state, 'signed-out');
  await assert.rejects(auth.getAccessToken(), (e) => e instanceof IceboltAuthError && e.authCode === 'interaction-required' && e.code === 'auth');
  assert.equal(await auth.signIn(), 'tok');
  assert.deepEqual(gis.requests, [{}], 'first sign-in uses Google default prompt');
  assert.equal(auth.state, 'signed-in');
  assert.equal(await auth.getAccessToken(), 'tok');
  assert.equal(gis.requests.length, 1, 'cached token, no popup');
  clock.t += 3600_000;
  gis.nextToken = 'tok2';
  const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(a, 'tok2');
  assert.equal(b, 'tok2');
  assert.equal(gis.requests.length, 2);
  assert.deepEqual(gis.requests[1], { prompt: '' }, 'renewal skips the consent screen');
});

await test('expired token outside a click → popup blocked → needs-reconnect (not a crash)', async () => {
  const gis = createFakeGis();
  const { auth, clock } = makeAuth(gis);
  await auth.signIn();
  clock.t += 3600_000;
  gis.allowPopup = false;
  await assert.rejects(auth.getAccessToken(), (e) => e.authCode === 'interaction-required');
  assert.equal(auth.state, 'needs-reconnect');
  gis.allowPopup = true;
  assert.equal(await auth.reconnect(), 'tok');
  assert.equal(auth.state, 'signed-in');
});

await test('renews during user activity shortly before expiry, while the popup is still allowed', async () => {
  const { window } = new JSDOM('<!doctype html><body><button>x</button></body>');
  const gis = createFakeGis();
  const { auth, clock } = makeAuth(gis, { refreshOnInteraction: true, doc: window.document });
  await auth.signIn();
  window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(gis.requests.length, 1, 'no renewal while far from expiry');
  clock.t += 56 * 60_000;
  gis.nextToken = 'fresh';
  window.document.querySelector('button').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(gis.requests.length, 2, 'popup opened synchronously inside the gesture');
  await tick();
  assert.equal(await auth.getAccessToken(), 'fresh');
  auth.dispose();
});

await test('user unchecks Drive access → scope-denied, token revoked, signed out', async () => {
  const gis = createFakeGis();
  gis.grantScopes = false;
  const { auth } = makeAuth(gis);
  await assert.rejects(auth.signIn(), (e) => e.authCode === 'scope-denied');
  assert.equal(auth.state, 'signed-out');
  assert.deepEqual(gis.revoked, ['tok']);
});

await test('closing the popup → cancelled; signOut revokes and forgets', async () => {
  const gis = createFakeGis();
  const { auth } = makeAuth(gis);
  gis.closePopup = true;
  await assert.rejects(auth.signIn(), (e) => e.authCode === 'cancelled');
  assert.equal(auth.state, 'signed-out');
  gis.closePopup = false;
  await auth.signIn();
  auth.signOut();
  assert.equal(auth.state, 'signed-out');
  assert.deepEqual(gis.revoked, ['tok']);
  await assert.rejects(auth.getAccessToken(), (e) => e.authCode === 'interaction-required');
});

await test('state flips to needs-reconnect when the token lapses', async () => {
  const gis = createFakeGis();
  gis.expiresIn = 0.05;
  const { auth, clock } = makeAuth(gis);
  await auth.signIn();
  clock.t += 100;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(auth.state, 'needs-reconnect');
});

await test('linkAuthToSync: revoked token (401) → reconnect → pending push flushed', async () => {
  const drive = createMockDrive();
  const sync = mk(drive);
  await sync.pull('tok', KEY);
  const gis = createFakeGis();
  gis.nextToken = 'revoked-elsewhere';
  const { auth } = makeAuth(gis);
  await auth.signIn();
  linkAuthToSync(auth, sync);
  const c = freshClient();
  bindAutoSync(c, sync, { getAccessToken: auth.getAccessToken, getEncryptionKey: () => KEY, schemaMeta: meta });
  c.table('tags').insert({ id: 700, label: 'needs sync' });
  await sync.flush();
  assert.equal(auth.state, 'needs-reconnect', '401 from Drive invalidated the token');
  assert.equal(c.isDirty, true, 'nothing was lost');
  assert.equal(sync.hasPendingPush, true);

  gis.nextToken = 'tok';
  await auth.reconnect();
  await sync.flush();
  assert.equal(c.isDirty, false);
  assert.equal(sync.hasPendingPush, false);
  const remote = new SQL.Database(await mk(drive).pullAndDecrypt('tok', KEY));
  assert.equal(remote.exec('SELECT label FROM tags WHERE id = 700')[0].values[0][0], 'needs sync');
});

await test('connect button follows auth state and opens the popup from its own click', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const gis = createFakeGis();
  const { auth, clock } = makeAuth(gis);
  await tick();
  const connected = [];
  const el = renderDriveConnectButton(auth, { onConnected: (t) => connected.push(t), doc: window.document });
  const button = el.querySelector('button');
  assert.equal(button.textContent, 'Connect Google Drive');
  button.click();
  assert.equal(gis.requests.length, 1, 'requestAccessToken called synchronously in the click');
  assert.equal(button.textContent, 'Connecting…');
  await tick();
  await tick();
  assert.deepEqual(connected, ['tok']);
  assert.equal(button.textContent, 'Google Drive connected');
  assert.equal(button.disabled, true);
  clock.t += 3600_000;
  gis.allowPopup = false;
  await auth.getAccessToken().catch(() => undefined);
  assert.equal(button.textContent, 'Reconnect Google Drive');
  assert.equal(button.disabled, false);
  assert.match(el.querySelector('[role="status"]').textContent, /session expired/);
});

// ──────────────────────────────────────────────────── 9. setup CLI
console.log('icebolt setup google');
const { setupGoogle, suggestProjectId, validateOrigin, projectDisplayName } = await import('../dist/cli/setupGoogle.js');
const { detectThirdParties, renderPrivacyPolicy, topPrivateDomain, addLegalLinks } = await import('../dist/cli/legal.js');
const { mkdtempSync, writeFileSync: wf, readFileSync: rf, mkdirSync: md, existsSync: ex } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { execFileSync } = await import('node:child_process');

function fakeDeps({ gcloud = true, account = 'niv@example.com', projectExists = false, repo = true, answers = {} } = {}) {
  const calls = { exec: [], opened: [], copied: [], prompts: [], log: [] };
  const queue = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [...(Array.isArray(v) ? v : [v])]]));
  return {
    calls,
    exec(cmd, args, opts) {
      calls.exec.push([cmd, ...args].join(' ') + (opts?.interactive ? ' (interactive)' : ''));
      if (cmd === 'git') {
        if (args[0] === 'rev-parse') return { code: repo ? 0 : 128, stdout: '', stderr: '' };
        if (args[0] === 'config') return { code: 0, stdout: args[1] === 'user.name' ? 'Calvin W. Hancock\n' : 'calvin@example.com\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd !== 'gcloud' || !gcloud) return { code: 127, stdout: '', stderr: 'not found' };
      if (args[0] === '--version') return { code: 0, stdout: 'Google Cloud SDK 500.0.0', stderr: '' };
      if (args[0] === 'config') return { code: 0, stdout: account + '\n', stderr: '' };
      if (args[0] === 'projects' && args[1] === 'describe') return { code: projectExists ? 0 : 1, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async prompt(q, def) {
      calls.prompts.push(q);
      const key = Object.keys(queue).find((k) => q.startsWith(k));
      const v = key && queue[key].length ? queue[key].shift() : undefined;
      return v === undefined || v === '' ? def ?? '' : v;
    },
    async waitForEnter() {},
    open(url) { calls.opened.push(url); return true; },
    copy(text) { calls.copied.push(text); return true; },
    log(line = '') { calls.log.push(line); },
  };
}

const SYNTAX_HTML = `<html><head><title>Syntax Tree Sandbox: Drag-and-Drop Constituency Parser | Calvin W. Hancock</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">
</head><body><a href="https://github.com/Nivlahk">GitHub</a><section id="libraryDock" data-google-client-id=""></section>
<script>const NLP_SRC='https://cdn.jsdelivr.net/npm/compromise@14/builds/compromise.min.js';</script></body></html>`;

function makeSite() {
  const dir = mkdtempSync(join(tmpdir(), 'icebolt-site-'));
  wf(join(dir, 'CNAME'), 'calvinhancock.com\n');
  md(join(dir, 'SYNTAX'));
  wf(join(dir, 'SYNTAX/index.html'), SYNTAX_HTML);
  return dir;
}

await test('helpers: project IDs, origins, display names, domains, third parties', () => {
  assert.equal(suggestProjectId('Syntax Tree Sandbox', () => 0.5), 'syntax-tree-sandbox-5500');
  assert.match(suggestProjectId('A very long application name that keeps going and going'), /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
  assert.equal(validateOrigin('https://calvinhancock.com'), null);
  assert.match(validateOrigin('https://calvinhancock.com/'), /trailing slash/);
  assert.match(validateOrigin('http://calvinhancock.com'), /only allows http:\/\/ for localhost/);
  assert.equal(projectDisplayName('Syntax: Trees | Calvin'), 'Syntax Trees Calvin');
  assert.equal(topPrivateDomain('www.calvinhancock.com'), 'calvinhancock.com');
  assert.equal(topPrivateDomain('app.example.co.uk'), 'example.co.uk');
  assert.deepEqual(detectThirdParties(SYNTAX_HTML, ['calvinhancock.com']).sort(), ['Google Fonts (fonts.googleapis.com, fonts.gstatic.com)', 'jsDelivr (cdn.jsdelivr.net)'], 'loaded resources only; plain links like github.com excluded');
  const linked = addLegalLinks('<body><p>x</p></body>', 'privacy.html', 'terms.html');
  assert.equal(addLegalLinks(linked, 'privacy.html', 'terms.html'), linked, 'idempotent');
  assert.match(renderPrivacyPolicy({ appName: '<b>X</b>', operator: 'O', contactEmail: 'a@b.co', homeUrl: 'https://x.y/', effectiveDate: 'Today', thirdParties: [] }), /&lt;b&gt;X&lt;\/b&gt;/);
});

await test('full run with gcloud: legal pages, every Branding field, client, verification file, pushes', async () => {
  const dir = makeSite();
  const deps = fakeDeps({ answers: { 'Paste the Client ID': ['nope', '123456789-abcdef123.apps.googleusercontent.com'], 'Do it now?': 'y', 'Paste the file name': ['google.html', 'google1a2b3c4d5e6f7a8b.html'] } });
  const res = await setupGoogle({ cwd: dir, now: new Date('2026-10-28T12:00:00') }, deps);
  const q = `?project=${res.projectId}`;

  // Legal pages written next to the app, linked from it, with detected third parties.
  const privacy = rf(join(dir, 'SYNTAX/privacy.html'), 'utf8');
  assert.match(privacy, /Syntax Tree Sandbox has no server that receives your data/);
  assert.match(privacy, /made and operated by Calvin W\. Hancock/);
  assert.match(privacy, /mailto:niv@example\.com/);
  assert.match(privacy, /Google Fonts .*jsDelivr|jsDelivr .*Google Fonts/);
  assert.match(privacy, /Effective October 28, 2026/);
  assert.match(privacy, /drive\.file/);
  assert.match(rf(join(dir, 'SYNTAX/terms.html'), 'utf8'), /provided “as is”/);
  const page = rf(join(dir, 'SYNTAX/index.html'), 'utf8');
  assert.match(page, /<a href="privacy\.html"[^>]*>Privacy policy<\/a> · <a href="terms\.html"[^>]*>Terms of service<\/a>/);
  assert.match(page, /data-google-client-id="123456789-abcdef123\.apps\.googleusercontent\.com"/);

  // Every Branding value copied in order, then scope, client name and origins, then the Search Console prefix.
  assert.deepEqual(deps.calls.copied, [
    'Syntax Tree Sandbox',
    'niv@example.com',
    'https://calvinhancock.com/SYNTAX/',
    'https://calvinhancock.com/SYNTAX/privacy.html',
    'https://calvinhancock.com/SYNTAX/terms.html',
    'calvinhancock.com',
    'niv@example.com',
    'https://www.googleapis.com/auth/drive.file',
    'Syntax Tree Sandbox web',
    'https://calvinhancock.com',
    'https://www.calvinhancock.com',
    'http://localhost:8000',
    'https://calvinhancock.com/',
  ]);
  assert.deepEqual(deps.calls.opened, [
    `https://console.cloud.google.com/auth/branding${q}`,
    `https://console.cloud.google.com/auth/scopes${q}`,
    `https://console.cloud.google.com/auth/audience${q}`,
    `https://console.cloud.google.com/auth/clients/create${q}`,
    'https://search.google.com/search-console/welcome',
    `https://console.cloud.google.com/auth/branding${q}`,
  ]);

  // Search Console HTML-file verification at the site root.
  assert.equal(rf(join(dir, 'google1a2b3c4d5e6f7a8b.html'), 'utf8'), 'google-site-verification: google1a2b3c4d5e6f7a8b.html');
  assert.ok(deps.calls.log.some((l) => /not a Search Console file name/.test(l)));

  // gcloud automation, then three commits pushed: legal pages, verification file, client ID.
  assert.ok(deps.calls.exec.includes(`gcloud projects create ${res.projectId} --name=Syntax Tree Sandbox (interactive)`));
  assert.ok(deps.calls.exec.includes(`gcloud services enable drive.googleapis.com --project=${res.projectId} (interactive)`));
  const commits = deps.calls.exec.filter((c) => c.startsWith('git commit'));
  assert.deepEqual(commits, [
    'git commit -m Add privacy policy and terms of service for Syntax Tree Sandbox',
    'git commit -m Add Google Search Console verification file',
    'git commit -m Switch on Google Drive sign-in for Syntax Tree Sandbox',
  ]);
  assert.equal(deps.calls.exec.filter((c) => c === 'git push (interactive)').length, 3);
  assert.ok(deps.calls.log.some((l) => /\[1\/6\] Project and Drive API \(automatic\)/.test(l)));
  assert.ok(deps.calls.log.some((l) => /\[2\/6\] Privacy policy and terms of service/.test(l)));
  assert.ok(deps.calls.log.some((l) => /\[6\/6\] Show your app name/.test(l)));

  // Legal pages are pushed before the Branding page is opened (Google checks them).
  const order = deps.calls.log.join('\n');
  assert.ok(order.indexOf('✓ Pushed.') < order.indexOf('Opened https://console.cloud.google.com/auth/branding'));

  // Re-running on a configured site does nothing unless asked; existing custom legal pages are never overwritten.
  const again = fakeDeps();
  await setupGoogle({ cwd: dir }, again);
  assert.equal(again.calls.opened.length, 0);
});

await test('own legal pages are kept; existing project reused; gcloud login when signed out', async () => {
  const dir = makeSite();
  wf(join(dir, 'SYNTAX/privacy.html'), '<h1>My own policy</h1>');
  let loggedIn = false;
  const deps = fakeDeps({ projectExists: true, answers: { 'Google Cloud project ID': 'my-existing-proj', 'Paste the Client ID': '42-zz9.apps.googleusercontent.com', 'Commit and push': ['n', 'n', 'n'] } });
  const exec = deps.exec;
  deps.exec = (cmd, args, opts) => {
    if (cmd === 'gcloud' && args[0] === 'auth') loggedIn = true;
    if (cmd === 'gcloud' && args[0] === 'config' && !loggedIn) { deps.calls.exec.push('gcloud config get-value account'); return { code: 0, stdout: '(unset)\n', stderr: '' }; }
    return exec(cmd, args, opts);
  };
  const res = await setupGoogle({ cwd: dir }, deps);
  assert.equal(res.projectId, 'my-existing-proj');
  assert.ok(deps.calls.exec.includes('gcloud auth login (interactive)'));
  assert.ok(!deps.calls.exec.some((c) => c.startsWith('gcloud projects create')));
  assert.equal(rf(join(dir, 'SYNTAX/privacy.html'), 'utf8'), '<h1>My own policy</h1>');
  assert.ok(ex(join(dir, 'SYNTAX/terms.html')));
  assert.ok(!deps.calls.exec.some((c) => c.startsWith('git commit')), 'declined pushes are respected');
  assert.ok(deps.calls.log.some((l) => /Kept your existing SYNTAX\/privacy\.html/.test(l)));
});

await test('without gcloud, Vite app: pages in public/, links in index.html, ID in .env.local', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'icebolt-vite-'));
  wf(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vite: '^6.0.0' } }));
  wf(join(dir, 'index.html'), '<html><body><div id="app"></div></body></html>');
  wf(join(dir, '.env.local'), 'OTHER=1\n');
  const deps = fakeDeps({ gcloud: false, repo: false, answers: {
    'Sites this app runs on': 'https://modtracker.app, http://localhost:5173',
    'Paste the project ID': ['Bad_ID', 'mod-tracker-123'],
    'Paste the Client ID': '99-abc.apps.googleusercontent.com',
  } });
  const res = await setupGoogle({ cwd: dir, appName: 'Mod Tracker' }, deps);
  assert.deepEqual(res.origins, ['https://modtracker.app', 'http://localhost:5173']);
  assert.equal(deps.calls.opened[0], 'https://console.cloud.google.com/projectcreate');
  assert.equal(deps.calls.opened[1], 'https://console.cloud.google.com/apis/library/drive.googleapis.com?project=mod-tracker-123');
  assert.ok(ex(join(dir, 'public/privacy.html')) && ex(join(dir, 'public/terms.html')));
  assert.match(rf(join(dir, 'index.html'), 'utf8'), /href="\/privacy\.html"/);
  assert.ok(deps.calls.copied.includes('https://modtracker.app/privacy.html'));
  assert.equal(rf(join(dir, '.env.local'), 'utf8'), 'OTHER=1\nVITE_GOOGLE_CLIENT_ID=99-abc.apps.googleusercontent.com\n');
  assert.ok(deps.calls.log.some((l) => /Upload .*public\/privacy\.html/.test(l)), 'not a git repo: told to upload');
  assert.ok(deps.calls.log.some((l) => /\[7\/7\] Show your app name/.test(l)));
});

await test('localhost-only setup skips legal pages and branding links', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'icebolt-o-'));
  const deps = fakeDeps({ gcloud: false, answers: { 'Sites this app runs on': ['http://example.com/app/', 'http://localhost:3000'], 'Paste the project ID': 'ex-app-1234', 'Paste the Client ID': '1-a.apps.googleusercontent.com' } });
  const res = await setupGoogle({ cwd: dir, appName: 'Ex' }, deps);
  assert.deepEqual(res.origins, ['http://localhost:3000']);
  assert.ok(deps.calls.log.some((l) => /only allows http:\/\/ for localhost/.test(l)));
  assert.ok(!ex(join(dir, 'privacy.html')));
  assert.ok(deps.calls.log.some((l) => /App domain links are only needed to publish/.test(l)));
});

await test('real binary: --help, and --client-id writes without any prompts', () => {
  const bin = join(here, '../dist/cli/index.js');
  assert.match(execFileSync('node', [bin, '--help'], { encoding: 'utf8' }), /icebolt setup google/);
  const dir = mkdtempSync(join(tmpdir(), 'icebolt-bin-'));
  wf(join(dir, 'page.html'), '<main data-google-client-id=""></main>');
  const out = execFileSync('node', [bin, 'setup', 'google', '--client-id', '7-xyz.apps.googleusercontent.com'], { cwd: dir, encoding: 'utf8', input: '' });
  assert.match(out, /Wrote the client ID into page\.html/);
  let failed = false;
  try { execFileSync('node', [bin, 'setup', 'google', '--client-id', 'not-an-id', '--write', 'page.html'], { cwd: dir, stdio: 'pipe', input: 'y\n' }); } catch { failed = true; }
  assert.ok(failed, 'invalid ID exits non-zero');
});

// ─────────────────────────────────────────────────── 10. schema migrations
console.log('Schema migrations');
const { IceboltSchemaTooNewError, IceboltMigrationError, describeMigration } = await import('../dist/index.js');

const V1 = `
Enum status { todo
  done }
Table projects { id integer [pk, increment]
  name varchar(80) [not null] }
Table tasks {
  id integer [pk, increment]
  project_id integer [not null]
  title varchar(140) [not null]
  status status [not null, default: 'todo']
  notes text
  indexes { title }
}
Ref: tasks.project_id > projects.id [delete: cascade]`;

// v2: purely additive.
const V2 = V1.replace("  notes text\n", "  notes text\n  priority int [not null, default: 0]\n  due_on date\n")
  .replace('  indexes { title }', '  indexes {\n    title\n    status\n  }') + `
Table tags { id integer [pk, increment]
  label varchar(30) [not null, unique] }`;

// v3: renames, a wider column, a newly required column, a new enum value, a renamed table, a computed default.
const V3 = `
Enum status { todo
  doing
  done }
Table workspaces [note: 'x'] { id integer [pk, increment]
  name varchar(80) [not null]
  Note: '@renamed-from: projects' }
Table tasks {
  id integer [pk, increment]
  project_id integer [not null]
  name varchar(200) [not null, note: '@renamed-from: title']
  status status [not null, default: 'todo']
  notes text [not null, default: '']
  priority int [not null, default: 0]
  due_on date
  created_at timestamp [not null, default: \`now()\`]
  indexes {
    name
    status
  }
}
Table tags { id integer [pk, increment]
  label varchar(30) [not null, unique] }
Ref: tasks.project_id > workspaces.id [delete: cascade]`;

const V4 = V3.replace('  due_on date\n', '');

const bundleOf = (r) => ({ migrationSql: r.sqlMigration, schemaHash: r.schemaHash, snapshot: r.snapshot, history: Object.fromEntries(r.lock.history.map((h) => [h.hash, h])) });
const rows = (drv, sql) => drv.all(sql, []);

const c1 = compileSchema(V1);
const c2 = compileSchema(V2, { previous: c1.lock });
const c3 = compileSchema(V3, { previous: c2.lock });

function v1Database() {
  const drv = createSqlJsDriver(new SQL.Database());
  assert.equal(ensureSchema(drv, bundleOf(c1)).status, 'created');
  drv.exec("INSERT INTO projects (name) VALUES ('Bronze Age Mod'), ('Other');");
  drv.exec("INSERT INTO tasks (project_id, title, status, notes) VALUES (1, 'Spearmen', 'done', 'first unit'), (1, 'Chariots', 'todo', NULL), (2, 'Ships', 'todo', NULL);");
  return drv;
}

await test('versions and lockfile: v1 → v2 → v3, history kept, unchanged recompile keeps the version', () => {
  assert.equal(c1.snapshot.version, 1);
  assert.equal(c1.migration, null);
  assert.equal(c2.snapshot.version, 2);
  assert.equal(c3.snapshot.version, 3);
  assert.deepEqual(c3.lock.history.map((h) => h.version), [1, 2, 3]);
  const again = compileSchema(V3, { previous: c3.lock });
  assert.equal(again.snapshot.version, 3);
  assert.equal(again.migration, null);
  assert.deepEqual(c3.snapshot.renames, { tables: { workspaces: ['projects'] }, columns: { tasks: { name: ['title'] } } });
  assert.equal(c2.schemaHash, compileSchema(V2).schemaHash, 'the hash depends only on the schema');
});

await test('additive change (v1 → v2) uses ADD COLUMN in place and keeps every row', () => {
  assert.deepEqual(c2.migration.steps.map((s) => s.kind), ['create-table', 'add-column', 'add-column', 'create-index', 'record-version']);
  const drv = v1Database();
  const r = ensureSchema(drv, bundleOf(c2));
  assert.equal(r.status, 'migrated');
  assert.equal(r.fromVersion, 1);
  assert.equal(r.version, 2);
  assert.deepEqual(rows(drv, 'SELECT title, priority, due_on FROM tasks ORDER BY id').map((x) => [x.title, x.priority, x.due_on]), [['Spearmen', 0, null], ['Chariots', 0, null], ['Ships', 0, null]]);
  assert.ok(rows(drv, "SELECT name FROM sqlite_master WHERE name='ix_tasks_status'").length === 1);
  assert.equal(ensureSchema(drv, bundleOf(c2)).status, 'opened', 'second open is a no-op');
});

await test('structural change (v2 → v3): renames, wider column, required column, new enum value, renamed table', () => {
  console.log(describeMigration(c3.migration).split('\n').map((l) => '      ' + l).join('\n'));
  const drv = v1Database();
  ensureSchema(drv, bundleOf(c2));
  const before = rows(drv, 'SELECT COUNT(*) AS n FROM tasks')[0].n;
  const r = ensureSchema(drv, bundleOf(c3));
  assert.equal(r.status, 'migrated');
  const t = rows(drv, 'SELECT id, project_id, name, status, notes, priority, created_at FROM tasks ORDER BY id');
  assert.equal(t.length, before);
  assert.deepEqual(t.map((x) => [x.name, x.status, x.notes]), [['Spearmen', 'done', 'first unit'], ['Chariots', 'todo', ''], ['Ships', 'todo', '']]);
  assert.ok(t.every((x) => /^\d{4}-\d\d-\d\dT/.test(x.created_at)), 'computed default filled for existing rows');
  assert.deepEqual(rows(drv, 'SELECT name FROM workspaces ORDER BY id').map((x) => x.name), ['Bronze Age Mod', 'Other']);
  assert.equal(rows(drv, "SELECT name FROM sqlite_master WHERE name='projects'").length, 0);
  // New rules apply: the new enum value works, the longer text fits, and constraints still bite.
  drv.exec("INSERT INTO tasks (project_id, name, status) VALUES (1, '" + 'x'.repeat(180) + "', 'doing');");
  assert.throws(() => drv.exec("INSERT INTO tasks (project_id, name, status) VALUES (1, 'bad', 'blocked');"), /CHECK constraint/);
  assert.throws(() => drv.exec("INSERT INTO tasks (project_id, name) VALUES (99, 'orphan');"), /FOREIGN KEY/);
  // The foreign key follows the renamed table, cascades included.
  drv.exec('DELETE FROM workspaces WHERE id = 2;');
  assert.equal(rows(drv, 'SELECT COUNT(*) AS n FROM tasks WHERE project_id = 2')[0].n, 0);
  assert.deepEqual(rows(drv, 'PRAGMA foreign_key_check'), []);
  const idx = rows(drv, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((x) => x.name);
  assert.deepEqual(idx, ['ix_tasks_name', 'ix_tasks_project_id_fk', 'ix_tasks_status'], 'indexes match the new schema; the stale title index is gone');
  // The typed client works against the upgraded database.
  const typed = new IceboltClient(drv, Object.fromEntries(c3.schema.tables.map((tb) => [tb.name, { primaryKey: tb.primaryKey, columns: Object.fromEntries(tb.columns.map((c) => [c.name, { kind: c.kind, nullable: c.nullable, hasDefault: c.hasDefault, generated: c.generated, ...(c.enumValues ? { enumValues: c.enumValues } : {}) }])) }])));
  assert.equal(typed.table('tasks').where({ name: 'Spearmen' }).first().notes, 'first unit');
});

await test('users who skipped versions upgrade straight from v1 to v3', () => {
  const drv = v1Database();
  const r = ensureSchema(drv, bundleOf(c3));
  assert.equal(r.fromVersion, 1);
  assert.equal(r.version, 3);
  assert.deepEqual(rows(drv, 'SELECT name, priority FROM tasks ORDER BY id').map((x) => [x.name, x.priority]), [['Spearmen', 0], ['Chariots', 0], ['Ships', 0]]);
});

await test('databases created before snapshots existed upgrade via the lockfile history', () => {
  const drv = v1Database();
  drv.exec("DELETE FROM __icebolt_meta WHERE key IN ('schema_snapshot', 'schema_version');");
  const r = ensureSchema(drv, bundleOf(c3));
  assert.equal(r.status, 'migrated');
  assert.equal(r.fromVersion, 1);
  // Opening an up-to-date pre-snapshot database records a snapshot for next time.
  const old = v1Database();
  old.exec("DELETE FROM __icebolt_meta WHERE key = 'schema_snapshot';");
  assert.equal(ensureSchema(old, bundleOf(c1)).status, 'opened');
  assert.equal(JSON.parse(rows(old, "SELECT value FROM __icebolt_meta WHERE key='schema_snapshot'")[0].value).version, 1);
});

await test('backup is the exact pre-upgrade database', () => {
  const drv = v1Database();
  const original = drv.export();
  const r = ensureSchema(drv, bundleOf(c3));
  assert.deepEqual(r.backup, original);
  const restored = createSqlJsDriver(new SQL.Database(r.backup));
  assert.equal(rows(restored, "SELECT value FROM __icebolt_meta WHERE key='schema_version'")[0].value, '1');
});

await test('an older copy of the app refuses a database a newer version upgraded', () => {
  const drv = v1Database();
  ensureSchema(drv, bundleOf(c3));
  const snap = drv.export();
  assert.throws(() => ensureSchema(drv, bundleOf(c2)), (e) => e instanceof IceboltSchemaTooNewError && e.databaseVersion === 3 && e.appVersion === 2);
  assert.deepEqual(drv.export(), snap, 'untouched');
});

await test('dropping data needs explicit confirmation, which the lock remembers', () => {
  assert.throws(() => compileSchema(V4, { previous: c3.lock }), (e) => e instanceof IceboltCompileError && /tasks\.due_on is gone/.test(e.message) && /allowDrop/.test(e.message));
  const c4 = compileSchema(V4, { previous: c3.lock, allowDrop: ['tasks.due_on'] });
  assert.deepEqual(c4.snapshot.drops.columns, { tasks: ['due_on'] });
  const drv = v1Database();
  ensureSchema(drv, bundleOf(c4));
  assert.ok(!rows(drv, 'PRAGMA table_info(tasks)').some((c) => c.name === 'due_on'));
  assert.equal(rows(drv, 'SELECT COUNT(*) AS n FROM tasks')[0].n, 3);
  // Later compiles keep the confirmation without repeating the flag.
  assert.equal(compileSchema(V4.replace("varchar(200)", "varchar(210)"), { previous: c4.lock }).snapshot.version, 5);
  // Dropping a whole table, too.
  assert.throws(() => compileSchema(V4.replace(/Table tags[^}]*}/, ''), { previous: c4.lock }), /Table tags is gone/);
});

await test('unsafe changes are compile errors, not silent data loss', () => {
  assert.throws(() => compileSchema(V1.replace('  notes text\n', '  notes text\n  owner text [not null]\n'), { previous: c1.lock }), /owner is required \(not null\) but has no default/);
  assert.throws(() => compileSchema(V1.replace('  notes text\n', '  notes text [not null]\n'), { previous: c1.lock }), /notes became required \(not null\) without a default/);
  // A rename without the hint looks like drop + add, and is caught.
  assert.throws(() => compileSchema(V1.replace('title varchar(140)', 'heading varchar(140)').replace('indexes { title }', 'indexes { heading }'), { previous: c1.lock }), /tasks\.title is gone. If it was renamed, add @renamed-from: title/);
});

await test('a migration that hits incompatible data rolls back completely', () => {
  // v6 removes the enum value "doing" while a row still uses it.
  const c4 = compileSchema(V4, { previous: c3.lock, allowDrop: ['tasks.due_on'] });
  const c5 = compileSchema(V4.replace('  doing\n', ''), { previous: c4.lock });
  assert.ok(c5.diagnostics.some((d) => /no longer allows doing/.test(d.message)), 'warned at compile time');
  const drv = v1Database();
  ensureSchema(drv, bundleOf(c4));
  drv.exec("UPDATE tasks SET status = 'doing' WHERE id = 2;");
  const before = drv.export();
  assert.throws(() => ensureSchema(drv, bundleOf(c5)), (e) => e instanceof IceboltMigrationError && /nothing was changed/.test(e.message) && /CHECK constraint/.test(e.message));
  assert.deepEqual(drv.export(), before, 'byte-for-byte unchanged');
  assert.equal(rows(drv, 'PRAGMA foreign_keys')[0].foreign_keys, 1, 'foreign keys back on');
});

await test('upgrade backups go to a Backups folder inside the app folder and never replace the live database', async () => {
  const drive = createMockDrive();
  const a = new GoogleDriveSyncManager({ appId: 'demo-app', folderName: 'Demo', fetch: drive.fetch, pbkdf2Iterations: ITER, baseBackoffMs: 5, maxBackoffMs: 40 });
  await a.pull('tok', KEY);
  const old = v1Database();
  const r = ensureSchema(old, bundleOf(c3));
  await a.backup('tok', { bytes: r.backup, encryption: { mode: 'passphrase', key: KEY }, label: 'before v3 (2026-10-28)' });
  await a.encryptAndPush('tok', old.export(), KEY);
  const [app] = drive.live('app-folder');
  const [backups] = drive.live('backup-folder');
  const [file] = drive.live('backup');
  assert.equal(backups.name, 'Backups');
  assert.deepEqual(backups.parents, [app.id]);
  assert.equal(file.name, 'demo-app before v3 (2026-10-28).icebolt');
  assert.ok(!isSqliteBytes(file.content), 'encrypted like the live file');
  const live = await new GoogleDriveSyncManager({ appId: 'demo-app', fetch: drive.fetch, pbkdf2Iterations: ITER }).pull('tok', KEY);
  const db = createSqlJsDriver(new SQL.Database(live.bytes));
  assert.equal(rows(db, "SELECT value FROM __icebolt_meta WHERE key='schema_version'")[0].value, '3', 'pull returns the upgraded database, not the backup');
});

await test('icebolt compile: lockfile workflow, upgrade plan printed, drops need --allow-drop', () => {
  const bin = join(here, '../dist/cli/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'icebolt-compile-'));
  const run = (args, ok = true) => {
    try {
      const out = execFileSync('node', [bin, 'compile', 'schema.dbml', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      assert.ok(ok, 'expected failure');
      return out;
    } catch (e) {
      if (ok) throw e;
      return String(e.stderr);
    }
  };
  wf(join(dir, 'schema.dbml'), V1);
  assert.match(run([]), /Schema v1 .*Started schema history/s);
  assert.ok(ex(join(dir, 'icebolt.schema.lock.json')) && ex(join(dir, 'src/db/icebolt-client.ts')));
  assert.doesNotMatch(run([]), /wrote/, 'unchanged schema writes nothing');
  wf(join(dir, 'schema.dbml'), V3);
  const out3 = run([]);
  assert.match(out3, /Schema v2 .*Schema v1 → v2.*Rename table projects → workspaces.*upgrade automatically/s);
  wf(join(dir, 'schema.dbml'), V4.replace('  priority int [not null, default: 0]\n', ''));
  assert.match(run([], false), /error: .*tasks\.priority is gone.*--allow-drop tasks\.priority/s);
  assert.match(run(['--allow-drop', 'tasks.priority'], false), /tasks\.due_on is gone/, 'every drop must be confirmed');
  assert.match(run(['--allow-drop', 'tasks.priority', '--allow-drop', 'tasks.due_on']), /Schema v3 .*Rebuild tasks keeping its rows \(−priority, −due_on\)/s);
  const lock = JSON.parse(rf(join(dir, 'icebolt.schema.lock.json'), 'utf8'));
  assert.deepEqual(lock.history.map((h) => h.version), [1, 2, 3]);
  assert.deepEqual(lock.current.drops.columns.tasks.sort(), ['due_on', 'priority']);
});

await test('generated client exposes the snapshot and upgrades on open', () => {
  const src = generateClientSource(c3);
  assert.match(src, /export const SCHEMA_SNAPSHOT: SchemaSnapshot \| undefined = \{"format":1,"version":3/);
  assert.match(src, /export const SCHEMA_HISTORY/);
  assert.match(src, /onMigrated\?\.\(result\)/);
});

await test('icebolt init: Vite starter becomes a working Icebolt app, idempotently', () => {
  const bin = join(here, '..', 'dist', 'cli', 'index.js');
  const dir = mkdtempSync(join(tmpdir(), 'icebolt-init-'));
  wf(join(dir, 'package.json'), JSON.stringify({ name: 'pocket-notes', private: true, type: 'module',
    scripts: { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview' },
    dependencies: { 'nivlahkicebolt': '^1.0.0', 'sql.js': '^1.11.0' }, devDependencies: { typescript: '~5.6.2', vite: '^5.4.0' } }, null, 2));
  wf(join(dir, 'tsconfig.json'), '{}');
  wf(join(dir, '.gitignore'), 'node_modules\ndist\n');
  md(join(dir, 'src'));
  wf(join(dir, 'src/main.ts'), "import './style.css'\nimport viteLogo from '/vite.svg'\nimport { setupCounter } from './counter.ts'\n");
  wf(join(dir, 'src/counter.ts'), 'export function setupCounter() {}\n');
  wf(join(dir, 'src/style.css'), '');
  const out = execFileSync('node', [bin, 'init'], { cwd: dir, encoding: 'utf8' });
  assert.match(out, /Icebolt added to Pocket Notes/);
  assert.match(out, /npx icebolt setup google/);
  assert.doesNotMatch(out, /npm install/, 'deps already present');
  const pkg = JSON.parse(rf(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['icebolt:compile'], 'icebolt compile schema.dbml --out src/db');
  assert.equal(pkg.scripts.predev, 'npm run icebolt:compile');
  assert.equal(pkg.scripts.prebuild, 'npm run icebolt:compile');
  for (const f of ['schema.dbml', 'icebolt.schema.lock.json', 'src/db/icebolt-client.ts', 'src/icebolt.ts', 'src/sqljs.d.ts']) assert.ok(ex(join(dir, f)), f);
  const client = rf(join(dir, 'src/db/icebolt-client.ts'), 'utf8');
  assert.match(client, /export const UI_MANIFEST: UiManifest/);
  const wiring = rf(join(dir, 'src/icebolt.ts'), 'utf8');
  assert.match(wiring, /appId: "pocket-notes"/);
  assert.match(wiring, /import\.meta\.env\.VITE_GOOGLE_CLIENT_ID/);
  assert.match(wiring, /sql-wasm\.wasm\?url/);
  const main = rf(join(dir, 'src/main.ts'), 'utf8');
  assert.match(main, /startIcebolt/);
  assert.match(main, /import '\.\/style\.css'/);
  assert.match(rf(join(dir, '.gitignore'), 'utf8'), /\.env\.local/);
  // second run changes nothing and keeps user edits
  wf(join(dir, 'schema.dbml'), rf(join(dir, 'schema.dbml'), 'utf8') + '\n// mine\n');
  const again = execFileSync('node', [bin, 'init'], { cwd: dir, encoding: 'utf8' });
  assert.match(again, /kept {5}schema\.dbml/);
  assert.match(rf(join(dir, 'schema.dbml'), 'utf8'), /\/\/ mine/);
  assert.equal(JSON.parse(rf(join(dir, 'package.json'), 'utf8')).scripts.predev, 'npm run icebolt:compile');
  // existing prebuild hooks are kept
  const d2 = mkdtempSync(join(tmpdir(), 'icebolt-init2-'));
  wf(join(d2, 'package.json'), JSON.stringify({ name: 'x', scripts: { prebuild: 'eslint .' } }));
  const out2 = execFileSync('node', [bin, 'init', '--app-name', 'Field Log'], { cwd: d2, encoding: 'utf8' });
  assert.match(out2, /npm install nivlahkicebolt sql\.js/);
  assert.match(out2, /Not a Vite project/);
  assert.equal(JSON.parse(rf(join(d2, 'package.json'), 'utf8')).scripts.prebuild, 'npm run icebolt:compile && eslint .');
  assert.ok(ex(join(d2, 'src/icebolt.js')));
  assert.match(rf(join(d2, 'src/icebolt.js'), 'utf8'), /appName: "Field Log"/);
  // no package.json: helpful error
  const d3 = mkdtempSync(join(tmpdir(), 'icebolt-init3-'));
  let msg = '';
  try { execFileSync('node', [bin, 'init'], { cwd: d3, stdio: 'pipe' }); } catch (e) { msg = String(e.stderr); }
  assert.match(msg, /npm create vite@latest/);
});

console.log(`\n${passed} tests passed.`);
