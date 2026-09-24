import assert from "node:assert/strict";
import test from "node:test";

import { buildResolver, normalizeRelayConfig, staleAttributions, sweep } from "../src/plugin.js";
import { LedgerStore } from "../src/store.js";
import { RelaySiteRegistry, createSiteResolver } from "../src/relay-sites.js";
import { DIRECT } from "../src/usage.js";

const DAY = Date.parse("2026-08-14T10:00:00");
let seq = 0;
const ev = (type, data) => ({ type, seq: seq++, time: DAY, data });
const header = (provider, model) => ev("request/header", { header: { config: { provider, model } } });
const message = (turn, step, provider, model, usage) =>
	ev("assistant/message", { turn, step, message: { role: "assistant", source: { kind: "model", provider, model } }, usage });
const eventAt = (seq, type, data) => ({ type, seq, time: DAY, data });
const headerAt = (seq) => eventAt(seq, "request/header", { header: { config: { provider: "p", model: "m" } } });
const messageAt = (seq, turn, inputTokens, outputTokens = 0) =>
	eventAt(seq, "assistant/message", {
		turn,
		step: 1,
		message: { role: "assistant", source: { kind: "model", provider: "p", model: "m" } },
		usage: { inputTokens, outputTokens }
	});
const seedEndAt = (seq) => eventAt(seq, "session/end-seed", {});

/**
 * A persistence double shaped like the real one: `listSnapshots()` returns
 * `{ header, revision }`, NOT `{ id }`. An earlier sweep read `snapshot.id`,
 * found nothing, and skipped every session in silence — a bug no synthetic
 * test caught because the double had been written to match the bug.
 */
const fakePersistence = (sessions) => ({
	async listSnapshots() {
		return [...sessions.entries()].map(([id, s]) => ({
			header: { version: 0, id, createdAt: DAY, ...s.header },
			revision: s.revision
		}));
	},
	async readFrom(id, fromSeq) {
		const s = sessions.get(id);
		if (s === undefined) throw new Error(`unknown session ${id}`);
		return { meta: { id }, events: s.events.filter((e) => e.seq >= fromSeq) };
	}
});

// Must await before closing: a synchronous `finally` around an async callback
// closes the database while the body is still using it, and every store call
// after that point fails inside the sweep's own error handling — which looks
// exactly like a collector bug.
const withStore = async (fn) => {
	const store = LedgerStore.open(":memory:");
	try {
		return await fn(store);
	} finally {
		store.close();
	}
};

test("the session id is read from snapshot.header.id", async () => {
	await withStore(async (store) => {
		const sessions = new Map([
			["s1", { revision: "r1", events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 100, outputTokens: 10 })] }]
		]);
		const stats = await sweep(fakePersistence(sessions), store, {});
		assert.equal(stats.scanned, 1);
		assert.equal(stats.updated, 1);
		assert.equal(stats.failed, 0);
		assert.equal(store.totals().inputTokens, 100);
	});
});

test("a snapshot with no recoverable id is counted and reported, not silently dropped", async () => {
	await withStore(async (store) => {
		const persistence = {
			async listSnapshots() {
				return [{ revision: "r1" }];
			},
			async readFrom() {
				throw new Error("should not be reached");
			}
		};
		const warnings = [];
		const stats = await sweep(persistence, store, { logger: { warn: (...a) => warnings.push(a) } });
		assert.equal(stats.scanned, 1);
		assert.equal(stats.failed, 1, "silence here is what hid the header.id bug");
		assert.equal(warnings.length, 1);
	});
});

test("an unchanged revision is skipped without reading the log", async () => {
	await withStore(async (store) => {
		let reads = 0;
		const sessions = new Map([
			["s1", { revision: "r1", events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 100, outputTokens: 10 })] }]
		]);
		const persistence = fakePersistence(sessions);
		const counting = { ...persistence, readFrom: (...a) => (reads++, persistence.readFrom(...a)) };

		await sweep(counting, store, {});
		assert.equal(reads, 1);
		const second = await sweep(counting, store, {});
		assert.equal(reads, 1, "an unchanged log must cost no read at all");
		assert.equal(second.skipped, 1);
	});
});

