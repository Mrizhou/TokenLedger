# Blue migration record

Status: dual-face Domain/Public Service implemented on the TokenLedger side.
The original `ctx.tokenLedger` service remains unchanged; new renderer-neutral
consumers use `ctx.tokenLedgerV1`. Blue interaction, TUI rendering, composition,
packed fixtures, and acceptance are separate follow-up work. This record tracks issue
[zh667/TokenLedger#57](https://github.com/zh667/TokenLedger/issues/57).

## Boundary map

| Layer | Owner and status |
| --- | --- |
| Domain | TokenLedger owns SQLite indexing, durable session-log replay, fork accounting, relay/project attribution, pricing, balance/quota readers, export, and settings persistence. It imports no Blue package. |
| Projection | `ctx.tokenLedgerV1.current()` and `subscribe()` expose a bounded, deeply frozen summary with monotonic revisions and immediate replay. `queryUsage()` returns a bounded range/site view assembled by the same `usagePayload()` as Web. |
| Action | `execute()` exposes refresh, rebuild, balance, export, relay settings, and wallet settings as request-id/revision-fenced structured actions with abort, supersede, unload, and late-result handling. |
| Interaction model | Pending in a separate Blue adapter package. It will translate this service into Blue commands, panes, status, dialogs, and notifications without owning accounting state. |
| Renderer UI | Pending in the Blue repository. Only Blue core may cross into pi-tui, width, focus, ANSI, or raw-terminal APIs. |
| Composition rows | Pending. TokenLedger will receive an independent opt-in Blue row and manifest; it will not be silently bundled beside another cost surface. |

## Scope

| Scope | State |
| --- | --- |
| Host/plugin instance | SQLite store, directory, fingerprint state, project-title cache, settings handles, wallet/unit cache, service revision, and in-flight requests. |
| Agent | None. TokenLedger does not own Agent state. |
| Session | Durable usage facts remain in Harness session logs; TokenLedger keeps only indexed checkpoints and aggregates. |
| Frontend tree | Pending adapter-owned selection, filters, active account, dialog state, and provider subscriptions. |
| Provider Fiber | Pending adapter registration/subscription lifetime. It must not move domain caches into the renderer. |

## Capabilities and fallback

### Capabilities

`tokenLedgerV1` provides bounded summary replay, range/site queries, sanitized
configuration, refresh/rebuild, balance refresh, export, and relay/wallet
settings actions. These are TokenLedger domain capabilities, not new Blue
capability names. The future Blue companion injects this service and requests
only the Blue UI capabilities it actually renders.

### Fallback

The new face is additive. `ctx.tokenLedger` keeps its original object shape and
raw `store` behavior for existing consumers. A host without `reflect.provide`,
or a failure while constructing `tokenLedgerV1`, still collects and serves the
existing Web UI. Missing settings disables only settings actions; missing
account/provider capabilities return an unavailable or unsupported result
rather than stopping collection. The Web UI and loopback HTTP API remain the
golden/plain fallback and are intentionally unchanged.

## Fixtures

This host-side change has source-plane service and wiring tests plus a packed
tarball/exports check. The independent Blue companion fixture remains pending.
It must install packed TokenLedger and adapter tarballs outside both source
trees on the current and previous supported Harness lines, then exercise
service absence, replay, abort/stale rejection, unload/late results, provider
swap/fallback, width scans at 20/40/80/120 columns, composition, and cleanup.

## Deletion condition

The legacy `ctx.tokenLedger` face is not deleted by this migration. Removing its
raw `store` or changing any of its nine members requires an explicit upstream
breaking-release decision, a documented deprecation window, and evidence that
existing consumers have migrated. The Blue companion must never consume that
face, so it has no reason to trigger its removal.

The old Web implementation also remains when the TUI first mounts. Its possible
future removal requires full feature parity, both packed Harness-line fixtures,
replay/fork evidence, lifecycle and width evidence, real-profile dogfood, and
human acceptance.

## Current evidence

- Service tests cover deep freeze, credential filtering, serialized size
  bounds, replay, monotonic revisions, range reads, structured actions,
  expected-revision rejection, same-id supersede, abort-before-commit, unload,
  late results, and export limits.
- Plugin wiring tests prove one `apply()` publishes both faces, the legacy face
  retains exactly its original nine members and raw `store`, and
  `tokenLedgerV1` has no store, credentials, or legacy reader methods. They also
  cover V1-construction fallback and Fiber-owned cleanup.
- Wallet/balance tests cover instance-owned caches and external abort. The old
  function exports remain compatibility wrappers; the Cordis plugin itself
  never uses their shared compatibility cache.
- `@deepseek-ai/schemastery` remains an optional runtime peer and is also a dev
  dependency so the late-mounted settings contract is actually exercised by
  the package's own test install.

## Upstream maintenance footprint

Existing files changed by this boundary are deliberately limited:

- `src/plugin.js`: preserves and publishes the legacy service, constructs the
  separate `tokenLedgerV1` service, maps actions to existing domain functions,
  and orders cleanup.
- `src/newapi-user.js`: adds an instance-owned wallet reader and cancellation;
  the original exports remain compatible.
- `src/balance.js`: threads an optional caller AbortSignal through existing
  network reads.
- `package.json` and `package-lock.json`: export `./service` and install the
  already-declared optional schema peer for tests.
- `test/apply.test.js`, `test/newapi-user.test.js`, and `test/balance.test.js`:
  verify the new ownership/lifecycle paths while retaining the old behavior
  assertions.

No Web component, client route, HTTP path, database schema, usage fold, pricing
rule, or bundle row changes as part of the Domain/Public Service extraction.
