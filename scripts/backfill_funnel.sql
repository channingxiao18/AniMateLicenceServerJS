-- backfill_funnel.sql —— 一次性回填（只读 telemetry_events，只写 3 张新表）
--
-- 预算控制（重要）：
--   * 三条语句各自只扫一遍窗口内的事件，**不做 N+1**；
--   * 先在 :from / :to 里收窄（建议一次回填 90 天，约 6~8 万行读）；
--   * 全量重跑单次实测 1~2 秒 / 33 万行；日常只跑「最近 7 天」增量。
--
-- 执行顺序：先 1) profile，再 2) day，最后 3) 快照（快照从 profile 聚合，不扫事件）。

-- ① 安装画像 ------------------------------------------------------------
DELETE FROM telemetry_install_profile
WHERE install_day >= :from AND install_day <= :to;

INSERT OR REPLACE INTO telemetry_install_profile (
  install_id, machine_hash, install_at, install_day, first_app_version,
  platform, channel, os_locale, gpu_tier,
  t_first_frame, t_onb_done, t_core, t_purchase_click, t_checkout,
  sessions, trial_granted, reminder_seen, f_dance, f_import, f_ai, built_at
)
WITH inst AS (
  SELECT install_id,
         MIN(received_at) AS install_at,
         MIN(received_at_unix) AS t0,
         MAX(machine_hash) AS machine_hash,
         MAX(app_version) AS ver,
         MAX(platform) AS platform,
         MAX(channel) AS channel
  FROM telemetry_events
  WHERE product_id='animate' AND event='install_seen' AND install_id IS NOT NULL
    AND received_at >= :from AND received_at < :tomorrow
  GROUP BY install_id
),
ev AS (
  SELECT e.install_id,
    MIN(CASE WHEN e.event IN ('first_frame_rendered','frontend_mounted','session_start') THEN e.sent_at END) AS t_frame,
    MIN(CASE WHEN e.event='onboarding_completed' THEN e.sent_at END) AS t_onb,
    MIN(CASE WHEN e.event IN ('model_import_completed','catalog_model_imported','trial_llm_turn_used','dance_started')
              OR (e.event='chat_reply_received' AND json_extract(e.payload_json,'$.mode')='live')
             THEN e.sent_at END) AS t_core,
    MIN(CASE WHEN e.event='purchase_clicked' THEN e.sent_at END) AS t_pc,
    MIN(CASE WHEN e.event='checkout_opened' THEN e.sent_at END) AS t_ck,
    COUNT(DISTINCT CASE WHEN e.event='session_start' THEN e.session_id END) AS sessions,
    MAX(CASE WHEN e.event='trial_granted' THEN 1 ELSE 0 END) AS trial,
    MAX(CASE WHEN e.event='license_reminder_shown' THEN 1 ELSE 0 END) AS rem,
    MAX(CASE WHEN e.event='dance_started' THEN 1 ELSE 0 END) AS f_dance,
    MAX(CASE WHEN e.event IN ('model_import_completed','catalog_model_imported') THEN 1 ELSE 0 END) AS f_imp,
    MAX(CASE WHEN e.event='trial_llm_turn_used'
              OR (e.event='chat_reply_received' AND json_extract(e.payload_json,'$.mode')='live')
             THEN 1 ELSE 0 END) AS f_ai
  FROM telemetry_events e JOIN inst i ON i.install_id = e.install_id
  WHERE e.product_id='animate'
    AND e.sent_at BETWEEN i.t0 - 3600 AND i.t0 + 604800
  GROUP BY e.install_id
)
SELECT i.install_id, i.machine_hash, i.install_at, substr(i.install_at,1,10), i.ver,
       i.platform, i.channel, NULL, NULL,
       ev.t_frame, ev.t_onb, ev.t_core, ev.t_pc, ev.t_ck,
       COALESCE(ev.sessions,0), COALESCE(ev.trial,0), COALESCE(ev.rem,0),
       COALESCE(ev.f_dance,0), COALESCE(ev.f_imp,0), COALESCE(ev.f_ai,0),
       datetime('now')
FROM inst i LEFT JOIN ev ON ev.install_id = i.install_id;

-- ② 按日计数 ------------------------------------------------------------
DELETE FROM telemetry_install_day
WHERE day >= :from AND day <= :to;

INSERT OR REPLACE INTO telemetry_install_day (install_id, day, events, sessions, span_secs,
  dance_n, import_click_n, import_ok_n, real_ai_n, msg_real_n, chat_err_n,
  purchase_click_n, checkout_n, reminder_shown_n)
