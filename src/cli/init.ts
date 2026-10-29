/**
 * `icebolt init` — add Icebolt to an existing web app (Vite recommended).
 *
 * Writes a starter schema, hooks `icebolt compile` into dev/build, compiles
 * once, writes the wiring module (sign-in, storage choice, sync), and in an
 * untouched Vite starter replaces the counter demo with a working notes app.
 * Never overwrites files you have changed; safe to run again.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compileProject } from './compileProject.js';
import { slugify } from './setupGoogle.js';

export interface InitOptions {
  cwd: string;
  appName?: string;
  /** Replace an untouched Vite starter's main file with the demo (default true). */
  demo?: boolean;
}

export interface InitResult {
  appName: string;
  appId: string;
  created: string[];
  updated: string[];
  kept: string[];
  missingDeps: string[];
  demo: boolean;
  vite: boolean;
  typescript: boolean;
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

const COMPILE = 'npm run icebolt:compile';

export function humanizeName(pkgName: string): string {
  const base = pkgName.replace(/^@[^/]+\//, '').replace(/[-_.]+/g, ' ').trim();
  return base ? base.replace(/\b\w/g, (c) => c.toUpperCase()) : 'My App';
}

export const STARTER_SCHEMA = `// Your app's data. Edit it, and the next \`npm run dev\` or \`npm run build\`
// recompiles the typed client. Users' saved data upgrades automatically;
// see https://github.com/Nivlahk/icebolt/blob/main/docs/migrations.md
//
// @ui notes turn columns into form fields and buttons (docs/schema-and-ui.md).

Table notes {
  id integer [pk, increment]
  title varchar(120) [not null, note: '''
    @ui:form-input { label: 'Title', placeholder: 'What is on your mind?' }
    @ui:action-button { action: 'deleteRow', label: 'Delete', confirm: 'Delete this note?' }
  ''']
  body text [note: '''@ui:form-input { label: 'Note', multiline: true }''']
  done boolean [not null, default: false, note: '''@ui:action-button { action: 'toggleRow', label: 'Done' }''']
  created_at timestamp [not null, default: \`now()\`]
}
`;

function wiringTemplate(appId: string, appName: string, ts: boolean, vite: boolean): string {
  const sqlite = vite
    ? `import initSqlJs from 'sql.js';\nimport wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';`
    : `import initSqlJs from 'sql.js';\n// Serve sql-wasm.wasm from node_modules/sql.js/dist/ at this URL (Vite does this for you).\nconst wasmUrl = '/sql-wasm.wasm';`;
  const env = vite ? 'import.meta.env.VITE_GOOGLE_CLIENT_ID' : `'' /* paste your client ID; see docs/google-setup.md */`;
  return `// Icebolt wiring: your users' data lives in their own Google Drive, never on your servers.
// Written by \`icebolt init\`; edit freely.
${sqlite}
import { createIceboltApp } from '@icebolt/compiler-core/app';
import { openIceboltClient, schemaMeta } from './db/icebolt-client';
${ts ? `\nexport type AppDb = ReturnType<typeof openIceboltClient>;\n` : ''}
/**
 * Puts the Connect / Storage controls into \`mount\` and calls \`onReady\` with the
 * database whenever it changes (on start, after connecting, after disconnecting).
 * The app works right away; connecting Google Drive keeps the data.
 */
export function startIcebolt(mount${ts ? ': HTMLElement' : ''}, onReady${ts ? ': (db: AppDb) => void' : ''}) {
  return createIceboltApp({
    appId: ${JSON.stringify(appId)},
    appName: ${JSON.stringify(appName)},
    clientId: ${env}, // set by \`npx icebolt setup google\`
    open: openIceboltClient,
    schemaMeta,
    sqlite: () => initSqlJs({ locateFile: () => wasmUrl }),
    mount,
    onReady,
  });
}
`;
}

const SQLJS_TYPES = `// Types for sql.js as Icebolt uses it (written by \`icebolt init\`).
// Delete this file if you install @types/sql.js.
declare module 'sql.js' {
  import type { SqlJsInit } from '@icebolt/compiler-core/app';
  const initSqlJs: SqlJsInit;
  export default initSqlJs;
}
`;

function demoTemplate(appName: string, hasStyle: boolean): string {
  return `${hasStyle ? "import './style.css';\n" : ''}import { renderActionButtons, renderForm } from '@icebolt/compiler-core/ui';
import { executeAction } from '@icebolt/compiler-core/runtime';
import { UI_MANIFEST } from './db/icebolt-client';
import { startIcebolt, type AppDb } from './icebolt';

// A tiny notes app driven by schema.dbml. Change the schema and this page follows:
// the form and buttons come from the @ui notes in it.
const ui = UI_MANIFEST.tables['notes']!;
const root = document.querySelector<HTMLDivElement>('#app')!;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) => Object.assign(document.createElement(tag), props);

const controls = h('div');
const header = h('header', { className: 'icebolt-demo-header' });
header.append(h('h1', { textContent: ${JSON.stringify(appName)} }), controls);
const list = h('ul', { className: 'icebolt-demo-list' });
let db: AppDb | null = null;

const form = renderForm(ui, {
  onSubmit: (values) => {
    db?.tableUnsafe('notes').insert(values);
  },
  onError: (err) => alert(err instanceof Error ? err.message : String(err)),
})!;
root.replaceChildren(header, form, list);

function render(): void {
  if (!db) return;
  const notes = db.table('notes').orderBy('created_at', 'desc').select();
  list.replaceChildren(
    ...notes.map((note) => {
      const item = h('li', { className: note.done ? 'done' : '' });
      item.append(h('strong', { textContent: note.title }), h('p', { textContent: note.body ?? '' }));
      item.append(renderActionButtons(ui, note, { onAction: (action, row) => void executeAction(db!, action, row, ui.primaryKey) }));
      return item;
    }),
  );
  if (!notes.length) list.append(h('li', { className: 'empty', textContent: 'No notes yet. Add one above.' }));
}

startIcebolt(controls, (next) => {
  db = next;
  db.onChange(render);
  render();
});

const style = h('style', {
  textContent: \`
  #app{max-width:640px;margin:0 auto;padding:24px 16px;text-align:left;border:0;box-sizing:border-box}
  #app h1{margin:0;font-size:32px}
  .icebolt-form button,.icebolt-actions button{font:inherit;font-size:14px;padding:6px 12px;border-radius:8px;border:1px solid #8886;background:transparent;color:inherit;cursor:pointer}
  .icebolt-submit{font-weight:600}
  .icebolt-demo-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
  .icebolt-form{display:flex;flex-direction:column;gap:8px;margin:16px 0}
  .icebolt-field{display:flex;flex-direction:column;gap:4px}
  .icebolt-field input,.icebolt-field textarea{font:inherit;padding:8px;border-radius:8px;border:1px solid #8884}
  .icebolt-submit{align-self:flex-start}
  .icebolt-demo-list{list-style:none;padding:0;display:flex;flex-direction:column;gap:8px}
  .icebolt-demo-list li{border:1px solid #8884;border-radius:10px;padding:10px 12px}
  .icebolt-demo-list li.done strong{text-decoration:line-through;opacity:.6}
  .icebolt-demo-list p{margin:4px 0;white-space:pre-wrap}
  .icebolt-actions{display:flex;gap:6px}\`,
});
document.head.append(style);
`;
}

/** True when src/main.ts is still Vite's counter starter. */
function isUntouchedViteStarter(cwd: string): boolean {
  const main = join(cwd, 'src/main.ts');
  if (!existsSync(main) || !existsSync(join(cwd, 'src/counter.ts'))) return false;
  const src = readFileSync(main, 'utf8');
  return src.includes('setupCounter') && src.includes('vite.svg');
}

export function init(opts: InitOptions, log: (line?: string) => void = () => undefined): InitResult {
  const { cwd } = opts;
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(
      'No package.json here. Run `icebolt init` inside your web app.\nStarting fresh? npm create vite@latest my-app -- --template vanilla-ts',
    );
  }
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as PackageJson;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const vite = 'vite' in deps;
  const typescript = existsSync(join(cwd, 'tsconfig.json'));
  const appName = opts.appName ?? humanizeName(pkg.name ?? '');
  const appId = slugify(pkg.name?.replace(/^@[^/]+\//, '') ?? appName) || 'icebolt-app';
  const res: InitResult = { appName, appId, created: [], updated: [], kept: [], missingDeps: [], demo: false, vite, typescript };
  const rel = (p: string): string => relative(cwd, p);

  for (const d of ['@icebolt/compiler-core', 'sql.js']) if (!(d in deps)) res.missingDeps.push(d);

  const writeNew = (path: string, content: string): void => {
    if (existsSync(path)) {
      res.kept.push(rel(path));
      return;
    }
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    res.created.push(rel(path));
  };

  // 1. schema
  writeNew(join(cwd, 'schema.dbml'), STARTER_SCHEMA);

  // 2. scripts: compile before dev and build
  const scripts = { ...(pkg.scripts ?? {}) };
  let scriptsChanged = false;
  if (scripts['icebolt:compile'] === undefined) {
    scripts['icebolt:compile'] = 'icebolt compile schema.dbml --out src/db';
    scriptsChanged = true;
  }
  for (const hook of ['predev', 'prebuild']) {
    const cur = scripts[hook];
    if (cur === undefined) {
      scripts[hook] = COMPILE;
      scriptsChanged = true;
    } else if (!cur.includes('icebolt:compile')) {
      scripts[hook] = `${COMPILE} && ${cur}`;
      scriptsChanged = true;
    }
  }
  if (scriptsChanged) {
    pkg.scripts = scripts;
    const indent = /^\s*\{\s*\n(\s+)"/.exec(raw)?.[1] ?? '  ';
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`);
    res.updated.push('package.json (icebolt:compile runs before dev and build)');
  }

  // 3. compile once so src/db exists
  const compiled = compileProject({ schemaPath: join(cwd, 'schema.dbml'), outDir: join(cwd, 'src/db') });
  for (const f of compiled.written) res.created.push(rel(f));

  // 4. wiring (+ sql.js types for TypeScript projects without @types/sql.js)
  const ext = typescript ? 'ts' : 'js';
  writeNew(join(cwd, `src/icebolt.${ext}`), wiringTemplate(appId, appName, typescript, vite));
  if (typescript && !('@types/sql.js' in deps)) writeNew(join(cwd, 'src/sqljs.d.ts'), SQLJS_TYPES);

  // 5. demo, only over an untouched Vite starter
  if ((opts.demo ?? true) && vite && typescript && isUntouchedViteStarter(cwd)) {
    writeFileSync(join(cwd, 'src/main.ts'), demoTemplate(appName, existsSync(join(cwd, 'src/style.css'))));
    res.updated.push('src/main.ts (Vite starter replaced with a notes demo)');
    res.demo = true;
  }

  // 6. keep secrets-ish local files out of git (Vite already ignores *.local)
  const gi = join(cwd, '.gitignore');
  const ignore = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!/^\*\.local$|^\.env\.local$/m.test(ignore)) {
    writeFileSync(gi, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}.env.local\n`);
    res.updated.push('.gitignore (.env.local)');
  }

  // ---- report
  log(`Icebolt added to ${appName}.`);
  for (const f of res.created) log(`  created  ${f}`);
  for (const f of res.updated) log(`  updated  ${f}`);
  for (const f of res.kept) log(`  kept     ${f} (already there)`);
  log();
  if (res.missingDeps.length) {
    log('Install what is missing:');
    log(`  npm install ${res.missingDeps.join(' ')}`);
    log();
  }
  log('Next:');
  log('  npx icebolt setup google     one-time Google registration so users can save to their Drive');
  log('  npm run dev');
  if (!res.demo) {
    log();
    log(`Use it from your code (${typescript ? 'src/icebolt.ts' : 'src/icebolt.js'}):`);
    log("  import { startIcebolt } from './icebolt';");
    log("  startIcebolt(document.querySelector('#controls'), (db) => { /* render from db */ });");
  }
  if (!vite) log('\nNot a Vite project: see the note at the top of the wiring file about serving sql-wasm.wasm.');
  return res;
}
