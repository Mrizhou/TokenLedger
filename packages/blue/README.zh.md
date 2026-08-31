# TokenLedger Blue companion

`@dsh-blue/tokenledger` 是 `dsh-tokenledger` 的 renderer-neutral Blue TUI
适配包。`0.1.1-blue.0` 仍是未发布的集成候选版本；npm 上已有的
`dsh-tokenledger@0.1.0` 不包含它所需的 `tokenLedgerV1` Service。

## 包归属

当前包名、npm scope、仓库地址和发布主体只是集成测试安排，不是对 TokenLedger
作者的发布约束。正式发布时，插件作者可以决定包名、scope、仓库和发布账号，也可以把
companion 移到作者自己的组织下。

当前暂放在 `dsh-blue` 组织，是为了在不把 Blue 渲染与交互代码写入 TokenLedger
核心 `src/blue*` 的前提下完成联调，并尽量减少对原仓库的修改。长期必须保留的是架构
边界：Blue companion 只消费公开、renderer-neutral 的 `ctx.tokenLedgerV1`；包名和
发布位置都可以变化。

## 安装边界

正式发布后，只把 companion 作为 profile 的直接插件安装；pnpm 会解析它的
`dsh-tokenledger` peer，但不会启用 peer 自己的 bundle：

```sh
dsh plugin --profile blue add @dsh-blue/tokenledger
```

不要再把 `dsh-tokenledger` 作为第二个 plugin 参数传入。companion 的 composition
已经按 TokenLedger 的标准数据库和 sweep 配置挂载 domain peer；同时启用 root bundle
会创建重复的 domain 实例。Blue composition 将 domain 的旧文本命令关闭，所以最终只
贡献一个 `/tokenledger` 命令；普通 Harness/Web 安装仍保留原命令。

## UI 与操作

`/tokenledger` 打开一个 managed overlay，不注册常驻 pane 或状态栏。overlay 采用与
Web UI 相同的纵向顺序：

1. 余额
2. Token 用量
3. 中转站分布
4. 按项目
5. 活跃度
6. 模型
7. 数据状态与刷新

顶部有两个 canonical 标签层级：账户标签和“今日 / 本月 / 累计”区间标签。
`Tab` / `Shift+Tab` 只在这两个层级间切换；`Left` / `Right` 立即切换当前层级中的
账户或区间；`Down` 进入内容。wire label 只含业务文本，`●`、`○`、`‹ ›` 和焦点
状态由 Blue core 统一绘制；当前聚焦标签还会带稳定的选择底色。

“按项目”显示 Token、占比和完整目录。`PgUp` / `PgDn` 在任一标签层级都可直接翻项目页；
焦点位于其他可分页列表时，该列表自己的分页优先。项目 continuation 进行中保留整张
dashboard 的其他内容，完成后也只替换项目当前页。站点、模型和账户在公共边界需要时
使用相同的局部分页机制。

当前 TUI 只提供简体中文。模型名、域名、产品名和实体按键名保留原文。overlay 不提供
Web UI 没有的导出、重建索引、provider 明细、活动详情页或多级总览/明细导航；设置仍
通过 Blue 的 `/settings` 工作流完成。

账户切换会读取该账户 provider 对应的完整用量切片，并通过 domain 缓存读取对应余额；
Token、请求数、中转站、项目、活跃度、模型、计价和余额会一起变化。Web 端不传
`provider`，原有未过滤行为不变。只有 dashboard 的“刷新”同时刷新用量并强制刷新当前
账户余额。所有请求都带 revision fence，并在替代请求、session 切换、Service 卸载或
companion 卸载时取消。frontend 只保留当前 continuation 页。

## 验证

preview 兼容窗口为 Blue `>=0.1.1-rc.2 <0.1.2` 和 Harness
`>=0.1.1-rc.1 <0.1.2`。发布前必须针对显式指定的最终 clean Blue commit，分别跑通
两个 Harness line 的 packed fixture；当前候选版本不声明这项最终发布门禁已经完成。
