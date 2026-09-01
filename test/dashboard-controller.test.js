/** Internal Blue dashboard controller behavior. */

import assert from "node:assert/strict";
import test from "node:test";

import { DashboardController } from "../src/dashboard-controller.js";

function usage(tokens = 100, count = 300) {
	return {
		version: "fixture",
		generatedAt: Date.now(),
		timeZone: { id: "UTC" },
		range: {},
		totals: { tokens, requests: 1 },
		windows: { today: { tokens }, month: { tokens }, all: { tokens } },
		days: [],
		activity: [],
		activityModels: [],
		models: Array.from({ length: count }, (_, index) => ({ model: `model-${String(index)}`, tokens: count - index })),
		sites: [],
		projects: [],
		providers: [],
		directory: [],
		accounts: [],
		diagnostics: {},
		priced: null
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => void (resolve = done));
	return { promise, resolve };
}

test("controller bounds initial views and pages the complete local collection", async () => {
	const controller = new DashboardController({ readUsage: () => usage() });
	assert.equal(controller.current().models.length, 64);
	assert.deepEqual(controller.current().collectionBounds.models, {
		sourceCount: 300,
		returnedCount: 256,
		omittedCount: 44
	});

	const view = await controller.queryUsage({ range: {} });
	assert.equal(view.value.models.length, 256);
	assert.equal(view.value.boundaryTruncated, true);
	const page = await controller.queryCollection({
		collection: "models",
		offset: 8,
		limit: 8,
		sortBy: "tokens",
		direction: "asc",
		expectedRevision: view.revision
	});
	assert.equal(page.value.returnedCount, 8);
	assert.equal(page.value.sourceCount, 300);
	assert.equal(page.value.items[0].tokens, 9);
	await controller.dispose();
});

test("refresh publishes one new revision while balance remains readonly", async () => {
	let tokens = 100;
	const revisions = [];
	const controller = new DashboardController({
		readUsage: () => usage(tokens, 1),
		refresh: async () => void (tokens = 200),
		readBalance: async () => ({ total: 12.5, currency: "CNY" })
	});
	controller.subscribe((snapshot) => revisions.push(snapshot.revision));
	const first = controller.current().revision;
	const refreshed = await controller.execute({
		requestId: "refresh",
		expectedRevision: first,
		action: { type: "usage.refresh" }
	});
	assert.equal(refreshed.revision, first + 1);
	assert.equal(refreshed.snapshot.totals.all.tokens, 200);
	const balance = await controller.execute({
		requestId: "balance",
		expectedRevision: refreshed.revision,
		action: { type: "balance.refresh", accountId: "fixture" }
	});
	assert.equal(balance.revision, refreshed.revision);
	assert.equal(balance.data.total, 12.5);
	assert.deepEqual(revisions, [first, first + 1]);
	await controller.dispose();
});

test("late asynchronous reads are rejected after abort or revision advance", async () => {
	let wait;
	let asynchronous = false;
	const controller = new DashboardController({ readUsage: () => asynchronous ? wait.promise : usage(100, 1) });
	wait = deferred();
	asynchronous = true;
	const abort = new AbortController();
	const aborted = controller.queryUsage({ range: {} }, { signal: abort.signal });
	abort.abort();
	wait.resolve(usage(200, 1));
	await assert.rejects(aborted, (error) => error.code === "ABORTED");

	wait = deferred();
	const stale = controller.queryUsage({ range: {} });
	asynchronous = false;
	wait.resolve(usage(300, 1));
	controller.notifyChanged(true);
	await assert.rejects(stale, (error) => error.code === "STALE");
	await controller.dispose();
});
