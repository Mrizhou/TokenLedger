/**
 * Account balances.
 *
 * The premise these tests were first written against was wrong: relay balances
 * were assumed to need administrator credentials. New API's per-request LOG
 * does; its balance does not. `GET /api/usage/token/` sits behind
 * `TokenAuthReadOnly`, so an ordinary `sk-` key reads that key's quota —
 * verified against New API's router source and against a live deployment.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	DESCRIBE_TTL_MS,
	SCHEMES,
	UNRECOGNIZED_RETRY_MS,
	createBalanceReader,
	deepSeekAccountClient,
	findAccount,
	mapAntigravityQuota,
	isOfficialDeepSeek,
	listAccounts,
	mapDeepSeekAccountWallets,
	readBalance,
	readDeepSeekAccountBalance,
	sectionReader
} from "../src/balance.js";

test("official is decided by origin, not by what the route is called", () => {
	// The same reason site attribution is: a route named `deepseek` may point at
	// a relay, and a route named anything may point at DeepSeek.
	assert.equal(isOfficialDeepSeek("https://api.deepseek.com/v1"), true);
	assert.equal(isOfficialDeepSeek("https://API.DeepSeek.com"), true);
	assert.equal(isOfficialDeepSeek(undefined), true, "no baseURL means the shipped default");
	assert.equal(isOfficialDeepSeek("https://api.relay-one.example/v1"), false);
	assert.equal(isOfficialDeepSeek("https://api.deepseek.com.evil.example"), false, "suffix must not match");
	assert.equal(isOfficialDeepSeek("not a url"), false);
});

test("every scheme answers the same shape, so one card renders all of them", () => {
	assert.deepEqual(Object.keys(SCHEMES).sort(), [
		"aliyun",
		"commandcode",
		"deepseek",
		"kimi",
		"mimo",
		"minimax",
		"moonshot",
		"newapi",
		"opencode-go",
		"openrouter",
		"sub2api",
		"zai"
	]);
	for (const [name, spec] of Object.entries(SCHEMES)) {
		// A typed-in balance (MiMo) and the 阿里云 billing center are read
		// outside the per-key path.
		if (spec.credential !== undefined) assert.equal(spec.read, undefined, name);
		else assert.equal(typeof spec.read, "function", name);
		assert.equal(typeof spec.label, "string", name);
		if (spec.envelope !== undefined) assert.equal(typeof spec.envelope, "function", name);
		if (spec.localCredential !== undefined) assert.equal(typeof spec.localCredential, "function", name);
	}
});

// --- the wire ----------------------------------------------------------------

const okJson = (body) => async () => ({ ok: true, json: async () => body });

test("the key rides an Authorization header, never a query string", async () => {
	let seen;
	await readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "sk-secret",
		fetch: async (url, init) => {
			seen = { url, init };
			return { ok: true, json: async () => ({ balance_infos: [] }) };
		}
	});
	assert.equal(seen.url.includes("sk-secret"), false, "a key in a URL leaks into history and proxy logs");
	assert.equal(seen.init.headers.authorization, "Bearer sk-secret");
});

test("no credential is reported as such, without a request", async () => {
	let called = 0;
	const result = await readBalance({ scheme: "newapi", origin: "https://r.example", fetch: async () => void called++ });
	assert.deepEqual(result, { supported: true, fetched: false, reason: "no-credential" });
	assert.equal(called, 0);
});

test("software nobody recognises is unsupported, not failed", async () => {
	assert.deepEqual(await readBalance({ scheme: "mystery", origin: "https://r.example", apiKey: "k" }), {
		supported: false,
		reason: "unknown-software"
	});
});

test("an http error and an unreachable host read differently", async () => {
	assert.equal(
		(await readBalance({ scheme: "deepseek", origin: "https://x.example", apiKey: "k", fetch: async () => ({ ok: false, status: 401 }) })).reason,
		"http-401"
	);
	assert.equal(
		(
			await readBalance({
				scheme: "deepseek",
				origin: "https://x.example",
				apiKey: "k",
				fetch: async () => {
					throw new Error("ECONNREFUSED");
				}
			})
		).reason,
		"unreachable"
	);
});

test("an external AbortSignal cancels the balance request distinctly from timeout", async () => {
	const abort = new AbortController();
	const pending = readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "sk-secret",
		signal: abort.signal,
		fetch: async (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
			})
	});
	abort.abort();
	assert.deepEqual(await pending, { supported: true, fetched: false, scheme: "deepseek", reason: "aborted" });
});

// --- per-vendor shapes -------------------------------------------------------

test("DeepSeek prefers CNY, and an unreported balance is absent rather than zero", async () => {
	// Zero is a balance. Absent is not knowing. Rendering the second as the
	// first tells someone their account is empty.
	const both = await readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "k",
		fetch: okJson({
			is_available: true,
			balance_infos: [
				{ currency: "USD", total_balance: "1.00" },
				{ currency: "CNY", total_balance: "36.44", granted_balance: "5.00" }
			]
		})
	});
	assert.equal(both.currency, "CNY");
	assert.equal(both.total, 36.44);
	assert.equal(both.granted, 5);

	const empty = await readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "k",
		fetch: okJson({ is_available: true, balance_infos: [] })
	});
	assert.equal(empty.total, undefined);
	assert.equal(empty.currency, undefined);
});

test("New API converts quota to money using the site's own divisor", async () => {
	// Quota is an internal integer and the same figure means different money at
	// different relays, so the conversion has to come from that site.
	const calls = [];
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "sk-k",
		fetch: async (url, init) => {
			calls.push({ url, auth: init.headers.authorization });
			if (url.includes("/api/status")) {
				return { ok: true, json: async () => ({ data: { quota_per_unit: 500000, price: 2 } }) };
			}
			return {
				ok: true,
				json: async () => ({
					data: { total_granted: 5_000_000, total_used: 1_000_000, total_available: 4_000_000, unlimited_quota: false }
				})
			};
		}
	});
	// 4,000,000 quota / 500,000 per unit = 8 USD. `price` is the local cost of
	// one unit at top-up, not the unit the quota is denominated in.
	assert.equal(result.total, 8);
	assert.equal(result.granted, 10);
	assert.equal(result.used, 2);
	assert.equal(result.currency, "USD");
	// The raw quota survives beside the money, for a site that publishes no units.
	assert.deepEqual(result.quota, { granted: 5_000_000, used: 1_000_000, available: 4_000_000 });

	assert.ok(calls[0].url.endsWith("/api/usage/token/"), "the trailing slash matters: without it New API answers 301");
	assert.equal(calls[0].auth, "Bearer sk-k");
	// `/api/status` is public; sending the key there would be gratuitous.
	assert.equal(calls[1].auth, undefined);
});

test("a New API site that publishes no units still reports its quota", async () => {
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: async (url) => {
			if (url.includes("/api/status")) throw new Error("nope");
			return { ok: true, json: async () => ({ data: { total_available: 4_000_000, total_granted: 4_000_000 } }) };
		}
	});
	assert.equal(result.total, undefined, "money is unknowable without the site's scale");
	assert.equal(result.quota.available, 4_000_000, "but the quota itself is not");
});

test("an unlimited New API key reads as available even at zero remaining", async () => {
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: okJson({ data: { total_available: 0, unlimited_quota: true } })
	});
	assert.equal(result.unlimited, true);
	assert.equal(result.isAvailable, true);
});

// --- Sub2API's three shapes ----------------------------------------------------
//
// `/v1/usage` answers in one of three shapes and only ONE of them carries a
// `balance`. Read off the gateway's own handler rather than inferred from a
// sample: `quota_limited` when the key has a total quota or rate limits,
// `unrestricted` with a `subscription` object when the key's group is a plan,
// and `unrestricted` with a `balance` for a plain wallet.

const sub2api = (body) => readBalance({ scheme: "sub2api", origin: "https://s.example", apiKey: "k", fetch: okJson(body) });

test("Sub2API's wallet shape reads as a wallet", async () => {
	const result = await sub2api({
		mode: "unrestricted",
		isValid: true,
		planName: "钱包余额",
		remaining: 4.768,
		unit: "USD",
		balance: 4.768
	});
	assert.equal(result.total, 4.768);
	assert.equal(result.currency, "USD");
	assert.equal(result.isAvailable, true);
	// The wallet shape sends a `planName` too, and it is a placeholder. Showing
	// it produces a card claiming the account is on a plan called "wallet".
	assert.equal(result.plan, undefined);
	assert.equal("windows" in result, false);
});

test("a quota-limited key reports its quota and every configured window", async () => {
	const result = await sub2api({
		mode: "quota_limited",
		isValid: true,
		status: "active",
		quota: { limit: 20, used: 8, remaining: 12, unit: "USD" },
		remaining: 12,
		unit: "USD",
		rate_limits: [
			{ window: "5h", limit: 100, used: 4, remaining: 96, reset_at: "2026-08-17T17:00:00Z" },
			{ window: "1d", limit: 400, used: 200, remaining: 200 },
			{ window: "7d", limit: 1000, used: 100, remaining: 900, reset_at: "2026-08-21T00:00:00Z" }
		]
	});
	assert.equal(result.total, 12, "remaining quota is the balance");
	assert.equal(result.granted, 20);
	assert.equal(result.used, 8);
	assert.deepEqual(result.windows, [
		{ kind: "session", minutes: 300, usedPercent: 4, resetsAt: "2026-08-17T17:00:00.000Z" },
		{ kind: "daily", usedPercent: 50 },
		{ kind: "weekly", usedPercent: 10, resetsAt: "2026-08-21T00:00:00.000Z" }
	]);
});

test("a lapsed window sends no reset_at, and none is invented", async () => {
	// The gateway omits it once the window has expired — the next request opens
	// a fresh one, so there is no instant to show.
	const result = await sub2api({
		mode: "quota_limited",
		isValid: true,
		rate_limits: [{ window: "5h", limit: 100, used: 0, remaining: 100, window_start: null }]
	});
	assert.equal("resetsAt" in result.windows[0], false);
});

test("a subscription key reports its periods, which is where its numbers live", async () => {
	// This shape has no `balance` at all. The previous reader looked for one,
	// found nothing, and rendered a card with nothing on it.
	const result = await sub2api({
		mode: "unrestricted",
		isValid: true,
		planName: "Claude 拼车 Pro",
		unit: "USD",
		remaining: 3.5,
		subscription: {
			daily_usage_usd: 1.5,
			weekly_usage_usd: 12,
			monthly_usage_usd: 30,
			daily_limit_usd: 5,
			weekly_limit_usd: 30,
			monthly_limit_usd: null,
			weekly_window_start: "2026-08-14T00:00:00Z",
			expires_at: "2026-09-01T00:00:00Z"
		}
	});
	assert.equal(result.plan, "Claude 拼车 Pro");
	assert.equal(result.total, 3.5);
	assert.deepEqual(result.windows, [
		{ kind: "daily", usedPercent: 30 },
		// The gateway reports when the window OPENED; the panel asks when it
		// frees up.
		{ kind: "weekly", usedPercent: 40, resetsAt: "2026-08-21T00:00:00.000Z" }
	]);
	assert.equal(result.windows.some((w) => w.kind === "monthly"), false, "an uncapped period is not a window at zero");
});

test("a subscription with no period caps is unlimited, not minus one dollar", async () => {
	// The gateway returns -1 for "no limit is configured anywhere". Rendered as
	// money that is a negative figure meaning nothing.
	const result = await sub2api({
		mode: "unrestricted",
		isValid: true,
		planName: "内部",
		unit: "USD",
		remaining: -1,
		subscription: { daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null }
	});
	assert.equal(result.unlimited, true);
	assert.equal(result.total, undefined);
	assert.equal("windows" in result, false);
});

test("a key that is out of quota is not an available account", async () => {
	// `isValid` stays true for exhausted and expired keys — upstream means "we
	// recognise this key", not "you can spend on it".
	for (const status of ["quota_exhausted", "expired", "disabled"]) {
		const result = await sub2api({ mode: "quota_limited", isValid: true, status, quota: { limit: 20, used: 20, remaining: 0 } });
		assert.equal(result.isAvailable, false, status);
	}
	const active = await sub2api({ mode: "quota_limited", isValid: true, status: "active", quota: { limit: 20, used: 1, remaining: 19 } });
	assert.equal(active.isAvailable, true);
});

test("a window the gateway names something we do not know is dropped, not guessed", async () => {
	const result = await sub2api({
		mode: "quota_limited",
		isValid: true,
		rate_limits: [{ window: "30d", limit: 10, used: 1 }, { window: "5h", limit: 10, used: 1 }]
	});
	assert.deepEqual(result.windows.map((w) => w.kind), ["session"]);
});

// --- reaching the host -------------------------------------------------------

const piAi = (route) => ({ provider: route, settingsNs: "llm-pi-ai", settingsPath: ["providers", route] });

const ctxWith = (providers, section, credentials, services) => ({
	get: (name) =>
		name === "llm"
			? { listConfigurableProviders: () => providers }
			: name === "settings"
				? { get: () => section }
				: name === "credentials"
					? credentials
					: services?.[name]
});

test("the account list carries no keys and makes no requests", () => {
	const accounts = listAccounts(
		ctxWith([piAi("official"), piAi("api99")], {
			providers: {
				official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DS_KEY" },
				api99: { baseURL: "https://api.relay-one.example/v1", apiKeyEnv: "RELAY_KEY" }
			}
		})
	);
	assert.deepEqual(accounts.map((a) => a.displayName), ["DeepSeek", "api.relay-one.example"]);
	assert.deepEqual(accounts.map((a) => a.scheme), ["deepseek", undefined]);
	assert.deepEqual(accounts.map((a) => a.hasCredential), [true, true]);
	assert.equal(JSON.stringify(accounts).includes("DS_KEY"), false, "the reference is not the key, but it is still not needed here");
});

test("two keys on one relay are two quotas, and are listed as two", () => {
	// A relay's quota is scoped to the KEY: New API's /api/usage/token/ and
	// Sub2API's /v1/usage both answer for whichever key asked. Collapsing them
	// by host showed one key's spend under the site's name and hid the other.
	const accounts = listAccounts(
		ctxWith([piAi("gpt"), piAi("claude")], {
			providers: {
				gpt: { baseURL: "https://api.relay-one.example/v1" },
				claude: { baseURL: "https://api.relay-one.example/v2" }
			}
		})
	);
	assert.equal(accounts.length, 2);
	// And the picker must be able to tell them apart, which the bare host cannot.
	assert.deepEqual(accounts.map((a) => a.displayName), ["api.relay-one.example · gpt", "api.relay-one.example · claude"]);
});

test("a single key on a relay is labelled by host alone", () => {
	const accounts = listAccounts(
		ctxWith([piAi("api99")], { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } })
	);
	assert.deepEqual(accounts.map((a) => a.displayName), ["api.relay-one.example"], "no route suffix when it adds nothing");
});

test("DeepSeek is still collapsed, because there the account is the unit", () => {
	// Its balance is an account fact, not a key fact — every key spends the same
	// wallet, so two routes to it are one card.
	const accounts = listAccounts(
		ctxWith([piAi("ds1"), piAi("ds2")], {
			providers: {
				ds1: { baseURL: "https://api.deepseek.com" },
				ds2: { baseURL: "https://api.deepseek.com" }
			}
		})
	);
	assert.equal(accounts.length, 1);
});

test("a route folded into a vendor card still finds that card", async () => {
	// The sidebar asks by the route the session's model sits on. A DeepSeek
	// card keeps ONE route's id, so asking by the other one — 0.1.7's keyless
	// `deepseek-account` beside the keyed route — read "unknown-account" and
	// the sidebar showed nothing for the default model.
	const ctx = ctxWith(
		[piAi("deepseek-account"), piAi("official"), piAi("api99")],
		{
			providers: {
				"deepseek-account": { baseURL: "https://api.deepseek.com" },
				official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_KEY" },
				api99: { baseURL: "https://api.relay-one.example/v1", apiKeyEnv: "K" }
			}
		},
		undefined,
		{ deepseekAccount: signedIn(ACCOUNT_WALLETS) }
	);
	const accounts = listAccounts(ctx);
	assert.equal(accounts.length, 2);
	assert.equal(accounts[0].id, "official", "the keyed route still takes the card");
	assert.deepEqual([...accounts[0].routes].sort(), ["deepseek-account", "official"]);
	assert.equal(findAccount(accounts, "deepseek-account"), accounts[0]);
	assert.equal(findAccount(accounts, "api99").id, "api99");
	assert.equal(findAccount(accounts, undefined), accounts[0], "no id is still the first card");
	assert.equal(findAccount(accounts, "nope"), undefined);

	const result = await createBalanceReader(ctx, { fetch: async () => assert.fail("no request") })("deepseek-account");
	assert.equal(result.fetched, true);
	assert.equal(result.account, "official");
	assert.equal(result.total, 49.8913457);
});

// --- Antigravity --------------------------------------------------------------

/** `antigravityAuth.usage()`'s normalized answer, as `dsh-antigravity-auth` 0.1.4-rc.5 returns it. */
const ANTIGRAVITY_USAGE = {
	state: "available",
	checkedAt: "2026-10-04T08:00:00.000Z",
	groups: [
		{
			group: "gemini",
			modelCount: 2,
			windows: [
				{ window: "5h", remainingFraction: 0.6, resetTime: "2026-10-04T12:00:00.000Z" },
				{ window: "weekly", remainingFraction: 0.85, resetTime: "2026-10-10T00:00:00.000Z" }
			]
		},
		{ group: "non-gemini", modelCount: 3, windows: [{ window: "5h", remainingFraction: 0, resetTime: "2026-10-04T10:00:00.000Z" }] }
	]
};