SELECT install_id,
       substr(datetime(sent_at,'unixepoch'),1,10) AS day,
       COUNT(*),
       COUNT(DISTINCT session_id),
       MAX(sent_at) - MIN(sent_at),
       SUM(CASE WHEN event='dance_started' THEN 1 ELSE 0 END),
       SUM(CASE WHEN event='model_import_clicked' THEN 1 ELSE 0 END),
       SUM(CASE WHEN event IN ('model_import_completed','catalog_model_imported') THEN 1 ELSE 0 END),
       SUM(CASE WHEN event='trial_llm_turn_used'
                  OR (event='chat_reply_received' AND json_extract(payload_json,'$.mode')='live')
                THEN 1 ELSE 0 END),
       SUM(CASE WHEN event='chat_message_sent' AND COALESCE(json_extract(payload_json,'$.scripted'),0)=0
                THEN 1 ELSE 0 END),
       SUM(CASE WHEN event='chat_error' THEN 1 ELSE 0 END),
       SUM(CASE WHEN event='purchase_clicked' THEN 1 ELSE 0 END),
       SUM(CASE WHEN event='checkout_opened' THEN 1 ELSE 0 END),
       SUM(CASE WHEN event='license_reminder_shown' THEN 1 ELSE 0 END)
FROM telemetry_events
WHERE product_id='animate' AND install_id IS NOT NULL
  AND received_at >= :from AND received_at < :tomorrow
GROUP BY install_id, day;

-- ③ 周期快照（从 profile 聚合，不扫事件；报表只读这张）----------------
DELETE FROM telemetry_cohort_snapshot
WHERE cohort_day >= :from AND cohort_day <= :to AND funnel_version='v1';

INSERT OR REPLACE INTO telemetry_cohort_snapshot (
  cohort_day, window_hours, segment_key, funnel_version, cohort_complete, cycle,
  s0, s1, s2, s3, s4, s5, active_core, passive_dance,
  onb_started, onb_done, onb_zero, imp_click, imp_ok, imp_cancel, imp_fail,
  chat_msg, chat_ai, chat_err, trial_granted, reminder_shown, q_checkout
)
SELECT install_day, 168, 'all', 'v1',
       CASE WHEN install_day <= date('now','-7 day') THEN 1 ELSE 0 END,
       :cycle,
       COUNT(*),
       SUM(CASE WHEN t_first_frame IS NOT NULL THEN 1 ELSE 0 END),
       SUM(CASE WHEN t_onb_done IS NOT NULL THEN 1 ELSE 0 END),
       SUM(CASE WHEN t_core IS NOT NULL THEN 1 ELSE 0 END),
       SUM(CASE WHEN t_core IS NOT NULL AND liked=1 THEN 1 ELSE 0 END),
       SUM(CASE WHEN t_core IS NOT NULL AND liked=1 AND retained=1 THEN 1 ELSE 0 END),
       SUM(CASE WHEN f_import=1 OR f_ai=1 THEN 1 ELSE 0 END),
       SUM(CASE WHEN f_dance=1 AND f_import=0 AND f_ai=0 THEN 1 ELSE 0 END),
       0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
       SUM(trial_granted), SUM(reminder_seen), 0
FROM telemetry_install_profile
WHERE install_day >= :from AND install_day <= :to
GROUP BY install_day;

-- ④ 派生字段（从 ② 的日表与 activations 补，避免再扫事件）----------------
UPDATE telemetry_install_profile AS p SET
  sessions = COALESCE((SELECT SUM(d.sessions) FROM telemetry_install_day d
                       WHERE d.install_id = p.install_id), 0),
  active_days = COALESCE((SELECT COUNT(*) FROM telemetry_install_day d
                          WHERE d.install_id = p.install_id), 0),
  max_day_span_secs = COALESCE((SELECT MAX(d.span_secs) FROM telemetry_install_day d
                                WHERE d.install_id = p.install_id), 0)
WHERE p.install_day >= :from AND p.install_day <= :to;

UPDATE telemetry_install_profile AS p SET
  liking_score = CASE
      WHEN p.max_day_span_secs < 300 THEN 0
      WHEN p.max_day_span_secs < 900 THEN 1
      WHEN p.max_day_span_secs < 3600 THEN 2
      ELSE 3 END
    + CASE
      WHEN p.active_days <= 1 THEN 0
      WHEN p.active_days = 2 THEN 1
      WHEN p.active_days <= 4 THEN 2
      ELSE 3 END
WHERE p.install_day >= :from AND p.install_day <= :to;

UPDATE telemetry_install_profile
SET liked = CASE WHEN liking_score >= 2 THEN 1 ELSE 0 END,
    retained = CASE WHEN active_days >= 2 THEN 1 ELSE 0 END
WHERE install_day >= :from AND install_day <= :to;

UPDATE telemetry_install_profile AS p SET
  t_activated = (SELECT MIN(a.activated_at) FROM activations a
                 JOIN entitlements en ON en.id = a.entitlement_id
                 WHERE a.telemetry_machine_hash = p.machine_hash),
  activation_provider = (SELECT MIN(en.source_provider) FROM activations a
                 JOIN entitlements en ON en.id = a.entitlement_id
                 WHERE a.telemetry_machine_hash = p.machine_hash)
WHERE p.install_day >= :from AND p.install_day <= :to;
