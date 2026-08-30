/**
 * The New API personal-wallet reader.
 *
 * The wire shape below is what a live site answered (`/api/user/self` with a
 * system access token and `New-Api-User`): `data.quota` remaining and
 * `data.used_quota` spent, both internal integers divided by the site's own
 * `quota_per_unit`, with the unit the site itself displays.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	BASE_TTL_MS,
	MIN_BACKOFF_MS,
	createNewApiWalletReader,
	readNewApiWallet,
	shouldUseWallet,
	unitFromStatus,
	forgetWallet
} from "../src/newapi-user.js";

/** A fetch that answers by URL substring, remembering every call and header. */
const recorder = (routes) => {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url, headers: init?.headers });
		for (const [needle, answer] of routes) {
			if (url.includes(needle)) return typeof answer === "function" ? answer(url, init, calls.length) : answer;
		}
		throw new Error(`unexpected ${url}`);
	};
	return { calls, fetch };
};

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

// Every test gets its own origin: the wallet cache is per origin and lives at
// module scope, so a shared origin would let one test's cache answer another
// test's read with zero requests — passing for the wrong reason.
let originSeq = 0;
const site = () => `https://site-${++originSeq}.example`;
const selfBody = {
	success: true,
	data: {
		id: 42,
		username: "someone",
		display_name: "someone",
		quota: 20000000,
		used_quota: 90000000,
		request_count: 42
	}
};
const statusBody = {
	success: true,
	data: { quota_per_unit: 500000, quota_display_type: "CNY", display_in_currency: true }
};

test("the wallet reads user/self with both console headers and the site's own unit", async () => {
	const origin = site();
	const { calls, fetch } = recorder([
		["/api/user/self", okJson(selfBody)],
		["/api/status", okJson(statusBody)]
	]);
	const card = await readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: 1_000 });

	const walletCall = calls.find((c) => c.url === `${origin}/api/user/self`);
	assert.notEqual(walletCall, undefined);
	assert.equal(walletCall.headers.authorization, "Bearer tok");
	assert.equal(walletCall.headers["new-api-user"], "42", "New API identifies the caller by id, not by the token alone");
	assert.equal(walletCall.url.includes("tok"), false, "the token rides a header, never a query string");

	// 20000000 / 500000 and 90000000 / 500000, in the unit the site displays.
	assert.equal(card.total, 40);
	assert.equal(card.used, 180);
	assert.equal(card.granted, 220);
	assert.equal(card.currency, "CNY");
	assert.equal(card.keyName, "someone");
	assert.equal(card.isAvailable, true);
	assert.equal(card.scheme, "newapi");
	assert.equal(card.userToken, true);
	// The flags the panel keys success off — a success card without `fetched`
	// is rendered as a refusal with an empty reason, which is exactly the bug
	// this assertion exists to keep dead.
	assert.equal(card.supported, true);
	assert.equal(card.fetched, true);
});

test("a fork that reports the spent figure in money wins over the internal counter", async () => {
	const { fetch } = recorder([
		["/api/user/self", okJson({ success: true, data: { quota: 100, used: 123.456789 } })],
		["/api/status", okJson({ success: true, data: { quota_per_unit: 500000, quota_display_type: "CNY" } })]
	]);
	const card = await readNewApiWallet({ origin: "https://fork.example", userId: 5, token: "t", fetch, now: 1_000 });
	assert.equal(card.used, 123.456789);
});

test("a fresh cache answers with no request at all — the panel opens instantly", async () => {
	const origin = site();
	const { calls, fetch } = recorder([
		["/api/user/self", okJson(selfBody)],
		["/api/status", okJson(statusBody)]
	]);
	await readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: 1_000 });
	const again = await readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: 1_000 + BASE_TTL_MS - 1 });

	assert.equal(calls.length, 2, "one status + one wallet, nothing more");
	assert.equal(again.cached, true);
	assert.equal(again.total, 40);
});

