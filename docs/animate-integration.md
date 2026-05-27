# AniMate 集成 licence.getanimate.app 授权服务

## 概述

将 AniMate 桌面客户端从 `http://127.0.0.1:8787`（本地调试）切换到 `https://licence.getanimate.app`（生产环境）。

> **前提**: 已在 `keys.rs` 编译期配置了 RSA 公钥，已确认客户端和服务端密钥对匹配。

---

## 修改文件清单（只改 2 个文件）

### 1. `src/core/licensing/licenseTypes.ts` — 改 API URL

**第 43 行**，把默认值从本地改成生产地址：

```diff
export const DEFAULT_LICENSE_API_URL =
  (import.meta.env.VITE_LICENSE_API_URL as string | undefined)?.trim() ||
-  "http://127.0.0.1:8787";
+  "https://licence.getanimate.app";
```

> 保留 `VITE_LICENSE_API_URL` 环境变量读取逻辑——本地开发时可以通过 `.env.local` 设回 `http://127.0.0.1:8787` 方便调试。

### 2. `src-tauri/tauri.conf.json` — 改 CSP 白名单

**第 32 行**，`connect-src` 加上生产域名：

```diff
- "connect-src http://127.0.0.1:8787 http://localhost:8787"
+ "connect-src http://127.0.0.1:8787 http://localhost:8787 https://licence.getanimate.app"
```

> Tauri 的 CSP 会拦截 WebView 中的所有 fetch 请求。不加这个白名单，激活 API 请求会被浏览器直接拒绝。

---

## 本地开发（可选）

建 `AniMate/.env.local`：

```
VITE_LICENSE_API_URL=http://127.0.0.1:8787
```

然后 `npm run dev` 走本地 Python 版或 JS 版 `wrangler dev`。

---

## 验证步骤

### 1. 确认 Worker 在线

```powershell
Invoke-RestMethod -Uri https://licence.getanimate.app/health
# 返回 {"status":"ok"}
```

### 2. 构建 AniMate

```powershell
cd E:\workspace\AniMate
npm run tauri build
```

### 3. 测试完整流程

1. 打开构建后的 AniMate
2. 在管理后台 `https://licence.getanimate.app/admin/` 生成订单
3. 在 AniMate 输入订单号激活
4. 检查 VRM/舞蹈/场景导入功能已解锁

---

## 注意事项

| 项目 | 说明 |
|------|------|
| RSA 密钥 | 客户端 `keys.rs` 的公钥必须与服务端私钥匹配，已确认一致 |
| AES 密钥 | 两端的 `EF4A77236A60236EA8B20C1D45F4472A` 一致，已硬编码 |
| 开发模式 | `keys.rs` 公钥为空时激活不校验，所有功能开放 |
| 速率限制 | 生产环境每 IP 每分钟 30 次请求，开发时注意不要触发 |
