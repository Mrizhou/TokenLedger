# @dsh-blue/tokenledger

`dsh-tokenledger` 的 renderer-neutral Blue TUI companion。

`0.1.1-blue.0` 是尚未发布的集成候选版本。下方安装命令只适用于兼容的 domain 与
companion 正式发布之后；npm 上已有的 domain `0.1.0` 不提供所需的
`tokenLedgerV1` Service。

它只消费公开的 `tokenLedgerV1` Service，把用量、余额和导出工作流映射为一个
Blue 命令、按需打开的 overlay 和通知。账本统计、余额读取、导出和设置写入仍由
TokenLedger domain 插件拥有；配置统一通过 Blue 现有的 `/settings` 工作流完成，
overlay 内不再重复提供设置页。原 Web 客户端保持安装且不作修改，作为 plain fallback。

只把 companion 作为 profile 的直接插件安装；pnpm 会解析它的 `dsh-tokenledger`
peer，但不会启用该 peer 的 bundle：

```sh
dsh plugin --profile blue add @dsh-blue/tokenledger
```

不要把 `dsh-tokenledger` 作为第二个 plugin 参数传入。`dsh.profile.bundles` 中只应
启用 `@dsh-blue/tokenledger`；companion 的 composition 已经按 TokenLedger 的标准
数据库与 sweep 配置挂载 domain peer。若再启用 root bundle，会针对同一个数据库
创建重复的 domain 实例和重复命令。运行 `/tokenledger` 打开完整仪表盘；companion
不注册常驻 pane 或状态栏。它的 domain composition row 设置
`commandEnabled: false`，因此 Blue 安装后只有这一个命令；普通 Harness/Web 安装仍因
domain 默认值为 true 而保留原有 `/tokenledger` 文本命令。

当前 TUI 仅提供简体中文。wire tab label 保持纯文本，由 canonical Blue core 统一
绘制 `●`/`○` 标记；主导航与明细导航还通过动态标题、“当前页”提示和 `‹ ›` 候选
括号表达状态，不依赖颜色。每个页面常驻中文操作提示：
`Tab/Shift+Tab` 只切换主导航与明细导航等标签层级，左右键切换本层标签，向下键
进入内容区，上下键浏览内容，`Enter/Space` 确认，`PgUp/PgDn` 对当前内容组翻页；
普通列表、按钮和表单不会进入 Tab 循环。英文国际化后续单独支持。

仪表盘包含今日/本月/全部范围、与 WebUI 对齐的 371 天按日活动热力图、relay
筛选，按页浏览站点/模型/项目/provider/活动详情，账户余额与 quota 窗口，用量刷新、
派生索引重建，以及完整分页显示的 JSON/CSV 导出内容。热力图每一天使用两个终端
字符并在天之间留一列空隙；宽屏分块显示完整历史，窄屏显示最近数周。relay 与个人
钱包设置继续通过 `/settings` 和 domain 公共兼容
API 提供，不在 TokenLedger overlay 内重复实现。

TokenLedger 的初始公开视图有明确大小上限。存在未返回行时，TUI 会显示准确的边界
计数，并通过 Service 拥有的 `queryCollection()` continuation API 读取后续页。请求带
revision fence，并在被替代、session 切换、Service 卸载或 companion 卸载时取消；
frontend 只保留当前页。

preview window 是 Blue `>=0.1.1-rc.2 <0.1.2` 与 Harness
`>=0.1.1-rc.1 <0.1.2`。发布前必须针对显式指定的最终 clean Blue commit，分别跑通
Harness `0.1.1-rc.1` 和 `0.1.1-rc.2` packed fixture。独立安装验证能力缺失、
fallback、replay、action、continuation、provider 替换、命令/overlay 清理、
键盘导航可见性，以及 20、40、80、120 列渲染。
