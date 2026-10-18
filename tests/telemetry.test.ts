import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestEnv } from "./helpers/setup";
import {
  getActivityDays,
  getInstallationDays,
  getProductAnalyticsReport,
  getRetentionReport,
  getStartupDiagnostics,
  getTelemetryInstallDetail,
  getTelemetryMachineDetail,
  getTelemetryMachineUsage,
  getTelemetryReport,
  listActiveDevicesForDay,
  listInstallationsForDay,
  listTelemetryEvents,
  listTelemetryUsers,
  recordTelemetryEvent,
  TelemetryError,
} from "../src/services/telemetry";
import {
  telemetryDailyMetrics,
  telemetryDailyUniques,
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

  it("accepts trial lifecycle events and builds the trial-to-activation funnel", async () => {
    const env = await createTestEnv();
    const machine = "c".repeat(64);
    const base = event({ machine_hash: machine, sent_at: 1781680000 });
    const lifecycle: Array<[string, number, Record<string, unknown>]> = [
      ["trial_granted", 1781680000, { source: "startup_bootstrap" }],
      ["trial_expired", 1781766400, { reason: "server_time_reached", trial_started_at: 1781680000, valid_until: 1781766400, expired_at: 1781766400 }],
      ["license_reminder_shown", 1781766500, {}],
      ["purchase_clicked", 1781766600, { surface: "license_prompt" }],
      ["checkout_opened", 1781766700, {}],
      ["license_activated", 1781766900, { source: "activate_command", first_activation: true }],
    ];
    for (const [index, [name, sentAt, payload]] of lifecycle.entries()) {
      await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
        ...base,
        event_id: `e${index}000000-0000-4000-8000-00000000000${index}`,
        sent_at: sentAt,
        event: name,
        license_state: name === "trial_expired" ? "expired" : "trial",
        payload,
      });
    }

    const report = await getProductAnalyticsReport(env.db, { days: 90, productId: "animate" });
    expect(report.funnels.trial.stages.map((stage) => stage.devices)).toEqual([1, 1, 1, 1, 1]);
    expect(report.funnels.trial.stages.at(-1)?.fromFirstPct).toBe(100);
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

describe("telemetry visible secs field compatibility (0.12.2 rename)", () => {
  it("accepts a 0.12.2 heartbeat carrying companion_visible_secs and counts its visible delta", async () => {
    const env = await createTestEnv();
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", event());
    await recordTelemetryEvent(
      env.db,
      env.config,
      "animate-desktop-prod-v1",
      event({
        event_id: "c0000001-0000-4000-8000-000000000001",
        event: "session_heartbeat",
        payload: {
          seq: 1,
          process_duration_secs: 900,
          companion_visible_secs: 600,
        },
      })
    );
    await recordTelemetryEvent(
      env.db,
      env.config,
      "animate-desktop-prod-v1",
      event({
        event_id: "c0000001-0000-4000-8000-000000000002",
        event: "session_heartbeat",
        payload: {
          seq: 2,
          process_duration_secs: 1200,
          companion_visible_secs: 900,
        },
      })
    );

    const state = await env.db
      .select()
      .from(telemetrySessionState)
      .where(eq(telemetrySessionState.sessionId, "33333333-3333-4333-8333-333333333333"))
      .get();
    expect(state?.lastOverlayVisibleSecs).toBe(900);

    const metrics = await env.db.select().from(telemetryDailyMetrics).all();
    expect(metrics.reduce((sum, row) => sum + row.activeSecs, 0)).toBe(1200);
    expect(metrics.reduce((sum, row) => sum + row.overlayVisibleSecs, 0)).toBe(900);
  });

  it("accepts a 0.12.2 session_end carrying companion_visible_secs", async () => {
    const env = await createTestEnv();
    const sessionId = "c0000002-0000-4000-8000-000000000002";
    const base = event({ install_id: "c0000002-0000-4000-8000-00000000fff2", session_id: sessionId });
    const receivedAt = new Date("2026-08-15T10:00:00.000Z");

    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "c0000002-0000-4000-8000-00000000000a",
      event: "session_start",
      payload: { started_at: Math.floor(receivedAt.getTime() / 1000) },
    }, receivedAt);
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "c0000002-0000-4000-8000-00000000000b",
      event: "session_end",
      payload: { process_duration_secs: 90, companion_visible_secs: 30, reason: "user_exit" },
    }, new Date(receivedAt.getTime() + 90000));

    const report = await getStartupDiagnostics(env.db, { day: "2026-08-15", productId: "animate" });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ processSecs: 90, diagnosis: "no_1m_checkpoint" });
  });

  it("rejects a heartbeat with neither visible secs field", async () => {
    const env = await createTestEnv();
    await expect(
      recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", event({
        event_id: "c0000003-0000-4000-8000-000000000003",
        event: "session_heartbeat",
        payload: { seq: 1, process_duration_secs: 900 },
      }))
    ).rejects.toMatchObject({
      error: "INVALID_PAYLOAD",
      statusCode: 400,
    });
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

    // 详情页默认只看最近 30 天；这条用例的数据固定在 2026-08-15，所以显式要全历史，
    // 否则窗口会把事件滤掉（窗口行为本身由下面的 "install detail window" 用例覆盖）。
    const detail = await getTelemetryInstallDetail(env.db, { installId, days: "all" });
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

