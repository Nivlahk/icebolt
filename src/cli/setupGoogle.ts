/**
 * `icebolt setup google` — the developer's one-time Google registration, shrunk
 * to what Google still requires a human to click.
 *
 * Google offers no public API for creating OAuth web clients, so a few console
 * pages stay manual. Everything else is automated: project creation and Drive
 * API enablement (via gcloud when installed), a privacy policy and terms of
 * service generated for the app and linked from it (Google requires both),
 * deep links that land on the right page of the right project, every value to
 * type printed and copied to the clipboard, optional Search Console ownership
 * via an HTML file, git commit + push, and the client ID validated and written
 * into the app.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { LEGAL_MARKER, addLegalLinks, detectThirdParties, renderPrivacyPolicy, renderTerms, topPrivateDomain } from './legal.js';

export const DRIVE_FILE_SCOPE_URL = 'https://www.googleapis.com/auth/drive.file';
const CONSOLE = 'https://console.cloud.google.com';
const CLIENT_ID_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Project display names allow letters, digits, spaces, hyphens, quotes and ! (max 30). */
export function projectDisplayName(appName: string): string {
  return appName.replace(/[^A-Za-z0-9 '"!-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30) || 'Icebolt app';
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every outside effect goes through here, so the flow is testable end to end. */
export interface SetupDeps {
  /** Run a command. `interactive` hands the terminal to it (gcloud auth login). */
  exec(cmd: string, args: string[], opts?: { interactive?: boolean; cwd?: string }): ExecResult;
  /** Ask a question; empty answer returns `defaultValue`. */
  prompt(question: string, defaultValue?: string): Promise<string>;
  /** Pause until the developer presses Enter. */
  waitForEnter(message: string): Promise<void>;
  /** Open a URL in the developer's browser; false if it couldn't. */
  open(url: string): boolean;
  /** Best-effort clipboard copy; false if no clipboard tool. */
  copy(text: string): boolean;
  log(line?: string): void;
}

export interface SetupGoogleOptions {
  cwd: string;
  appName?: string;
  projectId?: string;
  origins?: string[];
  /** File to write the client ID into: an .html file with data-google-client-id, or an env file. */
  write?: string;
  /** Use gcloud for project + API when available (default true). */
  gcloud?: boolean;
  /** Skip the console steps: just validate and write this ID. */
  clientId?: string;
  /** Who runs the app (shown in the privacy policy and terms). */
  operator?: string;
  contactEmail?: string;
  /** Override "today" for the legal pages' effective date. */
  now?: Date;
}

export interface SetupGoogleResult {
  projectId: string;
  clientId: string;
  origins: string[];
  wroteTo: string;
}

// ------------------------------------------------------------------ helpers

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '');
}

export function suggestProjectId(appName: string, rand: () => number = Math.random): string {
  const suffix = String(1000 + Math.floor(rand() * 9000));
  let base = slugify(appName) || 'icebolt-app';
  base = base.slice(0, 30 - suffix.length - 1).replace(/-+$/, '');
  if (base.length < 1) base = 'app';
  return `${base}-${suffix}`;
}

export function validateOrigin(origin: string): string | null {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return `"${origin}" is not a URL`;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `"${origin}" must start with https:// or http://`;
  if (u.protocol === 'http:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return `"${origin}": Google only allows http:// for localhost`;
  if (u.pathname !== '/' || u.search || u.hash || origin.endsWith('/')) return `"${origin}": an origin has no path or trailing slash (use ${u.origin})`;
  return null;
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth < 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, depth - 1, out);
    else if (e.endsWith('.html')) out.push(p);
  }
}

/** HTML files that carry a `data-google-client-id` attribute (Icebolt's no-build integration point). */
export function findClientIdTargets(cwd: string): string[] {
  const html: string[] = [];
  walk(cwd, 4, html);
  return html.filter((p) => {
    try {
      return readFileSync(p, 'utf8').includes('data-google-client-id=');
    } catch {
      return false;
    }
  });
}

function htmlTitle(path: string): string | null {
  const m = /<title>([^<]+)<\/title>/i.exec(readFileSync(path, 'utf8'));
  if (!m) return null;
  return m[1]!.split(/\s[:|–—-]\s|:\s/)[0]!.trim() || null;
}