test("the Antigravity adapter's route is an account when its plugin is mounted", async () => {
	// The route is registered as an ADAPTER, so the configurable directory
	// never lists it — before this it had no account and its quota showed
	// nowhere. The quota is read through the plugin's own service: the OAuth
	// token never leaves it, and nothing here talks to Google.
	const calls = [];
	const service = { usage: async (signal, force) => (calls.push(force), ANTIGRAVITY_USAGE) };
	const ctx = ctxWith(
		[piAi("official")],
		{ providers: { official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "K" } } },
		undefined,
		{ antigravityAuth: service }
	);
	const accounts = listAccounts(ctx);
	const account = accounts.find((a) => a.id === "google-antigravity");
	assert.ok(account, `not listed: ${accounts.map((a) => a.id)}`);
	assert.equal(account.displayName, "Antigravity");
	assert.equal(account.scheme, "antigravity");

	const read = createBalanceReader(ctx, { fetch: async () => assert.fail("no request of our own") });
	const result = await read("google-antigravity");
	assert.equal(result.fetched, true);
	assert.equal(result.scheme, "antigravity");
	assert.deepEqual(result.windows, [
		{ kind: "session", minutes: 300, usedPercent: 40, resetsAt: "2026-10-04T12:00:00.000Z", group: "gemini" },
		{ kind: "weekly", usedPercent: 15, resetsAt: "2026-10-10T00:00:00.000Z", group: "gemini" },
		{ kind: "session", minutes: 300, usedPercent: 100, resetsAt: "2026-10-04T10:00:00.000Z", group: "non-gemini" }
	]);
	assert.equal(result.isAvailable, false, "one group exhausted is not 'all available'");
	await read("google-antigravity", { force: true });
	assert.deepEqual(calls, [false, true], "the refresh button reaches the plugin as force");

	// No plugin, no account: there would be nothing to read it with.
	assert.equal(listAccounts(ctxWith([piAi("official")], { providers: { official: { apiKeyEnv: "K" } } })).some((a) => a.id === "google-antigravity"), false);
});

