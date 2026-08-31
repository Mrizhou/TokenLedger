/**
 * Renderer-neutral TokenLedger service contract.
 *
 * These tests exercise the boundary a non-Web renderer consumes. The domain
 * implementation is deliberately hostile where lifecycle behavior matters:
 * it may resolve after abort or after the owning plugin has begun unloading.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	TOKEN_LEDGER_COLLECTION_PAGE_MAX,
	TOKEN_LEDGER_SUMMARY_MAX_BYTES,
	TOKEN_LEDGER_VIEW_MAX_BYTES,
	TokenLedgerError,
	TokenLedgerService,
	createTokenLedgerCollectionPage,
	createTokenLedgerSummary,
	createTokenLedgerView
} from "../src/service.js";

const usage = (overrides = {}) => ({
	version: "0.1.0",
	generatedAt: 1_000,
	timeZone: { id: "Asia/Shanghai", offsetMinutes: 480 },
	range: {},
	totals: { inputTokens: 100, outputTokens: 20, tokens: 120 },
	windows: {
		today: { tokens: 120 },
		month: { tokens: 240 },
		all: { tokens: 360 }
	},
	days: [{ day: "2026-08-30", tokens: 120 }],
	activity: [{ day: "2026-08-30", tokens: 120 }],
	activityModels: [{ day: "2026-08-30", model: "deepseek-chat", tokens: 120 }],
	models: [{ model: "deepseek-chat", tokens: 120 }],
	sites: [{ site: "direct", tokens: 120 }],
	projects: [{ project: "/work/blue", title: "Blue", tokens: 120 }],
	providers: [{ provider: "deepseek", tokens: 120 }],
	directory: [{ id: "direct", routes: ["deepseek"] }],
	accounts: [{ id: "deepseek", origin: "https://api.deepseek.com" }],
	diagnostics: { sessions: 1, secret: "must-not-cross" },
	priced: { currency: "CNY", total: 0.001, apiKey: "must-not-cross" },
	lastSweepAt: 900,
	...overrides
});

const implementation = (overrides = {}) => ({
	readUsage: () => usage(),
	runAction: async () => ({ ok: true, changed: false }),
	...overrides
});

const errorCode = (code) => (error) => error instanceof TokenLedgerError && error.code === code;

function assertDeepFrozen(value, seen = new WeakSet()) {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	assert.equal(Object.isFrozen(value), true);
	for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test("summary and detailed views are bounded, deeply frozen, and credential-free", () => {
	const long = "x".repeat(8_192);
	const many = Array.from({ length: 4_096 }, (_, index) => ({ index, label: long, authorization: `Bearer ${index}` }));
	const source = usage({
		activityModels: many,
		models: many,
		projects: many,
		providers: many,
		diagnostics: { credentialReference: "settings:key", nested: { password: "hidden", value: "visible" } },
		priced: { token: "hidden", rows: many }
	});
	const view = createTokenLedgerView(source);
	const summary = createTokenLedgerSummary(source, 7);

	assert.ok(Buffer.byteLength(JSON.stringify(view), "utf8") <= TOKEN_LEDGER_VIEW_MAX_BYTES);
	assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") <= TOKEN_LEDGER_SUMMARY_MAX_BYTES);
	assert.equal(summary.revision, 7);
	assert.equal(JSON.stringify({ view, summary }).includes("Bearer"), false);
	assert.equal(JSON.stringify({ view, summary }).includes("hidden"), false);
	assert.equal(view.boundaryTruncated, true);
	assert.ok(view.boundaryOmissions.some((entry) => entry.kind === "string" && entry.omittedCount > 0));
	assert.equal(view.collectionBounds.models.sourceCount, many.length);
	assert.equal(view.collectionBounds.models.returnedCount, view.models.length);
	assert.equal(view.collectionBounds.models.omittedCount, many.length - view.models.length);
	assert.equal(summary.collectionBounds.models.sourceCount, many.length);
	assert.equal(summary.collectionBounds.models.returnedCount, summary.models.length);
	assert.equal(summary.collectionBounds.models.omittedCount, many.length - summary.models.length);
	assertDeepFrozen(view);
	assertDeepFrozen(summary);
});

test("every fixed collection reports exact source, returned, and omitted counts", () => {
	const many = (count) => Array.from({ length: count }, (_, index) => ({ index }));
	const source = usage({
		days: many(401),
		activity: many(372),
		activityModels: many(2049),
		models: many(257),
		sites: many(129),
		projects: many(257),
		providers: many(257),
		directory: many(129),
		accounts: many(129),
		priced: { rows: many(257) }
	});
	const view = createTokenLedgerView(source);
	const expected = {
		days: 401,
		activity: 372,
		activityModels: 2049,
		models: 257,
		sites: 129,
		projects: 257,
		providers: 257,
		directory: 129,
		accounts: 129,
		pricedRows: 257
	};

	assert.equal(view.boundaryTruncated, true);
	for (const [name, sourceCount] of Object.entries(expected)) {
		const bound = view.collectionBounds[name];
		assert.equal(bound.sourceCount, sourceCount, name);
		assert.equal(bound.returnedCount + bound.omittedCount, sourceCount, name);
		assert.ok(bound.omittedCount > 0, name);
	}
	assertDeepFrozen(view.collectionBounds);
});

test("hostile sparse arrays keep exact counts without length-sized allocation or traversal", () => {
	const sparse = [];
	sparse.length = 2 ** 32 - 1;
	sparse[0] = { model: "first", tokens: 1 };
	const source = usage({ models: sparse });
	const view = createTokenLedgerView(source);

	assert.equal(view.collectionBounds.models.sourceCount, 2 ** 32 - 1);
	assert.equal(view.collectionBounds.models.returnedCount, 256);
	assert.equal(view.collectionBounds.models.omittedCount, 2 ** 32 - 1 - 256);
	assert.equal(view.models[0].model, "first");

	const tail = createTokenLedgerCollectionPage(source, {
		collection: "models",
		offset: 2 ** 32 - 2,
		limit: 1
	});
	assert.equal(tail.sourceCount, 2 ** 32 - 1);
	assert.equal(tail.offset, 2 ** 32 - 2);
	assert.equal(tail.returnedCount, 1);
	assert.equal(tail.nextOffset, undefined);

	assert.throws(
		() => createTokenLedgerCollectionPage(source, { collection: "models", sortBy: "tokens" }),
		errorCode("VIEW_TOO_LARGE")
	);
	const sparseActivity = [];
	sparseActivity.length = 2 ** 32 - 1;
	assert.throws(
		() => createTokenLedgerCollectionPage(usage({ activityModels: sparseActivity }), {
			collection: "activityModels",
			day: "2026-08-30"
		}),
		errorCode("VIEW_TOO_LARGE")
	);
});

test("collection continuation retrieves every row with explicit page counts", async () => {
	const models = Array.from({ length: 301 }, (_, index) => ({ model: `model-${String(index)}`, tokens: index }));
	const activityModels = [
		...Array.from({ length: 75 }, (_, index) => ({ day: "2026-08-30", model: `today-${String(index)}` })),
		...Array.from({ length: 25 }, (_, index) => ({ day: "2026-08-29", model: `yesterday-${String(index)}` }))
	];
	const source = usage({ models, activityModels });
	const direct = createTokenLedgerCollectionPage(source, { collection: "models", offset: 37, limit: 23 });
	assert.equal(direct.sourceCount, 301);
	assert.equal(direct.returnedCount, 23);
	assert.equal(direct.omittedBefore, 37);
	assert.equal(direct.omittedAfter, 241);
	assert.equal(direct.omittedCount, 278);
	assert.equal(direct.items[0].model, "model-37");
	assertDeepFrozen(direct);

	const queries = [];
	const service = new TokenLedgerService(implementation({ readUsage: (query) => { queries.push(query); return source; } }));
	const received = [];
	let offset = 0;
	while (true) {
		const result = await service.queryCollection({
			requestId: `models-${String(offset)}`,
			expectedRevision: 1,
			collection: "models",
			offset,
			limit: 37
		});
		assert.equal(result.revision, 1);
		received.push(...result.value.items.map((entry) => entry.model));
		if (result.value.nextOffset === undefined) break;
		offset = result.value.nextOffset;
	}
	assert.deepEqual(received, models.map((entry) => entry.model));

	const filtered = await service.queryCollection({
		requestId: "activity-day",
		expectedRevision: 1,
		collection: "activityModels",
		day: "2026-08-30",
		limit: 80
	});
	assert.equal(filtered.value.sourceCount, 75);
	assert.equal(filtered.value.returnedCount, 75);
	assert.ok(filtered.value.items.every((entry) => entry.day === "2026-08-30"));

	await service.queryCollection({
		requestId: "provider-page",
		expectedRevision: 1,
		collection: "models",
		provider: " route-two ",
		limit: 1
	});
	assert.deepEqual(queries.at(-1), { range: {}, site: undefined, provider: "route-two" });

	await assert.rejects(
		service.queryCollection({ requestId: "stale-page", expectedRevision: 2, collection: "models" }),
		errorCode("STALE")
	);
	assert.throws(
		() => service.queryCollection({ requestId: "unknown-page", collection: "unknown" }),
		errorCode("INVALID_REQUEST")
	);
	assert.throws(
		() => service.queryCollection({ requestId: "large-page", collection: "models", limit: TOKEN_LEDGER_COLLECTION_PAGE_MAX + 1 }),
		errorCode("INVALID_REQUEST")
	);
	await service.dispose();
});

test("collection size retries use a fresh page-wide clone budget and preserve continuation", () => {
	const label = "界".repeat(2_048);
	const models = Array.from({ length: 128 }, (_, index) => ({
		model: `model-${String(index)}`,
		label,
		tokens: index
	}));
	const source = usage({ models });
	const received = [];
	let offset = 0;
	while (true) {
		const page = createTokenLedgerCollectionPage(source, {
			collection: "models",
			offset,
			limit: TOKEN_LEDGER_COLLECTION_PAGE_MAX
		});
		assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 256 * 1024);
		assert.ok(page.returnedCount > 0);
		assert.equal(page.boundaryOmissions.some((detail) => detail.kind.endsWith("budget")), false);
		received.push(...page.items.map((entry) => entry.model));
		if (page.nextOffset === undefined) break;
		offset = page.nextOffset;
	}
	assert.deepEqual(received, models.map((entry) => entry.model));
});

test("inherited boundary omissions are rebuilt from bounded public scalars", () => {
	let invoked = false;
	const safe = {
		path: "models[1] / unsafe",
		kind: "string / unsafe",
		sourceCount: 9,
		returnedCount: 2,
		omittedCount: 7,
		secret: "must-not-cross"
	};
	Object.defineProperty(safe, "credential", {
		enumerable: true,
		get() {
			invoked = true;
			return "must-not-cross";
		}
	});
	const traps = { count: 0 };
	const hostile = new Proxy({}, {
		get() {
			traps.count += 1;
			throw new Error("must not run");
		},
		getOwnPropertyDescriptor() {
			traps.count += 1;
			throw new Error("must not run");
		}
	});
	const source = usage({
		boundaryOmissions: [safe, hostile, { path: "bad", kind: "bad", sourceCount: 1, returnedCount: 0, omittedCount: 0 }],
		boundaryOmissionOverflow: 2
	});
	Object.defineProperty(source, "boundaryTruncated", {
		enumerable: true,
		get() {
			invoked = true;
			return true;
		}
	});
	const view = createTokenLedgerView(source);

	assert.equal(invoked, false);
	assert.equal(traps.count, 0);
	assert.equal(JSON.stringify(view).includes("must-not-cross"), false);
	assert.deepEqual(view.boundaryOmissions[0], {
		path: "models[1]___unsafe",
		kind: "string___unsafe",
		sourceCount: 9,
		returnedCount: 2,
		omittedCount: 7
	});
	for (const detail of view.boundaryOmissions) {
		assert.deepEqual(Object.keys(detail).sort(), ["kind", "omittedCount", "path", "returnedCount", "sourceCount"]);
	}
	assert.ok(view.boundaryOmissions.some((detail) => detail.path === "boundaryTruncated" && detail.kind === "accessor"));
	assert.ok(view.boundaryOmissionOverflow >= 4);
});

test("bounded clones omit oversized credential and prototype-control keys", () => {
	const paddedCredential = `a${"-".repeat(80)}pi-key`;
	const diagnostics = {
		visible: "safe",
		[paddedCredential]: "padded-credential-leak",
		prototype: "prototype-leak",
		constructor: "constructor-leak"
	};
	Object.defineProperty(diagnostics, "__proto__", {
		value: "proto-leak",
		enumerable: true,
		configurable: true
	});
	const view = createTokenLedgerView(usage({ diagnostics }));
	const serialized = JSON.stringify(view);

	assert.equal(view.diagnostics.visible, "safe");
	assert.equal(serialized.includes("credential-leak"), false);
	assert.equal(serialized.includes("prototype-leak"), false);
	assert.equal(serialized.includes("constructor-leak"), false);
	assert.equal(serialized.includes("proto-leak"), false);
	assert.ok(view.boundaryOmissions.some((detail) => detail.kind === "key" && detail.path === "diagnostics.[key]"));
	assert.ok(view.boundaryOmissions.some((detail) => detail.kind === "private-key" && detail.path === "diagnostics.prototype"));
});

test("bounded clones share node and UTF-8 text budgets across the complete result", async () => {
	const activityModels = Array.from({ length: 2_048 }, (_, index) => Object.fromEntries([
		["model", `model-${String(index)}`],
		...Array.from({ length: 20 }, (__, field) => [`field${String(field)}`, field])
	]));
	const view = createTokenLedgerView(usage({ activityModels }));
	assert.equal(view.collectionBounds.activityModels.sourceCount, activityModels.length);
	assert.ok(view.collectionBounds.activityModels.returnedCount < activityModels.length);
	assert.ok(view.boundaryOmissions.some((detail) => detail.kind === "node-budget"));

	const wide = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
		`field${String(index)}`,
		"界".repeat(2_048)
	]));
	const service = new TokenLedgerService(implementation({ readConfiguration: () => ({ wide }) }));
	const configuration = await service.getConfiguration({ requestId: "bounded-configuration" });
	assert.ok(configuration.value.boundaryOmissions.some((detail) => detail.kind === "text-budget"));
	assert.equal(configuration.value.boundaryTruncated, true);
	assertDeepFrozen(configuration);
	await service.dispose();
});

test("subscriptions replay immediately and publish only changed content", async () => {
	let current = usage();
	const service = new TokenLedgerService(implementation({ readUsage: () => current }));
	const seen = [];
	const off = service.subscribe((snapshot) => seen.push(snapshot));

	assert.deepEqual(seen.map((snapshot) => snapshot.revision), [1]);
	const unchanged = await service.getSummary({ requestId: "same" });
	assert.equal(unchanged, seen[0]);
	assert.deepEqual(seen.map((snapshot) => snapshot.revision), [1]);

	current = usage({ totals: { inputTokens: 200, outputTokens: 20, tokens: 220 } });
	const changed = await service.getSummary({ requestId: "changed" });
	assert.equal(changed.revision, 2);
	assert.deepEqual(seen.map((snapshot) => snapshot.revision), [1, 2]);
	off();
	current = usage({ totals: { inputTokens: 300, outputTokens: 20, tokens: 320 } });
	await service.getSummary({ requestId: "after-off" });
	assert.equal(seen.length, 2);
	await service.dispose();
});

test("forced notifications publish settings-only changes without weakening ordinary deduplication", async () => {
	const service = new TokenLedgerService(implementation());
	const seen = [];
	service.subscribe((snapshot) => seen.push(snapshot.revision));

	service.notifyChanged();
	assert.deepEqual(seen, [1]);
	assert.equal(service.current().revision, 1);

	service.notifyChanged(true);
	assert.deepEqual(seen, [1, 2]);
	assert.equal(service.current().revision, 2);
	await service.dispose();
});

test("range queries are bounded reads and do not advance the summary revision", async () => {
	const reads = [];
	const service = new TokenLedgerService(implementation({
		readUsage: (query) => {
			reads.push(query);
			return usage({ range: query.range, site: query.site, provider: query.provider });
		}
	}));
	const result = await service.queryUsage({
		requestId: "range",
		range: { from: "2026-08-01", to: "2026-08-30", ignored: "x" },
		site: " relay.example ",
		provider: " route-two "
	});

	assert.deepEqual(reads.at(-1), { range: { from: "2026-08-01", to: "2026-08-30" }, site: "relay.example", provider: "route-two" });
	assert.equal(result.revision, 1);
	assert.equal(result.value.site, "relay.example");
	assert.equal(result.value.provider, "route-two");
	assert.equal(service.current().revision, 1);
	assertDeepFrozen(result);
	await service.dispose();
});

test("every async read captures its revision before await and rejects a mixed cut", async () => {
	for (const kind of ["summary", "usage", "collection"]) {
		const late = Promise.withResolvers();
		let reads = 0;
		let tokens = 120;
		const service = new TokenLedgerService(implementation({
			readUsage: () => {
				reads += 1;
				if (reads === 2) return late.promise;
				return usage({ totals: { tokens } });
			}
		}));
		const pending = kind === "summary"
			? service.getSummary({ requestId: `revision-${kind}` })
			: kind === "usage"
				? service.queryUsage({ requestId: `revision-${kind}` })
				: service.queryCollection({ requestId: `revision-${kind}`, collection: "models" });
		await Promise.resolve();
		tokens = 999;
		service.notifyChanged();
		late.resolve(usage({ totals: { tokens: 1 } }));
		await assert.rejects(pending, errorCode("STALE"), kind);
		assert.equal(service.current().revision, 2, kind);
		assert.equal(service.current().totals.selected.tokens, 999, kind);
		await service.dispose();
	}

	const configuration = Promise.withResolvers();
	let tokens = 120;
	const configured = new TokenLedgerService(implementation({
		readUsage: () => usage({ totals: { tokens } }),
		readConfiguration: () => configuration.promise
	}));
	const pending = configured.getConfiguration({ requestId: "revision-configuration" });
	await Promise.resolve();
	tokens = 999;
	configured.notifyChanged();
	configuration.resolve({ settings: { available: true } });
	await assert.rejects(pending, errorCode("STALE"));
	await configured.dispose();
});

test("non-mutating async actions reject data read across a newer revision", async () => {
	const late = Promise.withResolvers();
	const started = Promise.withResolvers();
	let tokens = 120;
	const service = new TokenLedgerService(implementation({
		readUsage: () => usage({ totals: { tokens } }),
		runAction: () => {
			started.resolve();
			return late.promise;
		}
	}));
	const pending = service.execute({ requestId: "late-balance", action: { type: "balance.refresh" } });
	await started.promise;
	tokens = 999;
	service.notifyChanged();
	late.resolve({ ok: true, changed: false, data: { fetched: true } });
	await assert.rejects(pending, errorCode("STALE"));
	await service.dispose();
});

test("request options, action input, and action results never invoke accessors or proxies", async () => {
	let invoked = false;
	const unsafeAction = { type: "usage.export" };
	Object.defineProperty(unsafeAction, "format", {
		enumerable: true,
		get() {
			invoked = true;
			return "json";
		}
	});
	const service = new TokenLedgerService(implementation());
	assert.throws(
		() => service.execute({ requestId: "unsafe-action", action: unsafeAction }),
		errorCode("INVALID_REQUEST")
	);
	const options = {};
	Object.defineProperty(options, "signal", {
		enumerable: true,
		get() {
			invoked = true;
			return new AbortController().signal;
		}
	});
	await service.queryUsage({ requestId: "safe-options" }, options);
	assert.equal(invoked, false);
	await service.dispose();

	const unsafeResult = { ok: true };
	Object.defineProperty(unsafeResult, "changed", {
		enumerable: true,
		get() {
			invoked = true;
			return false;
		}
	});
	const hostile = new TokenLedgerService(implementation({ runAction: async () => unsafeResult }));
	const omittedAccessor = await hostile.execute({ requestId: "unsafe-result", action: { type: "usage.refresh" } });
	assert.equal(omittedAccessor.status, "applied");
	assert.equal(invoked, false);
	await hostile.dispose();

	const traps = { count: 0 };
	const proxy = new Proxy({}, {
		get() {
			traps.count += 1;
			throw new Error("must not run");
		},
		getOwnPropertyDescriptor() {
			traps.count += 1;
			throw new Error("must not run");
		}
	});
	const proxied = new TokenLedgerService(implementation({ readConfiguration: () => proxy }));
	const result = await proxied.getConfiguration({ requestId: "proxy-configuration" });
	assert.equal(result.value.boundaryTruncated, true);
	assert.equal(result.value.boundaryOmissions[0].kind, "proxy");
	assert.equal(traps.count, 0);
	await proxied.dispose();
});

test("action resource budgets reject hostile structure before structured cloning", async () => {
	let runs = 0;
	const service = new TokenLedgerService(implementation({
		runAction: async () => {
			runs += 1;
			return { ok: true, changed: false };
		}
	}));
	const hugeSparse = [];
	hugeSparse.length = 2 ** 32 - 1;
	const manyKeys = Object.fromEntries(Array.from({ length: 9_000 }, (_, index) => [`key${String(index)}`, 0]));
	const dense = Array.from({ length: 8_192 }, () => 0);
	for (const [requestId, payload] of [
		["action-array-length", hugeSparse],
		["action-key-budget", manyKeys],
		["action-node-budget", dense],
		["action-text-budget", "界".repeat(64 * 1_024)]
	]) {
		assert.throws(
			() => service.execute({ requestId, action: { type: "usage.refresh", payload } }),
			errorCode("INVALID_REQUEST"),
			requestId
		);
	}
	assert.equal(runs, 0);
	await service.dispose();
});

test("actions are serialized, revision-fenced, and publish committed changes", async () => {
	let total = 120;
	let active = 0;
	let peak = 0;
	const order = [];
	const service = new TokenLedgerService(implementation({
		readUsage: () => usage({ totals: { tokens: total } }),
		runAction: async (action, { commit }) => {
			active++;
			peak = Math.max(peak, active);
			order.push(`start:${action.type}`);
			await new Promise((resolve) => setImmediate(resolve));
			commit(() => void (total += 1));
			active--;
			order.push(`end:${action.type}`);
			return { ok: true, changed: true, message: "done", data: { token: "hidden", total } };
		}
	}));

	await assert.rejects(
		service.execute({ requestId: "stale", expectedRevision: 99, action: { type: "usage.refresh" } }),
		errorCode("STALE")
	);
	const [first, second] = await Promise.all([
		service.execute({ requestId: "first", expectedRevision: 1, action: { type: "usage.refresh" } }),
		service.execute({ requestId: "second", action: { type: "index.rebuild" } })
	]);

	assert.equal(peak, 1);
	assert.deepEqual(order, ["start:usage.refresh", "end:usage.refresh", "start:index.rebuild", "end:index.rebuild"]);
	assert.equal(first.revision, 2);
	assert.equal(second.revision, 3);
	assert.equal(JSON.stringify([first, second]).includes("hidden"), false);
	assertDeepFrozen(second);
	await service.dispose();
});

test("action input and expected revision are captured before queued work runs", async () => {
	let received;
	const service = new TokenLedgerService(implementation({
		runAction: async (action) => {
			received = action;
			return { ok: true, changed: false, data: { format: action.format, content: "[]" } };
		}
	}));
	const action = { type: "usage.export", format: "json" };
	const request = { requestId: "captured", expectedRevision: 1, action };
	const pending = service.execute(request);
	action.format = "csv";
	request.expectedRevision = 99;
	const result = await pending;

	assert.equal(received.format, "json");
	assert.equal(Object.isFrozen(received), true);
	assert.equal(result.data.format, "json");
	await service.dispose();
});

test("a newer request with the same id rejects the older result as stale", async () => {
	const slow = Promise.withResolvers();
	let reads = 0;
	const service = new TokenLedgerService(implementation({
		readUsage: () => {
			reads++;
			if (reads === 1) return usage();
			if (reads === 2) return slow.promise;
			return usage({ totals: { tokens: 999 } });
		}
	}));
	const older = service.getSummary({ requestId: "replace-me" });
	const olderRejected = assert.rejects(older, errorCode("STALE"));
	await Promise.resolve();
	const newer = service.getSummary({ requestId: "replace-me" });
	await newer;
	await olderRejected;
	slow.resolve(usage({ totals: { tokens: 1 } }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(service.current().totals.selected.tokens, 999);
	await service.dispose();
});

test("abort before commit rejects the action without publishing", async () => {
	const gate = Promise.withResolvers();
	const started = Promise.withResolvers();
	let mutated = false;
	const service = new TokenLedgerService(implementation({
		runAction: async (_action, { commit }) => {
			started.resolve();
			await gate.promise;
			commit(() => void (mutated = true));
			return { ok: true, changed: true };
		}
	}));
	const abort = new AbortController();
	const pending = service.execute({ requestId: "abort", action: { type: "index.rebuild" } }, { signal: abort.signal });
	await started.promise;
	abort.abort();
	await assert.rejects(pending, errorCode("ABORTED"));
	gate.resolve();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(mutated, false);
	assert.equal(service.current().revision, 1);
	await service.dispose();
});

test("dispose fences an uncooperative late read and never republishes it", async () => {
	const late = Promise.withResolvers();
	let reads = 0;
	let disposed = false;
	const service = new TokenLedgerService(implementation({
		readUsage: () => (++reads === 1 ? usage() : late.promise),
		dispose: async () => void (disposed = true)
	}));
	const seen = [];
	service.subscribe((snapshot) => seen.push(snapshot));
	const pending = service.getSummary({ requestId: "late" });
	await service.dispose();
	await assert.rejects(pending, (error) => error.code === "ABORTED" || error.code === "UNAVAILABLE");
	late.resolve(usage({ totals: { tokens: 999 } }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(disposed, true);
	assert.deepEqual(seen.map((snapshot) => snapshot.revision), [1]);
	assert.equal(service.current().totals.selected.tokens, 120);
	assert.throws(() => service.subscribe(() => {}), errorCode("UNAVAILABLE"));
});

test("invalid request and oversized export failures have stable codes", async () => {
	const service = new TokenLedgerService(implementation({
		runAction: async () => ({ ok: true, changed: false, data: { format: "csv", content: "x".repeat(1024 * 1024 + 1) } })
	}));
	assert.throws(() => service.getSummary({}), errorCode("INVALID_REQUEST"));
	assert.throws(
		() => service.execute({ requestId: "unknown", action: { type: "unknown" } }),
		errorCode("INVALID_REQUEST")
	);
	assert.throws(
		() => service.execute({ requestId: "bad-revision", expectedRevision: 0, action: { type: "usage.refresh" } }),
		errorCode("INVALID_REQUEST")
	);
	const preAborted = new AbortController();
	preAborted.abort();
	await assert.rejects(
		service.getSummary({ requestId: "pre-aborted" }, { signal: preAborted.signal }),
		errorCode("ABORTED")
	);
	await assert.rejects(
		service.execute({ requestId: "export", action: { type: "usage.export" } }),
		errorCode("RESULT_TOO_LARGE")
	);
	await service.dispose();

	const failing = new TokenLedgerService(implementation({
		runAction: async () => {
			throw new Error("provider retained top-secret");
		}
	}));
	await assert.rejects(
		failing.execute({ requestId: "failure", action: { type: "usage.refresh" } }),
		(error) => error.code === "INTERNAL" && error.cause === undefined && !error.message.includes("top-secret")
	);
	await failing.dispose();
});
