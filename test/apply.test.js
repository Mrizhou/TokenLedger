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
		services = {}
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
			const it = fn();
			if (typeof it?.next === "function") it.next();
		},
		on(event, handler) {
			if (event === "dispose") disposers.push(handler);
		},
		reflect: { provide() {} },
		sessionPersistence: {
			listSnapshots: async () => [{ header: { id: "s1" }, revision: `r${ticks}` }],
			readFrom: async (_id, from) => ({ events: from === 0 ? events : [] })
		}
	};

	return { ctx, getCalls, tick: () => ticks++, dispose: () => Promise.all(disposers.map((d) => d())) };
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

test("apply preserves the exact legacy service and publishes a separate V1 face", async () => {
	const { ctx, dispose } = fakeContext({ events: [turn(1, "deepseek")] });
	const services = captureServices(ctx);

	apply(ctx, { database: ":memory:", sweepIntervalMs: 0, sweepOnStart: false });

	assert.deepEqual([...services.keys()], ["tokenLedger", "tokenLedgerV1"]);
	const legacy = services.get("tokenLedger");
	const v1 = services.get("tokenLedgerV1");
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

	for (const key of ["store", "sweep", "totals", "byDay", "byModel", "bySite", "sites", "diagnostics", "reindex"]) {
		assert.equal(v1[key], undefined, `tokenLedgerV1 leaked the legacy ${key} member`);
	}
	assert.equal(typeof v1.current, "function");
	assert.equal(typeof v1.subscribe, "function");
	assert.equal(typeof v1.execute, "function");
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

test("disabling the legacy command leaves HTTP and public services intact", async () => {
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
	assert.deepEqual([...published.keys()], ["tokenLedger", "tokenLedgerV1"]);
	assert.deepEqual(
		routes.map((route) => route.path).sort(),
		["/api/tokenledger/balance", "/api/tokenledger/usage", "/api/tokenledger/userauth"]
	);
	await dispose();
});

test("tokenLedgerV1 is immutable, actionable, and exposes no store or credentials", async () => {
	const { ctx, dispose } = fakeContext({ events: [turn(1, "deepseek")] });
	const services = captureServices(ctx);

	apply(ctx, {
		database: ":memory:",
		sweepIntervalMs: 0,
		sweepOnStart: false,
		userAuth: { "https://relay.example": { userId: 42, token: "top-secret" } }
	});
	const api = services.get("tokenLedgerV1");

	assert.equal(api.store, undefined, "the mutable SQLite owner must not cross the service boundary");
	assert.equal(api.current().revision, 1);
	assert.equal(Object.isFrozen(api.current()), true);
	const replayed = [];
	api.subscribe((snapshot) => replayed.push(snapshot.revision));
	const refreshed = await api.execute({
		requestId: "refresh",
		expectedRevision: 1,
		action: { type: "usage.refresh" }
	});
	assert.equal(refreshed.status, "applied");
	assert.equal(refreshed.snapshot.totals.selected.tokens, 1100);
	assert.deepEqual(replayed, [1, 2]);
	const exported = await api.execute({
		requestId: "export",
		expectedRevision: 2,
		action: { type: "usage.export", format: "json" }
	});
	assert.equal(exported.revision, 2, "a readonly action does not invent a new projection revision");
	assert.equal(exported.data.format, "json");
	assert.ok(exported.data.content.includes("deepseek"));
	await assert.rejects(
		api.execute({
			requestId: "no-settings",
			action: { type: "settings.relay.set", route: "relay", baseUrl: "https://relay.example/v1" }
		}),
		(error) => error.code === "UNAVAILABLE"
	);

	const configuration = await api.getConfiguration({ requestId: "configuration" });
	assert.equal(configuration.value.wallets["https://relay.example"].hasToken, true);
	assert.equal(JSON.stringify(configuration).includes("top-secret"), false);
	assert.equal(Object.isFrozen(configuration.value), true);

	await dispose();
	assert.throws(() => api.subscribe(() => {}), (error) => error.code === "UNAVAILABLE");
});

test("structured settings and balance actions use the existing domain seams", async () => {
	const updates = [];
	const mutations = [];
	let section = {};
	let watch;
	const settings = {
		get: () => ({}),
		register: () => ({
			get: () => section,
			watch: (listener) => void (watch = listener),
			update: async (patch) => {
				updates.push(patch);
				section = { ...section, ...patch };
				watch?.(section);
			}
		}),
		mutate: async (_namespace, operations) => void mutations.push(...operations)
	};
	const { ctx, dispose } = fakeContext({ settings });
	const services = captureServices(ctx);
	apply(ctx, { database: ":memory:", sweepIntervalMs: 0, sweepOnStart: false });
	const api = services.get("tokenLedgerV1");
	assert.equal(
		await waitFor(async () => (await api.getConfiguration({ requestId: `ready-${Date.now()}` })).value.settings.available === true),
		true,
		"settings namespace did not become available"
	);

	const execute = (requestId, action) => api.execute({
		requestId,
		expectedRevision: api.current().revision,
		action
	});
	await execute("relay-set", { type: "settings.relay.set", route: "relay", baseUrl: "https://relay.example/v1" });
	assert.deepEqual(updates.at(-1).relays, { relay: "https://relay.example/v1" });
	await execute("relay-remove", { type: "settings.relay.remove", route: "relay" });
	assert.deepEqual(mutations.at(-1), { op: "unset", path: ["relays", "relay"] });

	await execute("wallet-set", {
		type: "settings.wallet.set",
		origin: "https://relay.example/v1",
		userId: 42,
		token: "top-secret"
	});
	const configuration = await api.getConfiguration({ requestId: "configured-wallet" });
	assert.equal(configuration.value.wallets["https://relay.example"].hasToken, true);
	assert.equal(JSON.stringify(configuration).includes("top-secret"), false);
	const balance = await execute("balance", { type: "balance.refresh" });
	assert.equal(balance.data.reason, "no-provider-directory");
	assert.equal(balance.revision, api.current().revision, "balance is a readonly action");

	await execute("wallet-clear", { type: "settings.wallet.clear", origin: "https://relay.example" });
	assert.deepEqual(mutations.at(-1), { op: "unset", path: ["userAuth", "https://relay.example"] });
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
	const publicApi = services.get("tokenLedgerV1");
	const initialRevision = publicApi.current().revision;
	assert.deepEqual(api.sites(), [], "the startup sweep genuinely cannot see relays yet");

	tick(); // the settings service mounts, after this plugin already did
	// Let the waiting fiber notice it and the dynamic import resolve. Dynamic
	// import completion is not specified in a fixed number of timer turns, so
	// wait for the observable contract with a hard upper bound.
	await waitFor(() => registered.length > 0);

	assert.deepEqual(registered, ["tokenledger"], "the namespace was never registered");
	assert.ok(publicApi.current().revision > initialRevision, "settings readiness did not advance the public revision");
	const configuration = await publicApi.getConfiguration({ requestId: "late-settings-ready" });
	assert.equal(configuration.revision, publicApi.current().revision);
	assert.equal(configuration.value.settings.available, true);
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

test("a V1 projection failure leaves the legacy service alive and the store Fiber-owned", async () => {
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