test("an Antigravity plugin that is signed out says so, and its throttle is not ours", async () => {
	const readWith = (answer) =>
		createBalanceReader(ctxWith([], {}, undefined, { antigravityAuth: { usage: async () => answer } }))("google-antigravity");
	const out = await readWith({ state: "unauthenticated" });
	assert.equal(out.fetched, false);
	assert.equal(out.hint, "antigravity-signin");
	const throttled = await readWith({ state: "rate-limited", checkedAt: "2026-10-04T08:00:00.000Z" });
	assert.equal(throttled.reason, "upstream-429", "'rate-limited' is the panel's word for OUR backoff and wants a retry time");
	const thrown = await createBalanceReader(
		ctxWith([], {}, undefined, { antigravityAuth: { usage: async () => { throw new Error("boom"); } } })
	)("google-antigravity");
	assert.equal(thrown.fetched, false);
	assert.equal(thrown.reason, "failed");
	assert.deepEqual(mapAntigravityQuota({ groups: [{ group: "x", windows: [{ window: "5h", remainingFraction: 0.5 }] }, { group: "gemini", windows: [{ window: "5h", remainingFraction: 2 }] }] }), [], "unknown groups and impossible fractions are dropped");
});

test("a relay's software is fingerprinted when a balance is asked for, and only once", async () => {
	// Probing every relay at startup was six unauthenticated requests for a
	// column nothing read. Probing the one just asked about is the same work
	// with a reason behind it.
	let probes = 0;
	const learned = new Map();
	const read = createBalanceReader(
		ctxWith(
			[piAi("api99")],
			{ providers: { api99: { baseURL: "https://api.relay-one.example/v1", apiKeyEnv: "K" } } },
			{ resolve: async () => ({ value: "sk-live" }) }
		),
		{
			softwareOf: learned,
			learnSoftware: (host, software) => learned.set(host, software),
			detect: async () => {
				probes++;
				return { billingAvailable: true, software: "newapi", confidence: 1 };
			},
			fetch: okJson({ data: { total_available: 1000 } })
		}
	);
	const first = await read("api99");
	assert.equal(first.scheme, "newapi");
	assert.equal(probes, 1);

	await read("api99");
	assert.equal(probes, 1, "the answer is remembered");
	assert.equal(learned.get("https://api.relay-one.example"), "newapi", "keyed by origin, so a second relay on the same host does not inherit it");
});

test("a relay running nothing recognisable says so instead of failing", async () => {
	const read = createBalanceReader(
		ctxWith([piAi("api99")], { providers: { api99: { baseURL: "https://odd.example/v1", apiKeyEnv: "K" } } }, {
			resolve: async () => ({ value: "k" })
		}),
		{ detect: async () => ({ billingAvailable: false, software: "unknown" }) }
	);
	const result = await read("api99");
	assert.equal(result.supported, false);
	assert.equal(result.reason, "unknown-software");
});

test("an unrecognisable relay is not re-probed on every read, until the retry window or a forced refresh", async () => {
	// Only hits used to be remembered: a vendor console or a local proxy paid
	// six probes — up to 10 s each when unreachable — on every balance read.
	let probes = 0;
	let clock = 5_000_000;
	const read = createBalanceReader(
		ctxWith([piAi("api99")], { providers: { api99: { baseURL: "https://odd.example/v1", apiKeyEnv: "K" } } }, {
			resolve: async () => ({ value: "k" })
		}),
		{
			now: () => clock,
			detect: async () => {
				probes++;
				return { billingAvailable: false, software: "unknown" };
			}
		}
	);
	assert.equal((await read("api99")).reason, "unknown-software");
	assert.equal((await read("api99")).reason, "unknown-software");
	assert.equal(probes, 1, "the miss is remembered");
	await read("api99", { force: true });
	assert.equal(probes, 2, "the refresh button asks again");
	clock += UNRECOGNIZED_RETRY_MS;
	await read("api99");
	assert.equal(probes, 3, "and so does the next read after the window");
});

test("the credential comes from the route that serves that account", async () => {
	let resolved;
	const read = createBalanceReader(
		ctxWith([piAi("official")], { providers: { official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_KEY" } } }, {
			resolve: async (reference) => {
				resolved = reference;
				return { value: "sk-live" };
			}
		}),
		{ fetch: okJson({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.41" }] }) }
	);
	const result = await read("official");
	assert.equal(resolved, "DEEPSEEK_KEY");
	assert.equal(result.total, 9.41);
	assert.equal(result.displayName, "DeepSeek");
});

test("a host that cannot be asked is unsupported, not an error", async () => {
	assert.equal((await createBalanceReader({ get: () => undefined })()).reason, "no-provider-directory");
	assert.deepEqual(listAccounts({ get: () => undefined }), []);
});

test("an unknown account id is named as such rather than silently answered", async () => {
	const read = createBalanceReader(ctxWith([piAi("a")], { providers: { a: { baseURL: "https://x.example" } } }));
	assert.equal((await read("nope")).reason, "unknown-account");
});

test("an unlimited key reports what it spent, not a negative balance", async () => {
	// New API decrements `total_available` from zero for an unlimited key, so it
	// comes back as the negated usage. Shown as a balance that is a negative
	// number meaning nothing — a real install displayed ¥-1.5052 next to a
	// wallet holding $33.49. The wallet is behind user auth a token key does not
	// have; what the key CAN answer is its own spend.
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: async (url) => {
			if (url.includes("/api/status")) return { ok: true, json: async () => ({ data: { quota_per_unit: 500000 } }) };
			return {
				ok: true,
				json: async () => ({
					data: { total_granted: 0, total_used: 752_600, total_available: -752_600, unlimited_quota: true }
				})
			};
		}
	});
	assert.equal(result.total, undefined, "there is no remaining balance to report");
	assert.equal(result.granted, undefined);
	assert.equal(result.used, 1.5052);
	assert.equal(result.unlimited, true);
	assert.equal(result.isAvailable, true, "unlimited is available however much it has spent");
	assert.deepEqual(result.quota, { used: 752_600 });
});

test("quota converts to USD, because that is what quota_per_unit divides into", async () => {
	// `price` is the local-currency cost of one unit at top-up, not the unit the
	// quota is denominated in. Treating its presence as "this site bills in CNY"
	// put a ¥ in front of a dollar figure that the site's own wallet shows as $.
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: async (url) => {
			if (url.includes("/api/status")) {
				return { ok: true, json: async () => ({ data: { quota_per_unit: 500000, price: 7.3 } }) };
			}
			return { ok: true, json: async () => ({ data: { total_available: 16_745_000, total_used: 0 } }) };
		}
	});
	assert.equal(result.currency, "USD");
	assert.equal(result.total, 33.49);
});

test("the key's own name and expiry ride along, when New API gives them", async () => {
	// With several keys on one relay the name is the only thing that says which
	// one a card is about; it is what the site's console shows beside each row.
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: async (url) => {
			if (url.includes("/api/status")) return { ok: true, json: async () => ({ data: { quota_per_unit: 500000 } }) };
			return { ok: true, json: async () => ({ data: { name: "claude1", total_available: 500000, expires_at: 1800000000 } }) };
		}
	});
	assert.equal(result.keyName, "claude1");
	assert.equal(result.expiresAt, 1800000000);
});

test("expires_at of 0 means never, not the epoch", async () => {
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: async () => ({ ok: true, json: async () => ({ data: { total_available: 1, expires_at: 0 } }) })
	});
	assert.equal(result.expiresAt, undefined);
});

test("two relays on one machine are two sites, not one with two ports", async () => {
	// Found by pointing two stub relays at 127.0.0.1 on different ports: the
	// second inherited the first's detected software and then 404'd, because
	// both the site id and the software cache were keyed by hostname alone.
	const accounts = listAccounts(
		ctxWith([piAi("a"), piAi("b")], {
			providers: {
				a: { baseURL: "http://127.0.0.1:7801/v1" },
				b: { baseURL: "http://127.0.0.1:7802/v1" }
			}
		}),
		{ softwareOf: new Map([["http://127.0.0.1:7801", "newapi"]]) }
	);
	assert.equal(accounts.length, 2);
	assert.deepEqual(accounts.map((a) => a.origin), ["http://127.0.0.1:7801", "http://127.0.0.1:7802"]);
	assert.deepEqual(accounts.map((a) => a.scheme), ["newapi", undefined], "the second must not inherit the first's software");
	// The port already tells them apart, so no route suffix is needed — the
	// suffix is only for two keys reaching the SAME origin.
	assert.deepEqual(accounts.map((a) => a.displayName), ["127.0.0.1:7801", "127.0.0.1:7802"]);
});

// --- vendors with a public balance endpoint -----------------------------------
//
// Provenance of the fixtures below: the response *shapes* are taken from
// `Ychris12138/dsh-usage-stats` (MIT), whose parsers are written against live
// responses, cross-checked against each vendor's published docs. The endpoints
// themselves were probed directly on 2026-08-15 — each answers 401 to a bad
// Bearer while a sibling path under the same prefix answers 404, which is what
// distinguishes "route exists, credential rejected" from "no such route".
//
// What is NOT verified: that a real key returns these bodies. Nobody here holds
// an OpenRouter, Moonshot, or Z.ai key. If a field name is wrong, the scheme
// reports `undefined` for it rather than a wrong number — which is the whole
// reason every field is read defensively instead of destructured.

