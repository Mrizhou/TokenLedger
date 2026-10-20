/**
 * Tests for the plugin's wiring, as opposed to its pure parts.
 *
 * Every bug a real DSH install has found in this package lived here — a service
 * sampled once at mount that was not ready yet, a fingerprint written onto an
 * object the next sweep rebuilds — and none of them was caught, because `apply`
 * had no test. Its collaborators are all reachable through the context or the
 * config, so a fake context is enough; nothing here touches a network or a disk.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/plugin.js";
import { LedgerStore } from "../src/store.js";

const DAY = Date.parse("2026-08-15T10:00:00");

/** One assistant turn billed to `route`. */
const turn = (seq, route) => ({
	type: "assistant/message",
	seq,
	time: DAY,
	data: {
		turn: seq,
		step: 1,
		message: { role: "assistant", source: { kind: "model", provider: route, model: "gpt" } },
		usage: { inputTokens: 1000, outputTokens: 100 }
	}
});

/**
 * A context with just enough of Cordis to run `apply`.
 *
 * `settingsReadyAfter` reproduces the real failure: the service exists, but not
 * at mount time.
 */
function fakeContext(options = {}) {
	const {
		providers = [],
		section = {},
		events = [],
		settings = undefined,
		settingsReadyAfter = 0,
		services = {},
		persistence = undefined
	} = options;
	const disposers = [];
	const getCalls = [];
	let ticks = 0;

	const llm = { listConfigurableProviders: () => providers };
	const settingsService = settings ?? { get: () => section };

	const ctx = {
		logger: () => ({ info() {}, warn() {}, error() {} }),
		get(name) {
			getCalls.push(name);
			if (name === "llm") return llm;
			if (name === "settings") return ticks >= settingsReadyAfter ? settingsService : undefined;
			if (Object.hasOwn(services, name)) return services[name];
			return undefined;
		},
		inject(deps, callback) {
			// Cordis waits indefinitely for the service. The fake waits a bounded
			// number of turns instead: a real never-arriving service is a valid
			// scenario here, and an unbounded retry would starve the event loop
			// rather than let that test finish.
			let attempts = 0;
			const start = () => {
				const service = ctx.get(deps[0]);
				if (service !== undefined) return void callback({ ...ctx, [deps[0]]: service, on: () => {} });
				if (attempts++ < 10) setTimeout(start, 0);
			};
			start();
		},
		effect(fn) {
			const value = fn();
			const cleanup = typeof value?.next === "function" ? value.next().value : value;
			let active = true;
			const dispose = () => {
				if (!active) return;
				active = false;
				if (typeof cleanup === "function") return cleanup();
				return cleanup?.dispose?.();
			};
			disposers.push(dispose);
			return dispose;
		},
		on(event, handler) {
			if (event === "dispose") disposers.push(handler);
		},
		reflect: { provide() {} },
		sessionPersistence: persistence ?? {
			listSnapshots: async () => [{ header: { id: "s1" }, revision: `r${ticks}` }],
			readFrom: async (_id, from) => ({ events: from === 0 ? events : [] })
		}
	};

	return {
		ctx,
		getCalls,
		tick: () => ticks++,
		dispose: async () => {
			for (const dispose of disposers.toReversed()) await dispose();
		}
	};
}

