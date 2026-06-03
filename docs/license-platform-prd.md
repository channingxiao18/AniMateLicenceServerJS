# 多产品授权平台 PRD

## 1. 背景

当前授权服务已经可以完成 AniMate 的基础授权闭环，包括：

- 管理后台批量生成订单码。
- 客户端通过订单码激活。
- 服务端签发本地 licence token。
- 设备解绑、停用、作废、重新激活。
- 接入 Creem licence key，并在激活时调用 Creem API。

但现有模型更偏向“单产品、买断式、单设备优先”的授权服务。随着产品线、支付渠道和授权模式增加，需要升级为一个通用的多产品授权平台。

本 PRD 先从使用场景回归，明确客户端如何集成、服务端如何处理、不同场景允许什么逻辑、禁止什么逻辑。

## 2. 当前路线评估

### 2.1 当前属于哪种用法

现有实现主要覆盖以下用法：

| 维度 | 当前状态 | 说明 |
| --- | --- | --- |
| 产品模型 | 基础支持，但未完整产品化 | 数据库已有 `products`，licence payload 里也有 `product_id`，但 Creem 激活仍依赖默认产品配置。 |
| 授权类型 | 买断式为主 | 激活逻辑中明确限制本地订单只支持 `lifetime`。 |
| 设备策略 | 一个授权码绑定一台机器 | 一个订单关联一个 entitlement，entitlement 只保存一个 fingerprint。 |
| 有效期 | 字段存在，但逻辑未闭环 | `valid_from` / `valid_until` 已存在，但买断逻辑基本写入 null，`/v1/refresh` 尚未实现。 |
| 支付平台 | 已接入 Creem，但耦合较强 | 当前通过判断是否为 Creem key 分支处理，并使用默认产品 ID。 |
| 后台管理 | 订单管理为中心 | 后台围绕订单、日志和简单操作，没有产品、套餐、订阅、支付映射等完整运营能力。 |

因此，当前路线可以定义为：

> 单产品买断授权平台，支持本地订单码和 Creem 外部授权码激活，授权码默认绑定一台机器。

### 2.2 当前方案的优点

- 已经有可工作的激活链路。
- 已经有 `products / entitlements / orders / activation_logs` 的领域雏形。
- licence token 已包含 `product_id / edition / tier / features / max_app_major`。
- 管理后台已有订单操作能力。
- 与旧客户端和旧 Python 版 licence codec 有兼容基础。

### 2.3 当前方案的主要缺口

- 产品和套餐没有明确分层。
- 授权码没有完整支持多设备。
- 有效期和订阅状态没有形成闭环。
- 支付平台逻辑进入激活业务逻辑，耦合偏重。
- 外部支付平台 product / variant / price 没有统一映射到本地 plan。
- 后台缺少产品、套餐、订阅、设备、支付事件、审计日志管理。

### 2.4 新方案是否兼容当前需求

新方案可以兼容当前需求。兼容方式是把当前能力纳入新模型中的一个默认场景：

| 当前概念 | 新模型映射 |
| --- | --- |
| `products` 当前记录 | 可以先作为 `plan` 使用，后续再拆出真正的 `product` 表和 `plans` 表。 |
| `orders.order_id` | 作为内部 license key 或兑换码。 |
| `entitlements` | 继续作为用户授权权益核心表。 |
| `entitlements.fingerprint` | 迁移为 `activations` 表中的单条设备绑定记录。 |
| Creem licence key | 作为外部 provider credential，首次兑换后创建或关联本地 entitlement。 |
| `CREEM_DEFAULT_PRODUCT_ID` | 迁移为 provider mapping 的默认兼容配置。 |
| 当前买断单机授权 | 新模型中的 `billing_model = lifetime` + `license_model = single_machine`。 |

兼容目标：

- 旧的 `AM-XXXXXXXXXXXX` 订单码仍可激活。
- 旧客户端仍可通过 `/v1/activate` 获取 licence。
- 当前 AniMate 买断版可作为默认产品和默认套餐继续运行。
- 新客户端可以逐步增加 `product_id`、`refresh`、多设备展示等能力。
- Creem 现有授权码仍可兑换，但后续不再把 Creem 当作核心授权主键。

## 3. 产品目标

