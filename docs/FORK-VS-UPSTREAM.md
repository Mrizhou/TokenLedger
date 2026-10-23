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
- **Qoder 的两条路由进 `BUILTIN_PROVIDER_ORIGINS`，并在 `VENDORS` 里占一个无读取器的位置**（2026-10-23）：
  - 来由：`@eghrhegpe/dsh-connect-qoder`（10-18 装）注册 `qoder-cn` / `qoder` 时写死 `settingsPath: []` ＋
    `declared: false`，设置区**不暴露 baseURL**；模型出口是本机 `127.0.0.1:<随机端口>/v1` 的临时 shim，
    再转发到 `gateway.qoder.com.cn/algo/api/v2/…`（`lib/index.js:9912`、`:1374`、`:1871`）。
    于是命中 `discovery.js` 的「无 baseURL ＋ `declared: false` → `directProviders`」规则，**整包落进「直连/官方」**：
    真实账本里 `direct` 只剩两条路由，`qoder-cn` 占 665M tokens（66 行，10-18 ~ 10-23），
    与 DeepSeek 自家的 1.18B 挤在同一行；同一原因还让 DeepSeek 的余额卡把 `qoder-cn` 收进自己的 `routes`。
  - 修法：表里加 `["qoder-cn", "https://gateway.qoder.com.cn"]` 与 `["qoder", "https://api3.qoder.sh"]`
    （两个 edition 是真两台网关，两个站点行）。**不能读 shim 的端口**——它每次启动都变，没有两次一致的名义。
    这与 Command Code ⑧ 是同一族、同一形态：插件的默认端点不在存储的 profile 里。
  - 附带一处：`VENDORS` 加 `gateway.qoder.com.cn` / `api3.qoder.sh` → `{ scheme: "qoder" }`，**但 `SCHEMES.qoder` 不存在**。
    它不是装饰：余额卡拿到 `scheme === undefined` 会把它当中转站去**匿名探测六条路由**（问 Qoder 的网关
    「你跑的是 New API 还是 Sub2API」——一个没有答案的问题，问在第三方身上，每次开面板一次、每 10 分钟一轮）。
    有了 scheme 就走「已知厂商、无读取器」，卡片如实说没有读取器并给声明端点的出路。
    `newapi-user.js` 的 `KNOWN_NON_NEWAPI` 同步加 `qoder`，免得残留的钱包条目把它送进 New API 读取器。
  - **🔴 别改用 `relays` 钉站**（2026-10-22 试过、已撤回）：`discovery` 判 direct 与 `mergeSites` 判站点 id
    两处期望打架，`staleAttributions()` 每轮 sweep 都判 stale → 反复重折叠，账本 `meta.rebuild.count` 涨到 421、
    `reason` 的箭头在两个值之间每次反向翻转，且热配置撤销止不住（必须彻底退出桌面版）。
    表项没有这个问题：它让 `discovery` 自己就不再产出 `directProviders`，期望只剩一处。
  - 守卫测试：`test/discovery.test.js`「a Qoder region's traffic is its own site row, not a share of 直连/官方」、
    `test/balance.test.js`「a Qoder region is its own account, and stops being folded into the DeepSeek card」
    「a Qoder card says there is no reader instead of probing the gateway」、
    `test/newapi-user.test.js`「shouldUseWallet: a Qoder gateway is not a New API console」。
    变异验证（逐一拆开）：表里去掉两条 → discovery 那条红；只去掉国际版 → 同一条红；去掉 `VENDORS` 两条 →
    balance 两条红；`KNOWN_NON_NEWAPI` 去掉 `qoder` → newapi-user 那条红。
  - 装机副作用：首轮会触发一次全量重折叠（10-20 起不清表，累计数中途不乱跳），历史上 665M 从「直连/官方」
    挪到 `gateway.qoder.com.cn`；余额一节多一张「Qoder CN · 无读取器」的卡。**合上游时这一处要保留**
    （上游没有 Qoder 支持；若上游补了自己的形态，取其那份并确认四条守卫仍绿）。
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

