import { describe, expect, it } from "vitest";
import { feedbackCountForMachine, recordFeedback, validateFeedbackBody } from "../src/services/feedback";
import { createTestDb } from "./helpers/setup";

const payload = {
  source: "store_review",
  message: "界面很可爱，希望增加更多语音选项。",
  contact: "user@example.com",
  app_version: "0.1.0",
  locale: "zh-CN",
  platform: "windows",
  channel: "microsoft_store",
  client_time_ms: 1760000000000,
  machine_hash: "a".repeat(64),
};

describe("feedback service", () => {
  it("validates and stores a feedback submission", async () => {
    const { db } = createTestDb();
    expect(validateFeedbackBody(payload).message).toContain("界面");
    await expect(recordFeedback(db, payload, { ipAddress: "203.0.113.10", userAgent: "test" }))
      .resolves.toEqual({ status: "submitted" });
    await expect(feedbackCountForMachine(db, "a".repeat(64))).resolves.toBe(1);
  });

  it("rejects unsupported values and overlong text", () => {
    expect(() => validateFeedbackBody({ ...payload, source: "other" })).toThrow();
    expect(() => validateFeedbackBody({ ...payload, channel: "other" })).toThrow();
    expect(() => validateFeedbackBody({ ...payload, message: "x".repeat(501) })).toThrow();
    expect(() => validateFeedbackBody({ ...payload, contact: "x".repeat(121) })).toThrow();
  });

  it("keeps quotas independent for different machines on the same IP", async () => {
    const { db } = createTestDb();
    for (let i = 0; i < 3; i += 1) {
      await recordFeedback(db, payload, { ipAddress: "198.51.100.7" });
    }
    await recordFeedback(db, { ...payload, machine_hash: "b".repeat(64) }, { ipAddress: "198.51.100.7" });
    expect(await feedbackCountForMachine(db, "a".repeat(64))).toBe(3);
    expect(await feedbackCountForMachine(db, "b".repeat(64))).toBe(1);
  });
});
