# @dsh-blue/tokenledger

Renderer-neutral Blue TUI companion for `dsh-tokenledger`.

`0.1.1-blue.0` is an unpublished integration candidate. The install command
below applies only after a compatible domain and companion release exists; the
published domain `0.1.0` does not provide the required `tokenLedgerV1` service.

It consumes only the public `tokenLedgerV1` Service and maps usage, balance, and
export workflows to one managed Blue command, an on-demand overlay, and
notifications. The TokenLedger domain plugin remains the owner of accounting,
balance reads, exports, and settings writes. Configuration uses Blue's existing
`/settings` workflow rather than a second settings page inside the overlay. The
Web client remains installed and unchanged as the plain fallback.

Install only the companion as the direct profile plugin; pnpm resolves its
`dsh-tokenledger` peer without enabling the peer's bundle:

```sh
dsh plugin --profile blue add @dsh-blue/tokenledger
```

Do not pass `dsh-tokenledger` as a second plugin argument. Only
`@dsh-blue/tokenledger` belongs in `dsh.profile.bundles`; its composition already
mounts the domain peer with TokenLedger's standard database and sweep
configuration. Enabling the root bundle too would create a duplicate domain
instance and duplicate command. Run `/tokenledger` to open the full dashboard.
The companion registers no persistent pane or status item. Its domain row sets
`commandEnabled: false`, so a Blue installation has exactly one command; normal
Harness/Web installations still receive TokenLedger's original `/tokenledger`
text command because the domain default remains enabled.

The current TUI is Simplified Chinese only. Canonical Blue core renders the
`●`/`○` navigation markers from plain tab labels; active state also uses a
changing surface title, explicit current-page labels, and `‹ ›` candidate
brackets. `Tab` / `Shift+Tab` switches only between
tab levels such as the main and breakdown navigation; Left/Right immediately
switches the page within that level, Down enters content, Up/Down browses
content, Enter/Space selects or activates content, and PageUp/PageDown pages the
focused content group. Lists, actions, pagination, and forms do not enter the
Tab cycle. Every page keeps this Chinese guide visible. English localization is
planned separately.

The dashboard includes today/month/all-time ranges, the WebUI-equivalent
371-day activity heatmap, relay filtering, paged
site/model/project/provider/activity detail, account balance and quota windows,
usage refresh, derived-index rebuild, and complete paged JSON/CSV export
content. Each heatmap day uses a two-column terminal cell with a one-column gap;
zero days are muted and all non-zero levels are green. The overview keeps one
chronological data row and fills it with the latest days that fit at three
columns each; the complete 371-day history remains under Activity in Breakdown.
Relay and personal-wallet settings remain available through
`/settings` and the domain's public compatibility API.

TokenLedger's initial public views are bounded. When rows are omitted, the TUI
shows the exact boundary count and retrieves subsequent pages through the
service-owned `queryCollection()` continuation API. Requests are revision
fenced and cancelled on supersede, session change, service unload, or companion
unload; the frontend retains only the current page.

The preview window is Blue `>=0.1.1-rc.2 <0.1.2` and Harness
`>=0.1.1-rc.1 <0.1.2`. Before release, packed fixtures must pass Harness
`0.1.1-rc.1` and `0.1.1-rc.2` against an explicitly pinned final clean Blue
commit. The independent install verifies capability absence, fallback, replay,
actions, continuation, provider swap, command/overlay cleanup,
keyboard-visible navigation, and rendering at 20, 40, 80, and 120 columns.