- **小米 MiMo 余额改为手填、按账本用量扣减**（2026-10-04，用户「这种改成自己输入吧」「填的数减去之后的估算花费」「去掉 Cookie，只留手填」「单价需要你去核实」；
  **取代** 09-25 起的控制台 cookie 读法 —— 那次是推翻 09-23「cookie 方案不做」，用户原话「mimo 推翻，改成读cookie」）：
  - 来由不变：MiMo 的 API key（按量 key 与 Token Plan `tp-*` key）**没有任何余额接口**。10-04 复查官方文档站
    （`mimo.mi.com/llms.txt` 全部页面清单，站点地图最新 09-29）：API 参考只有对话 / 语音 / 模型列表 / 错误码 / 限流，查余额只能登控制台。
    cookie 读法能用但约一天过期、要天天重贴（10-04 实测运行中的插件答 `http-401` / `mimo-cookie-expired`）。
  - 做法：`src/balance.js` 的 `SCHEMES.mimo` 只剩 `credential: { kind: "manual" }`，**没有 `read`、不发任何请求**；
    `createBalanceReader` 遇 manual 走 `options.manualBalance(account)`，没填过答 `no-manual-balance` + hint `manual-missing`。
    新增 `src/manual-balance.js`：填数时**先跑一次 sweep**，再记下该账户各路由 ×模型的全量 token 桶作基线；
    之后余额 = 填的数 − 估价(现在的桶 − 基线)，每个桶只计增长（重折叠让总量变小不算退款）。
    账本只到「会话 × 天」，所以用快照差而不是时间过滤 —— 跨天也准，误差只在两次 sweep 之间。
  - 单价：`src/pricing.js` 新增 `MIMO_OFFICIAL_RATES`，**10-04 从官方价目页一手核过**
    （`https://mimo.mi.com/static/docs/price/pay-as-you-go.md`，站点地图记该页 09-22 更新）：国内按量、实时 API，每百万 token：
    `mimo-v2.6-pro` 缓存命中 ¥0.025 / 未命中 ¥3 / 输出 ¥6；`mimo-v2.6-flash` ¥0.02 / ¥1 / ¥2；`mimo-v2.6-pro-ultraspeed` ¥0.25 / ¥30 / ¥60；
    缓存写入「限时免费」记 0；`mimo-v2.5-pro` / `mimo-v2.5` 与 2.6 同价（10-21 下线）。Batch 价（减半）不用 —— 账本分不出 batch。
    查价顺序：用户 `rates` 里有这个模型就用用户的，没有才用内置表（用户 profile 里已配的 MiMo 两条与官方一致）。
    这张表**只用于手填余额的扣减**，不进面板「估算」列（那列的口径不变）。
  - 存储：`credentials-file.js` 的第二张表从 `consoleCookies` 换成 `manualBalances`（按账户 id：`{ amount, currency, at, baseline }`，不是机密）；
    启动时发现旧文件里还有 `consoleCookies` 就**整份重写掉它**（那份 cookie 能登录整个小米控制台）。settings schema 删掉 `consoleCookies`。
    写口仍是 `POST /api/tokenledger/userauth`，`{ kind: "manual", account, amount, currency?, remove? }`，只接受 scheme 为 manual 的账户（否则 `invalid-account`），金额不合法 `invalid-amount`。
  - 面板：「设置 Cookie」对话框（`CookieDialog`）换成「填写余额」（`ManualBalanceDialog`）；卡上金额旁标「估算」，备注「手填 ¥x（N 天前）」「之后估算花费 ¥y」，
    有没单价的模型就列「未计价：…」；一行里显示 `≈¥26.19`，没填过显示灰色「未填写」（不是失败的警示色）。
  - 删掉：`normalizeConsoleCookie`、`MIMO_CONSOLE_ORIGIN`、`readMimoPlan`（Token Plan 月额度读取随之没了）、`readBalance` 的 Cookie 头分支、`CONSOLE_ORIGINS`、全部 `cookie.*` 文案。
  - 顺带（09-25 那次留下、仍有效）：0.1.7 的 settings 服务**没有 `register()`**，所以钱包凭据落 `tokenledger-credentials.json`（整份写临时文件再 rename）；
    `saveUserAuth` 的拒绝原因带 `kind`，`invalid-*` 回 400；`withKnownSoftware` 也按 origin 认余额卡懒探测记下的程序类型。
  守卫测试：`test/manual-balance.test.js` 七条（含「MiMo's shipped prices are the official page's」「only usage after the snapshot is charged…」
  「…a shrunken ledger is never a refund」）、`test/balance.test.js`「MiMo is typed in: nothing is fetched…」「a typed MiMo balance is the host's answer…」、
  `test/apply.test.js`「on a host with no settings namespace…」（含旧 cookie 被清掉、重启后余额照答）、
  `test/client.test.js`「a MiMo account with no typed balance asks for one…」「a typed balance reads as an estimate…」
  「the panel opens the balance dialog for a typed-in account…」「the balance dialog sends the typed figure…」、
  `test/discovery.test.js`「a type the balance card learned by origin reaches the site row」。
  变异验证：去掉「只计增长」、宿主不接 `manualBalance`、行上去掉 `≈`，对应测试各自失败。**合上游时这一处要保留**（上游没有 MiMo）。
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
- **插件页显示中文名「用量账本」**（2026-10-04，用户「插件那边点进去把dsh-tokenledger改成中文」）：
  DSH 插件页标题来自 `<包名>/locale/<语言>.json` 的 `meta.title` / `meta.description`（宿主 `dsh-app-boot` `readPluginMeta()`，经包的 **exports** 解析；
  解析不到报 `ERR_PACKAGE_PATH_NOT_EXPORTED` 就当没有、退回包名）。新增 `src/locale/{en,zh}.json`，`exports` 加
  `"./locale/*.json": "./src/locale/*.json"`（目标留在 `src/` 下，守上游「新导出只在 src/」的约束；文件名必须是语言 id，宿主会扫整个目录）。
  守卫测试 `test/packaging.test.js`「the plugin page's name and description resolve the way the host reads them」（变异验证）。
