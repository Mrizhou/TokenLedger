/** TokenLedger Blue entry lifecycle and action contract tests. */

import assert from "node:assert/strict";
import test from "node:test";
import { isProxy } from "node:util/types";

import { Context, Service } from "@deepseek-ai/cordis";
import { apply, inject, name } from "../lib/index.js";

function usage(tokens = 100, overrides = {}) {
	return {
		version: "0.1.0",
		generatedAt: Date.now(),
		timeZone: { id: "UTC" },
		range: {},
		totals: { tokens, requests: 2, inputTokens: tokens - 10, outputTokens: 10 },
		windows: { today: { tokens: 10 }, month: { tokens: 50 }, all: { tokens } },
		days: [{ day: "2026-08-30", tokens }],
		activity: [{ day: "2026-08-30", tokens }],
		activityModels: [{ day: "2026-08-30", model: "fixture/model", tokens }],
		models: [{ model: "fixture/model", tokens, requests: 2 }],
		sites: [{ site: "direct", tokens: 10 }, { site: "relay.example", tokens: tokens - 10 }],
		projects: [{ project: "/fixture", label: "Fixture", path: "/fixture", tokens }],
		providers: [{ provider: "fixture", tokens }],
		directory: [{ id: "relay.example", type: "newapi", routes: ["relay"] }],
		accounts: [{ id: "account-1", displayName: "Fixture account", origin: "https://relay.example" }],
		diagnostics: { sessions: 1, unattributedRows: 0 },
		priced: { currency: "CNY", totals: { CNY: 0.1 }, rows: [{ model: "fixture/model", cost: 0.1, currency: "CNY" }] },
		...overrides
	};
}

function summary(revision = 1, tokens = 100) {
	const view = usage(tokens);
	return {
		revision,
		capturedAt: view.generatedAt,
		version: view.version,
		timeZone: view.timeZone,
		totals: { selected: view.totals, today: view.windows.today, month: view.windows.month, all: view.windows.all },
		activity: view.activity,
		models: view.models,
		sites: view.sites,
		projects: view.projects,
		providers: view.providers,
		directory: view.directory,
		accounts: view.accounts,
		diagnostics: view.diagnostics,
		priced: view.priced,
		freshness: { lastSweepAt: view.generatedAt }
	};
}

function configuration() {
	return {
		version: "0.1.0",
		settings: { available: true },
		relays: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`route-${String(index)}`, { baseUrl: `https://relay-${String(index)}.example`, type: "newapi" }])),
		officialOrigins: [],
		fingerprint: true,
		sweepIntervalMs: 60_000,
		sweepOnStart: true,
		endpoints: [],
		rates: null,
		wallets: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`https://relay-${String(index)}.example`, { userId: index + 1, hasToken: true }])),
		walletCache: {}
	};
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function makeService(options = {}) {
	let revision = options.revision ?? 1;
	let tokens = options.tokens ?? 100;
	let listener;
	let queryOverride;
	let collectionOverride;
	let configurationOverride;
	let actionOverride;
	const calls = { queries: [], collections: [], actions: [], configurations: 0, subscribe: 0, dispose: 0 };
	const service = {
		current() {
			return summary(revision, tokens);
		},
		subscribe(next, { signal } = {}) {
			calls.subscribe += 1;
			listener = next;
			next(summary(revision, tokens));
			const dispose = () => {
				calls.dispose += 1;
				if (listener === next) listener = undefined;
			};
			signal?.addEventListener("abort", dispose, { once: true });
			return dispose;
		},
		async queryUsage(request, { signal } = {}) {
			calls.queries.push({ request, signal });
			if (queryOverride !== undefined) return queryOverride(request, signal);
			return { revision, value: options.view ?? usage(tokens, { range: request.range, site: request.site }) };
		},
		async queryCollection(request, { signal } = {}) {
			calls.collections.push({ request, signal });
			if (collectionOverride !== undefined) return collectionOverride(request, signal);
			const values = options.collections?.[request.collection] ?? [];
			const filtered = request.day === undefined ? values : values.filter((value) => value.day === request.day);
			const offset = Math.min(request.offset ?? 0, filtered.length);
			const items = filtered.slice(offset, offset + (request.limit ?? 16));
			return {
				revision,
				value: {
					collection: request.collection,
					...(request.day === undefined ? {} : { day: request.day }),
					offset,
					sourceCount: filtered.length,
					returnedCount: items.length,
					omittedCount: filtered.length - items.length,
					omittedBefore: offset,
					omittedAfter: filtered.length - offset - items.length,
					items
				}
			};
		},
		async getConfiguration(request, { signal } = {}) {
			calls.configurations += 1;
			if (configurationOverride !== undefined) return configurationOverride(request, signal);
			return { revision, value: configuration() };
		},
		async execute(request, { signal } = {}) {
			calls.actions.push({ request, signal });
			if (actionOverride !== undefined) return actionOverride(request, signal);
			const type = request.action.type;
			let data;
			if (type === "balance.refresh") data = {
				fetched: true,
				total: 12.5,
				used: 3,
				currency: "CNY",
				scheme: "newapi",
				windows: Array.from({ length: 20 }, (_, index) => ({ kind: `window-${String(index)}`, usedPercent: index }))
			};
			if (type === "usage.export") data = { format: request.action.format, content: "x".repeat(13_000), fileName: `tokenledger.${request.action.format}`, mimeType: request.action.format === "csv" ? "text/csv" : "application/json" };
			if (type !== "balance.refresh" && type !== "usage.export") {
				revision += 1;
				tokens += 1;
				listener?.(summary(revision, tokens));
			}
			return { requestId: request.requestId, revision, status: "applied", message: `${type} done`, ...(data === undefined ? {} : { data }), snapshot: summary(revision, tokens) };
		}
	};
	return {
		service,
		calls,
		emit(nextRevision, nextTokens) {
			revision = nextRevision;
			tokens = nextTokens;
			listener?.(summary(revision, tokens));
		},
		setQueryOverride(value) { queryOverride = value; },
		setCollectionOverride(value) { collectionOverride = value; },
		setConfigurationOverride(value) { configurationOverride = value; },
		setActionOverride(value) { actionOverride = value; },
		get listener() { return listener; }
	};
}

