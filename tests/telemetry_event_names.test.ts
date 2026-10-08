import { describe, expect, it } from "vitest";
import { EVENT_NAMES, PRODUCT_EVENT_NAMES } from "../src/services/telemetry";
import snapshot from "./fixtures/telemetry-client-event-names.json";

/**
 * Cross-repository guard for the telemetry event-name contract.
 *
 * Two incidents in two days had the same shape: the AniMate client started sending event names
 * this service had never heard of, so every one of them answered `400 INVALID_EVENT` while both
 * sides looked healthy. The client only treats `413` as "this single event is unprocessable" —
 * every other 4xx is deferred and replayed, so the rejected events sat in the local
 * `telemetry.json` queue and re-collided on every flush:
 *
 *   - 2026-10-06, catalog card funnel (five events, commit 3b22570);
 *   - 2026-10-08, `storage_read_failed` / `storage_write_failed` / `language_picker_shown`
 *     (0.12.5, commit a66836b). `storage_write_failed` fires on an ordinary transient file lock,
 *     so it is not a cold path.
 *
 * This repo's CI (`push main` → `npm ci` → `npm test` → migrate → `wrangler deploy`) only checks
 * out itself, so it cannot read the client's source. It compares a snapshot instead. That makes
 * `tests/fixtures/telemetry-client-event-names.json` load-bearing, and makes regenerating it part
 * of adding an event name on the client:
 *
 *   cd ../AniMate && npm run telemetry:sync-server-names
 *
 * which is the reminder to add the name here too. The other half of the guard lives in the client
 * repo (`src/__tests__/core/telemetryEventParity.test.ts`) and enforces that this snapshot is not
 * stale. See the client's `docs/plans/遥测事件名跨仓库一致性检查-2026-10-08.md`.
 */

const CLIENT_REGEN = "cd ../AniMate && npm run telemetry:sync-server-names";

/** Floors, not expectations: they turn a truncated snapshot into a failure instead of a green run. */
const MIN_SNAPSHOT_FRONTEND = 20;
const MIN_SNAPSHOT_RUST_ALLOWED = 20;

function clientNames(field: "frontend" | "rustAllowed"): string[] {
  const names = snapshot[field];
  const minimum = field === "frontend" ? MIN_SNAPSHOT_FRONTEND : MIN_SNAPSHOT_RUST_ALLOWED;
  if (!Array.isArray(names) || names.length < minimum) {
    throw new Error(
      `快照字段 ${field} 只有 ${Array.isArray(names) ? names.length : "非数组"} 项（至少 ${minimum}）——` +
        `快照很可能被截断或手改过；在客户端仓库运行 ${CLIENT_REGEN} 重新生成。`,
    );
  }
  return names;
}

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

describe("client telemetry event names (snapshot contract)", () => {
  it("the snapshot records a plausible name list", () => {
    // Guards the trivial false-green: an empty or hand-truncated snapshot would make every
    // assertion below vacuously pass.
    expect(clientNames("frontend").length).toBeGreaterThanOrEqual(MIN_SNAPSHOT_FRONTEND);
    expect(clientNames("rustAllowed").length).toBeGreaterThanOrEqual(MIN_SNAPSHOT_RUST_ALLOWED);
    expect(typeof snapshot.generatedAt).toBe("string");
  });

  it("every client event name is accepted by the ingest gate", () => {
    const union = sortedUnique([...clientNames("frontend"), ...clientNames("rustAllowed")]);
    const rejected = union.filter((name) => !EVENT_NAMES.has(name));

    expect(
      rejected,
      `客户端会发这些名字，但入库闸门不认，一律 400 INVALID_EVENT：\n` +
        rejected.map((name) => `  - ${name}`).join("\n") +
        `\n把它们加进 src/services/telemetry.ts 的 EVENT_NAMES（前端事件还要进 PRODUCT_EVENT_NAMES），` +
        `并先确认客户端快照是最新的：${CLIENT_REGEN}。`,
    ).toEqual([]);
  });

  it("every frontend event name reaches the product readers", () => {
    // Presence in EVENT_NAMES only means the row is stored. These three readers — the
    // `machine_active` daily-unique mark (updateAggregates), the per-(day, install) device view
    // (loadDailyDeviceActivity) and the report's raw event load — are driven by
    // PRODUCT_EVENT_NAMES, so a name missing there is stored and invisible: the funnel reports
    // zero while the events arrive.
    const visible = new Set<string>(PRODUCT_EVENT_NAMES);
    const invisible = sortedUnique(clientNames("frontend")).filter((name) => !visible.has(name));

    expect(
      invisible,
      `这些前端事件只入库、三个读者全都看不见（machine_active / 设备视图 / 报表原始事件载入）：\n` +
        invisible.map((name) => `  - ${name}`).join("\n") +
        `\n把它们加进 src/services/telemetry.ts 的 PRODUCT_EVENT_NAMES。` +
        `前端事件都意味着应用正在运行，当天必有 session_start，所以加进去不会改变 machine_active` +
        ` 或 (day, install) 视图的任何数字。`,
    ).toEqual([]);
  });
});
