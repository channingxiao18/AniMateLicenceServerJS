/**
 * Cross-compatibility verification: JS issues, Python decrypts.
 * Run with: npx tsx tests/compat_issue.ts
 */

import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { issueLicence } from "../src/licence/codec";
import { createAuthInfo } from "../src/licence/auth_info";

const privateKeyPkcs1Hex = readFileSync("keys/private.hex", "utf-8").trim();
const privateKeyPkcs1Der = Buffer.from(privateKeyPkcs1Hex, "hex");
const privKey = createPrivateKey({
  key: privateKeyPkcs1Der,
  format: "der",
  type: "pkcs1",
});
const privateKeyPkcs8Hex = (
  privKey.export({ format: "der", type: "pkcs8" }) as Buffer
).toString("hex");

async function main() {
  const auth = createAuthInfo({
    productId: "animate-companion-lifetime-basic-v1",
    edition: "companion",
    tier: "basic",
    features: ["import_vrm", "import_dance", "import_stage"],
    maxAppMajor: 1,
  });

  const licence = await issueLicence("FP_JS_ISSUED_TEST", auth, privateKeyPkcs8Hex);
  console.log(licence);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