test("a vendor origin names its scheme outright, with no fingerprint probe", () => {
	const accounts = listAccounts(
		ctxWith([piAi("or"), piAi("kimi"), piAi("glm")], {
			providers: {
				or: { baseURL: "https://openrouter.ai/api/v1" },
				kimi: { baseURL: "https://api.moonshot.cn/v1" },
				glm: { baseURL: "https://open.bigmodel.cn/api/paas/v4" }
			}
		}),
		{ softwareOf: new Map() }
	);
	assert.deepEqual(accounts.map((a) => a.scheme), ["openrouter", "moonshot", "zai"]);
	assert.deepEqual(accounts.map((a) => a.displayName), ["OpenRouter", "Moonshot", "智谱 GLM"]);
});

test("a built-in route without a baseURL still names its vendor", () => {
	// The harness resolves its built-in providers' endpoints from its own
	// catalog, so the stored profile carries no baseURL. Reading that absence as
	// "the shipped DeepSeek default" pointed a Z.ai key at api.deepseek.com and
	// collapsed the second such route as a duplicate vendor — the live install
	// showed a card that could not read and a picker with no 智谱 in it.
	const accounts = listAccounts(
		ctxWith([piAi("zai"), piAi("zai-coding-cn")], {
			providers: {
				zai: { apiKeyEnv: "ZAI_API_KEY" },
				"zai-coding-cn": { apiKeyEnv: "ZAI_CODING_CN_API_KEY" }
			}
		}),
		{ softwareOf: new Map() }
	);
	assert.deepEqual(accounts.map((a) => a.scheme), ["zai", "zai"]);
	assert.deepEqual(accounts.map((a) => a.displayName), ["Z.ai", "智谱 GLM"]);
	assert.deepEqual(accounts.map((a) => a.origin), ["https://api.z.ai", "https://open.bigmodel.cn"]);
	assert.deepEqual(accounts.map((a) => a.hasCredential), [true, true]);
});

test("a shipped catalog route nobody configured is not an account", () => {
	// The harness's directory lists every catalog provider, "registered or
	// dormant" — dozens of them, each `declared: false`, most with no stored
	// profile at all. Listing those as accounts put Z.ai and 智谱 GLM in the
	// picker of an install that had configured neither (the origin table above
	// is what lets them escape the DeepSeek collapse), and let whichever dormant
	// route came first claim the DeepSeek card under its own route id.
	const directory = [
		{ provider: "openai", displayName: "openai", settingsNs: "llm-pi-ai", settingsPath: ["providers", "openai"], declared: false },
		{ provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] },
		{ provider: "zai", displayName: "zai", settingsNs: "llm-pi-ai", settingsPath: ["providers", "zai"], declared: false },
		{ provider: "zai-coding-cn", displayName: "zai-coding-cn", settingsNs: "llm-pi-ai", settingsPath: ["providers", "zai-coding-cn"], declared: false },
		{ provider: "bd", displayName: "bd", settingsNs: "llm-pi-ai", settingsPath: ["providers", "bd"], declared: true }
	];
	const sections = {
		"llm-pi-ai": { providers: { bd: { baseURL: "http://127.0.0.1:8045/v1", apiKeyEnv: "BD_API_KEY" } } },
		"llm-deepseek": {}
	};
	const ctx = {
		get: (name) =>
			name === "llm"
				? { listConfigurableProviders: () => directory }
				: name === "settings"
					? { get: (ns) => sections[ns] }
					: undefined
	};
	const accounts = listAccounts(ctx, { softwareOf: new Map() });
	assert.deepEqual(accounts.map((a) => a.id), ["deepseek-official", "bd"]);
	assert.deepEqual(accounts.map((a) => a.displayName), ["DeepSeek", "127.0.0.1:8045"]);

	// Configuring the catalog route is what makes it an account.
	sections["llm-pi-ai"].providers.zai = { apiKeyEnv: "ZAI_API_KEY" };
	assert.deepEqual(listAccounts(ctx, { softwareOf: new Map() }).map((a) => a.displayName), ["DeepSeek", "Z.ai", "127.0.0.1:8045"]);

	// The shipped DeepSeek route is not a catalog entry: with nothing stored at
	// all it is still the default, and still an account.
	delete sections["llm-deepseek"];
	assert.equal(listAccounts(ctx, { softwareOf: new Map() })[0].id, "deepseek-official");
});

test("0.1.7 settings without get(): routes are read from describe(), not collapsed into DeepSeek", () => {
	// 0.1.7 dropped `settings.get` and serves live values only through
	// `describe()`. Read through `get` alone, every declared route looked
	// unconfigured, fell back to the DeepSeek origin, and collapsed into one
	// account — the picker had nothing to pick.
	const directory = [
		{ provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] },
		{ provider: "yos", displayName: "Yos", settingsNs: "llm-pi-ai", settingsPath: ["providers", "yos"], declared: true },
		{ provider: "ali", displayName: "ali", settingsNs: "llm-pi-ai", settingsPath: ["providers", "ali"], declared: true }
	];
	const forms = [
		{ ns: "ui-theme", value: { preference: "system" } },
		{
			ns: "llm-pi-ai",
			value: {
				providers: {
					yos: { baseURL: "https://api2.yoshub.com/v1", apiKeyEnv: "YOS_API_KEY" },
					ali: { baseURL: "https://dashscope.example.com/compatible-mode/v1", apiKeyEnv: "ALI_API_KEY" }
				}
			}
		}
	];
	const ctx = {
		get: (name) =>
			name === "llm"
				? { listConfigurableProviders: () => directory }
				: name === "settings"
					? { describe: () => forms }
					: undefined
	};
	const accounts = listAccounts(ctx, { softwareOf: new Map() });
	assert.deepEqual(accounts.map((a) => a.id), ["deepseek-official", "yos", "ali"]);
	assert.deepEqual(accounts.map((a) => a.origin), ["https://api.deepseek.com", "https://api2.yoshub.com", "https://dashscope.example.com"]);
	assert.deepEqual(accounts.map((a) => a.hasCredential), [false, true, true]);
});

test("sectionReader prefers get(), falls back to describe(), and survives a throwing describe()", () => {
	assert.deepEqual(sectionReader({ get: (ns) => ({ from: "get", ns }), describe: () => [] })("x"), { from: "get", ns: "x" });
	assert.deepEqual(sectionReader({ describe: () => [{ ns: "x", value: { from: "describe" } }] })("x"), { from: "describe" });
	assert.equal(sectionReader({ describe: () => [{ ns: "y", value: {} }] })("x"), undefined);
	assert.equal(sectionReader({ describe: () => { throw new Error("not settled"); } })("x"), undefined);
	assert.equal(sectionReader(undefined)("x"), undefined);
});

test("0.1.7 live shape: the keyed DeepSeek route owns the card, and vendors open the picker", () => {
	// The catalog order 0.1.7-rc.2 actually serves: xiaomi first, then the
	// sign-in route `deepseek-account` (no key, no baseURL) ahead of the API-key
	// route. First-wins handed the DeepSeek card to the keyless route, and the
	// panel opened on xiaomi, whose balance cannot be read.
	const directory = [
		{ provider: "xiaomi", settingsNs: "llm-pi-ai", settingsPath: ["providers", "xiaomi"], declared: false },
		{ provider: "deepseek-account", displayName: "DeepSeek Account", settingsNs: "llm-deepseek-account", settingsPath: [] },
		{ provider: "yos", settingsNs: "llm-pi-ai", settingsPath: ["providers", "yos"], declared: true },
		{ provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] }
	];
	const forms = [
		{ ns: "llm-deepseek-account", value: { reasoningEffort: "high" } },
		{ ns: "llm-deepseek", value: { apiKeyEnv: "DEEPSEEK_API_KEY" } },
		{
			ns: "llm-pi-ai",
			value: {
				providers: {
					xiaomi: { apiKeyEnv: "XIAOMI_API_KEY" },
					yos: { baseURL: "https://api2.yoshub.com/v1", apiKeyEnv: "YOS_API_KEY" }
				}
			}
		}
	];
	const ctx = {
		get: (name) =>
			name === "llm" ? { listConfigurableProviders: () => directory } : name === "settings" ? { describe: () => forms } : undefined
	};
	const accounts = listAccounts(ctx, { softwareOf: new Map() });
	// Vendors first, in catalog order — MiMo is a vendor since its console reader.
	assert.deepEqual(accounts.map((a) => a.id), ["xiaomi", "deepseek-official", "yos"]);
	assert.equal(accounts[1].hasCredential, true);
});

test("one account listing costs one describe(), however many routes the catalog has", () => {
	// describe() re-validates every plugin entry synchronously on the host
	// thread. Called once per route, one listing froze 0.1.7-rc.2 for ~4.5 s.
	const directory = Array.from({ length: 30 }, (_, i) => ({
		provider: `route-${i}`,
		settingsNs: `ns-${i}`,
		settingsPath: [],
		declared: true
	}));
	const forms = directory.map((e, i) => ({ ns: e.settingsNs, value: { baseURL: `https://relay-${i}.example.com/v1`, apiKeyEnv: `K${i}` } }));
	let calls = 0;
	const settings = {
		describe: () => {
			calls++;
			return forms;
		}
	};
	const ctx = { get: (name) => (name === "llm" ? { listConfigurableProviders: () => directory } : name === "settings" ? settings : undefined) };
	assert.equal(listAccounts(ctx, { softwareOf: new Map() }).length, 30);
	assert.equal(calls, 1);
});

