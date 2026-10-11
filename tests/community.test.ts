import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/setup";
import { communitySettings } from "../src/db/schema";
import {
  COMMUNITY_KEYS,
  readCommunityInfo,
  writeCommunityInfo,
} from "../src/services/community";
import { createV1Router } from "../src/routes/v1";

/**
 * The community config is the client's only remote-config read, and its contract has two
 * halves that can each fail silently:
 *
 * - an unconfigured channel must arrive as `""` (never as a missing key), because the
 *   client treats `""` as "hide this channel" and a missing field as a parse failure;
 * - `revision` must increase on every write, because the client rejects a response with a
 *   lower revision than its cache — that is what stops a stale CDN edge node from walking
 *   a machine back to the old group number.
 */

/** Fill the table the way the migration does — rows absent until written. */
async function seedRevisionOnly(env: Awaited<ReturnType<typeof createTestEnv>>, revision: number) {
  await env.db
    .insert(communitySettings)
    .values({ key: COMMUNITY_KEYS.revision, value: String(revision) });
}

describe("community info service", () => {
  it("reports every channel as unconfigured when the table is empty", async () => {
    const env = await createTestEnv();

    // Empty table (not just empty values): the migration seeds the rows, but a database
    // restored from a partial dump must still produce the full shape.
    await expect(readCommunityInfo(env.db)).resolves.toEqual({
      revision: 0,
      qq_group_number: "",
      qq_join_url: "",
      discord_invite_url: "",
    });
  });

  it("trims what the operator typed", async () => {
    const env = await createTestEnv();
    await writeCommunityInfo(env.db, {
      qq_group_number: "  123456789 ",
      qq_join_url: " https://qm.qq.com/q/abc ",
      discord_invite_url: "https://discord.gg/xyz ",
    });

    const info = await readCommunityInfo(env.db);
    expect(info.qq_group_number).toBe("123456789");
    expect(info.qq_join_url).toBe("https://qm.qq.com/q/abc");
    expect(info.discord_invite_url).toBe("https://discord.gg/xyz");
  });

  it("bumps the revision on every write, so a rollback cannot be published by accident", async () => {
    const env = await createTestEnv();
    await seedRevisionOnly(env, 3);

    const first = await writeCommunityInfo(env.db, { qq_group_number: "111" });
    const second = await writeCommunityInfo(env.db, { qq_group_number: "222" });
    const third = await writeCommunityInfo(env.db, { discord_invite_url: "https://discord.gg/a" });

    expect([first.revision, second.revision, third.revision]).toEqual([4, 5, 6]);
  });

  it("leaves unpatched fields alone", async () => {
    const env = await createTestEnv();
    await writeCommunityInfo(env.db, {
      qq_group_number: "123456789",
      discord_invite_url: "https://discord.gg/xyz",
    });

    const afterDiscordOnly = await writeCommunityInfo(env.db, {
      discord_invite_url: "https://discord.gg/abc",
    });

    expect(afterDiscordOnly.qq_group_number).toBe("123456789");
    expect(afterDiscordOnly.discord_invite_url).toBe("https://discord.gg/abc");
  });

  it("accepts an empty string as a deliberate 'hide this channel'", async () => {
    const env = await createTestEnv();
    await writeCommunityInfo(env.db, { qq_group_number: "123456789" });

    const cleared = await writeCommunityInfo(env.db, { qq_group_number: "" });

    expect(cleared.qq_group_number).toBe("");
    expect(cleared.discord_invite_url).toBe("");
  });

  it("treats an unparsable revision as 'not versioned' instead of failing", async () => {
    const env = await createTestEnv();
    await env.db
      .insert(communitySettings)
      .values({ key: COMMUNITY_KEYS.revision, value: "not-a-number" });

    // 0 means "newest response wins" on the client; throwing here would make the whole
    // route 500 over a single bad row.
    await expect(readCommunityInfo(env.db)).resolves.toMatchObject({ revision: 0 });
  });
});

describe("GET /v1/community/info", () => {
  function request(env: Awaited<ReturnType<typeof createTestEnv>>) {
    return createV1Router(env.db, env.config, env.registry).request("/community/info", {
      method: "GET",
    });
  }

  it("answers the client contract with no identity headers at all", async () => {
    const env = await createTestEnv();
    await writeCommunityInfo(env.db, {
      qq_group_number: "123456789",
      discord_invite_url: "https://discord.gg/xyz",
    });

    const response = await request(env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      revision: 1,
      qq_group_number: "123456789",
      qq_join_url: "",
      discord_invite_url: "https://discord.gg/xyz",
    });
  });

  it("is not cached by intermediaries, so a change lands on the next launch", async () => {
    const env = await createTestEnv();
    const response = await request(env);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
