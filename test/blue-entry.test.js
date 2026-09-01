/** TokenLedger Blue entry lifecycle and action contract tests. */

import assert from "node:assert/strict";
import test from "node:test";
import { isProxy } from "node:util/types";

import { Context, Service } from "@deepseek-ai/cordis";
import { mountTokenLedgerBlue } from "../src/blue/index.js";
import { tokenLedgerAccountTabId } from "../src/blue/model.js";

const BLUE_NAME = "dsh-tokenledger";

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
			const selected = { ...options.view, ...options.providerViews?.[request.provider] };
			return { revision, value: usage(tokens, {
				...selected,
				range: request.range,
				...(request.site === undefined ? {} : { site: request.site }),
				...(request.provider === undefined ? {} : { provider: request.provider })
			}) };
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
	const overlayOpenOptions = [];
	let sessionId = options.sessionId ?? "session-1";
	let sessionListener;
	const registration = (value, kind) => ({
		value,
		disposed: false,
		refreshes: 0,
		refresh() {
			this.refreshes += 1;
			if (kind === "overlay") options.onOverlayRefresh?.();
			return { ok: true, value: undefined };
		},
		dispose() { this.disposed = true; },
		close() { this.closed = true; },
		setHidden() { return { ok: true, value: undefined }; }
	});
	const api = {
		commands: { register(value) { registered.commands.push(value); const handle = registration(value, "command"); handles.commands.push(handle); return { ok: true, value: handle }; } },
		overlays: { open(value, openOptions) { registered.overlays.push(value); overlayOpenOptions.push(openOptions); const handle = registration(value, "overlay"); handles.overlays.push(handle); return { ok: true, value: handle }; } },
		...(options.notifications === false ? {} : { notifications: { publish(value) { registered.notifications.push(value); return { ok: true, value: undefined }; } } }),
		...(options.session === false ? {} : {
				session: {
					current() { return { ok: true, value: sessionId === null ? null : { revision: 1, sessionEpoch: 1, id: sessionId, status: "idle", mode: "normal", cwd: "/fixture" } }; },
					subscribe(next) {
						sessionListener = next;
						next(this.current());
						return { ok: true, value: { dispose() { if (sessionListener === next) sessionListener = undefined; } } };
				}
			}
		})
	};
	return {
		api,
		registered,
		handles,
		overlayOpenOptions,
		openFailure: options.openFailure,
		open(_ctx, manifest) {
			if (options.openFailure) return { ok: false, code: "BLUE_CAPABILITY_DENIED", message: "denied" };
			assert.equal(manifest.id, BLUE_NAME);
			assert.equal(manifest.$schema, "https://dsh-blue.dev/schema/blue.plugin.v1.schema.json");
			return { ok: true, value: { api, grants: [], unavailableOptional: [] } };
		},
		switchSession(next) {
			sessionId = next;
			sessionListener?.({ ok: true, value: next === null ? null : { revision: 2, sessionEpoch: 2, id: next, status: "idle", mode: "normal", cwd: "/fixture" } });
		},
		get sessionListener() { return sessionListener; }
	};
}

function makeContext(service, host = makeHost()) {
	const rootCleanups = [];
	const base = {
		__tokenLedgerController: service,
		bluePluginHost: { open: host.open.bind(host) },
		effect(factory) {
			const cleanup = factory();
			rootCleanups.push(cleanup);
			return cleanup;
		}
	};
	return {
		context: base,
		host,
		dispose() {
			for (const cleanup of rootCleanups.splice(0).reverse()) cleanup?.();
		}
	};
}

