/**
 * Order ID format: AM-{11 data chars}{1 check char}, alphabet 0-9A-Z, weighted mod-36 checksum.
 * Compatible with Python order_id.py and Rust client orderId.ts.
 */

const ORDER_PREFIX = "AM-";
const ORDER_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ORDER_ID_BODY_LEN = 12;
const ORDER_ID_DATA_LEN = 11;
const ORDER_ID_PATTERN = /^AM-[0-9A-Z]{12}$/;

export class OrderIdValidationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OrderIdValidationError";
  }
}

function normalizeOrderId(raw: string): string {
  return raw.trim().toUpperCase();
}

function computeCheckChar(data11: string): string {
  if (data11.length !== ORDER_ID_DATA_LEN) {
    throw new Error("data part must be 11 characters");
  }
  let total = 0;
  for (let i = 0; i < data11.length; i++) {
    total += ORDER_ALPHABET.indexOf(data11[i]) * (i + 1);
  }
  return ORDER_ALPHABET[total % ORDER_ALPHABET.length];
}

/**
 * Validate order ID format + checksum. Returns normalized (uppercase) order ID.
 * Throws OrderIdValidationError on failure.
 */
export function validateOrderId(raw: string): string {
  const normalized = normalizeOrderId(raw);
  if (!normalized) {
    throw new OrderIdValidationError(
      "INVALID_ORDER_FORMAT",
      "订单号不能为空"
    );
  }
  if (!ORDER_ID_PATTERN.test(normalized)) {
    throw new OrderIdValidationError(
      "INVALID_ORDER_FORMAT",
      "订单号格式无效（应为 AM- 加 12 位大写字母或数字）"
    );
  }
  const suffix = normalized.substring(ORDER_PREFIX.length);
  const expected = computeCheckChar(suffix.substring(0, ORDER_ID_DATA_LEN));
  if (suffix[ORDER_ID_DATA_LEN] !== expected) {
    throw new OrderIdValidationError(
      "INVALID_ORDER_CHECKSUM",
      "订单号校验位错误，请核对后重试"
    );
  }
  return normalized;
}

/** Generate random characters from ORDER_ALPHABET using Web Crypto. */
function randomAlphabetChars(count: number): string {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let i = 0; i < count; i++) {
    result += ORDER_ALPHABET[bytes[i] % ORDER_ALPHABET.length];
  }
  return result;
}

/** Generate a new order ID in AM-XXXXXXXXXXXX format. */
export function generateOrderId(): string {
  const data = randomAlphabetChars(ORDER_ID_DATA_LEN);
  const check = computeCheckChar(data);
  return `${ORDER_PREFIX}${data}${check}`;
}
