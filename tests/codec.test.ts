/**
 * License codec tests — verify issue/parse compatibility.
 */

import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import {
  issueLicence,
  parseLicenceOuter,
  parseLicenceInner,
  buildInnerPlaintext,
  randomString,
  decryptLicencePayload,
} from "../src/licence/codec";
import { createAuthInfo, authInfoToJson } from "../src/licence/auth_info";
import { aesEncrypt, aesDecrypt, getAesKey } from "../src/crypto/aes";
import { signRsa, verifyRsaSign } from "../src/crypto/rsa";

function generateTestKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs1", format: "der" },
  });

  const privPkcs1 = createPrivateKey({ key: privateKey, format: "der", type: "pkcs1" });
  const privPkcs8 = privPkcs1.export({ format: "der", type: "pkcs8" }) as Buffer;

  const pubPkcs1 = createPublicKey({ key: publicKey, format: "der", type: "pkcs1" });
  const pubSpki = pubPkcs1.export({ format: "der", type: "spki" }) as Buffer;

  return {
    privateKeyPkcs8Hex: privPkcs8.toString("hex"),
    publicKeySpkiHex: pubSpki.toString("hex"),
  };
}

describe("buildInnerPlaintext", () => {
  it("formats correctly", () => {
    const authJson = '{"version":"2"}';
    const fingerprint = "fp_test_123";
    const inner = buildInnerPlaintext(authJson, fingerprint);
    expect(inner).toBe("0000000f" + authJson + "0000000b" + fingerprint);
  });
});

describe("randomString", () => {
  it("generates correct length", () => {
    const s = randomString(32);
    expect(s.length).toBe(32);
  });

  it("only contains alphanumeric chars", () => {
    const s = randomString(100);
    expect(s).toMatch(/^[a-zA-Z0-9]+$/);
  });
});

describe("issueLicence and parse", () => {
  it("issues and decrypts a licence", async () => {
    const keys = generateTestKeypair();

    const auth = createAuthInfo({
      productId: "test-product-v1",
      edition: "companion",
      tier: "basic",
      features: ["import_vrm", "import_dance"],
      maxAppMajor: 1,
    });

    const fingerprint = "fp_" + randomString(64);
    const licence = await issueLicence(fingerprint, auth, keys.privateKeyPkcs8Hex);

    // Licence should be a non-empty string
    expect(licence.length).toBeGreaterThan(40 + 256); // IV + len + some ciphertext + signature

    // Parse outer
    const [iv, ct, sig] = parseLicenceOuter(licence);
    expect(iv.length).toBe(32);
    expect(sig.length).toBe(256);

    // Verify + decrypt
    await verifyRsaSign(ct, sig, keys.publicKeySpkiHex);

    const inner = await aesDecrypt(getAesKey(), iv, ct);
    const [authValue, fp] = parseLicenceInner(inner);

    expect(authValue.product_id).toBe("test-product-v1");
    expect(authValue.edition).toBe("companion");
    expect(authValue.tier).toBe("basic");
    expect(authValue.features).toEqual(["import_vrm", "import_dance"]);
    expect(fp).toBe(fingerprint);
  });

  it("full decrypt path works", async () => {
    const keys = generateTestKeypair();

    const auth = createAuthInfo({
      productId: "test-product-v2",
      edition: "companion",
      tier: "premium",
      features: ["feature_a", "feature_b"],
      maxAppMajor: 2,
    });

    const fingerprint = "fp_full_test_" + randomString(32);
    const licence = await issueLicence(fingerprint, auth, keys.privateKeyPkcs8Hex);

    const [authValue, fp] = await decryptLicencePayload(licence, keys.publicKeySpkiHex);

    expect(authValue.product_id).toBe("test-product-v2");
    expect(fp).toBe(fingerprint);
  });

  it("produces deterministic-length licence", async () => {
    const keys = generateTestKeypair();
    const auth = createAuthInfo({
      productId: "test",
      edition: "companion",
      tier: "basic",
      features: [],
      maxAppMajor: 1,
    });
    const fp = "a".repeat(100);
    const authJson = authInfoToJson(auth);
    const inner = buildInnerPlaintext(authJson, fp);

    // Inner length determines AES output length
    const iv = randomString(32);
    const ct = await aesEncrypt(getAesKey(), iv, inner);
    const sig = await signRsa(ct, keys.privateKeyPkcs8Hex);

    // Expected: IV(32) + LEN(8) + CT(len) + SIG(256)
    const expectedLen = 32 + 8 + ct.length + 256;
    const licence = await issueLicence(fp, auth, keys.privateKeyPkcs8Hex);
    expect(licence.length).toBe(expectedLen);
  });
});
