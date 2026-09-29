#!/usr/bin/env node
/**
 * Upload one catalog model to R2 and upsert its D1 row (Lever 1).
 *
 * A model directory contains manifest.json; the .vrm and thumbnail are passed
 * explicitly (test seeds live in the AniMate repo, not here):
 *
 *   node scripts/catalog_upload.mjs \
 *     --dir scripts/catalog/seed/mdl_fafamu \
 *     --vrm ../AniMate/src-tauri/resources/companion-v1/avatars/Fafamu_fafa0001/model.vrm \
 *     --thumb ../AniMate/src-tauri/resources/companion-v1/avatars/Fafamu_fafa0001/thumbnail.webp
 *
 * Add --local to target the local wrangler state (wrangler dev / local D1);
 * default is --remote (production).
 *
 * manifest.json shape (content payload — D1 holds selection fields only):
 * {
 *   "id": "mdl_fafamu",
 *   "name": { "en": "Fafamu", "ja": "ふぁふぁむ" },
 *   "tags": { "en": ["cute"], "ja": ["かわいい"] },
 *   "license_note": "Bundled with AniMate (companion-v1); AniMate project."
 * }
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BUCKET = "animate-model-catalog";
const THUMB_NAMES = ["thumb.jpg", "thumb.jpeg", "thumb.png", "thumb.webp"];

function parseArgs(argv) {
  const args = { local: false };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--local") args.local = true;
    else if (key === "--dir") args.dir = argv[++i];
    else if (key === "--vrm") args.vrm = argv[++i];
    else if (key === "--thumb") args.thumb = argv[++i];
    else {
      throw new Error(`未知参数: ${key}`);
    }
  }
  if (!args.dir) throw new Error("缺少 --dir <模型目录>");
  return args;
}

function run(args) {
  // Invoke wrangler's JS entry via node directly: spawning `npx` from a child
  // process is unreliable on Windows (npx is a .cmd shim; Node ≥20.12 rejects
  // spawning .cmd without a shell — EINVAL).
  const wranglerBin = fileURLToPath(
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
  );
  console.log(`+ wrangler ${args.join(" ")}`);
  execFileSync(process.execPath, [wranglerBin, ...args], { stdio: "inherit" });
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  const args = parseArgs(process.argv);
  const manifestPath = path.join(args.dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  const modelId = manifest.id;
  if (!/^mdl_[a-z0-9_]+$/.test(modelId)) {
    throw new Error(`manifest.id 非法（需匹配 mdl_[a-z0-9_]+）: ${modelId}`);
  }
  if (!manifest.name || typeof manifest.name.en !== "string") {
    throw new Error("manifest.name.en 缺失（en 是回退语言，必填）");
  }

  const vrmPath = args.vrm || path.join(args.dir, "model.vrm");
  let thumbPath = args.thumb;
  if (!thumbPath) {
    const files = await readdir(args.dir);
    const found = THUMB_NAMES.find((name) => files.includes(name));
    if (!found) throw new Error("找不到缩略图（thumb.jpg/jpeg/png/webp），请用 --thumb 指定");
    thumbPath = path.join(args.dir, found);
  }

  const vrmBytes = await readFile(vrmPath);
  const sha256 = createHash("sha256").update(vrmBytes).digest("hex");
  const { size } = await stat(vrmPath);
  const thumbExt = path.extname(thumbPath).replace(".", "").toLowerCase();

  const vrmKey = `catalog/${modelId}/model.vrm`;
  const thumbKey = `catalog/${modelId}/thumb.${thumbExt}`;
  const manifestKey = `catalog/${modelId}/manifest.json`;
  const locales = JSON.stringify(Object.keys(manifest.name));

  // Flag asymmetry in wrangler 3.x: `r2 object put` targets REMOTE storage by
  // default (only `--local` exists as a flag), while `d1 execute` defaults to
  // LOCAL and needs an explicit `--remote`.
  const r2Args = args.local ? ["--local"] : [];
  const d1Args = args.local ? ["--local"] : ["--remote"];
  run(["r2", "object", "put", `${BUCKET}/${vrmKey}`, "--file", vrmPath, ...r2Args]);
  run(["r2", "object", "put", `${BUCKET}/${thumbKey}`, "--file", thumbPath, ...r2Args]);
  run(["r2", "object", "put", `${BUCKET}/${manifestKey}`, "--file", manifestPath, ...r2Args]);

  const upsert = `
INSERT INTO catalog_models
  (id, enabled, weight, sha256, size_bytes, r2_key_vrm, r2_key_thumb, manifest_key, locales, updated_at)
VALUES
  (${sqlString(modelId)}, 1, 1, ${sqlString(sha256)}, ${size}, ${sqlString(vrmKey)},
   ${sqlString(thumbKey)}, ${sqlString(manifestKey)}, ${sqlString(locales)}, datetime('now'))
ON CONFLICT(id) DO UPDATE SET
  enabled = 1,
  sha256 = excluded.sha256,
  size_bytes = excluded.size_bytes,
  r2_key_vrm = excluded.r2_key_vrm,
  r2_key_thumb = excluded.r2_key_thumb,
  manifest_key = excluded.manifest_key,
  locales = excluded.locales,
  updated_at = datetime('now')`;
  run(["d1", "execute", "animate-licence-db", "--command", upsert, ...d1Args]);

  console.log(`\n✅ ${modelId} 上传完成 (vrm ${(size / 1024 / 1024).toFixed(1)}MB sha256=${sha256.slice(0, 12)}… locales=${locales})`);
  console.log("   模型当前 enabled=1；如需下架: UPDATE catalog_models SET enabled=0 WHERE id=…");
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
