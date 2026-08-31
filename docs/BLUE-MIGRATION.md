# Blue migration record

Status: the renderer-neutral `tokenLedgerV1` boundary and separate Blue
companion are implemented. The current command opens one Chinese managed
overlay aligned with the Web dashboard. Dedicated-profile automated PTY
dogfood is complete. Final dual-Harness packed runs against an explicitly
pinned release commit and human terminal acceptance remain release gates. This record tracks
[zh667/TokenLedger#57](https://github.com/zh667/TokenLedger/issues/57).

## Packaging decision

`@dsh-blue/tokenledger` is a temporary integration-test identity. It does not
reserve the package name, npm scope, repository, or publishing account. The
TokenLedger plugin author may decide all four for the real release, including
moving the companion into an author-owned organization or repository.

The companion is separate instead of being implemented as TokenLedger
`src/blue*` modules for two reasons:

1. Blue interaction, composition, and rendering concerns should not enter the
   renderer-neutral accounting plugin.
2. A separate package lets the integration be tested with minimal changes to
   the original TokenLedger repository and without coupling its Web/plain
   fallback to a particular TUI release line.

The durable decision is the dependency direction, not the current package
name:

```text
durable Harness session logs
  -> TokenLedger store and usagePayload()
  -> bounded ctx.tokenLedgerV1
  -> Web, Blue companion, and future renderers
```

The companion must consume only `ctx.tokenLedgerV1`. It must not read the
legacy `ctx.tokenLedger`, expose `LedgerStore`, import TokenLedger internals, or
fold Harness session events. Renderer-neutral additions needed by all clients
belong in the public Service; Blue-only code stays in the adapter package.

## Boundary map

| Layer | Owner and status |
| --- | --- |
| Domain | TokenLedger owns SQLite indexing, durable-log replay, attribution, pricing, balance/quota readers, export, and settings persistence. It imports no Blue package. |
| Public projection | `current()` / `subscribe()` expose bounded, frozen, revisioned summaries. `queryUsage()` uses the same `usagePayload()` truth as Web. `queryCollection()` returns revision-fenced continuation pages with explicit source/returned/omitted counts. |
| Public actions | `execute()` retains refresh, rebuild, balance, export, relay settings, and wallet settings for Web, HTTP, legacy, and third-party consumers. Every action is request-id/revision fenced and abort safe. |
| Blue interaction | `packages/blue/lib/index.js` owns selection, request controllers, current pages, dynamic Service binding, and cleanup. `lib/model.js` emits bounded, frozen Blue nodes. |
| Renderer | Blue core owns pi-tui, width, ANSI, focus, tab chrome, key decoding, and compilation. The companion never receives those objects. |
| Composition | `packages/blue/cordis.patch.yml` mounts the domain and companion. The domain row sets `commandEnabled: false`, so Blue exposes exactly one `/tokenledger` command. |

The legacy `ctx.tokenLedger` object keeps its exact nine-member behavior and
identity. The existing Web client and loopback HTTP API remain the golden/plain
fallback and are intentionally unchanged.

## UI parity decision

The Blue companion exposes one vertically scrolling dashboard, not separate
overview/detail/account/export pages. Its order matches the Web panel:

1. 余额
2. Token 用量
3. 中转站分布
4. 按项目
5. 活跃度
6. 模型
7. 数据状态与刷新

Only two canonical tab groups remain:

- Accounts select one provider-scoped usage cut and its matching balance card.
- `今日 / 本月 / 累计` select the Web usage range.

`Tab` / `Shift+Tab` switches between these two tab levels. Left/Right
immediately switches within the focused group. Down enters ordinary content;
Enter/Space does not activate a tab. Wire labels contain no hand-authored
`●`/`○`/focus glyphs; canonical Blue core owns that state paint and gives the
focused tab a stable selection background.

The TUI is Simplified Chinese. Product names, model names, domains, and physical
key names remain in their source spelling. The overlay intentionally omits
features absent from the Web UI: JSON/CSV export, index rebuild, provider
detail, independent activity/model/site pages, and multi-level overview/detail
navigation. The public domain APIs for those compatibility workflows remain
unchanged. Configuration stays in Blue's existing `/settings` workflow.

The activity view keeps the WebUI's 371-day quantile data, rendered as weekdays
in seven rows and weeks in columns. It exposes bounded variants for the latest
responsive slices up to 54 weeks. Each day is two terminal columns wide so the
cell remains approximately square. Zero is muted; non-zero density levels share the
success tone.

## Local paging

`按项目` is a first-class Web-parity section and shows Token, percentage, and
the complete directory key. Each local page contains eight rows. PageUp and
PageDown use validated global shortcut actions so projects can page directly
from either tab level; a shortcut scoped to another focused collection takes
precedence. If the next eight rows already exist in the bounded initial view, no
Service request is made. Otherwise only `queryCollection({ collection:
"projects" })` runs.

While a project continuation is pending, the current project page and every
other dashboard section remain visible and unchanged. Completion replaces only
the project page cache. Sites, models, and accounts may use the same bounded
local paging mechanism, but none causes a whole-dashboard data read.

Model sorting remains a compact Web-style control. When the initial model
boundary is incomplete, sorting requests a globally sorted page from
`queryCollection()` instead of pretending the returned prefix is complete.

## Balance semantics

Opening the overlay and switching account tabs query the selected account's
provider-scoped usage cut, then execute `balance.refresh` with `force: false`,
allowing the domain's freshness cache to answer. Token totals, request counts,
site distribution, projects, activity, models, pricing, and balance therefore
move together. The Web client does not pass `provider`, so its existing
unfiltered behavior is unchanged. The single dashboard Refresh action performs
`usage.refresh`, reloads the selected provider view, then executes balance
refresh with `force: true` for the current account. A balance failure is soft
and does not replace valid usage with a whole-overlay error.

## Lifecycle and fallback

Every asynchronous read captures service generation and revision before its
first await. Supersede, session change, Service replacement/unload, and
companion unload abort or fence results. Frontend state retains only one page
per bounded collection. Descriptor-only normalizers reject proxies and
accessors without executing them and keep credential filtering and clone
budgets at the public boundary.

If Blue admission fails, no command or partial surface is registered. If Blue
is available but `tokenLedgerV1` is absent, invalid, or later unloads, the one
command opens a local Chinese unavailable overlay. Domain collection, Web, HTTP,
and the legacy Service continue unaffected.

## Dedicated-profile dogfood

Automated terminal dogfood ran on 2026-08-31 with the retained profile
`blue-tokenledger-r3` at 100 columns by 40 rows. The profile links the Blue
acceptance worktree and this TokenLedger worktree. Its bundle list contains
`@dsh-blue/blue` and `@dsh-blue/tokenledger`; `dsh-tokenledger` remains a linked
dependency but is not a second enabled bundle. `--dump-config` showed exactly
one `tokenledger-domain` row with `commandEnabled: false` and exactly one
`tokenledger-blue` row.

The real `/tokenledger` workflow verified:

- one Chinese overlay opens with real usage, project, account, and balance data;
- Tab moves only between account and range levels;
- Left/Right changes the active level immediately;
- `累计 -> 今日` replaces requests, hit rate, sites, and projects as one range
  cut (`4,231 -> 0` requests in this run), rather than retaining cumulative data;
- an account switch survives account-directory reordering and renders the
  selected account's balance result;
- Down enters content, and project PgDn/PgUp changes only the project page while
  the highlighted project slot keeps focus;
- Esc closes the overlay and `/quit` exits cleanly.

Dogfood found four integration defects that isolated model tests had missed:

1. Account tab ids used array positions, so a balance-triggered directory
   reorder moved semantic focus. IDs now derive from the public account id or
   origin.
2. Project row ids used absolute offsets, so a page replacement could not
   restore list focus. IDs now represent the eight stable page slots.
3. A revision advancing during a usage read could surface either a stale
   Service exception or a newer replay. The adapter retries once only when the
   subscribed revision actually advanced, and a filtered accepted view is no
   longer partially mixed with a cumulative summary.
4. Calling the overlay handle's external `refresh()` from inside `onEvent`
   caused canonical Blue to abort the event that initiated the read. Event-time
   refreshes are now batched; core performs the success redraw after settlement.

A second 100-by-40 PTY pass found four presentation and navigation gaps:

1. The hardware cursor alone did not make the focused tab level legible. Blue
   now paints every focused tab with `selectedBg`; the measured background moved
   from the account row (14 cells) to the range row (22 cells) after Tab.
2. Project PageUp/PageDown was scoped to the project list, so it did nothing
   while either tab level was focused. The companion now declares validated
   global fallback shortcuts; PgDn moved `第 1 / 7 页` to `第 2 / 7 页` directly
   from the range tabs and refreshed only the project section.
3. A one-column terminal cell is not approximately square. Every activity day
   now occupies two columns (`··`, `░░`, `▒▒`, `▓▓`, or `██`) across responsive
   16/18/30/42/54-week slices.
4. The canonical nested scroll did not follow focus, leaving content below the
   viewport unreachable even after the overlay grew. Blue now scrolls a focused
   canonical control into view, including after semantic focus restoration.

The companion now requests a 96%-width, 96%-height overlay and compresses the
balance summary into three contiguous rows. In the final pass, keyboard
navigation exposed the complete heatmap and model section, the frame reported
no overflow, no uncaught exception was printed, and `/quit` exited with status
0.

A provider-filter dogfood pass then switched from `DeepSeek` to
`14.103.55.49:3000 · test`. The accepted cut changed from 556,997,650 tokens,
3,947 requests, 49 projects, direct-only distribution, and the DeepSeek model
set to 0 tokens, 3 requests, 2 projects, the `14.103.55.49:3000` site, a
three-request activity cut, and `glm-5.3`. SQLite independently reported the
same per-route figures. The separate `test2` route on that origin retained its
own 283,849 tokens and 18 requests, proving account selection filters by
provider route rather than merging keys by site. The PTY exited with status 0
and reported neither overflow nor an uncaught exception.

No `blue-overflow.log` or `pi-crash.log` was produced. The profile is
intentionally retained for human acceptance:

```sh
dsh --profile blue-tokenledger-r3
```

This automated run is not a claim that human acceptance or the final
dual-Harness release gate has passed.

## Verification and release gate

The companion tests cover the one-overlay section order, the two tab groups,
Chinese labels, retired-feature absence, cached/forced balance semantics,
project paging isolation, global model sort requests, revision/request fences,
Service replacement, unload cleanup, hostile public values, wire budgets, and
the seven-row responsive heatmap.

The canonical validator checks the manifest, package export closure,
architecture imports, capabilities, and lifecycle registration. The packed
fixture installs TokenLedger, the companion, and Blue public packages outside
both source trees with normal peer resolution. It must cover real compiler
keyboard behavior and 20/40/80/120-column width scans.

Acceptance deliberately requires
`--blue-revision <full-clean-blue-commit>`. Missing, dirty, or different Blue
state fails closed. Both supported Harness lines must execute every scenario
with no skips before release. The preview ranges remain Blue
`>=0.1.1-rc.2 <0.1.2` and Harness `>=0.1.1-rc.1 <0.1.2`; those ranges are not a
claim that the final packed gate has passed.

The domain and companion manifests currently use unpublished candidate version
`0.1.1-blue.0`. A real release must publish the compatible domain first and set
the companion peer floor to that released version. The final companion name,
scope, repository, and publisher remain the TokenLedger author's decision.

## Maintenance footprint

The domain-side changes stay renderer neutral:

- `src/service.js` owns the bounded `tokenLedgerV1` contract and continuation.
- `src/plugin.js` publishes both public faces, maps actions to existing domain
  functions, distinguishes cached from forced balance reads, and orders cleanup.
- `src/newapi-user.js` and `src/balance.js` provide instance-owned caches and
  cancellation without changing their compatibility exports.
- `packages/blue/` owns all Blue interaction, manifest, composition, tests, and
  adapter documentation.

No Web component, client route, loopback HTTP path, database schema, usage fold,
pricing rule, or root bundle row is replaced by this UI adaptation.