test("a changed revision reads only the tail and stays exact", async () => {
	await withStore(async (store) => {
		const events = [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 100, outputTokens: 10 })];
		const sessions = new Map([["s1", { revision: "r1", events }]]);
		const persistence = fakePersistence(sessions);
		await sweep(persistence, store, {});

		// Append a second turn and bump the revision, as an append would.
		events.push(message(2, 1, "p", "m", { inputTokens: 50, outputTokens: 5 }));
		sessions.get("s1").revision = "r2";
		const stats = await sweep(persistence, store, {});

		assert.equal(stats.updated, 1);
		assert.equal(stats.events, 1, "only the appended event was read");
		assert.equal(store.totals().inputTokens, 150);
		assert.equal(store.totals().requests, 2);
	});
});

// Revisions copied from a live 0.1.7-rc.2 JSONL backend: a five-field stat
// identity (`dev:ino:size:mtimeNs:ctimeNs`), plus one corpus-revision field
// for logs it migrates from an older session format. That corpus hash moves
// between observations of an UNCHANGED log — strict equality therefore never
// held again and every sweep re-folded every session from seq 0.
const FILE_REV = "25:102663:616:1790060732550935800:1790060732550935800";
const corpusRev = (hex) => `${FILE_REV}:${hex}`;

test("a moving corpus suffix on an unchanged log is skipped without reading it", async () => {
	await withStore(async (store) => {
		let reads = 0;
		const sessions = new Map([
			["s1", {
				revision: corpusRev("4ed11c4f4dd6f5e28e631261ee9cbd729c3727cd2c9cbd40cd3488d13f45fd8c"),
				events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 100, outputTokens: 10 })]
			}]
		]);
		const persistence = fakePersistence(sessions);
		const counting = { ...persistence, readFrom: (...a) => (reads++, persistence.readFrom(...a)) };

		await sweep(counting, store, {});
		assert.equal(reads, 1);
		// Same bytes on disk: only the corpus hash moved, as it does between
		// observations of the same historical log on 0.1.7.
		sessions.get("s1").revision = corpusRev("e9b84ccdacaa7b44f326bf3bae1aa0fa794b4d7f985aecad8d33d2115e0a8fcc");
		const second = await sweep(counting, store, {});
		assert.equal(reads, 1, "a moved corpus suffix is not a change to the log");
		assert.equal(second.skipped, 1);
	});
});

test("a changed file identity under a corpus suffix still refolds the tail", async () => {
	await withStore(async (store) => {
		const events = [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 100, outputTokens: 10 })];
		const sessions = new Map([["s1", {
			revision: corpusRev("4ed11c4f4dd6f5e28e631261ee9cbd729c3727cd2c9cbd40cd3488d13f45fd8c"),
			events
		}]]);
		const persistence = fakePersistence(sessions);
		await sweep(persistence, store, {});

		// Appending moved size and mtimeNs — the stat identity must still see it.
		events.push(message(2, 1, "p", "m", { inputTokens: 50, outputTokens: 5 }));
		sessions.get("s1").revision = "25:102663:700:1790266659740975400:1790266659740975400:e9b84ccdacaa7b44f326bf3bae1aa0fa794b4d7f985aecad8d33d2115e0a8fcc";
		const stats = await sweep(persistence, store, {});

		assert.equal(stats.updated, 1, "size and mtimeNs moved — the log grew");
		assert.equal(store.totals().inputTokens, 150);
	});
});

