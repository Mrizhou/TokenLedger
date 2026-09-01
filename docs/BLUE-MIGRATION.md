# Blue single-package migration

TokenLedger now ships its Web, command, HTTP, and Blue surfaces in the single
`dsh-tokenledger` npm package. The Blue integration targets the Blue
`0.1.2-alpha.1` release head `72aaca583306e42a4acac7525fe43b3f9ea0610e`
and Harness
`0.1.2-alpha.2`.

## Architecture

```text
durable Harness session logs
  -> TokenLedger store
  -> usagePayload()
  -> Web HTTP response or bounded apply-local DashboardController
  -> in-package Blue adapter
```

The root Cordis `apply()` owns the store, wallet cache, dashboard controller,
and Blue adapter in one Fiber. The controller is passed by closure and is not a
Cordis service or package export. `ctx.tokenLedgerV1` and the former
`@dsh-blue/tokenledger` companion package have been removed.

`ctx.tokenLedger` remains unchanged for compatibility, including its original
object identity and `store`, `sweep`, `totals`, `byDay`, `byModel`, `bySite`,
`sites`, `diagnostics`, and `reindex` members.

## Surface ownership

- Without Blue, the original text `/tokenledger` command, Web client, and
  loopback HTTP API remain active.
- When `bluePluginHost` mounts, TokenLedger disposes the text command before
  registering the Blue command. Admission failure restores the text command.
- Blue unload disposes its overlay, subscriptions, requests, and command, then
  restores the text command while the domain plugin remains active.
- The Blue adapter imports no terminal renderer, pi-tui, ANSI, DOM, React,
  Agent, Session, or store implementation.

The Blue overlay keeps the accepted Web-parity order: balance, Token usage,
relay distribution, projects, activity, models, then data status and refresh.
Account/provider selection, range and site filters, collection pagination,
model sorting, balance caching, refresh, revision fencing, abort, and session
changes remain supported. Export, diagnostics, reindex, relay configuration,
and wallet configuration stay on the existing Web/text-command surfaces.

## Distribution

`package.json.blue.manifest` points to `./blue.plugin.json`. The manifest id is
`dsh-tokenledger` and its selected public entry is the root export `.`. The
bundle patch still contains exactly one bare-package row, so the Harness Web
client scanner and Blue both load the same plugin instance.

Install and enable only `dsh-tokenledger`; no companion package or second
composition row is required.

## Pull request verification

Plugin developers test the PR against the published, exact Blue version. From
the TokenLedger repository root:

```sh
npm test
npm pack --dry-run --json
npm install --global pnpm@11 @dsh-blue/blue-cli@0.1.2-alpha.1
blue plugin add "file:$PWD"
blue
```

Run `/tokenledger` in Blue and verify real usage, refresh, account switching,
pagination, and clean exit. Re-run `blue plugin add "file:$PWD"` after changing
the plugin source because `file:` installs a package snapshot. This is the
normal PR-author workflow; it requires neither a Blue checkout nor a companion
TokenLedger package.

## Maintainer source acceptance

The source-pinned fixture remains available when validating an unreleased Blue
HEAD:

Run:

```sh
node /path/to/blue/script/blue-plugin-validate.mjs .
node test/blue-packed-fixture.mjs \
  --blue-root /path/to/blue \
  --blue-revision 72aaca583306e42a4acac7525fe43b3f9ea0610e \
  --install \
  --harness-line 0.1.2-alpha.2
```

The independent fixture packs one TokenLedger tarball, installs it with the
Blue runtime outside both source trees, folds a real durable-log event into the
SQLite store, opens `/tokenledger`, refreshes it, compiles the resulting UI at
20/40/80/120 columns, and verifies unload cleanup.
