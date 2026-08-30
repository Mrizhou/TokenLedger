# AGENTS.md

TokenLedger is a renderer-independent DeepSeek Harness domain plugin. Keep the
accounting direction as durable Harness session logs -> TokenLedger store ->
`usagePayload()` -> bounded public views. The Web client and future Blue TUI
must consume that domain truth rather than folding session events themselves.

`src/service.js` owns the renderer-neutral `ctx.tokenLedgerV1` boundary. Public
snapshots and results must remain bounded, credential-filtered, deeply frozen,
revisioned, and free of Cordis, Agent, Session, DOM, React, pi-tui, ANSI,
terminal width, focus handles, and Promises. Every action needs a request id,
stable error code, abort/stale fencing, and unload-safe late-result behavior.

`ctx.tokenLedger` is a separate legacy/deprecation boundary. Preserve its object
identity and its exact `store`, `sweep`, `totals`, `byDay`, `byModel`, `bySite`,
`sites`, `diagnostics`, and `reindex` behavior. Do not silently narrow or replace
it. New consumers, including the Blue companion, must inject only
`tokenLedgerV1`.

Mutable caches belong to one `apply()` instance. The Cordis plugin must use
`createNewApiWalletReader()`; the module-level wallet helper exports exist only
for compatibility. Cleanup order is service/request abort, owned cache dispose,
then store close. Never expose `LedgerStore` through `ctx.tokenLedgerV1`.

Keep the existing Web UI and loopback HTTP API as the golden/plain fallback.
Blue-specific interaction, renderer, and composition code belongs in a separate
adapter package and must not be added under `src/blue*` here.

Run `npm test` and `npm pack --dry-run --json` from the repository root. The
package intentionally has no build step. New exports must stay under `src/`, be
listed in `package.json`, and be covered by `test/packaging.test.js`.