// Lever 1 (one-click sample model card). Both registries have to know these
// five names: EVENT_NAMES gates ingest, PRODUCT_EVENT_NAMES is the candidate
// set the machine_active mark, the per-(day, install) device view and the
// product report's raw event load all read. Missing from the first, the funnel
// is rejected at the door; missing from the second, it is stored but invisible.
// See docs/reports/用户行为遥测分析-0.12.2-2026-10-06.md §3.4.
describe("telemetry catalog card funnel (lever 1)", () => {
  const catalogEvents = [
    "catalog_card_shown",
    "catalog_claim_clicked",
    "catalog_claim_result",
    "catalog_download_result",
    "catalog_model_imported",
  ];

  it("accepts every step of the catalog funnel the desktop client sends", async () => {
    const env = await createTestEnv();
    const base = event();
    for (const [index, eventName] of catalogEvents.entries()) {
      const result = await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
        ...base,
        event_id: `c0000005-0000-4000-8000-00000000000${index}`,
        event: eventName,
        payload: { model_id: "mdl_changli", remaining: 2 },
      });
      expect(result).toEqual({ ok: true });
    }

    const rows = await env.db.select().from(telemetryEvents).all();
    expect(rows.map((row) => row.event).sort()).toEqual([...catalogEvents].sort());
  });

  it("keeps a catalog event inside the daily device view candidate set", async () => {
    const env = await createTestEnv();
    const day = "2026-08-15";
    const installId = "44444444-4444-4444-8444-444444444444";
    // Inserted directly: ingest is already covered above, and this test is
    // about PRODUCT_EVENT_NAMES (the reader), not the EVENT_NAMES gate.
    await env.db.insert(telemetryEvents).values({
      eventId: "c0000006-0000-4000-8000-000000000001",
      schemaVersion: 1,
      event: "catalog_card_shown",
      sourceId: "desktop_prod",
      receivedAt: `${day} 10:00:00`,
      receivedAtUnix: Math.floor(Date.parse("2026-08-15T10:00:00Z") / 1000),
      sentAt: Math.floor(Date.parse("2026-08-15T10:00:00Z") / 1000),
      productId: "animate",
      appVersion: "0.12.2",
      platform: "windows",
      channel: "official",
      machineHash,
      installId,
      licenseState: "trial",
      payloadJson: JSON.stringify({ remaining: 2 }),
      rawJson: "{}",
    });

    const listed = await listActiveDevicesForDay(env.db, { day, productId: "animate" });
    expect(listed.total).toBe(1);
    expect(listed.items[0].installId).toBe(installId);
  });
});

