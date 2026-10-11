-- 官方社群入口（QQ 群 / Discord）的远程配置位。
--
-- Key-value 单表，理由同 catalog_settings：换群号 / 换邀请链接不该发客户端版本。
-- 客户端在启动后异步延迟拉取，拉不到就回落到自己编译期里的默认值，所以这张表
-- **永远不是**入口可用的前提 —— 它只是让运营不用发版就能改内容。
--
-- 缺 key = 未配置：客户端把空字符串当"该渠道未配置"，对应入口不展现
-- （不会渲染一个点进去是空号的按钮）。

CREATE TABLE `community_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

-- 版本号：每次通过后台上报时 +1（见 src/services/community.ts）。
-- 客户端只在"响应版本 >= 本地缓存版本"时采纳：CDN 边缘节点可能还挂着旧响应，
-- 没有这个版本号，同一台机器会看到群号在两次启动之间来回横跳。
--
-- 初值 1 而不是 0：下面已经填了真实内容，内容存在就该有一个版本。
INSERT INTO `community_settings` (`key`, `value`) VALUES ('revision', '1')
ON CONFLICT(`key`) DO NOTHING;

-- QQ 群（2026-10-10 上线）：与客户端 src-tauri/src/community.rs 的编译期默认值一致。
-- 两处都填是刻意的——服务端这份让换群不必发版，客户端那份让断网 / 服务端故障时
-- 新装用户仍能进群。改群号时先改这里（客户端下次启动即生效），觉得需要"离线用户也
-- 立刻看到"时再把编译期默认值一起改并发布。
INSERT INTO `community_settings` (`key`, `value`) VALUES ('qq_group_number', '1129250160')
ON CONFLICT(`key`) DO NOTHING;
INSERT INTO `community_settings` (`key`, `value`) VALUES ('qq_join_url', 'https://qm.qq.com/q/SzedH1r18O')
ON CONFLICT(`key`) DO NOTHING;

-- Discord 邀请链接待定：空 = 该渠道未配置，客户端整条不渲染（不会出现空按钮）。
-- 拿到链接后 POST /admin/api/community/info 填上即可，不必发客户端版本。
INSERT INTO `community_settings` (`key`, `value`) VALUES ('discord_invite_url', '')
ON CONFLICT(`key`) DO NOTHING;