test("a describe() snapshot is shared across readers only while it is fresh", () => {
	let calls = 0;
	let value = { v: 1 };
	const settings = {
		describe: () => {
			calls++;
			return [{ ns: "x", value }];
		}
	};
	let clock = 1_000_000;
	const now = () => clock;
	assert.deepEqual(sectionReader(settings, { now })("x"), { v: 1 });
	value = { v: 2 };
	clock += DESCRIBE_TTL_MS - 1;
	assert.deepEqual(sectionReader(settings, { now })("x"), { v: 1 }, "a second reader inside the window reuses the snapshot");
	assert.equal(calls, 1);
	clock += 1;
	assert.deepEqual(sectionReader(settings, { now })("x"), { v: 2 }, "an expired snapshot is read again");
	assert.equal(calls, 2);

	// A throwing describe() is not remembered: the next reader asks again.
	let broken = true;
	const settling = {
		describe: () => {
			calls++;
			if (broken) throw new Error("not settled");
			return [{ ns: "x", value: "ok" }];
		}
	};
	calls = 0;
	const reader = sectionReader(settling, { now });
	assert.equal(reader("x"), undefined);
	assert.equal(reader("y"), undefined);
	assert.equal(calls, 1, "one reader does not retry per namespace");
	broken = false;
	assert.equal(sectionReader(settling, { now })("x"), "ok");
});

test("an explicit baseURL beats the built-in origin table", () => {
	// A route called anything may point anywhere: the table only speaks for
	// routes whose profile says nothing at all.
	const accounts = listAccounts(
		ctxWith([piAi("zai")], {
			providers: {
				zai: { baseURL: "https://relay-one.example/v1", apiKeyEnv: "K" }
			}
		}),
		{ softwareOf: new Map() }
	);
	assert.equal(accounts[0].scheme, undefined, "the relay is not the vendor");
	assert.equal(accounts[0].host, "relay-one.example");
});

test("a catalog route the harness resolves by itself still gets its own card", () => {
	// The live failure this exists for: `llm-pi-ai.providers.xiaomi` lists the
	// MiMo models and a key but no `baseURL`, because the harness resolves
	// api.xiaomimimo.com from its own catalog. Reading that absence as "the
	// shipped DeepSeek default" pointed MiMo at api.deepseek.com, where the
	// vendor collapse then swallowed it into the DeepSeek card — a picker that
	// never named the account the user had just added.
	const accounts = listAccounts(
		ctxWith(
			[
				{ provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] },
				{ ...piAi("xiaomi"), declared: false }
			],
			{ providers: { xiaomi: { apiKeyEnv: "XIAOMI_API_KEY" } } }
		),
		{ softwareOf: new Map() }
	);
	assert.deepEqual(accounts.map((a) => a.id), ["deepseek-official", "xiaomi"]);
	assert.deepEqual(accounts.map((a) => a.origin), ["https://api.deepseek.com", "https://api.xiaomimimo.com"]);
	assert.equal(accounts[1].displayName, "小米 MiMo");
	assert.equal(accounts[1].scheme, "mimo", "a vendor now: its console, not a relay probe, reads the money");
	assert.equal(accounts[1].hasCredential, true);
});

test("two routes at one vendor collapse, because they draw on one wallet", () => {
	// The opposite of the relay rule directly above: there, two keys are two
	// quotas and must stay apart. Here they are one account seen twice.
	const accounts = listAccounts(
		ctxWith([piAi("fast"), piAi("smart")], {
			providers: {
				fast: { baseURL: "https://api.moonshot.cn/v1" },
				smart: { baseURL: "https://api.moonshot.cn/v1" }
			}
		})
	);
	assert.equal(accounts.length, 1);
	assert.equal(accounts[0].displayName, "Moonshot");
});

test("a Command Code route is a vendor card, not a relay to fingerprint", () => {
	// The route's own origin is where the plan numbers live, so the card needs
	// no probe to know what it is: `individual-*` plans are read off
	// api.commandcode.ai, the same host its Provider API answers on.
	const accounts = listAccounts(
		ctxWith([piAi("commandcode")], {
			providers: {
				commandcode: { baseURL: "https://api.commandcode.ai/provider/v1", apiKeyEnv: "COMMANDCODE_API_KEY" }
			}
		}),
		{ softwareOf: new Map() }
	);
	assert.equal(accounts.length, 1);
	assert.equal(accounts[0].displayName, "Command Code");
	assert.equal(accounts[0].scheme, "commandcode");
	assert.equal(accounts[0].origin, "https://api.commandcode.ai", "the /provider/v1 path is not part of the origin asked");
	assert.equal(accounts[0].hasCredential, true);
});

test("the route the Command Code provider plugin mounts with a default endpoint still gets its card", () => {
	// The live shape after 2026-09-29: the provider plugin's patch layer declares
	// the route with an `apiKeyEnv` and no baseURL, so the vendor endpoint is a
	// default of the plugin's. Read as "no baseURL", the route fell back to the
	// shipped DeepSeek origin and its card became DeepSeek's own.
	const accounts = listAccounts(
		ctxWith([{ provider: "commandcode", settingsNs: "llm-commandcode", settingsPath: [] }], { apiKeyEnv: "COMMANDCODE_API_KEY" }),
		{ softwareOf: new Map() }
	);
	assert.equal(accounts.length, 1);
	assert.equal(accounts[0].origin, "https://api.commandcode.ai");
	assert.equal(accounts[0].scheme, "commandcode");
	assert.equal(accounts[0].displayName, "Command Code");
	assert.equal(accounts[0].hasCredential, true);
});

test("openrouter reports remaining credit, not the top-up total", async () => {
	const result = await readBalance({
		scheme: "openrouter",
		origin: "https://openrouter.ai",
		apiKey: "sk-or-mgmt",
		fetch: okJson({ data: { total_credits: 50, total_usage: 12.5 } })
	});
	assert.equal(result.total, 37.5, "the headline is what is left, not what was bought");
	assert.equal(result.used, 12.5);
	assert.equal(result.granted, 50);
	assert.equal(result.currency, "USD");
	assert.equal(result.isAvailable, true);
});

test("openrouter says which key it wanted, rather than leaving a bare 401", async () => {
	// `/api/v1/credits` takes a Management Key, not the `sk-or-v1-` inference
	// key the route carries — so for most people this 401s, and a card reading
	// only "401" would send them to check a key that is perfectly fine.
	const result = await readBalance({
		scheme: "openrouter",
		origin: "https://openrouter.ai",
		apiKey: "sk-or-v1-inference",
		fetch: async () => ({ ok: false, status: 401 })
	});
	assert.equal(result.reason, "http-401");
	assert.equal(result.hint, "openrouter-management-key");
});

test("a scheme with no hint adds no hint field", async () => {
	const result = await readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "k",
		fetch: async () => ({ ok: false, status: 401 })
	});
	assert.equal("hint" in result, false);
});

test("moonshot separates voucher credit from cash", async () => {
	const result = await readBalance({
		scheme: "moonshot",
		origin: "https://api.moonshot.cn",
		apiKey: "sk-moonshot",
		fetch: okJson({ code: 0, data: { available_balance: 49.58, voucher_balance: 49.58, cash_balance: 0 } })
	});
	assert.equal(result.total, 49.58);
	assert.equal(result.granted, 49.58, "voucher credit is granted, not bought");
	assert.equal(result.toppedUp, 0);
	assert.equal(result.currency, "CNY", "the regional endpoint bills in one currency and does not say so");
});

test("a currency the body reports beats the one we assumed", async () => {
	const result = await readBalance({
		scheme: "moonshot",
		origin: "https://api.moonshot.cn",
		apiKey: "k",
		fetch: okJson({ data: { available_balance: 1, currency: "USD" } })
	});
	assert.equal(result.currency, "USD");
});

test("an unreported currency stays absent rather than being guessed", async () => {
	// `api.moonshot.ai` is the global endpoint; we do not know what it bills in,
	// so the card shows a bare number. A number under the wrong symbol is worse.
	const result = await readBalance({
		scheme: "moonshot",
		origin: "https://api.moonshot.ai",
		apiKey: "k",
		fetch: okJson({ data: { available_balance: 20 } })
	});
	assert.equal(result.total, 20);
	assert.equal(result.currency, undefined);
});

/**
 * A fetch that answers by path, so a reader with more than one route can be
 * walked through all of them. An unmatched path throws rather than 404s: a
 * stub that answers everything looks exactly like a vendor gone mad, and the
 * test should say which path nobody planned for.
 */
const byPath = (routes) => async (url, init) => {
	const path = new URL(url).pathname;
	for (const [needle, answer] of routes) {
		if (path.includes(needle)) {
			if (typeof answer === "function") return answer(url, init);
			// A plain body is wrapped into a response; an object that already
			// speaks `ok`/`json` is a whole response and goes out untouched.
			// Wrapping a 404-shaped answer as a body would turn the refusal
			// into a successful response whose body merely mentions failure.
			return "ok" in answer || "json" in answer ? answer : { ok: true, json: async () => answer };
		}
	}
	throw new Error(`unexpected path: ${path}`);
};

