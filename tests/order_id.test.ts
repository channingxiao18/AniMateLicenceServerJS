/**
 * Order ID tests — verify generation and validation.
 */

import { describe, it, expect } from "vitest";
import {
  generateOrderId,
  validateOrderId,
  OrderIdValidationError,
} from "../src/licence/order_id";

describe("generateOrderId", () => {
  it("generates valid format", () => {
    const id = generateOrderId();
    expect(id).toMatch(/^AM-[0-9A-Z]{12}$/);
  });

  it("passes validation", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateOrderId();
      expect(() => validateOrderId(id)).not.toThrow();
    }
  });

  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateOrderId());
    }
    expect(ids.size).toBe(1000);
  });
});

describe("validateOrderId", () => {
  it("accepts valid order ID", () => {
    const id = generateOrderId();
    expect(validateOrderId(id)).toBe(id);
  });

  it("normalizes to uppercase", () => {
    const id = generateOrderId();
    const lower = id.toLowerCase();
    const normalized = validateOrderId(lower);
    expect(normalized).toBe(id);
  });

  it("rejects empty string", () => {
    expect(() => validateOrderId("")).toThrow(OrderIdValidationError);
    try {
      validateOrderId("");
    } catch (e) {
      expect((e as OrderIdValidationError).code).toBe("INVALID_ORDER_FORMAT");
    }
  });

  it("rejects wrong prefix", () => {
    expect(() => validateOrderId("XX-123456789012")).toThrow(
      OrderIdValidationError
    );
  });

  it("rejects wrong length", () => {
    expect(() => validateOrderId("AM-12345678901")).toThrow(
      OrderIdValidationError
    );
  });

  it("rejects invalid characters", () => {
    expect(() => validateOrderId("AM-1234567890!!")).toThrow(
      OrderIdValidationError
    );
  });

  it("rejects wrong checksum", () => {
    // Take valid ID and change the check character
    const id = generateOrderId();
    const prefix = id.substring(0, id.length - 1);
    const lastChar = id[id.length - 1];
    // Find a different character
    const wrongChar = lastChar === "A" ? "B" : "A";
    const tampered = prefix + wrongChar;

    expect(() => validateOrderId(tampered)).toThrow(OrderIdValidationError);
    try {
      validateOrderId(tampered);
    } catch (e) {
      expect((e as OrderIdValidationError).code).toBe("INVALID_ORDER_CHECKSUM");
    }
  });

  it("trims whitespace", () => {
    const id = generateOrderId();
    expect(validateOrderId("  " + id + "  ")).toBe(id);
  });
});
