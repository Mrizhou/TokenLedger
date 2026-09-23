# TokenLedger 功能变更与新增说明

> 版本 0.1.1-blue.0 · 本文档覆盖本批次全部修改与新增功能，供使用、验收与后续维护参考。

---

## 一、Z.ai / 智谱 GLM 余额查询改造

### 1.1 接口优先级调整

| 优先级 | 接口 | 说明 |
|---|---|---|
| 1（首选） | `GET /api/biz/account/query-customer-account-report` | 智谱控制台账单页同源接口，数据最全（实测两个 origin 均可用：`open.bigmodel.cn` 与 `api.z.ai`） |
| 2（兜底） | `GET /api/paas/v4/balance` | 旧接口，**已实测在大模型平台返回 404（下线）**，仅作为 report 路由不可用时的兜底 |

- 认证方式：report 路由使用**裸 key**（不带 Bearer 前缀，与 `/api/biz/` 控制台家族一致）；v4 兜底路由保持 Bearer。实测两种认证方式在该路由均被接受。
- 任一路由失败不产生错误卡片，只有两条路由全部失败才显示失败。

### 1.2 字段映射

| 卡片字段 | report 来源 | 说明 |
|---|---|---|
| 余额（主金额） | `data.availableBalance`（缺省回退 `data.balance`） | 当前可用 |
| 已用 | `data.totalSpendAmount` | 累计消费 |
| 货币 | 站点未返回 → 使用 vendor 表 | `open.bigmodel.cn` 显示 ¥ |
| ~~赠送~~ | 已移除 | **充值额不是赠送**——原"其中赠送 ¥50"表述有误，已按用户反馈取消该注释 |

### 1.3 稳定性

- 两个 origin 上 report 均返回 200；旧 v4 路由实测 404，因此 report 是智谱唯一可用钱包数据源，v4 仅兜底未知场景。

---

## 二、New API 个人钱包（新增「设置查询API」功能）

### 2.1 功能入口

New API 站点的余额卡片上，**余额金额文本右侧**有「设置查询API」按钮（失败状态的卡片同样提供）。点击打开设置弹窗。

### 2.2 设置流程（弹窗内置提示）

1. 登录该中转站的网页控制台；
2. 个人设置 → 生成「系统访问令牌」(access_token)；
3. 个人设置 → 复制用户 ID（数字）；
4. 填入弹窗保存。保存后面板对该站改用个人钱包接口查询，**不再消耗模型 key 的查询次数**。

- 令牌输入框为**明文**（方便核对粘贴内容）。
- 已配置过的站点再次打开：用户 ID 自动回填，令牌留空表示"保持不变"。
- 「清除」按钮删除该站点配置，卡片自动回退到模型 key 查询。
- **同一站点的多条路由共用一份配置**（个人钱包按站点用户维度）。

### 2.3 数据读取

- 接口：`GET /api/user/self`，请求头携带 `Authorization: Bearer <令牌>` 与 `New-Api-User: <用户ID>`（令牌只走请求头，绝不进入 URL）。
- 返回映射：

| 卡片显示 | 来源 | 换算 |
|---|---|---|
| 余额 | `data.quota` | ÷ 站点 `quota_per_unit` |
| 已用 | `data.used_quota`（兼容直接返回金额的分支） | 同上 |
| 累计充值 | 余额 + 已用 | 同上 |
| 货币单位 | 站点 `/api/status` 的 `quota_display_type` | `CNY → ¥`、`USD → $`；站点未声明则显示裸数字，**绝不猜符号** |

- **不限额度的 key**：卡片直接以「已用 ¥xx.xx」为主金额（不再显示无意义的负数余额）。

### 2.4 自适应限流查询系统

New API 站点默认限流 **20 分钟 5 次**。系统按站点（origin）维护缓存与退避状态：

| 场景 | 行为 |
|---|---|
| 缓存新鲜（< 5 分钟） | 直接使用缓存，**零网络请求**，面板秒开 |
| 触发限流（HTTP 429 或限流文案） | **沿用上次查询结果**继续显示，小字提示"已限流，HH:MM 前不刷新"；优先采用服务器返回的 `retry-after` / `x-ratelimit-reset` 参数，无参数时指数退避（下限 4 分钟=限流节奏，上限 30 分钟，连续限流翻倍） |
| 退避期内再次打开 | 不发任何请求，继续显示缓存结果 |
| 限流且无历史结果 | 显示"查询已限流，HH:MM 后可再试。" |
| 查询成功 | 退避清零，回 to 5 分钟节奏 |
| 手动刷新（面板刷新按钮） | 跳过新鲜窗口（`?force=1`），但**永远不越过限流退避** |

### 2.5 查询预算保护

配置用户令牌后，该站点**完全跳过**模型 key 的 `/api/usage/token/` 查询，避免挤占站点限流配额。页面加载时的预热请求同样只针对已配置钱包的站点。

