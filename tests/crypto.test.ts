/**
 * Crypto module tests — verify AES and RSA compatibility with Python/Rust.
 */

import { describe, it, expect } from "vitest";
import {
  aesEncrypt,
  aesDecrypt,
  pkcs7Pad,
  pkcs7Unpad,
  bytesToHex,
  hexToBytes,
  aesIvBytes,
  packAesBlob,
  unpackAesBlob,
  getAesKey,
} from "../src/crypto/aes";
import { signRsa, verifyRsaSign } from "../src/crypto/rsa";

// Sync import for Node.js crypto (test only)
import { createRequire } from "node:module";
const nodeCrypto = createRequire(import.meta.url)("node:crypto") as typeof import("node:crypto");

function generateTestKeypair() {
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs1", format: "der" },
  });

  const privPkcs1 = nodeCrypto.createPrivateKey({
    key: privateKey,
    format: "der",
    type: "pkcs1",
  });
  const privPkcs8 = privPkcs1.export({ format: "der", type: "pkcs8" }) as Buffer;

  const pubPkcs1 = nodeCrypto.createPublicKey({
    key: publicKey,
    format: "der",
    type: "pkcs1",
  });
  const pubSpki = pubPkcs1.export({ format: "der", type: "spki" }) as Buffer;

  return {
    privateKeyPkcs8Hex: privPkcs8.toString("hex"),
    publicKeySpkiHex: pubSpki.toString("hex"),
    publicKeyPkcs1Hex: (publicKey as Buffer).toString("hex"),
    privateKeyPkcs1Hex: (privateKey as Buffer).toString("hex"),
  };
}

describe("pkcs7 padding", () => {
  it("pads data to block size", () => {
    const data = new Uint8Array([1, 2, 3]);
    const padded = pkcs7Pad(data, 16);
    expect(padded.length).toBe(16);
    expect(padded[padded.length - 1]).toBe(13); // 16 - 3 = 13
  });

  it("adds full block when data is multiple of block size", () => {
    const data = new Uint8Array(16);
    const padded = pkcs7Pad(data, 16);
    expect(padded.length).toBe(32);
    expect(padded[31]).toBe(16);
  });

  it("round-trips correctly", () => {
    const original = new TextEncoder().encode("Hello, World! This is a test.");
    const padded = pkcs7Pad(original);
    const unpadded = pkcs7Unpad(padded);
    expect(unpadded).toEqual(original);
  });

  it("rejects invalid padding", () => {
    const data = new Uint8Array(16);
    data[15] = 99; // invalid pad length
    expect(() => pkcs7Unpad(data)).toThrow("invalid pkcs7 padding");
  });
});

describe("hex conversion", () => {
  it("bytesToHex produces lowercase hex", () => {
    const bytes = new Uint8Array([0xab, 0xcd, 0xef]);
    expect(bytesToHex(bytes)).toBe("abcdef");
  });

  it("hexToBytes round-trips", () => {
    const hex = "deadbeef12345678";
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });
});

describe("aesIvBytes", () => {
  it("uses first 16 ASCII bytes", () => {
    const iv = aesIvBytes("abcdefghijklmnopqrstuvwxyz123456");
    expect(iv.length).toBe(16);
    expect(new TextDecoder().decode(iv)).toBe("abcdefghijklmnop");
  });

  it("zero-pads short strings", () => {
    const iv = aesIvBytes("abc");
    expect(iv.length).toBe(16);
    expect(iv[0]).toBe(0x61); // 'a'
    expect(iv[3]).toBe(0); // zero
  });
});

describe("AES-256-CBC", () => {
  it("encrypts and decrypts round-trip", async () => {
    const key = getAesKey();
    const iv = "abcdefghijklmnopqrstuvwxyz123456";
    const plaintext = '{"product_uuid_ok":true,"product_uuid":"test"}';

    const ciphertext = await aesEncrypt(key, iv, plaintext);
    const decrypted = await aesDecrypt(key, iv, ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("produces hex output", async () => {
    const key = getAesKey();
    const ciphertext = await aesEncrypt(key, "abcdefghijklmnopqrstuvwxyz123456", "hello");
    expect(ciphertext).toMatch(/^[0-9a-f]+$/);
  });

  it("produces different output for different IVs", async () => {
    const key = getAesKey();
    const plaintext = "same plaintext";
    const ct1 = await aesEncrypt(key, "aaaaaaaaaaaaaaaa0000000000000000", plaintext);
    const ct2 = await aesEncrypt(key, "bbbbbbbbbbbbbbbb0000000000000000", plaintext);
    expect(ct1).not.toBe(ct2);
  });
});

describe("pack/unpack AES blob", () => {
  it("packs and unpacks correctly", () => {
    const iv = "a".repeat(32);
    const ct = "deadbeef";
    const packed = packAesBlob(iv, ct);
    const [iv2, ct2] = unpackAesBlob(packed);
    expect(iv2).toBe(iv);
    expect(ct2).toBe(ct);
  });

  it("validates length", () => {
    const packed = packAesBlob("a".repeat(32), "abcd");
    // Tamper with the length header
    const tampered = packed.substring(0, 33) + "00000010" + packed.substring(40);
    expect(() => unpackAesBlob(tampered)).toThrow("length mismatch");
  });
});

describe("RSA-1024 sign/verify", () => {
  it("signs and verifies hex message", async () => {
    const keys = generateTestKeypair();
    const message = "abc123deadbeef";

    const sigHex = await signRsa(message, keys.privateKeyPkcs8Hex);
    expect(sigHex).toMatch(/^[0-9a-f]+$/);
    // RSA-1024 signature is 128 bytes = 256 hex chars
    expect(sigHex.length).toBe(256);

    // Should verify successfully
    await expect(
      verifyRsaSign(message, sigHex, keys.publicKeySpkiHex)
    ).resolves.toBeUndefined();
  });

  it("fails verification with wrong message", async () => {
    const keys = generateTestKeypair();
    const sigHex = await signRsa("original message", keys.privateKeyPkcs8Hex);

    await expect(
      verifyRsaSign("tampered message", sigHex, keys.publicKeySpkiHex)
    ).rejects.toThrow();
  });

  it("fails verification with wrong key", async () => {
    const keys1 = generateTestKeypair();
    const keys2 = generateTestKeypair();
    const sigHex = await signRsa("message", keys1.privateKeyPkcs8Hex);

    await expect(
      verifyRsaSign("message", sigHex, keys2.publicKeySpkiHex)
    ).rejects.toThrow();
  });
});