const piAi = (route) => ({
	provider: route,
	displayName: route,
	settingsNs: "llm-pi-ai",
	settingsPath: ["providers", route]
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Capture every reflected service by its stable Cordis name. */
function captureServices(ctx) {
	const services = new Map();
	ctx.reflect.provide = (name, value) => void services.set(name, value);
	return services;
}

/** Wait a bounded number of event-loop turns for a dynamically imported seam. */
async function waitFor(predicate, turns = 100) {
	for (let turn = 0; turn < turns; turn++) {
		if (await predicate()) return true;
		await settle();
	}
	return false;
}

test("a relay is discovered and its traffic attributed, with no configuration at all", async () => {
	const { ctx } = fakeContext({
		providers: [piAi("api99")],
		section: { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } },
		events: [turn(1, "api99")]
	});
	const services = captureServices(ctx);

	apply(ctx, { database: ":memory:", sweepIntervalMs: 0, detect: async () => ({ billingAvailable: false }) });
	await settle();
	const api = services.get("tokenLedger");

	assert.deepEqual(
		api.sites().map((s) => s.id),
		["api.relay-one.example"]
	);
	assert.equal(api.bySite({}).find((r) => r.site === "api.relay-one.example")?.tokens, 1100);
});

test("apply preserves the exact legacy service without publishing an internal dashboard controller", async () => {
	const { ctx, dispose } = fakeContext({ events: [turn(1, "deepseek")] });
	const services = captureServices(ctx);

	apply(ctx, { database: ":memory:", sweepIntervalMs: 0, sweepOnStart: false });

	assert.deepEqual([...services.keys()], ["tokenLedger"]);
	const legacy = services.get("tokenLedger");
	assert.deepEqual(Object.keys(legacy).sort(), [
		"byDay",
		"byModel",
		"bySite",
		"diagnostics",
		"reindex",
		"sites",
		"store",
		"sweep",
		"totals"
	]);
	assert.ok(legacy.store instanceof LedgerStore, "the legacy raw-store escape hatch changed identity");
	assert.deepEqual(legacy.totals({}), legacy.store.totals({}));
	assert.deepEqual(legacy.byDay({}), legacy.store.byDay({}));
	assert.deepEqual(legacy.byModel({}), legacy.store.byModel({}));
	assert.deepEqual(legacy.bySite({}), legacy.store.bySite({}));
	assert.deepEqual(legacy.diagnostics(), legacy.store.diagnostics());

	assert.equal(services.has("tokenLedgerV1"), false);
	await dispose();
});

test("the legacy tokenledger command remains enabled by default", async () => {
	const registered = [];
	const commands = { register: (spec) => (registered.push(spec), () => {}) };
	const { ctx, dispose } = fakeContext({ services: { commands } });

	apply(ctx, { database: ":memory:", sweepIntervalMs: 0, sweepOnStart: false });

	assert.equal(registered.length, 1);
	assert.equal(registered[0].name, "tokenledger");
	assert.equal(typeof registered[0].handler, "function");
	await dispose();
});

test("Blue owns the only tokenledger command while its host is mounted", async () => {
	const legacy = new Set();
	const blue = new Set();
	const commands = {
		register(spec) {
			legacy.add(spec);
			return () => legacy.delete(spec);
		}
	};
	const bluePluginHost = {
		open() {
			return {
				ok: true,
				value: {
					api: {
						commands: {
							register(spec) {
								blue.add(spec);
								return { ok: true, value: { dispose: () => blue.delete(spec) } };
							}
						}
					},
					grants: [],
					unavailableOptional: []
				}
			};
		}
	};
	const { ctx, dispose } = fakeContext({ services: { commands, bluePluginHost } });

	apply(ctx, { database: ":memory:", sweepIntervalMs: 0, sweepOnStart: false });
	await settle();

	assert.equal(legacy.size, 0, "the text command remained registered beside Blue");
	assert.equal(blue.size, 1);
	assert.equal([...blue][0].id, "tokenledger");
	await dispose();
	assert.equal(legacy.size, 0);
	assert.equal(blue.size, 0);
});

test("disabling the legacy command leaves HTTP and the legacy service intact", async () => {
	const registered = [];
	const routes = [];
	const commands = { register: (spec) => (registered.push(spec), () => {}) };
	const httpServer = { register: (spec) => (routes.push(spec), () => {}) };
	const { ctx, dispose, getCalls } = fakeContext({ services: { commands, httpServer } });
	const published = captureServices(ctx);

	apply(ctx, {
		database: ":memory:",
		sweepIntervalMs: 0,
		sweepOnStart: false,
		commandEnabled: false
	});

	assert.equal(getCalls.includes("commands"), false, "a disabled command must not probe or invoke the registry");
	assert.deepEqual(registered, []);
	assert.deepEqual([...published.keys()], ["tokenLedger"]);
	assert.deepEqual(
		routes.map((route) => route.path).sort(),
		["/api/tokenledger/balance", "/api/tokenledger/usage", "/api/tokenledger/userauth"]
	);
	await dispose();
});

test("a fingerprint answer survives the next sweep", async () => {
	// The regression a real install showed as a site permanently reading 未识别.
	const { ctx, tick } = fakeContext({
		providers: [piAi("api99")],
		section: { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } }
	});
	const services = captureServices(ctx);

	let asks = 0;
	apply(ctx, {
		database: ":memory:",
		sweepIntervalMs: 0,
		// Off by default now; this test is about what happens once it is on.
		fingerprint: true,
		detect: async () => {
			asks++;
			return { billingAvailable: true, software: "newapi", confidence: 1 };
		}
	});
	await settle();
	const api = services.get("tokenLedger");
	assert.equal(api.sites()[0].type, "newapi");

	tick();
	await api.sweep();
	await settle();
	assert.equal(api.sites()[0].type, "newapi", "the rebuilt directory dropped what detection had learned");
	assert.equal(asks, 1, "and it must not re-interrogate the relay on every sweep");
});

