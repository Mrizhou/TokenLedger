> **开工前先读知识库** `D:\Workspace\KnowledgeBase\`：
> - `CLAUDE.md` §0 路由表 —— 什么话题读哪个文件
> - `40-领域/技术/工作习惯.md` —— 怎么跟我配合
> - `40-领域/技术/决策记录.md` —— **提方案前必查**，别重复提已否掉的
> - `40-领域/技术/资产清单.md` —— 服务器/账号/凭据位置（本地，不在 GitHub 上）
>
> 本项目的笔记：`30-项目/工程/TokenLedger.md`

# TokenLedger

DSH Desktop 的第三方 token 计量插件。**这是 fork，不是原创**：
上游 `github.com/zh667/TokenLedger` → 我的 `github.com/Mrizhou/TokenLedger`（origin）。
上游更新不勤快，所以自己维护。

**`AGENTS.md` 是架构约束的正本**（renderer 无关性、`ctx.tokenLedger` 兼容边界、
Blue 适配器的隔离要求、cleanup 顺序）。**改代码前先读它**，本文件不复述。

## 技术栈

Node.js ≥22、ESM、**零运行时依赖**、**无构建步骤**（`package.json` 的 `files` 直接发 `src/`）。
测试用 Node 内置 `node --test`，没有框架。

## 怎么跑

```bash
npm install                        # 不能省，见红线 2
npm test                           # 全量，当前基线 486/486
node --test test/plugin.test.js    # 单文件
npm pack --dry-run --json          # 打包契约（AGENTS.md 要求跟 npm test 一起跑）
```

## 红线

1. **🔴 改这个仓库不会修好运行中的 DSH。**
   实际加载的是 `~/.dsh/profiles/desktop/node_modules/dsh-tokenledger`，
   **npm 装的 0.1.0，跟本仓库（0.1.1-blue.0）是两份独立代码**。
   仓库里 commit 完就说"修好了"是错的 —— 必须另外去打那一份。
   **而且不能整包覆盖过去**：本仓库的 `blue.plugin.json` 声明
   `compatibility.harness: "0.1.2-alpha.2"`（Blue 渲染器线），本机是 DSH Desktop 2.0.6，
   整包换过去等于顺带吃下整个 Blue 重构。做法是只手工搬需要的那几处改动。

   装机目录现在有**两处**手工补丁。自检命令在装机目录下跑，**出来 0 就是被冲掉了**：

   | 文件 | 补了什么 | 自检 | 备份 |
   |------|---------|------|------|
   | `src/plugin.js` | DSH 2.0 句柄式 persistence 兼容（2026-09-14） | `grep -c "persistence.open" src/plugin.js` | `src/plugin.js.bak-pre-dsh2-fix-20260914` |
   | `src/client.js` | AccountPicker 下拉灰底灰字（2026-09-14） | `grep -c "tkl_select option" src/client.js` | `src/client.js.bak-pre-select-contrast-20260914` |

   ⚠️ 手工补丁**会被 DSH 市场的更新/重装悄悄冲掉**，升完要回来把上表逐条重打。
   打完必须**重启 DSH Desktop**：样式表按 `STYLE_ID` 一次性注入，热重载不会换掉已注入的那份。

   `client.js` 这处已提上游 [PR #63](https://github.com/zh667/TokenLedger/pull/63)，
   上游合并并发版、且装机版跟进之后，这一行可以从表里删掉。

2. **🔴 没跑 `npm install` 就别下"测试挂了"的结论。**
   `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 是 devDeps，缺了会让
   `boot` / `settings-schema` / `blue-entry` 三个文件整文件加载失败（5 个 fail），
   报的是 `ERR_MODULE_NOT_FOUND`，不是断言失败 —— 别去改代码。

3. **🔴 Windows 上不要直接 spawn `npm`。**（`test/blue-packaging.test.js` 2026-09-14 已修）
   `npm` 在 Windows 上是 `npm.cmd`，`execFileSync("npm", …)` 报 `ENOENT`；
   **改成 `npm.cmd` 也没用** —— Node 18.20/20.12/22 之后不带 shell spawn `.cmd`
   会抛 **EINVAL**（CVE-2024-27980 的缓解）。唯一可行的是 `shell: true`，
   而走了 shell，带路径的参数就要自己加引号。全量基线现在是 **486/486**。

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

- 仓库版本 `0.1.1-blue.0` ≠ 装机版本 `0.1.0`，排障时先确认在看哪一份。
- `~/.dsh/tokenledger.sqlite` 是唯一的历史来源，**换插件会丢历史**
  （知识库决策记录 2026-08-31 已为此否掉过换 `dsh-usage-stats`）。
- git 作者身份是 gitee 的 `zhou-synn`，但 origin 在 GitHub（`Mrizhou`）。两边别搞混。
