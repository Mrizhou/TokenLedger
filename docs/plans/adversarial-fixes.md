# 对抗审查修复 — Plan

## Goal
修复 2026-10-12 对抗审查的全部发现（6 high + 15 medium + low + 测试组 11 条缺口），每步加测试、做变异验证、跑全量 + pack 契约，最后 push + 按新 SHA 重装并向用户报告。Done = 全量测试绿、pack 干净、工作区干净、装机 SHA 已换、账本完整。

## Constraints / decisions
- 用户拍板：全部都修、按 H4+M12 → H1+H2+H3 → H5+H6 → 其余 medium/low → 测试缺口的顺序，注意测试。
- 仓库红线：`npm install` 已有（node_modules 在）；Windows 不 spawn npm（用 shell:true 的 npm）；对上游 DSH API 只做探测+降级；sweep 异常静音——修的时候别把"静音"语义搞丢，只加可见性。
- 每处源码改动必须配测试 + 变异验证（源码换回旧写法，新测试必须红），这是本仓库红线 6 的要求。
- 报告里的"误报 1 条"（settings 抹凭据）不修，已用 schemastery 仿真宿主实证推翻。
- 报告里"记录在案即可"的不修：loopback Origin 可绕过（设计如此）。
- 每完成一组就提交一次（小步提交），作者身份用仓库 local override（Mrizhou noreply）。
- 重装只在最后做一次（多组改完统一装），用桌面版自带 node+pnpm，完整 40 位 SHA。
- `dsh.profile.bundles` 里已有 dsh-tokenledger，无需手工改；重装后核对 package.json 行 + bundles 行 + 装机 src 内容一致 + 账本行数/总数守恒。

## Steps
- [x] 0. 收拾工作区：删 3 个一次性探针（tkl-probe-b/c、收件箱 cost-probe）。AGENTS.md 5 行坑记录留待随修复提交。
- [x] 1. H4+M12 单行修复组：http.js priceToday 加 try/catch；newapi-user.js:362 补 response 参数；各加测试+变异验证；跑全量+pack；提交。(d5c52a4, 605/605)
- [x] 2. H1+H2+H3 计价语义重构组（用户已批方案）：H1 partial 行单列 partialTotals/partialModels（选 b）；H2 按日计价后汇总；H3 按 effectiveDates 切点分段+卡上披露；渲染侧（report/client/blue/http/余额卡）同步；各加测试+变异验证；跑全量+pack；提交。(67f5741, 610/610)
- [ ] 2. H1+H2+H3 计价语义重构组：先出设计方案给用户看（priceRows partial 行处理、按日计价、快照按日存三选的取舍），用户点头再动手；动手后加测试+变异验证；跑全量+pack；提交。
- [x] 3. H5+H6 账本组：reset 前加 canListSessions 可读性探测（list 失败不丢库）；referenceFor 按请求 id 优先找 key；H5 集成测试（apply 双代 relay 变化+坏 persistence）+ canListSessions 四断言；H6 双 key 测试；变异验证通过；跑全量+pack；提交。(待提交)
- [ ] 4. 其余 medium/low 组：M1 window 拒绝、M2 priceToday 多货币、M3 rates 替换语义文档+告警、M4 sweep 失败可见性、M5 cursor 腐坏自愈、M6 usage:null 守卫、M7 legacy 重编号自愈、M8/M9 dayOffsetMinutes 口径统一、M10/M11 趋势线 null 与 Blue 路由拆行、M13/M14/M15 订阅与余额校验、low 组（caption 破折号、极小金额、未知余额态、负余额钳位、探测 abort、dispose 中断在飞请求）；逐个加测试+变异验证；跑全量+pack；提交（可分 2-3 个提交）。
- [ ] 5. 测试缺口组（测试组 11 条）：priceToday 零覆盖、跨代际区间计价、路由行 cost 回退、無 logger 失败路径、句柄 close 保证、并发 sweep、余额缺桶/跨币/超支、弱断言补强、unmount 迟到回包、offset 两套时钟、CSV 双向断言；逐个补测试；跑全量+pack；提交。
- [ ] 6. 收尾：全量最后跑一次 + pack；push；按新 SHA 重装；核对装机（package.json 行、bundles、src 内容一致）；验证账本（schemaVersion、行数/总数只增不丢）；清 TEMP 残留；确认工作区干净；AGENTS.md 钉换新 SHA 后提交+push；向用户报告。

