/**
 * Default privacy policy and terms of service for an Icebolt app, written to
 * match what an Icebolt app actually does: no server receives user data, the
 * app only reaches files it created in the user's own Drive, encryption is the
 * user's choice. Third-party hosts the page loads (fonts, CDNs) are detected
 * from the page itself and disclosed.
 *
 * They are starting points written in plain language, not legal advice.
 */

export interface LegalInfo {
  appName: string;
  operator: string;
  contactEmail: string;
  homeUrl: string;
  /** e.g. "October 28, 2026" */
  effectiveDate: string;
  /** Friendly names of third-party services the page loads, e.g. "Google Fonts". */
  thirdParties: string[];
}

export const LEGAL_MARKER = '<!-- icebolt:generated-legal-page -->';
export const LINKS_MARKER = '<!-- icebolt:legal-links -->';

const KNOWN_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)fonts\.(googleapis|gstatic)\.com$/, 'Google Fonts (fonts.googleapis.com, fonts.gstatic.com)'],
  [/^cdn\.jsdelivr\.net$/, 'jsDelivr (cdn.jsdelivr.net)'],
  [/^unpkg\.com$/, 'unpkg (unpkg.com)'],
  [/^cdnjs\.cloudflare\.com$/, 'cdnjs (cdnjs.cloudflare.com)'],
  [/^code\.jquery\.com$/, 'jQuery CDN (code.jquery.com)'],
  [/^cdn\.tailwindcss\.com$/, 'Tailwind CDN (cdn.tailwindcss.com)'],
  [/(^|\.)googletagmanager\.com$|(^|\.)google-analytics\.com$/, 'Google Analytics'],
  [/(^|\.)plausible\.io$/, 'Plausible Analytics'],
  [/(^|\.)cloudflareinsights\.com$/, 'Cloudflare Web Analytics'],
];

/**
 * Hosts the page actually loads resources from (scripts, styles, fonts),
 * as opposed to sites it merely links to.
 */