### 2.6 存储与安全

- 凭据按**站点（origin）**独立保存在插件 settings 命名空间（`tokenledger.userAuth`），每个站点一条，随 settings.yaml 持久化；
- 令牌只随 `Authorization` 头发送；任何 GET 接口只回显 `userId` 与 `hasToken` 布尔值，**令牌本身永不回传浏览器**；
- 写接口受与读取相同的回环栅栏保护（socket 地址 + Host 双重校验），请求体上限 4KB。

---

## 三、面板 UI / UX 改进

| 项 | 说明 |
|---|---|
| 设置查询API 按钮 | 位于余额金额文本右侧；New API 失败卡同样提供 |
| 已用金额 | 独立一行显示在「账户可用」正下方（小字）；主金额已是已用时自动不重复 |
| 限流提示 | 限流时小字"已限流，HH:MM 前不刷新 · N 分钟前的结果" |
| 缓存年龄行 | 已按要求移除（不再显示"缓存 · N 分钟前"） |
| 用户名 | who 行不再显示用户名（保留 来源 · 程序名） |
| 失败文案 | 空原因不再出现"（）"；未知提示类型回退普通失败文案 |
| 保存失败 404 | 弹窗明确提示"宿主还在运行旧版插件，请完全退出重启" |
| 打开不白屏 | 刷新时保留上一次卡片数据，仅骨架屏消失 |
| 磨砂玻璃 | 账本窗口与设置弹窗为半透明毛玻璃（86%/92% 主题色 + 16px 背景模糊），主题 token 链保留，任意主题下文字对比度有保障 |

---

## 四、HTTP 接口（宿主侧）

| 方法/路径 | 说明 |
|---|---|
| `GET /api/tokenledger/usage` | 面板主数据（不变） |
| `GET /api/tokenledger/balance?account=&force=1` | 余额读取；`force=1` 供刷新按钮跳过新鲜窗口（不越过限流退避） |
| `GET /api/tokenledger/balance?origin=` | **预热**：页面加载时对已配置站点各发一次被动读，首开面板即刻渲染 |
| `GET /api/tokenledger/userauth` | 返回各站点凭据状态（`userId` + `hasToken`，**永不回显令牌**） |
| `POST /api/tokenledger/userauth` | 保存（`{origin, userId, token}`）或清除（`{origin, remove:true}`）；body 上限 4KB；仅回环地址可调用（socket+Host 双校验） |

> 说明：`POST` 是本只读surface 唯一的写例外，只写本插件自己的 settings 命名空间；同一路径由单一注册项按方法内部分派（符合宿主 webserver"路由自管方法"的约定）。

---

## 五、安装与部署

- 装机版按红线 1 从 fork 以 40 位完整 SHA 安装、装完重启宿主（下面的 link/junction 描述为历史做法，已作废）：`profiles/web/node_modules/dsh-tokenledger` → Junction → 仓库目录；profile `package.json` 依赖为 `link:G:/dev/merge/TokenLedger`（ bundles 列表不变，备份在 `package.json.bak-tokenledger`）。
- 仓库自带 `node_modules/@deepseek-ai/schemastery`（→ profile 副本）与 `@deepseek-ai/cordis`（→ profile 副本）junction，供 link 模式下解析 peer/dev 依赖（Node 按 realpath 解析，仓库必须自带依赖）；`node_modules/` 已在 `.gitignore`。
- 宿主半区改动需**完全退出并重启桌面应用**生效；client 半区改动刷新页面即生效。面板数据版本号可通过 `GET /api/tokenledger/usage` 的 `version` 字段核对（当前 0.1.1-blue.0）。

---

## 六、测试与质量

- 测试总量 **516 项，516 通过，0 失败，0 跳过（100%）**（2026-09-23 对抗式审计整体加固后的基线；含 `test/hardening.test.js` 的 17 条变异验证守卫）。
- 新增/覆盖：
  - `test/newapi-user.test.js`：钱包读取映射（双头认证、金额换算、货币单位）、缓存零请求、force 语义、限流退避（含 Retry-After 优先与连续限流翻倍）、401/信封拒绝、`shouldUseWallet` 决策表、`unitFromStatus`；
  - `test/http.test.js`：POST 仅限 userauth 路径、回环栅栏对写请求同样生效、body 上限、userauth 路由 GET 脱敏/POST 落库、balance 查询参数解析；
  - `test/client.test.js`：按钮与弹窗渲染、已用行位置与去重、空括号防护、磨砂背景契约（overlay token 链 + backdrop-filter）；
  - `test/balance.test.js`：report 优先映射、404 回退、report 拒绝仍回退、双失败取旧路由错误、raw 认证断言。
- **脱敏**：全库检索确认不含任何真实 key、用户 ID、用户名或站点实测数字；测试一律使用假值。