export function detectOrigins(cwd: string): string[] {
  const out: string[] = [];
  const cname = join(cwd, 'CNAME');
  if (existsSync(cname)) {
    const host = readFileSync(cname, 'utf8').trim().split(/\s+/)[0];
    if (host) {
      out.push(`https://${host}`);
      if (!host.startsWith('www.') && host.split('.').length === 2) out.push(`https://www.${host}`);
    }
  }
  let vite = false;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    vite = !!(pkg.dependencies?.['vite'] ?? pkg.devDependencies?.['vite']);
  } catch {
    /* no package.json */
  }
  out.push(vite ? 'http://localhost:5173' : 'http://localhost:8000');
  return out;
}

export function writeClientId(path: string, clientId: string): void {
  if (path.endsWith('.html')) {
    const html = readFileSync(path, 'utf8');
    if (!html.includes('data-google-client-id=')) throw new Error(`${path} has no data-google-client-id attribute`);
    writeFileSync(path, html.replace(/data-google-client-id="[^"]*"/g, `data-google-client-id="${clientId}"`));
    return;
  }
  const line = `VITE_GOOGLE_CLIENT_ID=${clientId}`;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = /^VITE_GOOGLE_CLIENT_ID=.*$/m.test(existing)
    ? existing.replace(/^VITE_GOOGLE_CLIENT_ID=.*$/m, line)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`;
  writeFileSync(path, next);
}

function readClientId(path: string): string | null {
  if (!existsSync(path)) return null;
  const s = readFileSync(path, 'utf8');
  const m = path.endsWith('.html') ? /data-google-client-id="([^"]+)"/.exec(s) : /^VITE_GOOGLE_CLIENT_ID=(.+)$/m.exec(s);
  return m ? m[1]!.trim() : null;
}


// --------------------------------------------------------------------- flow

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFY_FILE_RE = /^google[0-9a-f]{6,}\.html$/;

export async function setupGoogle(opts: SetupGoogleOptions, deps: SetupDeps): Promise<SetupGoogleResult> {
  const { log } = deps;
  const cwd = opts.cwd;
  const rel = (p: string): string => relative(cwd, p) || p;
  const step = (n: number, total: number, title: string): void => {
    log();
    log(`[${n}/${total}] ${title}`);
  };
  const show = (url: string): void => {
    if (deps.open(url)) log(`    Opened ${url}`);
    else log(`    Open: ${url}`);
  };
  /** Print form values; copy each to the clipboard in turn so they paste field by field. */
  const fill = async (fields: Array<[string, string]>): Promise<void> => {
    const width = Math.max(...fields.map(([k]) => k.length)) + 3;
    for (const [i, [label, value]] of fields.entries()) {
      const copied = deps.copy(value);
      log(`      ${`${label} `.padEnd(width, '.')} ${value}${copied ? '   ← copied, paste it' : ''}`);
      if (copied && i < fields.length - 1) await deps.waitForEnter('        Press Enter to copy the next one.');
    }
  };
  const offerPush = async (files: string[], message: string): Promise<boolean> => {
    if (deps.exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd }).code !== 0) {
      log(`    Upload ${files.map(rel).join(', ')} with your site before continuing.`);
      return false;
    }
    const yes = (await deps.prompt(`Commit and push ${files.map(rel).join(', ')} now? (Y/n)`, 'y')).toLowerCase().startsWith('y');
    if (!yes) {
      log('    OK. Push them yourself before Google checks them.');
      return false;
    }
    deps.exec('git', ['add', '--', ...files], { cwd });
    deps.exec('git', ['commit', '-m', message], { cwd });
    const pushed = deps.exec('git', ['push'], { cwd, interactive: true }).code === 0;
    log(pushed ? '    ✓ Pushed.' : '    git push failed; push manually before continuing.');
    return pushed;
  };

  // ---- where the ID goes, and what the app is called
  let target = opts.write ? join(cwd, opts.write) : null;
  if (!target) {
    const found = findClientIdTargets(cwd);
    if (found.length === 1) target = found[0]!;
    else if (found.length > 1) {
      log('Several pages can take a client ID:');
      found.forEach((f, i) => log(`  ${i + 1}. ${rel(f)}`));
      const pick = Number(await deps.prompt('Which one?', '1'));
      target = found[Math.min(Math.max(1, pick || 1), found.length) - 1]!;
    } else target = join(cwd, '.env.local');
  }

  const current = readClientId(target);
  if (current && !opts.clientId) {
    log(`${rel(target)} already has a client ID (${current}).`);
    const again = (await deps.prompt('Set up a new one anyway? (y/N)', 'n')).toLowerCase();
    if (!again.startsWith('y')) return { projectId: '', clientId: current, origins: [], wroteTo: target };
  }

  if (opts.clientId) {
    if (!CLIENT_ID_RE.test(opts.clientId)) throw new Error('That does not look like a web client ID (…apps.googleusercontent.com).');
    writeClientId(target, opts.clientId);
    log(`Wrote the client ID into ${rel(target)}.`);
    return { projectId: opts.projectId ?? '', clientId: opts.clientId, origins: opts.origins ?? [], wroteTo: target };
  }

  const isHtml = target.endsWith('.html');
  const appName = opts.appName ?? (isHtml ? htmlTitle(target) : null) ?? 'My Icebolt app';

  log('Google Drive setup for Icebolt');
  log(`App: ${appName}    Client ID goes into: ${rel(target)}`);
  log('Google has no API for registering the sign-in client, so a few console pages stay manual.');
  log('This command opens each one, tells you what goes in every field, and copies it for you.');

  // ---- origins
  let origins = opts.origins ?? detectOrigins(cwd);
  for (;;) {
    const answer = await deps.prompt('Sites this app runs on (comma-separated)', origins.join(', '));
    const list = answer.split(',').map((s) => s.trim()).filter(Boolean);
    const problems = list.map(validateOrigin).filter((p): p is string => p !== null);
    if (list.length && !problems.length) {
      origins = list;
      break;
    }
    problems.forEach((p) => log(`  ${p}`));
  }
  const publicOrigin = origins.find((o) => o.startsWith('https://')) ?? null;

  // ---- identities
  const useGcloud = (opts.gcloud ?? true) && deps.exec('gcloud', ['--version']).code === 0;
  let account = '';
  if (useGcloud) {
    account = deps.exec('gcloud', ['config', 'get-value', 'account']).stdout.trim();
    if (!account || account === '(unset)') {
      log('Signing gcloud in to your Google account…');
      deps.exec('gcloud', ['auth', 'login'], { interactive: true });
      account = deps.exec('gcloud', ['config', 'get-value', 'account']).stdout.trim();
    }
    if (account === '(unset)') account = '';
  }
  const gitName = deps.exec('git', ['config', 'user.name'], { cwd }).stdout.trim();
  const gitEmail = deps.exec('git', ['config', 'user.email'], { cwd }).stdout.trim();
  let operator = opts.operator ?? '';
  while (!operator) operator = (await deps.prompt('Your name or organization (shown in the privacy policy)', gitName || undefined)).trim();
  let contactEmail = opts.contactEmail ?? '';
  while (!EMAIL_RE.test(contactEmail)) {
    contactEmail = (await deps.prompt('Contact email (for users, and the Google account you will sign in with)', account || gitEmail || undefined)).trim();
    if (!EMAIL_RE.test(contactEmail)) log('  That is not an email address.');
  }

  const total = (useGcloud ? 1 : 2) + (publicOrigin ? 5 : 3);
  let n = 0;

  // ---- project + Drive API
  let projectId = opts.projectId ?? '';
  let automated = false;
  if (useGcloud) {
    step(++n, total, 'Project and Drive API (automatic)');
    for (;;) {
      projectId = (await deps.prompt('Google Cloud project ID', projectId || suggestProjectId(appName))).trim();
      if (PROJECT_ID_RE.test(projectId)) break;
      log('  6–30 characters: lowercase letters, digits, hyphens; start with a letter.');
    }
    const exists = deps.exec('gcloud', ['projects', 'describe', projectId, '--format=value(projectId)']).code === 0;
    const created = exists || deps.exec('gcloud', ['projects', 'create', projectId, `--name=${projectDisplayName(appName)}`], { interactive: true }).code === 0;
    const enabled = created && deps.exec('gcloud', ['services', 'enable', 'drive.googleapis.com', `--project=${projectId}`], { interactive: true }).code === 0;
    automated = enabled;
    if (enabled) log(`    ✓ Project ${projectId} ${exists ? 'found' : 'created'}, Google Drive API enabled.`);
    else log('    gcloud could not finish this step; doing it in the browser instead.');
  }
  if (!automated) {
    step(++n, total, 'Create a project');
    show(`${CONSOLE}/projectcreate`);
    log(`    Name it "${projectDisplayName(appName)}", click Create, then copy the project ID shown under the name.`);
    for (;;) {
      projectId = (await deps.prompt('Paste the project ID', projectId || undefined)).trim();
      if (PROJECT_ID_RE.test(projectId)) break;
      log('  That is not a project ID (6–30 lowercase letters, digits, hyphens).');
    }
    step(++n, total, 'Enable the Google Drive API');
    show(`${CONSOLE}/apis/library/drive.googleapis.com?project=${projectId}`);
    await deps.waitForEnter('    Click Enable, then press Enter here.');
  }
  const q = `?project=${encodeURIComponent(projectId)}`;

  // ---- privacy policy + terms (Google requires both for a public app)
  let legal: { home: string; privacy: string; terms: string; domain: string } | null = null;
  const siteRoot = isHtml ? cwd : existsSync(join(cwd, 'package.json')) ? join(cwd, 'public') : cwd;
  if (publicOrigin) {
    step(++n, total, 'Privacy policy and terms of service (generated)');
    const pagesDir = isHtml ? dirname(target) : siteRoot;
    mkdirSync(pagesDir, { recursive: true });
    const segs = relative(siteRoot, pagesDir).split(/[\\/]/).filter(Boolean).map(encodeURIComponent);
    const base = `${publicOrigin}/${segs.length ? `${segs.join('/')}/` : ''}`;
    const home = isHtml && basename(target) !== 'index.html' ? `${base}${basename(target)}` : base;
    legal = { home, privacy: `${base}privacy.html`, terms: `${base}terms.html`, domain: topPrivateDomain(new URL(publicOrigin).hostname) };

    const linkPage = isHtml ? target : existsSync(join(cwd, 'index.html')) ? join(cwd, 'index.html') : null;
    const ownHosts = origins.map((o) => new URL(o).hostname);
    const thirdParties = linkPage ? detectThirdParties(readFileSync(linkPage, 'utf8'), ownHosts) : [];
    const info = {
      appName,
      operator,
      contactEmail,
      homeUrl: home,
      effectiveDate: (opts.now ?? new Date()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      thirdParties,
    };
    const changed: string[] = [];
    for (const [file, html] of [
      ['privacy.html', renderPrivacyPolicy(info)],
      ['terms.html', renderTerms(info)],
    ] as const) {
      const path = join(pagesDir, file);
      if (existsSync(path) && !readFileSync(path, 'utf8').includes(LEGAL_MARKER)) {
        log(`    Kept your existing ${rel(path)}.`);
        continue;
      }
      writeFileSync(path, html);
      changed.push(path);
      log(`    ✓ Wrote ${rel(path)}  →  ${file === 'privacy.html' ? legal.privacy : legal.terms}`);
    }
    if (linkPage) {
      const before = readFileSync(linkPage, 'utf8');
      const hrefs = isHtml ? ['privacy.html', 'terms.html'] : ['/privacy.html', '/terms.html'];
      const after = addLegalLinks(before, hrefs[0]!, hrefs[1]!);
      if (after !== before) {
        writeFileSync(linkPage, after);
        changed.push(linkPage);
        log(`    ✓ Linked both from ${rel(linkPage)} (Google requires the home page to link the privacy policy).`);
      }
    } else {
      log('    Add links to /privacy.html and /terms.html on your home page; Google checks for them.');
    }
    if (thirdParties.length) log(`    Disclosed services your page loads: ${thirdParties.join('; ')}.`);
    log('    These are plain-language starting points, not legal advice. Read them before you publish.');
    if (changed.length) await offerPush(changed, `Add privacy policy and terms of service for ${appName}`);
  }

  // ---- branding
  step(++n, total, 'Sign-in screen (Google Auth Platform → Branding)');
  show(`${CONSOLE}/auth/branding${q}`);
  log('    If you see "Get started", the wizard asks: App name, User support email, Audience = External,');
  log('    Contact email, then agree and Create. Afterwards fill in the Branding page itself:');
  const brandingFields: Array<[string, string]> = [
    ['App name', appName],
    ['User support email', contactEmail],
  ];
  if (legal) {
    brandingFields.push(
      ['Application home page', legal.home],
      ['Application privacy policy link', legal.privacy],
      ['Application terms of service link', legal.terms],
      ['Authorized domains → Add domain', legal.domain],
    );
  }
  brandingFields.push(['Developer contact information', contactEmail]);
  await fill(brandingFields);
  log('      App logo: leave empty for now (it only shows after brand verification).');
  if (!legal) log('      App domain links are only needed to publish; add them once your site is public.');
  log('    Click Save at the bottom of the page.');
  await deps.waitForEnter('    Press Enter when saved.');

  // ---- scope + audience
  step(++n, total, 'Permission and who can sign in');
  show(`${CONSOLE}/auth/scopes${q}`);
  log('    Data access → Add or remove scopes → "Manually add scopes" box:');
  await fill([['Scope', DRIVE_FILE_SCOPE_URL]]);
  log('    Click "Add to table", Update, then Save.');
  await deps.waitForEnter('    Press Enter when saved.');
  show(`${CONSOLE}/auth/audience${q}`);
  log('    For a public site: click "Publish app". drive.file is a non-sensitive scope, so it skips Google\'s sensitive-scope review.');
  log(`    To keep testing privately instead: add test users (${contactEmail}).`);
  await deps.waitForEnter('    Press Enter when done.');

  // ---- client
  step(++n, total, 'Create the web client');
  show(`${CONSOLE}/auth/clients/create${q}`);
  log('      Application type: Web application');
  log('      Authorized JavaScript origins: click "Add URI" once per site.');
  await fill([['Name', `${appName} web`], ...origins.map((o, i): [string, string] => [`Origin ${i + 1}`, o])]);
  log('      Authorized redirect URIs: leave empty');
  log('    Click Create, then copy the Client ID (you do not need the secret).');

  let clientId = '';
  for (;;) {
    clientId = (await deps.prompt('Paste the Client ID')).trim();
    if (CLIENT_ID_RE.test(clientId)) break;
    log('  That is not a web client ID. It ends in .apps.googleusercontent.com.');
  }
  writeClientId(target, clientId);
  log(`    ✓ Wrote the client ID into ${rel(target)}. Drive saving is on.`);

  // ---- optional: brand verification so Google shows the app name
  if (legal && publicOrigin) {
    step(++n, total, 'Show your app name on Google\'s screen (optional)');
    log(`    Until Google verifies your brand, the sign-in screen shows "${legal.domain}" instead of "${appName}".`);
    log('    Verifying needs proof that you own the domain, done once in Google Search Console.');
    const go = (await deps.prompt('Do it now? (y/N)', 'n')).toLowerCase().startsWith('y');
    if (go) {
      show('https://search.google.com/search-console/welcome');
      log('    Sign in with the same Google account. Choose "URL prefix" and enter:');
      await fill([['URL prefix', `${publicOrigin}/`]]);
      log('    Continue, then under "Other verification methods" open "HTML file".');
      log('    Copy only the file NAME it shows (like google1a2b3c4d5e6f7a8b.html); this command creates the file.');
      let fileName = '';
      for (;;) {
        fileName = (await deps.prompt('Paste the file name (Enter to skip)', '')).trim();
        if (!fileName || VERIFY_FILE_RE.test(fileName)) break;
        log('  That is not a Search Console file name (google… .html).');
      }
      if (fileName) {
        const path = join(siteRoot, fileName);
        mkdirSync(siteRoot, { recursive: true });
        writeFileSync(path, `google-site-verification: ${fileName}`);
        log(`    ✓ Wrote ${rel(path)}`);
        await offerPush([path], 'Add Google Search Console verification file');
        await deps.waitForEnter('    When the site has updated (about a minute on GitHub Pages), click Verify in Search Console, then press Enter.');
        show(`${CONSOLE}/auth/branding${q}`);
        log('    Click "Verify branding". The automated check usually finishes in minutes; then click "Publish branding".');
        log('    If it reports the domain as unverified, add a "Domain" property in Search Console instead (a DNS record at your registrar).');
        await deps.waitForEnter('    Press Enter to finish.');
      }
    } else {
      log('    Skipped. Run this step any time from Google Auth Platform → Branding → Verify branding.');
    }
  }

  // ---- ship it
  log();
  await offerPush([target], `Switch on Google Drive sign-in for ${appName}`);
  log();
  log(`✓ Done. Visitors now see "Connect Google Drive" in ${appName}.`);
  log('  The client ID is not a secret; it belongs in your site.');
  log(`  Manage later: ${CONSOLE}/auth/clients${q}`);
  return { projectId, clientId, origins, wroteTo: target };
}