### 3.1 必须支持

1. 一个授权平台支持多款产品。
2. 授权码支持单机器和多机器策略。
3. 授权模式支持买断式和订阅制。
4. 授权平台可以接入多个支付平台，并兼容外部平台授权码。
5. 客户端只接入统一授权 API，不直接感知支付平台差异。
6. 服务端内部解耦支付平台、授权权益、设备激活和 licence 签发。

### 3.2 暂不优先

- 完整账号体系。
- 客户自助门户。
- 企业 SSO。
- 复杂团队成员邀请。
- 多租户 SaaS 控制台。

这些能力可以在多产品、多套餐、多设备、订阅闭环稳定后再扩展。

## 4. 核心概念

> **三个容易混淆的关键概念，先厘清：**

| 概念 | 谁生成 | 存在哪里 | 用途 | 举例 |
|------|--------|---------|------|------|
| **兑换码** (license_key) | 管理后台批量生成 / 支付平台分发 | `licenses` 表 (PK) | 用户购买后拿到的兑换凭证，在客户端激活界面输入 | `AM-IDROMZQJOYDQ`、`40TJ0-U89OC-8843Y-37N0L-OU2D6` |
| **机器指纹** (fingerprint / machine_id) | 客户端采集硬件信息后生成 | `activations` 表 | 唯一标识一台设备，服务端据此判定设备数量是否超限 | `e8a7c3f0...` 长哈希 |
| **授权令牌** (signed licence token) | 服务端实时签发（不存库） | 仅客户端本地保存 | RSA 签名 + AES 加密的授权凭证，客户端离线验签即可判断是否有效。**它是"真正的授权凭证"** | `IV(32)+LEN(8)+CT+SIG(256)` 几百字节的长字符串 |

**三者关系**：用户拿着兑换码 → 在客户端输入 → 客户端采集机器指纹 → 一起发给服务端激活 → 服务端验证兑换码有效后，签发一个包含机器指纹的授权令牌 → 客户端保存授权令牌到本地。后续 refresh / deactivate 操作都要求携带授权令牌证明身份。

### 4.1 Product

产品，例如：

- AniMate
- AniMuse
- AniRender

产品是客户端识别和授权隔离的边界。客户端必须带 `product_id` 激活，服务端必须校验授权是否属于该产品。

### 4.2 Plan

套餐或 SKU，例如：

- AniMate Basic Lifetime
- AniMate Pro Lifetime
- AniMate Pro Monthly
- AniMate Team Yearly
- AniMate Trial 14 Days

Plan 决定授权策略，包括：

- 买断、订阅、限时、试用。
- 单设备或多设备。
- 最大设备数。
- 有效期。
- 宽限期。
- 可用功能。
- 最大支持 App 主版本。

### 4.3 兑换码 (License Key)

用户输入的兑换凭证，常见形式：

- 平台内部生成（`AM-XXXXXXXXXXXX` 格式）。
- Creem 分发（`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` 5 段 dash 分隔）。
- Stripe / Lemon Squeezy / Paddle 等将来接入的支付平台分发的各种格式。
- 管理员手动导入或代理商渠道分发的码。

**客户端不区分兑换码来源。** 它只是一个字符串，用户粘贴到激活框。服务端负责识别来源、调用对应平台验证（仅首次）、导入本地并签发真正的授权令牌。

> 兑换码 ≠ 授权令牌（signed licence token）。兑换码是用户购买后拿到的凭证，授权令牌是服务端在验证兑换码有效后签发的加密凭证，包含机器指纹。

### 4.4 Entitlement

授权权益。它表示某个用户、订单、订阅或手工发放行为最终拥有的产品权限。

Entitlement 是授权平台的核心，不应该直接等同于支付平台订单。

### 4.5 Activation

设备激活记录。一个 entitlement 可以对应一台或多台机器。

### 4.6 Subscription

订阅记录。订阅状态由支付平台 webhook 或后台操作更新，并影响 entitlement 是否可用。

### 4.7 Provider Mapping

支付平台商品和本地产品套餐之间的映射，例如：

| Provider | 外部商品 | 本地产品 | 本地套餐 |
| --- | --- | --- | --- |
| Creem | product `prod_123` | AniMate | Pro Lifetime |
| Lemon Squeezy | variant `456789` | AniMate | Pro Yearly |
| Stripe | price `price_abc` | AniMate | Pro Monthly |