// Storage honesty + language picker (AniMate 0.12.5,
// docs/plans/语言选择卡事件风暴与状态失忆问题分析-2026-10-07.md). Same two-registry rule as the
// catalog funnel above: EVENT_NAMES gates ingest, PRODUCT_EVENT_NAMES is what the machine_active
// mark, the per-(day, install) device view and the product report's raw load read.
//
// The failure mode here is worse than a missing number: the desktop client only treats HTTP_413 as
// "the server refused this event" — a 400 is deferred and replayed, so an unlisted name keeps
// answering INVALID_EVENT forever and pins its event in the local queue.
describe("telemetry storage honesty + language picker events", () => {
  const honestyEvents = [
    "storage_read_failed",
    "storage_write_failed",
    "language_picker_shown",
  ];

  it("accepts the events the 0.12.5 client sends instead of answering INVALID_EVENT", async () => {
    const env = await createTestEnv();
    const base = event();
    for (const [index, eventName] of honestyEvents.entries()) {
      const result = await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
        ...base,
        event_id: `d0000005-0000-4000-8000-00000000000${index}`,
        event: eventName,
        payload: { code: "STORAGE_WRITE_FAILED", file: "state.json" },
      });
      expect(result).toEqual({ ok: true });
    }

    const rows = await env.db.select().from(telemetryEvents).all();
    expect(rows.map((row) => row.event).sort()).toEqual([...honestyEvents].sort());
  });

  it("keeps a storage-honesty event inside the daily device view candidate set", async () => {
    const env = await createTestEnv();
    const day = "2026-08-16";
    const installId = "55555555-5555-4555-8555-555555555555";
    const machineHash = "b".repeat(64);
    // Inserted directly: ingest is covered above, and this test is about
    // PRODUCT_EVENT_NAMES (the reader), not the EVENT_NAMES gate.
    await env.db.insert(telemetryEvents).values({
      eventId: "d0000006-0000-4000-8000-000000000001",
      schemaVersion: 2,
      event: "storage_write_failed",
      sourceId: "desktop_prod",
      receivedAt: `${day} 10:00:00`,
      receivedAtUnix: Math.floor(Date.parse("2026-08-16T10:00:00Z") / 1000),
      sentAt: Math.floor(Date.parse("2026-08-16T10:00:00Z") / 1000),
      productId: "animate",
      appVersion: "0.12.5",
      platform: "windows",
      channel: "official",
      machineHash,
      installId,
      licenseState: "active",
      payloadJson: JSON.stringify({ code: "STORAGE_WRITE_FAILED", file: "state.json" }),
      rawJson: "{}",
    });

    const listed = await listActiveDevicesForDay(env.db, { day, productId: "animate" });
    expect(listed.total).toBe(1);
    expect(listed.items[0].installId).toBe(installId);
  });
});

describe("telemetry daily-unique marks (read-quota rewrite)", () => {
  it("falls back to the raw replay while install_active has no coverage", async () => {
    const env = await createTestEnv();
    const day = new Date().toISOString().slice(0, 10);
    // 直接插原始事件 = 「回填还没跑」的状态：install_active 一行都没有。
    // 这时活跃设备页必须回退到原始事件重放，而不是给出一张全 0 的报表。
    await env.db.insert(telemetryEvents).values({
      eventId: "bbbbbbbb-0000-4000-8000-000000000001",
      schemaVersion: 2,
      event: "session_start",
      sourceId: "desktop_prod",
      receivedAt: `${day} 10:00:00`,
      receivedAtUnix: Math.floor(Date.parse(`${day}T10:00:00Z`) / 1000),
      sentAt: Math.floor(Date.parse(`${day}T10:00:00Z`) / 1000),
      productId: "animate",
      appVersion: "0.12.5",
      platform: "windows",
      channel: "official",
      machineHash: "d".repeat(64),
      installId: "cccccccc-0000-4000-8000-000000000001",
      sessionId: "dddddddd-0000-4000-8000-000000000001",
      licenseState: "free",
      payloadJson: JSON.stringify({ started_at: Math.floor(Date.parse(`${day}T10:00:00Z`) / 1000) }),
      rawJson: "{}",
    });

    const report = await getActivityDays(env.db, { days: 7, productId: "animate" });
    expect(report.days.find((row) => row.day === day)).toMatchObject({ devices: 1, launches: 1 });
    expect(await env.db.select().from(telemetryDailyUniques).all()).toHaveLength(0);
  });

  it("writes machine_active, session_seen and install_active in one ingest pass", async () => {
    const env = await createTestEnv();
    const now = new Date();
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", event(), now);

    const marks = await env.db.select().from(telemetryDailyUniques).all();
    expect(marks.map((row) => row.uniqueType).sort()).toEqual([
      "install_active",
      "machine_active",
      "session_seen",
    ]);
    const day = now.toISOString().slice(0, 10);
    for (const mark of marks) {
      expect(mark.day).toBe(day);
      expect(mark.productId).toBe("animate");
    }
    expect(marks.find((row) => row.uniqueType === "install_active")!.uniqueValue).toBe(
      "22222222-2222-4222-8222-222222222222"
    );
  });
});

