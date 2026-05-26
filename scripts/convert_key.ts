/**
 * Key format conversion: PKCS#1 DER (hex) → PKCS#8 (private) / SPKI (public).
 *
 * The current Python server stores RSA keys as hex-encoded PKCS#1 DER.
 * Web Crypto API requires PKCS#8 for private keys and SPKI for public keys.
 *
 * Run with: npx tsx scripts/convert_key.ts
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function hexToBuf(hex: string): Buffer {
  return Buffer.from(hex.trim(), "hex");
}

function bufToHex(buf: Buffer): string {
  return buf.toString("hex");
}

function convertPrivateKey(pkcs1Hex: string): string {
  const pkcs1Der = hexToBuf(pkcs1Hex);
  const privateKey = createPrivateKey({
    key: pkcs1Der,
    format: "der",
    type: "pkcs1",
  });
  const pkcs8Der = privateKey.export({ format: "der", type: "pkcs8" });
  return bufToHex(pkcs8Der as Buffer);
}

function convertPublicKey(pkcs1Hex: string): string {
  const pkcs1Der = hexToBuf(pkcs1Hex);
  const publicKey = createPublicKey({
    key: pkcs1Der,
    format: "der",
    type: "pkcs1",
  });
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  return bufToHex(spkiDer as Buffer);
}

// Paths relative to project root
const KEYS_DIR = join(import.meta.dirname, "..", "keys");
const PRIVATE_KEY_PATH = join(KEYS_DIR, "private.hex");
const PUBLIC_KEY_PATH = join(KEYS_DIR, "public.hex");

// Key source: can be local keys/ files or the hardcoded public key from the client
const CLIENT_PUBLIC_KEY_HEX =
  "30818902818100b24324286867fb1b7e3b8aaa1cb2c2ca34a76c58f8a13e705d81a69671e90697e6ef308db513fd6ac7a6bc9a4a44f6352ad606d990e4352001f77e2ace3f3376e0abab865975955c1f500137d09f8427a309971cd007c18e446252c3c3e9ea67de1089ae28675a3ecf280cb9e3c7cf0a66c72920e97723ed0948139be9f770430203010001";

function main() {
  console.log("=== RSA Key Format Converter ===\n");
  console.log(
    "Converts PKCS#1 DER (hex) → PKCS#8 DER (private) / SPKI DER (public)\n"
  );

  // Convert public key from client
  console.log("--- Public Key (from AniMate client keys.rs) ---");
  try {
    const spkiHex = convertPublicKey(CLIENT_PUBLIC_KEY_HEX);
    console.log(`SPKI DER (hex): ${spkiHex}`);
    console.log(`Length: ${spkiHex.length} chars\n`);
  } catch (err) {
    console.error("Failed to convert public key:", err);
  }

  // Convert private key if available
  console.log("--- Private Key ---");
  if (existsSync(PRIVATE_KEY_PATH)) {
    try {
      const pkcs1Hex = readFileSync(PRIVATE_KEY_PATH, "utf-8");
      const pkcs8Hex = convertPrivateKey(pkcs1Hex);
      console.log(`PKCS#8 DER (hex): ${pkcs8Hex}`);
      console.log(`Length: ${pkcs8Hex.length} chars`);
      console.log("\nStore this as RSA_PRIVATE_KEY_PKCS8_HEX secret in Cloudflare Workers.");
    } catch (err) {
      console.error("Failed to convert private key:", err);
    }
  } else {
    console.log(
      `Private key file not found at ${PRIVATE_KEY_PATH}`
    );
    console.log("Place the private.hex file in the keys/ directory.");
    console.log("Or run: python ../AniMateLicenceServer/scripts/gen_rsa_keypair.py");
  }

  // Also convert public key from keys/ if available
  if (existsSync(PUBLIC_KEY_PATH)) {
    try {
      const pubHex = readFileSync(PUBLIC_KEY_PATH, "utf-8");
      const spkiHex = convertPublicKey(pubHex);
      console.log(`\n--- Public Key (from keys/public.hex) ---`);
      console.log(`SPKI DER (hex): ${spkiHex}`);
    } catch (err) {
      console.error("Failed to convert keys/public.hex:", err);
    }
  }
}

main();