test("an unknown revision shape falls back to exact comparison", async () => {
	await withStore(async (store) => {
		let reads = 0;
		const sessions = new Map([
			["s1", {
				revision: "memory:host:1",
				events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 100, outputTokens: 10 })]
			}]
		]);
		const persistence = fakePersistence(sessions);
		const counting = { ...persistence, readFrom: (...a) => (reads++, persistence.readFrom(...a)) };

		await sweep(counting, store, {});
		sessions.get("s1").revision = "memory:host:2";
		await sweep(counting, store, {});
		assert.equal(reads, 2, "an unrecognized shape must never be trusted as unchanged");
	});
});

test("a fork counts only usage recorded after its inherited seed", async () => {
	await withStore(async (store) => {
		const parentEvents = [headerAt(0), messageAt(1, 1, 100, 10)];
		const childEvents = [
			...structuredClone(parentEvents),
			seedEndAt(2),
			headerAt(3),
			messageAt(4, 2, 50, 5)
		];
		const sessions = new Map([
			["parent", { revision: "parent-r1", events: parentEvents }],
			[
				"child",
				{
					revision: "child-r1",
					header: { parentSession: "parent", seedLength: parentEvents.length },
					events: childEvents
				}
			]
		]);

		const stats = await sweep(fakePersistence(sessions), store, {});

		assert.equal(stats.events, 5, "the child's two inherited events are not folded again");
		assert.equal(store.totals().inputTokens, 150);
		assert.equal(store.totals().outputTokens, 15);
		assert.equal(store.totals().requests, 2);
	});
});

test("nested forks count each model request exactly once", async () => {
	await withStore(async (store) => {
		const parentEvents = [messageAt(0, 1, 100)];
		const childEvents = [
			...structuredClone(parentEvents),
			seedEndAt(1),
			messageAt(2, 2, 50)
		];
		const grandchildEvents = [
			...structuredClone(childEvents),
			seedEndAt(3),
			messageAt(4, 3, 25)
		];
		const sessions = new Map([
			["parent", { revision: "parent-r1", events: parentEvents }],
			["child", { revision: "child-r1", header: { parentSession: "parent", seedLength: 1 }, events: childEvents }],
			[
				"grandchild",
				{
					revision: "grandchild-r1",
					header: { parentSession: "child", seedLength: childEvents.length },
					events: grandchildEvents
				}
			]
		]);

		await sweep(fakePersistence(sessions), store, {});

		assert.equal(store.totals().inputTokens, 175);
		assert.equal(store.totals().requests, 3);
	});
});

test("a fork resumes incrementally after establishing its seed checkpoint", async () => {
	await withStore(async (store) => {
		const inherited = [messageAt(0, 1, 100, 10)];
		const events = [...structuredClone(inherited), seedEndAt(1)];
		const sessions = new Map([
			[
				"child",
				{
					revision: "r1",
					header: { parentSession: "parent", seedLength: inherited.length },
					events
				}
			]
		]);
		const persistence = fakePersistence(sessions);
		const reads = [];
		const recording = {
			...persistence,
			readFrom: (id, fromSeq) => {
				reads.push(fromSeq);
				return persistence.readFrom(id, fromSeq);
			}
		};

		await sweep(recording, store, {});
		events.push(messageAt(2, 2, 50, 5));
		sessions.get("child").revision = "r2";
		await sweep(recording, store, {});

		assert.deepEqual(reads, [1, 2]);
		assert.equal(store.totals().tokens, 55);
		assert.equal(store.totals().requests, 1);
	});
});

test("one broken session does not stop the others", async () => {
	await withStore(async (store) => {
		const good = [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 7, outputTokens: 1 })];
		const persistence = {
			async listSnapshots() {
				return [
					{ header: { id: "bad" }, revision: "r1" },
					{ header: { id: "good" }, revision: "r1" }
				];
			},
			async readFrom(id) {
				if (id === "bad") throw new Error("corrupt log");
				return { meta: { id }, events: good };
			}
		};
		const stats = await sweep(persistence, store, { logger: { warn() {} } });
		assert.equal(stats.failed, 1);
		assert.equal(stats.updated, 1);
		assert.equal(store.totals().inputTokens, 7);
	});
});