function makeHost(options = {}) {
	const registered = { commands: [], status: [], panes: [], overlays: [], notifications: [] };
	const handles = { commands: [], overlays: [] };
	let sessionId = options.sessionId ?? "session-1";
	let sessionListener;
	const registration = (value) => ({
		value,
		disposed: false,
		refreshes: 0,
		refresh() { this.refreshes += 1; return { ok: true, value: undefined }; },
		dispose() { this.disposed = true; },
		close() { this.closed = true; },
		setHidden() { return { ok: true, value: undefined }; }
	});
	const api = {
		commands: { register(value) { registered.commands.push(value); const handle = registration(value); handles.commands.push(handle); return { ok: true, value: handle }; } },
		overlays: { open(value) { registered.overlays.push(value); const handle = registration(value); handles.overlays.push(handle); return { ok: true, value: handle }; } },
		...(options.notifications === false ? {} : { notifications: { publish(value) { registered.notifications.push(value); return { ok: true, value: undefined }; } } }),
		...(options.session === false ? {} : {
			session: {
				current() { return sessionId === null ? null : { revision: 1, id: sessionId, status: "idle", mode: "normal", cwd: "/fixture" }; },
				subscribe(next) {
					sessionListener = next;
					next(this.current());
					return { dispose() { if (sessionListener === next) sessionListener = undefined; } };
				}
			}
		})
	};
	return {
		api,
		registered,
		handles,
		openFailure: options.openFailure,
		open(_ctx, manifest) {
			if (options.openFailure) return { ok: false, code: "BLUE_CAPABILITY_DENIED", message: "denied" };
			assert.equal(manifest.id, name);
			return { ok: true, value: { api, grants: [], unavailableOptional: [] } };
		},
		switchSession(next) {
			sessionId = next;
			sessionListener?.(next === null ? null : { revision: 2, id: next, status: "idle", mode: "normal", cwd: "/fixture" });
		},
		get sessionListener() { return sessionListener; }
	};
}