test("zai reads the account report first: what was spent, what is left", async () => {
	const seen = [];
	const result = await readBalance({
		scheme: "zai",
		origin: "https://open.bigmodel.cn",
		apiKey: "glm-key",
		fetch: byPath([
			[
				"/api/biz/account/query-customer-account-report",
				(url, init) => {
					seen.push(init.headers.authorization);
					return {
						ok: true,
						json: async () => ({
							code: 200,
							msg: "操作成功",
							success: true,
							data: {
								balance: 66.5,
								rechargeAmount: 70.0,
								giveAmount: 0.0,
								totalSpendAmount: 3.5,
								availableBalance: 66.5,
								frozenBalance: 0,
								creditStatus: "NOT_OPEN"
							}
						})
					};
				}
			],
			["/api/monitor/usage/quota/limit", { data: { limits: [] } }],
			["/api/biz/subscription/list", { data: [] }]
		])
	});
	assert.equal(result.total, 66.5);
	assert.equal(result.granted, undefined, "recharge is cumulative top-up, not a gift; the card must not say 其中赠送");
	assert.equal(result.used, 3.5);
	assert.equal(result.currency, "CNY", "the report carries no currency; the vendor map supplies it");
	assert.equal(result.isAvailable, true);
	assert.deepEqual(seen, ["glm-key"], "console routes take the key raw, without a Bearer prefix");
});

test("an origin that does not serve the report falls back to the v4 balance", async () => {
	let bearer;
	const result = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "zai-key",
		fetch: byPath([
			["/api/biz/account/query-customer-account-report", { ok: false, status: 404 }],
			[
				"/api/paas/v4/balance",
				(url, init) => {
					bearer = init.headers.authorization;
					return { ok: true, json: async () => ({ data: { total_balance: 100, available_balance: 64 } }) };
				}
			],
			["/api/monitor/usage/quota/limit", { data: { limits: [] } }],
			["/api/biz/subscription/list", { data: [] }]
		])
	});
	assert.equal(result.total, 64);
	assert.equal(result.granted, 100);
	assert.equal("used" in result, false, "the v4 route carries no spend; none is invented");
	assert.equal(bearer, "Bearer zai-key", "the v4 route still takes the inference API's Bearer form");
});

test("a refusal on the report route is not the wallet's answer", async () => {
	// The gateway refuses every path the same way, so a refusal here says
	// nothing about the wallet the older route would still answer for — and on
	// a bad key both routes refuse alike, so the surfaced refusal is honest
	// either way.
	const result = await readBalance({
		scheme: "zai",
		origin: "https://open.bigmodel.cn",
		apiKey: "k",
		fetch: byPath([
			["/api/biz/account/query-customer-account-report", { code: 401, msg: "token expired or incorrect", success: false }],
			["/api/paas/v4/balance", { data: { total_balance: 100, available_balance: 64 } }],
			["/api/monitor/usage/quota/limit", { data: { limits: [] } }],
			["/api/biz/subscription/list", { data: [] }]
		])
	});
	assert.equal(result.total, 64);
});

test("when both wallet routes fail, the older route's refusal is the one surfaced", async () => {
	const result = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "k",
		fetch: byPath([
			["/api/biz/account/query-customer-account-report", { success: false, msg: "report leg" }],
			["/api/paas/v4/balance", { code: 401, msg: "token expired or incorrect", success: false }],
			["/api/monitor/usage/quota/limit", { code: 401, msg: "token expired or incorrect", success: false }],
			["/api/biz/subscription/list", { code: 401, msg: "token expired or incorrect", success: false }]
		])
	});
	assert.equal(result.fetched, false);
	assert.equal(result.reason, "upstream-401", "the v4 refusal carries the code; the report's bare refusal does not");
});

// --- quota windows ------------------------------------------------------------

test("a scheme describes what its vendor sent; readBalance does the arithmetic", async () => {
	// Normalising centrally is the point: a reader says "a ratio" or "seconds
	// from now" and never has to get the same conversion right a fifth time.
	const now = Date.UTC(2026, 7, 17, 12, 0, 0);
	const spec = {
		label: "Stub",
		read: async () => ({
			plan: "Go",
			windows: [
				{ kind: "weekly", usedRatio: 0.82 },
				{ kind: "session", minutes: 300, usedPercent: 4, resetInSeconds: 3600 }
			]
		})
	};
	SCHEMES.__stub = spec;
	try {
		const result = await readBalance({ scheme: "__stub", origin: "https://x.example", apiKey: "k", now, fetch: okJson({}) });
		assert.deepEqual(result.windows, [
			{ kind: "session", minutes: 300, resetsAt: "2026-08-17T13:00:00.000Z", usedPercent: 4 },
			{ kind: "weekly", usedPercent: 82 }
		]);
		assert.equal(result.plan, "Go", "the rest of the reader's answer is untouched");
	} finally {
		delete SCHEMES.__stub;
	}
});

test("a reader that emits nothing usable leaves no windows key at all", async () => {
	// Not `windows: []`. An empty list would have the card claim to be a
	// subscription account with nothing in it, which is the same lie as
	// reporting an unread balance as zero.
	SCHEMES.__stub = { label: "Stub", read: async () => ({ total: 5, windows: [{ kind: "ROLLING_5H", usedPercent: 3 }] }) };
	try {
		const result = await readBalance({ scheme: "__stub", origin: "https://x.example", apiKey: "k", fetch: okJson({}) });
		assert.equal("windows" in result, false);
		assert.equal(result.total, 5);
	} finally {
		delete SCHEMES.__stub;
	}
});

test("a money scheme still returns no windows key", async () => {
	const result = await readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "k",
		fetch: okJson({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "3.00" }] })
	});
	assert.equal("windows" in result, false);
});

// --- vendors that refuse with a 200 ------------------------------------------
//
// Probed live with an invalid Bearer and a control path that does not exist:
//
//   GET https://api.z.ai/api/monitor/usage/quota/limit
//     -> 200 {"code":401,"msg":"token expired or incorrect","success":false}
//   GET https://api.z.ai/api/monitor/nope-404            (control)
//     -> 200 {"code":401,"msg":"token expired or incorrect","success":false}
//
// The control is the point: the status line does not even distinguish a route
// that exists from one that never did, so nothing can be read off it.

test("a refusal dressed as a 200 is a failure, not an empty account", async () => {
	const result = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "bad-key",
		fetch: okJson({ code: 401, msg: "token expired or incorrect", success: false })
	});
	assert.equal(result.fetched, false, "the vendor refused; nothing was read");
	assert.equal(result.reason, "upstream-401");
	assert.equal(result.total, undefined, "an account we could not read has no balance to report");
	assert.equal(result.isAvailable, undefined);
});

test("an envelope refusal reads differently from a transport failure", async () => {
	// Both are failures, and they are not the same failure: one means the vendor
	// answered and said no, the other means the status line said no. Collapsing
	// them loses the only thing that tells you the endpoint is even alive.
	const envelope = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "k",
		fetch: okJson({ success: false, msg: "nope" })
	});
	const transport = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "k",
		fetch: async () => ({ ok: false, status: 401 })
	});
	assert.equal(envelope.reason, "upstream-error", "no code in the body means no number to report");
	assert.equal(transport.reason, "http-401");
});

test("a success code spelled 0 is still a success", async () => {
	// The refusal signal is `success:false`; `code` only supplies the number.
	// Reading any non-200 code as a refusal would report a live account as
	// unreadable on every vendor that spells success `0`, which is common.
	const result = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "k",
		fetch: okJson({ code: 0, data: { availableBalance: 64 } })
	});
	assert.equal(result.fetched, true);
	assert.equal(result.total, 64);
});

test("a vendor that carries neither convention is left alone", async () => {
	// The wallet routes may answer with a bare `data` object. An envelope that
	// fires on absence would break every such response.
	const result = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "k",
		fetch: okJson({ data: { availableBalance: 10 } })
	});
	assert.equal(result.fetched, true);
	assert.equal(result.total, 10);
});

test("schemes whose vendor uses real status codes gain no envelope", async () => {
	// DeepSeek, Moonshot, OpenRouter and New API all answer 401 with a 401. A
	// blanket envelope check would start rejecting their success bodies for
	// carrying an unrelated `code` field.
	for (const scheme of ["deepseek", "moonshot", "openrouter", "newapi", "sub2api"]) {
		assert.equal(SCHEMES[scheme].envelope, undefined, scheme);
	}
});

test("a vendor response missing every field fails soft, with no zeros invented", async () => {
	for (const scheme of ["openrouter", "moonshot", "zai"]) {
		const result = await readBalance({ scheme, origin: "https://api.moonshot.cn", apiKey: "k", fetch: okJson({}) });
		assert.equal(result.fetched, true, scheme);
		assert.equal(result.total, undefined, `${scheme}: an unreported balance is not a balance of zero`);
		assert.equal(result.isAvailable, undefined, scheme);
	}
});

// --- 小米 MiMo: a balance the user types in ------------------------------------

/** The MiMo route as the host lists it, with a key that must never be spent on a balance read. */
function mimoCtx() {
	return ctxWith([{ provider: "xiaomi", settingsNs: "llm-pi-ai", settingsPath: ["providers", "xiaomi"], declared: false }], { providers: { xiaomi: { apiKeyEnv: "XIAOMI_API_KEY" } } }, {
		resolve: async () => ({ value: "sk-route-key" })
	});
}

test("MiMo is typed in: nothing is fetched, and an untyped account asks for a figure", async () => {
	// 用户 2026-10-04「这种改成自己输入吧」: no key reads MiMo's balance, and the
	// console cookie that could lasted a day.
	assert.equal(SCHEMES.mimo.credential.kind, "manual");
	assert.equal(SCHEMES.mimo.read, undefined, "there is nothing to fetch");
	let fetched = 0;
	const read = createBalanceReader(mimoCtx(), { fetch: async () => (fetched++, {}), manualBalance: () => undefined });
	const result = await read("xiaomi");
	assert.equal(fetched, 0);
	assert.equal(result.fetched, false);
	assert.equal(result.scheme, "mimo", "the card needs the scheme to offer the 填写余额 button");
	assert.equal(result.reason, "no-manual-balance");
	assert.equal(result.hint, "manual-missing");
});

