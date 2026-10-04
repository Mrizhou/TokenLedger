> 本文 2026-09-30 从项目 AGENTS.md 原样移出（为压到 Antigravity 24000 字节上限以内），内容一字未改。
- `src/balance.js` `listAccounts()` 跳过「`declared: false` 且无存储配置」的目录项
  （2026-09-17，**用户明确不提 PR**）。宿主目录列出 pi-ai 全部内置 provider，
  不跳过的话 Z.ai / 智谱 GLM 会出现在没配过它们的账户列表里，
  排在前面的空路由还会顶掉 `deepseek-official` 占走 DeepSeek 那一项。
  守卫测试：`test/balance.test.js`「a shipped catalog route nobody configured is not an account」。
  **合上游时这一处要保留**；上游若自己修了，取上游那份并确认守卫测试仍绿。
- `src/balance.js` 的 `BUILTIN_PROVIDER_ORIGINS`（上游 PR #55 建的表）加 `xiaomi` 一项并 `export`，
  `src/discovery.js` 共用它：路由的 profile 没写 `baseURL` 就按表里的 catalog origin 归因、
  自成站点行（2026-09-23）。不做这件事的话，加了 MiMo 那天面板上什么都没有：无 `baseURL` 一律
  按「DeepSeek 默认」合并 —— 账户卡被 vendor 压缩吞进 DeepSeek，用量整包落进「直连/官方」。
  归因是**两面各有各的线**（同日用户定「是哪个就进哪个」后改）：用量归因看**去向**，表对所有路由
  生效 —— 没配过的 `zai` 也按 api.z.ai 归行，glm 的量不许混进 DeepSeek 的桶；账户列表（余额卡）
  仍按 09-17 只列**配过的**，没配过的没有余额可读、不冒卡。
  守卫测试：`test/balance.test.js`「a catalog route the harness resolves by itself still gets its own card」
  与「a shipped catalog route nobody configured is not an account」、
  `test/discovery.test.js`「a catalog route's own endpoint is its origin…」
  与「…nobody configured still attributes to its own endpoint」。
  **合上游时这一处要保留**（可上游的形态：表项按需补 + discovery 共用表；上游若合了就取上游那份）。
- `src/plugin.js` 的 `revisionUnchanged()`（2026-09-24，**0.1.7 revision 语义适配**）：0.1.7 起 JSONL 后端对
   「从旧会话格式迁移的」日志把 revision 报成 `fileRevision`（`dev:ino:size:mtimeNs:ctimeNs`）**再拼一段**
   `historicalCorpusRevision()`，而这段语料哈希**每次观测都会变**（0.1.7-rc.2 实测：相邻两个 sweep 波次给出
   `4ed11c4f…` / `e9b84ccd…`）。于是「日志没变」的严格相等判据永不成立 → 每 60 秒把全部会话 `read(0)` 全量
   重折叠（Windows + SQLite 实测：118 个会话每分钟整表重写、WAL 不停涨，且因红线 5 全程静音）。修复：revision
   形如「5 段 stat 身份 + 至多 1 段语料哈希」时只比 stat 五元组；**任何不认识的形态退回严格相等**（宁可多读、
   不可少算）。语料目录升级改变老日志折叠结果时用 `/tokenledger reindex` 重建。守卫测试：「a moving corpus
   suffix on an unchanged log is skipped without reading it」「a changed file identity under a corpus suffix
   still refolds the tail」「an unknown revision shape falls back to exact comparison」（钉死「不认识就退回」）。
   **合上游时这一处要保留**（上游在 0.1.7 线同样会撞上；上游若修了取上游那份，确认三个守卫测试仍绿）。
