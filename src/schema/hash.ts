/**
 * Deterministic, synchronous 64-bit fingerprint (two independent FNV-1a
 * lanes). Used only to detect schema drift — not a security primitive.
 */
export function schemaFingerprint(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 15;
  }
  return h1.toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
