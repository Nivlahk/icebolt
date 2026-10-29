/**
 * Self-describing AES-256-GCM envelope, Web Crypto only.
 *
 *   offset  size  field
 *   0       4     magic "ICEB"
 *   4       1     format version (1)
 *   5       1     KDF id (1 = PBKDF2-HMAC-SHA256)
 *   6       4     KDF iterations (uint32, big-endian)
 *   10      16    KDF salt
 *   26      12    AES-GCM IV (fresh per encryption)
 *   38      …     ciphertext ‖ 128-bit tag
 *
 * The whole 38-byte header is bound as AES-GCM additional data, so any
 * tampering with salt, iteration count or version fails authentication.
 */

const MAGIC = new Uint8Array([0x49, 0x43, 0x45, 0x42]); // "ICEB"
const FORMAT_VERSION = 1;
const KDF_PBKDF2_SHA256 = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
export const ENVELOPE_HEADER_BYTES = 4 + 1 + 1 + 4 + SALT_BYTES + IV_BYTES;

/** OWASP 2023+ recommendation for PBKDF2-HMAC-SHA256. */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

export interface KdfParams {
  salt: Uint8Array;
  iterations: number;
}

export class IceboltDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IceboltDecryptionError';
  }
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('Web Crypto (crypto.subtle) is unavailable; Icebolt requires a secure context (HTTPS or localhost).');
  return c.subtle;
}

/** Copy into a fresh ArrayBuffer — sidesteps SharedArrayBuffer/offset views and TS BufferSource variance. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function freshKdfParams(iterations: number = DEFAULT_PBKDF2_ITERATIONS): KdfParams {
  assertIterations(iterations);
  return { salt: randomBytes(SALT_BYTES), iterations };
}

function assertIterations(n: number): void {
  if (!Number.isInteger(n) || n < MIN_ITERATIONS || n > MAX_ITERATIONS) {
    throw new IceboltDecryptionError(`PBKDF2 iteration count ${n} outside the accepted range [${MIN_ITERATIONS}, ${MAX_ITERATIONS}]`);
  }
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Caches derived, non-extractable AES keys so the (deliberately slow) PBKDF2
 * runs once per (passphrase, salt, iterations) per session.
 */
export class KeyCache {
  readonly #cache = new Map<string, Promise<CryptoKey>>();

  get(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
    const id = `${kdf.iterations}:${hex(kdf.salt)}:${passphrase}`;
    let p = this.#cache.get(id);
    if (!p) {
      p = deriveKey(passphrase, kdf);
      this.#cache.set(id, p);
      p.catch(() => this.#cache.delete(id));
    }
    return p;
  }

  clear(): void {
    this.#cache.clear();
  }
}

export async function deriveKey(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new TypeError('encryptionKey must be a non-empty string');
  assertIterations(kdf.iterations);
  if (kdf.salt.byteLength !== SALT_BYTES) throw new TypeError(`salt must be ${SALT_BYTES} bytes`);
  const s = subtle();
  const material = await s.importKey('raw', toArrayBuffer(new TextEncoder().encode(passphrase.normalize('NFC'))), 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(kdf.salt), iterations: kdf.iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function buildHeader(kdf: KdfParams, iv: Uint8Array): Uint8Array {
  const header = new Uint8Array(ENVELOPE_HEADER_BYTES);
  const view = new DataView(header.buffer);
  header.set(MAGIC, 0);
  header[4] = FORMAT_VERSION;
  header[5] = KDF_PBKDF2_SHA256;
  view.setUint32(6, kdf.iterations, false);
  header.set(kdf.salt, 10);
  header.set(iv, 10 + SALT_BYTES);
  return header;
}

export async function sealEnvelope(plaintext: Uint8Array, passphrase: string, kdf: KdfParams, cache: KeyCache): Promise<Uint8Array> {
  const key = await cache.get(passphrase, kdf);
  const iv = randomBytes(IV_BYTES);
  const header = buildHeader(kdf, iv);
  const ciphertext = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(header), tagLength: 128 }, key, toArrayBuffer(plaintext)),
  );
  const out = new Uint8Array(header.byteLength + ciphertext.byteLength);
  out.set(header, 0);
  out.set(ciphertext, header.byteLength);
  return out;
}

export async function openEnvelope(sealed: Uint8Array, passphrase: string, cache: KeyCache): Promise<{ plaintext: Uint8Array; kdf: KdfParams }> {
  if (sealed.byteLength < ENVELOPE_HEADER_BYTES + 16) throw new IceboltDecryptionError('remote file is too short to be an Icebolt envelope');
  for (let i = 0; i < MAGIC.length; i++) {
    if (sealed[i] !== MAGIC[i]) throw new IceboltDecryptionError('remote file is not an Icebolt envelope (bad magic)');
  }
  if (sealed[4] !== FORMAT_VERSION) throw new IceboltDecryptionError(`unsupported envelope version ${sealed[4]}`);
  if (sealed[5] !== KDF_PBKDF2_SHA256) throw new IceboltDecryptionError(`unsupported KDF id ${sealed[5]}`);

  const header = sealed.slice(0, ENVELOPE_HEADER_BYTES);
  const iterations = new DataView(header.buffer).getUint32(6, false);
  assertIterations(iterations);
  const kdf: KdfParams = { salt: header.slice(10, 10 + SALT_BYTES), iterations };
  const iv = header.slice(10 + SALT_BYTES, ENVELOPE_HEADER_BYTES);

  const key = await cache.get(passphrase, kdf);
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(header), tagLength: 128 },
      key,
      toArrayBuffer(sealed.subarray(ENVELOPE_HEADER_BYTES)),
    );
    return { plaintext: new Uint8Array(plain), kdf };
  } catch {
    throw new IceboltDecryptionError('decryption failed: wrong encryption key or the file was modified');
  }
}
