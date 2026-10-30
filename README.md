# Icebolt

[![npm](https://img.shields.io/npm/v/nivlahkicebolt)](https://www.npmjs.com/package/nivlahkicebolt)
[![CI](https://github.com/Nivlahk/icebolt/actions/workflows/ci.yml/badge.svg)](https://github.com/Nivlahk/icebolt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Let your users own their data.** Icebolt gives a web app a real SQLite database that lives in each user's own Google Drive, in a folder named after your app, optionally encrypted with a passphrase only they know. There is no backend to run, and you, the developer, never receive anyone's data.

You describe your data once in [DBML](https://dbml.dbdiagram.io/docs/); Icebolt compiles it into:

- a **SQLite schema** (STRICT tables, foreign keys, CHECK constraints, indexes) that runs in the browser via WebAssembly;
- a **typed client**: `db.table('notes').insert({ title: 'Hi' })`, with `isDirty` change tracking;
- **forms and buttons** from `@ui:` notes on your columns;
- **automatic upgrades** of users' saved data when you change the schema;
- **Google Drive sync**: Connect button, passphrase prompts, a save status and a Storage menu, all built in.

## Quick start

```bash
npm create vite@latest my-app -- --template vanilla-ts   # skip if you already have an app
cd my-app
npm install nivlahkicebolt sql.js
npx icebolt init
npx icebolt setup google
npm run dev
```

The package is called `nivlahkicebolt`; the command it installs is `icebolt`.

| Command | Result |
|---|---|
| `npx icebolt init` | Adds `schema.dbml` (a starter notes table), compiles it to `src/db/`, hooks the compile into `npm run dev` and `npm run build`, and writes `src/icebolt.ts` (sign-in, storage choice, sync). In a fresh Vite starter it also replaces the counter demo with a working notes app. It never overwrites files you have changed. |
| `npx icebolt setup google` | The one-time Google registration every app needs so users can sign in. It creates the Cloud project (with `gcloud`), generates a privacy policy and terms page, opens each Google console page in order and copies each value for you, then writes the client ID to `.env.local`. You can skip it at first: the app runs locally and says Drive saving isn't set up yet. [Details](docs/google-setup.md) |
| `npm run dev` | Your app works immediately with a local database. **Connect Google Drive** saves it to the user's Drive. |

### Make it yours

Edit `schema.dbml`; the next `npm run dev` recompiles it. Then render from the database. `startIcebolt` takes the element where the Connect / Storage controls go, and a function that receives the database:

```ts
import { startIcebolt } from './icebolt';

const controls = document.createElement('div');
document.body.prepend(controls);

startIcebolt(controls, (db) => {
  const draw = () => {
    const notes = db.table('notes').where({ done: false }).orderBy('created_at', 'desc').select();
    // ...render notes
  };
  db.onChange(draw);
  draw();
});
```

That function runs again whenever the active database changes (after connecting or disconnecting), so always render from the `db` it gives you. The demo `src/main.ts` written by `icebolt init` is a complete example.

## What your users get

- The app works before they sign in. **Connect Google Drive** asks once how to store their data: **encrypted** (only their passphrase opens it, not even Google) or **plain file** (a normal SQLite file they can open with any tool).
- Everything is saved in a **“Your App Name”** folder in their Drive. The app only asks for `drive.file`, so it can see the files it made and nothing else.
- The **Storage** menu shows save status, lets them switch encryption, turn on readable JSON copies for BigQuery, or disconnect.
- When you ship a schema change, their data upgrades on next open, with a copy of the old version kept in a **Backups** folder.

## Docs

- [Schema and UI](docs/schema-and-ui.md): DBML features, `@ui:form-input` and `@ui:action-button`, the typed client
- [Changing your schema](docs/migrations.md): the lockfile, renames, drops, how upgrades run
- [Sync and storage](docs/sync-and-storage.md): Drive layout, encryption, readable copies, wiring it by hand
- [Google setup and sign-in](docs/google-setup.md): what `icebolt setup google` does, publishing the consent screen, tokens

## Commands

```
icebolt init                       Add Icebolt to the app in this folder
icebolt compile schema.dbml        Rebuild src/db/ (runs automatically before dev and build)
icebolt setup google               One-time Google registration
icebolt --help                     All options
```

## Package layout

| Import | Contents |
|---|---|
| `nivlahkicebolt` | Everything below, plus `compileSchema` and `generateClientSource` |
| `nivlahkicebolt/app` | `createIceboltApp`: the complete Connect / Storage experience |
| `nivlahkicebolt/runtime` | Typed client, SQLite drivers (sql.js, @sqlite.org/sqlite-wasm), schema upgrades |
| `nivlahkicebolt/ui` | Forms, action buttons, storage settings panel |
| `nivlahkicebolt/sync` | `GoogleDriveSyncManager`, encryption, readable exports |
| `nivlahkicebolt/auth` | Google sign-in (browser token flow, no server) |
| `nivlahkicebolt/cli` | `init`, `compileProject`, `setupGoogle` as functions |

## Contributing

```bash
git clone https://github.com/Nivlahk/icebolt.git
cd icebolt
npm install
npm test
```

`npm test` builds with strict TypeScript, runs the end-to-end suite (real SQLite through sql.js, a mocked Drive API, jsdom, the CLI against temp projects), and type-checks generated code. CI runs it on every push and pull request.

To try unreleased changes in an app: `npm install github:Nivlahk/icebolt` (it builds itself on install).

## Releasing

Releases are published from GitHub Actions with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers), so there is no npm token to manage, and every version carries a provenance link back to the commit it was built from.

```bash
npm version patch        # or minor / major: bumps package.json, commits, tags
git push --follow-tags   # the tag runs tests and publishes
```

## License

[MIT](LICENSE)