test("a listSnapshots failure degrades instead of throwing into DSH", async () => {
	await withStore(async (store) => {
		const persistence = {
			async listSnapshots() {
				throw new Error("backend down");
			}
		};
		const stats = await sweep(persistence, store, { logger: { warn() {} } });
		assert.equal(stats.failed, 1);
		assert.equal(stats.scanned, 0);
	});
});

// --- the index can drift from the directory ------------------------------------

/** A directory that resolves `nine` to a relay and knows nothing else. */
function liveDirectory() {
	const registry = new RelaySiteRegistry([{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example/v1" }]);
	const providerBaseUrls = { ninerelay: "https://api.relay-one.example/v1" };
	return { available: true, providerBaseUrls, resolveSite: createSiteResolver(registry, providerBaseUrls) };
}

/** Fold `events` into a fresh store using `resolveSite`. */
async function indexedWith(store, id, events, resolveSite) {
	await sweep(fakePersistence(new Map([[id, { revision: id, events }]])), store, { resolveSite });
}

test("a route recorded under a site the directory no longer agrees with is stale", async () => {
	// The shape a real install reached: the fold is INCREMENTAL, so a session
	// first folded before the directory knew a route keeps those rows while its
	// later events attribute correctly. One route, two sites, 229k tokens of it
	// under "direct/official".
	await withStore(async (store) => {
		const directory = liveDirectory();
		const blind = createSiteResolver(new RelaySiteRegistry([]), {});
		await indexedWith(store, "s1", [header("ninerelay", "gpt"), message(1, 1, "ninerelay", "gpt", { inputTokens: 100, outputTokens: 0 })], blind);

		const stale = staleAttributions(store, directory);
		assert.deepEqual(stale, [{ site: "unrouted", provider: "ninerelay", expected: "nine" }]);
	});
});

test("an index that agrees with the directory is not rebuilt", async () => {
	// Without this the check would rebuild on every sweep, which is a rebuild
	// loop wearing the costume of a fix.
	await withStore(async (store) => {
		const directory = liveDirectory();
		await indexedWith(store, "s1", [header("ninerelay", "gpt"), message(1, 1, "ninerelay", "gpt", { inputTokens: 100, outputTokens: 0 })], directory.resolveSite);
		assert.deepEqual(staleAttributions(store, directory), []);
	});
});

test("a genuinely direct route is not mistaken for drift", async () => {
	await withStore(async (store) => {
		const registry = new RelaySiteRegistry([{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example/v1" }]);
		const providerBaseUrls = { ninerelay: "https://api.relay-one.example/v1", official: "https://api.deepseek.com" };
		const directory = { available: true, providerBaseUrls, resolveSite: createSiteResolver(registry, providerBaseUrls) };
		await indexedWith(store, "s1", [header("official", "v4"), message(1, 1, "official", "v4", { inputTokens: 10, outputTokens: 0 })], directory.resolveSite);
		assert.deepEqual(staleAttributions(store, directory), []);
	});
});

test("a directory that could not be read proves nothing about the index", async () => {
	// Discovery being down makes every route look unresolvable. Acting on that
	// would rebuild the whole index into a worse state than it started in.
	await withStore(async (store) => {
		const directory = liveDirectory();
		await indexedWith(store, "s1", [header("ninerelay", "gpt"), message(1, 1, "ninerelay", "gpt", { inputTokens: 100, outputTokens: 0 })], directory.resolveSite);
		assert.deepEqual(staleAttributions(store, { ...directory, available: false }), []);
		assert.deepEqual(staleAttributions(store, undefined), []);
	});
});

test("rows with no route at all are left alone", async () => {
	// `provider = unknown` has nothing to resolve; it is already counted by the
	// unattributed diagnostic and must not drive a rebuild that cannot fix it.
	await withStore(async (store) => {
		await indexedWith(store, "s1", [message(1, 1, undefined, undefined, { inputTokens: 10, outputTokens: 0 })], liveDirectory().resolveSite);
		assert.deepEqual(staleAttributions(store, liveDirectory()), []);
	});
});

test("relay attribution flows through the sweep", async () => {
	await withStore(async (store) => {
		const registry = new RelaySiteRegistry([
			{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example/v1" }
		]);
		// Three routes, three different answers. `official` is configured and
		// points at no relay; `elsewhere` is not in the directory at all.
		const resolveSite = createSiteResolver(registry, {
			ninerelay: "https://api.relay-one.example/v1",
			official: "https://api.deepseek.com"
		});
		const sessions = new Map([
			[
				"s1",
				{
					revision: "r1",
					events: [
						header("ninerelay", "gpt"),
						message(1, 1, "ninerelay", "gpt", { inputTokens: 100, outputTokens: 10 }),
						message(2, 1, "official", "gpt", { inputTokens: 20, outputTokens: 2 }),
						message(3, 1, "elsewhere", "gpt", { inputTokens: 7, outputTokens: 1 })
					]
				}
			]
		]);
		await sweep(fakePersistence(sessions), store, { resolveSite });

		const sites = store.bySite();
		assert.deepEqual(
			sites.map((s) => [s.site, s.inputTokens]).sort(),
			[
				// Configured, points at the vendor. Genuinely direct.
				["direct", 20],
				["nine", 100],
				// NOT in the directory. We do not know where this went, and
				// saying "direct/official" would be inventing an answer — a real
				// install showed 88% of its tokens that way.
				["unrouted", 7]
			].sort()
		);
	});
});

test("the dsh version is stamped on the checkpoint", async () => {
	await withStore(async (store) => {
		const sessions = new Map([
			["s1", { revision: "r1", events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 1, outputTokens: 1 })] }]
		]);
		await sweep(fakePersistence(sessions), store, { dshVersion: "0.1.0-rc.6" });
		assert.equal(store.checkpointFor("s1").dshVersion, "0.1.0-rc.6");
		assert.equal(store.checkpointFor("s1").logRevision, "r1");
	});
});

// --- relay config normalization -------------------------------------------

test("one line per relay yields a site, a route map, and a resolver", async () => {
	const { sites, providerBaseUrls, resolveSite } = normalizeRelayConfig({
		relays: { ninerelay: "https://api.relay-one.example/v1" }
	});
	assert.equal(sites.length, 1);
	assert.equal(sites[0].id, "api.relay-one.example", "the id is the exact domain, which is what reports show");
	assert.equal(sites[0].type, undefined, "type is fingerprinted later, not typed by hand");
	assert.deepEqual(providerBaseUrls, { ninerelay: "https://api.relay-one.example/v1" });
	assert.equal(resolveSite("ninerelay"), "api.relay-one.example");
	assert.equal(resolveSite("something-else"), undefined);
});

test("two routes on one relay collapse to a single site", async () => {
	// A key per model group is normal; they share one invoice and must not
	// produce two rows for it.
	const { sites, resolveSite } = normalizeRelayConfig({
		relays: {
			gptroute: "https://api.relay-one.example/v1",
			clauderoute: "https://api.relay-one.example/v1"
		}
	});
	assert.equal(sites.length, 1);
	assert.equal(resolveSite("gptroute"), resolveSite("clauderoute"));
});

test("the long form overrides the derived id and type", async () => {
	const { sites, resolveSite } = normalizeRelayConfig({
		relays: {
			r: { baseUrl: "https://api.relay-two.example", id: "my-label", type: "sub2api" }
		}
	});
	assert.equal(sites[0].id, "my-label");
	assert.equal(sites[0].type, "sub2api");
	assert.equal(resolveSite("r"), "my-label");
});

test("no relays configured means no resolver, and everything is direct", async () => {
	const { sites, resolveSite } = normalizeRelayConfig({});
	assert.deepEqual(sites, []);
	assert.equal(resolveSite, undefined);

	await withStore(async (store) => {
		const sessions = new Map([
			["s1", { revision: "r1", events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 5, outputTokens: 1 })] }]
		]);
		await sweep(fakePersistence(sessions), store, { resolveSite });
		assert.deepEqual(store.bySite().map((s) => s.site), ["direct"], "still a correct report, just no site dimension");
	});
});

test("a shipped provider default resolves as official even without a relay site", () => {
	const resolveSite = buildResolver({ directProviders: ["deepseek-official"] });
	assert.equal(resolveSite("deepseek-official"), DIRECT);
	assert.equal(resolveSite("removed-route"), undefined, "an absent route remains unknown");
});

test("a malformed relay entry is skipped rather than poisoning the map", async () => {
	const { sites, providerBaseUrls } = normalizeRelayConfig({
		relays: { good: "https://api.relay-one.example", bad: "", worse: null, alsoBad: {} }
	});
	assert.equal(sites.length, 1);
	assert.deepEqual(Object.keys(providerBaseUrls), ["good"]);
});

test("handles handle-based persistence (list + open handle) from modern DSH", async () => {
	await withStore(async (store) => {
		const sessions = new Map([
			["s1", { revision: "r1", events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 200, outputTokens: 20 })] }]
		]);
		let closed = false;
		const handlePersistence = {
			async list() {
				return [...sessions.entries()].map(([id, s]) => ({
					header: { version: 0, id, createdAt: DAY, ...s.header },
					revision: s.revision
				}));
			},
			async open(id, mode) {
				assert.equal(mode, "read");
				return {
					async read(fromSeq) {
						const s = sessions.get(id);
						return { events: s.events.filter((e) => e.seq >= fromSeq) };
					},
					async close() {
						closed = true;
					}
				};
			}
		};
		const stats = await sweep(handlePersistence, store, {});
		assert.equal(stats.scanned, 1);
		assert.equal(stats.updated, 1);
		assert.equal(closed, true);
		assert.equal(store.totals().inputTokens, 200);
		assert.equal(store.totals().outputTokens, 20);
	});
});

