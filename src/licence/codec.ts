/**
 * Licence issue/parse — compatible with Python licence_codec.py and Rust licensing/licence.rs.
 *
 * Licence string format (no separators):
 *   IV(32 hex) + LEN(8 hex) + CIPHERTEXT_HEX(LEN chars) + SIGNATURE_HEX(256 chars)
 *
 * Inner plaintext format:
 *   AUTH_LEN(8 hex) + AUTH_JSON + FP_LEN(8 hex) + FINGERPRINT_BLOB
 */

import {
  getAesKey,
  aesEncrypt,
  aesDecrypt,
  packAesBlob,
  unpackAesBlob,
} from "../crypto/aes";
import { signRsa, verifyRsaSign } from "../crypto/rsa";
import type { AuthInfoV2 } from "./auth_info";
import { authInfoToJson, authInfoFromJson } from "./auth_info";

const RANDOM_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Generate a random alphanumeric string of given length using Web Crypto. */
export function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += RANDOM_ALPHABET[bytes[i] % RANDOM_ALPHABET.length];
  }
  return result;
}

/** Build the inner plaintext that gets AES-encrypted. */
export function buildInnerPlaintext(
  authJson: string,
  fingerprint: string
): string {
  return `${authJson.length.toString(16).padStart(8, "0")}${authJson}${fingerprint.length.toString(16).padStart(8, "0")}${fingerprint}`;
}

/**
 * Issue a licence string from a fingerprint and auth info.
 * This is the server-side function that produces the full licence token.
 */
export async function issueLicence(
  fingerprint: string,
  auth: AuthInfoV2,
  privateKeyPkcs8Hex: string
): Promise<string> {
  const authJson = authInfoToJson(auth);
  const inner = buildInnerPlaintext(authJson, fingerprint);
  const iv = randomString(32);
  const ciphertextHex = await aesEncrypt(getAesKey(), iv, inner);
  const signatureHex = await signRsa(ciphertextHex, privateKeyPkcs8Hex);
  return `${packAesBlob(iv, ciphertextHex)}${signatureHex}`;
}

/** Parse outer licence structure into (iv, ciphertextHex, signatureHex). */
export function parseLicenceOuter(
  licence: string
): [string, string, string] {
  if (licence.length < 40) {
    throw new Error("licence too short");
  }
  const iv = licence.substring(0, 32);
  const lenHex = licence.substring(32, 40);
  const expectedLen = parseInt(lenHex, 16);
  const rest = licence.substring(40);
  if (rest.length <= expectedLen) {
    throw new Error("missing signature");
  }
  const ciphertextHex = rest.substring(0, expectedLen);
  const signatureHex = rest.substring(expectedLen);
  if (!signatureHex) {
    throw new Error("empty signature");
  }
  return [iv, ciphertextHex, signatureHex];
}

/** Parse inner plaintext into (authJson, fingerprint). */
export function parseLicenceInner(
  inner: string
): [Record<string, unknown>, string] {
  if (inner.length < 16) {
    throw new Error("inner too short");
  }
  const authLen = parseInt(inner.substring(0, 8), 16);
  if (inner.length < 8 + authLen + 8) {
    throw new Error("inner truncated");
  }
  const authJson = inner.substring(8, 8 + authLen);
  const fpLenStart = 8 + authLen;
  const fpLen = parseInt(inner.substring(fpLenStart, fpLenStart + 8), 16);
  const fpStart = fpLenStart + 8;
  if (inner.length < fpStart + fpLen) {
    throw new Error("fingerprint truncated");
  }
  const fingerprint = inner.substring(fpStart, fpStart + fpLen);
  const authValue = JSON.parse(authJson) as Record<string, unknown>;
  return [authValue, fingerprint];
}

/**
 * Full decrypt + verify of a licence string.
 * Returns (authInfo, fingerprint).
 */
export async function decryptLicencePayload(
  licence: string,
  publicKeySpkiHex: string
): Promise<[Record<string, unknown>, string]> {
  const [iv, ciphertextHex, signatureHex] = parseLicenceOuter(licence);
  await verifyRsaSign(ciphertextHex, signatureHex, publicKeySpkiHex);
  const inner = await aesDecrypt(getAesKey(), iv, ciphertextHex);
  return parseLicenceInner(inner);
}

/** Decrypt a fingerprint blob (pack_aes_blob format, no signature). */
export async function decryptFingerprintBlob(
  fingerprint: string
): Promise<Record<string, unknown>> {
  const [iv, ciphertextHex] = unpackAesBlob(fingerprint);
  const jsonStr = await aesDecrypt(getAesKey(), iv, ciphertextHex);
  return JSON.parse(jsonStr) as Record<string, unknown>;
}

/** Parse app major version from version string (e.g. "1.2.3" → 1). */
export function parseAppMajor(appVersion: string | null | undefined): number | null {
  if (!appVersion) return null;
  const parts = appVersion.trim().split(".");
  if (!parts.length || !parts[0] || !/^\d+$/.test(parts[0])) return null;
  return parseInt(parts[0], 10);
}
