-- 两个「低频写、高频读」的索引。两条都不含会被高频 UPDATE 修改的列，
-- 因此对心跳 / 试用写入没有写放大（opcode 与 journal 字节实测见
-- docs/telemetry-pagination-optimization-plan-1017.md §5）。
--
-- 1) trial_grants(fingerprint_hash, status)
--    「这台机器有没有有效试用」是 catalog 资格检查（src/services/catalog.ts）
--    与试用 LLM 签发（src/services/llm_trial.ts）的前置判断，两处都只按
--    fingerprint_hash + status 查、不带 product_id；而现有两个索引
--    (product_id, feature, fingerprint_hash) / (product_id, fingerprint_hash)
--    都以 product_id 打头 → 每次都 SCAN 全表（线上约 2,100 行/次，实测 39 次/天）。
--    trial_grants 只在「发放试用 / 状态转 expired」时写，日增几十行，索引维护成本可忽略。
--
-- 2) telemetry_session_state(install_id)
--    活跃设备-某日页要为当前这一页 25 台设备显示「历史累计时长」。旧实现回放该产品
--    全历史的 4 种时长事件（实测 15.9 万行/次，P50 3.0 秒），而入库时
--    updateSessionState 已经把每个会话的累计时长写进这张表，按 install_id 求和即可。
--    该索引只含 install_id；心跳 UPDATE 只改 last_* / updated_at 等未被索引的列，
--    SQLite 不会重写索引项（已用 EXPLAIN + journal 字节对照验证）。
--
-- 3) licenses(created_at) / trial_grants(created_at)
--    兑换码页与试用页都是「按创建时间倒序 + 分页」。这两张表都没有 created_at 索引，
--    所以每次打开页面都是「扫全表 + 临时 B-tree 排序」再看前 30/80 行。
--    两张表的写入都极少（licenses 只在生成兑换码时整批插入，trial_grants 日增几十行），
--    多一个索引项的成本可忽略，换来的是页面只读「当前这一页 + 偏移」的索引项。
--
-- 安全性：CREATE INDEX 只新增索引对象，不读取也不修改任何表的数据行。
-- 回滚：下面四条 DROP 语句可原样撤销（不会丢数据，只是回到旧查询计划）。
--   DROP INDEX IF EXISTS `trial_grants_fingerprint_status_idx`;
--   DROP INDEX IF EXISTS `telemetry_session_state_install_idx`;
--   DROP INDEX IF EXISTS `licenses_created_idx`;
--   DROP INDEX IF EXISTS `trial_grants_created_idx`;

CREATE INDEX IF NOT EXISTS `trial_grants_fingerprint_status_idx`
  ON `trial_grants` (`fingerprint_hash`, `status`);

CREATE INDEX IF NOT EXISTS `telemetry_session_state_install_idx`
  ON `telemetry_session_state` (`install_id`);

CREATE INDEX IF NOT EXISTS `licenses_created_idx`
  ON `licenses` (`created_at`);

CREATE INDEX IF NOT EXISTS `trial_grants_created_idx`
  ON `trial_grants` (`created_at`);
