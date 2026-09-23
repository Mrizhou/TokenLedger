/**
 * Regression guards for the 2026-09-23 adversarial-audit hardening pass.
 *
 * Each test here pins ONE demonstrated corruption: fold type confusion, NUL
 * route-key splitting, dedup-key collapse, interleaved re-report double
 * charging, NaN day keys, day-cut timezone drift, schema-downgrade ledger
 * destruction, CSV formula injection, blank/junk base-URL misattribution,
 * the permanent-rebuild loop, blind tail increments, and default-price scope
 * creep. Every guard was mutation-verified: reverted to the pre-fix code, it
 * goes red.
 *
 * The CSRF write gate and `days` parsing guards live in `test/http.test.js`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { listAccounts } from "../src/balance.js";
import { discoverSites, mergeSites } from "../src/discovery.js";
import { priceWithConfiguredRates, staleAttributions, sweep } from "../src/plugin.js";
import { DEEPSEEK_OFFICIAL_RATES } from "../src/pricing.js";
import { LedgerStore, SCHEMA_VERSION } from "../src/store.js";
import { UNKNOWN_DAY, applyUsageDelta, bucketsOf, createUsageState, dayKey, foldUsage, parseRouteKey, routeKey } from "../src/usage.js";

const DAY = Date.parse("2026-09-20T10:00:00Z");
const DAY_KEY = dayKey(DAY);

let seq = 0;
const ev = (type, data, time = DAY) => ({ type, seq: seq++, time, data });
const message = (turn, step, provider, model, usage, time = DAY) =>
	ev("assistant/message", { turn, step, message: { role: "assistant", source: { kind: "model", provider, model } }, usage }, time);
const usageChunk = (turn, step, usage, time = DAY) => ev("assistant/chunk", { turn, step, chunk: { type: "usage", usage } }, time);

const withStore = (fn) => {
	const store = LedgerStore.open(":memory:");
	try {
		return fn(store);
	} finally {
		store.close();
	}
};

// --- fold: type confusion and name hygiene -----------------------------------

test("bucketsOf coerces numeric strings and clamps negatives to zero", () => {
	// A string field used to CONCATENATE into the totals (`"12"` made `"012"`)
	// and a negative count was summed as a negative.
	const b = bucketsOf({ inputTokens: "12", outputTokens: -5, cacheReadTokens: "junk", cacheWriteTokens: "3", reasoningTokens: 7 });
	assert.equal(b.inputTokens, 12);
	assert.equal(b.outputTokens, 0);
	assert.equal(b.cacheReadTokens, 0);
	assert.equal(b.cacheWriteTokens, 3);
	assert.equal(b.reasoningTokens, 7);
	assert.equal(b.requests, 1);

	const totals = foldUsage([message(1, 1, "p", "m", { inputTokens: "12", outputTokens: -5 })]).get(DAY_KEY).totals;
	assert.equal(totals.inputTokens, 12);
	assert.equal(totals.outputTokens, 0);
});

test("a log-supplied name cannot split a route key", () => {
	const key = routeKey("site", "prov\u0000evil", "m");
	assert.equal(key.split("\u0000").length, 3, "a separator inside a name must not add columns");
	assert.equal(parseRouteKey(key).provider, "prov\uFFFDevil");
});

test("a log-supplied name cannot grow without bound", () => {
	assert.equal(parseRouteKey(routeKey("site", "p", "m".repeat(300))).model.length, 128);
	assert.equal(parseRouteKey(routeKey("s".repeat(300), "p", "m")).site.length, 128);
});

// --- fold: re-report identity ------------------------------------------------

test("samples with no (turn, step) are each counted rather than deduped into one", () => {
	// A shared fallback key made every unidentified sample silently replace the
	// last one: three samples counted as one.
	const totals = foldUsage([
		usageChunk(undefined, undefined, { inputTokens: 10 }),
		usageChunk(undefined, undefined, { inputTokens: 20 }),
		usageChunk(undefined, undefined, { inputTokens: 30 })
	]).get(DAY_KEY).totals;
	assert.equal(totals.requests, 3);
	assert.equal(totals.inputTokens, 60);
});

test("an interleaved re-report replaces its earlier sample wherever it sits", () => {
	// (1,1)=10, (1,2)=20, (1,1)=99 must settle at 119, not 129: replacement is
	// looked up across the whole pass, not only against the previous sample.
	const totals = foldUsage([
		message(1, 1, "p", "m", { inputTokens: 10 }),
		message(1, 2, "p", "m", { inputTokens: 20 }),
		message(1, 1, "p", "m", { inputTokens: 99 })
	]).get(DAY_KEY).totals;
	assert.equal(totals.inputTokens, 119);
	assert.equal(totals.requests, 2);
});

// --- fold: day keys ----------------------------------------------------------

test("a sample with no usable timestamp folds into the explicit unknown day", () => {
	const untimed = {
		type: "assistant/message",
		seq: 1,
		data: { turn: 1, step: 1, message: { role: "assistant", source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 5 } }
	};
	const days = foldUsage([untimed]);
	assert.deepEqual([...days.keys()], [UNKNOWN_DAY]);
	assert.equal(UNKNOWN_DAY, "0000-00-00");
});

test("dayKey cuts days at the configured offset, not the machine's", () => {
	const at = Date.parse("2026-09-23T16:30:00Z");
	assert.equal(dayKey(at, 480), "2026-09-24", "16:30Z is already tomorrow in UTC+8");
	assert.equal(dayKey(at - 60 * 60 * 1000, 480), "2026-09-23");
	assert.equal(dayKey(at, 0), "2026-09-23");
	assert.equal(dayKey(NaN, 480), UNKNOWN_DAY, "no NaN-NaN-NaN day key, ever");

	const days = foldUsage([message(1, 1, "p", "m", { inputTokens: 5 }, at)], { dayOffsetMinutes: 480 });
	assert.deepEqual([...days.keys()], ["2026-09-24"]);
});

// --- store: schema and CSV ---------------------------------------------------

test("a store from a newer build is refused, and its rows survive the refusal", () => {
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-newer-"));
	const path = join(dir, "ledger.sqlite");
	try {
		const seeded = LedgerStore.open(path);
		const state = createUsageState();
		applyUsageDelta(state, [message(1, 1, "deepseek", "v4", { inputTokens: 100, outputTokens: 10 })]);
		seeded.commitSession("s1", state);
		seeded.close();

		const raw = new DatabaseSync(path);
		try {
			raw.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run(String(SCHEMA_VERSION + 1));

			// Dropping it would destroy rows this build cannot even read, and only
			// the logs that still exist could ever rebuild them. The handle is ours
			// to close: a refused `open` must leave the caller's connection intact.
			assert.throws(() => new LedgerStore(raw), /newer than this build/);

			assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM session_rollups").get().n), 1, "the refusal must not drop a single row");
			assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get().value, String(SCHEMA_VERSION + 1));
		} finally {
			raw.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("csv export neutralises spreadsheet formula cells", () => {
	// A model name comes from session logs, and Excel executes a leading
	// `=`/`+`/`-`/`@` (or tab/CR) as a formula — or DDE — on open. Quoting and
	// comma-escaping do not touch that.
	const prefixes = ["=", "+", "-", "@", "\t", "\r"];
	const csv = withStore((store) => {
		const state = createUsageState();
		for (const [i, prefix] of prefixes.entries()) {
			applyUsageDelta(state, [message(i + 1, 1, "p", `${prefix}cmd${i}`, { inputTokens: 10, outputTokens: 1 })]);
		}
		store.commitSession("s1", state);
		return store.exportCsv();
	});
	for (const [i, prefix] of prefixes.entries()) {
		assert.ok(csv.includes(`'${prefix}cmd${i}`), `cell starting ${JSON.stringify(prefix)} must be apostrophe-prefixed; csv: ${JSON.stringify(csv)}`);
	}
});

// --- discovery: the blank/junk baseURL family --------------------------------

test("a blank or junk base URL is read as absent, so the built-in table still speaks", () => {
	// `??` alone treats `""` as a real value, which shadowed the built-in
	// origin table and re-opened the mis-attribution the table exists to stop.
	const providers = [
		{ provider: "zai", settingsNs: "llm-pi-ai", settingsPath: ["providers", "zai"], declared: false },
		{ provider: "xiaomi", settingsNs: "llm-pi-ai", settingsPath: ["providers", "xiaomi"], declared: false }
	];
	const section = { providers: { zai: { baseURL: "" }, xiaomi: { baseURL: 42 } } };
	const result = discoverSites({ providers, readSection: () => section });
	assert.equal(result.providerBaseUrls.zai, "https://api.z.ai");
	assert.equal(result.providerBaseUrls.xiaomi, "https://api.xiaomimimo.com");
	assert.deepEqual(result.sites.map((s) => s.id).sort(), ["api.xiaomimimo.com", "api.z.ai"]);
});

test("an unreadable namespace gets no table answer at all", () => {
	// An unreadable profile is NOT an absent one: asserting a catalog origin
	// for a route whose override we could not read names a destination we do
	// not know.
	const providers = [{ provider: "zai", settingsNs: "llm-pi-ai", settingsPath: ["providers", "zai"], declared: false }];
	const result = discoverSites({
		providers,
		readSection: () => {
			throw new Error("namespace not registered here");
		}
	});
	assert.deepEqual(result.sites, []);
	assert.equal(Object.hasOwn(result.providerBaseUrls, "zai"), false, "the table must stay silent for a route we could not read");
});

test("an omitted settingsPath is the section root, and so is a null one", () => {
	const base = { baseURL: "https://relay.example/v1" };
	const providers = [
		{ provider: "r1", settingsNs: "llm-a", declared: true },
		{ provider: "r2", settingsNs: "llm-b", settingsPath: null, declared: true }
	];
	const sections = { "llm-a": base, "llm-b": base };
	const result = discoverSites({ providers, readSection: (ns) => sections[ns] });
	assert.equal(result.providerBaseUrls.r1, "https://relay.example/v1");
	assert.equal(result.providerBaseUrls.r2, "https://relay.example/v1");
	assert.deepEqual(result.sites.map((s) => s.routes).flat().sort(), ["r1", "r2"]);
	assert.equal(result.skipped, 0);
});

test("route names like __proto__ and toString keep their origins and their routes", () => {
	// Plain assignment to `providerBaseUrls[route]` sets the prototype for a
	// route named `__proto__`, and `in` sees `toString` on every plain object —
	// both silently ate entries.
	const providers = [{ provider: "__proto__", settingsNs: "llm-x", settingsPath: [], declared: true }];
	const result = discoverSites({ providers, readSection: () => ({ baseURL: "https://proto.example/v1" }) });
	const own = Object.getOwnPropertyDescriptor(result.providerBaseUrls, "__proto__");
	assert.equal(own?.value, "https://proto.example/v1", "the route must be an own entry, not a prototype write");
	assert.deepEqual(result.sites[0].routes, ["__proto__"]);

	const merged = mergeSites({ sites: [], providerBaseUrls: {}, directProviders: ["toString", "constructor"] }, {});
	assert.deepEqual(merged.directProviders, ["toString", "constructor"], "prototype-chain names are not already-mapped routes");
});

// --- balance: the same family on the card side -------------------------------

test("a blank base URL does not swallow the DeepSeek card", () => {
	const ctx = {
		get: (name) =>
			name === "llm"
				? {
						listConfigurableProviders: () => [
							{ provider: "zai", settingsNs: "llm-pi-ai", settingsPath: ["providers", "zai"], declared: false },
							{ provider: "deepseek-official", settingsNs: "llm-deepseek", settingsPath: [] }
						]
					}
				: name === "settings"
					? { get: (ns) => (ns === "llm-pi-ai" ? { providers: { zai: { baseURL: "", apiKeyEnv: "ZAI_API_KEY" } } } : {}) }
					: undefined
	};
	const accounts = listAccounts(ctx, { softwareOf: new Map() });
	assert.deepEqual(accounts.map((a) => `${a.id}:${a.scheme}`), ["zai:zai", "deepseek-official:deepseek"]);
});

// --- plugin: rebuild loop, tail increments, default prices -------------------

test("with no resolver every row is DIRECT by rule, so nothing is stale", () => {
	// Reading "no resolver" as UNROUTED called the whole index stale and
	// rebuilt the store on every sweep — forever.
	withStore((store) => {
		const state = createUsageState();
		applyUsageDelta(state, [message(1, 1, "p", "m", { inputTokens: 10, outputTokens: 1 })]);
		store.commitSession("s1", state);
		assert.deepEqual(staleAttributions(store, { available: true }), []);
		assert.deepEqual(staleAttributions(store, { available: true, resolveSite: undefined }), []);
	});
});

test("a tail read is trusted only when contiguous with our own sequence", async () => {
	// A checkpoint past a RE-NUMBERED log reads an empty or disjoint tail; if
	// that were trusted, the session would silently stop counting. Only a tail
	// that continues our own seq exactly is folded as-is.
	const store = LedgerStore.open(":memory:");
	try {
		const headerAt = (seq) => ({ type: "request/header", seq, time: DAY, data: { header: { config: { provider: "p", model: "m" } } } });
		const messageAt = (seq, turn, inputTokens, outputTokens = 0) => ({
			type: "assistant/message",
			seq,
			time: DAY,
			data: { turn, step: 1, message: { role: "assistant", source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens, outputTokens } }
		});
		const log = { revision: "r1", events: [headerAt(0), messageAt(1, 1, 200, 20), messageAt(2, 2, 50, 5)] };
		const calls = [];
		const persistence = {
			async list() {
				return [{ header: { version: 0, id: "s1", createdAt: DAY }, revision: log.revision }];
			},
			async open() {
				return {
					async read(fromSeq) {
						calls.push(fromSeq);
						return { events: log.events.filter((e) => e.seq >= fromSeq) };
					},
					async close() {}
				};
			}
		};

		await sweep(persistence, store, {});
		assert.deepEqual(calls, [0], "a first fold reads the whole log");

		log.revision = "r2";
		log.events = [...log.events, messageAt(3, 3, 10, 1)];
		calls.length = 0;
		await sweep(persistence, store, {});
		assert.deepEqual(calls, [3], "a tail continuing our exact sequence is folded as it is");
		assert.equal(store.totals().inputTokens, 260);

		// The v1→v2 migration shape: revision moves, seqs restart, one new
		// event sits far past our consumedSeq.
		log.revision = "r3";
		log.events = [headerAt(0), messageAt(1, 1, 200, 20), messageAt(2, 2, 50, 5), messageAt(3, 3, 10, 1), messageAt(40, 4, 7, 2)];
		calls.length = 0;
		await sweep(persistence, store, {});
		assert.deepEqual(calls, [4, 0], "a disjoint tail falls back to a full re-fold");
		assert.equal(store.totals().inputTokens, 267);
		assert.equal(store.totals().requests, 4, "the wholesale rollup replace means no double count");
	} finally {
		store.close();
	}
});

test("the shipped DeepSeek prices never price another route's rows", () => {
	// The shipped list is DeepSeek OFFICIAL prices: `deepseek-v4-flash` served
	// through Ali is billed at Ali's prices, and printing DeepSeek's numbers
	// for it is a confidently wrong figure.
	withStore((store) => {
		const state = createUsageState();
		applyUsageDelta(state, [
			message(1, 1, "ali", "deepseek-v4-flash", { inputTokens: 1000, outputTokens: 100 }),
			message(2, 1, "deepseek-official", "deepseek-v4-flash", { inputTokens: 1000, outputTokens: 100 })
		]);
		store.commitSession("s1", state);

		const scoped = priceWithConfiguredRates(store, {}, undefined, undefined);
		assert.equal(scoped.rows.length, 1, "the shipped list prices the official ROUTE's rows and nothing else");

		assert.deepEqual(priceWithConfiguredRates(store, {}, undefined, undefined, "ali"), { rows: [], totals: {}, unpricedModels: [] });

		// A user-supplied `rates` is the user's own pricing and prices every row.
		assert.equal(priceWithConfiguredRates(store, {}, undefined, DEEPSEEK_OFFICIAL_RATES, "ali").rows.length, 1);
	});
});
