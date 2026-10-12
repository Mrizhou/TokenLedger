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
- [ ] 1. H4+M12 单行修复组：http.js priceToday 加 try/catch；newapi-user.js:362 补 response 参数；各加测试+变异验证；跑全量+pack；提交。
- [ ] 2. H1+H2+H3 计价语义重构组：先出设计方案给用户看（priceRows partial 行处理、按日计价、快照按日存三选的取舍），用户点头再动手；动手后加测试+变异验证；跑全量+pack；提交。
- [ ] 3. H5+H6 账本组：reset 推迟到首次成功读日志之后；referenceFor 按请求 id 找 key；加测试+变异验证；跑全量+pack；提交。
- [ ] 4. 其余 medium/low 组：M1 window 拒绝、M2 priceToday 多货币、M3 rates 替换语义文档+告警、M4 sweep 失败可见性、M5 cursor 腐坏自愈、M6 usage:null 守卫、M7 legacy 重编号自愈、M8/M9 dayOffsetMinutes 口径统一、M10/M11 趋势线 null 与 Blue 路由拆行、M13/M14/M15 订阅与余额校验、low 组（caption 破折号、极小金额、未知余额态、负余额钳位、探测 abort、dispose 中断在飞请求）；逐个加测试+变异验证；跑全量+pack；提交（可分 2-3 个提交）。
- [ ] 5. 测试缺口组（测试组 11 条）：priceToday 零覆盖、跨代际区间计价、路由行 cost 回退、無 logger 失败路径、句柄 close 保证、并发 sweep、余额缺桶/跨币/超支、弱断言补强、unmount 迟到回包、offset 两套时钟、CSV 双向断言；逐个补测试；跑全量+pack；提交。
- [ ] 6. 收尾：全量最后跑一次 + pack；push；按新 SHA 重装；核对装机（package.json 行、bundles、src 内容一致）；验证账本（schemaVersion、行数/总数只增不丢）；清 TEMP 残留；确认工作区干净；AGENTS.md 钉换新 SHA 后提交+push；向用户报告。

## Progress log
- 2026-10-12: 计划落盘。工作区已收拾（删 3 探针）。AGENTS.md 5 行未提交留待步骤 1-6 随附提交。

## Open questions / blockers
- 步骤 2 需要用户先看设计方案（重构面大）。H1 的 (a)/(b) 取舍、H3 快照按日存的 schema 变更代价，都要用户拍板。
- 无其他 blocker。