test("a typed MiMo balance is the host's answer, asked for by account", async () => {
	const asked = [];
	let fetched = 0;
	const read = createBalanceReader(mimoCtx(), {
		fetch: async () => (fetched++, {}),
		manualBalance: (account) => (asked.push(account.id), { supported: true, fetched: true, manual: true, currency: "CNY", total: 12.5 })
	});
	const result = await read("xiaomi");
	assert.deepEqual(asked, ["xiaomi"]);
	assert.equal(fetched, 0);
	assert.equal(result.total, 12.5);
	assert.equal(result.manual, true);
	assert.equal(result.scheme, "mimo");
	assert.equal(result.account, "xiaomi");
});

// --- 阿里云百炼: the account balance, read with an AccessKey --------------------

test("a 百炼 workspace route is the 阿里云 card, read with the stored AccessKey and never the route key", async () => {
	const ctx = ctxWith(
		[{ provider: "ali", settingsNs: "llm-pi-ai", settingsPath: ["providers", "ali"] }],
		{ providers: { ali: { baseURL: "https://llm-7ub39ukw6sjudiit.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "ALI_KEY" } } },
		{ resolve: async () => ({ value: "sk-route-key" }) }
	);
	const [account] = listAccounts(ctx);
	assert.equal(account.scheme, "aliyun");
	assert.equal(account.displayName, "阿里云百炼");

	// No key stored: the card asks for one, and nothing is sent anywhere.
	let calls = 0;
	const none = await createBalanceReader(ctx, { fetch: async () => (calls++, {}), aliyunAccessKey: () => undefined })("ali");
	assert.equal(calls, 0);
	assert.equal(none.fetched, false);
	assert.equal(none.scheme, "aliyun", "the card needs the scheme to offer the button");
	assert.equal(none.hint, "aliyun-ak-missing");

	const seen = [];
	const read = createBalanceReader(ctx, {
		fetch: async (url, init) => {
			seen.push({ url, init });
			return { ok: true, status: 200, json: async () => ({ Code: "200", Success: true, Data: { AvailableAmount: "88.80", AvailableCashAmount: "88.80", Currency: "CNY" } }) };
		},
		aliyunAccessKey: () => ({ accessKeyId: "LTAI5tExampleKeyId01", accessKeySecret: "ExampleSecretValue0123456789ab" })
	});
	const card = await read("ali");
	assert.equal(card.fetched, true);
	assert.equal(card.total, 88.8);
	assert.equal(card.account, "ali");
	assert.equal(seen.length, 1);
	assert.equal(new URL(seen[0].url).host, "business.aliyuncs.com", "the balance is asked of the billing center, not the workspace host");
	assert.equal(JSON.stringify(seen[0].init).includes("sk-route-key"), false, "the inference key never leaves for the billing center");
});

// --- Command Code: two rolling caps and the month's pool -----------------------

/**
 * The account API's shapes, as a live GOAT account answered them (2026-09-29).
 *
 * `Credits` carries both caps and what is left of the pool; the subscription
 * route carries the plan and the period it resets in. `resetAt` is epoch
 * MILLISECONDS, which is what the magnitude has to survive on the way to the
 * card — a seconds reading of that number lands in 1970.
 */
const COMMAND_CODE_CREDITS = {
	credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 69.586298012, purchasedCredits: 0, freeCredits: 0 },
	windowLimits: {
		limited: true,
		exceeded: null,
		fiveHour: { used: 0.413701988, cap: 14, exceeded: false, resetAt: 1_800_000_000_000 },
		weekly: { used: 0.413701988, cap: 35, exceeded: false, resetAt: 1_801_000_000_000 }
	}
};

const COMMAND_CODE_SUBSCRIPTION = {
	success: true,
	data: {
		status: "active",
		planId: "individual-goat",
		currentPeriodStart: "2026-09-29T01:02:57.000Z",
		currentPeriodEnd: "2026-10-29T01:02:57.000Z"
	}
};

/** The account API's own paths, as a stub keyed by path (a number is a status). */
function commandCodeApi(bodies) {
	const seen = [];
	return {
		seen,
		fetch: async (url, init) => {
			seen.push({ url, headers: init.headers });
			const body = bodies[new URL(url).pathname];
			if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
			if (typeof body === "number") return { ok: false, status: body, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => body };
		}
	};
}

const commandCode = (bodies, extra = {}) =>
	readBalance({
		scheme: "commandcode",
		origin: "https://api.commandcode.ai",
		apiKey: "ck-live",
		fetch: commandCodeApi(bodies).fetch,
		...extra
	});

test("Command Code reads both rolling caps and the month's pool off its own account API", async () => {
	const stub = commandCodeApi({ "/alpha/billing/credits": COMMAND_CODE_CREDITS, "/alpha/billing/subscriptions": COMMAND_CODE_SUBSCRIPTION });
	const result = await readBalance({
		scheme: "commandcode",
		origin: "https://api.commandcode.ai",
		apiKey: "ck-live",
		fetch: stub.fetch
	});

	assert.equal(result.fetched, true);
	assert.equal(result.plan, "GOAT");
	assert.deepEqual(result.windows, [
		{ kind: "session", minutes: 300, resetsAt: "2027-01-15T08:00:00.000Z", usedPercent: 3 },
		{ kind: "weekly", resetsAt: "2027-01-26T21:46:40.000Z", usedPercent: 1.2 },
		// 70 credits is what GOAT's pool is worth, which the response never says:
		// it reports the 69.586 left, and the spend against the cap is the
		// difference. The reset is the billing period's own end.
		{ kind: "monthly", resetsAt: "2026-10-29T01:02:57.000Z", usedPercent: 0.6 }
	]);

	// The key the route already holds is the whole credential — no session
	// cookie, and it never leaves the vendor's own origin.
	for (const { url, headers } of stub.seen) {
		assert.equal(new URL(url).origin, "https://api.commandcode.ai");
		assert.equal(headers.authorization, "Bearer ck-live");
	}
	assert.equal(stub.seen[0].headers.cookie, undefined, "a bearer key, not a console session");
});

test("an unknown plan id costs the month's row, never the rolling caps", async () => {
	// The pool has no denominator without the table, and a denominator invented
	// here would be a percentage about a plan this module has never heard of.
	const result = await commandCode({
		"/alpha/billing/credits": COMMAND_CODE_CREDITS,
		"/alpha/billing/subscriptions": { success: true, data: { planId: "individual-something-new", currentPeriodEnd: "2026-10-29T01:02:57.000Z" } }
	});
	assert.equal(result.plan, undefined);
	assert.deepEqual(result.windows.map((w) => w.kind), ["session", "weekly"]);
});

test("the longer plan id wins, so a legacy Pro is not read as the current one", async () => {
	// `individual-pro` and `individual-pro-v1` are both real, both called Pro,
	// and worth different pools. A shortest-first match would give every v1
	// account the legacy denominator.
	const result = await commandCode({
		"/alpha/billing/credits": { ...COMMAND_CODE_CREDITS, credits: { monthlyCredits: 79.5 } },
		"/alpha/billing/subscriptions": { success: true, data: { planId: "individual-pro-v1" } }
	});
	assert.equal(result.plan, "Pro");
	// 0.5 of 80, not 0.5 of 30 and not "unknown".
	assert.deepEqual(result.windows.filter((w) => w.kind === "monthly"), [{ kind: "monthly", usedPercent: 0.6 }]);
});

test("a remainder larger than the plan's pool is not a spend of zero", async () => {	// Credits granted on top of the pool, or a table that has fallen behind a
	// new plan: either way the subtraction is meaningless, and a bar at 0% would
	// claim nothing had been used.
	const result = await commandCode({
		"/alpha/billing/credits": { ...COMMAND_CODE_CREDITS, credits: { monthlyCredits: 99 } },
		"/alpha/billing/subscriptions": COMMAND_CODE_SUBSCRIPTION
	});
	assert.deepEqual(result.windows.map((w) => w.kind), ["session", "weekly"]);
});

test("the subscription route failing leaves the caps standing", async () => {
	// The plan's name and the period end are labels; the caps are the reading.
	const result = await commandCode({ "/alpha/billing/credits": COMMAND_CODE_CREDITS, "/alpha/billing/subscriptions": 500 });
	assert.equal(result.fetched, true);
	assert.deepEqual(result.windows.map((w) => w.kind), ["session", "weekly"]);
});

test("a refused account API is the refusal, and the caps are not reported as empty", async () => {
	for (const status of [401, 403]) {
		const result = await commandCode({ "/alpha/billing/credits": status, "/alpha/billing/subscriptions": status });
		assert.equal(result.fetched, false, String(status));
		assert.equal(result.reason, `http-${status}`);
		assert.equal("windows" in result, false);
	}
});

test("a pay-as-you-go account with no caps says so in words", async () => {
	// `windowLimits.limited: false` is what the vendor answers for a plan-less
	// account. No caps and no pool is a stated absence, not a card at zero.
	const result = await commandCode({
		"/alpha/billing/credits": { credits: { monthlyCredits: 0, purchasedCredits: 5 }, windowLimits: { limited: false } },
		"/alpha/billing/subscriptions": { success: true, data: {} }
	});
	assert.equal(result.fetched, true);
	assert.equal("windows" in result, false);
	assert.equal(result.reason, "no rolling or monthly allowance in the response");
});

// --- the signed-in DeepSeek wallet -------------------------------------------

/**
 * What the Host's account service answers for `getBalance(client)`.
 *
 * `null` while signed out, `{ status: "failed" }` when Platform could not be
 * asked, and `{ status: "ready", value, bonusWallets }` with the recharge and
 * bonus wallets as decimal STRINGS. Shapes taken from the Host's own contract
 * (`@deepseek-ai/dsh-api-account-controller`'s remote schema), not guessed.
 */
const signedIn = (result) => ({ getBalance: async () => result });

const ACCOUNT_WALLETS = {
	status: "ready",
	value: [{ currency: "CNY", balance: "47.3913457000000000" }],
	bonusWallets: [{ currency: "CNY", balance: "2.5" }]
};

test("the sign-in wallet is the DeepSeek card's source while the Host is signed in", async () => {
	// 0.1.7 spends DeepSeek through `deepseek-account`, the Platform sign-in,
	// whose wallet has no API key behind it. `/user/balance` wants a key: the
	// keyless route read "no key", and a route whose key was revoked read 401 —
	// both while the signed-in account's own money sat unread one hostname over.
	// The Host's account service is the reader that can see it.
	let requests = 0;
	let resolved = 0;
	const read = createBalanceReader(
		ctxWith(
			[piAi("official")],
			{ providers: { official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_KEY" } } },
			{ resolve: async () => (resolved++, { value: "sk-live" }) },
			{ deepseekAccount: signedIn(ACCOUNT_WALLETS) }
		),
		{ fetch: async () => void requests++ }
	);
	const result = await read("official");
	assert.equal(requests, 0, "api.deepseek.com is not asked: this wallet is not behind a key");
	assert.equal(resolved, 0, "and the route's key is not even looked up");
	assert.equal(result.account, "official");
	assert.equal(result.fetched, true);
	assert.equal(result.scheme, "deepseek-account", "the card must say which wallet it is showing");
	assert.equal(result.currency, "CNY");
	assert.equal(result.toppedUp, 47.3913457);
	assert.equal(result.granted, 2.5);
	assert.equal(result.total, 49.8913457);
	assert.equal(result.isAvailable, true);
});

test("a Host that is signed out still reads the route's key", async () => {
	// The sign-in is the first source, never the only one: a key-only install
	// and a Host whose session lapsed must keep reading the wallet they can.
	let requests = 0;
	const read = createBalanceReader(
		ctxWith(
			[piAi("official")],
			{ providers: { official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_KEY" } } },
			{ resolve: async () => ({ value: "sk-live" }) },
			{ deepseekAccount: signedIn(null) }
		),
		{
			fetch: async () => {
				requests++;
				return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.41" }] }) };
			}
		}
	);
	const result = await read("official");
	assert.equal(requests, 1);
	assert.equal(result.scheme, "deepseek");
	assert.equal(result.total, 9.41);
	assert.equal(result.hint, undefined, "the key answered; there is nothing to sign in for");
});

test("a failing account service never costs the balance the key can still read", async () => {
	// Probe and degrade, the way every Host API is treated here: 0.1.7 exposes
	// `deepseekAccount`, another host version may not, and either way one
	// broken reader is not a reason to show nothing.
	for (const service of [
		{ getBalance: async () => { throw new Error("service exploded"); } },
		{ getBalance: () => new Promise(() => {}) },
		{ notGetBalance: true },
		undefined
	]) {
		const read = createBalanceReader(
			ctxWith(
				[piAi("official")],
				{ providers: { official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_KEY" } } },
				{ resolve: async () => ({ value: "sk-live" }) },
				{ deepseekAccount: service }
			),
			{
				accountTimeoutMs: 5,
				fetch: async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.41" }] }) })
			}
		);
		const started = Date.now();
		const result = await read("official");
		assert.ok(Date.now() - started < 3000, "a stuck account service costs the deadline, not the card");
		assert.equal(result.fetched, true, JSON.stringify(service));
		assert.equal(result.total, 9.41);
		assert.equal(result.scheme, "deepseek");
	}
});

test("the account wallet is a DeepSeek-only source", async () => {
	// A relay running on api.deepseek.com's hostname is not a thing, but a
	// reader that matched on the route NAME would hand some other vendor's card
	// DeepSeek's wallet. It must match on the origin, like everything else here.
	let accountCalls = 0;
	const read = createBalanceReader(
		ctxWith(
			[piAi("api99")],
			{ providers: { api99: { baseURL: "https://api.relay-one.example/v1", apiKeyEnv: "K" } } },
			{ resolve: async () => ({ value: "k" }) },
			{
				deepseekAccount: {
					getBalance: async () => (accountCalls++, ACCOUNT_WALLETS)
				}
			}
		),
		{ detect: async () => ({ billingAvailable: true, software: "newapi" }), fetch: okJson({ data: { total_available: 1000 } }) }
	);
	const result = await read("api99");
	assert.equal(accountCalls, 0);
	assert.equal(result.scheme, "newapi");
});

test("a signed-out Host with a refused key says to sign in, rather than leaving a bare 401", async () => {
	// This is the shape that broke the panel: the API key gone (revoked or
	// deleted) and the sign-in left in place. "http-401" says the key is wrong;
	// it does not say the account is signed out and has money sitting there.
	const read = createBalanceReader(
		ctxWith(
			[piAi("official")],
			{ providers: { official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_KEY" } } },
			{ resolve: async () => ({ value: "sk-revoked" }) },
			{ deepseekAccount: signedIn(null) }
		),
		{ fetch: async () => ({ ok: false, status: 401 }) }
	);
	const result = await read("official");
	assert.equal(result.fetched, false);
	assert.equal(result.reason, "http-401");
	assert.equal(result.hint, "deepseek-signin");
});

test("the account reader says why it cannot answer, and never guesses a zero", async () => {
	assert.equal((await readDeepSeekAccountBalance({ get: () => undefined })).reason, "no-account-service");
	assert.equal((await readDeepSeekAccountBalance({ get: (n) => (n === "deepseekAccount" ? signedIn(null) : undefined) })).reason, "signed-out");
	assert.equal((await readDeepSeekAccountBalance({ get: (n) => (n === "deepseekAccount" ? signedIn({ status: "failed" }) : undefined) })).reason, "failed");
	assert.equal(
		(await readDeepSeekAccountBalance({ get: (n) => (n === "deepseekAccount" ? signedIn({ status: "ready", value: [], bonusWallets: [] }) : undefined) })).reason,
		"no-wallets",
		"an account that reports no wallet at all is not an account with nothing in it"
	);
	assert.equal(
		(await readDeepSeekAccountBalance({ get: (n) => (n === "deepseekAccount" ? { getBalance: () => new Promise(() => {}) } : undefined) }, { timeoutMs: 5 })).reason,
		"timeout",
		"a balance read must not outlive the card that asked for it"
	);
	const ok = await readDeepSeekAccountBalance({ get: (n) => (n === "deepseekAccount" ? signedIn(ACCOUNT_WALLETS) : undefined) });
	assert.equal(ok.ok, true);
	assert.equal(ok.total, 49.8913457);
});

test("wallet strings are read as money, not as text", () => {
	// Platform answers in the decimal grammar its own Web client feeds big.js:
	// an omitted part and a decimal exponent are both legal, and `0E-16` is a
	// real zero. NaN, Infinity and prose are not balances.
	const wallets = (value, bonusWallets) => mapDeepSeekAccountWallets({ status: "ready", value, bonusWallets });
	assert.equal(wallets([{ currency: "CNY", balance: "0E-16" }], []).total, 0);
	assert.equal(wallets([{ currency: "CNY", balance: "0E-16" }], []).isAvailable, false, "a zero balance is a fact, and it is not 'unavailable'");
	assert.equal(wallets([{ currency: "CNY", balance: "5.0000000000000000" }], []).total, 5);

	// Recharge and bonus are two wallets on one account: the card's total is
	// both, and its two lines know which is which.
	const both = wallets([{ currency: "CNY", balance: "10" }, { currency: "USD", balance: "3" }], [{ currency: "CNY", balance: "1.5" }]);
	assert.equal(both.currency, "CNY", "the account's own denomination wins");
	assert.equal(both.toppedUp, 10);
	assert.equal(both.granted, 1.5);
	assert.equal(both.total, 11.5);

	// Two entries in one currency are one wallet split in the answer.
	assert.equal(wallets([{ currency: "CNY", balance: "1" }, { currency: "CNY", balance: "2" }], []).total, 3);

	for (const bad of ["NaN", "Infinity", "abc", "", "   "]) {
		assert.equal(wallets([{ currency: "CNY", balance: bad }], []), undefined, `${bad} is not money, and unreported is not zero`);
	}
	assert.equal(wallets(undefined, undefined), undefined);
	assert.equal(mapDeepSeekAccountWallets(null), undefined);
	assert.equal(mapDeepSeekAccountWallets({ status: "failed" }), undefined);
	// Two wallet entries that carry no currency cannot be added up honestly.
	assert.equal(wallets([{ balance: "1" }], []), undefined);
});

test("the account call carries a client identity of its own", () => {
	// The Host derives Platform request headers from this. A borrowed or empty
	// one is the kind of lie a vendor can act on.
	const client = deepSeekAccountClient({ version: "dsh-tokenledger/1", locale: "zh-CN", timezoneOffsetSeconds: 0 });
	assert.deepEqual(client, { version: "dsh-tokenledger/1", locale: "zh-CN", timezoneOffsetSeconds: 0 });
	const fallback = deepSeekAccountClient();
	assert.equal(typeof fallback.version, "string");
	assert.notEqual(fallback.version, "", "Platform wants to know which client asked");
	assert.equal(typeof fallback.locale, "string");
	assert.equal(typeof fallback.timezoneOffsetSeconds, "number");
});