function apply(context) {
	return mountTokenLedgerBlue(context, context.__tokenLedgerController);
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

function findControl(root, id) {
	const seen = new WeakSet();
	const visit = (value) => {
		if (value === null || typeof value !== "object" || seen.has(value)) return undefined;
		seen.add(value);
		if (value.id === id) return value;
		for (const child of Object.values(value)) {
			const found = visit(child);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	return visit(root);
}

test("the in-package adapter uses the root package identity", () => {
	const fixture = makeService();
	const context = makeContext(fixture.service);
	assert.equal(apply(context.context), true);
	assert.equal(context.host.registered.commands.length, 1);
	context.dispose();
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
	const fixture = makeService();
	await ctx.plugin({
		name: "tokenledger-blue-test",
		inject: ["bluePluginHost"],
		apply(scoped) { mountTokenLedgerBlue(scoped, fixture.service); }
	});
	await tick();
	assert.equal(host.registered.commands.length, 1);
	assert.equal(host.registered.status.length, 0);
	assert.equal(host.registered.panes.length, 0);
	assert.equal(host.registered.overlays.length, 0);
	await ctx.fiber.dispose();
});

test("service replay stays command-only until the single dashboard drives range and site workflows", async () => {
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
	let rendered = JSON.stringify(surface.render());
	assert.match(rendered, /Token 用量/);
	assert.match(rendered, /"id":"tokenledger\.account-tabs"/);
	assert.match(rendered, /"id":"tokenledger\.range-tabs"/);
	assert.equal(fixture.calls.actions.at(-1).request.action.type, "balance.refresh");
	assert.equal(fixture.calls.actions.at(-1).request.action.force, false);
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "today" }, { signal: signal() });
	assert.deepEqual(fixture.calls.queries.at(-1).request.range, { from: fixture.calls.queries.at(-1).request.range.from });
	await surface.onEvent({ kind: "selection-change", controlId: "tokenledger.sites", value: "site:1" }, { signal: signal() });
	assert.equal(fixture.calls.queries.at(-1).request.site, "relay.example");
	rendered = JSON.stringify(surface.render());
	assert.match(rendered, /只看：relay\.example/);

	fixture.emit(2, 222);
	assert.doesNotMatch(JSON.stringify(surface.render()), /222/, "a newer summary must not partially replace an accepted filtered view");
	fixture.emit(2, 999);
	assert.doesNotMatch(JSON.stringify(surface.render()), /999/);
	context.dispose();
	assert.equal(fixture.listener, undefined);
});

test("a replay reloads the selected provider as one complete usage cut", async () => {
	const fixture = makeService();
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	fixture.emit(2, 222);
	await tick();
	const rendered = JSON.stringify(surface.render());
	assert.match(rendered, /"id":"all","label":"累计 222"/u);
	assert.match(rendered, /"label":"请求数","value":\[\{"text":"2"\}\]/u);
	assert.equal(fixture.calls.queries.at(-1).request.provider, "account-1");
	context.dispose();
});

test("project continuation updates only the project page", async () => {
	const projects = Array.from({ length: 24 }, (_, index) => ({
		project: `/work/project-${String(index)}`,
		label: `项目 ${String(index)}`,
		tokens: 1_000 - index,
		requests: index + 1
	}));
	const first = usage(100, {
		projects: projects.slice(0, 16),
		collectionBounds: {
			projects: { sourceCount: 24, returnedCount: 16, omittedCount: 8 }
		},
		boundaryOmissions: [],
		boundaryOmissionOverflow: 0,
		boundaryTruncated: true
	});
	const fixture = makeService({ view: first, collections: { projects } });
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	assert.match(JSON.stringify(surface.render()), /项目：初始边界外还有 8 条/);
	assert.match(JSON.stringify(surface.render()), /第 1 \/ 3 页/);

	assert.equal((await surface.onEvent({ kind: "activate", controlId: "tokenledger.page.projects.next" }, { signal: signal() })).ok, true);
	assert.equal(fixture.calls.collections.length, 0, "the second local page must not cross the service boundary");
	assert.equal(findControl(surface.render(), "tokenledger.projects").items[0].label, "项目 8");

	const before = surface.render();
	const stable = {
		account: JSON.stringify(findControl(before, "tokenledger.account-tabs")),
		range: JSON.stringify(findControl(before, "tokenledger.range-tabs")),
		sites: JSON.stringify(findControl(before, "tokenledger.sites")),
		models: JSON.stringify(findControl(before, "tokenledger.models"))
	};
	const page = deferred();
	fixture.setCollectionOverride(() => page.promise);
	const pending = surface.onEvent({ kind: "activate", controlId: "tokenledger.page.projects.next" }, { signal: signal() });
	await tick();
	const during = surface.render();
	assert.match(JSON.stringify(during), /正在读取第 3 页，其他数据保持不变/);
	assert.equal(findControl(during, "tokenledger.projects").items[0].label, "项目 8");
	for (const [key, value] of Object.entries(stable)) assert.equal(JSON.stringify(findControl(during, `tokenledger.${key === "account" ? "account-tabs" : key === "range" ? "range-tabs" : key}`)), value);
	assert.equal(fixture.calls.collections.at(-1).request.offset, 16);
	assert.equal(fixture.calls.collections.at(-1).request.limit, 8);
	assert.equal(fixture.calls.collections.at(-1).request.collection, "projects");

	page.resolve({
		revision: 1,
		value: {
			collection: "projects",
			offset: 16,
			sourceCount: 24,
			returnedCount: 8,
			omittedCount: 16,
			omittedBefore: 16,
			omittedAfter: 0,
			items: projects.slice(16)
		}
	});
	assert.equal((await pending).ok, true);
	assert.equal(findControl(surface.render(), "tokenledger.projects").items[0].label, "项目 16");
	for (const [key, value] of Object.entries(stable)) assert.equal(JSON.stringify(findControl(surface.render(), `tokenledger.${key === "account" ? "account-tabs" : key === "range" ? "range-tabs" : key}`)), value);
	context.dispose();
});

test("model sort controls request one globally sorted bounded page", async () => {
	const models = Array.from({ length: 24 }, (_, index) => ({
		model: `model-${String(index)}`,
		tokens: 1_000 - index,
		requests: index + 1,
		pricing: { cost: index / 10, currency: "CNY" }
	}));
	const first = usage(100, {
		models: models.slice(0, 16),
		collectionBounds: {
			models: { sourceCount: 24, returnedCount: 16, omittedCount: 8 }
		},
		boundaryTruncated: true
	});
	const fixture = makeService({ view: first, collections: { models } });
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	assert.equal((await surface.onEvent({ kind: "activate", controlId: "tokenledger.model-sort.cost" }, { signal: signal() })).ok, true);
	assert.equal(fixture.calls.collections.at(-1).request.collection, "models");
	assert.equal(fixture.calls.collections.at(-1).request.sortBy, "cost");
	assert.equal(fixture.calls.collections.at(-1).request.direction, "desc");
	assert.equal(fixture.calls.collections.at(-1).request.offset, 0);
	assert.equal(fixture.calls.collections.at(-1).request.limit, 8);
	assert.equal((await surface.onEvent({ kind: "activate", controlId: "tokenledger.model-sort.cost" }, { signal: signal() })).ok, true);
	assert.equal(fixture.calls.collections.at(-1).request.direction, "asc");
	context.dispose();
});

test("account tabs reload the complete provider usage cut and balance", async () => {
	const fixture = makeService({
		view: usage(100, {
			accounts: [
				{ id: "account-1", displayName: "账户一", origin: "https://one.example" },
				{ id: "account-2", displayName: "账户二", origin: "https://two.example" }
			]
		}),
		providerViews: {
			"account-1": {
				totals: { tokens: 111, requests: 11 },
				windows: { today: { tokens: 1 }, month: { tokens: 11 }, all: { tokens: 111 } },
				projects: [{ project: "/one", label: "项目一", path: "/one", tokens: 111 }],
				activity: [{ day: "2026-08-29", tokens: 111 }],
				models: [{ model: "model-one", tokens: 111, requests: 11 }]
			},
			"account-2": {
				totals: { tokens: 222, requests: 22 },
				windows: { today: { tokens: 2 }, month: { tokens: 22 }, all: { tokens: 222 } },
				projects: [{ project: "/two", label: "项目二", path: "/two", tokens: 222 }],
				activity: [{ day: "2026-08-30", tokens: 222 }],
				models: [{ model: "model-two", tokens: 222, requests: 22 }]
			}
		}
	});
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	assert.equal(fixture.calls.queries.at(-1).request.provider, "account-1");
	assert.deepEqual(fixture.calls.actions.at(-1).request.action, { type: "balance.refresh", force: false, accountId: "account-1" });
	assert.match(JSON.stringify(surface.render()), /¥12\.50/);
	assert.equal(findControl(surface.render(), "tokenledger.projects").items[0].label, "项目一");
	assert.equal(findControl(surface.render(), "tokenledger.models").items[0].label, "model-one");

	const accountTwoTabId = tokenLedgerAccountTabId({ id: "account-2" });
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.account-tabs", tabId: accountTwoTabId }, { signal: signal() });
	assert.equal(fixture.calls.queries.at(-1).request.provider, "account-2");
	assert.deepEqual(fixture.calls.actions.at(-1).request.action, { type: "balance.refresh", force: false, accountId: "account-2" });
	assert.equal(findControl(surface.render(), "tokenledger.account-tabs").activeId, accountTwoTabId);
	assert.equal(findControl(surface.render(), "tokenledger.projects").items[0].label, "项目二");
	assert.equal(findControl(surface.render(), "tokenledger.models").items[0].label, "model-two");
	const rendered = JSON.stringify(surface.render());
	assert.match(rendered, /请求数.*22/u);
	assert.match(rendered, /2026-08-30/u);
	assert.doesNotMatch(rendered, /项目一|model-one|2026-08-29/u);

	await surface.onEvent({ kind: "activate", controlId: "tokenledger.refresh" }, { signal: signal() });
	assert.deepEqual(fixture.calls.actions.slice(-2).map((value) => value.request.action), [
		{ type: "usage.refresh" },
		{ type: "balance.refresh", force: true, accountId: "account-2" }
	]);
	const actionCount = fixture.calls.actions.length;
	await surface.onEvent({ kind: "activate", controlId: "tokenledger.rebuild" }, { signal: signal() });
	await surface.onEvent({ kind: "activate", controlId: "tokenledger.export.next" }, { signal: signal() });
	assert.equal(fixture.calls.actions.length, actionCount, "retired Web-external actions must stay inert");
	assert.equal(fixture.calls.configurations, 0);
	context.dispose();
});

test("command requires a gesture, opens one complete overlay, and accepts range/site args", async () => {
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
	const result = await command.execute(["today", "relay.example"], { signal: signal(), userGesture: {} });
	assert.equal(result.ok, true);
	assert.equal(context.host.registered.overlays.length, 1);
	assert.equal(context.host.registered.overlays[0].title, "TokenLedger 用量账本", "managed overlay metadata owns the single frame title");
	assert.equal(context.host.registered.overlays[0].width, "96%");
	assert.equal(context.host.registered.overlays[0].maxHeight, "96%");
	assert.equal(context.host.registered.overlays[0].render().chrome, "none");
	assert.deepEqual(context.host.overlayOpenOptions[0], { userGesture: {} });
	assert.equal(fixture.calls.queries.at(-1).request.site, "relay.example");
	const rendered = JSON.stringify(context.host.registered.overlays[0].render());
	assert.match(rendered, /"id":"tokenledger\.account-tabs"/);
	assert.match(rendered, /"id":"tokenledger\.range-tabs","activeId":"today"/);
	assert.doesNotMatch(rendered, /tokenledger\.(?:tabs|breakdown|export|rebuild|providers)/u);
	assert.doesNotMatch(rendered, /Tab 切换账户\/区间|PgUp\/PgDn 项目翻页/u);
	context.dispose();
});

test("the overlay has no settings, export, rebuild, provider, or detail-page surface", async () => {
	const fixture = makeService();
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	const rendered = JSON.stringify(surface.render());

	assert.doesNotMatch(rendered, /运行设置|导出|重建索引|按提供方|tokenledger\.(?:settings|relays|wallets|relay-form|wallet-form|export|rebuild|providers|breakdown)/);
	assert.equal(fixture.calls.configurations, 0);
	const retired = await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "settings" }, { signal: signal() });
	assert.equal(retired.code, "BLUE_INVALID_CONTRIBUTION");
	assert.equal(fixture.calls.configurations, 0);
	context.dispose();
});

