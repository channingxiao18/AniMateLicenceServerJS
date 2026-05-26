/**
 * Extend Hono's ContextVariableMap for typed c.get()/c.set().
 */

import type { ActivateRateLimiter } from "./services/rate_limit";

declare module "hono" {
  interface ContextVariableMap {
    rateLimiter: ActivateRateLimiter;
    clientIp: string;
  }
}