describe("install detail window (read-quota rewrite)", () => {
  const installId = "99999999-9999-4999-8999-999999999999";
  const sessionId = "88888888-8888-4888-8888-888888888888";

  async function seed(env: Awaited<ReturnType<typeof createTestEnv>>) {
    const old = new Date(Date.now() - 60 * 86400000);
    const recent = new Date(Date.now() - 3600_000);
    const base = {
      schema_version: 2 as const,
      product_id: "animate",
      app_version: "0.12.5",
      platform: "win32",
      channel: "official",
      machine_hash: "c".repeat(64),
      install_id: installId,
      session_id: sessionId,
      license_state: "free",
      payload: {},
    };
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "aaaabbbb-0000-4000-8000-000000000001",
      event: "session_start",
      payload: { started_at: Math.floor(old.getTime() / 1000) },
    }, old);
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "aaaabbbb-0000-4000-8000-000000000002",
      event: "session_start",
      payload: { started_at: Math.floor(recent.getTime() / 1000) },
    }, recent);
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      ...base,
      event_id: "aaaabbbb-0000-4000-8000-000000000003",
      event: "surface_event",
      payload: { surface: "workshop", action: "open" },
    }, recent);
  }

  it("defaults to 30 days, honours days=all and filters in SQL", async () => {
    const env = await createTestEnv();
    await seed(env);

    const recentOnly = await getTelemetryInstallDetail(env.db, { installId });
    expect(recentOnly.days).toBe(30);
    expect(recentOnly.totalEvents).toBe(2);
    expect(recentOnly.launches).toBe(1);
    expect(recentOnly.workshopOpens).toBe(1);
    expect(recentOnly.platform).toBe("windows");

    const allHistory = await getTelemetryInstallDetail(env.db, { installId, days: "all" });
    expect(allHistory.days).toBe("all");
    expect(allHistory.totalEvents).toBe(3);
    expect(allHistory.launches).toBe(2);

    // event / session_id / surface 三种筛选都由 SQL 完成（含 json_extract 的 surface）。
    const byEvent = await getTelemetryInstallDetail(env.db, { installId, days: "all", event: "session_start" });
    expect(byEvent.totalFilteredEvents).toBe(2);
    expect(byEvent.events).toHaveLength(2);
    const bySession = await getTelemetryInstallDetail(env.db, { installId, days: "all", sessionId });
    expect(bySession.totalFilteredEvents).toBe(3);
    const bySurface = await getTelemetryInstallDetail(env.db, { installId, days: "all", surface: "workshop" });
    expect(bySurface.totalFilteredEvents).toBe(1);
    expect(bySurface.events[0].event).toBe("surface_event");
    const byMissingSurface = await getTelemetryInstallDetail(env.db, { installId, days: "all", surface: "dance_studio" });
    expect(byMissingSurface.totalFilteredEvents).toBe(0);
  });

  it("pages in SQL instead of slicing a full in-memory scan", async () => {
    const env = await createTestEnv();
    await seed(env);
    const page = await getTelemetryInstallDetail(env.db, { installId, days: "all", page: 2, pageSize: 2 });
    expect(page.totalFilteredEvents).toBe(3);
    expect(page.events).toHaveLength(1);
  });
});

