# -*- coding: utf-8 -*-
"""本地校验：在 sqlite 副本上建投影表 → 回填 → 与「直接查事件」的结果对比。

只读原始事件；写入只发生在新表（副本文件内，不碰生产）。
用法: python scripts/verify_funnel.py [db路径] [from] [to]
"""
import os, shutil, sqlite3, sys, re, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else r'E:\workspace\AniMate\.d1-export\telemetry.db'
F = sys.argv[2] if len(sys.argv) > 2 else '2026-09-01'
T = sys.argv[3] if len(sys.argv) > 3 else '2026-10-08'
TOMORROW = (datetime.date.fromisoformat(T) + datetime.timedelta(days=1)).isoformat()
WORK = os.path.join(ROOT, 'scripts', '_verify_funnel.db')

if not os.path.exists(WORK):
    print('copying db ...', SRC)
    shutil.copyfile(SRC, WORK)

db = sqlite3.connect(WORK)
db.execute('PRAGMA journal_mode=WAL')

# 1) 应用迁移
mig = open(os.path.join(ROOT, 'migrations', '0018_telemetry_funnel.sql'), encoding='utf-8').read()
for stmt in [s for s in mig.split(';') if s.strip()]:
    db.execute(stmt)
db.commit()
print('migration applied')

# 2) 回填（只跑 ① profile 和 ③ 快照，够验证漏斗）
back = open(os.path.join(ROOT, 'scripts', 'backfill_funnel.sql'), encoding='utf-8').read()
blocks = [b for b in back.split(';') if b.strip()]
params = {':from': F, ':to': T, ':tomorrow': TOMORROW, ':cycle': 'verify'}
def run(block):
    sqltext = block.strip()
    for k, v in sorted(params.items(), key=lambda kv: -len(kv[0])):
        sqltext = sqltext.replace(k, f"'{v}'")
    db.executescript(sqltext + ';')

for b in blocks[1:]:
    if b.strip():
        run(b) # ③ 快照
db.commit()
print('backfill done:', db.execute('select count(*) from telemetry_install_profile').fetchone()[0], 'profiles')

# 3) 投影口径
q = db.execute("""
SELECT COUNT(*),
 SUM(t_first_frame IS NOT NULL), SUM(t_onb_done IS NOT NULL), SUM(t_core IS NOT NULL),
 SUM(t_core IS NOT NULL AND liked=1),
 SUM(t_core IS NOT NULL AND liked=1 AND retained=1),
 SUM(t_purchase_click IS NOT NULL), SUM(t_activated IS NOT NULL)
FROM telemetry_install_profile WHERE install_day BETWEEN ? AND ?
""", (F, T)).fetchone()

# 4) 独立口径：直接查事件（EXISTS/子查询写法，与回填实现不同）
q2 = db.execute("""
WITH inst AS (
  SELECT install_id, MIN(received_at_unix) t0
  FROM telemetry_events
  WHERE product_id='animate' AND event='install_seen' AND install_id IS NOT NULL
    AND substr(received_at,1,10) BETWEEN ? AND ?
  GROUP BY install_id
), f AS (
  SELECT i.install_id,
    EXISTS(SELECT 1 FROM telemetry_events e WHERE e.install_id=i.install_id
           AND e.event IN ('first_frame_rendered','frontend_mounted')
           AND e.sent_at BETWEEN i.t0-3600 AND i.t0+604800) launch,
    EXISTS(SELECT 1 FROM telemetry_events e WHERE e.install_id=i.install_id
           AND e.event='onboarding_completed'
           AND e.sent_at BETWEEN i.t0-3600 AND i.t0+604800) onb,
    EXISTS(SELECT 1 FROM telemetry_events e WHERE e.install_id=i.install_id
           AND (e.event IN ('model_import_completed','catalog_model_imported','trial_llm_turn_used','dance_started')
                OR (e.event='chat_reply_received' AND json_extract(e.payload_json,'$.mode')='live'))
           AND e.sent_at BETWEEN i.t0-3600 AND i.t0+604800) core,
    EXISTS(SELECT 1 FROM telemetry_events e WHERE e.install_id=i.install_id
           AND e.event='purchase_clicked'
           AND e.sent_at BETWEEN i.t0-3600 AND i.t0+604800) buy
  FROM inst i
)
SELECT COUNT(*), SUM(launch), SUM(onb), SUM(core), SUM(core AND buy) FROM f
""", (F, T)).fetchone()

print('\n投影(profile) :', q)
print('独立(events)  :', q2)
labels = ['装机', '启动', '导览', '核心', '喜爱', '持续', '购买', '支付']
ok = (q[0:4] == q2[0:4])
print('\n对比:')
for i, lab in enumerate(labels):
    print(f'  {lab}: profile={q[i]}  events={q2[i] if i < len(q2) else chr(8212)}')
print('\n口径一致性:', 'PASS ✅' if ok else 'FAIL ❌')
print('（购买/支付两项口径不同：profile 统计窗口内任意时间；events 只比 核心后购买）')