function makeContext(service, host = makeHost()) {
	const rootCleanups = [];
	let childCleanups = [];
	let injection;
	let currentService = service;
	const base = {
		bluePluginHost: { open: host.open.bind(host) },
		effect(factory) {
			const cleanup = factory();
			rootCleanups.push(cleanup);
			return cleanup;
		},
		inject(dependencies, callback) {
			assert.deepEqual(dependencies, ["tokenLedgerV1"]);
			injection = callback;
			if (currentService !== undefined) mount(currentService);
			return { dispose() { unmount(); } };
		}
	};
	function mount(nextService) {
		childCleanups = [];
		const scoped = {
			...base,
			tokenLedgerV1: nextService,
			effect(factory) {
				const cleanup = factory();
				childCleanups.push(cleanup);
				return cleanup;
			}
		};
		injection?.(scoped);
	}
	function unmount() {
		for (const cleanup of childCleanups.splice(0).reverse()) cleanup?.();
	}
	return {
		context: base,
		host,
		provide(nextService) {
			unmount();
			currentService = nextService;
			if (nextService !== undefined) mount(nextService);
		},
		dispose() {
			unmount();
			for (const cleanup of rootCleanups.splice(0).reverse()) cleanup?.();
		},
		get childCleanups() { return childCleanups; }
	};
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const signal = () => new AbortController().signal;

async function openDashboard(context, args = []) {
	const commands = context.host.registered.commands;
	assert.equal(commands.length, 1, "Blue 安装必须只贡献一个 TokenLedger 命令");
	assert.equal(commands[0].id, "tokenledger");
	const result = await commands[0].execute(args, { signal: signal(), userGesture: {} });
	assert.equal(result.ok, true);
	const surface = context.host.registered.overlays.at(-1);
	assert.ok(surface, "命令必须打开 TokenLedger 浮层");
	return surface;
}

test("entry identity and dependencies keep tokenLedgerV1 dynamically optional", () => {
	assert.equal(name, "@dsh-blue/tokenledger");
	assert.deepEqual(inject, ["bluePluginHost"]);
});

test("real Cordis trace proxies remain admissible without weakening public data copies", async () => {
	const host = makeHost({ session: false, notifications: false });
	class TracedBluePluginHost extends Service {
		constructor(ctx) {
			super(ctx, "bluePluginHost");
		}
		open(...args) {
			return host.open(...args);
		}
	}
	const ctx = new Context();
	await ctx.plugin(TracedBluePluginHost);
	assert.equal(isProxy(ctx.get("bluePluginHost")), true);
	await ctx.plugin({ name, inject, apply });
	await tick();
	assert.equal(host.registered.commands.length, 1);
	assert.equal(host.registered.status.length, 0);
	assert.equal(host.registered.panes.length, 0);
	assert.equal(host.registered.overlays.length, 0);
	await ctx.fiber.dispose();
});

test("service replay stays command-only until the overlay drives range/site/detail workflows", async () => {
	const fixture = makeService();
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const { registered } = context.host;
	assert.equal(registered.commands.length, 1);
	assert.equal(registered.status.length, 0);
	assert.equal(registered.panes.length, 0);
	assert.equal(registered.overlays.length, 0);
	assert.equal(fixture.calls.subscribe, 1);
	assert.equal(fixture.calls.queries.length >= 1, true);

	const surface = await openDashboard(context);
	assert.match(JSON.stringify(surface.render()), /当前用量/);
	await surface.onEvent({ kind: "selection-change", controlId: "tokenledger.range-list", value: "range:today" }, { signal: signal() });
	assert.deepEqual(fixture.calls.queries.at(-1).request.range, { from: fixture.calls.queries.at(-1).request.range.from });
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "breakdown" }, { signal: signal() });
	await surface.onEvent({ kind: "selection-change", controlId: "tokenledger.sites", value: "site:1" }, { signal: signal() });
	assert.match(JSON.stringify(surface.render()), /已选站点/);
	await surface.onEvent({ kind: "activate", controlId: "tokenledger.filter-selected-site" }, { signal: signal() });
	assert.equal(fixture.calls.queries.at(-1).request.site, "relay.example");
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "overview" }, { signal: signal() });

	fixture.emit(2, 222);
	assert.match(JSON.stringify(surface.render()), /222/);
	fixture.emit(2, 999);
	assert.doesNotMatch(JSON.stringify(surface.render()), /999/);
	context.dispose();
	assert.equal(fixture.listener, undefined);
});

