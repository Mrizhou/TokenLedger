> **开工前先读知识库** `D:\Workspace\KnowledgeBase\`：
> - `AGENTS.md` §0 路由表 —— 什么话题读哪个文件
> - `40-领域/技术/工作习惯.md` —— 怎么跟我配合
> - `40-领域/技术/决策记录.md` —— **提方案前必查**，别重复提已否掉的
> - `40-领域/技术/资产清单.md` —— 服务器/账号/凭据位置（本地，不在 GitHub 上）
>
> 本项目的个人笔记在知识库 `70-归档/TokenLedger.md`（本仓库是公开 fork，个人内容不写进仓库）

# TokenLedger

DSH Desktop 的第三方 token 计量插件。**这是 fork，不是原创**：
上游 `github.com/zh667/TokenLedger` → 我的 `github.com/Mrizhou/TokenLedger`（origin）。
**上游其实很勤快**（2026-09-15 查证：外部 PR 常在当天合，我们的 #63 从提到合 2 小时）——
早先「上游不活跃」的说法已推翻。留着 fork 的理由：我们有几样**不打算上游**的东西，
而 DSH 装的就是这个 fork（见红线 1）。

**同步纪律：尽量跟随上游。** 我们只在上游没有的地方保留：本文件的中文规则部分（2026-09-22 起 `AGENTS.md` 合并了原 `CLAUDE.md` 全文，
`CLAUDE.md` 只剩 `@AGENTS.md` 导入行；文末「附」段随上游同步）、
`test/blue-packaging.test.js` 的 Windows shell spawn（**有意不上游**，见决策记录）、
`test/plugin.test.js` 末尾两个 sweep 测试（上游 `test/sweep-handle-api.test.js` 覆盖更全，留作守卫），
以及 **`src/` 里与上游不同的两处**（同一族问题：宿主目录里「内置 provider 路由」的 origin 存在
pi-ai catalog 里，settings 的 profile 看不见）：

- `src/balance.js` `listAccounts()` 跳过「`declared: false` 且无存储配置」的目录项
  （2026-09-17，**用户明确不提 PR**）。宿主目录列出 pi-ai 全部内置 provider，
  不跳过的话 Z.ai / 智谱 GLM 会出现在没配过它们的账户列表里，
  排在前面的空路由还会顶掉 `deepseek-official` 占走 DeepSeek 那一项。
  守卫测试：`test/balance.test.js`「a shipped catalog route nobody configured is not an account」。
  **合上游时这一处要保留**；上游若自己修了，取上游那份并确认守卫测试仍绿。
- `src/balance.js` 的 `BUILTIN_PROVIDER_ORIGINS`（上游 PR #55 建的表）加 `xiaomi` 一项并 `export`，
  `src/discovery.js` 共用它：**已配置**的路由若 profile 没写 `baseURL`，按表里的 catalog origin 归因、
  自成站点行（2026-09-23）。不做这件事的话，加了 MiMo 那天面板上什么都没有：无 `baseURL` 一律
  按「DeepSeek 默认」合并 —— 账户卡被 vendor 压缩吞进 DeepSeek，用量整包落进「直连/官方」。
  「没配过的路由不冒出来」的门槛两处同款（profile 为空就不用表）。
  守卫测试：`test/balance.test.js`「a catalog route the harness resolves by itself still gets its own card」、
  `test/discovery.test.js`「a catalog route's own endpoint is its origin…」与「…does not resurface as a site row」。
  **合上游时这一处要保留**（可上游的形态：表项按需补 + discovery 共用表；上游若合了就取上游那份）。

其余再出现重复实现，**取上游那份**。

**架构约束的正本**是本文件末尾「附：上游 AGENTS.md 原文」那一段（renderer 无关性、
`ctx.tokenLedger` 兼容边界、Blue 适配器的隔离要求、cleanup 顺序）。**改代码前先读它。**

## 技术栈

Node.js ≥22、ESM、**零运行时依赖**、**无构建步骤**（`package.json` 的 `files` 直接发 `src/`）。
测试用 Node 内置 `node --test`，没有框架。

## 怎么跑

```bash
npm install                        # 不能省，见红线 2
npm test                           # 全量，当前基线 493/493
node --test test/plugin.test.js    # 单文件
npm pack --dry-run --json          # 打包契约（AGENTS.md 要求跟 npm test 一起跑）
```

## 红线

1. **🔴 改这个仓库不会修好运行中的 DSH —— 要 push 之后按新 SHA 重装。**
   2026-09-17 起宿主是命令行 `dsh web`，装机版**直接从本 fork 装**：
   `dsh plugin --profile web add "github:Mrizhou/TokenLedger#<40 位完整 SHA>"`
   （短 SHA 解析不了），装完重启 `dsh web`。**不再手工打补丁。**
   **别从 npm 装**：npm 上只有 08-15 的 0.1.0，缺句柄式 persistence 兼容，在现在的宿主上
   **静音不记账**（09-11、09-16 两次都是这样死的）。
   换装会触发账本重建：store schema 不一致时整表 DROP、从会话日志重折叠，
   **日志已删的会话用量找不回**（09-17 那次丢了 43 个，数字记在知识库项目笔记时间线）。

   ~~旧做法（DSH Desktop 时代，已作废）~~：「不能整包覆盖，Blue 兼容声明不符」这个判断**是错的** ——
   宿主不读 `blue.plugin.json`。下表只作历史。装机目录曾有**三处**手工补丁（`plugin.js` 上叠了两处）：

   | 文件 | 补了什么 | 自检 | 备份 |
   |------|---------|------|------|
   | `src/plugin.js` | ① DSH 2.0 句柄式 persistence 兼容（2026-09-14） | `grep -c "persistence.open" src/plugin.js` | `src/plugin.js.bak-pre-dsh2-fix-20260914` |
   | `src/plugin.js` | ② 重编号日志整份重折叠（2026-09-15，见下） | `grep -c "handle.read(0)" src/plugin.js` | `src/plugin.js.bak-pre-refold-20260915` |
   | `src/client.js` | AccountPicker 下拉灰底灰字（2026-09-14） | `grep -c "tkl_select option" src/client.js` | `src/client.js.bak-pre-select-contrast-20260914` |

   ⚠️ 手工补丁**会被 DSH 市场的更新/重装悄悄冲掉**，升完要回来把上表逐条重打。
   打完必须**重启 DSH Desktop**：`plugin.js` 在启动时载入，样式表按 `STYLE_ID` 一次性注入 ——
   两者热重载都不会换掉已经在内存里的那份。

   **补丁 ② 的来由**：`86a30b6` 的句柄改法只换了读取方式，仍从 `consumedSeq + 1` 读尾巴；
   而 v1→v2 会话迁移会**重编事件 seq**，老 checkpoint 会指到重编后日志的末尾之外 ——
   读回来是空的 → `skipped` → **这个会话从此再不统计**，而且静音（红线 5）。
   上游 @wangk123 在 [PR #65](https://github.com/zh667/TokenLedger/pull/65) 里发现的，
   我们的 #64 因此关掉。本地一度自己补过一份（`ca5b3d5`），2026-09-15 同步时
   **整份换成了上游的实现** —— 我们那两个测试在上游代码上原样通过，等于实测确认等价。

   ⚠️ **上游合了不等于这张表可以删。** `client.js` 那处的
   [PR #63](https://github.com/zh667/TokenLedger/pull/63) 已于 2026-09-15 合并
   （`cf57c27` 就是我们的 commit），`plugin.js` 那两处也都在上游了 —— 但**装机版仍是
   npm 上的 0.1.0**，一行都没跟上。要等上游发版 **且** 装机版升上去，这张表才能删。

2. **🔴 没跑 `npm install` 就别下"测试挂了"的结论。**
   `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 是 devDeps，缺了会让
   `boot` / `settings-schema` / `blue-entry` 三个文件整文件加载失败（5 个 fail），
   报的是 `ERR_MODULE_NOT_FOUND`，不是断言失败 —— 别去改代码。

3. **🔴 Windows 上不要直接 spawn `npm`。**（`test/blue-packaging.test.js` 2026-09-14 已修）
   `npm` 在 Windows 上是 `npm.cmd`，`execFileSync("npm", …)` 报 `ENOENT`；
   **改成 `npm.cmd` 也没用** —— Node 18.20/20.12/22 之后不带 shell spawn `.cmd`
   会抛 **EINVAL**（CVE-2024-27980 的缓解）。唯一可行的是 `shell: true`，
   而走了 shell，带路径的参数就要自己加引号。全量基线现在是 **493/493**。

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

## 已知的坑

- 装机版是 fork 的**某个 SHA**，不一定是仓库 HEAD。排障时先看 `~/.dsh/profiles/web/package.json`
  里 `dsh-tokenledger` 钉的是哪个 SHA，再对仓库。
- `~/.dsh/tokenledger.sqlite` 是唯一的历史来源，**换插件会丢历史**
  （知识库决策记录 2026-08-31 已为此否掉过换 `dsh-usage-stats`）。
- git 作者身份是 gitee 的 `zhou-synn`，但 origin 在 GitHub（`Mrizhou`）。两边别搞混。

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
listed in `package.json`, and be covered by `test/packaging.test.js`.