test("a settings service that mounts after this plugin is still used", async () => {
	// The other real-install regression: `ctx.get('settings')` was sampled once
	// inside apply, before the service existed, so configuration could never be
	// saved even though discovery — which asks later — worked fine.
	const registered = [];
	const { ctx, tick } = fakeContext({
		providers: [piAi("api99")],
		section: { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } },
		settingsReadyAfter: 1,
		settings: {
			get: () => ({ providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } }),
			register: (ns) => {
				registered.push(ns);
				return { get: () => ({}), watch() {}, update: async () => {} };
			}
		}
	});

	const services = captureServices(ctx);

	apply(ctx, { database: ":memory:", sweepIntervalMs: 0, detect: async () => ({ billingAvailable: false }) });
	assert.deepEqual(registered, [], "nothing to register against yet");
	await settle();
	const api = services.get("tokenLedger");
	assert.deepEqual(api.sites(), [], "the startup sweep genuinely cannot see relays yet");

	tick(); // the settings service mounts, after this plugin already did
	// Let the waiting fiber notice it and the dynamic import resolve. Dynamic
	// import completion is not specified in a fixed number of timer turns, so
	// wait for the observable contract with a hard upper bound.
	await waitFor(() => registered.length > 0);

	assert.deepEqual(registered, ["tokenledger"], "the namespace was never registered");
	// Discovery reads provider profiles through that same service, so arriving
	// late must re-run it. Leaving it to the next timer tick showed a real
	// install "no relays" while its own report listed one.
	assert.deepEqual(
		api.sites().map((s) => s.id),
		["api.relay-one.example"],
		"the directory was left empty until the next sweep"
	);
});

test("a store that cannot be opened does not stop DSH from booting", () => {
	const { ctx } = fakeContext({});
	assert.doesNotThrow(() => apply(ctx, { database: "/nonexistent-dir/x/y.sqlite", sweepIntervalMs: 0 }));
});

test("a dashboard projection failure leaves the legacy service alive and the store Fiber-owned", async () => {
	const { ctx, dispose } = fakeContext({});
	const services = new Map();
	let closed = false;
	ctx.reflect.provide = (name, value) => {
		services.set(name, value);
		if (name !== "tokenLedger") return;
		value.store.byProject = () => {
			throw new Error("projection failed");
		};
		const close = value.store.close.bind(value.store);
		value.store.close = () => {
			closed = true;
			close();
		};
	};

	assert.doesNotThrow(() => apply(ctx, { database: ":memory:", sweepIntervalMs: 0, sweepOnStart: false }));
	assert.ok(services.get("tokenLedger").store instanceof LedgerStore);
	assert.equal(services.has("tokenLedgerV1"), false);
	await dispose();
	assert.equal(closed, true, "the fallback path leaked the host-owned store");
});

