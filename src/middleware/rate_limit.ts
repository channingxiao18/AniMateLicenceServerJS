/**
 * Rate limiting middleware for Hono.
 */

import type { Context, Next } from "hono";
import { ActivateRateLimiter, type ActivateRateLimiterConfig } from "../services/rate_limit";

type RateLimitOptions = {
  errorCode?: string;
  message?: string;
};

export function createRateLimiter(
  config: ActivateRateLimiterConfig,
  options: RateLimitOptions = {}
) {
  const limiter = new ActivateRateLimiter(config);

  return async (c: Context, next: Next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";

    if (!limiter.checkRequest(ip)) {
      return c.json(
        {
          error: options.errorCode || "RATE_LIMITED",
          message: options.message || "请求过于频繁，请稍后再试",
        },
        429
      );
    }

    // Store limiter and IP in context for use in route handlers
    c.set("rateLimiter", limiter);
    c.set("clientIp", ip);

    await next();
  };
}
