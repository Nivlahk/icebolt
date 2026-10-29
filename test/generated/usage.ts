import { openIceboltClient, type TasksRow } from './icebolt-client.js';
import { createSqlJsDriver } from 'nivlahkicebolt/runtime';
declare const db: Parameters<typeof createSqlJsDriver>[0];

const client = openIceboltClient(createSqlJsDriver(db));
const p = client.table('projects').insert({ owner_id: 1, name: 'Bronze Age Mod' });
const id: string = p.id;
const archived: boolean = p.archived;
const t: TasksRow = client.table('tasks').insert({ project_id: id, title: 'x', due_on: new Date() });
const s: 'todo' | 'doing' | 'done' = t.status;
const dirty: boolean = client.isDirty;
client.table('tasks').where({ priority: { gte: 2 }, status: 'done' }).orderBy('priority', 'desc').select();
void [archived, s, dirty];

// @ts-expect-error unknown table
client.table('nope');
// @ts-expect-error missing required 'name'
client.table('projects').insert({ owner_id: 1 });
// @ts-expect-error invalid enum literal
client.table('tasks').insert({ project_id: id, title: 'x', status: 'blocked' });
// @ts-expect-error unknown column in where
client.table('tasks').where({ nope: 1 });
// @ts-expect-error wrong value type
client.table('tasks').update({ done: 'yes' });
// @ts-expect-error orderBy on unknown column
client.table('tasks').orderBy('nope');