test("boundary collections continue through service-owned pages without accumulating an unbounded model", async () => {
	const models = Array.from({ length: 40 }, (_, index) => ({
		model: `model-${String(index)}`,
		tokens: 1_000 - index,
		requests: index + 1,
		pricing: { cost: index / 10, currency: "CNY" }
	}));
	const first = usage(100, {
		models: models.slice(0, 16),
		collectionBounds: {
			models: { sourceCount: 40, returnedCount: 16, omittedCount: 24 }
		},
		boundaryOmissions: [],
		boundaryOmissionOverflow: 0,
		boundaryTruncated: true
	});
	const fixture = makeService({ view: first, collections: { models } });
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "breakdown" }, { signal: signal() });
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.breakdown.tabs", tabId: "models" }, { signal: signal() });
	assert.match(JSON.stringify(surface.render()), /初始边界外还有 24 条/);
	assert.match(JSON.stringify(surface.render()), /第 1 \/ 3 页/);

	assert.equal((await surface.onEvent({ kind: "activate", controlId: "tokenledger.page.models.next" }, { signal: signal() })).ok, true);
	assert.equal(fixture.calls.collections.at(-1).request.offset, 16);
	assert.equal(fixture.calls.collections.at(-1).request.limit, 16);
	assert.equal(fixture.calls.collections.at(-1).request.sortBy, "tokens");
	assert.match(JSON.stringify(surface.render()), /model-31/);

	assert.equal((await surface.onEvent({ kind: "activate", controlId: "tokenledger.page.models.next" }, { signal: signal() })).ok, true);
	assert.equal(fixture.calls.collections.at(-1).request.offset, 32);
	assert.match(JSON.stringify(surface.render()), /model-39/);
	await surface.onEvent({ kind: "selection-change", controlId: "tokenledger.models", value: "model:39" }, { signal: signal() });
	assert.match(JSON.stringify(surface.render()), /已选模型/);

	assert.equal((await surface.onEvent({ kind: "submit", controlId: "tokenledger.model-sort-form", values: { sort: "cost" } }, { signal: signal() })).ok, true);
	assert.equal(fixture.calls.collections.at(-1).request.offset, 0);
	assert.equal(fixture.calls.collections.at(-1).request.sortBy, "cost");
	context.dispose();
});

test("selecting another activity day resets only the scoped model continuation", async () => {
	const days = ["2026-08-29", "2026-08-30"];
	const activityModels = days.flatMap((day) => Array.from({ length: 20 }, (_, index) => ({
		day,
		model: `${day}/model-${String(index)}`,
		tokens: 1_000 - index,
		requests: index + 1
	})));
	const first = usage(100, {
		activity: days.map((day, index) => ({ day, tokens: 100 - index, requests: 1 })),
		activityModels: activityModels.filter((_value, index) => index % 20 < 8),
		collectionBounds: {
			activityModels: { sourceCount: 40, returnedCount: 16, omittedCount: 24 }
		},
		boundaryOmissions: [],
		boundaryOmissionOverflow: 0,
		boundaryTruncated: true
	});
	const fixture = makeService({ view: first, collections: { activityModels } });
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "breakdown" }, { signal: signal() });
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.breakdown.tabs", tabId: "activity" }, { signal: signal() });

	assert.equal((await surface.onEvent({ kind: "selection-change", controlId: "tokenledger.activity", value: "activity:0" }, { signal: signal() })).ok, true);
	assert.equal(fixture.calls.collections.at(-1).request.day, "2026-08-30");
	assert.equal((await surface.onEvent({ kind: "activate", controlId: "tokenledger.page.activity-models.next" }, { signal: signal() })).ok, true);
	assert.equal(fixture.calls.collections.at(-1).request.offset, 16);

	assert.equal((await surface.onEvent({ kind: "selection-change", controlId: "tokenledger.activity", value: "activity:1" }, { signal: signal() })).ok, true);
	assert.equal(fixture.calls.collections.at(-1).request.day, "2026-08-29");
	assert.equal(fixture.calls.collections.at(-1).request.offset, 0);
	context.dispose();
});

test("balance, export, refresh, and rebuild actions stay service-owned", async () => {
	const fixture = makeService();
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);

	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "accounts" }, { signal: signal() });
	await surface.onEvent({ kind: "activate", controlId: "tokenledger.balance.refresh" }, { signal: signal() });
	assert.equal(fixture.calls.actions.at(-1).request.action.type, "balance.refresh");
	assert.match(JSON.stringify(surface.render()), /12\.50/);
	assert.match(JSON.stringify(surface.render()), /第 1 \/ 2 页/);
	await surface.onEvent({ kind: "activate", controlId: "tokenledger.page.quota-windows.next" }, { signal: signal() });
	assert.match(JSON.stringify(surface.render()), /window-19/);

	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "export" }, { signal: signal() });
	await surface.onEvent({ kind: "submit", controlId: "tokenledger.export-form", values: { format: "csv" } }, { signal: signal() });
	assert.equal(fixture.calls.actions.at(-1).request.action.type, "usage.export");
	assert.match(JSON.stringify(surface.render()), /1 \/ 3/);
	await surface.onEvent({ kind: "activate", controlId: "tokenledger.export.next" }, { signal: signal() });
	assert.match(JSON.stringify(surface.render()), /2 \/ 3/);

	await surface.onEvent({ kind: "activate", controlId: "tokenledger.refresh" }, { signal: signal() });
	await surface.onEvent({ kind: "activate", controlId: "tokenledger.rebuild" }, { signal: signal() });
	assert.deepEqual(fixture.calls.actions.slice(-2).map((value) => value.request.action.type), ["usage.refresh", "index.rebuild"]);
	assert.ok(context.host.registered.notifications.length >= 4);
	assert.equal(fixture.calls.configurations, 0);
	context.dispose();
});