- `src/client.js` 的**侧边栏席位适配**（2026-09-25，**0.1.7 席位语义**）：0.1.7 把 `sidebar.footer.action` 的锚点
   渲染成 `display:contents`、放进**高度受限的 nowrap 行** —— launcher 不再是盒子，占整行的 launcher 会被排到
   席位之外（**渲染了、`opacity:1`、看不见**，与旧版那个 `:has()` 换行坑同形，同样静音）。实测定位链：宿主半边
   运行中 → 插件列表无同步失败 → console 五段面包屑全走到「`sidebar.footer.action is available; registering`」
   → `document.querySelectorAll` 命中槽 div，但界面上仍然没有。修复：给自己的样式表补
   `body [data-slot='sidebar.footer.action']` 三条规则（**恢复盒子** + **纵向堆叠** + 席位保持高度受限可滚动），
   做法对齐社区桌面插件 `anywhere-labs/dsh-desktop` 的
   `dsh-plugin-desktop/src/client/sidebar-footer-styles.ts`（它开篇就写明上游是 `display: contents` 锚点）。
   守卫测试：`test/client.test.js`「the 0.1.7 seat is given a box back, or the badge is laid out of it」
   （变异验证：换成 `display:contents` 即 `not ok`）。
   **合上游时这一处要保留**（上游若改回盒子或提供席位容器 API，取上游那份并确认守卫仍绿）。
- **0.1.7 首开慢 / 宿主周期性卡顿的一组修复**（2026-09-25）：
  - `src/balance.js` `sectionReader()`：0.1.7 的 `settings.describe()` 会**同步**重校验、重序列化 profile 里
    **全部**插件条目，旧写法每个路由调一次 → 一次账户列举在宿主主线程上卡 ~4.5 s；60 秒定时 sweep
    关着面板也卡，打开面板（usage + balance 各列举几次）9–18 s。改为一个 reader 只调一次、2 秒内跨 reader 共享快照。
    实测定位法：面板请求进行中同时轮询 `/api/tokenledger/userauth`（平时 2 ms），它被整段卡住 = 同步阻塞。
  - `createBalanceReader()`：识别不出的站点（阿里 MaaS、小米、本地反代）以前每次读余额都重探 6 个路由，
    现在记 10 分钟，刷新按钮（`force`）可绕过。
  - `listAccounts()`：同一厂商多条路由合并时，卡片归**有 key 的那条**（0.1.7 新增无 key 的 `deepseek-account`）；
    厂商账户排在最前（catalog 把 xiaomi 排第一，面板默认开在读不了余额的卡上）。
  - `src/discovery.js`：`deepseek-account`（`llm-deepseek-account` 条目、无 baseURL）归「直连/官方」，不再进 unrouted。
  - `src/client.js`：徽章关着面板也读一次并每 5 分钟刷新（以前要点开一次才有数字）。
  守卫测试：`test/balance.test.js`「one account listing costs one describe()…」「a describe() snapshot is shared…」
  「an unrecognisable relay is not re-probed…」「0.1.7 live shape: the keyed DeepSeek route owns the card…」、
  `test/discovery.test.js`「0.1.7's sign-in route to DeepSeek is direct traffic too…」、
  `test/client.test.js`「the badge reads today's figure with the panel shut…」（每条都做过变异验证）。

- **小米 MiMo 余额走控制台 cookie + 凭据本地文件**（2026-09-25，**推翻 09-23「cookie 方案不做」**，用户原话「mimo 推翻，改成读cookie」）：
  - MiMo 的 API key（按量 key 与 Token Plan `tp-*` key）**没有任何余额接口**；只有控制台
    `https://platform.xiaomimimo.com/api/v1/{balance,tokenPlan/usage,tokenPlan/detail}` 能读，鉴权是登录 cookie
    （需含 `serviceToken` 与 `userId`，约 24 小时过期）。接口形状参照 MIT 的 `Han-1413141/dsh-cost-meter` PR #166。
  - `src/balance.js`：`api.xiaomimimo.com` 与三个 `token-plan-*` 主机登记为厂商 `mimo`；scheme 声明
    `credential: { kind: "console-cookie", origin }`，`readBalance` 对它发 `Cookie` 头（不发 Authorization）且只发往该控制台 origin；
    缺 cookie / 过期各有 hint，卡片据此给「设置 Cookie」按钮。
  - **凭据存储**：0.1.7 的 settings 服务**没有 `register()`**，插件命名空间注册失败 → 原「设置查询API」对话框
    **自升级起就存不进去**（接口回 500 `internal`）。新增 `src/credentials-file.js`：宿主没有可写命名空间时，
    New API 钱包凭据与控制台 cookie 写进账本旁的 `tokenledger-credentials.json`（整份写临时文件再 rename），启动时读回。
    `saveUserAuth` 的拒绝原因带 `kind`，`invalid-*` 回 400。
  - 顺带：`withKnownSoftware` 也按 origin 认余额卡懒探测记下的程序类型（以前只按站点 id，站点行永远无类型），
    站点行悬停提示显示程序类型。
  守卫测试：`test/balance.test.js` MiMo 五条、`test/apply.test.js`「on a host with no settings namespace…」、
  `test/client.test.js`「a MiMo card without a live console session…」「the panel opens the cookie dialog…」、
  `test/discovery.test.js`「a type the balance card learned by origin reaches the site row」（均变异验证）。

