/**
 * Default look for the app shell. Every rule is scoped to .icebolt-* classes and
 * reads colors from --icebolt-* custom properties, so apps can restyle it.
 */
export const ICEBOLT_CSS = `
.icebolt-bar,.icebolt-dialog{--icebolt-ink:#16191f;--icebolt-ink2:#5a6371;--icebolt-panel:#fff;--icebolt-line:#d5dae1;--icebolt-ok:#14965a;--icebolt-warn:#b86f00;--icebolt-bad:#d4344b}
.icebolt-bar{display:inline-flex;gap:8px;align-items:center;position:relative;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--icebolt-ink)}
@media (prefers-color-scheme:dark){.icebolt-bar,.icebolt-dialog{--icebolt-ink:#e8ebf1;--icebolt-ink2:#9aa3b0;--icebolt-panel:#171b22;--icebolt-line:#2c333e}}
.icebolt-btn{font:inherit;border:1px solid var(--icebolt-line);background:transparent;color:inherit;border-radius:8px;padding:6px 12px;cursor:pointer}
.icebolt-btn:hover{border-color:var(--icebolt-ink2)}
.icebolt-btn--primary{background:var(--icebolt-ink);color:var(--icebolt-panel);border-color:var(--icebolt-ink);font-weight:600}
.icebolt-menu>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px}
.icebolt-menu>summary::-webkit-details-marker{display:none}
.icebolt-menu>summary::after{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-2px) rotate(45deg)}
.icebolt-menu[open]>summary::after{transform:translateY(1px) rotate(-135deg)}
.icebolt-menu>summary.icebolt-attn::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--icebolt-bad)}
.icebolt-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:1000;width:min(340px,calc(100vw - 32px));max-height:min(70vh,560px);overflow:auto;
  background:var(--icebolt-panel);border:1px solid var(--icebolt-line);border-radius:12px;padding:14px;box-shadow:0 12px 32px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:10px}
.icebolt-status{margin:0;padding:6px 9px;border-radius:8px;font-size:13px;background:color-mix(in srgb,var(--icebolt-ok) 12%,transparent)}
.icebolt-status[data-kind="busy"]{background:color-mix(in srgb,var(--icebolt-warn) 14%,transparent)}
.icebolt-status[data-kind="err"]{background:color-mix(in srgb,var(--icebolt-bad) 14%,transparent)}
.icebolt-status:empty{display:none}
.icebolt-small{margin:0;font-size:12px;color:var(--icebolt-ink2)}
.icebolt-err{color:var(--icebolt-bad);font-size:13px;margin:6px 0 0}
.icebolt-err:empty{display:none}
.icebolt-pop .icebolt-storage-settings h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--icebolt-ink2);margin:4px 0}
.icebolt-pop .icebolt-storage-settings p,.icebolt-pop .icebolt-storage-settings small,.icebolt-pop .icebolt-storage-settings dl{font-size:12px;color:var(--icebolt-ink2)}
.icebolt-pop .icebolt-storage-settings small{display:block;margin:0 0 4px 22px}
.icebolt-pop .icebolt-storage-settings fieldset{border:0;padding:0;margin:8px 0}
.icebolt-pop .icebolt-storage-settings dd{margin:0}
.icebolt-pop .icebolt-warning{color:var(--icebolt-warn)}
.icebolt-dialog{background:var(--icebolt-panel);color:var(--icebolt-ink);border:1px solid var(--icebolt-line);border-radius:14px;max-width:420px;padding:18px 20px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.icebolt-dialog::backdrop{background:rgba(0,0,0,.45)}
.icebolt-dialog h3{margin:0 0 8px;font-size:19px}
.icebolt-dialog p{margin:6px 0}
.icebolt-field{display:flex;flex-direction:column;gap:3px;font-size:12px;margin:6px 0}
.icebolt-input{font:inherit;padding:6px 9px;border-radius:8px;border:1px solid var(--icebolt-line);background:transparent;color:inherit;width:100%;box-sizing:border-box}
.icebolt-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
`;

export function injectStyles(doc: Document = document): void {
  if (doc.getElementById('icebolt-styles')) return;
  const style = doc.createElement('style');
  style.id = 'icebolt-styles';
  style.textContent = ICEBOLT_CSS;
  doc.head.prepend(style); // first, so app styles win
}
