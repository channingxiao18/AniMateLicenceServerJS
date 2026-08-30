import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnv } from "./helpers/setup";
import {
  getActivityDays,
  getInstallationDays,
  getProductAnalyticsReport,
  getRetentionReport,
  getStartupDiagnostics,
  getTelemetryInstallDetail,
  getTelemetryReport,
  listActiveDevicesForDay,
  listInstallationsForDay,
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
      event()
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

  it("accepts a v2 checkpoint without session_start and counts its baseline", async () => {
    const env = await createTestEnv();
    await recordTelemetryEvent(
      env.db,
      env.config,
      "animate-desktop-prod-v1",
      event({
        schema_version: 2,
        event_id: "77777777-7777-4777-8777-777777777777",
        event: "session_checkpoint",
        channel: "microsoft_store",
        license_state: "trial",
        payload: {
          seq: 1,
          process_duration_secs: 120,
          companion_visible_secs: 90,
          workshop_visible_secs: 10,
        },
      })
    );

    const report = await getTelemetryReport(env.db, { days: 1, productId: "animate" });
    expect(report.totals.activeSecs).toBe(120);
    expect(report.totals.overlayVisibleSecs).toBe(90);
  });

  it("stores product events without treating them as session duration", async () => {
    const env = await createTestEnv();
    await recordTelemetryEvent(
      env.db,
      env.config,
      "animate-desktop-prod-v1",
      event({
        schema_version: 2,
        event_id: "88888888-8888-4888-8888-888888888888",
        event: "model_import_completed",
        payload: {
          surface: "avatar_manager",
          format: "vrm",
          result: "success",
          size_bucket: "10mb_50mb",
        },
      })
    );

    const rows = await env.db.select().from(telemetryEvents).all();
    expect(rows[0].event).toBe("model_import_completed");
    const report = await getTelemetryReport(env.db, { days: 1, productId: "animate" });
    expect(report.totals.activeSecs).toBe(0);
  });

  it("records free-model guide clicks with their entry surface", async () => {
    const env = await createTestEnv();
    await recordTelemetryEvent(
      env.db,
      env.config,
      "animate-desktop-prod-v1",
      event({
        schema_version: 2,
        event_id: "99999999-9999-4999-8999-999999999999",
        event: "free_model_guide_clicked",
        payload: { surface: "workshop_model_card" },
      })
    );

    const rows = await env.db.select().from(telemetryEvents).all();
    expect(rows[0].event).toBe("free_model_guide_clicked");
    expect(JSON.parse(rows[0].payloadJson || "{}")).toEqual({
      surface: "workshop_model_card",
    });
    const report = await getTelemetryReport(env.db, { days: 1, productId: "animate" });
    expect(report.totals.activeSecs).toBe(0);
  });

  it("builds device-based product funnels in event order", async () => {
    const env = await createTestEnv();
    const machine = "b".repeat(64);
    const base = event({ machine_hash: machine, sent_at: 1781680000 });
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      event: "free_model_guide_clicked",
      payload: { surface: "import_dialog" },
    });
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sent_at: 1781680001,
      event: "model_import_clicked",
      payload: { surface: "avatar_manager" },
    });
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sent_at: 1781680002,
      event: "model_import_picker_opened",
      payload: { surface: "avatar_manager" },
    });
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sent_at: 1781680003,
      event: "model_import_completed",
      payload: { result: "success" },
    });

    const report = await getProductAnalyticsReport(env.db, { days: 90, productId: "animate" });
    expect(report.funnels.freeModel.stages.map((stage) => stage.devices)).toEqual([1, 1, 1]);
    expect(report.freeModelSurfaces.find((surface) => surface.surface === "import_dialog")?.funnel.stages[2].devices).toBe(1);
    expect(report.funnels.import.stages[2].fromFirstPct).toBe(100);
  });

  it("reports installation, activity detail and retention by install_id", async () => {
    const env = await createTestEnv();
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    const cohortDate = new Date(today.getTime() - 3 * 86400000);
    const dayOneDate = new Date(today.getTime() - 2 * 86400000);
    const installId = "12121212-1212-4212-8212-121212121212";
    const sessionId = "34343434-3434-4434-8434-343434343434";
    const base = event({ install_id: installId, machine_hash: machineHash });

    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "10101010-1010-4010-8010-101010101010",
      event: "install_seen",
      session_id: undefined,
      payload: { first_seen: true },
    }, cohortDate);
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "20202020-2020-4020-8020-202020202020",
      event: "install_seen",
      session_id: undefined,
      payload: { first_seen: true },
    }, today);
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "71717171-7171-4171-8171-717171717171",
      event: "free_model_guide_clicked",
      session_id: undefined,
      payload: { surface: "workshop_model_card" },
    }, cohortDate);
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "72727272-7272-4272-8272-727272727272",
      event: "free_model_guide_clicked",
      session_id: undefined,
      payload: { surface: "import_dialog" },
    }, new Date(cohortDate.getTime() + 60000));
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "73737373-7373-4373-8373-737373737373",
      event: "model_import_completed",
      session_id: undefined,
      payload: { result: "success" },
    }, new Date(cohortDate.getTime() + 120000));
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "74747474-7474-4474-8474-747474747474",
      event: "purchase_clicked",
      session_id: undefined,
      payload: { surface: "license_dialog" },
    }, dayOneDate);
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "30303030-3030-4030-8030-303030303030",
      event: "session_start",
      session_id: sessionId,
      payload: { started_at: Math.floor(dayOneDate.getTime() / 1000) },
    }, dayOneDate);
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "40404040-4040-4040-8040-404040404040",
      event: "session_checkpoint",
      session_id: sessionId,
      payload: { seq: 1, process_duration_secs: 600, companion_visible_secs: 360 },
    }, new Date(dayOneDate.getTime() + 600000));
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "50505050-5050-4050-8050-505050505050",
      event: "session_checkpoint",
      session_id: sessionId,
      payload: { seq: 2, process_duration_secs: 900, companion_visible_secs: 480 },
    }, new Date(dayOneDate.getTime() + 900000));
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "60606060-6060-4060-8060-606060606060",
      event: "session_start",
      session_id: "56565656-5656-4656-8656-565656565656",
      payload: { started_at: Math.floor(today.getTime() / 1000) },
    }, today);

    const cohortDay = cohortDate.toISOString().slice(0, 10);
    const dayOne = dayOneDate.toISOString().slice(0, 10);
    const installationReport = await getInstallationDays(env.db, { days: 7, productId: "animate" });
    expect(installationReport.days.find((row) => row.day === cohortDay)).toMatchObject({
      installs: 1,
      freeModelUsers: 1,
      modelUploadUsers: 1,
      purchaseUsers: 0,
    });
    const installations = await listInstallationsForDay(env.db, { day: cohortDay, page: 1, pageSize: 1 });
    expect(installations).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(installations.items[0]).toMatchObject({
      installId,
      freeModelClicked: true,
      modelUploadSucceeded: true,
      purchaseClicked: false,
    });

    const activityReport = await getActivityDays(env.db, { days: 7, productId: "animate" });
    expect(activityReport.days.find((row) => row.day === dayOne)).toMatchObject({ devices: 1, activeSecs: 900 });
    const activeDevices = await listActiveDevicesForDay(env.db, { day: dayOne, page: 1, pageSize: 1 });
    expect(activeDevices.items[0]).toMatchObject({ installId, activeSecs: 900, overlayVisibleSecs: 480 });

    const retention = await getRetentionReport(env.db, { days: 7, productId: "animate" });
    const cohort = retention.rows.find((row) => row.cohortDay === cohortDay);
    expect(cohort?.retention[1]).toMatchObject({ devices: 1, ratePct: 100 });
    expect(cohort?.retention[3]).toMatchObject({ devices: 1, ratePct: 100 });
  });

  it("uses session_end duration in startup diagnostics", async () => {
    const env = await createTestEnv();
    const sessionId = "67676767-6767-4676-8676-676767676767";
    const base = event({ install_id: "78787878-7878-4787-8787-787878787878", session_id: sessionId });
    const receivedAt = new Date("2026-08-15T10:00:00.000Z");

    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "89898989-8989-4898-8898-898989898989",
      event: "session_start",
      payload: { started_at: Math.floor(receivedAt.getTime() / 1000) },
    }, receivedAt);
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "90909090-9090-4909-8909-909090909090",
      event: "first_frame_rendered",
      payload: {},
    }, new Date(receivedAt.getTime() + 5000));
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "abababab-abab-4aba-8aba-abababababab",
      event: "session_end",
      payload: { process_duration_secs: 90, overlay_visible_secs: 30, reason: "user_exit" },
    }, new Date(receivedAt.getTime() + 90000));

    const report = await getStartupDiagnostics(env.db, { day: "2026-08-15", productId: "animate" });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ processSecs: 90, diagnosis: "no_1m_checkpoint" });
  });
});