test("a renumbered log is re-folded rather than skipped, so a migrated session keeps counting", async () => {
	// The v1 -> v2 session migration RENUMBERS event seqs. A checkpoint written
	// before it points past the end of the renumbered log, so a tail read comes
	// back empty, the session is counted as skipped, and it is never folded
	// again — silently, because sweep() swallows its own failures. The handle
	// seam therefore re-reads the whole log and folds it from scratch.
	await withStore(async (store) => {
		const log = { revision: "r1", events: [headerAt(100), messageAt(101, 1, 200, 20)] };
		const persistence = {
			async list() {
				return [{ header: { version: 0, id: "s1", createdAt: DAY }, revision: log.revision }];
			},
			async open(id, mode) {
				assert.equal(mode, "read");
				return {
					async read(fromSeq) {
						return { events: log.events.filter((e) => e.seq >= fromSeq) };
					},
					async close() {}
				};
			}
		};

		const first = await sweep(persistence, store, {});
		assert.equal(first.updated, 1, "the pre-migration sweep lands a checkpoint past seq 100");
		assert.equal(store.totals().inputTokens, 200);

		// The migration: the same conversation plus one more turn, renumbered
		// from zero. Every seq is now far below the consumedSeq just stored.
		log.revision = "r2";
		log.events = [headerAt(0), messageAt(1, 1, 200, 20), messageAt(2, 2, 50, 5)];

		const second = await sweep(persistence, store, {});
		assert.equal(second.skipped, 0, "an empty tail read must not retire the session for good");
		assert.equal(second.updated, 1);
		assert.equal(store.totals().inputTokens, 250, "the whole renumbered log is folded again");
		assert.equal(store.totals().outputTokens, 25);
		assert.equal(store.totals().requests, 2, "the wholesale rollup replace means no double count");
	});
});