支付平台变化时，只需要修改 adapter 和 mapping，不应该修改核心授权逻辑。

## 5. 总体架构原则

### 5.1 客户端统一接入

客户端只调用授权平台：

```text
POST /v1/activate
POST /v1/refresh
POST /v1/deactivate
GET  /v1/license/status
```

客户端不直接调用 Creem、Lemon Squeezy、Stripe 或其他支付平台。

### 5.2 服务端分层

```text
Provider Adapter
  负责支付平台差异、验签、外部 API、原始事件解析

Billing Layer
  负责把外部事件转换为统一支付事件

Entitlement Engine
  负责产品、套餐、授权状态、有效期、订阅策略

Activation Engine
  负责设备绑定、解绑、设备数量限制

Licence Issuer
  负责签发和刷新本地 signed licence
```

### 5.3 支付平台解耦

禁止把支付平台对象作为授权核心模型。

不推荐：

```text
creem_license_key -> licence
stripe_price_id -> product
lemonsqueezy_variant_id -> entitlement
```

推荐：

```text
external provider data
  -> provider mapping
  -> local product / plan
  -> entitlement
  -> activation
  -> signed licence
```

## 6. 客户端集成方式

### 6.1 首次激活

请求：

```json
{
  "product_id": "animate",
  "license_key": "XXXX-XXXX",
  "machine_id": "machine-001",
  "app_version": "1.2.0",
  "platform": "windows"
}
```

响应：

```json
{
  "licence": "SIGNED_TOKEN",
  "entitlement": {
    "product_id": "animate",
    "plan_id": "animate-pro-lifetime",
    "billing_model": "lifetime",
    "license_model": "single_machine",
    "status": "active",
    "valid_until": null,
    "features": ["pro"],
    "max_activations": 1,
    "used_activations": 1
  }
}
```

客户端职责：

- 采集稳定的 `machine_id`。
- 传入当前产品的 `product_id`。
- 保存服务端返回的 signed licence。
- 展示授权状态、有效期和设备数量。

客户端禁止：

- 自己判断支付平台。
- 自己决定授权有效期。
- 自己决定设备上限。
- 不传 `product_id`。

### 6.2 启动校验

客户端启动时应优先校验本地 signed licence。

如果本地 licence 有效：

- 买断版可以直接启动。
- 订阅版如果接近过期，应后台调用 `/v1/refresh`。

如果本地 licence 过期或缺失：

- 调用 `/v1/refresh`。
- refresh 失败时进入未授权状态或受限模式。

### 6.3 刷新授权

订阅和限时授权需要 refresh。

请求：

```json
{
  "product_id": "animate",
  "license_key": "XXXX-XXXX",
  "machine_id": "machine-001",
  "app_version": "1.2.0",
  "platform": "windows"
}
```

服务端根据 entitlement、subscription、activation 判断是否重新签发 licence。

### 6.4 解绑设备

请求：

```json
{
  "product_id": "animate",
  "license_key": "XXXX-XXXX",
  "machine_id": "machine-001"
}
```

是否允许客户端自助解绑，由 plan 策略决定。

## 7. 场景矩阵

### 7.1 买断授权，一个兑换码绑定一台机器

适用场景：

- 个人版。
- 基础买断版。
- 当前 AniMate 默认授权模式。

客户端使用：

- 首次激活调用 `/v1/activate`。
- 启动时校验本地 signed licence。
- 同一机器可重复激活或重新获取 licence。
- 换机器需要先解绑旧机器，或由管理员后台解绑。

服务端逻辑：

1. 根据 `license_key` 找到或兑换 entitlement。
2. 校验 `product_id` 是否匹配。
3. 校验 plan 为 `lifetime`。
4. 校验设备数量上限为 1。
5. 如果当前 machine 已绑定，允许 reissue。
6. 如果没有设备绑定，绑定当前 machine。
7. 如果已绑定其他 machine，拒绝激活。

允许：

- 首次激活。
- 同机重复激活。
- 管理员解绑。
- 按策略允许当前机器自助解绑。

禁止：

