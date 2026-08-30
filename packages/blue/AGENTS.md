# AGENTS.md

`@dsh-blue/tokenledger` is the renderer-neutral Blue companion for the
`dsh-tokenledger` domain plugin. It consumes only the public
`ctx.tokenLedgerV1` service. Do not import TokenLedger internals, expose its
store, fold Harness session events, or move accounting, pricing, balance,
export, or settings truth into this package.

`lib/index.js` owns one frontend-tree instance: dynamic service injection,
session fencing, request controllers, current-page caches, Blue capability
registrations, and Fiber cleanup. `lib/model.js` is pure interaction-model and
wire-node construction code. Neither file may import pi-tui, raw terminal,
ANSI, DOM, React, Agent, or Session objects. Renderer compilation and width
truth remain owned by Blue core.
Untrusted service values are copied through bounded incremental data-descriptor
reads. Never bulk-materialize an object's descriptors before applying its key
budget; proxies, accessors, overlong keys, credential keys, and
`__proto__`/`prototype`/`constructor` fail closed before normalization.

The initial `current()`/`queryUsage()` values are bounded and can omit rows.
Every async read captures the active summary revision before its first await
and accepts only that exact cut; action results must echo the request id and
carry one revision consistently in both the result and snapshot.
Read `collectionBounds.{sourceCount,returnedCount,omittedCount}` and
`boundaryTruncated`; never present a bounded array as complete. The only path
beyond that boundary is `tokenLedgerV1.queryCollection()` with a revision
fence. Keep only the current continuation page in frontend state, abort it on
supersede/session switch/service unload, and reject stale or late results. The
user-facing continuation explanation is emitted by `collectionNotice()` in
`lib/model.js`; do not add competing continuation copy elsewhere.

The Web client and loopback HTTP API remain the golden/plain fallback. Missing
`tokenLedgerV1`, capability denial, activation failure, or service unload must
leave collection and Web behavior intact and must not partially register Blue
surfaces.

The companion composition owns an explicit domain row because installing the
companion does not activate its peer's bundle. Keep that row's database and
sweep config identical to the root TokenLedger bundle so Blue never creates a
working-directory-local second ledger. The profile dependency set contains
both packages, but `dsh.profile.bundles` must enable only this companion bundle;
also enabling the root `dsh-tokenledger` bundle would mount a second domain
instance against the same database. A normal registry install adds only the
companion as the direct profile plugin and lets pnpm resolve its peer. Local
link profiles may need both packages as direct dependencies; run every
`dsh plugin` operation first, then remove `dsh-tokenledger` from the bundle list
before boot because plugin reconciliation re-enables every direct dependency
that declares `dsh.bundle`.

The Blue composition exposes exactly one command, `tokenledger`. Its domain row
must set `commandEnabled: false`, while ordinary Harness/Web compositions keep
the domain plugin's same-named legacy text command through the default
`commandEnabled: true`. Do not register a persistent pane or status entry: the
command opens the complete managed overlay, and unload must both dispose the
command handle and close that overlay.

The overlay does not own a settings page, configuration reads, or settings
actions. TokenLedger configuration is edited through Blue's existing
`/settings` workflow. Keep the domain `tokenLedgerV1.getConfiguration()` and
settings action compatibility surface intact for Web, HTTP, legacy, and other
public-service consumers, but do not call it from this companion.

The preview TUI is Simplified Chinese only. Main and breakdown navigation must
show active state without relying on color (`●` active, `○` inactive), repeat
the selected page in the surface title and current-page divider, and use the
Blue compiler's `‹ ›` candidate brackets without a redundant leading arrow on
the active candidate. Wire tab labels stay plain; canonical Blue core owns both
markers, so compiled rows must never contain `● ●` or `○ ○`. Form submit labels
and loading cancel
controls must remain Chinese without leaking internal `tokenledger.*` ids. The
shared surface body always explains that Tab/Shift-Tab switches only between
tab levels, Left/Right immediately switches the page in the current tab level,
Down enters content, Up/Down browses content, Enter/Space selects or activates
content controls, and PageUp/PageDown pages the focused control group. Tabs
must ignore Enter/Space. Lists, actions, pagination, and forms must never enter
the Tab cycle. Pagination actions are not focusable and carry an explicit
`shortcutFor` control id.
Overview renders the WebUI's 371-day activity heatmap with the same quantile
scale. One day is two adjacent terminal cells (`░░`, `▒▒`, `▓▓`, or `██`) plus
one blank column, which approximates the Web square-cell grid. Zero days use
the muted tone; all four non-zero levels use the success tone and differ only
by glyph density. The overview is always one chronological data row. Bounded
responsive variants select the latest number of days that fit at three columns
per day after the overlay frame and padding are deducted; `明细 -> 活动` remains
the complete 371-day paged history. The
managed overlay request carries no title because the returned dynamic overlay
surface owns the single frame.
Keyboard fixture evidence must cover Tab/Shift-Tab between main and breakdown
tab levels, immediate Left/Right tab changes, Enter/Space no-op on tabs, Down
content entry, Tab return from content, Enter/Space content selection, and
PageUp/PageDown scoped paging through the real public compiler.

Run `node --test "test/*.test.js"`, syntax-check both `lib/*.js` entries, run
oxlint from the Blue checkout, and validate with
`node script/blue-plugin-validate.mjs <this-package>`. The independent packed
fixture must run against the current and previous supported Harness lines with
normal npm peer resolution and a clean, exact Blue revision supplied through
`--blue-revision <full-clean-blue-commit>`; omission must fail closed. It must execute
all declared scenarios, report no skips, clean its temporary install, and
cover continuation, abort/stale rejection, provider swap/fallback, unload/late
results, and 20/40/80/120-column rendering.

The manifests currently use the unpublished integration candidate
`0.1.1-blue.0`; the companion peer floor is
`dsh-tokenledger >=0.1.1-blue.0 <0.2.0` because published `0.1.0` has no public
service export. This is not registry evidence. The validated preview window is
Blue `>=0.1.1-rc.2 <0.1.2` and Harness
`>=0.1.1-rc.1 <0.1.2`. Do not widen either manifest range beyond evidence from
the canonical validator and packed compatibility fixture.

Do not remove the companion while it is the only Blue consumer of
`tokenLedgerV1`. Deletion requires an integrated replacement that preserves
the same public-service boundary, complete continuation behavior, lifecycle
and width evidence, packed dual-line fixtures, real-profile dogfood, and human
acceptance. Removing the legacy Web renderer is a separate upstream decision.
