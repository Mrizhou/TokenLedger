# Blue migration record

Status: Domain/Public Service extraction and the separate Blue companion are
implemented. The command-only Chinese overlay now delegates configuration to
Blue's existing `/settings` workflow and keeps a keyboard guide on every main
page. Packed compatibility, dedicated-profile dogfood, and human acceptance
remain release gates: no current/previous Harness-line result is claimed until
the fixture is run against the final clean Blue integration commit. The
original `ctx.tokenLedger` service and Web client remain unchanged; new
renderer-neutral consumers use
`ctx.tokenLedgerV1`. This record tracks issue
[zh667/TokenLedger#57](https://github.com/zh667/TokenLedger/issues/57).

## Boundary map

| Layer | Owner and status |
| --- | --- |
| Domain | TokenLedger owns SQLite indexing, durable session-log replay, fork accounting, relay/project attribution, pricing, balance/quota readers, export, and settings persistence. It imports no Blue package. |
| Projection | `ctx.tokenLedgerV1.current()` and `subscribe()` expose a bounded, deeply frozen summary with monotonic revisions and immediate replay. `queryUsage()` returns a bounded range/site view assembled by the same `usagePayload()` as Web. Every fixed collection reports `sourceCount`, `returnedCount`, and `omittedCount`; `boundaryTruncated` and bounded omission details make every other defensive reduction explicit. `queryCollection()` retrieves revision-fenced continuation pages. |
| Action | `execute()` exposes refresh, rebuild, balance, export, relay settings, and wallet settings as request-id/revision-fenced structured actions with abort, supersede, unload, and late-result handling. |
| Interaction model | `packages/blue/lib/model.js` maps public usage, balance, and export values to overlay forms, lists, actions, explicit Chinese navigation state, and a persistent keyboard guide. It owns no accounting or configuration state. |
| Renderer UI | `@dsh-blue/tokenledger` contributes renderer-neutral Blue nodes only. Blue core performs real compilation and owns pi-tui, width, focus, ANSI, and raw-terminal APIs. The only Blue entry is `/tokenledger`; it opens a managed overlay with total, breakdown, account, and export pages, delegates configuration to `/settings`, and registers no persistent pane or status item. |
| Composition rows | `packages/blue/cordis.patch.yml` adds explicit domain and companion rows. The domain row sets `commandEnabled: false`, preventing its legacy text command from duplicating the companion command. The companion has its own v1 manifest and is not silently bundled beside another cost surface. |

## Scope

| Scope | State |
| --- | --- |
| Host/plugin instance | SQLite store, directory, fingerprint state, project-title cache, settings handles, wallet/unit cache, service revision, and in-flight requests. |
| Agent | None. TokenLedger does not own Agent state. |
| Session | Durable usage facts remain in Harness session logs; TokenLedger keeps only indexed checkpoints and aggregates. |
| Frontend tree | The companion owns usage selection, filters, active account, dialogs, request epoch, and only the current continuation page. It owns no configuration projection and never accumulates the complete ledger or a second accounting projection. |
| Provider Fiber | Dynamic service binding owns subscriptions and AbortControllers. Replacement, session switch, capability failure, and unload abort/fence requests and dispose registrations. |

## Capabilities and fallback

### Capabilities

`tokenLedgerV1` provides bounded summary replay, range/site queries, stable
collection continuation, sanitized configuration, refresh/rebuild, balance
refresh, export, and relay/wallet settings actions. These remain TokenLedger
domain compatibility capabilities for Web, HTTP, legacy, and third-party
consumers, not new Blue capability names. The companion injects the service for
usage, balance, and export only; it performs no configuration read or settings
action and relies on Blue `/settings` for configuration. It requests only
commands, overlays, optional notifications, and optional readonly session
identity from Blue.

### Fallback

The new face is additive. `ctx.tokenLedger` keeps its original object shape and
raw `store` behavior for existing consumers. A host without `reflect.provide`,
or a failure while constructing `tokenLedgerV1`, still collects and serves the
existing Web UI. Missing settings disables only settings actions; missing
account/provider capabilities return an unavailable or unsupported result
rather than stopping collection. The Web UI and loopback HTTP API remain the
golden/plain fallback and are intentionally unchanged.

The companion is also additive. If Blue admission or a required capability is
denied, companion activation leaves no command or partial Blue surface; the
domain, Web UI, HTTP API, and legacy service continue unchanged. When Blue
admission succeeds but `tokenLedgerV1` is absent, invalid, or later unloads,
the already-registered single command opens a local Chinese unavailable
overlay. Removing the companion settings page does not remove the domain
namespace or public configuration/action contract.

## Fixtures

The independent companion fixture packs TokenLedger, the companion, and the
minimum Blue public closure with lifecycle scripts disabled. It installs them
outside both source trees with normal npm peer resolution. Its command-only
contract covers public exports, capability absence/dynamic arrival, exactly one
`/tokenledger` command, no idle pane/status/overlay, replay/duplicate rejection,
complete collection continuation, action abort/stale fencing, provider
swap/fallback, unload/late-result rejection, cleanup, and real Blue compiler
width scans at 20/40/80/120 columns. The compiler scenario exercises canonical
single-marker tabs, Enter and Space confirmation, main/detail tab focus restore,
the original asynchronous range-list focus regression, continued range
selection without another Tab traversal, and scoped `PgUp`/`PgDn` escape-key
dispatch with non-focusable paging actions.

The fixture deliberately contains no temporary Blue commit pin. Acceptance
must pass `--blue-revision <full-clean-blue-commit>` explicitly; omitting it
fails closed with `FIXTURE_BLUE_REVISION_REQUIRED`, and a dirty or different
checkout also fails before packaging. Each eventual report records that exact
revision and every installed Harness package instance's path, version,
integrity, and package.json digest. Current and previous Harness-line reports
must both execute every declared scenario with no skips before release. The
manifest preview window remains Blue `>=0.1.1-rc.2 <0.1.2` and Harness
`>=0.1.1-rc.1 <0.1.2`, but those ranges are not a claim that this candidate has
completed the final packed gate.

Automated fixtures are not human acceptance. Dedicated-profile pseudo-TTY and
live-terminal evidence must be repeated after the final Blue revision is clean,
built, and supplied to both packed runs; this record intentionally retains no
stale acceptance claim from an earlier linked process.

## Release candidate versions

The domain and companion manifests are synchronized at `0.1.1-blue.0`, an
unpublished integration candidate. The companion requires
`dsh-tokenledger >=0.1.1-blue.0 <0.2.0`; published `dsh-tokenledger@0.1.0` lacks
the `./service` export and `tokenLedgerV1` contract and is therefore not a
compatible peer. This candidate version is local evidence only, not a registry
release or an installability claim. A release must publish the compatible
domain first and keep the companion peer floor at that released version.

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
  bounds, exact source/returned/omitted counts, complete revision-fenced
  continuation, replay, monotonic revisions, range reads, structured actions,
  expected-revision rejection, same-id supersede, abort-before-commit, unload,
  late results, export limits, sparse hostile arrays, shared clone budgets,
  pre-clone action budgets, and descriptor-only rejection of accessors,
  proxies, overlong keys, credentials, and prototype-control keys.
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
- Companion tests cover usage, balance, and export workflows, bounded/frozen
  credential filtering, current-page-only continuation, cancellation, service
  replacement, capability fallback, complete export paging, passive section
  structure, incremental wide-object descriptor reads, no configuration reads
  or settings controls, and cleanup.
- The command-only companion revision has focused model/entry coverage for
  one-command admission, no persistent pane/status, Chinese active state
  delegated to canonical core markers, a persistent keyboard guide, and
  command/overlay cleanup. The custom fixture contains the full canonical
  compiler, focus-replacement, scoped paging, width, lifecycle, and packed-peer
  scenarios, but final clean-Blue current/previous Harness reports,
  dedicated-profile dogfood, and human live-terminal acceptance are pending.

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
- `src/service.js` and `test/service.test.js`: own and verify explicit boundary
  evidence plus the stable `queryCollection()` continuation contract.
- `packages/blue/`: contains the independent renderer-neutral companion,
  manifest, composition rows, bilingual documentation, unit tests, and packed
  dual-line fixture. It is packed and released separately from the root package.

No Web component, client route, HTTP path, database schema, usage fold, pricing
rule, or bundle row changes as part of the Domain/Public Service extraction.
