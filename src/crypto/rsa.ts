/**
 * RSA-3072 PKCS#1 v1.5 SHA-256 signing — compatible with AniMate Rust licensing.
 *
 * Uses Web Crypto API (SubtleCrypto).
 * Key format: PKCS#8 DER (private) / SPKI DER (public), hex-encoded.
 * The signature covers the ASCII bytes of the ciphertext hex string (NOT raw bytes).
 */

import { hexToBytes, bytesToHex, toArrayBuffer } from "./aes";

let cachedPrivateKey: CryptoKey | null = null;
let cachedPrivateKeyHex: string | null = null;

/**
 * Import an RSA private key from PKCS#8 DER (hex-encoded).
 * Cloudflare Workers supports "pkcs8" format for private keys.
 */
export async function importPrivateKey(
  pkcs8Hex: string
): Promise<CryptoKey> {
  if (cachedPrivateKey && cachedPrivateKeyHex === pkcs8Hex) {
    return cachedPrivateKey;
  }
  const der = hexToBytes(pkcs8Hex.trim());
  cachedPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  cachedPrivateKeyHex = pkcs8Hex;
  return cachedPrivateKey;
}

let cachedPublicKey: CryptoKey | null = null;
let cachedPublicKeyHex: string | null = null;

/**
 * Import an RSA public key from SPKI DER (hex-encoded).
 */
export async function importPublicKey(spkiHex: string): Promise<CryptoKey> {
  if (cachedPublicKey && cachedPublicKeyHex === spkiHex) {
    return cachedPublicKey;
  }
  const der = hexToBytes(spkiHex.trim());
  cachedPublicKey = await crypto.subtle.importKey(
    "spki",
    toArrayBuffer(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  cachedPublicKeyHex = spkiHex;
  return cachedPublicKey;
}

/**
 * Sign the ciphertext hex string with RSA.
 * CRITICAL: signature covers ASCII bytes of ciphertextHex, not raw ciphertext.
 * This matches LicenceSdk behaviour and the Python/Rust implementations.
 */
export async function signRsa(
  ciphertextHex: string,
  privateKeyPkcs8Hex: string
): Promise<string> {
  const key = await importPrivateKey(privateKeyPkcs8Hex);
  const messageBytes = new TextEncoder().encode(ciphertextHex);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    toArrayBuffer(messageBytes)
  );
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Verify RSA signature over the ciphertext hex string.
 */
export async function verifyRsaSign(
  ciphertextHex: string,
  signatureHex: string,
  publicKeySpkiHex: string
): Promise<void> {
  const key = await importPublicKey(publicKeySpkiHex);
  const signatureBytes = hexToBytes(signatureHex);
  const messageBytes = new TextEncoder().encode(ciphertextHex);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    toArrayBuffer(signatureBytes),
    toArrayBuffer(messageBytes)
  );
  if (!valid) {
    throw new Error("rsa verify: signature verification failed");
  }
}
