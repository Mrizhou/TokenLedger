# TokenLedger

DSH Desktop 的第三方 token 计量插件。**这是 fork，不是原创**：
上游 `github.com/zh667/TokenLedger` → 我的 `github.com/Mrizhou/TokenLedger`（origin）。
**上游的状态：收 PR 快，自己不推功能**（2026-09-15 查证：外部 PR 常在当天合，我们的 #63 从提到合 2 小时；
2026-09-29 复核：最后 push 09-15、npm 停在 08-15 的 `0.1.0`、issue #61 靠外部 PR 才修，而作者本人在推别的仓库）——
「上游不活跃」这句**对功能与发版成立、对 PR 不成立**，别把两者混成「弃坑」。
留着 fork 的理由：我们有几样**不打算上游**的东西。
🔴 **2026-10-03 起 DSH 装的就是本 fork**（2026-10-20 起钉 `70300c5`）。09-29 ~ 10-03 一度改用 `dsh-cost-meter`（当时的理由是省 token：
「之前的那个人家都不维护了，要我自己更新 很麻烦」），10-03 用户定「把现在的换成之前那个」换回（嫌 cost-meter 显示花哨）。
**两条都是用户定的，别拿其中一条去否定另一条**；装机事实以知识库 `40-领域/技术/DSH配置与排障.md` 的插件表为准，别拿本文件推断「现在装的是谁」。
**2026-09-23 用户定：本插件改为「自用专用」**（原话「以后这个插件我自己专用」）——同步纪律降级为「上游有修复就择优合并」，不为通用性克制功能；文档以本机实际为准。同日对三路对抗审计的全部发现（4 Critical、8 必修、5 次级）做了整体加固：CSRF 写闸、传输围栏与响应体上限、fold 类型混淆/\0/去重键、schema 降级拒毁、CSV 公式闸、成本只计官方路由、`dayOffsetMinutes` 切日、空串/垃圾 baseURL 族。

**同步纪律：尽量跟随上游。** 我们只在上游没有的地方保留：本文件的中文规则部分（2026-09-22 起 `AGENTS.md` 合并了原 `CLAUDE.md` 全文，
`CLAUDE.md` 只剩 `@AGENTS.md` 导入行；文末「附」段随上游同步）、
`test/blue-packaging.test.js` 的 Windows shell spawn（**有意不上游**，见决策记录）、
`test/plugin.test.js` 末尾两个 sweep 测试（上游 `test/sweep-handle-api.test.js` 覆盖更全，留作守卫），
以及 **`src/` 里与上游不同的四处**（前两处同一族问题：宿主目录里「内置 provider 路由」的 origin 存在
pi-ai catalog 里，settings 的 profile 看不见；第三处是 0.1.7 的 revision 语义适配；第四处是 0.1.7 的席位语义适配）：

> 本 fork 相对上游的**逐条差异清单**（来由、实测现象、守卫测试名、逐条「合上游时是否保留」）已原样移出到
> `docs/FORK-VS-UPSTREAM.md` —— 2026-09-30 移出（为压到 Antigravity 读规则文件的 24000 字节上限以内），内容一字未改。
> 上面那段只是目录，逐条结论在那份文件里：① `balance.js` 跳过没配置的 catalog 路由；② `BUILTIN_PROVIDER_ORIGINS` 加 `xiaomi`；
> ③ `plugin.js` `revisionUnchanged()` 的 0.1.7 revision 形态；④ `client.js` 的 0.1.7 侧边栏席位样式；⑤ 0.1.7 首开慢那组修复；
> ⑥ MiMo 余额改手填、按账本用量扣减（`manual-balance.js`，10-04 起；09-25 ~ 10-04 是控制台 cookie）+ `credentials-file.js`；⑦ DeepSeek 先读登录账户钱包；⑧ Command Code 的 `/alpha/*` 额度与表项；⑨ 侧边栏「用量账本」下的当前模型余额（`client.js` 读 DSH 模型选择 ＋ `balance.js` 的 `findAccount`）；⑩ Antigravity 插件的额度进余额账户（探测 `antigravityAuth` 服务）；⑪ 面板「余额」一节列**全部账户**、去掉下拉选择（`client.js` `useBalances`）；⑫ 阿里云百炼的余额用 AccessKey 读阿里云费用中心（`aliyun-bss.js`）；⑬ DeepSeek 峰谷：侧边栏时段行、切换前提醒、节假日表到期提醒、按时段计价（`peak.js`，账本 schema 5 加 `phase` 列）；⑭ 自动重建不清表（`forgetCheckpoints()` ＋ `dropUnfolded()`）；⑮ 重启不再重建 ＋ 收账时按 `merge` 配置归并；⑯ 账本重建留记录（`meta.rebuild`，诊断里可见）；⑰ Qoder 的两条路由进 `BUILTIN_PROVIDER_ORIGINS` ＋ `VENDORS` 占一个无读取器的位置（10-23，**别改用 `relays` 钉站**）；⑱ 重建只丢日志真没了的会话、读不出的保旧行（10-24）。
>
> **什么时候必须去读它**：同步 / 合并上游之前；要动上面 ①–⑱ 涉及的 `src/` 文件之前；想删某条守卫测试之前。
> **合上游的铁律**：标了「合上游时这一处要保留」的一律保留本 fork 写法；上游自己修了同一处就取上游那份，
> 但必须确认对应守卫测试仍全绿。**任何一处都不许在合并里被静默丢掉。**