test("no llm and no settings still collects, attributing everything to direct", async () => {
	const { ctx } = fakeContext({ events: [turn(1, "whatever")] });
	ctx.get = () => undefined;
	const services = captureServices(ctx);

	apply(ctx, { database: ":memory:", sweepIntervalMs: 0 });
	await settle();
	const api = services.get("tokenLedger");

	assert.deepEqual(api.sites(), []);
	assert.equal(api.totals({}).outputTokens, 100, "usage accounting does not depend on knowing the site");
});

test("on a host with no settings namespace, panel credentials land in a file and survive a restart", async () => {
	// 0.1.7 dropped `settings.register`, so the namespace never registered and
	// every save from the panel was refused as "internal" — the New API wallet
	// dialog had stored nothing since the upgrade. A typed MiMo balance needs
	// the same seat.
	const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { PassThrough } = await import("node:stream");
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-cred-"));
	const credentialsPath = join(dir, "tokenledger-credentials.json");
	// A file from the cookie era: the session must not outlive the reader.
	writeFileSync(credentialsPath, JSON.stringify({ userAuth: {}, consoleCookies: { "https://platform.xiaomimimo.com": 'api-platform_serviceToken="st"; userId=123' } }));
	const xiaomi = {
		providers: [{ provider: "xiaomi", settingsNs: "llm-pi-ai", settingsPath: ["providers", "xiaomi"], declared: false }],
		section: { providers: { xiaomi: { apiKeyEnv: "XIAOMI_API_KEY" } } }
	};
	const call = async (route, method, url, body) => {
		const sent = [];
		const stream = new PassThrough();
		stream.end(body === undefined ? "" : JSON.stringify(body));
		await route.handler(
			Object.assign(stream, { method, url, headers: { host: "127.0.0.1", "x-tokenledger": "1" }, socket: { remoteAddress: "127.0.0.1" } }),
			{ writeHead: (s) => sent.push(s), end: (b) => sent.push(b) }
		);
		return { status: sent[0], body: JSON.parse(sent[1]) };
	};
	try {
		const routes = [];
		const httpServer = { register: (spec) => (routes.push(spec), () => {}) };
		const { ctx, dispose } = fakeContext({ ...xiaomi, services: { httpServer } });
		apply(ctx, { database: ":memory:", credentialsPath, sweepIntervalMs: 0, sweepOnStart: false });
		await settle();
		assert.equal(readFileSync(credentialsPath, "utf8").includes("serviceToken"), false, "the stored console cookie is dropped at start");
		const auth = routes.find((r) => r.path === "/api/tokenledger/userauth");
		const post = (body) => call(auth, "POST", auth.path, body);

		assert.deepEqual(await post({ kind: "manual", account: "xiaomi", amount: "abc" }), { status: 400, body: { ok: false, error: "invalid-amount" } });
		assert.equal((await post({ kind: "manual", account: "nobody", amount: 5 })).body.error, "invalid-account", "only an account read that way takes a typed figure");
		assert.equal((await post({ kind: "manual", account: "xiaomi", amount: "¥36.5" })).status, 200);
		assert.equal((await post({ origin: "https://relay.example", userId: 7, token: "tok" })).status, 200, "the New API dialog saves again");

		const onDisk = JSON.parse(readFileSync(credentialsPath, "utf8"));
		assert.equal(onDisk.manualBalances.xiaomi.amount, 36.5, "stored without the pasted sign");
		assert.equal(onDisk.manualBalances.xiaomi.currency, "CNY");
		assert.ok(Array.isArray(onDisk.manualBalances.xiaomi.baseline));
		assert.deepEqual(onDisk.userAuth["https://relay.example"], { userId: 7, token: "tok" });
		assert.equal(onDisk.consoleCookies, undefined);
		await dispose();

		// A restart reads them back; the balance route answers the typed figure.
		const again = [];
		const second = fakeContext({ ...xiaomi, services: { httpServer: { register: (spec) => (again.push(spec), () => {}) } } });
		apply(second.ctx, { database: ":memory:", credentialsPath, sweepIntervalMs: 0, sweepOnStart: false });
		await settle();
		const balanceRoute = again.find((r) => r.path === "/api/tokenledger/balance");
		const card = (await call(balanceRoute, "GET", "/api/tokenledger/balance?account=xiaomi")).body;
		assert.equal(card.fetched, true);
		assert.equal(card.manual, true);
		assert.equal(card.total, 36.5, "nothing spent since it was typed");
		const authAgain = again.find((r) => r.path === "/api/tokenledger/userauth");
		const origins = (await call(authAgain, "GET", "/api/tokenledger/userauth")).body.origins;
		assert.equal(origins["https://relay.example"].hasToken, true);
		await second.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a typed balance with a damaged baseline reads unfilled, not deeply negative", async () => {
	// A hand-edited credentials file (or a pre-baseline entry) can leave a
	// baseline that is not an array. Charging all history against the typed
	// figure would open deep negative; the card must ask for a retype instead.
	const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { PassThrough } = await import("node:stream");
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-badbase-"));
	const credentialsPath = join(dir, "tokenledger-credentials.json");
	writeFileSync(credentialsPath, JSON.stringify({ userAuth: {}, manualBalances: { xiaomi: { amount: 10, currency: "CNY", at: 1, baseline: "oops" } } }));
	const xiaomi = {
		providers: [{ provider: "xiaomi", settingsNs: "llm-pi-ai", settingsPath: ["providers", "xiaomi"], declared: false }],
		section: { providers: { xiaomi: { apiKeyEnv: "XIAOMI_API_KEY" } } }
	};
	const call = async (route, method, url, body) => {
		const sent = [];
		const stream = new PassThrough();
		stream.end(body === undefined ? "" : JSON.stringify(body));
		await route.handler(
			Object.assign(stream, { method, url, headers: { host: "127.0.0.1", "x-tokenledger": "1" }, socket: { remoteAddress: "127.0.0.1" } }),
			{ writeHead: (s) => sent.push(s), end: (b) => sent.push(b) }
		);
		return { status: sent[0], body: JSON.parse(sent[1]) };
	};
	try {
		const routes = [];
		const httpServer = { register: (spec) => (routes.push(spec), () => {}) };
		const { ctx, dispose } = fakeContext({ ...xiaomi, services: { httpServer } });
		apply(ctx, { database: ":memory:", credentialsPath, sweepIntervalMs: 0, sweepOnStart: false });
		await settle();
		const balance = routes.find((r) => r.path === "/api/tokenledger/balance");
		const card = (await call(balance, "GET", "/api/tokenledger/balance?account=xiaomi")).body;
		assert.equal(card.fetched, false, "a damaged baseline is unentered, not a deficit");
		assert.equal(card.reason, "no-manual-balance");
		await dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the 阿里云 AccessKey is stored once, shown masked, and signs the 百炼 card's read", async () => {
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { PassThrough } = await import("node:stream");
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-ak-"));
	const credentialsPath = join(dir, "tokenledger-credentials.json");
	const call = async (route, method, url, body) => {
		const sent = [];
		const stream = new PassThrough();
		stream.end(body === undefined ? "" : JSON.stringify(body));
		await route.handler(
			Object.assign(stream, { method, url, headers: { host: "127.0.0.1", "x-tokenledger": "1" }, socket: { remoteAddress: "127.0.0.1" } }),
			{ writeHead: (s) => sent.push(s), end: (b) => sent.push(b) }
		);
		return { status: sent[0], body: JSON.parse(sent[1]), raw: sent[1] };
	};
	const asked = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		asked.push({ url: String(url), init });
		return { ok: true, status: 200, json: async () => ({ Code: "200", Success: true, Data: { AvailableAmount: "42.00", AvailableCashAmount: "42.00", Currency: "CNY" } }) };
	};
	try {
		const routes = [];
		const { ctx, dispose } = fakeContext({
			providers: [{ provider: "ali", settingsNs: "llm-pi-ai", settingsPath: ["providers", "ali"] }],
			section: { providers: { ali: { baseURL: "https://llm-7ub39ukw6sjudiit.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "ALI_KEY" } } },
			services: { httpServer: { register: (spec) => (routes.push(spec), () => {}) } }
		});
		apply(ctx, { database: ":memory:", credentialsPath, sweepIntervalMs: 0, sweepOnStart: false });
		await settle();
		const auth = routes.find((r) => r.path === "/api/tokenledger/userauth");
		const balance = routes.find((r) => r.path === "/api/tokenledger/balance");

		assert.equal((await call(balance, "GET", "/api/tokenledger/balance?account=ali")).body.hint, "aliyun-ak-missing");
		assert.deepEqual(await call(auth, "POST", auth.path, { kind: "aliyun-access-key", accessKeyId: "sk-not-an-ak", accessKeySecret: "x" }).then((r) => r.body), {
			ok: false,
			error: "invalid-access-key"
		});
		const secret = "ExampleSecretValue0123456789ab";
		assert.equal((await call(auth, "POST", auth.path, { kind: "aliyun-access-key", accessKeyId: "LTAI5tExampleKeyId01", accessKeySecret: secret })).status, 200);
		// The same ID with a blank secret keeps the stored one.
		assert.equal((await call(auth, "POST", auth.path, { kind: "aliyun-access-key", accessKeyId: "LTAI5tExampleKeyId01", accessKeySecret: "" })).status, 200);

		const view = await call(auth, "GET", auth.path);
		assert.deepEqual(view.body.aliyun, { accessKeyId: "LTAI…Id01", hasSecret: true });
		assert.equal(view.raw.includes(secret), false, "the secret never crosses back out");
		assert.equal(view.raw.includes("LTAI5tExampleKeyId01"), false, "nor the whole ID");
		assert.deepEqual(JSON.parse(readFileSync(credentialsPath, "utf8")).aliyunAccessKey, { accessKeyId: "LTAI5tExampleKeyId01", accessKeySecret: secret });

		const card = (await call(balance, "GET", "/api/tokenledger/balance?account=ali")).body;
		assert.equal(card.fetched, true);
		assert.equal(card.total, 42);
		assert.equal(new URL(asked.at(-1).url).host, "business.aliyuncs.com");

		assert.equal((await call(auth, "POST", auth.path, { kind: "aliyun-access-key", remove: true })).status, 200);
		assert.equal(JSON.parse(readFileSync(credentialsPath, "utf8")).aliyunAccessKey, undefined);
		assert.equal((await call(auth, "GET", auth.path)).body.aliyun, null);
		await dispose();
	} finally {
		globalThis.fetch = realFetch;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rebuild that cannot list the logs keeps the old index instead of blanking the panel", async () => {
	// The reset discards the good index AND the checkpoints, so it must not
	// run blind: when the host cannot list its sessions, the sweep that
	// follows finds nothing, and any session whose logs are already gone is
	// lost for good. A host that cannot be listed keeps its old index.
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-rebuild-"));
	const database = join(dir, "ledger.sqlite");
	let api;
	let api2;
	try {
		// First generation: a healthy host folds one turn.
		const first = fakeContext({ events: [turn(1, "deepseek")] });
		const firstServices = captureServices(first.ctx);
		apply(first.ctx, { database, sweepIntervalMs: 0, sweepOnStart: false, detect: async () => ({ billingAvailable: false }) });
		await settle();
		api = firstServices.get("tokenLedger");
		await api.sweep();
		assert.equal(api.totals({}).inputTokens, 1000, "the first sweep lands rows");
		await first.dispose();

		// Second generation: the relay set moved (a relay appears), but the
		// host cannot list its sessions anymore. The rebuild must not run.
		const broken = {
			listSnapshots: async () => {
				throw new Error("locked");
			},
			readFrom: async () => ({ events: [] })
		};
		const second = fakeContext({
			providers: [piAi("api99")],
			section: { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } },
			persistence: broken
		});
		const secondServices = captureServices(second.ctx);
		apply(second.ctx, {
			database,
			sweepIntervalMs: 0,
			sweepOnStart: false,
			detect: async () => ({ billingAvailable: false }),
			relays: { api99: "https://api.relay-one.example/v1" }
		});
		await settle();
		api2 = secondServices.get("tokenLedger");
		await api2.sweep();
		assert.equal(
			api2.totals({}).inputTokens,
			1000,
			"the unreadable host keeps the old index; a blind reset would have blanked it"
		);
		await second.dispose();
	} finally {
		// Close both stores before removing the directory: Windows locks the
		// sqlite file while a connection is open and rmSync would hit EBUSY.
		try {
			api?.store?.close();
		} catch {}
		try {
			api2?.store?.close();
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rebuild keeps the cumulative total whole while it runs, then drops sessions whose logs are gone", async () => {
	// 2026-10-20 on a real install: a relay change rebuilt the index, the
	// re-fold took a minute, and every panel open or range click in between
	// read a store that had been emptied — the cumulative total climbed a
	// little on each click. Mid-rebuild the old rows must still be there.
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-rebuild-"));
	const database = join(dir, "ledger.sqlite");
	const logs = { s1: [turn(1, "api99")], s2: [turn(1, "api99")], s3: [turn(1, "api99")] };
	const persistenceOf = (ids, readFrom) => ({
		listSnapshots: async () => ids.map((id) => ({ header: { id }, revision: "r1" })),
		readFrom
	});
	let api;
	let api2;
	try {
		// First generation: no relay known, three sessions land as unrouted.
		const first = fakeContext({
			persistence: persistenceOf(["s1", "s2", "s3"], async (id, from) => ({ events: from === 0 ? logs[id] : [] }))
		});
		const firstServices = captureServices(first.ctx);
		apply(first.ctx, { database, sweepIntervalMs: 0, sweepOnStart: false, detect: async () => ({ billingAvailable: false }) });
		await settle();
		api = firstServices.get("tokenLedger");
		await api.sweep();
		assert.equal(api.totals({}).inputTokens, 3000);
		await first.dispose();

		// Second generation: the relay is configured, s3's log was deleted, and
		// s2's read is held open so the rebuild can be observed half way.
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		let s2Waiting = false;
		const second = fakeContext({
			providers: [piAi("api99")],
			section: { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } },
			persistence: persistenceOf(["s1", "s2"], async (id, from) => {
				if (id === "s2") {
					s2Waiting = true;
					await gate;
				}
				return { events: from === 0 ? logs[id] : [] };
			})
		});
		const secondServices = captureServices(second.ctx);
		apply(second.ctx, {
			database,
			sweepIntervalMs: 0,
			sweepOnStart: false,
			detect: async () => ({ billingAvailable: false }),
			relays: { api99: "https://api.relay-one.example/v1" }
		});
		await settle();
		api2 = secondServices.get("tokenLedger");
		const rebuild = api2.sweep();
		assert.ok(await waitFor(() => s2Waiting), "the rebuild reaches the held session");

		assert.equal(api2.totals({}).inputTokens, 3000, "mid-rebuild the old rows still count; an emptied store read 1000 here");
		assert.equal(api2.totals({}, "api.relay-one.example").inputTokens, 1000, "s1 is already re-attributed");

		release();
		await rebuild;
		assert.equal(api2.totals({}).inputTokens, 2000, "s3's log is gone, so its rows go — as reset() would have lost them");
		assert.equal(api2.totals({}, "api.relay-one.example").inputTokens, 2000, "every surviving session moved to the relay");
		assert.equal(api2.store.diagnostics().sessionsTracked, 2);
		await second.dispose();
	} finally {
		try {
			api?.store?.close();
		} catch {}
		try {
			api2?.store?.close();
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rebuild whose listing fails after the probe keeps every session and finishes on the next sweep", async () => {
	// The readability probe and the sweep list separately. If the second one
	// fails, nothing was re-read, and treating every session as unfolded would
	// blank the ledger the probe exists to protect.
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-rebuild-"));
	const database = join(dir, "ledger.sqlite");
	const readFrom = async (_id, from) => ({ events: from === 0 ? [turn(1, "api99")] : [] });
	const list = async () => [{ header: { id: "s1" }, revision: "r1" }, { header: { id: "s2" }, revision: "r1" }];
	let api;
	let api2;
	try {
		const first = fakeContext({ persistence: { listSnapshots: list, readFrom } });
		const firstServices = captureServices(first.ctx);
		apply(first.ctx, { database, sweepIntervalMs: 0, sweepOnStart: false, detect: async () => ({ billingAvailable: false }) });
		await settle();
		api = firstServices.get("tokenLedger");
		await api.sweep();
		assert.equal(api.totals({}).inputTokens, 2000);
		await first.dispose();

		let calls = 0;
		const second = fakeContext({
			providers: [piAi("api99")],
			section: { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } },
			persistence: {
				// Probe succeeds, the sweep's own listing fails, then the host recovers.
				listSnapshots: async () => {
					if (++calls === 2) throw new Error("locked");
					return list();
				},
				readFrom
			}
		});
		const secondServices = captureServices(second.ctx);
		apply(second.ctx, {
			database,
			sweepIntervalMs: 0,
			sweepOnStart: false,
			detect: async () => ({ billingAvailable: false }),
			relays: { api99: "https://api.relay-one.example/v1" }
		});
		await settle();
		api2 = secondServices.get("tokenLedger");
		await api2.sweep();
		assert.equal(api2.totals({}).inputTokens, 2000, "a failed listing re-read nothing, so nothing may be dropped");

		await api2.sweep();
		assert.equal(api2.totals({}).inputTokens, 2000);
		assert.equal(api2.totals({}, "api.relay-one.example").inputTokens, 2000, "the next sweep finishes the rebuild");
		await second.dispose();
	} finally {
		try {
			api?.store?.close();
		} catch {}
		try {
			api2?.store?.close();
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed sweep is visible in diagnostics instead of vanishing into the log", async () => {
	// Sweep failures are silent by design (a failed collection must not break
	// the panel), but "the panel is not growing and nothing says why" needs
	// an answer somewhere `/tokenledger diagnostics` can show.
	const { ctx, dispose } = fakeContext({
		events: [turn(1, "deepseek")],
		persistence: {
			listSnapshots: async () => [{ header: { id: "s1" }, revision: "r1" }],
			readFrom: async () => {
				throw new Error("log unreadable");
			}
		}
	});
	const services = captureServices(ctx);
	apply(ctx, { database: ":memory:", sweepIntervalMs: 0, sweepOnStart: false, detect: async () => ({ billingAvailable: false }) });
	await settle();
	const api = services.get("tokenLedger");
	const stats = await api.sweep();
	assert.equal(stats.failed, 1);
	const d = api.diagnostics();
	assert.equal(d.lastSweepFailed, 1);
	assert.ok(typeof d.lastSweepError === "string" && d.lastSweepError.length > 0);
	assert.ok(typeof d.lastSweepAt === "number");
	await dispose();
});