- 第二台机器直接激活。
- 跨产品激活。
- 已撤销、暂停授权继续激活。
- 客户端修改设备数和有效期。

### 7.2 买断授权，一个兑换码允许多台机器

适用场景：

- Pro 版。
- 家庭版。
- 小团队版。

客户端使用：

- 多台机器使用同一个 license key 激活。
- 客户端展示 `used_activations / max_activations`。
- 客户端可按策略解绑当前机器。

服务端逻辑：

1. 查询 entitlement。
2. 查询 activation 列表。
3. 如果 machine 已存在，允许 reissue。
4. 如果 machine 不存在且未达到上限，新增 activation。
5. 如果达到上限，拒绝激活。

允许：

- 多台机器激活，直到达到上限。
- 同一机器 refresh 或 reissue。
- 管理员增加设备额度。
- 管理员解绑任意设备。

禁止：

- 超过设备上限。
- 客户端解绑其他机器。
- 客户端传入自定义 `max_activations`。
- 跨产品激活。

### 7.3 限时授权

适用场景：

- 试用。
- 活动码。
- 临时授权。
- 售后补偿。

客户端使用：

- 首次激活调用 `/v1/activate`。
- 启动时检查本地 licence 是否过期。
- 快过期时调用 `/v1/refresh`。

服务端逻辑：

1. 首次激活时写入 `valid_from`。
2. 根据 plan 的 `duration_days` 计算 `valid_until`。
3. 签发带有效期的 licence。
4. refresh 时检查是否仍在有效期内。

允许：

- 有效期内激活和刷新。
- 后台延长有效期。
- 后台转换为正式授权。

禁止：

- 过期后继续 refresh。
- 过期后绑定新设备。
- 通过重复激活重置试用期。
- 客户端决定试用开始时间。

### 7.4 订阅制授权

适用场景：

- 月付。
- 年付。
- 持续更新付费。

客户端使用：

- 首次激活调用 `/v1/activate`。
- 启动时优先校验本地短期 licence。
- 定期调用 `/v1/refresh`。
- 订阅过期后进入未授权状态或受限模式。

服务端逻辑：

1. 支付平台 webhook 创建或更新 subscription。
2. subscription 影响 entitlement 状态。
3. `valid_until` 设置为当前订阅周期结束时间。
4. refresh 时根据 subscription 状态重新签发短期 licence。

允许：

- `active` 状态允许新设备激活和 refresh。
- `canceled` 但未到周期结束时继续允许使用。
- 续费成功后延长 `valid_until`。
- 管理员手动补偿天数。

禁止：

- 订阅授权签发永久 licence。
- 过期后继续 refresh。
- 退款或拒付后继续使用。
- 客户端绕过 refresh 长期离线使用。

### 7.5 支付失败和宽限期

适用场景：

- 订阅扣款失败。
- 信用卡临时失败。
- 支付平台进入 past_due。

客户端使用：

- 调用 `/v1/refresh`。
- 如果响应为 grace 状态，展示续费或支付异常提醒。

服务端逻辑：

1. 收到 `payment.failed` 事件。
2. subscription 状态变为 `past_due`。
3. entitlement 状态变为 `grace`。
4. `valid_until` 可延长到原周期结束时间加 `grace_days`。

允许：

- 宽限期内已有设备 refresh。
- 支付恢复后恢复 active。
- 返回 warning 给客户端展示。

禁止：

- 宽限期结束后继续 refresh。
- 宽限期内新增设备，除非 plan 明确允许。
- 无限延长宽限期。

推荐规则：

| 状态 | 已有设备 refresh | 新设备激活 |
| --- | --- | --- |
| active | 允许 | 允许 |
| grace | 允许 | 默认禁止 |
| expired | 禁止 | 禁止 |
| revoked | 禁止 | 禁止 |

### 7.6 退款、拒付和风控撤销

适用场景：

- refund。
- chargeback。
- 盗刷。
- 授权码泄露。

客户端使用：

- 客户端无需知道具体支付事件。
- 下次 refresh 或在线校验时收到授权失效。

服务端逻辑：

1. 收到退款、拒付或后台撤销。
2. entitlement 状态变为 `revoked`。
3. subscription 可标记为 `revoked` 或 `canceled`。
4. 保留 activation 和日志记录。