- **DeepSeek 余额先读「登录账户」钱包，路由的 key 只是兜底**（2026-09-27，用户报「把 api 删了，
  另一个显示不了余额了」）：DeepSeek 的钱在两个平面上 —— `/user/balance` 回答的是 **API key**
  背后的钱包，0.1.7 免 key 的 `deepseek-account`（登录账户）永远答不了它；key 被删/被吊销时更是什么
  都读不到（401），而登录账户自己的钱就在隔壁主机名上没人读。Platform 为登录会话在
  `https://platform.deepseek.com/api/v0/users/get_user_summary` 提供它（`x-dsh-auth-token` 鉴权），
  0.1.7 宿主已把它包成 `deepseekAccount` 服务（`getBalance(client)` → `{ status: "ready", value,
  bonusWallets }`，无授权时 `null`）。
  - `src/balance.js` `readDeepSeekAccountBalance()`：走宿主服务（**token 不出宿主**），先于 key 读；
    key 仍是兜底（只配 key 的安装、登录失效的宿主不受影响）。15 秒封顶（`options.accountTimeoutMs`），
    服务缺席 / 抛错 / 挂起只损失这一路，不影响 key 那一路。返回 `scheme: "deepseek-account"`，
    卡片据此标「登录账户余额」（key 读到的仍标「API 余额」）—— 一张 DeepSeek 卡同时挂两条路由，
    而两个钱包未必是同一个账户。钱包字符串按 Platform 自家 Web 客户端喂 big.js 的十进制文法读
    （`0E-16` 是真 0；NaN / 散文不是钱），`value`→`toppedUp`、`bonusWallets`→`granted`、
    `total` 为两者之和；**一个钱包都没报 ≠ 余额为 0**，返回 undefined 让调用方走兜底。
  - 登录缺席且 key 也被拒时给 hint `deepseek-signin`（中英双语），不许只留一个裸 `http-401`。
  - 调用自带客户端身份 `deepSeekAccountClient()`（宿主据此生成 Platform 的 `x-client-*` 头；
    version 取本包版本），不借 UI 的身份。
  守卫测试：`test/balance.test.js`「the sign-in wallet is the DeepSeek card's source…」
  「a Host that is signed out still reads the route's key」「a failing account service never costs the balance…」
  「the account wallet is a DeepSeek-only source」「a signed-out Host with a refused key says to sign in…」
  「the account reader says why it cannot answer…」「wallet strings are read as money, not as text」
  「the account call carries a client identity of its own」、`test/client.test.js`
  「the sign-in wallet is labelled as the account's…」「a Host whose account is signed out is told to sign in…」
  （均变异验证）。**合上游时这一处要保留**（上游没有登录账户这条线；上游若自己加了，取上游那份并确认守卫仍绿）。

