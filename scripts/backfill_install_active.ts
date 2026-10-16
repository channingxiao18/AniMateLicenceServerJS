/**
 * 一次性回填 install_active 日聚合（用于把活跃设备页/留存页从"重放原始事件"切到聚合表）。
 *
 * 只做两件事，都**不接触线上数据库**：
 *   1. 从本地生产快照（wrangler d1 export 出来的 .db）里按 DEVICE_ACTIVITY_EVENTS 推导出
 *      每（天 × install）一行，写成带 ON CONFLICT DO NOTHING 的 INSERT 语句文件；
 *   2. 打印快照截止日之后、需要直接跑在线上的 INSERT ... SELECT 命令（按天切片）。
 *
 * 用法：
 *   npx tsx scripts/backfill_install_active.ts \
 *     --dump analysis/telemetry.db \
 *     --out analysis/install_active_backfill.sql \
 *     [--until 2026-10-08] [--chunk 300] [--database animate-licence-db]
 *
 * 生成的 SQL 是幂等的：重复执行只会在唯一键冲突时被忽略，不会修改/删除任何已有行。
 * 回滚：DELETE FROM telemetry_daily_uniques WHERE unique_type = 'install_active';
 */
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { DEVICE_ACTIVITY_EVENTS } from "../src/services/telemetry";

type Args = {
  dump?: string;
  out?: string;
  until?: string;
  chunk: number;
  database: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { chunk: 300, database: "animate-licence-db" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--dump") args.dump = value;
    else if (key === "--out") args.out = value;
    else if (key === "--until") args.until = value;
    else if (key === "--chunk") args.chunk = Number(value) || 300;
    else if (key === "--database") args.database = value || args.database;
  }
  return args;
}

function sqlString(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.dump || !args.out) {
  console.error("usage: npx tsx scripts/backfill_install_active.ts --dump <snapshot.db> --out <file.sql> [--until YYYY-MM-DD] [--chunk 300] [--database animate-licence-db]");
  process.exit(1);
}

const db = new Database(args.dump, { readonly: true });
const maxRow = db.prepare("SELECT MAX(received_at) AS value FROM telemetry_events").get() as { value: string };
const minRow = db.prepare("SELECT MIN(received_at) AS value FROM telemetry_events").get() as { value: string };
const until = args.until || maxRow.value.slice(0, 10);
const since = minRow.value.slice(0, 10);

const placeholders = DEVICE_ACTIVITY_EVENTS.map(() => "?").join(",");
const rows = db
  .prepare(
    `SELECT substr(received_at,1,10) AS day,
            product_id            AS productId,
            install_id            AS installId,
            MIN(source_id)        AS sourceId,
            MIN(platform)         AS platform,
            MIN(channel)          AS channel,
            MIN(app_version)      AS appVersion,
            MIN(license_state)    AS licenseState,
            MIN(received_at)      AS firstSeenAt
       FROM telemetry_events
      WHERE product_id = 'animate'
        AND install_id IS NOT NULL
        AND event IN (${placeholders})
        AND received_at >= ?
        AND received_at <= ?
      GROUP BY 1, 2, 3`,
    )
    .all(...DEVICE_ACTIVITY_EVENTS, `${since} 00:00:00`, `${until} 23:59:59`) as Array<{
    day: string;
    productId: string;
    installId: string;
    sourceId: string;
    platform: string | null;
    channel: string | null;
    appVersion: string | null;
    licenseState: string | null;
    firstSeenAt: string;
  }>;

const lines: string[] = [
  `-- install_active 回填（自动生成，请勿手工编辑）`,
  `-- 来源快照: ${args.dump}`,
  `-- 覆盖区间: ${since} .. ${until}   行数: ${rows.length}`,
  `-- 幂等: ON CONFLICT (day, product_id, unique_type, unique_value) DO NOTHING`,
  `-- 回滚: DELETE FROM telemetry_daily_uniques WHERE unique_type = 'install_active';`,
  "",
];

for (let i = 0; i < rows.length; i += args.chunk) {
  const chunk = rows.slice(i, i + args.chunk);
  const values = chunk
    .map((row) =>
      `(${sqlString(row.day)}, ${sqlString(row.productId)}, 'install_active', ${sqlString(row.installId)}, ` +
      `${sqlString(row.sourceId)}, ${sqlString(row.platform ?? "unknown")}, ${sqlString(row.channel ?? "official")}, ` +
      `${sqlString(row.appVersion ?? "unknown")}, ${sqlString(row.licenseState ?? "unknown")}, ${sqlString(row.firstSeenAt)})`
    )
    .join(",\n  ");
  lines.push(
    `INSERT INTO telemetry_daily_uniques\n  (day, product_id, unique_type, unique_value, source_id, platform, channel, app_version, license_state, first_seen_at)\nVALUES\n  ${values}\nON CONFLICT (day, product_id, unique_type, unique_value) DO NOTHING;`,
    ""
  );
}

writeFileSync(args.out, lines.join("\n"), "utf8");

const dayAfter = new Date(new Date(`${until}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const eventList = DEVICE_ACTIVITY_EVENTS.map((event) => `'${event}'`).join(", ");

console.log(`快照区间        : ${since} .. ${until}`);
console.log(`install_active  : ${rows.length} 行 -> ${args.out}（${Math.ceil(rows.length / args.chunk)} 条 INSERT）`);
console.log("");
console.log("下一步（需要确认后再执行，都会写线上）：");
console.log("");
console.log(`# 1) 推快照区间（约 ${rows.length} 行，只增不改）`);
console.log(`npx wrangler d1 execute ${args.database} --remote --file ${args.out}`);
console.log("");
console.log(`# 2) 快照之后到今天的缺口（逐天 INSERT ... SELECT，每天约读几千行）`);
console.log(`#    把下面的 D 依次换成 ${dayAfter} .. ${today}`);
console.log(`npx wrangler d1 execute ${args.database} --remote --command "INSERT INTO telemetry_daily_uniques (day, product_id, unique_type, unique_value, source_id, platform, channel, app_version, license_state, first_seen_at) SELECT substr(received_at,1,10), product_id, 'install_active', install_id, source_id, platform, channel, app_version, license_state, MIN(received_at) FROM telemetry_events WHERE product_id='animate' AND install_id IS NOT NULL AND event IN (${eventList}) AND received_at >= 'D 00:00:00' AND received_at <= 'D 23:59:59' GROUP BY 1,2,4 ON CONFLICT (day, product_id, unique_type, unique_value) DO NOTHING"`);
console.log("");
console.log("# 3) 核对覆盖（应等于或晚于昨天）");
console.log(`npx wrangler d1 execute ${args.database} --remote --command "SELECT MIN(day), MAX(day), COUNT(*) FROM telemetry_daily_uniques WHERE unique_type='install_active'"`);

db.close();