- **面板「余额」一节列全部账户、去掉账户下拉**（2026-10-04，用户「用量账本点开显示全部余额，不要选择了」）：
  - 浏览器：`client.js` 的 `useBalance(open, account, …)` 换成 `useBalances(open, accounts, …)` —— 每个账户各发一次
    `/api/tokenledger/balance?account=<id>`（并行，各自落地，慢的只拖它自己那张卡）；结果按账户 id 存成表、跨重开保留，刷新时旧数字不消失。
    依赖的是账户 id 串而不是数组引用，避免每次用量载荷重建账户列表都重读一遍。等用量载荷到了（知道有哪些账户）才开始读，
    不再先发一次不点名的读；载荷里没有账户时退回旧的不带 `account` 的单次读。刷新按钮照旧对全部账户 `force=1`。
  - `Body` 渲染 `.tkl_balances` 竖排卡片，一账户一张；还没读到的占骨架位、读失败的留一张「读取失败（unreachable）」卡（不再整张消失），
    每张卡（含失败卡）都用 `whoLine` 标出是谁的；「设置查询API / Cookie」按钮配置的是**该卡自己的账户**。
  - 删掉：`AccountPicker`（及其导出）、`.tkl_picker` / `.tkl_pickerLabel` / `.tkl_select` / `.tkl_select option` 样式、
    `--tkl-scheme` / `--tkl-option-bg` / `--tkl-option-fg` 三组主题变量、`balance.account` 文案、面板的 `account` 状态格
    （`TokenLedgerPanel` 的 state 顺序因此变成 `[open, range, site, nonce, forceNonce, dialogFor, …]`）。
    09-14 那处「下拉灰底灰字」修复（PR #63）随下拉一起不复存在。
  - 守卫测试：`test/client.test.js`「every account gets its own balance card, and there is nothing to select」
    「opening the panel reads every account's balance, once each」（均变异验证：换回改动前的 `client.js` 两条都失败）。
    **合上游时这一处要保留**（上游仍是下拉）。
  - **同日再收成一账户一行**（用户「这样东西太多了 每个压缩成一行 有余额的显示余额 套餐的显示最长那个比如月周」）：
    `Body` 改渲染 `BalanceRow`（`▸ 名字 …… 数字`），点一行才在下面展开原来的 `BalanceCard`（重置时刻、备注、「设置查询API / Cookie」按钮都还在卡里）。
    行上的数字由 `balanceRowValue()` 定：有 `total` 显示余额；不限额 key 显示「已用 $x」；有 `quota` 显示额度；
    否则取**最长窗口**（`longestWindows()`：月 > 周 > 日 > 5h，计费周期按月算；没有百分比的窗口不算；Antigravity 按模型组各取一个），
    写成侧边栏同款的裸百分比 `30d 18.5%`。有钱包又有套餐（Z.ai）时只显示钱包。读失败只写两个字（读取失败 / 未配置密钥 / 限流中 / 不支持），标警示色，详情点开看。
    守卫测试：「a balance line shows the money, or the plan's longest window」「a balance line opens its full card, button and all」
    （变异验证：`Body` 换回 `BalanceCard`、或去掉取最长的比较，对应测试失败）。
