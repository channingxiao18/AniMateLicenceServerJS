/**
 * AES-256-CBC with PKCS#7 padding — compatible with AniMate Rust licensing.
 *
 * Uses Web Crypto API (SubtleCrypto) available in Cloudflare Workers.
 * Web Crypto automatically handles PKCS#7 padding for AES-CBC,
 * so we do NOT manually pad — the output matches Python/Rust exactly.
 */

const AES_KEY_BYTES: Uint8Array = new TextEncoder().encode(
  "EF4A77236A60236EA8B20C1D45F4472A"
);

export function getAesKey(): Uint8Array {
  return AES_KEY_BYTES;
}

/** Derive 16-byte AES IV from a string: first 16 ASCII bytes, zero-padded. */
export function aesIvBytes(ivStr: string): Uint8Array {
  const raw = new TextEncoder().encode(ivStr);
  const iv = new Uint8Array(16);
  const n = Math.min(raw.length, 16);
  iv.set(raw.subarray(0, n));
  return iv;
}

/** PKCS#7 pad to blockSize (default 16). */
export function pkcs7Pad(data: Uint8Array, blockSize = 16): Uint8Array {
  const padLen = blockSize - (data.length % blockSize);
  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  padded.fill(padLen, data.length);
  return padded;
}

/** PKCS#7 unpad. Throws on invalid padding. */
export function pkcs7Unpad(data: Uint8Array, blockSize = 16): Uint8Array {
  if (data.length === 0 || data.length % blockSize !== 0) {
    throw new Error("invalid pkcs7 block size");
  }
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > blockSize) {
    throw new Error("invalid pkcs7 padding");
  }
  for (let i = data.length - padLen; i < data.length; i++) {
    if (data[i] !== padLen) {
      throw new Error("invalid pkcs7 padding bytes");
    }
  }
  return data.subarray(0, data.length - padLen);
}

/** Convert Uint8Array to lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convert lowercase hex string to Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes);
  return copy.buffer;
}

let cachedAesKey: CryptoKey | null = null;

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (!cachedAesKey) {
    cachedAesKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(keyBytes),
      { name: "AES-CBC" },
      false,
      ["encrypt", "decrypt"]
    );
  }
  return cachedAesKey;
}

/**
 * AES-256-CBC encrypt. Returns lowercase hex ciphertext.
 * Compatible with Python crypto.aes_encrypt and Rust crypto::aes_encrypt.
 */
export async function aesEncrypt(
  key: Uint8Array,
  ivStr: string,
  plaintext: string
): Promise<string> {
  const iv = aesIvBytes(ivStr);
  const aesKey = await importAesKey(key);
  const plainBytes = new TextEncoder().encode(plaintext);
  // Web Crypto auto-applies PKCS#7 padding — do NOT manually pad
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(plainBytes)
  );
  return bytesToHex(new Uint8Array(ciphertext));
}

/**
 * AES-256-CBC decrypt.
 * Compatible with Python crypto.aes_decrypt and Rust crypto::aes_decrypt.
 */
export async function aesDecrypt(
  key: Uint8Array,
  ivStr: string,
  ciphertextHex: string
): Promise<string> {
  const iv = aesIvBytes(ivStr);
  const aesKey = await importAesKey(key);
  const cipherBytes = hexToBytes(ciphertextHex);
  // Web Crypto auto-strips PKCS#7 padding — do NOT manually unpad
  const plainBytes = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(cipherBytes)
  );
  return new TextDecoder().decode(plainBytes);
}

export const IV_PREFIX_LEN = 32;
export const LENGTH_HEX_LEN = 8;

/** Pack IV + length + ciphertext into a blob. */
export function packAesBlob(iv: string, ciphertextHex: string): string {
  const lenHex = ciphertextHex.length.toString(16).padStart(8, "0");
  return `${iv}${lenHex}${ciphertextHex}`;
}

/** Unpack a blob into (iv, ciphertextHex). */
export function unpackAesBlob(blob: string): [string, string] {
  if (blob.length < IV_PREFIX_LEN + LENGTH_HEX_LEN) {
    throw new Error("blob too short");
  }
  const iv = blob.substring(0, IV_PREFIX_LEN);
  const lenHex = blob.substring(
    IV_PREFIX_LEN,
    IV_PREFIX_LEN + LENGTH_HEX_LEN
  );
  const expectedLen = parseInt(lenHex, 16);
  const dataHex = blob.substring(IV_PREFIX_LEN + LENGTH_HEX_LEN);
  if (dataHex.length !== expectedLen) {
    throw new Error(
      `length mismatch: header ${expectedLen}, actual ${dataHex.length}`
    );
  }
  return [iv, dataHex];
}