test("command requires a gesture, opens the complete overlay, and accepts range/site args", async () => {
	const fixture = makeService();
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const command = context.host.registered.commands[0];
	assert.equal(context.host.registered.commands.length, 1);
	assert.equal(command.id, "tokenledger");
	assert.equal(context.host.registered.status.length, 0);
	assert.equal(context.host.registered.panes.length, 0);
	assert.equal((await command.execute([], {})).code, "BLUE_ACTION_REJECTED");
	const result = await command.execute(["today", "relay.example", "--tab=breakdown"], { signal: signal(), userGesture: {} });
	assert.equal(result.ok, true);
	assert.equal(context.host.registered.overlays.length, 1);
	assert.equal(context.host.registered.overlays[0].title, undefined, "动态 TokenLedger surface 必须独占唯一浮层边框");
	assert.equal(context.host.registered.overlays[0].render().chrome, "overlay");
	assert.equal(fixture.calls.queries.at(-1).request.site, "relay.example");
	const rendered = JSON.stringify(context.host.registered.overlays[0].render());
	assert.match(rendered, /TokenLedger · 明细/);
	assert.match(rendered, /当前页：明细/);
	assert.match(rendered, /"activeId":"breakdown"/);
	assert.match(rendered, /"id":"breakdown","label":"明细"/);
	assert.doesNotMatch(rendered, /(?:●|○) (?:总览|明细|账户|导出)/u);
	assert.match(rendered, /Tab\/Shift\+Tab 切换标签层级/);
	assert.match(rendered, /←\/→ 直接切换本层标签页/);
	assert.match(rendered, /↓ 进入内容/);
	assert.match(rendered, /↑\/↓ 浏览内容/);
	assert.match(rendered, /Enter\/Space 选择内容项/);
	assert.match(rendered, /PgUp\/PgDn 翻页/);
	context.dispose();
});

test("the overlay has no settings tab or configuration read and rejects the retired tab id", async () => {
	const fixture = makeService();
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	const rendered = JSON.stringify(surface.render());

	assert.doesNotMatch(rendered, /● 设置|○ 设置|运行设置|tokenledger\.(?:settings|relays|wallets|relay-form|wallet-form)/);
	assert.equal(fixture.calls.configurations, 0);
	const retired = await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "settings" }, { signal: signal() });
	assert.equal(retired.code, "BLUE_INVALID_CONTRIBUTION");
	assert.equal(fixture.calls.configurations, 0);
	context.dispose();
});

test("service absence and invalid service keep a visible plain fallback", async () => {
	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	for (const value of [undefined, { current() {} }, revoked.proxy]) {
		const host = makeHost({ session: false, notifications: false });
		const context = makeContext(value, host);
		apply(context.context);
		await tick();
		assert.equal(host.registered.panes.length, 0);
		assert.equal(host.registered.status.length, 0);
		const surface = await openDashboard(context);
		assert.match(JSON.stringify(surface.render()), /服务暂不可用|不符合公开 Service 契约/);
		context.dispose();
	}
});