- **阿里云百炼的余额：用 AccessKey 读阿里云费用中心**（2026-10-04，用户「llm-7ub39ukw6sjudiit.cn-beijing.maas.aliyuncs.com 这个是阿里云百炼的，真的抓不到吗」→「这个需要经常维护吗」→「尝试一下」）：
  - 来由：百炼的推理域名（`dashscope.aliyuncs.com`、业务空间专属域名 `{WorkspaceId}.{region}.maas.aliyuncs.com`）只认 API key、只答模型；
    官方 Base URL 页只列 `/compatible-mode/v1`、`/apps/anthropic`、`/api/v1`，没有余额接口（10-04 核）。此前这个账户答 `unknown-software`。
    钱在阿里云费用中心：BssOpenApi `2017-12-14` 的 `QueryAccountBalance`，用 AccessKey 签名（V3 `ACS3-HMAC-SHA256`），权限只要 `bss:DescribeAcccount`（官方拼写三个 c）。
  - 新增 `src/aliyun-bss.js`：V3 签名器照官方「V3 版本请求体&签名机制」页实现，**用该页的 RunInstances 示例逐字节核对过签名**（守卫测试原样用那组固定输入与期望值）；
    `readAliyunBalance` 对 `https://business.aliyuncs.com/` 发签名 POST（不跟跨源重定向、响应体有上限、15 s 超时），
    `AvailableAmount` 作总额、`AvailableCashAmount` 与总额不同时作 `toppedUp`；`InvalidAccessKeyId*` / `SignatureDoesNotMatch` 给 hint `aliyun-ak-invalid`，
    `NoPermission` / `NotAuthorized` 给 `aliyun-ak-permission`，没存 key 给 `aliyun-ak-missing`。
  - `src/balance.js`：`vendorOf` 对百炼主机按模式认（`ALIYUN_VENDOR`，scheme `aliyun`、显示「阿里云百炼」）；`SCHEMES.aliyun` 只有 `credential: { kind: "aliyun-access-key" }`；
    `createBalanceReader` 走 `options.aliyunAccessKey()`，**不碰路由的 API key**。`vendorOf` 只在 `balance.js` 里用，不影响站点归因、不会触发账本重折叠。
  - 存储：`credentials-file.js` 加 `aliyunAccessKey`（整个安装一份，不按 origin —— 余额是整个阿里云账号的）；`plugin.js` 所有落盘改走 `fileCredentials()` 一处，
    免得哪次保存漏掉某张表。写口 `POST /api/tokenledger/userauth` `{ kind: "aliyun-access-key", accessKeyId, accessKeySecret | remove }`，同 ID 空 Secret 保留原 Secret；
    `GET` 多回一个 `aliyun: { accessKeyId: "LTAI…abcd", hasSecret }`，**Secret 和完整 ID 都不回显**。
  - 面板：百炼卡上「设置 AccessKey」按钮 → `AliyunAccessKeyDialog`（三步：RAM 建用户 → 只授权 `bss:DescribeAcccount` → 填 ID/Secret）。
  - **10-05 修正域名**：首版写成 `bssopenapi.aliyuncs.com`（把产品代码当成了域名，出自一次未复核的文档摘要），DNS 根本解析不到，每次都答 `unreachable`。改为官方 SDK 端点表（`aliyun/alibabacloud-python-sdk` `bssopenapi-20171214` client 的 `_endpoint_map`：`cn-*` → `business.aliyuncs.com`）给的 `business.aliyuncs.com`；实测假 key 回 `InvalidAccessKeyId.NotFound`（证明域名与签名格式都对），用户的 key 读回 `Code 200`、各项 0.00。
  - 已知局限：读到的是**整个阿里云账号**的可用余额（各产品共用），不是百炼单独的；百炼的免费额度读不到；只认中国站（`business.aliyuncs.com`）。
  守卫测试：`test/aliyun-bss.test.js` 五条（含「the signature matches Alibaba Cloud's own worked V3 example」）、
  `test/balance.test.js`「a 百炼 workspace route is the 阿里云 card, read with the stored AccessKey and never the route key」、
  `test/apply.test.js`「the 阿里云 AccessKey is stored once, shown masked, and signs the 百炼 card's read」、
  `test/client.test.js`「a 百炼 card with no AccessKey says where the balance lives…」。
  变异验证：签名头分隔符改错、读余额不取已存的 key、ID 不打码，对应测试各自失败。**合上游时这一处要保留**（上游没有阿里云）。
