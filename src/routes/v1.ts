/**
 * Client-facing API routes.
 */

import { Hono } from "hono";
import type { AppConfig } from "../config";
import type { Database } from "../db/index";
import {
  activateOrder,
  ActivationError,
  deactivateOrder,
  queryLicenseStatus,
  refreshLicence,
} from "../services/activation";
import type { ProviderRegistry } from "../services/provider";
import { createRateLimiter } from "../middleware/rate_limit";
import type { ActivateRateLimiter } from "../services/rate_limit";
import { getAesKey, aesDecrypt } from "../crypto/aes";
import { parseLicenceOuter, parseLicenceInner } from "../licence/codec";

type ClientBody = {
  product_id?: string;
  license_key?: string;
  order_id?: string;
  machine_id?: string;
  fingerprint?: string;
  machine_name?: string;
  app_version?: string;
  platform?: string;
  /** Signed licence token — required for deactivate to prove device ownership. */
  licence_token?: string;
};

function readClientBody(body: ClientBody) {
  return {
    productId: body.product_id || null,
    licenseKey: body.license_key || body.order_id || "",
    fingerprint: body.machine_id || body.fingerprint || "",
    machineName: body.machine_name || null,
    appVersion: body.app_version || null,
    platform: body.platform || null,
    licenceToken: body.licence_token || null,
  };
}

function statusFor(err: ActivationError): 400 | 403 | 404 | 409 | 429 | 500 | 502 {
  return err.statusCode as 400 | 403 | 404 | 409 | 429 | 500 | 502;
}

/**
 * Decrypt the signed licence token using the server-side AES key and extract
 * the fingerprint it was issued for. Returns null when no token provided.
 *
 * This is a lightweight proof-of-possession check: only the activated device
 * holds a valid licence token containing its fingerprint. No RSA verification
 * needed — the AES key is a server-only secret.
 */
async function verifyLicenceTokenFingerprint(
  licenceToken: string | null,
  licenseKey: string
): Promise<string | null> {
  if (!licenceToken) {
    throw new ActivationError(
      "LICENCE_TOKEN_REQUIRED",
      "解绑设备需要提供当前有效的 licence_token，请升级客户端",
      400
    );
  }

  // Parse outer: IV(32) + LEN(8) + CT + SIG
  let iv: string, ciphertextHex: string;
  try {
    [iv, ciphertextHex] = parseLicenceOuter(licenceToken);
  } catch {
    throw new ActivationError(
      "LICENCE_TOKEN_INVALID",
      "licence_token 格式无效",
      400
    );
  }

  // Decrypt inner plaintext using server-side AES key.
  let inner: string;
  try {
    inner = await aesDecrypt(getAesKey(), iv, ciphertextHex);
  } catch {
    throw new ActivationError(
      "LICENCE_TOKEN_INVALID",
      "licence_token 解密失败，可能已损坏或过期",
      400
    );
  }

  // Parse inner: AUTH_LEN(8) + AUTH_JSON + FP_LEN(8) + FINGERPRINT
  let fingerprint: string;
  try {
    [, fingerprint] = parseLicenceInner(inner);
  } catch {
    throw new ActivationError(
      "LICENCE_TOKEN_INVALID",
      "licence_token 内层解析失败",
      400
    );
  }

  if (!fingerprint || fingerprint.length < 4) {
    throw new ActivationError(
      "LICENCE_TOKEN_INVALID",
      "licence_token 中的设备指纹无效",
      400
    );
  }

  return fingerprint;
}

