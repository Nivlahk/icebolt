#!/usr/bin/env node
/**
 * icebolt — developer CLI for nivlahkicebolt.
 *
 *   icebolt init [--app-name NAME] [--no-demo]
 *   icebolt compile SCHEMA.dbml [--out DIR] [--allow-drop TABLE[.COLUMN]]...
 *   icebolt setup google [--write FILE] [--project ID] [--origin URL]... [--app-name NAME] [--no-gcloud] [--client-id ID]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { relative } from 'node:path';
import { IceboltCompileError, formatDiagnostic } from '../types.js';
import { describeMigration } from '../schema/migrate.js';
import { compileProject } from './compileProject.js';
import { setupGoogle, type SetupDeps } from './setupGoogle.js';
import { init } from './init.js';

const HELP = `icebolt — Icebolt developer tools

Usage:
  icebolt init                     Add Icebolt to the web app in this folder: starter schema.dbml,
                                   compile hooked into dev/build, src/icebolt.ts wiring
                                   (--app-name NAME, --no-demo to keep a fresh Vite starter as is)
  icebolt compile SCHEMA.dbml [--out DIR] [--allow-drop TABLE[.COLUMN]]...
                                   Build the typed client, UI manifest and migrations; keeps
                                   icebolt.schema.lock.json (commit it) next to the schema
  icebolt setup google [options]   One-time Google registration so your app can save to users' Drives

Options for "setup google":
  --write FILE        Where to put the client ID: an .html file with data-google-client-id,
                      or an env file (default: auto-detect, else .env.local)
  --project ID        Google Cloud project ID to use or create
  --origin URL        A site the app runs on (repeatable; default: from CNAME + localhost)
  --app-name NAME     Name shown on Google's sign-in screen
  --no-gcloud         Do every step in the browser, even if gcloud is installed
  --client-id ID      Already have a client ID? Just validate and write it
  -h, --help          Show this help
`;

function isWsl(): boolean {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], input?: string): boolean {
  const r = spawnSync(cmd, args, { stdio: input === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'], input, timeout: 10_000 });
  return !r.error && r.status === 0;
}

function onPath(cmd: string): boolean {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
}

export function realDeps(): SetupDeps {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const wsl = isWsl();
  return {
    exec(cmd, args, opts) {
      const r = spawnSync(cmd, args, {
        encoding: 'utf8',
        cwd: opts?.cwd,
        stdio: opts?.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      if (r.error) return { code: 127, stdout: '', stderr: String(r.error.message) };
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    async prompt(question, defaultValue) {
      const text = defaultValue
        ? `${question}\n  Press Enter to accept: ${defaultValue}\n  (or type a different answer) > `
        : `${question}\n  > `;
      const answer = (await rl.question(text)).trim();
      return answer || defaultValue || '';
    },
    async waitForEnter(message) {
      await rl.question(`${message} `);
    },
    open(url) {
      if (wsl) {
        if (onPath('wslview') && run('wslview', [url])) return true;
        // cmd's start treats & as a separator, so let PowerShell open it.
        return run('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`]);
      }
      if (process.platform === 'darwin') return run('open', [url]);
      if (process.platform === 'win32') return run('powershell', ['-NoProfile', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`]);
      return onPath('xdg-open') && run('xdg-open', [url]);
    },
    copy(text) {
      if (wsl || process.platform === 'win32') return run('clip.exe', [], text);
      if (process.platform === 'darwin') return run('pbcopy', [], text);
      if (onPath('wl-copy')) return run('wl-copy', [], text);
      if (onPath('xclip')) return run('xclip', ['-selection', 'clipboard'], text);
      return false;
    },
    log(line = '') {
      process.stdout.write(`${line}\n`);
    },
  };
}

function parse(argv: string[]): { cmd: string[]; flags: Map<string, string[]> } {
  const cmd: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') flags.set('help', ['']);
    else if (a === '--no-gcloud' || a === '--no-demo') flags.set(a.slice(2), ['']);
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      flags.set(k, [...(flags.get(k) ?? []), v]);
    } else cmd.push(a);
  }
  return { cmd, flags };
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { cmd, flags } = parsed;
  if (flags.has('help') || cmd.length === 0) {
    process.stdout.write(HELP);
    return cmd.length === 0 && !flags.has('help') ? 1 : 0;
  }
  if (cmd[0] === 'init') {
    try {
      const opts: Parameters<typeof init>[0] = { cwd: process.cwd(), demo: !flags.has('no-demo') };
      const name = flags.get('app-name')?.[0];
      if (name) opts.appName = name;
      init(opts, (line = '') => process.stdout.write(`${line}\n`));
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (cmd[0] === 'compile') {
    const schemaPath = cmd[1];
    if (!schemaPath) {
      process.stderr.write('icebolt compile needs a .dbml file.\n');
      return 2;
    }
    try {
      const out = compileProject({ schemaPath, outDir: flags.get('out')?.[0] ?? 'src/db', allowDrop: flags.get('allow-drop') ?? [] });
      const r = out.result;
      for (const d of r.diagnostics) process.stdout.write(`warning: ${formatDiagnostic(d)}\n`);
      process.stdout.write(`Schema v${r.snapshot.version} (${r.schemaHash}), ${r.schema.tables.length} tables.\n`);
      if (r.migration) process.stdout.write(`${describeMigration(r.migration)}\nUsers' databases upgrade automatically the next time they open the app.\n`);
      else if (out.newVersion) process.stdout.write('Started schema history. Commit icebolt.schema.lock.json with your app.\n');
      for (const f of out.written) process.stdout.write(`  wrote ${relative(process.cwd(), f)}\n`);
      if (out.written.some((f) => f.endsWith('icebolt.schema.lock.json'))) process.stdout.write('Commit the lockfile: it is how future versions know how to upgrade.\n');
      return 0;
    } catch (err) {
      if (err instanceof IceboltCompileError) {
        process.stderr.write(`${err.diagnostics.filter((d) => d.severity === 'error').map((d) => `error: ${formatDiagnostic(d)}`).join('\n')}\n`);
        return 1;
      }
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (cmd[0] !== 'setup' || cmd[1] !== 'google') {
    process.stderr.write(`Unknown command "${cmd.join(' ')}".\n\n${HELP}`);
    return 2;
  }
  const one = (k: string): string | undefined => flags.get(k)?.[0];
  const write = one('write');
  if (write && !existsSync(write) && write.endsWith('.html')) {
    process.stderr.write(`${write} does not exist.\n`);
    return 2;
  }
  const deps = realDeps();
  try {
    const opts: Parameters<typeof setupGoogle>[0] = { cwd: process.cwd(), gcloud: !flags.has('no-gcloud') };
    if (write) opts.write = write;
    const project = one('project');
    if (project) opts.projectId = project;
    const origins = flags.get('origin');
    if (origins) opts.origins = origins;
    const appName = one('app-name');
    if (appName) opts.appName = appName;
    const clientId = one('client-id');
    if (clientId) opts.clientId = clientId;
    await setupGoogle(opts, deps);
    return 0;
  } catch (err) {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    process.stdin.pause();
  }
}

main().then((code) => process.exit(code));