- **Command Code 的 5h / 周 / 月 额度读它的账户 API**（2026-09-29，用户「我加了 command code 的 api，把使用限制抓出来」）：
  `api.commandcode.ai` 上除了 `/provider/v1`（推理）还有一套 `/alpha/*` 账户路由，正是它家 CLI 的 `/usage`
  浮层读的 —— `/alpha/billing/credits` 给 `credits.monthlyCredits`（月度池**剩余**）与
  `windowLimits.fiveHour|weekly`（`{used, cap, exceeded, resetAt}` 毫秒 epoch），
  `/alpha/billing/subscriptions` 给 `planId` 与 `currentPeriodEnd`，`/alpha/whoami`、
  `/alpha/usage/summary` 是用户与本周期用量。**鉴权就是 Provider API 那把 key**（Bearer），不需要
  像 MiMo 那样搞控制台 cookie。官方文档没写这套路由（`plans.md` 甚至写「plan 无法 headless 读取」），
  所以 `src/subscriptions.js` 的 `COMMAND_CODE` 每个字段都可缺省：形状变了只丢一行，不丢整张卡。
  - 窗口语义（官方 usage-limits 文档 + CLI 源码一致）：两个滚动窗口都从**本窗口第一次请求**起算（5h / 7d），
    与自然日无关；只有套餐内月度积分计入，另购的 pay-as-you-go 不计也不被拦。
  - 月度池的**分母**接口不给，只有剩余。`COMMAND_CODE_PLANS` 照抄 CLI 1.68.0 的表
    （Go 10 / GOAT 70 / Pro 80 / individual-pro 30 是遗留档 / Max 150 / Max 20× 300 / Team Pro 40），
    按**最长前缀**匹配；匹配不到的 planId **不出月行**（宁可少一行，不编一个分母）。
    剩余**大于**表里的池子时也不出月行 —— 那是表错了或有额外赠送，画成 0% 等于说没用过。
  - **归因靠 `BUILTIN_PROVIDER_ORIGINS`**（2026-09-29 当天发现）：用户改用第三方 provider 插件
    `@mars-sea/dsh-commandcode-provider@0.12.0`（行 id `llm-commandcode`、`apiKeyEnv: COMMANDCODE_API_KEY`）
    接 Command Code，那条路由**没有存储 baseURL**（端点取插件自己的默认值）。宿主里没有这条表项时，
    这条路由被读成「**用户声明但读不到 origin**」—— 既不敢当直连也不敢当中转，于是
    `/tokenledger site` 报 **未知路由**、用量从所有站点行里掉出去，而余额卡又退回「无 baseURL = DeepSeek
    默认」，把 Command Code 的卡变成 DeepSeek 自己的。补表项 `["commandcode", "https://api.commandcode.ai"]`
    后：站点行自成 `api.commandcode.ai`，卡回到 `commandcode` scheme。**这条表 `discovery.js` 共用**，
    所以修一处两面都对。历史不用手工重折叠 —— `refreshDirectory()` 发现 origin 集合变了就
    `store.reset()` + 从会话日志整份重折叠（`plugin.js`，日志已删的会话仍找不回）。
    模式与 09-23 的 xiaomi 完全同形：**provider 插件/preset 挂的路由不带 baseURL，就要进这张表**。
  - 守卫测试：`test/balance.test.js`「Command Code reads both rolling caps and the month's pool…」
    「an unknown plan id costs the month's row, never the rolling caps」「the longer plan id wins…」
    「a remainder larger than the plan's pool is not a spend of zero」「the subscription route failing
    leaves the caps standing」「a refused account API is the refusal…」「a pay-as-you-go account with
    no caps says so in words」「a Command Code route is a vendor card, not a relay to fingerprint」
    「the route the Command Code provider plugin mounts with a default endpoint still gets its card」、
    `test/discovery.test.js`「a provider plugin's route with a default endpoint stops being an unknown route」
    （均变异验证）。**合上游时这一处要保留**（上游没有这个 vendor）。