允许：

- 管理员查看撤销原因。
- 管理员补发新授权。
- 保留审计日志。

禁止：

- activate。
- refresh。
- deactivate 后重新占用。
- 普通后台操作直接恢复 revoked 授权。

### 7.7 多产品授权

适用场景：

- 一个授权平台同时服务多个桌面产品。

客户端使用：

每个产品客户端必须传自己的 `product_id`。

```json
{
  "product_id": "animate",
  "license_key": "XXXX",
  "machine_id": "machine-001"
}
```

服务端逻辑：

1. `license_key` 定位 entitlement。
2. entitlement 定位 plan。
3. plan 定位 product。
4. 请求中的 `product_id` 必须和 entitlement 所属 product 一致。

允许：

- 一个授权平台服务多个产品。
- 一个客户拥有多个产品授权。
- 后台按产品筛选授权、订单、订阅、设备。

禁止：

- Product A 的授权激活 Product B。
- 客户端不传 `product_id`。
- 仅靠 license key 前缀判断产品。
- 支付平台 product id 直接当成本地 product id。

### 7.8 多支付平台外部兑换码

适用场景：

- Creem、Lemon Squeezy、Stripe、Paddle、手工订单并存。

客户端使用：

- 客户端仍只调用 `/v1/activate`、`/v1/refresh`、`/v1/deactivate`。
- 用户输入的可能是内部 license key，也可能是外部平台授权码。
- 客户端不区分来源。

服务端逻辑：

1. 先查内部 license key。
2. 如果不存在，进入 provider adapter 识别或验证。
3. 通过 provider API 或 webhook 结果确认外部授权有效。
4. 根据 provider mapping 找到本地 plan。
5. 创建或关联本地 entitlement。
6. 后续全部使用本地 entitlement。

允许：

- 支持多个 provider。
- 一个本地 plan 映射到多个外部平台商品。
- 外部授权码首次兑换成本地授权。
- webhook 自动创建或更新授权。

禁止：

- 客户端直接调用支付平台。
- 核心业务逻辑散落 `if provider === "creem"`。
- 外部 license key 成为唯一核心主键。
- 没有 mapping 的外部商品自动发授权。

### 7.9 管理员手动发放授权

适用场景：

- 测试。
- 赠送。
- 代理商。
- 企业合同。
- 售后补偿。

客户端使用：

- 用户拿到平台生成的内部 license key。
- 按标准流程激活。

服务端逻辑：

1. 管理员选择 product 和 plan。
2. 设置设备数、有效期、备注、批次。
3. 创建 entitlement 和内部 license key。
4. 等待用户激活。

允许：

- 批量生成。
- 设置备注和批次。
- 延长、暂停、撤销。
- 记录后台操作日志。

禁止：

- 绕过 product / plan 生成裸授权。
- 无审计日志修改授权。
- 普通管理员硬删除授权记录。

### 7.10 企业和团队授权

适用场景：

- 一个授权码给 10 台、50 台或更多设备使用。

客户端使用：

- 团队成员使用同一个 license key 激活。
- 客户端可以展示设备使用数量。

服务端逻辑：

1. plan 设置 `max_activations`。
2. entitlement 可绑定 customer 或 company。
3. activation 表记录每台设备。
4. 后台支持批量解绑和增加席位。

允许：

- 多机器激活。
- 后台增加席位。
- 后台批量解绑。
- 企业离线授权作为高级能力扩展。

禁止：

- 普通客户端查看完整设备列表，除非有账号体系。
- 超过席位。
- 同一 machine_id 伪造多个设备占位。

## 8. 授权策略字段建议

Plan 应该决定授权逻辑，而不是在代码中写死。

```text
license_model:
  single_machine
  multi_machine

billing_model:
  lifetime
  subscription
  fixed_term
  trial

max_activations:
  number

allow_self_deactivate:
  boolean

allow_reactivation:
  boolean

allow_new_device_during_grace:
  boolean

duration_days:
  number | null

billing_period_days:
  number | null

grace_days:
  number | null

refresh_interval_days:
  number | null

offline_cache_days:
  number | null
```

## 9. 状态机建议

### 9.1 Entitlement 状态

