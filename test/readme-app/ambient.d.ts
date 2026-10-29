declare module 'sql.js' {
  const init: (cfg?: { locateFile?: (f: string) => string }) => Promise<{ Database: new (data?: Uint8Array) => import('@icebolt/compiler-core/runtime').SqlJsDatabaseLike }>;
  export default init;
}
declare module 'sql.js/dist/sql-wasm.wasm?url' { const url: string; export default url; }
interface ImportMeta { readonly env: { readonly VITE_GOOGLE_CLIENT_ID: string } }