- **侧边栏「用量账本」下方显示当前所选模型的余额**（2026-10-04，用户「我想在左边栏上加上余额显示 就是用量账本四个字下方 显示为当前选择模型的余额」）：
  - 「当前所选模型」取 DSH 自己的选择，**不从账本推断**：`uiSession.current` 给出主会话 id →
    `modelDirectories.directoryFor(id).store` 的 `current = { provider, model }`（与输入框的模型席位同一个 store，
    出处：`@deepseek-ai/dsh-client-ui-model-selection` / `dsh-client-ui-session` 0.2.0-rc.2 的 `lib/client.js`）。
    两个服务都用 `ctx.get` 取、**不进 `inject`**（`docs/HOST-CONTRACT.md` §2：声明即必需，宿主没有就整个插件挂起）；
    取不到就每 2 s 重试、最多 60 次（两分钟），之后这一行不出，徽章其余照旧。
  - **刚加载不显示、选了模型才出（同日用户报「我刚加载进去没显示」）**：两处根因，都改成会重试。
    ① 重启后第一次查余额早于宿主的 provider 目录 / 登录态就绪，答 `no-provider-directory` 之类，这个空答案一直挂到 5 分钟节拍或换模型 →
    现在没读到（`fetched !== true` 或请求失败）就按 5 s / 15 s / 30 s / 60 s 再问，读到即停；
    ② 主会话先被点名、作用域后建，`directoryFor()` 抛「resolved no scope」时旧代码已把会话记为「处理过」、再不重试 → 现在忘掉它、2 s 后重来。
    守卫测试 `test/client.test.js`「a fresh load that finds the host or the session not ready yet asks again」（两处各自变异验证）。
  - `provider` 就是路由 id，直接当 `/api/tokenledger/balance?account=` 用；从不 `force`，走宿主的新鲜度窗口，
    跟今日用量同一个 5 分钟节拍。读不到 / 不支持 / 失败 → **这一行不出**（解释留给面板里的余额卡）；
    换模型时旧路由的数字立即撤掉，不会挂在新模型下。显示：有余额 `余额 ¥x`，无限额 key `已用 $x`，
    只有订阅窗口（Command Code）取第一个有百分比的窗口 `5 小时窗口 已用 40%`；悬停给 `路由/模型 · 卡名`。收起成 56px 轨道时隐藏。
  - **宿主侧配套**：`listAccounts()` 每个账户多带 `routes`（被厂商卡折叠进来的路由 id 也记上），
    `findAccount()` 先按 id、再按 `routes` 找 —— 否则会话停在 `deepseek-account`、而 DeepSeek 卡留的是另一条路由的 id 时，
    按路由问余额得到 `unknown-account`，默认模型那一行永远是空的。`plugin.js` 的钱包分支同样改用 `findAccount()`。
  - 守卫测试：`test/client.test.js`「the badge's second line is the balance behind the open session's model」
    「the badge's balance line says nothing it cannot say in a few words」、
    `test/balance.test.js`「a route folded into a vendor card still finds that card」（前一条与第三条均变异验证）。
    **合上游时这一处要保留**（上游没有）。
- **Antigravity（`dsh-antigravity-auth` 插件）进余额账户**（2026-10-04，用户「antigravity的插件可以显示进账户吗」「dsh里装的那个插件」）：
  - 来由：`google-antigravity` 是插件用 `llm.registerAdapter` 挂的**适配器路由**，不在 `listConfigurableProviders()` 里，
    所以从来没有账户、余额查它答 `unknown-account`（2026-10-04 对运行中宿主 `GET /api/tokenledger/balance?account=google-antigravity` 实测）。
  - 做法：探测宿主服务 `antigravityAuth`（插件 `lib/index.js` `ctx.provide("antigravityAuth", service)`，0.1.4-rc.5），
    有 `usage()` 就在 `listAccounts()` 末尾补一个厂商账户（id `google-antigravity`、scheme `antigravity`）；
    读额度调 `service.usage(signal, force)` —— **令牌留在那个插件里，我们不碰 OAuth、不自己请求 Google**，插件自带 30 s 下限。
    返回 `{ state, groups: [{ group: "gemini" | "non-gemini", windows: [{ window: "5h" | "weekly", remainingFraction, resetTime }] }] }`，
    转成面板通用窗口 `{ kind, minutes?, usedPercent = round((1−剩余)×100), resetsAt, group }`；卡片窗口名前缀组名
    （「Gemini」「Claude 与 GPT」，沿用该插件自己的分组叫法），侧边栏按当前模型名含不含 `gemini` 取对应组。
    未登录给 hint `antigravity-signin`；插件自己的 `rate-limited` 改报 `upstream-429`（我们的 `rate-limited` 带重试时刻，语义不同）。
  - **不碰** `BUILTIN_PROVIDER_ORIGINS` / 站点归因：`listAccounts()` 只供余额，不进 origin 集合，**不会触发账本整表重折叠**（10-03 手工归并不受影响）。
  - 守卫测试：`test/balance.test.js`「the Antigravity adapter's route is an account when its plugin is mounted」
    「an Antigravity plugin that is signed out says so, and its throttle is not ours」（均变异验证）、
    `test/client.test.js`「Antigravity's quota is labelled by model group, and the badge reads the selected model's group」。
    **合上游时这一处要保留**（上游没有）。