export function detectThirdParties(html: string, ownHosts: string[]): string[] {
  const hosts = new Set<string>();
  const add = (url: string): void => {
    try {
      const h = new URL(url).hostname;
      if (!ownHosts.some((o) => h === o || h.endsWith(`.${o}`))) hosts.add(h);
    } catch {
      /* not a URL */
    }
  };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["'](https:\/\/[^"']+)["']/gi)) add(m[1]!);
  for (const m of html.matchAll(/<link\b[^>]*\bhref=["'](https:\/\/[^"']+)["'][^>]*>/gi)) {
    if (/rel=["'][^"']*(stylesheet|preconnect|preload|modulepreload|dns-prefetch)/i.test(m[0])) add(m[1]!);
  }
  for (const m of html.matchAll(/<(?:img|iframe|source|video|audio)\b[^>]*\bsrc=["'](https:\/\/[^"']+)["']/gi)) add(m[1]!);
  // Script URLs assembled in code, e.g. const NLP_SRC = 'https://cdn.jsdelivr.net/npm/…/x.js'
  for (const m of html.matchAll(/["'`](https:\/\/[^"'`\s]+?\.(?:m?js|css|wasm|woff2?))(?:\?[^"'`\s]*)?["'`]/gi)) add(m[1]!);
  for (const m of html.matchAll(/["'`](https:\/\/[^"'`\s]+\/npm\/[^"'`\s]+)["'`]/gi)) add(m[1]!);

  const names = new Set<string>();
  for (const h of [...hosts].sort()) {
    if (h === 'accounts.google.com' || h.endsWith('googleapis.com') && !h.startsWith('fonts.')) continue; // covered as Google sign-in/Drive
    const known = KNOWN_HOSTS.find(([re]) => re.test(h));
    names.add(known ? known[1] : h);
  }
  return [...names];
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function page(title: string, info: LegalInfo, body: string): string {
  return `<!doctype html>
${LEGAL_MARKER}
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="icebolt setup google">
<title>${esc(title)} · ${esc(info.appName)}</title>
<meta name="description" content="${esc(title)} for ${esc(info.appName)}.">
<style>
:root{color-scheme:light dark;--bg:#fbfbfc;--ink:#16191f;--ink2:#555e6c;--line:#d9dde3;--accent:#1f5fd1}
@media (prefers-color-scheme:dark){:root{--bg:#101318;--ink:#e7eaef;--ink2:#9aa3b0;--line:#2a313b;--accent:#7aa7ff}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:40px 20px 64px}
h1{font-size:2rem;line-height:1.2;margin:0 0 4px}
h2{font-size:1.15rem;margin:2rem 0 .4rem}
p,li{color:var(--ink)}
.meta{color:var(--ink2);margin:0 0 1.5rem}
.summary{border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:1rem 0 1.5rem}
a{color:var(--accent)}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--ink2);font-size:.9rem}
</style>
</head>
<body>
<main>
<p><a href="${esc(info.homeUrl)}">← ${esc(info.appName)}</a></p>
<h1>${esc(title)}</h1>
<p class="meta">${esc(info.appName)} · Effective ${esc(info.effectiveDate)}</p>
${body}
<footer>Questions: <a href="mailto:${esc(info.contactEmail)}">${esc(info.contactEmail)}</a></footer>
</main>
</body>
</html>
`;
}

export function renderPrivacyPolicy(info: LegalInfo): string {
  const app = esc(info.appName);
  const op = esc(info.operator);
  const thirdParty = info.thirdParties.length
    ? `<p>To display the app, this page also loads files from: ${info.thirdParties.map(esc).join('; ')}. Like any website, those services receive your IP address and basic browser information when the files are requested. ${app} sends them none of your app data.</p>`
    : '';
  return page(
    'Privacy Policy',
    info,
    `<div class="summary"><strong>In short:</strong> ${app} has no server that receives your data. What you save goes to a file in your own Google Drive, and ${op} cannot see it.</div>

<h2>Who runs ${app}</h2>
<p>${app} is made and operated by ${op} (“we”). You can reach us at <a href="mailto:${esc(info.contactEmail)}">${esc(info.contactEmail)}</a>.</p>

<h2>What ${app} accesses in your Google account</h2>
<p>If you choose to connect Google Drive, ${app} asks Google for one permission: <em>see, edit, create and delete only the specific Google Drive files you use with this app</em> (the <code>drive.file</code> scope). With it, ${app} can only reach files that it created in your Drive. It cannot see, list or open any of your other files.</p>
<p>${app} does not request your name, email address, contacts or profile. Google gives the app a temporary access token, which is kept only in your browser tab's memory and is gone when you close the tab.</p>

<h2>How your data is used</h2>
<ul>
<li>Your work is saved as a database file in your own Google Drive, so you can reopen it later or on another device.</li>
<li>All reading, writing and processing happens inside your browser. Requests go directly from your browser to Google.</li>
<li>If you turn on “Readable copies,” ${app} also keeps plain JSON copies of your data in a folder in your Drive, so you can analyze it with tools of your choice. You can turn this off at any time; the copies are then moved to your Drive trash.</li>
</ul>

<h2>Encryption</h2>
<p>You can choose to encrypt your database with a passphrase. Encryption happens in your browser (AES-256-GCM, with the key derived from your passphrase). Your passphrase never leaves your device and is not stored by ${app}. Neither Google nor we can read an encrypted file, and nobody can recover it if the passphrase is lost. If you choose a plain file instead, it is stored like any other file in your Drive.</p>

<h2>What we receive and share</h2>
<p>We do not receive, store, sell or share your Google user data or anything you create in ${app}. There are no ads and no tracking cookies. ${app} does not transfer Google user data to anyone, and does not use it for advertising or to train AI models.</p>
<p>The website is served by a web host, which, like any web server, may record standard request logs such as IP addresses and the pages requested.</p>
${thirdParty}
<p>${app}'s use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including its Limited Use requirements.</p>

<h2>Storage and deletion</h2>
<p>Your data stays in your Google Drive for as long as you keep it there. To delete it, delete the file (and the readable-copies folder, if you made one) from your Drive. To remove ${app}'s access entirely, visit <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Your browser may keep app settings in its local storage, which you can clear in your browser settings.</p>

<h2>Children</h2>
<p>${app} is not directed at children under 13, and we do not knowingly collect information from them. Because we receive no user data, we hold none to delete.</p>

<h2>Changes</h2>
<p>If this policy changes, we will update it on this page and change the effective date above.</p>`,
  );
}

export function renderTerms(info: LegalInfo): string {
  const app = esc(info.appName);
  const op = esc(info.operator);
  return page(
    'Terms of Service',
    info,
    `<p>These terms apply when you use ${app}, operated by ${op}. By using ${app}, you agree to them.</p>

<h2>The service</h2>
<p>${app} is a free tool that runs in your web browser. We may change, suspend or discontinue it at any time.</p>

<h2>Your content</h2>
<p>What you create in ${app} belongs to you. If you connect Google Drive, it is saved to your own Drive account; we never receive a copy and claim no rights to it.</p>

<h2>Your responsibilities</h2>
<ul>
<li>Keep your Google account secure. Your use of Google Drive is governed by Google's own terms.</li>
<li>If you encrypt your data, keep your passphrase safe. It cannot be recovered, and without it your encrypted data cannot be opened by anyone.</li>
<li>Keep your own backups of anything important.</li>
<li>Do not use ${app} to break the law, to harm others, or to interfere with the service or the systems it relies on.</li>
</ul>

<h2>No warranty</h2>
<p>${app} is provided “as is” and “as available,” without warranties of any kind, express or implied, including fitness for a particular purpose and non-infringement. We do not promise that it will be error-free or always available, or that data will never be lost.</p>

<h2>Limitation of liability</h2>
<p>To the fullest extent permitted by law, ${op} is not liable for any indirect, incidental, special, consequential or punitive damages, or for any loss of data, arising from your use of ${app}.</p>

<h2>Changes</h2>
<p>We may update these terms. The current version is always on this page, with its effective date above. Continuing to use ${app} after a change means you accept the updated terms.</p>

<h2>Privacy</h2>
<p>See the <a href="privacy.html">Privacy Policy</a> for how ${app} handles data.</p>`,
  );
}

/** Add footer links to the app page (Google requires the home page to link the privacy policy). Idempotent. */
export function addLegalLinks(html: string, privacyHref: string, termsHref: string): string {
  if (html.includes(LINKS_MARKER)) return html;
  const footer =
    `${LINKS_MARKER}\n<footer class="icebolt-legal" style="width:100%;margin:14px auto 0;text-align:center;font-size:12px;opacity:.75">` +
    `<a href="${esc(privacyHref)}" style="color:inherit">Privacy policy</a> · <a href="${esc(termsHref)}" style="color:inherit">Terms of service</a></footer>\n`;
  const i = html.lastIndexOf('</body>');
  return i < 0 ? html + footer : html.slice(0, i) + footer + html.slice(i);
}

/** Registrable domain for Google's "Authorized domains" (handles common two-part suffixes). */
export function topPrivateDomain(host: string): string {
  const parts = host.split('.');
  const twoPart = /^(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoPart ? -3 : -2).join('.');
}