describe("telemetry unclean session reporting", () => {
  it("records session_unclean_end and attributes durations to the crashed session", async () => {
    const env = await createTestEnv();
    const crashedSessionId = "67676767-6767-4676-8676-676767676767";
    const installId = "78787878-7878-4787-8787-787878787878";
    const base = event({ install_id: installId, session_id: crashedSessionId });
    const receivedAt = new Date("2026-08-15T10:00:00.000Z");

    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "89898989-8989-4898-8898-898989898989",
      event: "session_start",
      payload: { started_at: Math.floor(receivedAt.getTime() / 1000) },
    }, receivedAt);
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "9a9a9a9a-9a9a-49a9-8a9a-9a9a9a9a9a9a",
      event: "session_unclean_end",
      payload: {
        started_at: Math.floor(receivedAt.getTime() / 1000),
        process_duration_secs: 1800,
        companion_visible_secs: 1200,
        workshop_visible_secs: 300,
        last_startup_stage: "model_load_started",
        last_checkpoint_at: Math.floor(receivedAt.getTime() / 1000) + 1740,
      },
    }, new Date(receivedAt.getTime() + 86400000));

    const rows = await env.db.select().from(telemetryEvents).all();
    expect(rows.filter((row) => row.event === "session_unclean_end")).toHaveLength(1);

    const detail = await getTelemetryInstallDetail(env.db, { installId });
    expect(detail.uncleanExits).toBe(1);
    expect(detail.cleanExits).toBe(0);
    expect(detail.activeSecs).toBe(1800);
    expect(detail.overlayVisibleSecs).toBe(1200);
  });

  it("accepts events the desktop client sends that were previously rejected", async () => {
    const env = await createTestEnv();
    const base = event();
    const previouslyRejected = [
      "frontend_bootstrap_started",
      "free_llm_credits_clicked",
      "free_asr_credits_clicked",
      "free_tts_credits_clicked",
    ];
    for (const [index, eventName] of previouslyRejected.entries()) {
      const result = await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
        ...base,
        event_id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${index}`,
        event: eventName,
        payload: { surface: "test" },
      });
      expect(result).toEqual({ ok: true });
    }
    const rows = await env.db.select().from(telemetryEvents).all();
    expect(rows).toHaveLength(4);
  });
});
