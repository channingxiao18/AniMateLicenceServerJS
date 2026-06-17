import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnv } from "./helpers/setup";
import {
  getTelemetryReport,
  recordTelemetryEvent,
  TelemetryError,
} from "../src/services/telemetry";
import {
  telemetryDailyMetrics,
  telemetryEvents,
  telemetrySessionState,
} from "../src/db/schema";

const machineHash = "a".repeat(64);

function event(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    event_id: "11111111-1111-4111-8111-111111111111",
    event: "session_start",
    sent_at: 1781680000,
    product_id: "animate",
    app_version: "0.4.2",
    platform: "win32",
    channel: "official",
    machine_hash: machineHash,
    install_id: "22222222-2222-4222-8222-222222222222",
    session_id: "33333333-3333-4333-8333-333333333333",
    license_state: "free",
    activation_id: null,
    payload: { started_at: 1781680000 },
    ...overrides,
  };
}

describe("telemetry", () => {
  it("records a valid session_start and updates report aggregates", async () => {
    const env = await createTestEnv();
    const result = await recordTelemetryEvent(
      env.db,
      env.config,
      "animate-desktop-prod-v1",
      event(),
      new Date("2026-06-17T12:00:00Z")
    );

    expect(result).toEqual({ ok: true });
    const rows = await env.db.select().from(telemetryEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe("desktop_prod");
    expect(rows[0].platform).toBe("windows");

    const report = await getTelemetryReport(env.db, { days: 1, productId: "animate" });
    expect(report.totals.launches).toBe(1);
    expect(report.totals.activeMachines).toBe(1);
    expect(report.licenseStates[0].licenseState).toBe("free");
  });

  it("deduplicates event_id without double-counting", async () => {
    const env = await createTestEnv();
    const payload = event();
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", payload);
    const duplicate = await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", payload);

    expect(duplicate).toEqual({ ok: true, duplicate: true });
    expect(await env.db.select().from(telemetryEvents).all()).toHaveLength(1);
    const metrics = await env.db.select().from(telemetryDailyMetrics).all();
    expect(metrics.reduce((sum, row) => sum + row.launches, 0)).toBe(1);
  });

  it("computes heartbeat duration deltas from session state", async () => {
    const env = await createTestEnv();
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", event());
    await recordTelemetryEvent(
      env.db,
      env.config,
      "animate-desktop-prod-v1",
      event({
        event_id: "44444444-4444-4444-8444-444444444444",
        event: "session_heartbeat",
        payload: {
          seq: 1,
          process_duration_secs: 900,
          overlay_visible_secs: 600,
        },
      })
    );
    await recordTelemetryEvent(
      env.db,
      env.config,
      "animate-desktop-prod-v1",
      event({
        event_id: "55555555-5555-4555-8555-555555555555",
        event: "session_heartbeat",
        payload: {
          seq: 2,
          process_duration_secs: 1200,
          overlay_visible_secs: 900,
        },
      })
    );

    const state = await env.db
      .select()
      .from(telemetrySessionState)
      .where(eq(telemetrySessionState.sessionId, "33333333-3333-4333-8333-333333333333"))
      .get();
    expect(state?.lastProcessDurationSecs).toBe(1200);

    const metrics = await env.db.select().from(telemetryDailyMetrics).all();
    expect(metrics.reduce((sum, row) => sum + row.activeSecs, 0)).toBe(1200);
    expect(metrics.reduce((sum, row) => sum + row.overlayVisibleSecs, 0)).toBe(900);
  });

  it("rejects invalid telemetry token", async () => {
    const env = await createTestEnv();
    await expect(
      recordTelemetryEvent(env.db, env.config, "bad-token", event())
    ).rejects.toMatchObject({
      error: "INVALID_TELEMETRY_TOKEN",
      statusCode: 401,
    });
  });

  it("records download_click without machine or install ids", async () => {
    const env = await createTestEnv();
    await recordTelemetryEvent(
      env.db,
      env.config,
      "animate-desktop-dev",
      event({
        event_id: "66666666-6666-4666-8666-666666666666",
        event: "download_click",
        app_version: undefined,
        platform: undefined,
        machine_hash: undefined,
        install_id: undefined,
        session_id: undefined,
        license_state: undefined,
        payload: {
          download_platform: "windows",
          download_version: "0.4.2",
          source: "official_site",
        },
      })
    );

    const report = await getTelemetryReport(env.db, { days: 1, productId: "animate" });
    expect(report.totals.downloads).toBe(1);
    expect(report.totals.activeMachines).toBe(0);
  });
});