test("missing or invalid internal controllers do not partially register Blue", () => {
	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	for (const value of [undefined, { current() {} }, revoked.proxy]) {
		const host = makeHost({ session: false, notifications: false });
		const context = makeContext(value, host);
		assert.equal(apply(context.context), false);
		assert.equal(host.registered.commands.length, 0);
		assert.equal(host.registered.panes.length, 0);
		assert.equal(host.registered.status.length, 0);
		context.dispose();
	}
});

test("adapter unload fences late controller callbacks and a fresh mount reads the new controller", async () => {
	const first = makeService({ tokens: 100 });
	const second = makeService({ tokens: 200 });
	const context = makeContext(first.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	const late = first.listener;
	context.dispose();
	const afterDispose = JSON.stringify(surface.render());
	late?.(summary(99, 999));
	assert.equal(JSON.stringify(surface.render()), afterDispose);

	const replacement = makeContext(second.service);
	apply(replacement.context);
	await tick();
	const replacementSurface = await openDashboard(replacement);
	assert.match(JSON.stringify(replacementSurface.render()), /200/);
	late?.(summary(100, 888));
	assert.doesNotMatch(JSON.stringify(replacementSurface.render()), /888/);
	replacement.dispose();
});

test("caller abort and session swap fence in-flight reads and action results", async () => {
	const fixture = makeService();
	const query = deferred();
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	fixture.setQueryOverride(() => query.promise);
	const pendingRead = surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "month" }, { signal: signal() });
	fixture.setQueryOverride(undefined);
	context.host.switchSession("session-2");
	query.resolve({ revision: 1, value: usage(999) });
	const stale = await pendingRead;
	assert.ok(stale.code === "BLUE_ABORTED" || stale.code === "BLUE_STALE");
	assert.doesNotMatch(JSON.stringify(surface.render()), /999/);
	await tick();

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

	const queryCount = fixture.calls.queries.length;
	fixture.setQueryOverride(async () => ({ revision: 2, value: usage(999) }));
	const view = await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "today" }, { signal: signal() });
	assert.equal(view.code, "BLUE_STALE");
	assert.equal(fixture.calls.queries.length, queryCount + 1, "a mismatched result must not retry while the snapshot is unchanged");
	assert.doesNotMatch(JSON.stringify(surface.render()), /999/);

	fixture.setQueryOverride(async (request) => ({ revision: 1, value: usage(100, {
		provider: request.provider,
		models: [{ model: "model-0", tokens: 100 }],
		collectionBounds: { models: { sourceCount: 32, returnedCount: 1, omittedCount: 31 } },
		boundaryTruncated: true
	}) }));
	assert.equal((await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "all" }, { signal: signal() })).ok, true);
	fixture.setCollectionOverride(async () => ({
		revision: 2,
		value: { collection: "models", offset: 8, sourceCount: 32, returnedCount: 8, items: Array.from({ length: 8 }, (_, index) => ({ model: `future-${String(index)}` })) }
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

test("usage reads retry once when a newer replay arrives during the query", async () => {
	const fixture = makeService();
	const context = makeContext(fixture.service);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	let attempts = 0;
	fixture.setQueryOverride((request) => {
		attempts += 1;
		if (attempts === 1) {
			fixture.emit(2, 222);
			throw Object.assign(new Error("revision advanced"), { code: "STALE" });
		}
		return { revision: 2, value: usage(222, { range: request.range, provider: request.provider }) };
	});
	const result = await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "today" }, { signal: signal() });
	assert.equal(result.ok, true);
	assert.equal(attempts, 2);
	assert.equal(fixture.calls.queries.at(-2).request.requestId.endsWith("-1"), true);
	assert.equal(fixture.calls.queries.at(-1).request.requestId.endsWith("-2"), true);
	assert.match(JSON.stringify(surface.render()), /"label":"今日 10"/u);
	assert.match(JSON.stringify(surface.render()), /"label":"累计 222"/u);
	context.dispose();
});

test("event-driven reads do not self-abort through an external overlay refresh", async () => {
	let activeController;
	const host = makeHost({ onOverlayRefresh() { activeController?.abort(); } });
	const fixture = makeService();
	const context = makeContext(fixture.service, host);
	apply(context.context);
	await tick();
	const surface = await openDashboard(context);
	activeController = new AbortController();
	const refreshes = host.handles.overlays[0].refreshes;
	const result = await surface.onEvent(
		{ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "today" },
		{ signal: activeController.signal }
	);
	assert.equal(result.ok, true);
	assert.equal(activeController.signal.aborted, false);
	assert.equal(host.handles.overlays[0].refreshes, refreshes, "core owns the success refresh after an event settles");
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
