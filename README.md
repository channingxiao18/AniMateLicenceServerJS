# AniMate Licence Server (Cloudflare Workers)

AniMate 桌面陪伴软件的授权服务端，运行在 Cloudflare Workers + D1 上。

## 技术栈

- **运行时**: Cloudflare Workers
- **框架**: Hono
- **数据库**: Cloudflare D1 (SQLite)
- **ORM**: Drizzle ORM
- **加密**: Web Crypto API

## 快速开始

```bash
# 安装依赖
npm install

# 运行测试
npm test

# 转换密钥格式 (PKCS#1 DER → PKCS#8 DER)
# 首先确保 keys/private.hex 和 keys/public.hex 存在
# 可以从 Python 版项目 ../AniMateLicenceServer/keys/ 复制
npm run convert-key

# 创建 .dev.vars 并填入转换后的密钥
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，设置 RSA_PRIVATE_KEY_PKCS8_HEX 为转换后的值

# 创建 D1 数据库 (本地)
npx wrangler d1 create animate-licence-db

# 生成并执行数据库迁移
npm run db:generate
npm run db:migrate:local

# 启动开发服务器
npm run dev
```

## API 端点

### 面向客户端 (v1)
- `POST /v1/activate` — 激活许可证
- `POST /v1/deactivate` — 停用许可证
- `POST /v1/refresh` — 订阅刷新 (暂未实现)

### 管理后台
- `GET /admin/` — 仪表板
- `GET /admin/orders` — 订单管理
- `GET /admin/orders/:id` — 订单详情
- `GET /admin/logs` — 激活日志

### 管理 REST API
- `POST /admin/api/orders/batch` — 批量生成订单
- `POST /admin/api/orders/:id/unbind` — 解绑设备
- `POST /admin/api/orders/:id/deactivate` — 停用授权
- `POST /admin/api/orders/:id/revoke` — 作废订单
- `POST /admin/api/orders/:id/reactivate` — 重新激活

### 其他
- `GET /health` — 健康检查
- `GET /` — 重定向到管理后台

## 部署

```bash
# 设置密钥
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put RSA_PRIVATE_KEY_PKCS8_HEX

# 部署
npm run deploy
```

## 与 Python 版的兼容性

JS 版本与 Python 版本在许可证编解码层面**逐字节兼容**：
- 许可证格式: IV(32) + LEN(8) + CIPHERTEXT + SIGNATURE(256)
- AES-256-CBC + PKCS#7 填充
- RSA-1024 PKCS#1 v1.5 SHA-1 签名
- 签名覆盖 hex 密文字符串的 ASCII 字节

已通过双向交叉兼容验证 (Python 签发 → JS 解密, JS 签发 → Python 解密)。