| 状态 | 含义 | activate | refresh |
| --- | --- | --- | --- |
| pending | 已创建，未激活 | 允许 | 禁止 |
| active | 正常有效 | 允许 | 允许 |
| grace | 宽限期 | 默认禁止新设备 | 允许已有设备 |
| expired | 已过期 | 禁止 | 禁止 |
| suspended | 暂停 | 禁止 | 禁止 |
| revoked | 作废 | 禁止 | 禁止 |

### 9.2 Activation 状态

| 状态 | 含义 |
| --- | --- |
| active | 当前设备有效 |
| deactivated | 用户或管理员解绑 |
| revoked | 设备绑定被撤销 |

### 9.3 Subscription 状态

| 状态 | 含义 |
| --- | --- |
| active | 正常订阅 |
| trialing | 试用订阅 |
| past_due | 扣款失败，可能进入宽限期 |
| canceled | 已取消，但可能仍在周期内 |
| expired | 周期结束且不可用 |
| revoked | 退款、拒付或风控撤销 |

## 10. API 需求

### 10.1 客户端 API

#### POST /v1/activate

用途：

- 首次激活（用户输入兑换码）。
- 同机重新签发授权令牌。
- 外部兑换码首次兑换（仅首次调外部 API，后续走本地）。

必须参数：

- `product_id`
- `license_key`（兑换码）
- `machine_id`（机器指纹）
- `app_version`
- `platform`

不需要 `licence_token` — 首次激活还没有。

服务端必须检查：

- 兑换码是否存在或可兑换。
- 产品是否匹配。
- plan 是否允许当前操作。
- entitlement 是否有效。
- machine 是否超过设备数量。
- app version 是否被授权覆盖。

#### POST /v1/refresh

用途：

- 刷新订阅授权。
- 刷新限时授权。
- 在线确认授权状态。

服务端必须检查：

- entitlement 状态。
- subscription 状态。
- machine 是否已绑定。
- 是否在有效期或宽限期内。

#### POST /v1/deactivate

用途：

- 当前设备解绑。

服务端必须检查：

- plan 是否允许自助解绑。
- machine 是否属于该授权。
- entitlement 是否允许解绑后重新激活。

#### GET /v1/license/status

用途：

- 查询当前授权状态。
- 客户端展示套餐、有效期、设备数量。

### 10.2 管理后台 API

需要支持：

- 产品 CRUD。
- 套餐 CRUD。
- 授权码创建、批量创建。
- 授权详情查询。
- 延长有效期。
- 增加设备数。
- 解绑设备。
- 暂停、恢复、撤销授权。
- 支付平台 mapping 配置。
- webhook 事件查看和重试。
- 审计日志查看。

### 10.3 支付平台 API

需要支持：

```text
POST /webhooks/:provider
```

服务端处理流程：

1. 验签。
2. 保存 raw event。
3. 去重。
4. 转换为 canonical event。
5. 根据 provider mapping 找到本地 plan。
6. 创建或更新 customer、subscription、entitlement。
7. 写入处理结果。

## 11. 支付平台解耦需求

### 11.1 Canonical Payment Event

外部事件应该转换为内部统一事件：

```ts
type CanonicalPaymentEvent = {
  provider: "creem" | "lemonsqueezy" | "stripe" | "paddle" | "manual";
  eventType:
    | "purchase.completed"
    | "subscription.created"
    | "subscription.renewed"
    | "subscription.cancelled"
    | "payment.failed"
    | "refund.created"
    | "chargeback.created";
  externalCustomerId?: string;
  externalOrderId?: string;
  externalSubscriptionId?: string;
  externalLicenseKey?: string;
  externalProductId?: string;
  externalVariantId?: string;
  occurredAt: string;
  rawPayload: unknown;
};
```

### 11.2 Provider Adapter 职责

Provider adapter 只负责支付平台相关逻辑：

- webhook 验签。
- 外部 API 调用。
- 外部授权码验证。
- 外部商品 ID 解析。
- 转换 canonical event。

Provider adapter 禁止：

- 直接决定本地授权套餐。
- 直接签发 licence。
- 直接绕过 entitlement engine 写设备绑定。

## 12. 后台管理需求

### 12.1 产品管理

- 创建产品。
- 启用、停用产品。
- 配置产品展示名称。
- 查看产品下的套餐、授权、订阅和设备。

