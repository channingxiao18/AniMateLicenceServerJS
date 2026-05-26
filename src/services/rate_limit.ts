/**
 * In-memory sliding-window rate limiters.
 * Equivalent to Python rate_limit.py.
 *
 * Uses a global Map. In Cloudflare Workers, each isolate has its own instance.
 * For strict global limits across isolates, use D1 or KV.
 */

interface SlidingWindowConfig {
  maxEvents: number;
  windowSeconds: number;
}

class SlidingWindowLimiter {
  private maxEvents: number;
  private windowSeconds: number;
  private events: Map<string, number[]>;

  constructor(config: SlidingWindowConfig) {
    this.maxEvents = config.maxEvents;
    this.windowSeconds = config.windowSeconds;
    this.events = new Map();
  }

  private prune(key: string, now: number): number[] {
    const cutoff = now - this.windowSeconds * 1000;
    const kept = (this.events.get(key) || []).filter((t) => t > cutoff);
    this.events.set(key, kept);
    return kept;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const kept = this.prune(key, now);
    if (kept.length >= this.maxEvents) {
      return false;
    }
    kept.push(now);
    this.events.set(key, kept);
    return true;
  }

  remaining(key: string): number {
    const now = Date.now();
    const kept = this.prune(key, now);
    return Math.max(0, this.maxEvents - kept.length);
  }
}

export interface ActivateRateLimiterConfig {
  ipMax: number;
  ipWindowSeconds: number;
  ipFailMax: number;
  ipFailWindowSeconds: number;
  orderFailMax: number;
  orderFailWindowSeconds: number;
}

export class ActivateRateLimiter {
  private ipRequests: SlidingWindowLimiter;
  private ipFailures: SlidingWindowLimiter;
  private orderFailures: SlidingWindowLimiter;

  constructor(config: ActivateRateLimiterConfig) {
    this.ipRequests = new SlidingWindowLimiter({
      maxEvents: config.ipMax,
      windowSeconds: config.ipWindowSeconds,
    });
    this.ipFailures = new SlidingWindowLimiter({
      maxEvents: config.ipFailMax,
      windowSeconds: config.ipFailWindowSeconds,
    });
    this.orderFailures = new SlidingWindowLimiter({
      maxEvents: config.orderFailMax,
      windowSeconds: config.orderFailWindowSeconds,
    });
  }

  checkRequest(ip: string): boolean {
    return this.ipRequests.allow(`ip:${ip}`);
  }

  recordFailure(ip: string, orderId: string | null): boolean {
    const ipOk = this.ipFailures.allow(`ipfail:${ip}`);
    let orderOk = true;
    if (orderId) {
      orderOk = this.orderFailures.allow(`orderfail:${orderId}`);
    }
    return ipOk && orderOk;
  }

  failuresAllowed(ip: string, orderId: string | null): boolean {
    if (this.ipFailures.remaining(`ipfail:${ip}`) <= 0) return false;
    if (orderId && this.orderFailures.remaining(`orderfail:${orderId}`) <= 0)
      return false;
    return true;
  }
}