test("service unload, replacement, and late callbacks cannot republish stale data", async () => {
	const first = makeService({ tokens: 100 });
	const second = makeService({ tokens: 200 });
	const context = makeContext(first.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	const late = first.listener;
	context.provide(undefined);
	assert.match(JSON.stringify(surface.render()), /服务暂不可用/);
	late?.(summary(99, 999));
	assert.doesNotMatch(JSON.stringify(surface.render()), /999/);
	context.provide(second.service);
	await tick();
	assert.match(JSON.stringify(surface.render()), /200/);
	late?.(summary(100, 888));
	assert.doesNotMatch(JSON.stringify(surface.render()), /888/);
	context.dispose();
});

test("caller abort and session swap fence in-flight reads and action results", async () => {
	const fixture = makeService();
	const query = deferred();
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	fixture.setQueryOverride(() => query.promise);
	const pendingRead = surface.onEvent({ kind: "selection-change", controlId: "tokenledger.range-list", value: "range:month" }, { signal: signal() });
	fixture.setQueryOverride(undefined);
	context.host.switchSession("session-2");
	query.resolve({ revision: 1, value: usage(999) });
	const stale = await pendingRead;
	assert.ok(stale.code === "BLUE_ABORTED" || stale.code === "BLUE_STALE");
	assert.doesNotMatch(JSON.stringify(surface.render()), /999/);

	fixture.setQueryOverride(undefined);
	const action = deferred();
	fixture.setActionOverride((_request, actionSignal) => {
		actionSignal.addEventListener("abort", () => action.resolve({ requestId: "late", revision: 1, status: "applied", message: "late", snapshot: summary(1, 777) }), { once: true });
		return action.promise;
	});
	const controller = new AbortController();
	const pendingAction = surface.onEvent({ kind: "activate", controlId: "tokenledger.refresh" }, { signal: controller.signal });
	controller.abort();
	const aborted = await pendingAction;
	assert.equal(aborted.code, "BLUE_ABORTED");
	assert.doesNotMatch(JSON.stringify(surface.render()), /777/);
	context.dispose();
});

test("every provider result is fenced to the request id and captured revision", async () => {
	const fixture = makeService({
		view: usage(100, {
			models: [{ model: "model-0", tokens: 100 }],
			collectionBounds: { models: { sourceCount: 32, returnedCount: 1, omittedCount: 31 } },
			boundaryTruncated: true
		}),
		collections: { models: Array.from({ length: 32 }, (_, index) => ({ model: `model-${String(index)}`, tokens: 100 - index })) }
	});
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);

	fixture.setQueryOverride(async () => ({ revision: 2, value: usage(999) }));
	const view = await surface.onEvent({ kind: "selection-change", controlId: "tokenledger.range-list", value: "range:today" }, { signal: signal() });
	assert.equal(view.code, "BLUE_STALE");
	assert.doesNotMatch(JSON.stringify(surface.render()), /999/);

	fixture.setQueryOverride(async () => ({ revision: 1, value: usage(100, {
		models: [{ model: "model-0", tokens: 100 }],
		collectionBounds: { models: { sourceCount: 32, returnedCount: 1, omittedCount: 31 } },
		boundaryTruncated: true
	}) }));
	assert.equal((await surface.onEvent({ kind: "selection-change", controlId: "tokenledger.range-list", value: "range:all" }, { signal: signal() })).ok, true);
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "breakdown" }, { signal: signal() });
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.breakdown.tabs", tabId: "models" }, { signal: signal() });
	fixture.setCollectionOverride(async () => ({
		revision: 2,
		value: { collection: "models", offset: 16, sourceCount: 32, returnedCount: 16, items: Array.from({ length: 16 }, (_, index) => ({ model: `future-${String(index)}` })) }
	}));
	const collection = await surface.onEvent({ kind: "activate", controlId: "tokenledger.page.models.next" }, { signal: signal() });
	assert.equal(collection.code, "BLUE_STALE");
	assert.doesNotMatch(JSON.stringify(surface.render()), /future-/);

	fixture.setActionOverride((request) => ({
		requestId: `${request.requestId}-wrong`,
		revision: 2,
		status: "applied",
		message: "must be rejected",
		snapshot: summary(1, 777)
	}));
	const action = await surface.onEvent({ kind: "activate", controlId: "tokenledger.refresh" }, { signal: signal() });
	assert.equal(action.code, "BLUE_INVALID_CONTRIBUTION");
	assert.doesNotMatch(JSON.stringify(surface.render()), /777/);
	context.dispose();
});

test("consumer unload disposes every registration and session/service subscription", async () => {
	const fixture = makeService();
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	const commandHandle = context.host.handles.commands[0];
	const overlayHandle = context.host.handles.overlays[0];
	assert.ok(context.host.sessionListener);
	context.dispose();
	assert.equal(commandHandle.disposed, true);
	assert.equal(overlayHandle.closed, true);
	assert.equal(fixture.listener, undefined);
	assert.equal(context.host.sessionListener, undefined);
	const afterDispose = JSON.stringify(surface.render());
	fixture.emit(9, 999);
	assert.equal(JSON.stringify(surface.render()), afterDispose);
});

test("required capability denial leaves no partial registrations", () => {
	const host = makeHost({ openFailure: true });
	const context = makeContext(makeService().service, host);
	apply(context.context);
	assert.deepEqual(host.registered, { commands: [], status: [], panes: [], overlays: [], notifications: [] });
	context.dispose();
});
