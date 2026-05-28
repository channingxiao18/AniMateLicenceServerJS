/**
 * Application configuration from environment variables and Cloudflare Workers bindings.
 * Equivalent to Python config.py Settings.
 */

export interface AppConfig {
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  rsaPrivateKeyPkcs8Hex: string;
  defaultAppVersion: string;
  corsOrigins: string[];
  // Rate limit settings
  activateRateLimitIpMax: number;
  activateRateLimitIpWindowSeconds: number;
  activateRateLimitIpFailMax: number;
  activateRateLimitIpFailWindowSeconds: number;
  activateRateLimitOrderFailMax: number;
  activateRateLimitOrderFailWindowSeconds: number;
  // Creem
  creemApiKey: string;
  creemTestMode: boolean;
  creemDefaultProductId: string;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    adminUsername: env.ADMIN_USERNAME || "admin",
    adminPassword: env.ADMIN_PASSWORD || "change_me",
    sessionSecret: env.SESSION_SECRET || "change_me_random_secret_key_32chars",
    rsaPrivateKeyPkcs8Hex: env.RSA_PRIVATE_KEY_PKCS8_HEX || "",
    defaultAppVersion: env.DEFAULT_APP_VERSION || "0.1.0",
    corsOrigins: (env.CORS_ORIGINS || "http://localhost:1420")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    activateRateLimitIpMax: parseInt(
      env.ACTIVATE_RATE_LIMIT_IP_MAX || "30",
      10
    ),
    activateRateLimitIpWindowSeconds: parseInt(
      env.ACTIVATE_RATE_LIMIT_IP_WINDOW_SECONDS || "60",
      10
    ),
    activateRateLimitIpFailMax: parseInt(
      env.ACTIVATE_RATE_LIMIT_IP_FAIL_MAX || "15",
      10
    ),
    activateRateLimitIpFailWindowSeconds: parseInt(
      env.ACTIVATE_RATE_LIMIT_IP_FAIL_WINDOW_SECONDS || "300",
      10
    ),
    activateRateLimitOrderFailMax: parseInt(
      env.ACTIVATE_RATE_LIMIT_ORDER_FAIL_MAX || "8",
      10
    ),
    activateRateLimitOrderFailWindowSeconds: parseInt(
      env.ACTIVATE_RATE_LIMIT_ORDER_FAIL_WINDOW_SECONDS || "3600",
      10
    ),
    creemApiKey: env.CREEM_API_KEY || "",
    creemTestMode: (env.CREEM_TEST_MODE || "false").toLowerCase() === "true",
    creemDefaultProductId:
      env.CREEM_DEFAULT_PRODUCT_ID || "animate-companion-lifetime-basic-v1",
  };
}
