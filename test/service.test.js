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
	TOKEN_LEDGER_SUMMARY_MAX_BYTES,
	TOKEN_LEDGER_VIEW_MAX_BYTES,
	TokenLedgerError,
	TokenLedgerService,
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
	assertDeepFrozen(view);
	assertDeepFrozen(summary);
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

test("range queries are bounded reads and do not advance the summary revision", async () => {
	const reads = [];
	const service = new TokenLedgerService(implementation({
		readUsage: (query) => {
			reads.push(query);
			return usage({ range: query.range, site: query.site });
		}
	}));
	const result = await service.queryUsage({
		requestId: "range",
		range: { from: "2026-08-01", to: "2026-08-30", ignored: "x" },
		site: " relay.example "
	});

	assert.deepEqual(reads.at(-1), { range: { from: "2026-08-01", to: "2026-08-30" }, site: "relay.example" });
	assert.equal(result.revision, 1);
	assert.equal(result.value.site, "relay.example");
	assert.equal(service.current().revision, 1);
	assertDeepFrozen(result);
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
