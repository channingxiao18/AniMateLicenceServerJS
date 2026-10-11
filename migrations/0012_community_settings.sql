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
INSERT INTO `community_settings` (`key`, `value`) VALUES ('revision', '0')
ON CONFLICT(`key`) DO NOTHING;

-- 三个内容位全部留空：真实群号 / 邀请链接待运营填写。
-- 填写方式：admin 后台 `POST /admin/api/community/info`，或直接改这三行。
INSERT INTO `community_settings` (`key`, `value`) VALUES ('qq_group_number', '')
ON CONFLICT(`key`) DO NOTHING;
INSERT INTO `community_settings` (`key`, `value`) VALUES ('qq_join_url', '')
ON CONFLICT(`key`) DO NOTHING;
INSERT INTO `community_settings` (`key`, `value`) VALUES ('discord_invite_url', '')
ON CONFLICT(`key`) DO NOTHING;