## Progress log
- 2026-10-12: 计划落盘。工作区已收拾（删 3 探针）。AGENTS.md 5 行未提交留待步骤 1-6 随附提交。

## Open questions / blockers
- 步骤 2 需要用户先看设计方案（重构面大，见下）。H1 的 (a)/(b) 取舍、H3 快照按日存的 schema 变更代价，都要用户拍板。
- 无其他 blocker。

## 步骤 2 设计方案（H1+H2+H3，待用户批）

### 现状（三处病根是同一个：时间维度被压扁了）
- H2：`priceWithConfiguredRates`（plugin.js:71-98）把区间多天用量先聚合，再用 `day = range.to ?? range.from ?? today` 一个日期查整段费率。跨 effectiveFrom 必错一边；且"本月"range 只有 from、无 to。
- H1：`estimateCost`（pricing.js:166-187）对 rate 缺桶返回 priced:true + 偏小 cost；`priceRows` 只看 priced 不看 unpricedBuckets；`spentBetween`（manual-balance.js:80-86）把偏小值累进 spent。
- H3：`spentBetween` 全 delta 用一个 day（今天）定价，录入后调价则老用量按新价扣。

### 方案（一次重构，三处同治；不改 store schema、不改账本）
1. **按日计价后汇总（治 H2）**：`priceWithConfiguredRates` 改为按 `store.byDay`（已有索引 idx_rollups_day）取区间内有量日，对每天分别 `priceRows` 后把 totals 按货币累加。`dailySeries`（http.js:298-319）已经是这个做法，复用同一思路。单日查询仍走现有 `byModel/byProviderModel` + range={from:day,to:day}，无新索引需求。坏表语义不变（catch 丢成本列）。
   - 代价：一次区间查询变成 N 次按日查询（N=区间天数）。本月按 30 天计是 30 次 sqlite 查询，账本 381 行规模下可忽略；累计 40 天同样。性能测试会钉死上限。
   - 不选"让 priceRows 接受逐行 day"：priceRows 是纯函数，改签名会波及 report/http/client 三处调用方；按日循环调用方只动 plugin.js 一处。
2. **partial 行单列（治 H1，选 b 而非 a）**：`priceRows` 对 `unpricedBuckets` 非空的行：cost 保持算出的偏小值但另立 `partialTotals`，该行进 `partialModels` 名单（面板显示"~¥x（部分未定价）"）；主 `totals` 不收偏小值。`spentBetween` 同步：partial 行不扣减、只记名。理由：选 (a)（直接置 null）会让 DeepSeek 全系（官方表故意不对 cacheWriteTokens 定价）大面积变 —，比现在更差；(b) 保留信息且总额不再撒谎。
   - 代价：`priceRows` 返回形状多两个字段（`partialTotals`、`partialModels`）；client/blue/report 三处渲染要认新字段（只加分支，不改现有）。
3. **快照按 effectiveFrom 分段存（治 H3，折中）**：不动 store schema、不改快照形状。`spentBetween` 改为：取 rate 表在该模型上的全部 effectiveFrom 切点（`RateTable` 内部已有按模型排序的 list，加一个只读 accessor 取切点），把 delta 按"基线日→今天"切段，每段按段内费率计后累加。基线日本身未知（快照只存累计桶）——用"最早切点之前全按最早费率"兜底，并在卡上注明"按当前价回算历史，调价后仅供参考"（审查建议的披露句保留）。
   - 代价：`RateTable` 加一个取切点的方法；`spentBetween` 签名不变（rateFor 已能按任意 day 查，只需多查几次）。
   - 不选"快照按日存"：要改 credentials 文件形状 + `usageSnapshot` 按日分组，老快照迁移复杂，收益只在"录入后调价"这一种情形，代价不成比例。

### 验收（测试组高优先级缺口正好当验收）
- 跨 09-10 改价的区间 totals 按日分段正确（测 H2）。
- partial 行进 partialTotals 不进 totals，面板字段透传（测 H1）。
- 录入后调价的 spent 按切点分段（测 H3）。
- 每个修复配变异验证（源码换回旧写法，新测试必须红）。
