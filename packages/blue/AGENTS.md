# AGENTS.md

This directory is TokenLedger's separate renderer-neutral Blue companion. The
current `@dsh-blue/tokenledger` name and repository are temporary integration
test choices; the TokenLedger author owns the eventual package name, scope,
repository, and publisher. The durable rule is that this package injects only
`ctx.tokenLedgerV1`. It must never import TokenLedger internals, expose its
store, fold Harness events, or move accounting truth into the frontend.

`lib/index.js` owns one frontend-tree instance: dynamic service injection,
session/revision fencing, request controllers, current-page caches, Blue
registrations, and Fiber cleanup. `lib/model.js` is pure wire-node construction.
Neither may import pi-tui, ANSI, terminal widths, DOM, React, Agent, Session,
Cordis objects, or renderer focus handles. Blue core owns compilation and
keyboard behavior.

Untrusted public values cross through bounded descriptor reads. Proxies and
accessors never execute. Credential, overlong, prototype-control, and unsafe
array/key structures fail closed. Normalized values and emitted nodes stay
bounded and deeply frozen.

Every asynchronous query captures the current service generation and revision
before its first await and accepts only that cut afterward. Each request has a
request id and abort controller. Supersede, session change, Service replacement,
Service unload, and companion unload abort or fence late results. Keep only the
current continuation page; never accumulate the ledger in frontend state.

Do not call the overlay registration's external `refresh()` while its `onEvent`
handler is still running: canonical Blue treats that as an external surface
replacement and aborts the in-flight event. Batch frontend refresh requests
during event dispatch. On success, rely on the core bridge's one post-handler
refresh; defer an explicit refresh until after settlement only for a failed
event whose local error state must become visible.

The Web client and loopback HTTP API are the golden/plain fallback. The Blue UI
is exactly one command-opened managed overlay with no persistent pane/status
and no duplicate settings page. Missing/invalid `tokenLedgerV1` must leave a
visible local fallback without affecting collection or Web behavior.

Match the Web UI's vertical order and surface area:

1. 余额
2. Token 用量
3. 中转站分布
4. 按项目
5. 活跃度
6. 模型
7. 数据状态与刷新

Do not add export, index rebuild, provider detail, independent activity/model/
site pages, or overview/breakdown navigation. Configuration belongs to Blue's
existing `/settings` flow. The domain public actions remain available for Web,
HTTP, legacy, and third-party consumers but are not UI justification here.

Accounts and `今日 / 本月 / 累计` are the only canonical tab groups. Wire tab
labels are plain business text. Blue core owns `●`, `○`, `‹ ›`, and focus paint.
On the accepted core contract, Tab/Shift+Tab cycles only these two tab levels;
Left/Right immediately selects within the focused level; Enter/Space is inert
on tabs; Down enters content and Tab from content returns to the remembered tab
level. Account wire ids derive from the public account `id`/`origin`, never an
array position, so provider-directory reordering cannot move semantic focus.
Selecting an account reloads the complete usage cut for that account's provider
as well as its balance; totals, requests, sites, projects, activity, models,
and pricing must never remain on another provider. Keep the Chinese footer
aligned with that behavior.

`按项目` must show tokens, percentage, and the full project directory. PgUp/
PgDn uses a validated global paging shortcut so either tab level can page the
project list without first traversing dashboard content; a more specific
focused collection shortcut still wins. A pending project continuation preserves every other section
and completion replaces only the project page. Project row ids represent page
slots so the focused slot survives a page replacement. Sites, models, and accounts may
also page locally when the public boundary requires it. A local page already in
the initial view must not trigger `queryCollection()`.

If a usage query is fenced only because the replayed public revision advanced
during that read, retry once against the new captured revision. Never retry a
result whose revision disagrees while the captured snapshot itself is unchanged.
An unfiltered cumulative dashboard may adopt a newer summary replay as one
complete cut. A provider/day/month/site-filtered view must retain its last
accepted query cut until another query succeeds; never replace only its totals
with the new cumulative summary.

The activity view uses the WebUI's 371-day, quantile-based data with weekdays as
seven rows and weeks as columns. Every day occupies two terminal columns so a
cell remains approximately square; keep bounded responsive variants up to 54
weeks. Zero uses muted `··`; non-zero levels use doubled success-toned
`░`, `▒`, `▓`, and `█`.

Initial overlay open and account changes query the selected provider usage cut,
then request `balance.refresh` with `force: false`. The single dashboard Refresh
action runs `usage.refresh`, reloads the selected provider view, then requests
the current account balance with `force: true`. Balance failure is soft and
must not erase otherwise valid usage data.

The composition owns an explicit domain row because installing a peer does not
activate its bundle. Keep database/sweep settings identical to the root bundle
and `commandEnabled: false` in this row so Blue exposes exactly one command.

Run `node --test "test/*.test.js"`, syntax-check `lib/*.js`, run oxlint from the
Blue checkout, run the canonical `blue-plugin-validate.mjs`, and dry-run both
package tarballs. The independent packed fixture requires an explicit clean
Blue revision and must eventually pass both supported Harness lines plus
20/40/80/120-column compiler scans. Do not claim that final packed gate until
both runs actually complete.