describe("duration scope contract (single SESSION_DURATION_EVENTS)", () => {
  const installId = "eeeeeeee-0000-4000-8000-000000000001";
  const machine = "e".repeat(64);
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // 固定到当天 12:00 UTC：让所有事件落在同一个 UTC 日，且不与页面的时间窗边界打架。
  const base = (() => {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    return d.getTime();
  })();
  const at = (secs: number) => new Date(base + secs * 1000);
  const today = new Date(base).toISOString().slice(0, 10);
  const todayRow = (report: { days: Array<Record<string, unknown>> }) =>
    report.days.find((row) => row.day === today);

  async function send(
    env: Awaited<ReturnType<typeof createTestEnv>>,
    event: string,
    sessionId: string,
    eventId: string,
    payload: Record<string, unknown>,
    secs: number
  ) {
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", {
      schema_version: 2,
      event_id: eventId,
      event,
      sent_at: Math.floor(at(secs).getTime() / 1000),
      product_id: "animate",
      app_version: "0.12.5",
      platform: "win32",
      channel: "official",
      machine_hash: machine,
      install_id: installId,
      session_id: sessionId,
      license_state: "free",
      payload,
    }, at(secs));
  }

  it("reports the same activeSecs in every consumer, including tails that end on a checkpoint", async () => {
    const env = await createTestEnv();
    // 会话 A：最后一个时长事件是 checkpoint（旧的三事件口径会丢掉这段尾巴）
    const a = uuid(101);
    await send(env, "session_start", a, uuid(1), { started_at: Math.floor(base / 1000) }, 0);
    await send(env, "session_checkpoint", a, uuid(2), { seq: 1, process_duration_secs: 600, companion_visible_secs: 360 }, 600);
    // 会话 B：以 unclean_end 收尾
    const b = uuid(102);
    await send(env, "session_start", b, uuid(3), { started_at: Math.floor(base / 1000) }, 0);
    await send(env, "session_heartbeat", b, uuid(4), { seq: 1, process_duration_secs: 300, companion_visible_secs: 200 }, 300);
    await send(env, "session_unclean_end", b, uuid(5), { process_duration_secs: 900, companion_visible_secs: 600 }, 900);
    // 会话 C：干净退出
    const c = uuid(103);
    await send(env, "session_start", c, uuid(6), { started_at: Math.floor(base / 1000) }, 0);
    await send(env, "session_heartbeat", c, uuid(7), { seq: 1, process_duration_secs: 300, companion_visible_secs: 200 }, 300);
    await send(env, "session_end", c, uuid(8), { process_duration_secs: 1200, companion_visible_secs: 800 }, 1200);

    // 600 (A) + 300→900 (B) + 300→1200 (C) = 2700；三个口径必须都给出这个数。
    const activity = await getActivityDays(env.db, { days: 2, productId: "animate" });
    expect(todayRow(activity)).toMatchObject({ devices: 1, launches: 3, activeSecs: 2700 });

    const usage = await getTelemetryMachineUsage(env.db, { days: 2, productId: "animate" });
    expect(usage[0].activeSecs).toBe(2700);

    const detail = await getTelemetryInstallDetail(env.db, { installId, days: "all" });
    expect(detail.activeSecs).toBe(2700);
    expect(detail.launches).toBe(3);

    const users = await listTelemetryUsers(env.db, { days: 2, productId: "animate" });
    expect(users.items[0].activeSecs).toBe(2700);

    // 入库聚合（设备总览卡片/每日趋势的数据源）也必须一致
    const report = await getTelemetryReport(env.db, { days: 2, productId: "animate" });
    expect(report.totals.activeSecs).toBe(2700);

    // 活跃设备-某日页的「历史累计时长」改读 telemetry_session_state 聚合（migration 0017）。
    // 它必须与上面四个消费方给出同一个数：每个会话的 last_* 之和 = 该会话的累计增量。
    const dayDevices = await listActiveDevicesForDay(env.db, {
      day: today,
      page: 1,
      pageSize: 10,
    });
    expect(dayDevices.items).toHaveLength(1);
    expect(dayDevices.items[0]).toMatchObject({
      installId,
      lifetimeActiveSecs: 2700,
      lifetimeOverlayVisibleSecs: 1760, // 360 (A) + 600 (B) + 800 (C)
    });

    // 用户详情页：默认 30 天窗口 + SQL 分页，摘要与上面的口径一致。
    const machineDetail = await getTelemetryMachineDetail(env.db, {
      machineHash: machine,
      productId: "animate",
      days: 2,
      page: 1,
      pageSize: 2,
    });
    expect(machineDetail.user).toMatchObject({ machineHash: machine, events: 8, launches: 3, activeSecs: 2700 });
    expect(machineDetail.days).toBe(2);
    expect(machineDetail.total).toBe(8);
    expect(machineDetail.events).toHaveLength(2);
    const nextPage = await getTelemetryMachineDetail(env.db, {
      machineHash: machine,
      productId: "animate",
      days: 2,
      page: 2,
      pageSize: 2,
    });
    expect(nextPage.events).toHaveLength(2);
    expect(nextPage.events[0].eventId).not.toBe(machineDetail.events[0].eventId);
  });

  it("keeps session_unclean_detected out of the duration scope (and warns once)", async () => {
    const env = await createTestEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sessionId = uuid(201);
    await send(env, "session_start", sessionId, uuid(11), { started_at: Math.floor(base / 1000) }, 0);
    await send(env, "session_heartbeat", sessionId, uuid(12), { seq: 1, process_duration_secs: 600, companion_visible_secs: 400 }, 600);
    // 带时长字段的 detection 事件：今天刻意不算时长（口径由 SESSION_DURATION_EVENTS 决定），
    // 但它仍然算「异常退出」并让当天设备保持活跃。
    await send(env, "session_unclean_detected", sessionId, uuid(13), { process_duration_secs: 900, companion_visible_secs: 700 }, 900);

    const detail = await getTelemetryInstallDetail(env.db, { installId, days: "all" });
    expect(detail.activeSecs).toBe(600);
    expect(detail.uncleanExits).toBe(1);

    const usage = await getTelemetryMachineUsage(env.db, { days: 2, productId: "animate" });
    expect(usage[0].activeSecs).toBe(600);

    const activity = await getActivityDays(env.db, { days: 2, productId: "animate" });
    expect(todayRow(activity)).toMatchObject({ devices: 1, activeSecs: 600 });

    // 探针：第一次收到带时长的 session_unclean_detected 时告警（每个 isolate 一次）。
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("raw event browser id lookup", () => {
  it("matches a full hash / UUID exactly, and still matches fragments", async () => {
    const env = await createTestEnv();
    await recordTelemetryEvent(env.db, env.config, "animate-desktop-prod-v1", event());

    // 完整 64 位 hash → 走 machine_idx 等值
    const fullHash = await listTelemetryEvents(env.db, { machineHash, days: 7 });
    expect(fullHash.total).toBe(1);
    // 片段 → 仍是两侧通配 LIKE（语义不变）
    const fragment = await listTelemetryEvents(env.db, { machineHash: machineHash.slice(0, 8), days: 7 });
    expect(fragment.total).toBe(1);
    // 完整 UUID → 走 install_idx 等值
    const byInstall = await listTelemetryEvents(env.db, {
      installId: "22222222-2222-4222-8222-222222222222",
      days: 7,
    });
    expect(byInstall.total).toBe(1);
    // 大小写不敏感仍然成立
    const upper = await listTelemetryEvents(env.db, {
      installId: "22222222-2222-4222-8222-222222222222".toUpperCase(),
      days: 7,
    });
    expect(upper.total).toBe(1);
    // 不存在的完整 hash → 0 行（而不是退化成全表 LIKE）
    const missing = await listTelemetryEvents(env.db, { machineHash: "f".repeat(64), days: 7 });
    expect(missing.total).toBe(0);
  });
});
