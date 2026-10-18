// 回填运行器：把 backfill_funnel.sql 按窗口跑在指定 D1 上。
//
// 用法：
//   node scripts/run_backfill.mjs --local  --from 2026-09-01 --to 2026-10-11
//   node scripts/run_backfill.mjs --remote --from 2026-09-01 --to 2026-10-11 --yes
//
// 安全：
//   * 只执行 migrations/0018 + scripts/backfill_funnel.sql；
//   * 两者都只创建/写入新表（telemetry_install_profile / _day / _cohort_snapshot）；
//   * --remote 必须显式加 --yes，防止误跑生产。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const get = (k, d = null) => {
  const i = args.indexOf(k);
  return i >= 0 ? (args[i + 1] ?? true) : d;
};

const remote = args.includes("--remote");
const local = args.includes("--local");
if (!remote && !local) {
  console.error("需要 --local 或 --remote");
  process.exit(1);
}
if (remote && !args.includes("--yes")) {
  console.error("远程执行需要 --yes 确认（会写入 D1 的新表）");
  process.exit(1);
}

const from = String(get("--from", "2026-09-01"));
const to = String(get("--to", new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10)));
const cycle = String(get("--cycle", new Date().toISOString().slice(0, 10)));
const tomorrow = new Date(Date.parse(to + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const migration = path.join(root, "..", "migrations", "0018_telemetry_funnel.sql");
const backfill = path.join(root, "backfill_funnel.sql");

if (!fs.existsSync(migration)) throw new Error("缺少迁移文件: " + migration);
if (!fs.existsSync(backfill)) throw new Error("缺少回填文件: " + backfill);

function run(file, params) {
  let sql = fs.readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(params)) {
    sql = sql.split(k).join(`'${v}'`);
  }
  const tmp = path.join(root, "_run.sql");
  fs.writeFileSync(tmp, sql, "utf8");
  const d1Args = ["wrangler", "d1", "execute", "animate-licence-db", remote ? "--remote" : "--local", "--file", tmp];
  console.log("$ npx", d1Args.join(" "));
  execFileSync("npx", d1Args, { stdio: "inherit", cwd: path.join(root, "..") });
  fs.rmSync(tmp, { force: true });
}

console.log(`回填窗口 ${from} ~ ${to}（cycle=${cycle}, ${remote ? "REMOTE" : "LOCAL"}）`);
run(migration, {});
run(backfill, { ":from": from, ":to": to, ":tomorrow": tomorrow, ":cycle": cycle });
console.log("完成。请打开 /admin/telemetry/funnel 核对口径。");