- **Command Code 与 Antigravity 的窗口标成 `5h` / `7d` / `30d`**（2026-10-04，用户「cc的用量别写5小时窗口 用5h week month标出来」）：
  `client.js` 的 `COMPACT_WINDOW_SCHEMES`（`commandcode`；同日用户问「antigravity的做匹配了吗 5h week」后加 `antigravity` —— 侧边栏只列当前模型所在组的 `5h` / `7d`，并前缀组名：`Gemini 5h 7% · 7d 20%` / `Claude 与 GPT 5h 0% · 7d 0%`；用户问「选opus显示claude、还有个gpt的」—— **GPT 与 Claude 在 Antigravity 是同一个额度池**（插件 `parseUsageResult` 只允许 `gemini` / `non-gemini` 两组），所以选 GPT 也显示「Claude 与 GPT」）→ `compactWindowLabel()`，面板卡片用短标签；
  侧边栏那一行**三个窗口都列、不写「已用」**（同日用户「那一行三个都要显示 已用两个字不写」）：`5h 1.9% · 7d 37% · 30d 18.5%`（同日用户「别写week 写7d 和30d吧」，`daily` 相应写 `1d`，目前只有 Sub2API 有日窗口），悬停给全文；
  其他方案仍是「5 小时窗口 / 每周窗口」。守卫测试：`test/client.test.js`「Command Code's windows read 5h / 7d / 30d, on the card and on the badge」。
- **面板：「模型」挪到「活跃度」上方；最下面加「日用量」折线**（2026-10-04，用户「模型提到活跃度上方，然后在最下面搞一个日用量折线图可以选按token还是估算的费用 选单日（按小时或者分钟来，如果做不到换成90天） 30天 全部」）：
  - **单日按小时做不到**：账本 `session_rollups` 的最细粒度是「会话 × 天」，没有时刻列；要小时就得改 schema → 整表 DROP + 从会话日志重折叠，
    会丢日志已删的会话、并冲掉 10-03 的手工归并。按用户给的退路换成 **30 天 / 90 天 / 全部**。
  - 宿主：`http.js` `dailySeries()` → 载荷字段 `daily: [{ day, tokens, requests, cost?, currency? }]`，全历史、与所选区间无关（同活跃度）；
    费用口径同「估算」列（配了 `rates` 计全部路由，只有内置表则只计官方路由），但**每天按当天的价目**计；多币种时只画总额最大的那种、不相加。
    `plugin.js` 两处 deps 用 `config.rates` 接上。
  - 浏览器：`client.js` `TrendChart` 手写 SVG 单线（无依赖）。Token / 估算费用 切换（没有任何计价记录时费用按钮置灰），30 / 90 天 / 全部；
    空闲日补 0；十字线吸附到最近一天，悬停提示复用活跃度的 `.tkl_tip`。线色 `#0284c7`，用 dataviz 校验脚本在浅/深两种底色上都过了亮度带、彩度和 3:1 对比。
  - 守卫测试：`test/http.test.js`「the trend line's days carry each day's own cost, priced at that day's rates」（变异验证）
    「the payload carries the whole daily history for the trend line」、`test/client.test.js`「the trend line fills idle days…」
    「the trend chart toggles tokens and cost…」「the panel orders 模型 above 活跃度 and puts the daily line last」。**合上游时这一处要保留**。