- **DeepSeek 峰谷：侧边栏时段行、切换前提醒、节假日表到期提醒、按时段计价**（2026-10-14，用户「我需要加一个deepseek峰谷的提醒」，
  拍板：提醒形态「1+2」（侧边栏一行＋右下角小提示，不做系统通知）、**所有模型都提醒**（「我在峰段用其他模型，到谷段提醒我了，我要切」）、
  2026 年节假日先配上、十二月最后十天（或设定日前 N 天）每次打开 DSH 弹窗提醒补下一年、计价「以前的不算了，以后的要算」）：
  - 规则来源（10-14 取原页）：DeepSeek 定价页「北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，
    包括周末及中国法定节假日全天均为空闲时段」，空闲＝高峰半价。Command Code（`/docs/resources/pricing-limits`）与 OpenCode Go（`/docs/go`）
    转售 DeepSeek 模型用**同样的时段**，但原文**没写节假日** —— 按字面，工作日的节假日在它们那里仍是高峰。OpenCode Zen 是固定价、无峰谷。
    调休补班的周末：三家原文都把周末整体列为空闲，没有例外，按空闲算。仓库原有的 `DEEPSEEK_OFF_PEAK`（00:30–08:30 夜间优惠）是旧规则，已删。
  - 新增 `src/peak.js`：`phaseAt()` 把一个时刻分成 `peak` / `off` / `holiday`（工作日高峰时段但落在节假日）**三类**，由各费率自己决定 `holiday` 算不算谷；
    一律按 UTC+8 算，不看宿主时区。`CN_HOLIDAYS` 内置 2026 年全部放假日（国务院办公厅通知，新华社全文 2025-11-04；含调休出来的工作日如 02-23、10-07，
    不含补班周末）。`upcomingChanges()` 给出未来 8 天的切换点；`peakView()` 组装载荷里的 `peak`（当前时段、切换点、提醒设置、到期提醒）。
  - 账本：`session_rollups` 加 `phase` 列进主键，**schema 4 → 5 原地迁移**（新表拷全部行、`phase=''`、换名），**不走整表 DROP** ——
    否则日志已删的会话找不回，10-03 手工归并的账也会长回来。`meta.phaseSince` 记下开始分时段的时刻（迁移或建库那一刻），
    之前的用量（包括以后任何一次重折叠）一律 `phase=''`、按原价计，之后的按事件时刻分类。`reset()` 不清 `meta`，所以 reindex 也不会改写历史。
    `byModel` / `byProviderModel` / `byRoute` 默认仍合并时段（显示、导出、`ctx.tokenLedger` 形状不变），只有计价传 `{ phase: true }` 拆开。
    ⚠️ **回滚**：v5 的库被 v4 的旧版本打开会触发「schema 比本版新、拒绝丢弃」，插件不加载（账本不受损）；回滚到 `acb5a28` 前要先想好这一点。
    实测：10-14 用真实账本的 `VACUUM INTO` 副本迁移，458 行 / 413 个 checkpoint 全在，27 组 provider+model 合计逐字相同，内置价表算出的总额与旧代码同为 ¥41.693718；副本已删。
  - 计价：费率可带 `offPeak: { factor, holidays }`，`perMillion` 即**高峰价**；`estimateCost(buckets, rate, phase)` 对谷时段乘 `factor`，`holidays` 默认 true。
    内置 DeepSeek 官方 8 条全部带 `{ factor: 0.5, holidays: true }`。`priceWithConfiguredRates`、`priceToday`、`dailySeries` 改读拆时段的行，合并时去掉 `phase`。
    没带 `offPeak` 的费率不受影响。
  - 面板（`client.js`）：「用量账本」下加一行「高峰 · 23 分钟后空闲」（高峰时用警示色，悬停给规则与 CC/OpenCode 的节假日差异），30 秒走一次本地钟；
    `PeakToast`：切换前 `aheadMinutes`（默认 5）分钟右下角小卡片，`target` 可选 both / peak / offpeak，同一切换点本次启动只弹一次，切换后 2 分钟自己消失；
    `HolidayNotice`：节假日表有效期（默认＝表里最后一年的 12-31，可配 `holidaysUntil`）前 `remindDays`（默认 10）天起，**每次打开 DSH 弹一次**，过期后继续弹。
    提醒按 DeepSeek 官方口径（节假日算空闲），对所有模型都提醒。
  - 配置：`settings-schema.js` 加 `peak`（`alert` / `aheadMinutes` / `target` / `holidays` / `holidaysUntil` / `remindDays`）；`holidays` 是**追加**到内置表上的北京日期。
  - 守卫测试：`test/peak.test.js`（时段边界表、周末与补班周六、节假日三分类、宿主时区无关、2026 表与通知逐条对、切换点跨周末/国庆、分类器的截止时刻、到期提醒窗口）、
    `test/peak-ledger.test.js`（v4 原地迁移保住全部行与 checkpoint、新库记 phaseSince、拆时段存/合并显示、跨时段重报不重复计、谷时段半价/无时段按原价/网关节假日按峰）、
    `test/pricing.test.js` 的 offPeak 四条、`test/client.test.js` 的峰谷四条、`test/settings-schema.test.js` 默认值。
    变异验证：`src/` 整体换回改动前，以上 14 条全红；单把 v4 原地迁移关掉（回到 DROP），迁移那条红。**合上游时这一处要保留**（上游没有峰谷）。
