# Schema and UI

Your app's data is described in one DBML file (`schema.dbml` after `icebolt init`). `icebolt compile` turns it into `src/db/`:

| File | What it is |
|---|---|
| `icebolt-client.ts` | Row/insert types per table, `openIceboltClient`, `schemaMeta`, `UI_MANIFEST`, and the migration bundle |
| `ui-manifest.json` | The same UI manifest as JSON, for tools or other frameworks |
| `migration.sql` | The full CREATE script, for reading |

and keeps `icebolt.schema.lock.json` next to the schema (commit it; see [migrations](migrations.md)).

## DBML features

```dbml
Enum task_status { todo  doing  done }

Table projects {
  id integer [pk, increment]
  name varchar(80) [not null, unique]
  settings json
}

Table tasks {
  id integer [pk, increment]
  project_id integer [not null, ref: > projects.id]
  title varchar(140) [not null]
  status task_status [not null, default: 'todo']
  done boolean [not null, default: false]
  due_on date
  created_at timestamp [not null, default: `now()`]

  indexes {
    (project_id, status)
  }
}

Table tags { id integer [pk, increment]  name text [not null] }
Ref: tasks.id <> tags.id   // many-to-many: a junction table is generated
```

- Tables are SQLite `STRICT`. `boolean`, enums, `json` and `varchar(n)` become CHECK constraints, so bad data is rejected by the database itself.
- Every foreign key gets an index. `delete:` and `update:` (`cascade`, `set null`, `restrict`, `set default`, `no action`) work on `Ref:` lines and, as an Icebolt convenience, next to an inline ref: `circle_id integer [ref: > circles.id, delete: set null]`.
- Settings Icebolt doesn't understand are compile warnings, never silently dropped.
- `now()` defaults use SQLite's UTC timestamp.
- Errors and warnings come with line and column numbers; the compile fails on any error.

## Forms and buttons: `@ui:` notes

```dbml
Table tasks {
  id integer [pk, increment]
  title varchar(140) [not null, note: '''@ui:form-input { label: 'Task', placeholder: 'What needs doing?' }''']
  status task_status [not null, default: 'todo', note: '''
    @ui:form-input { label: 'Status', optionLabels: { doing: 'In progress' } }
    @ui:action-button { action: 'toggleRow', target: 'status', label: 'Advance' }
  ''']
  done boolean [not null, default: false, note: '@ui:action-button { action: "toggleRow" }']
}
```

`@ui:form-input` keys: `label, placeholder, type, multiline, required, order, help, min, max, step, pattern, maxLength, autocomplete, optionLabels, labelColumn`. The input type, required flag, length and options come from the column automatically; set keys only to override.

**Foreign keys become dropdowns.** A form field on a column that references another table lists that table's rows, labelled by its first unique text column (else its first text column); `labelColumn: 'title'` picks a different one. `circle_id` is labelled “Circle” by default. `renderForm` needs a `lookup` to read the rows (below).

`@ui:action-button` actions: `toggleRow` (flip a boolean, cycle an enum, or step through `values: [...]`), `setValue` (`value`), `increment` / `decrement` (`by`), `deleteRow`. Shared keys: `target` (defaults to the annotated column), `label`, `confirm`, `variant`.

Props are read by a strict literal parser; nothing is evaluated. Bad targets, unknown actions, wrong value types and unknown enum values fail the compile; unknown keys are warnings.

Render them:

```ts
import { lookupFrom, renderForm, renderActionButtons } from 'nivlahkicebolt/ui';
import { executeAction } from 'nivlahkicebolt/runtime';
import { UI_MANIFEST } from './db/icebolt-client';

const ui = UI_MANIFEST.tables['tasks']!;
const form = renderForm(ui, {
  onSubmit: (values) => { db.tableUnsafe('tasks').insert(values); },
  lookup: (ref) => (db ? lookupFrom(db)(ref) : []), // fills foreign-key dropdowns
});
const buttons = renderActionButtons(ui, row, { onAction: (action, r) => { executeAction(db, action, r, ui.primaryKey); } });
```

Dropdowns re-read their options whenever the user opens them. If your code sets a dropdown to a row it just added, call `refreshLookups(form)` first. The submit button says “Add task”, “Add person”, “Add category”: the table name, singular.

Everything is built with `createElement` and `textContent`, never `innerHTML`, so text from the schema can't inject markup. Elements carry `icebolt-*` classes for styling.

## The typed client

```ts
const p = db.table('projects').insert({ name: 'Garden' });          // returns the row, typed
db.table('tasks').insert({ project_id: p.id, title: 'Plant beans' }); // defaults filled in
db.table('tasks').where({ project_id: p.id, done: false }).orderBy('created_at', 'desc').limit(20).select();
db.table('tasks').where({ id: 3 }).update({ done: true });
db.table('tasks').where({ done: true }).delete();
db.transaction(() => { /* all or nothing; nests with savepoints */ });

db.isDirty;          // unsaved changes since the last sync
db.onChange(fn);     // called after every write
```

Values are converted both ways (booleans, JSON, dates as ISO strings) and validated against the schema before they reach SQLite. Column names that don't exist, wrong types and missing required fields are TypeScript errors.

Without the app shell, open a database yourself:

```ts
import initSqlJs from 'sql.js';
import { createSqlJsDriver } from 'nivlahkicebolt/runtime';
import { openIceboltClient } from './db/icebolt-client';

const SQL = await initSqlJs();
const db = openIceboltClient(createSqlJsDriver(new SQL.Database()));
```

`createOo1Driver` does the same for the official `@sqlite.org/sqlite-wasm` build.

## Using the compiler directly

```ts
import { compileSchema, generateClientSource } from 'nivlahkicebolt';

const result = compileSchema(dbmlText); // throws IceboltCompileError listing every problem
result.sqlMigration;  // CREATE script
result.uiManifest;    // forms and buttons
generateClientSource(result); // the icebolt-client.ts source
```
