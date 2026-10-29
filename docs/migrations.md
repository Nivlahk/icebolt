# Changing your schema

Edit `schema.dbml` and run the app as usual: `npm run dev` and `npm run build` recompile first (or run `npm run icebolt:compile`). The compile prints how users' databases will upgrade:

```
Schema v2 (9c1e…), 3 tables.
Schema v1 → v2:
  • Add column tasks.priority
  • Rename table projects → workspaces
Users' databases upgrade automatically the next time they open the app.
```

**Commit `icebolt.schema.lock.json`.** It records every schema version your app has shipped, so a user who skipped five releases still upgrades cleanly.

## What upgrades automatically

- **New tables, columns and indexes** are added in place.
- **Changed columns, keys or foreign keys** use SQLite's table rebuild: create the new shape, copy every row, swap it in. Type changes are converted with `CAST`.
- **A new required column, or a column that becomes required,** needs a `default`, so existing rows get a value. The compile tells you if it's missing.
- **Changes that might not fit existing data** (fewer enum values, shorter `varchar`) compile with a warning. If real data doesn't fit, that user's upgrade is rolled back and nothing changes.

## Renames need a hint

A diff can't tell a rename from "deleted one, added another", so say so:

```dbml
Table workspaces {
  Note: '@renamed-from: projects'
  id integer [pk, increment]
  title text [not null, note: '@renamed-from: name']
}
```

Once compiled, the hint is recorded in the lockfile; you can delete it from the schema after the release.

## Deleting data needs confirmation

Removing a table or column deletes users' data in it, so the compile refuses until you confirm:

```bash
npx icebolt compile schema.dbml --out src/db --allow-drop tasks.notes --allow-drop old_table
```

The confirmation is stored in the lockfile, so later compiles don't ask again.

## How upgrades run

When the app opens a database (`openIceboltClient`, which the app shell calls for you):

1. Same schema: opened as is.
2. Older schema of this app: every step runs in **one transaction**, foreign keys are checked, then it commits. If anything fails, the database is left byte-for-byte unchanged.
3. Newer schema (the user opened an old copy of your app): refused with `IceboltSchemaTooNewError` instead of being damaged. The app shell asks the user to reload.
4. A database from a different app: refused with `IceboltSchemaMismatchError`.

After an upgrade the database is marked changed, so it syncs back to Drive. The app shell first saves the pre-upgrade copy to a **Backups** folder inside the app's Drive folder and tells the user. Doing it yourself:

```ts
openIceboltClient(driver, {
  onMigrated: (r) => sync.backup(token, { bytes: r.backup, encryption, label: `before v${r.version}` }),
});
```