test("plugin-owned wallet readers do not share cache state", async () => {
	const origin = site();
	const { calls, fetch } = recorder([
		["/api/user/self", okJson(selfBody)],
		["/api/status", okJson(statusBody)]
	]);
	const first = createNewApiWalletReader();
	const second = createNewApiWalletReader();
	await first.read({ origin, userId: 42, token: "tok", fetch, now: 1_000 });
	await first.read({ origin, userId: 42, token: "tok", fetch, now: 2_000 });
	assert.equal(calls.length, 2, "one reader reuses its own status and wallet cache");
	await second.read({ origin, userId: 42, token: "tok", fetch, now: 2_000 });
	assert.equal(calls.length, 4, "a second plugin instance starts with an empty cache");
	assert.equal(first.snapshot().length, 1);
	assert.equal(first.snapshot()[0].state, undefined, "diagnostics never expose the wallet value");
	first.dispose();
	assert.equal(first.snapshot().length, 0);
	await assert.rejects(first.read({ origin, userId: 42, token: "tok", fetch }), (error) => error.kind === "aborted");
	second.dispose();
});

test("an external AbortSignal cancels a wallet read without filling the cache", async () => {
	const reader = createNewApiWalletReader();
	const abort = new AbortController();
	const fetch = async (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
		});
	const pending = reader.read({ origin: site(), userId: 42, token: "tok", fetch, signal: abort.signal });
	abort.abort();
	await assert.rejects(pending, (error) => error.kind === "aborted");
	assert.deepEqual(reader.snapshot(), []);
	reader.dispose();
});

test("disposing a reader rejects and clears an uncooperative late result", async () => {
	const reader = createNewApiWalletReader();
	const gate = Promise.withResolvers();
	const fetch = async (url) => {
		await gate.promise;
		return url.includes("/api/status") ? okJson(statusBody) : okJson(selfBody);
	};
	const pending = reader.read({ origin: site(), userId: 42, token: "tok", fetch });
	reader.dispose();
	gate.resolve();
	await assert.rejects(pending, (error) => error.kind === "aborted");
	assert.deepEqual(reader.snapshot(), [], "a late response cannot repopulate a disposed instance");
});

test("force skips the freshness window but never a backoff", async () => {
	const origin = site();
	// A first read succeeds; a force inside the TTL goes back to the network.
	const { calls, fetch } = recorder([
		["/api/user/self", okJson(selfBody)],
		["/api/status", okJson(statusBody)]
	]);
	await readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: 1_000 });
	await readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: 2_000, force: true });
	assert.ok(calls.length >= 3, "the forced read went out");
});

test("a throttle serves the previous card with a small-print flag, then backs off adaptively", async () => {
	const origin = "https://throttled.example";
	try {
		let limited = false;
		const { calls, fetch } = recorder([
			["/api/user/self", () => (limited ? { ok: false, status: 429, json: async () => ({}) } : okJson(selfBody))],
			["/api/status", okJson(statusBody)]
		]);

		const first = await readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: 0 });
		assert.equal(first.cached, false);

		limited = true;
		const stale = await readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: BASE_TTL_MS + 1 });
		assert.equal(stale.stale, true, "the previous result is what the card shows");
		assert.equal(stale.total, 40);
		assert.equal(stale.retryAt, BASE_TTL_MS + 1 + MIN_BACKOFF_MS, "the first backoff is the throttle's own interval");

		// Inside the backoff: no request, same card, same retryAt.
		const within = await readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: BASE_TTL_MS + 2 });
		const callsAfterRefusal = calls.length;
		assert.equal(within.stale, true);
		assert.equal(calls.length, callsAfterRefusal, "a backoff never becomes a request");

		// Past the first backoff the read goes out and is refused AGAIN — the
		// backoff doubles rather than restarting.
		const doubled = await readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: stale.retryAt + 1, force: true });
		assert.equal(doubled.retryAt, stale.retryAt + 1 + MIN_BACKOFF_MS * 2);
	} finally {
		forgetWallet(origin);
	}
});