- **自动重建不清表：只清 checkpoint、逐会话替换、最后清孤行**（2026-10-20，用户「又出现那个点一下增加累计的bug了」）：
  - 现象：DSH 改了 `relays` 后重启（12:14），归因对不上 → `runSweep` 走 `store.reset()` + 整份重折叠，真实账本约两分钟。
    这期间每次打开面板、点今日/本月/累计、点刷新都请求 `/api/tokenledger/usage`，它要的那次 sweep 因 `running` 直接返回，读到的是**清空后重建到一半**的库，
    累计数一点一涨。重建完就恢复（当日实测：连采 2 分钟 518 行 / 29,160 次请求恒定，接口连请求 6 次逐字相同）。
  - 改法：`plugin.js` `runSweep` 的「relay 集合变了 / 归因过期」那条路径把 `store.reset()` 换成 `store.forgetCheckpoints()`（只删 checkpoint），
    每个会话照旧从 seed 边界整份重读、`commitSession` 先删后插替换它自己的行，所以重建中途累计基本不动（只在会话之间换站点归属）；
    sweep 完整跑完后 `store.dropUnfolded()` 删掉没被重新提交的会话（日志已删 / 读失败 / 空）—— 与 `reset()` 丢的是同一批，只是挪到最后，
    否则它们带着旧归因留下，`staleAttributions()` 会一直判过期、每轮重建。列表本身失败（`scanned 0 且 failed > 0`）时不清，`rebuilding` 留到下一轮做完。
    `loadState()` 在没有 checkpoint 时返回空状态，两条读日志的分支都不会把旧行叠进新折叠，不重复计。
    显式重建不变：`/tokenledger reindex` 与 `ctx.tokenLedger.reindex` 仍走 `reset()`（后者是兼容边界，行为不许变）。
  - 守卫测试：`test/apply.test.js`「a rebuild keeps the cumulative total whole while it runs…」（卡住第二个会话的读，中途累计必须还是 3000、
    已重读的那个已归到 relay；放行后日志已删的会话被清、剩下的全部归到 relay）与「a rebuild whose listing fails after the probe…」。
    变异验证：`src/` 换回改动前，第一条红在中途累计 `actual: 1000`（正是现场症状）；把列表失败的判断去掉，第二条红在 `actual: 0`。
    **合上游时这一处要保留**（上游仍是 `reset()`）。
