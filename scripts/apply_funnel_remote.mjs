// 通过 D1 REST API 执行迁移 + 回填（逐条语句），规避 wrangler 的 fetch 抖动。
// 用法: node scripts/apply_funnel_remote.mjs --from 2026-09-01 --to 2026-10-11 [--dry]
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.join(HERE, "..");
const envTxt = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
const pick = (k) => (envTxt.match(new RegExp(k + "\\s*=\\s*(\\S+)")) || [])[1];
const TOKEN = pick("CLOUDFLARE_API_TOKEN");
const ACCOUNT = pick("CLOUDFLARE_ACCOUNT_ID");
const DB = "e2c38144-73ff-4f84-b1b9-4d859db796ec";
if (!TOKEN || !ACCOUNT) throw new Error("缺少 CLOUDFLARE_API_TOKEN / ACCOUNT_ID");

const from = opt("--from", "2026-09-01");
const to = opt("--to", new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10));
const tomorrow = new Date(Date.parse(to + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
const cycle = new Date().toISOString().slice(0, 10);

function splitStatements(sql) {
  // 先去掉整行注释，再按分号切分（不能按“首行是注释”丢弃，否则 CREATE TABLE 会被漏掉）
  const noComments = sql.replace(/^\s*--.*$/gm, "");
  return noComments
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runOne(sql, label) {
  if (dry) {
    console.log(`[dry] ${label}: ${sql.slice(0, 70).replace(/\s+/g, " ")}...`);
    return;
  }
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(JSON.stringify(json.errors));
      const meta = json.result?.[0]?.meta || {};
      console.log(`ok ${label} (rows_written=${meta.rows_written ?? 0}, read=${meta.rows_read ?? 0})`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  retry ${attempt} ${label}: ${msg.slice(0, 120)}`);
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const migration = fs.readFileSync(path.join(ROOT, "migrations", "0018_telemetry_funnel.sql"), "utf8");
const backfillRaw = fs.readFileSync(path.join(ROOT, "scripts", "backfill_funnel.sql"), "utf8");
const backfill = backfillRaw
  .split(":tomorrow").join(`'${tomorrow}'`)
  .split(":from").join(`'${from}'`)
  .split(":to").join(`'${to}'`)
  .split(":cycle").join(`'${cycle}'`);

console.log(`migration: ${splitStatements(migration).length} stmts | backfill: ${splitStatements(backfill).length} stmts | window ${from}~${to}`);

let n = 0;
for (const sql of splitStatements(migration)) {
  n += 1;
  await runOne(sql, `migrate#${n}`);
}
n = 0;
for (const sql of splitStatements(backfill)) {
  n += 1;
  await runOne(sql, `backfill#${n}`);
}
console.log("done");