test("a throttle with no previous card throws, carrying the retry instant", async () => {
	const origin = "https://limited-first.example";
	try {
		const { fetch } = recorder([
			["/api/user/self", { ok: false, status: 429, json: async () => ({}) }],
			["/api/status", okJson(statusBody)]
		]);
		await assert.rejects(
			readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: 0 }),
			(error) => error.kind === "rate-limited" && error.retryAt === MIN_BACKOFF_MS
		);
	} finally {
		forgetWallet(origin);
	}
});

test("a refusal dressed as success:false is an auth failure unless it names the throttle", async () => {
	const origin = "https://envelope.example";
	try {
		const { fetch } = recorder([
			["/api/user/self", okJson({ success: false, message: "无权进行此操作，未登录且未提供 access token" })],
			["/api/status", okJson(statusBody)]
		]);
		await assert.rejects(
			readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: 0 }),
			(error) => error.kind === "upstream-auth"
		);

		const { fetch: limitFetch } = recorder([
			["/api/user/self", okJson({ success: false, message: "查询次数已达上限" })],
			["/api/status", okJson(statusBody)]
		]);
		await assert.rejects(
			readNewApiWallet({ origin, userId: 42, token: "tok", fetch: limitFetch, now: 0 }),
			(error) => error.kind === "rate-limited"
		);
	} finally {
		forgetWallet(origin);
	}
});

test("a bad token answered with a real 401 says so", async () => {
	const origin = "https://real-401.example";
	try {
		const { fetch } = recorder([
			["/api/user/self", { ok: false, status: 401, json: async () => ({}) }],
			["/api/status", okJson(statusBody)]
		]);
		await assert.rejects(
			readNewApiWallet({ origin, userId: 42, token: "tok", fetch, now: 0 }),
			(error) => error.kind === "upstream-auth" && error.status === 401
		);
	} finally {
		forgetWallet(origin);
	}
});

test("a site that names no unit still gets a wallet, without a borrowed symbol", async () => {
	const { fetch } = recorder([
		["/api/user/self", okJson(selfBody)],
		["/api/status", okJson({ success: true, data: { quota_per_unit: 500000 } })]
	]);
	const card = await readNewApiWallet({ origin: "https://unitless.example", userId: 42, token: "tok", fetch, now: 1_000 });
	assert.equal(card.total, 40);
	assert.equal(card.currency, undefined, "a number under a guessed symbol is worse than a number under none");
});

test("unitFromStatus reads the site's own display currency", () => {
	assert.deepEqual(unitFromStatus({ quota_per_unit: 500000, quota_display_type: "CNY" }), {
		currency: "CNY",
		perUnit: 500000
	});
	assert.deepEqual(unitFromStatus({ quota_per_unit: 500000, quota_display_type: "USD" }).currency, "USD");
	// A fork's custom symbol is honoured when it is a real one; "¤" is the
	// framework's placeholder and means nothing.
	assert.equal(unitFromStatus({ quota_display_type: "custom", custom_currency_symbol: "¤" }).currency, undefined);
	assert.equal(unitFromStatus({}).perUnit, 500000);
});

test("shouldUseWallet: credentials decide, known non-New-API vendors keep their reader", () => {
	const account = { origin: site(), scheme: "newapi" };
	assert.equal(shouldUseWallet(account, { userId: 42, token: "tok" }), true);
	assert.equal(shouldUseWallet({ ...account, scheme: undefined }, { userId: 42, token: "tok" }), true, "an undetected relay defers to the user's explicit setup");
	assert.equal(shouldUseWallet({ ...account, scheme: "zai" }, { userId: 42, token: "tok" }), false, "a known other vendor is never overridden");
	assert.equal(shouldUseWallet(account, { userId: 42, token: "" }), false);
	assert.equal(shouldUseWallet(account, { userId: 0, token: "tok" }), false);
	assert.equal(shouldUseWallet({ origin: "" }, { userId: 1, token: "tok" }), false);
	assert.equal(shouldUseWallet(account, undefined), false);
});
