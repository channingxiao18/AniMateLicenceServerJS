-- 0018_telemetry_funnel.sql
-- 目的：为「用户转化路径」报表提供可查的投影表。
--
-- 安全边界（务必遵守）：
--   1) 本迁移**只做 CREATE**，不 ALTER / UPDATE / DELETE 任何既有表；
--   2) 不触碰 telemetry_events（事实源）；新表全部可 DROP 回滚；
--   3) 建表后不自动回填：回填由 scripts/backfill_funnel.sql 手动执行。
--
-- 预算：建表为 DDL，不产生行读取；回填为一次性全表聚合（实测 1~2s，约 33 万行读）。

CREATE TABLE IF NOT EXISTS telemetry_install_profile (
  install_id         TEXT PRIMARY KEY,
  machine_hash       TEXT,
  install_at         TEXT NOT NULL,            -- install_seen 首个 received_at (UTC)
  install_day        TEXT NOT NULL,            -- 'YYYY-MM-DD'
  first_app_version  TEXT NOT NULL,            -- 首见版本（cohort 归属，不用事件版本）
  release_day        TEXT,                     -- 由数据推导：该版本最早 install_day
  platform           TEXT,
  channel            TEXT,
  os_locale          TEXT,
  gpu_tier           TEXT,
  -- 阶段时间戳（UTC epoch 秒；NULL = 未发生）
  t_first_frame      INTEGER,
  t_onb_done         INTEGER,
  t_core             INTEGER,                  -- min(真AI, 导入成功, 舞蹈)
  t_purchase_click   INTEGER,
  t_checkout         INTEGER,
  t_activated        INTEGER,                  -- 服务端真值
  activation_provider TEXT,
  -- 窗口内汇总（首 7 天；窗口口径变更时整表重建即可）
  sessions           INTEGER DEFAULT 0,
  active_days        INTEGER DEFAULT 0,
  max_day_span_secs  INTEGER DEFAULT 0,
  liking_score       INTEGER,                  -- 0~6
  liked              INTEGER DEFAULT 0,        -- score >= 2
  retained           INTEGER DEFAULT 0,        -- active_days >= 2
  trial_granted      INTEGER DEFAULT 0,
  reminder_seen      INTEGER DEFAULT 0,
  f_dance            INTEGER DEFAULT 0,
  f_import           INTEGER DEFAULT 0,
  f_ai               INTEGER DEFAULT 0,
  built_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_tip_day    ON telemetry_install_profile(install_day);
CREATE INDEX IF NOT EXISTS idx_tip_ver    ON telemetry_install_profile(first_app_version, install_day);

-- 按日计数：支撑「任意窗口内的频次/分布」，窗口只是查询参数
CREATE TABLE IF NOT EXISTS telemetry_install_day (
  install_id      TEXT NOT NULL,
  day             TEXT NOT NULL,
  events          INTEGER DEFAULT 0,
  sessions        INTEGER DEFAULT 0,
  span_secs       INTEGER DEFAULT 0,
  dance_n         INTEGER DEFAULT 0,
  import_click_n  INTEGER DEFAULT 0,
  import_ok_n     INTEGER DEFAULT 0,
  real_ai_n       INTEGER DEFAULT 0,
  msg_real_n      INTEGER DEFAULT 0,
  chat_err_n      INTEGER DEFAULT 0,
  purchase_click_n INTEGER DEFAULT 0,
  checkout_n      INTEGER DEFAULT 0,
  reminder_shown_n INTEGER DEFAULT 0,
  PRIMARY KEY (install_id, day)
);

-- 周期快照：报表只读这张（几十~几百行）
CREATE TABLE IF NOT EXISTS telemetry_cohort_snapshot (
  cohort_day      TEXT NOT NULL,
  window_hours    INTEGER NOT NULL,
  segment_key     TEXT NOT NULL DEFAULT 'all',
  funnel_version  TEXT NOT NULL DEFAULT 'v1',
  cohort_complete INTEGER NOT NULL DEFAULT 0,
  cycle           TEXT NOT NULL,
  s0 INTEGER, s1 INTEGER, s2 INTEGER, s3 INTEGER, s4 INTEGER, s5 INTEGER,
  active_core     INTEGER, passive_dance INTEGER,
  onb_started     INTEGER, onb_done INTEGER, onb_zero INTEGER,
  imp_click INTEGER, imp_ok INTEGER, imp_cancel INTEGER, imp_fail INTEGER,
  chat_msg INTEGER, chat_ai INTEGER, chat_err INTEGER,
  trial_granted INTEGER, reminder_shown INTEGER,
  q_checkout      INTEGER,
  PRIMARY KEY (cohort_day, window_hours, segment_key, funnel_version)
);

-- 指标覆盖登记：新埋点没有历史时，报表显示 "—" 而不是 0
CREATE TABLE IF NOT EXISTS telemetry_metric_coverage (
  metric         TEXT PRIMARY KEY,
  first_event_at TEXT,
  note           TEXT
);

INSERT OR IGNORE INTO telemetry_metric_coverage(metric, first_event_at, note) VALUES
  ('purchase_clicked', '2026-08-10 15:55:36', 'site'),
  ('checkout_opened',  '2026-08-10 15:55:37', '与 purchase_clicked 同动作'),
  ('trial_granted',    '2026-09-30 02:57:03', '0.12.0 起'),
  ('license_reminder_shown', '2026-09-01 10:51:48', '次数含每小时重复'),
  ('trial_llm_turn_used', '2026-10-15 00:00:00', '0.13.x 起'),
  ('purchase_prompt_shown', NULL, '未上线；上线后补 first_event_at');