其余再出现重复实现，**取上游那份**。

**架构约束的正本**是本文件末尾「附：上游 AGENTS.md 原文」那一段（renderer 无关性、
`ctx.tokenLedger` 兼容边界、Blue 适配器的隔离要求、cleanup 顺序）。**改代码前先读它。**

## 技术栈

Node.js ≥22、ESM、**零运行时依赖**、**无构建步骤**（`package.json` 的 `files` 直接发 `src/`）。
测试用 Node 内置 `node --test`，没有框架。

## 怎么跑

```bash
npm install                        # 不能省，见红线 2
npm test                           # 全量，当前基线 679/679（2026-10-24）
node --test test/plugin.test.js    # 单文件
npm pack --dry-run --json          # 打包契约（AGENTS.md 要求跟 npm test 一起跑）
```

## 红线

1. **🔴 改这个仓库不会修好运行中的 DSH —— 要 push 之后按新 SHA 重装。**
   ⚠️ **本插件 2026-10-03 起已装回**（2026-10-20 起钉 `70300c5`，装机事实以知识库插件表为准）。本节是**装机 / 重装**流程，照它做。
   ~~2026-09-24 起宿主是**桌面版 0.1.7-rc.2**，装机版**直接从本 fork 装**进 `~/.dsh/profiles/desktop`：~~
   用桌面版自带的 node + pnpm 执行 `add "github:Mrizhou/TokenLedger#<40 位完整 SHA>"`
   （短 SHA 解析不了；完整命令与 `DSH_DESKTOP_NODE_EXECUTABLE` 的坑见知识库「DSH配置与排障」），
   装完**完全退出桌面版（含托盘）再开** —— 服务端代码不热加载。**不再手工打补丁。**
   （09-17 ~ 09-24 是 `dsh plugin --profile web add` + 重启 `dsh web`，web 版已删。）
   **别从 npm 装**：npm 上只有 08-15 的 0.1.0，缺句柄式 persistence 兼容，在现在的宿主上
   **静音不记账**（09-11、09-16 两次都是这样死的）。
   换装会触发账本重建：store schema 不一致时整表 DROP、从会话日志重折叠，
   **日志已删的会话用量找不回**（09-17 那次丢了 43 个，数字记在知识库项目笔记时间线）。

   **手工补丁时代已彻底结束，别再回去打补丁。** 那三处补丁（persistence 句柄兼容、重编号重折叠、下拉配色）
   连同装机目录里的 `src/*.bak-pre-*` 备份，2026-09-16 随 desktop profile 一起没了 ——
   **本仓库 `src/` 下现在一个 `.bak` 都没有**，装机版直接按 SHA 从本 fork 装（上面「装机 / 重装」就是全部流程）。
   三处的现状：前两处上游已合（#64 因此关掉，[PR #65](https://github.com/zh667/TokenLedger/pull/65) 是它的超集 ——
   老 checkpoint 指到重编号后日志的末尾之外，读回空 → 会话被永久跳过且静音，见红线 5）；
   [PR #63](https://github.com/zh667/TokenLedger/pull/63) 的下拉配色随 `AccountPicker` 一起被删掉了。
   历史清单、自检命令与逐条来由记在知识库项目笔记（`70-归档/TokenLedger.md`）与 `docs/FORK-VS-UPSTREAM.md`（差异正本）。
   ⚠️ 若哪天又看到「重打补丁」「`.bak-pre-*` 待清除」这类字样，那是**过期描述**，不是待办。

2. **🔴 没跑 `npm install` 就别下"测试挂了"的结论。**
   `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 是 devDeps，缺了会让
   `boot` / `settings-schema` / `blue-entry` 三个文件整文件加载失败（5 个 fail），
   报的是 `ERR_MODULE_NOT_FOUND`，不是断言失败 —— 别去改代码。

3. **🔴 Windows 上不要直接 spawn `npm`。**（`test/blue-packaging.test.js` 2026-09-14 已修）
   `npm` 在 Windows 上是 `npm.cmd`，`execFileSync("npm", …)` 报 `ENOENT`；
   **改成 `npm.cmd` 也没用** —— Node 18.20/20.12/22 之后不带 shell spawn `.cmd`
   会抛 **EINVAL**（CVE-2024-27980 的缓解）。唯一可行的是 `shell: true`，
   而走了 shell，带路径的参数就要自己加引号。全量基线现在是 **679/679**（2026-10-24）。

4. **🔴 对上游 DSH 的 API 一律"探测 + 降级"，不要二选一改掉。**
   这是 fork，既要能跑在新 DSH 上，也要能回滚。
   已经这么处理的：`persistence.list ?? persistence.listSnapshots`、
   `typeof persistence.open === "function"` 走句柄否则 `readFrom`。
   **句柄必须在 `finally` 里 `close()`。**

5. **🔴 `sweep()` 的异常是静音的**（catch 住只 `logger.warn` + `stats.failed++`）。
   所以上游一改 API，现象是"面板空白 / 数据不长"而**不是报错**。
   动 `sweep()` 时想清楚：新的失败路径会不会又被这层 catch 吞掉。

6. **测试替身照真实 API 的形状写，不要照着 bug 写。**
   `test/plugin.test.js` 顶部注释记着这个教训：`listSnapshots()` 返回
   `{ header, revision }` 而**不是** `{ id }`，早期替身照 bug 写，结果整类 bug 测不出来。
   加兼容分支时，新替身要做**变异验证** —— 把源码换回修复前，新测试必须失败。
   **还要照真实时序写**：服务商插件是启动后陆续注册的，「一开始全在」的替身测不出启动竞态（10-20 重启重建两遍就这么漏的）。

7. **🔴 账本（`~/.dsh/tokenledger.sqlite`）是从会话日志算出来的派生数据，不手改。**（2026-10-20 用户定）
   能用配置表达的写配置（归并 `merge`、站点 `relays`、价格 `rates`），任何重建都保持；直接改库，下次整表重建就按日志长回来（10-03、10-20 都丢过）。
   所以 `ledger-maintenance.mjs rename-model` 不加 `--force` 拒绝执行、只打印该写的 `merge`。
   查健康：`/tokenledger diagnostics` 或 `ledger-maintenance.mjs status`（重建几次、为什么、有无「一个路由多个站点」）。

## 目录：什么进什么（2026-09-30 起）

> 规矩正本：知识库 `40-领域/技术/项目目录规范.md`（工程版 ＋ 出处）；归位与清理用 skill `project-tidy`。
> **五条硬规矩**：① 根上只许**四类文件**（入口 / 配置 / 发布必备 / 插件框架入口），**除这四类以外根上只许有目录，一个多余文件都不许有**；② **根目录尽量干净**（2026-10-18 用户定）—— 空的骨架目录**不常驻根上**：`00-收件箱/`、`logs/`、`state/`、`archive/`、`results/` 一律**按需现建、用完即删**（git 本来也不收空目录），根上只留真有内容的目录；③ `00-收件箱/YYYY-MM-DD/` 是**当天做的、还没想好放哪**的东西的暂存区，由 skill `project-tidy` 定期归位、归位后空的日期夹删掉 —— **它不是产出目录**；④ **一次性产物直接清除、不进 `archive/`**，只有有参考价值的旧版本才收档到 `archive/YYYY-MM-DD-<主题>/`；⑤ 一级目录按语义分，**日期只允许出现在两处**：`00-收件箱/YYYY-MM-DD/` 与跑批产出 `results/YYYY-MM-DD-<主题>/`。

**根目录只允许（四类）**：入口 `README.md` · `AGENTS.md` · `CLAUDE.md`；配置 `.gitignore` · `package.json` · `package-lock.json`；发布必备 `LICENSE` · `NOTICE`；**插件框架入口 `blue.plugin.json` · `cordis.patch.yml`** —— ⚠️ **这是 DSH 插件的框架约定（包根 ＝ 仓库根），它们本来就该在根上，不是乱**。

| 现有/应有目录 | 什么进这里 | 不许进 |
|---|---|---|
| `src/` | 插件代码（宿主半边 / 浏览器半边；Blue 专属代码只在 `src/blue/`）。**与上游不同的四处差异逐条记在 `docs/FORK-VS-UPSTREAM.md`** | 手工补丁备份 `*.bak-pre-*`（一次性产物 → 直接清除；**现仓库里一个都没有**）；日志 |
| `tools/` | 维护工具（Node/ESM 零依赖维护脚本，如 `tools/ledger-maintenance.mjs`） | 一次性手跑临时脚本 |
| `test/` | 测试（`node --test`，全量基线 679/679） | 手跑脚本冒充测试 |
| `docs/` | 文档，**按主题分**。现有：`FORK-VS-UPSTREAM.md`（差异正本）、`HOST-CONTRACT.md`、`BLUE-MIGRATION.md`、`COMPARISON.md`、`ROADMAP.md`、`UI-PLAN.md`、`FEATURES.md`、`registry-entry.json`、`plans/adversarial-fixes.md`、`images/` | ⚠️ **`docs/决策记录.md` 不存在也不该建** —— 本仓库是公开 fork，个人决策记在知识库 `40-领域/技术/决策记录.md`（正本）与 `70-归档/TokenLedger.md`（项目笔记）；根目录上的一次性报告 |
| `node_modules/` | 依赖；**已 gitignore**（`.gitignore` 第 1 行），没跑 `npm install` 别下「测试挂了」的结论，见红线 2 | 提交进 git；当源码读 |
| `00-收件箱/YYYY-MM-DD/`（**按需建，现无内容**） | **当天做的、还没想好放哪**的东西先扔这儿，等 skill `project-tidy` 归位；**归位后空的日期夹与空的 `00-收件箱/` 都删掉**（别常驻根上） | 当成长期仓库；产出目录 |
| `logs/`、`state/`（**按需建，现无内容**） | 运行期产物：`.log` · `.pid` · 状态 json —— **一律进 `.gitignore`**（账本 `~/.dsh/tokenledger.sqlite` 在用户目录，**不在本项目**、别删） | 放在根目录；提交进 git |
| `archive/YYYY-MM-DD-<主题>/`（**按需建，现无内容**） | **只收有参考价值的旧版本**：旧版本文档、确需回看的旧配置 | 🗑️ 一次性产物（`.bak*`、缓存 → **直接清除**）；无界堆积 |
| 根上其余 | **应始终为空**（2026-10-18 体检：根上 12 个文件全属白名单四类、其余只有目录，0 违规）。发现白名单外的文件 → 按 skill `project-tidy` 逐条念过再动 | 任何白名单外的文件；空的骨架目录常驻 |

**禁物**（根上除上述四类文件外，一个文件都不许有）：`_tmp_*` · `*.bak*` · `*.log` · `*.pid` · 状态 json · `__pycache__/` · 序号后缀（`ablation2.py`、`result1.csv`）· 同名 `.py` 与目录并存 · 根上的 `.bat` / `.sh` / `.ps1`（进 `bin/`）· 一次性报告。
**两类处理方式不同**：🗑️ 一次性产物 → **直接清除**；📦 有参考价值的旧版本 → 收档 `archive/YYYY-MM-DD-<主题>/`（`archive/` 是收档，**不是垃圾桶**）。

## 已知的坑

- **装机版是 fork 的某个 SHA**，不一定是仓库 HEAD。现在钉 `70300c5`（2026-10-20；装完复查 `package.json` 那一行 —— 同一分钟插件市场自动更新会把清单写回旧 SHA，见知识库「怎么装 / 换插件」）。
  重装 / 换 SHA：看 `~/.dsh/profiles/desktop/package.json` 的 `dsh-tokenledger` 行，再对仓库 HEAD；
  注意 `pnpm add` / `remove` **都不管** `dsh.profile.bundles`，两端都要手工改（知识库「怎么装 / 换插件」）。
- `~/.dsh/tokenledger.sqlite` 是**唯一全量、不截断**的历史，2026-10-03 起重新在写。
  09-29 ~ 10-03 那段的账在 `~/.dsh/storages/cost-meter/ledger.json` 里（按 provider+model、按 `historyDays` 截断）——**留着可抄、别删**。
- **2026-10-03 给面板定的两条约定**（改这块代码前先读）：
  ① 模型行按 **`<路由>/<模型名>`** 命名 —— **一行只许一个斜杠**：Command Code 的目录 id 自带厂商前缀（`deepseek/deepseek-v4.1-flash`），
  所以**路由段取代厂商段**显示成 `commandcode/deepseek-v4.1-flash`，完整 id 留在悬停 `title`，同一路由下撞名时不折叠；文字报表 `/tokenledger` 仍印裸 id。
  ② **粒度改细要同时改三处**：数据分组（`store.byProviderModel`）、行上的派生值（计价走 `priceWithConfiguredRates(..., byRoute=true)`，报表仍按模型）、
  **列表 key**（`rowKey(m)` = 路由+模型）。漏掉第三处的症状不报错 —— 表格里某一行要等下次重渲染才出现/数字不对。
- **给新模型配价时，`effectiveFrom` 要填区间起点，不是配价当天**（2026-10-12 踩过）：`priceWithConfiguredRates` 用
  `day = range.to ?? range.from ?? dayKey(Date.now())` **一个日期**解析整个区间的费率，而三个窗口的 range 形状不同 ——
  今日 `{from: 今天}`、本月 `{from: 10-01}`（**没有 to**）、累计 `{}`（回落到今天）。
  所以把当月新模型的 `effectiveFrom` 填成「今天」，结果是**今日和累计有估算、本月没有**，且不报错。
  凡是账本里已有用量的模型，`effectiveFrom` 一律填「最早有用量那天」或「本月 1 号」，不要填配价日期。
- **峰谷计价只从 `meta.phaseSince` 起算**（2026-10-14，用户「以前的不算了，以后的要算」）：schema 4→5 是**原地迁移**、不 DROP，
  老行 `phase=''` 按原价（高峰）计，重折叠也不会改写这条线之前的历史。给 DeepSeek 系模型配价时 `perMillion` 填**高峰价**、加
  `offPeak: { factor: 0.5, holidays: true }`。
  🔴 **2026-10-18 起账本一律按「模型厂商官方刊例价」计，不再按第三方转售价**（用户「按官方价，不要按第三方价」「官方没有的就不填」，
  详见知识库决策记录）：账本要用同一把尺子比各家套餐，转售价会让同一模型出现两套价。所以 commandcode 路由的
  `deepseek/deepseek-v4.1-flash`（＝DeepSeek 官方 `deepseek-flash` / V4.1-Flash-1017）现按 DeepSeek 官方价 ¥2/¥0.04/¥8、
  `holidays: true` —— **不再用 Command Code 自己那套峰谷窗口与 `holidays: false`**（那条 10-14 的口径已废）。
  `holidays: false` 现在只在「照抄某网关原文、而该网关明确不给节假日豁免」时才用，DeepSeek 系模型不再属于这种。
  ⚠️ 官方无刊例价的模型（如 `gpt-oss-120b-medium`、`stealth/space-bunny-alpha`）**删掉费率不填**、让面板显示未计价，
  **不要填 0**：填 0 会被当成已计价、成本 0，与「查不到官方价」混淆。
  节假日表内置到 2026 年，**每年国务院公布放假安排后**往配置 `peak.holidays` 里追加下一年；不补的话 12 月最后十天起每次打开都会弹窗。
  ⚠️ v5 的库被旧版本（≤ `acb5a28`）打开会拒绝加载 —— 回滚前先想好这一点。
- **账本归并与路由钉住**（2026-10-20）：
  ① **归并写在配置里，收账时就按新名记**：装机 profile `~/.dsh/profiles/desktop/cordis.patch.yml`（**不是**仓库根上那份）的 `tokenledger` 条目 `config.merge`，
  现有 10-03 用户定的四条（`bd`→`google-antigravity`，`modlens-ali` / `deepseek-official`→`deepseek-account`，`gemini-3.8-flash-high`→`antigravity-gemini-3.8-flash`）。
  任何全量重折叠都保持合并，**不用再手工改库**；新增一条会自动触发一次重建，删一条不会自动拆开，要 `/tokenledger reindex`。
  ② **已卸插件的旧路由**在 `config.relays` 钉站点（`bd`、`google-antigravity`→`daily-cloudcode-pa.googleapis.com`，`modlens-ali`→百炼，`our-free-model`→`opencode.ai`）；`workbuddy-ai` 无公开端点，留在 `unrouted`。
  ③ 自动重建只在**账本行与目录 / `merge` 对不上**、且目录稳定满 60 秒后才跑；单纯重启不再重建（⑮）。改 `cordis.patch.yml` 不热生效，要完全退出桌面版再开。
  ④ `tools/ledger-maintenance.mjs`：`status` 看重建记录与站点分布；`rename-model` 只作兜底，见红线 7（不加 `--force` 拒绝执行；加了也默认 dry-run，`--apply` 先 `VACUUM INTO` 备份到 `~/.dsh/backups/`）。
- git 作者身份：全局配置是 gitee 的 `zhou-synn`，**本仓库用 local override 换成 GitHub noreply**
  （`57312813+Mrizhou@users.noreply.github.com`），提交才归到 `Mrizhou` 名下。这个 override 只存在
  本目录的 `.git/config` 里，**重新 clone 不会带过去**。
- **🔴 唯一工作区是 `D:\Workspace\Projects\工程\TokenLedger`，别在别处另 clone 一份。**
  2026-09-24 有个会话在 `Projects\` 根下另 clone 了 `Projects\TokenLedger`，在里面提交了
  `2dd93f1`、`e634cf7` 并 push —— 因为新 clone 没有上面那条 override，这两个提交用的是 gitee 邮箱，
  在 GitHub 上不归 `Mrizhou`（已推上 main，没改写历史）。那份副本随后丢了 pack 文件、git 历史断掉，
  内容与 `e634cf7` 一致、无独有改动，2026-09-25 已删除。开工先 `git log -1` 确认在这个目录、HEAD 是最新。

---

## 附：上游 AGENTS.md 原文（英文，随上游同步）

TokenLedger is a renderer-independent DeepSeek Harness domain plugin. Keep the
accounting direction as durable Harness session logs -> TokenLedger store ->
`usagePayload()` -> bounded renderer views. The Web client and the in-package
Blue adapter consume that domain truth rather than folding session events.

Blue is an optional renderer inside the single `dsh-tokenledger` npm package.
The root Cordis `apply()` owns one internal dashboard controller and passes it
directly to the Blue adapter in the same Fiber. Do not publish that controller
on `ctx`, add a second Cordis plugin row, create another npm package, or restore
the public `ctx.tokenLedgerV1` boundary. The internal controller keeps practical
collection bounds, revision consistency, abort/stale fencing, credential
filtering, and unload-safe late-result behavior without a hostile third-party
clone/descriptor protocol.

`ctx.tokenLedger` is a separate legacy/deprecation boundary. Preserve its object
identity and its exact `store`, `sweep`, `totals`, `byDay`, `byModel`, `bySite`,
`sites`, `diagnostics`, and `reindex` behavior. Do not silently narrow or replace
it. New external consumers do not receive an implicit replacement API; design
an explicit public contract only when a real external consumer requires one.

Mutable caches belong to one `apply()` instance. The Cordis plugin must use
`createNewApiWalletReader()`; the module-level wallet helper exports exist only
for compatibility. Cleanup order is Blue/controller request abort, owned cache
dispose, then store close. Never expose `LedgerStore` through the dashboard
controller.
Usage-derived notifications retain fingerprint deduplication. Settings
mount/unmount, initial/watch values, registration failure, and legacy settings
writes must notify the internal controller so configuration and writability
changes advance its revision even when usage rows are unchanged. Notify again
after `settingsScope` is assigned; an earlier initial-value callback does not
prove that writes are ready.

Keep the existing Web UI and loopback HTTP API as the golden/plain fallback.
Blue-specific interaction and renderer code belongs under `src/blue/`; it must
remain isolated from accounting and store ownership. With no Blue host, retain
the legacy `/tokenledger` command. With Blue mounted, expose exactly one
renderer-native `/tokenledger` command and restore the legacy command if Blue
unloads or fails to register.

Run `npm test` and `npm pack --dry-run --json` from the repository root. The
package intentionally has no build step. New exports must stay under `src/`, be
listed in `package.json`, and be covered by `test/packaging.test.js`.（本 fork 消歧：『listed in package.json』指模块子路径列进 exports 映射、行为有测试覆盖即可；命名导出无法『列进』exports 映射。2026-09-23 记。）
