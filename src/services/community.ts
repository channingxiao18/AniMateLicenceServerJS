/**
 * Official community entry config (QQ group / Discord).
 *
 * Design constraints, and why this is a key-value table rather than columns:
 *
 * - **Changing a group number must not need a client release.** The client reads
 *   this once per launch (`GET /v1/community/info`) and falls back to its own
 *   compiled-in default on any failure, so this table is never a prerequisite for
 *   the entry to work — only a way to move it without shipping a build.
 * - **`revision` is a monotonic order stamp, not a timestamp.** The client rejects a
 *   response whose revision is lower than what it already cached, which is what stops
 *   a CDN edge node serving a stale body from walking a machine back to the old group
 *   number. Bumping it on every write is therefore not bookkeeping — it is the
 *   mechanism. Never write these rows without going through {@link writeCommunityInfo}.
 * - **Empty value = channel unconfigured.** The client hides a channel whose
 *   identifier is empty; it does not render a button that copies an empty string.
 *
 * See `AniMate/docs/plans/社群入口设计-QQ与Discord-2026-10-08.md`.
 */

import { eq } from "drizzle-orm";
import type { Database } from "../db/index";
import { communitySettings } from "../db/schema";
import { nowISO } from "./activation";

/** D1 keys. Spelled out so a typo cannot silently create a second, unread row. */
export const COMMUNITY_KEYS = {
  revision: "revision",
  qqGroupNumber: "qq_group_number",
  qqJoinUrl: "qq_join_url",
  discordInviteUrl: "discord_invite_url",
} as const;

/** Wire shape of `GET /v1/community/info`. Field names are the client's contract. */
export type CommunityInfo = {
  revision: number;
  qq_group_number: string;
  qq_join_url: string;
  discord_invite_url: string;
};

/** What an admin may change. Absent field = leave the stored value alone. */
export type CommunityInfoPatch = {
  qq_group_number?: string;
  qq_join_url?: string;
  discord_invite_url?: string;
};

/**
 * All four rows at once. One query, not four: this is the client's only read and
 * it runs on every launch.
 */
export async function readCommunityInfo(db: Database): Promise<CommunityInfo> {
  const rows = await db.select().from(communitySettings).all();
  const value = (key: string): string =>
    rows.find((row) => row.key === key)?.value ?? "";

  const revision = Number.parseInt(value(COMMUNITY_KEYS.revision), 10);

  return {
    // A missing / unparsable revision is 0: "the operator never versioned this",
    // which the client treats as "newest response wins" rather than as an error.
    revision: Number.isFinite(revision) && revision > 0 ? revision : 0,
    qq_group_number: value(COMMUNITY_KEYS.qqGroupNumber),
    qq_join_url: value(COMMUNITY_KEYS.qqJoinUrl),
    discord_invite_url: value(COMMUNITY_KEYS.discordInviteUrl),
  };
}

async function upsert(db: Database, key: string, value: string): Promise<void> {
  await db
    .insert(communitySettings)
    .values({ key, value, updatedAt: nowISO() })
    .onConflictDoUpdate({
      target: communitySettings.key,
      set: { value, updatedAt: nowISO() },
    });
}

/**
 * Apply a patch and bump the revision in the same logical operation.
 *
 * Deliberately not a single SQL transaction: D1's batch API would be needed for that,
 * and a half-applied patch is recoverable here — the client re-reads on the next
 * launch, and the worst case is one channel briefly holding a previous value. The
 * revision is written **last** so that a crash between the two steps cannot publish a
 * revision that does not yet describe the content.
 */
export async function writeCommunityInfo(
  db: Database,
  patch: CommunityInfoPatch
): Promise<CommunityInfo> {
  if (patch.qq_group_number !== undefined) {
    await upsert(db, COMMUNITY_KEYS.qqGroupNumber, patch.qq_group_number.trim());
  }
  if (patch.qq_join_url !== undefined) {
    await upsert(db, COMMUNITY_KEYS.qqJoinUrl, patch.qq_join_url.trim());
  }
  if (patch.discord_invite_url !== undefined) {
    await upsert(db, COMMUNITY_KEYS.discordInviteUrl, patch.discord_invite_url.trim());
  }

  const current = await readCommunityInfo(db);
  await upsert(db, COMMUNITY_KEYS.revision, String(current.revision + 1));

  return readCommunityInfo(db);
}