### 12.2 套餐管理

- 设置 billing model。
- 设置 license model。
- 设置设备数量。
- 设置有效期、宽限期、刷新周期。
- 设置功能列表。
- 设置最大支持 App 主版本。

### 12.3 授权管理

- 搜索 license key、邮箱、订单号、机器 ID。
- 查看授权来源。
- 查看绑定设备。
- 查看有效期和状态。
- 延长、暂停、恢复、撤销。
- 增加设备数。
- 解绑设备。

### 12.4 订阅管理

- 查看订阅状态。
- 查看当前周期结束时间。
- 查看支付失败和宽限期状态。
- 手动同步支付平台状态。
- 手动补偿天数。

### 12.5 支付平台管理

- 配置 provider。
- 配置 provider mapping。
- 查看 webhook 事件。
- 查看处理失败原因。
- 手动重试。

### 12.6 审计日志

所有后台关键操作必须记录：

- 操作人。
- 操作时间。
- 操作对象。
- 操作前后状态。
- 操作原因。

## 13. 兼容和迁移策略

### 13.1 第一阶段：兼容现有模式

目标：

- 保持当前 AniMate 买断单机授权可用。
- 让现有 `AM-` 订单码继续激活。
- 让 Creem key 继续激活。
- 新增 `product_id` 参数，但可给旧客户端保留默认值。

实现建议：

- 保留现有 `/v1/activate`。
- 新客户端传 `product_id`。
- 旧客户端未传时，服务端使用默认产品兼容。
- Creem 默认产品 ID 迁移到 provider mapping，但保留旧配置作为 fallback。

### 13.2 第二阶段：产品和套餐分层

目标：

- 明确拆出 product 和 plan。
- 当前 `products` 数据可迁移为默认 plan。
- 后台支持产品和套餐配置。

### 13.3 第三阶段：多设备

目标：

- 新增 activation 表。
- 将 entitlement 中单个 fingerprint 迁移为 activation 记录。
- 支持 `max_activations`。

### 13.4 第四阶段：有效期和 refresh

目标：

- `valid_until` 真正参与激活和刷新判断。
- 实现 `/v1/refresh`。
- 限时授权和订阅授权签发短期 licence。

### 13.5 第五阶段：支付平台解耦

目标：

- 新增 provider adapter。
- 新增 provider mapping。
- 新增 webhook events。
- Creem 逻辑从 activation service 中下沉到 adapter。

### 13.6 第六阶段：订阅闭环

目标：

- 新增 subscriptions。
- 支持 purchase、renewal、cancel、payment failed、refund。
- entitlement 根据 subscription 状态自动变化。

## 14. 验收标准

### 14.1 多产品

- Product A 授权不能激活 Product B。
- 同一平台可同时创建多个产品和套餐。
- 后台可按产品筛选授权记录。

### 14.2 单设备和多设备

- 单设备授权只能绑定一台机器。
- 多设备授权可绑定 N 台机器。
- 超过设备数时拒绝激活。
- 同一设备重复激活不重复占用名额。

### 14.3 买断

- 买断授权可长期使用。
- 买断授权可离线校验本地 licence。
- 撤销后不能 refresh 或重新激活。

### 14.4 订阅

- active 订阅可 refresh。
- canceled 但未到期订阅可继续使用。
- past_due 可进入宽限期。
- expired / revoked 禁止 refresh。
- 订阅授权不签发永久 licence。

### 14.5 多支付平台

- Creem、Lemon Squeezy、Stripe 等平台通过 adapter 接入。
- 外部商品必须通过 mapping 映射到本地 plan。
- 没有 mapping 的商品不能自动创建授权。
- 客户端不需要知道授权码来源。

### 14.6 后台

- 管理员可创建产品、套餐和授权码。
- 管理员可查看授权详情和设备列表。
- 管理员可延长、解绑、暂停、恢复、撤销授权。
- 所有关键操作有审计日志。

## 15. 后续设计任务

完成本 PRD 后，建议继续输出以下设计文档：

1. 数据模型设计。
2. API 设计。
3. 支付平台 adapter 设计。
4. 后台管理页面信息架构。
5. 迁移方案。
6. 测试用例矩阵。
