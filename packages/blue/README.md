# TokenLedger Blue companion

`@dsh-blue/tokenledger` is the renderer-neutral Blue TUI companion for
`dsh-tokenledger`. Version `0.1.1-blue.0` remains an unpublished integration
candidate; the published `dsh-tokenledger@0.1.0` does not expose the required
`tokenLedgerV1` Service.

## Package ownership

The current package name, npm scope, repository, and publisher are temporary
integration-test choices, not release constraints on the TokenLedger author.
The plugin author may choose all of them for a real release and may move the
companion to an author-owned organization.

It currently lives under `dsh-blue` so Blue interaction and renderer-specific
code can be tested without adding `src/blue*` modules to TokenLedger or making
large changes to the original repository. The durable boundary is that the
companion consumes only the public, renderer-neutral `ctx.tokenLedgerV1` API.
Its eventual package name and publication location are replaceable.

## Installation boundary

After compatible packages are published, install only the companion as the
direct profile plugin. pnpm resolves its `dsh-tokenledger` peer without
enabling the peer bundle:

```sh
dsh plugin --profile blue add @dsh-blue/tokenledger
```

Do not pass `dsh-tokenledger` as a second plugin argument. The companion
composition already mounts the domain peer with TokenLedger's standard
database and sweep configuration; enabling the root bundle as well creates a
duplicate domain instance. The Blue composition disables the legacy text
command in that domain row, leaving exactly one `/tokenledger` command. Normal
Harness/Web installations retain the original command.

## UI and controls

`/tokenledger` opens one managed overlay and registers no persistent pane or
status item. It follows the Web UI's vertical order: Balance, Token usage,
Relay distribution, By project, Activity, Models, then data status and refresh.

Two canonical tab levels sit at the top of the interaction model: accounts and
Today / This month / All-time ranges. `Tab` / `Shift+Tab` moves only between
those levels; Left/Right immediately changes the account or range in the
current level; Down enters content. Wire labels contain business text only;
Blue core owns `●`, `○`, `‹ ›`, and focus paint, including a persistent
selection background on the focused tab.

By project shows tokens, share, and the complete directory. PageUp/PageDown can
page projects directly from either tab level; a focused pageable collection's
own shortcut takes precedence. While a project continuation request is in
flight, every other dashboard section remains unchanged; completion replaces
only the project page. Sites, models, and accounts use the same local paging
mechanism when the public boundary requires it.

The TUI is currently Simplified Chinese. Model names, domains, product names,
and physical key names retain their source spelling. The overlay does not add
export, index rebuild, provider details, activity detail pages, or overview /
breakdown navigation absent from the Web UI. Configuration remains in Blue's
existing `/settings` workflow.

Account switching reads the complete usage cut for that account's provider and
the matching balance through the domain cache; tokens, requests, sites,
projects, activity, models, pricing, and balance move together. The Web client
does not pass `provider`, so its existing unfiltered behavior is unchanged.
Only the dashboard Refresh command refreshes usage and forces the selected
account's balance. All requests are revision-fenced and abort on supersede,
session change, Service unload, or companion unload. The frontend retains only
the current continuation page.

## Verification

The preview compatibility window is Blue `>=0.1.1-rc.2 <0.1.2` and Harness
`>=0.1.1-rc.1 <0.1.2`. Before release, packed fixtures must pass both Harness
lines against an explicitly pinned final clean Blue commit. This candidate does
not claim that final release gate has completed.