- **重启不再重建账本；账本归并改成收账时按配置合并（`merge`）**（2026-10-20，用户「两个都做」）：
  - 现象（当日实测）：没改任何配置的一次重启（13:45:24）也把 454 个会话整表重折叠了**两遍**。第二遍里 `unrouted` 从 33 行回到 23 行，
    差的 10 行正好是 `qoder-cn` 的行数 —— 推断：首轮 sweep 时 Qoder 等服务商插件还没注册，`staleAttributions()` 把「目录里没有」当成「该记 unrouted」，
    按半张目录重建一遍；插件注册后 origin 集合变了（`moved`），再重建一遍。每次重启手工改过的账（10-03 的归并、10-20 的改名）都被冲掉。
  - 改法（`plugin.js`）：① `staleAttributions()` 遇到 `resolveSite()` 返回 `undefined`（目录里没有这个服务商）就跳过 —— 没列出来是「还不知道」，不是「变了」；
    代价：服务商整个卸掉后，它的旧行留在原站点、不再改记 `unrouted`。② origin 集合变了（`moved`）只记日志、不再单独触发重建 —— 它能挪动的行都会被 stale 检查看到。
    ③ 自动重建等目录（是否可读 ＋ 每个服务商的 baseURL ＋ 直连服务商名单）连续 `rebuildSettleMs`（默认 60 秒，内部参数、不进设置）不变才动手，免得按半张目录折叠。
  - 归并（`usage.js` `applyUsageDelta` 的 `merge` 选项 ＋ `normalizeMergeConfig()` ＋ `unmergedRoutes()` ＋ 设置项 `merge`）：
    `merge.providers` / `merge.models` 把旧路由名 / 旧模型名在**记行之前**换成新名，合并后的路由按**新名**解析站点；账本里还留着旧名的行会触发一次（等过稳定期的）重建。
    只换一跳；删掉某条不会自动拆开已合并的行，要 `/tokenledger reindex`。装机配置写了 10-03 用户定的四条（见 profile `cordis.patch.yml` 的注释）。
  - 守卫测试：`test/plugin.test.js`「a provider missing from the directory is not evidence…」「the merge config renames routes and models as they are folded」
    「rows written before a merge was configured ask for a re-fold」「merge config ignores entries that are not a rename」；
    `test/apply.test.js`「a restart whose provider plugins register late does not rebuild the index」「an automatic rebuild waits for the directory to hold still」
    「configuring a merge re-folds the old rows…, and a reindex keeps them merged」。三条原有重建测试加了 `rebuildSettleMs: 0`。
    变异验证（每次只拆一处）：缺席当 unrouted → 2 条红；`moved` 恢复触发 → 迟注册那条红；去掉稳定期 → 稳定期那条红；收账不传 `merge` → 2 条红；忽略未合并行 → apply 归并那条红。
    **合上游时这一处要保留**（上游没有 `merge`，仍按 origin 集合变动重建）。
- **账本重建留记录、诊断里看得见**（2026-10-20，用户「这些老问题一直出现 是为什么 能预防吗」→「都做」）：
  - 来由：修复前每次重启都整表重建两遍，却没人知道 —— 宿主不落插件日志，唯一痕迹是 454 个 checkpoint 时间戳相同。看不见的重建，就是「老毛病时好时坏」的来源。
  - 改法：`store.js` 新增 `recordRebuildStart(reason)` / `recordRebuildDone(dropped)` / `rebuildRecord()`，一条 `meta` 记录 `rebuild = { count, at, reason, doneAt?, dropped? }`
    （`reset()` 不清 `meta`，所以记录比它描述的重建活得久）；`diagnostics()` 只在有记录时多出 `lastRebuild` 字段（附加、不改原有字段，`ctx.tokenLedger.diagnostics` 随之附加）。
    `plugin.js`：自动重建开始时记原因（哪几个路由 `site -> expected`、哪几条 `merge`），`dropUnfolded()` 后记结束；`/tokenledger reindex` 命令也记；
    兼容边界 `ctx.tokenLedger.reindex` **不记**（行为不许变）。`/tokenledger diagnostics` 多两行「账本重建 / 最近一次的原因」（`rebuildLines()`）。
    不做弹窗或主动提醒（10-18 用户否过同类主动提醒）。
  - 配套（不在 `src/`）：`tools/ledger-maintenance.mjs status` 打印同一条记录并检查「一个路由多个站点」（10-03 死循环的判据）；
    `rename-model` 不加 `--force` 拒绝执行（退出码 2）、打印该写进 `merge` 的配置 —— 规矩由脚本把关，不靠文档（呼应 10-09 用户定的「改动由脚本事后把关，不靠提示词」）。
  - 守卫测试：`test/store.test.js`「the rebuild record counts rebuilds, survives reset…」、`test/plugin.test.js`「diagnostics says whether, when, and why…」、
    `test/apply.test.js` 重建那条加了记录断言、新文件 `test/ledger-maintenance.test.js`（以子进程真跑脚本，`HOME` 指到临时目录）。
    变异验证：去掉开始 / 结束记录、去掉诊断字段、去掉 `--force` 闸门、去掉分站点检查，各自对应的测试都红。**合上游时这一处要保留**。