export function createV1Router(db: Database, config: AppConfig, registry: ProviderRegistry): Hono {
  const router = new Hono();
  const rateLimiter = createRateLimiter({
    ipMax: config.activateRateLimitIpMax,
    ipWindowSeconds: config.activateRateLimitIpWindowSeconds,
    ipFailMax: config.activateRateLimitIpFailMax,
    ipFailWindowSeconds: config.activateRateLimitIpFailWindowSeconds,
    orderFailMax: config.activateRateLimitOrderFailMax,
    orderFailWindowSeconds: config.activateRateLimitOrderFailWindowSeconds,
  });

  router.use("/activate", rateLimiter);
  router.use("/refresh", rateLimiter);
  router.use("/deactivate", rateLimiter);
  router.use("/license/status", rateLimiter);

  router.post("/activate", async (c) => {
    const limiter = c.get("rateLimiter") as ActivateRateLimiter;
    const ip = c.get("clientIp") as string;

    let body: ClientBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_REQUEST", message: "请求体格式无效" }, 400);
    }

    const request = readClientBody(body);
    if (!limiter.failuresAllowed(ip, request.licenseKey || null)) {
      return c.json({ error: "RATE_LIMITED", message: "失败次数过多，请稍后再试" }, 429);
    }

    try {
      return c.json(
        await activateOrder(db, config, registry, {
          ...request,
          ipAddress: ip,
        })
      );
    } catch (err) {
      limiter.recordFailure(ip, request.licenseKey || null);
      if (err instanceof ActivationError) {
        return c.json({ error: err.error, message: err.message }, statusFor(err));
      }
      console.error("Activate error:", err);
      return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
    }
  });

  router.post("/refresh", async (c) => {
    const ip = c.get("clientIp") as string;

    let body: ClientBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_REQUEST", message: "请求体格式无效" }, 400);
    }

    const request = readClientBody(body);

    // Verify the caller holds a valid licence token for this device.
    const licenceFingerprint = await verifyLicenceTokenFingerprint(
      body.licence_token || null,
      request.licenseKey
    );
    if (licenceFingerprint && licenceFingerprint !== request.fingerprint) {
      return c.json({
        error: "FINGERPRINT_MISMATCH",
        message: "licence_token 中的设备指纹与请求不匹配",
      }, 403);
    }

    try {
      return c.json(
        await refreshLicence(db, config, {
          productId: request.productId,
          licenseKey: request.licenseKey,
          fingerprint: request.fingerprint,
          appVersion: request.appVersion,
          platform: request.platform,
          ipAddress: ip,
        })
      );
    } catch (err) {
      if (err instanceof ActivationError) {
        return c.json({ error: err.error, message: err.message }, statusFor(err));
      }
      console.error("Refresh error:", err);
      return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
    }
  });

  router.post("/deactivate", async (c) => {
    const ip = c.get("clientIp") as string;

    let body: ClientBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_REQUEST", message: "请求体格式无效" }, 400);
    }

    const request = readClientBody(body);

    // Security: verify the client holds a valid licence token issued for this fingerprint.
    // This prevents attackers who only know license_key + fingerprint from deactivating devices.
    const licenceFingerprint = await verifyLicenceTokenFingerprint(
      body.licence_token || null,
      request.licenseKey
    );

    try {
      await deactivateOrder(db, config, registry, {
        productId: request.productId,
        licenseKey: request.licenseKey,
        fingerprint: request.fingerprint,
        ipAddress: ip,
        expectedFingerprint: licenceFingerprint, // must match request fingerprint
      });
      return c.json({ status: "ok" });
    } catch (err) {
      if (err instanceof ActivationError) {
        return c.json({ error: err.error, message: err.message }, statusFor(err));
      }
      console.error("Deactivate error:", err);
      return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
    }
  });

  router.post("/license/status", async (c) => {
    const ip = c.get("clientIp") || "unknown";
    let body: ClientBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_REQUEST", message: "请求体格式无效" }, 400);
    }

    const request = readClientBody(body);
    if (!request.licenseKey) {
      return c.json({ error: "INVALID_REQUEST", message: "license_key 不能为空" }, 400);
    }
    try {
      return c.json(
        await queryLicenseStatus(db, config, {
          productId: request.productId,
          licenseKey: request.licenseKey,
          fingerprint: request.fingerprint,
        })
      );
    } catch (err) {
      if (err instanceof ActivationError) {
        return c.json({ error: err.error, message: err.message }, statusFor(err));
      }
      console.error("Status error:", err);
      return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
    }
  });

  router.get("/license/status", async (c) => {
    const body = {
      product_id: c.req.query("product_id") || undefined,
      license_key: c.req.query("license_key") || c.req.query("order_id") || "",
      machine_id: c.req.query("machine_id") || c.req.query("fingerprint") || undefined,
    };

    if (!body.license_key) {
      return c.json({ error: "INVALID_REQUEST", message: "license_key 不能为空" }, 400);
    }

    try {
      return c.json(
        await queryLicenseStatus(db, config, {
          productId: body.product_id || null,
          licenseKey: body.license_key,
          fingerprint: body.machine_id || null,
        })
      );
    } catch (err) {
      if (err instanceof ActivationError) {
        return c.json({ error: err.error, message: err.message }, statusFor(err));
      }
      console.error("Status error:", err);
      return c.json({ error: "SERVER_ERROR", message: "服务器内部错误" }, 500);
    }
  });

  return router;
}
