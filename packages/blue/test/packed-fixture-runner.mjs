/** Runtime half of TokenLedger's independent packed-install fixture. */

const DECLARED = [
	"package.public-exports",
	"host.capability-absent-and-dynamic-arrival",
	"host.single-command-overlay-admission",
	"renderer.two-level-tab-and-project-paging",
	"projection.replay-and-duplicate-revision",
	"projection.collection-continuation-and-boundary-evidence",
	"action.success-abort-request-and-session-stale",
	"provider.swap-unload-fallback-and-late-result",
	"renderer.width-scan-20-40-80-120",
	"consumer.unload-and-cleanup"
];

const report = { declared: [...DECLARED], executed: [], skipped: [], failures: [], observations: [] };

class FixtureFailure extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function ensure(condition, code, message) {
	if (!condition) throw new FixtureFailure(code, message);
}

function failure(scenarioName, error, fallbackCode = "FIXTURE_SCENARIO_FAILED") {
	report.failures.push({
		scenario: scenarioName,
		code: error instanceof FixtureFailure ? error.code : fallbackCode,
		message: error instanceof Error ? error.message : String(error)
	});
}

async function scenario(name, callback) {
	try {
		await callback();
		report.executed.push(name);
	} catch (error) {
		failure(name, error);
	}
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
	for (let index = 0; index < 4; index += 1) await tick();
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

const rendered = (value) => JSON.stringify(value);
const many = (count, make) => Array.from({ length: count }, (_, index) => make(index));

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

function assertNoRawVisibleIds(rows, label) {
	const value = rows.join("\n");
	for (const id of ["tokenledger.model-sort", "tokenledger.cancel"]) {
		ensure(!value.includes(id), "FIXTURE_RAW_CONTROL_ID", `${label}: internal control id ${id} became visible`);
	}
}

let cordis;
let blueApi;
let core;
let themeDark;
let companion;
let domain;

await scenario("package.public-exports", async () => {
	[cordis, blueApi, core, themeDark, companion, domain] = await Promise.all([
		import("@deepseek-ai/cordis"),
		import("@dsh-blue/blue-api"),
		import("@dsh-blue/blue-core"),
		import("@dsh-blue/blue-core/theme-dark"),
		import("@dsh-blue/tokenledger"),
		import("dsh-tokenledger/service")
	]);
	ensure(companion.name === "@dsh-blue/tokenledger", "FIXTURE_COMPANION_NAME", "companion public entry has the wrong Cordis name");
	ensure(typeof companion.apply === "function", "FIXTURE_COMPANION_APPLY", "companion public entry has no callable apply");
	ensure(typeof domain.TokenLedgerService === "function", "FIXTURE_DOMAIN_SERVICE", "TokenLedger public service export is missing");
	ensure(typeof core.compileBlueUiNode === "function", "FIXTURE_CORE_COMPILER", "Blue core public compiler export is missing");
});

function usage(tokens = 100, overrides = {}) {
	return {
		version: "0.1.0",
		generatedAt: Date.UTC(2026, 7, 30, 12),
		timeZone: { id: "Asia/Shanghai", offset: "UTC+08:00" },
		range: {},
		totals: {
			inputTokens: Math.max(0, tokens - 30),
			outputTokens: 10,
			cacheReadTokens: 15,
			requests: 4,
			tokens,
			cacheHitRate: 25
		},
		windows: {
			today: { tokens: Math.floor(tokens / 4), requests: 1 },
			month: { tokens: Math.floor(tokens / 2), requests: 2 },
			all: { tokens, requests: 4 }
		},
		activity: [{ day: "2026-08-30", tokens, requests: 4 }],
		activityModels: [{ day: "2026-08-30", model: "fixture/model-0", tokens, requests: 1 }],
		models: many(300, (index) => ({
			model: `fixture/model-${String(index)}`,
			tokens: 10_000 - index,
			requests: index + 1,
			inputTokens: 9_000 - index,
			outputTokens: 10,
			cacheReadTokens: 5
		})),
		sites: many(20, (index) => ({ site: index === 0 ? "direct" : `relay-${String(index)}.example`, tokens: tokens - index, requests: index + 1 })),
		projects: many(20, (index) => ({ project: `/fixture/project-${String(index)}`, label: `项目 ${String(index)}`, tokens: tokens - index, requests: 1 })),
		providers: many(20, (index) => ({ provider: `provider-${String(index)}`, tokens: tokens - index, requests: 1 })),
		directory: many(20, (index) => ({ id: index === 0 ? "direct" : `relay-${String(index)}.example`, type: "newapi" })),
		accounts: many(5, (index) => ({ id: `account-${String(index)}`, displayName: `账户 ${String(index)}`, origin: `https://relay-${String(index)}.example`, provider: `provider-${String(index)}` })),
		diagnostics: { sessions: 8, unattributedRows: 1, lastUsageAt: Date.UTC(2026, 7, 30, 12) },
		lastSweepAt: Date.UTC(2026, 7, 30, 12),
		priced: {
			currency: "CNY",
			totals: { CNY: tokens / 10_000 },
			rows: many(300, (index) => ({ model: `fixture/model-${String(index)}`, cost: index / 100, currency: "CNY" }))
		},
		...overrides
	};
}

function createDomainFixture(initialTokens = 100) {
	let tokens = initialTokens;
	let disposed = false;
	let configurationReads = 0;
	const reads = [];
	const actions = [];
	const implementation = {
		readUsage(query = {}) {
			const pending = reads.shift();
			if (pending !== undefined) return pending.promise;
			const accountTwo = query.provider === "provider-1";
			const selectedTokens = accountTwo ? tokens + 1_000 : tokens;
			return usage(selectedTokens, {
				...(accountTwo ? {
					totals: { inputTokens: selectedTokens - 50, outputTokens: 50, requests: 41, tokens: selectedTokens, cacheHitRate: 50 },
					windows: {
						today: { tokens: selectedTokens - 20, requests: 40 },
						month: { tokens: selectedTokens - 10, requests: 40 },
						all: { tokens: selectedTokens, requests: 41 }
					},
					activity: [{ day: "2026-08-29", tokens: selectedTokens, requests: 41 }],
					models: many(300, (index) => ({ model: `account-two/model-${String(index)}`, tokens: selectedTokens - index, requests: index + 1 })),
					sites: [{ site: "account-two.example", tokens: selectedTokens, requests: 41 }],
					projects: many(20, (index) => ({ project: `/account-two/project-${String(index)}`, label: `账户二项目 ${String(index)}`, tokens: selectedTokens - index, requests: 1 }))
				} : {}),
				range: query.range ?? {},
				...(query.site === undefined ? {} : { site: query.site }),
				...(query.provider === undefined ? {} : { provider: query.provider })
			});
		},
		readConfiguration() {
			configurationReads += 1;
			return { version: "0.1.0", settings: { available: true }, relays: {}, wallets: {} };
		},
		async runAction(action, context) {
			const pending = actions.shift();
			if (pending !== undefined) return pending.promise;
			if (action.type === "usage.refresh") {
				tokens += 25;
				context.commit();
				return { changed: true, view: usage(tokens), message: "usage refreshed" };
			}
			if (action.type === "balance.refresh") {
				return {
					changed: false,
					message: "balance refreshed",
					data: { fetched: true, total: 12.5, used: 3, currency: "CNY", scheme: "newapi", windows: [{ kind: "每日", usedPercent: 20 }] }
				};
			}
			return { changed: false, message: `${String(action.type)} completed` };
		},
		dispose() {
			disposed = true;
		}
	};
	const service = new domain.TokenLedgerService(implementation);
	return {
		service,
		deferNextRead() {
			const pending = deferred();
			reads.push(pending);
			return pending;
		},
		deferNextAction() {
			const pending = deferred();
			actions.push(pending);
			return pending;
		},
		get tokens() { return tokens; },
		get configurationReads() { return configurationReads; },
		get disposed() { return disposed; }
	};
}

function summary(tokens, revision) {
	return domain.createTokenLedgerSummary(usage(tokens), revision);
}

function manualService(initialTokens, initialRevision = 1) {
	let tokens = initialTokens;
	let revision = initialRevision;
	let listener;
	let query;
	let subscriptionDisposed = 0;
	const service = {
		current: () => summary(tokens, revision),
		subscribe(next, options = {}) {
			listener = next;
			next(summary(tokens, revision));
			let done = false;
			const dispose = () => {
				if (done) return;
				done = true;
				subscriptionDisposed += 1;
				if (listener === next) listener = undefined;
				options.signal?.removeEventListener("abort", dispose);
			};
			if (options.signal?.aborted === true) dispose();
			else options.signal?.addEventListener("abort", dispose, { once: true });
			return dispose;
		},
		async queryUsage(request) {
			const pending = query;
			query = undefined;
			if (pending !== undefined) return pending.promise;
			return {
				revision,
				value: domain.createTokenLedgerView(usage(
					tokens,
					request.provider === undefined ? {} : { provider: request.provider }
				))
			};
		},
		async execute(request) {
			return { requestId: request.requestId, revision, status: "applied", message: "manual action", snapshot: summary(tokens, revision) };
		}
	};
	return {
		service,
		emit(nextRevision, nextTokens) {
			revision = nextRevision;
			tokens = nextTokens;
			listener?.(summary(tokens, revision));
		},
		deferNextQuery() {
			query = deferred();
			return query;
		},
		get listener() { return listener; },
		get subscriptionDisposed() { return subscriptionDisposed; }
	};
}

function sessionFixture() {
	let current = { revision: 1, sessionEpoch: 1, id: "fixture-session-a", cwd: "/fixture/a", status: "idle", mode: "normal", model: { id: "fixture-model", provider: "fixture" } };
	const listeners = new Set();
	return {
		reader: {
			current: () => current,
			subscribe(next) {
				listeners.add(next);
				next(current);
				return { dispose: () => listeners.delete(next) };
			}
		},
		publish(value) {
			current = value;
			for (const listener of listeners) listener(current);
		},
		get listenerCount() { return listeners.size; }
	};
}

let ctx;
let compilerContext;
let compilerComponents;
let ownerLease;
let sessionRegistration;
let notificationRegistration;
let companionFiber;
let currentServiceDisposer;
let domainFixture;
let sessions;
let notices;
let companionDisposed = false;

function ownerSnapshot() {
	const result = ownerLease.snapshot();
	ensure(result.ok, "FIXTURE_OWNER_STALE", result.message ?? "Blue owner lease became stale");
	return result.value;
}

async function provideService(value) {
	currentServiceDisposer = ctx.provide("tokenLedgerV1", value);
	await settle();
}

async function removeService() {
	const dispose = currentServiceDisposer;
	currentServiceDisposer = undefined;
	if (dispose !== undefined) await dispose();
	await settle();
}

function commandContribution() {
	const command = ownerSnapshot().commands.find((entry) => entry.id === "tokenledger");
	ensure(command !== undefined, "FIXTURE_COMMAND_MISSING", "TokenLedger command contribution is missing");
	return command;
}

function overlayContribution() {
	const overlay = ownerSnapshot().overlays.find((entry) => entry.id === "tokenledger.dashboard.overlay");
	ensure(overlay !== undefined, "FIXTURE_OVERLAY_MISSING", "TokenLedger managed overlay is missing");
	return overlay;
}

async function openDashboard(args = []) {
	const command = commandContribution();
	const result = await ownerLease.runUserGesture("commands", (userGesture) => command.execute(args, { userGesture }));
	ensure(result.ok, "FIXTURE_COMMAND_EXECUTE", result.message ?? "TokenLedger command failed");
	return overlayContribution();
}

function usageTokens(surface, value) {
	return rendered(surface.render()).includes(`"id":"all","label":"累计 ${new Intl.NumberFormat("zh-CN").format(value)}`);
}

await scenario("host.capability-absent-and-dynamic-arrival", async () => {
	ctx = new cordis.Context();
	await ctx.plugin(blueApi);
	const control = ctx.get("bluePluginControl");
	ensure(control !== undefined, "FIXTURE_BLUE_CONTROL_MISSING", "Blue host did not provide its composition control");
	ownerLease = control.attachCapabilities(ctx, ["commands", "overlays", "notifications.publish"]);
	sessions = sessionFixture();
	sessionRegistration = control.attachSessionReader(ctx, sessions.reader);
	notices = [];
	notificationRegistration = ownerLease.observeNotifications((notice) => notices.push(notice));
	compilerContext = new cordis.Context();
	compilerComponents = new core.BlueComponentsService(compilerContext, { theme: { colors: themeDark.DARK_COLORS }, tui: {} });
	companionFiber = await ctx.plugin(companion);
	await settle();

	const absent = ownerSnapshot();
	ensure(absent.commands.length === 1 && absent.status.length === 0 && absent.panes.length === 0 && absent.overlays.length === 0, "FIXTURE_COMMAND_ONLY_IDLE", "TokenLedger must stay command-only while idle");
	const fallback = await openDashboard();
	ensure(/服务暂不可用/u.test(rendered(fallback.request.render())), "FIXTURE_SERVICE_ABSENT_OVERLAY", "service-absent overlay did not expose its local fallback");
	ensure(ownerLease.closeOverlay(fallback).ok, "FIXTURE_FALLBACK_OVERLAY_CLOSE", "service-absent overlay could not close");

	domainFixture = createDomainFixture(100);
	await provideService(domainFixture.service);
	const ready = ownerSnapshot();
	ensure(ready.commands.length === 1 && ready.status.length === 0 && ready.panes.length === 0 && ready.overlays.length === 0, "FIXTURE_DYNAMIC_SERVICE_IDLE", "late Service arrival created a persistent surface");
});

await scenario("host.single-command-overlay-admission", async () => {
	const overlay = await openDashboard();
	ensure(overlay.request.capturing === true && overlay.request.dismissible === true, "FIXTURE_OVERLAY_POLICY", "command did not open the expected managed overlay");
	ensure(overlay.request.width === "96%" && overlay.request.maxHeight === "96%", "FIXTURE_OVERLAY_SIZE", "dashboard did not use the expanded dogfood viewport");
	ensure(overlay.request.title === undefined, "FIXTURE_OVERLAY_DOUBLE_FRAME", "managed overlay title would create a second frame");
	const node = overlay.request.render();
	const view = rendered(node);
	ensure(node?.kind === "surface" && node.chrome === "overlay", "FIXTURE_OVERLAY_SINGLE_FRAME", "TokenLedger did not return one overlay surface");
	ensure(/TokenLedger 用量账本/u.test(view), "FIXTURE_OVERLAY_TITLE", "single dashboard title is missing");
	ensure(findControl(node, "tokenledger.account-tabs")?.kind === "tabs" && findControl(node, "tokenledger.range-tabs")?.kind === "tabs", "FIXTURE_TWO_TAB_LEVELS", "account and range tab levels are missing");
	ensure(/余额/u.test(view) && /Token 用量/u.test(view) && /中转站分布/u.test(view) && /按项目/u.test(view) && /活跃度/u.test(view) && /模型/u.test(view), "FIXTURE_WEB_SECTION_PARITY", "dashboard does not retain the Web section set");
	ensure(/Tab 切换账户\/区间/u.test(view) && /←\/→ 切换当前标签/u.test(view) && /PgUp\/PgDn 项目翻页/u.test(view), "FIXTURE_OVERLAY_GUIDE", "Chinese keyboard guide does not describe the two tab levels and project paging");
	ensure(!/tokenledger\.(?:tabs|breakdown|export|rebuild|providers|activity-models)/u.test(view), "FIXTURE_RETIRED_UI", "overlay retained a Web-external or old detail-page control");
	ensure(!/[●○]/u.test(view), "FIXTURE_RAW_TAB_MARKER", "wire labels contain renderer-owned tab glyphs");
	ensure(domainFixture.configurationReads === 0, "FIXTURE_CONFIGURATION_READ", "overlay read the retired companion configuration surface");
});

await scenario("renderer.two-level-tab-and-project-paging", async () => {
	const overlay = overlayContribution().request;
	const viewport = { columns: 100, rows: 120 };
	const compileSurface = (events) => {
		const result = core.compileBlueUiNode(overlay.render(), {
			components: compilerComponents,
			colors: themeDark.DARK_COLORS,
			getViewport: () => viewport,
			screenMode: "alternate",
			emit: (event) => events.push(event)
		});
		ensure(result.ok && result.value.focusTarget !== null, "FIXTURE_KEYBOARD_COMPILE", result.message ?? "interactive overlay did not compile");
		result.value.focusTarget.focused = true;
		return result.value;
	};
	const identity = (compiled) => compiled.focusTarget.captureFocusIdentity?.();
	const rows = (compiled) => compiled.component.render(viewport.columns).join("\n");
	const replace = (previous, events, code) => {
		const previousIdentity = identity(previous);
		const next = compileSurface(events);
		ensure(previousIdentity !== undefined && next.focusTarget.restoreFocusIdentity?.(previousIdentity) === true, code, "semantic focus did not survive redraw");
		next.focusTarget.focused = true;
		return next;
	};
	const moveDownTo = (compiled, controlId) => {
		for (let count = 0; count < 32 && identity(compiled)?.controlId !== controlId; count += 1) compiled.focusTarget.handleInput?.("\x1b[B");
		return identity(compiled);
	};

	let events = [];
	let compiled = compileSurface(events);
	ensure(identity(compiled)?.controlId === "tokenledger.account-tabs", "FIXTURE_ACCOUNT_TAB_INITIAL", "account tabs are not the initial tab level");
	ensure(/‹ ● 账户 0 ›/u.test(rows(compiled)), "FIXTURE_ACCOUNT_TAB_VISIBLE", "active account tab is not visibly rendered by canonical core");
	compiled.focusTarget.handleInput?.("\x1b[6~");
	ensure(
		events.at(-1)?.kind === "activate" && events.at(-1)?.controlId === "tokenledger.page.projects.next",
		"FIXTURE_PROJECT_GLOBAL_PAGEDOWN",
		`PgDn from the account tab level did not target the project page; received ${JSON.stringify(events.at(-1))}`
	);
	events.length = 0;
	compiled.focusTarget.handleInput?.("\r");
	compiled.focusTarget.handleInput?.(" ");
	ensure(events.length === 0, "FIXTURE_TAB_CONFIRM_NOOP", "Enter/Space emitted an event from tabs");

	compiled.focusTarget.handleInput?.("\t");
	ensure(identity(compiled)?.controlId === "tokenledger.range-tabs" && identity(compiled)?.itemId === "all", "FIXTURE_TAB_SWITCH_LEVEL", "Tab did not move from account level to range level");
	compiled.focusTarget.handleInput?.("\x1b[C");
	const todayEvent = events.at(-1);
	ensure(todayEvent?.kind === "tab-change" && todayEvent.controlId === "tokenledger.range-tabs" && todayEvent.tabId === "today", "FIXTURE_RANGE_RIGHT", "Right did not immediately select 今日");
	ensure((await overlay.onEvent(todayEvent, { signal: new AbortController().signal })).ok, "FIXTURE_RANGE_APPLY", "今日 range event failed");
	events = [];
	compiled = replace(compiled, events, "FIXTURE_RANGE_FOCUS_RESTORE");
	ensure(/‹ ● 今日/u.test(rows(compiled)), "FIXTURE_RANGE_ACTIVE_VISIBLE", "今日 did not become visibly active after redraw");

	compiled.focusTarget.handleInput?.("\t");
	ensure(identity(compiled)?.controlId === "tokenledger.account-tabs", "FIXTURE_TAB_RETURN_LEVEL", "Tab did not return to account level");
	const nextAccountId = findControl(overlay.render(), "tokenledger.account-tabs")?.items?.[1]?.id;
	compiled.focusTarget.handleInput?.("\x1b[C");
	const accountEvent = events.at(-1);
	ensure(accountEvent?.kind === "tab-change" && accountEvent.tabId === nextAccountId, "FIXTURE_ACCOUNT_RIGHT", "Right did not immediately select the next account");
	ensure((await overlay.onEvent(accountEvent, { signal: new AbortController().signal })).ok, "FIXTURE_ACCOUNT_APPLY", "account tab event failed");
	events = [];
	compiled = replace(compiled, events, "FIXTURE_ACCOUNT_FOCUS_RESTORE");
	ensure(/‹ ● 账户 1 ›/u.test(rows(compiled)), "FIXTURE_ACCOUNT_ACTIVE_VISIBLE", "selected account did not become visibly active");
	const accountTwoCut = overlay.render();
	const accountTwoRendered = rendered(accountTwoCut);
	ensure(usageTokens(overlay, domainFixture.tokens + 1_000), "FIXTURE_ACCOUNT_USAGE_TOTAL", "account switch did not replace cumulative Token usage");
	ensure(/请求数[\s\S]*41/u.test(accountTwoRendered), "FIXTURE_ACCOUNT_REQUESTS", "account switch did not replace the request count");
	ensure(findControl(accountTwoCut, "tokenledger.projects")?.items?.[0]?.label === "账户二项目 0", "FIXTURE_ACCOUNT_PROJECTS", "account switch did not replace projects");
	ensure(findControl(accountTwoCut, "tokenledger.models")?.items?.[0]?.label === "account-two/model-0", "FIXTURE_ACCOUNT_MODELS", "account switch did not replace models");
	ensure(/2026-08-29/u.test(accountTwoRendered) && /account-two\.example/u.test(accountTwoRendered), "FIXTURE_ACCOUNT_ACTIVITY_SITE", "account switch did not replace activity and site distribution");
	const firstAccountId = findControl(accountTwoCut, "tokenledger.account-tabs")?.items?.[0]?.id;
	ensure((await overlay.onEvent({ kind: "tab-change", controlId: "tokenledger.account-tabs", tabId: firstAccountId }, { signal: new AbortController().signal })).ok, "FIXTURE_ACCOUNT_RESTORE", "fixture could not restore the first account");
	events = [];
	compiled = replace(compiled, events, "FIXTURE_ACCOUNT_RESTORE_FOCUS");
	ensure(usageTokens(overlay, domainFixture.tokens), "FIXTURE_ACCOUNT_RESTORE_USAGE", "restoring the first account did not restore its usage cut");

	compiled.focusTarget.handleInput?.("\x1b[B");
	ensure(!identity(compiled)?.controlId?.endsWith("-tabs"), "FIXTURE_DOWN_CONTENT", "Down did not enter dashboard content");
	compiled.focusTarget.handleInput?.("\t");
	ensure(identity(compiled)?.controlId === "tokenledger.account-tabs", "FIXTURE_CONTENT_TAB_RETURN", "Tab from content did not return to the remembered tab level");
	compiled.focusTarget.handleInput?.("\t");
	compiled.focusTarget.handleInput?.("\x1b[B");
	ensure(moveDownTo(compiled, "tokenledger.projects")?.controlId === "tokenledger.projects", "FIXTURE_PROJECT_FOCUS", "could not reach the project list through content navigation");
	const stableBefore = overlay.render();
	const stableControls = ["tokenledger.account-tabs", "tokenledger.range-tabs", "tokenledger.sites", "tokenledger.models"]
		.map((id) => [id, rendered(findControl(stableBefore, id))]);
	compiled.focusTarget.handleInput?.("\x1b[6~");
	const pageDown = events.at(-1);
	ensure(pageDown?.kind === "activate" && pageDown.controlId === "tokenledger.page.projects.next", "FIXTURE_PROJECT_PAGEDOWN", "PgDn escaped the focused project scope");
	ensure((await overlay.onEvent(pageDown, { signal: new AbortController().signal })).ok, "FIXTURE_PROJECT_PAGE_APPLY", "project next page failed");
	const projectPage = overlay.render();
	ensure(findControl(projectPage, "tokenledger.projects")?.items?.[0]?.id === "project:0" && findControl(projectPage, "tokenledger.projects")?.items?.[0]?.label === "项目 8", "FIXTURE_PROJECT_PAGE_VISIBLE", "project page did not advance locally");
	for (const [id, value] of stableControls) ensure(rendered(findControl(projectPage, id)) === value, "FIXTURE_PROJECT_PAGE_ISOLATION", `${id} changed while only the project page advanced`);

	events = [];
	compiled = replace(compiled, events, "FIXTURE_PROJECT_PAGE_FOCUS_RESTORE");
	ensure(identity(compiled)?.controlId === "tokenledger.projects", "FIXTURE_PROJECT_PAGE_FOCUS_CONTROL", "project page replacement moved focus out of the project list");
	compiled.focusTarget.handleInput?.("\x1b[5~");
	const pageUp = events.at(-1);
	ensure(pageUp?.kind === "activate" && pageUp.controlId === "tokenledger.page.projects.prev", "FIXTURE_PROJECT_PAGEUP", "PgUp escaped the focused project scope");
	ensure((await overlay.onEvent(pageUp, { signal: new AbortController().signal })).ok, "FIXTURE_PROJECT_PAGEUP_APPLY", "project previous page failed");
});

await scenario("projection.replay-and-duplicate-revision", async () => {
	await removeService();
	const manual = manualService(300, 5);
	await provideService(manual.service);
	const surface = overlayContribution().request;
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "all" }, { signal: new AbortController().signal });
	ensure(usageTokens(surface, 300), "FIXTURE_MANUAL_REPLAY", "replacement Service replay did not activate");
	manual.emit(5, 999);
	ensure(!usageTokens(surface, 999), "FIXTURE_DUPLICATE_REVISION", "same-revision replay replaced current state");
	manual.emit(4, 888);
	ensure(!usageTokens(surface, 888), "FIXTURE_REGRESSED_REVISION", "regressed replay replaced current state");
	manual.emit(6, 600);
	await settle();
	ensure(usageTokens(surface, 600), "FIXTURE_MONOTONIC_REPLAY", "newer replay did not replace current state");
	await removeService();
	ensure(manual.subscriptionDisposed === 1, "FIXTURE_REPLAY_SUBSCRIPTION_DISPOSE", "Service subscription was not disposed exactly once");
	await provideService(domainFixture.service);
});

await scenario("projection.collection-continuation-and-boundary-evidence", async () => {
	const surface = overlayContribution().request;
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "all" }, { signal: new AbortController().signal });
	const initial = rendered(surface.render());
	ensure(/模型：初始边界外还有 44 条/u.test(initial), "FIXTURE_COLLECTION_BOUNDARY_NOTICE", "fixed model truncation was not disclosed exactly");
	ensure(/第 1 \/ 38 页/u.test(initial), "FIXTURE_COLLECTION_TOTAL", "model prefix was presented as the complete collection");

	const direct = await domainFixture.service.queryCollection({
		requestId: "fixture-model-page",
		expectedRevision: domainFixture.service.current().revision,
		collection: "models",
		offset: 296,
		limit: 8,
		sortBy: "tokens",
		direction: "desc"
	});
	ensure(direct.value.sourceCount === 300 && direct.value.returnedCount === 4 && direct.value.items.at(-1)?.model === "fixture/model-299", "FIXTURE_COLLECTION_COUNTS", "direct continuation did not retain the final source row");

	for (let page = 1; page < 38; page += 1) {
		const result = await surface.onEvent({ kind: "activate", controlId: "tokenledger.page.models.next" }, { signal: new AbortController().signal });
		ensure(result.ok, "FIXTURE_COLLECTION_NEXT", result.message ?? `model page ${String(page + 1)} failed`);
	}
	const final = rendered(surface.render());
	ensure(/第 38 \/ 38 页/u.test(final) && /fixture\/model-299/u.test(final), "FIXTURE_COLLECTION_FINAL", "TUI did not render the final continued model page");
	const sorted = await surface.onEvent({ kind: "activate", controlId: "tokenledger.model-sort.cost" }, { signal: new AbortController().signal });
	ensure(sorted.ok && findControl(surface.render(), "tokenledger.models")?.items?.[0]?.label === "fixture/model-299", "FIXTURE_COLLECTION_COST_SORT", "service-owned cost sorting did not return the global maximum");
});

await scenario("action.success-abort-request-and-session-stale", async () => {
	const surface = overlayContribution().request;
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "all" }, { signal: new AbortController().signal });
	const refreshed = await surface.onEvent({ kind: "activate", controlId: "tokenledger.refresh" }, { signal: new AbortController().signal });
	ensure(refreshed.ok && domainFixture.tokens === 125 && usageTokens(surface, 125), "FIXTURE_ACTION_SUCCESS", "single refresh did not update usage and balance");
	ensure(notices.some((notice) => notice.tone === "success"), "FIXTURE_ACTION_NOTIFICATION", "successful usage refresh did not publish a notification");

	const lateAction = domainFixture.deferNextAction();
	const actionAbort = new AbortController();
	const pendingAction = surface.onEvent({ kind: "activate", controlId: "tokenledger.refresh" }, { signal: actionAbort.signal });
	await tick();
	actionAbort.abort();
	const abortedAction = await pendingAction;
	ensure(abortedAction.code === "BLUE_ABORTED", "FIXTURE_ACTION_ABORT", "caller abort did not reject the in-flight action");
	lateAction.resolve({ changed: false, message: "late action" });
	await settle();

	const firstRead = domainFixture.deferNextRead();
	const first = surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "month" }, { signal: new AbortController().signal });
	await tick();
	const second = await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "today" }, { signal: new AbortController().signal });
	ensure(second.ok, "FIXTURE_REQUEST_REPLACEMENT", "replacement range request did not complete");
	firstRead.resolve(usage(999));
	const stale = await first;
	ensure(stale.code === "BLUE_ABORTED" || stale.code === "BLUE_STALE", "FIXTURE_REQUEST_STALE", "superseded range request was not fenced");
	ensure(!rendered(surface.render()).includes("999"), "FIXTURE_REQUEST_LATE_RESULT", "superseded result reached the dashboard");

	const sessionRead = domainFixture.deferNextRead();
	const pendingSessionRead = surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "all" }, { signal: new AbortController().signal });
	await tick();
	sessions.publish({ revision: 2, sessionEpoch: 2, id: "fixture-session-b", cwd: "/fixture/b", status: "idle", mode: "normal", model: { id: "fixture-model", provider: "fixture" } });
	await settle();
	sessionRead.resolve(usage(777));
	const sessionStale = await pendingSessionRead;
	ensure(sessionStale.code === "BLUE_ABORTED" || sessionStale.code === "BLUE_STALE", "FIXTURE_SESSION_STALE", "session swap did not fence the old read");
});

await scenario("provider.swap-unload-fallback-and-late-result", async () => {
	const surface = overlayContribution().request;
	await removeService();
	ensure(/服务暂不可用/u.test(rendered(surface.render())), "FIXTURE_PROVIDER_UNLOAD_FALLBACK", "Service unload did not restore fallback");

	const first = manualService(300, 1);
	await provideService(first.service);
	const pending = first.deferNextQuery();
	const lateRead = surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "today" }, { signal: new AbortController().signal });
	await tick();
	const lateReplay = first.listener;
	await removeService();
	pending.resolve({ revision: 1, value: domain.createTokenLedgerView(usage(999)) });
	const rejected = await lateRead;
	ensure(rejected.code === "BLUE_ABORTED" || rejected.code === "BLUE_STALE", "FIXTURE_PROVIDER_LATE_READ", "unloaded provider read was not rejected");

	const replacement = manualService(400, 1);
	await provideService(replacement.service);
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "all" }, { signal: new AbortController().signal });
	ensure(usageTokens(surface, 400), "FIXTURE_PROVIDER_SWAP", "replacement provider did not activate");
	lateReplay?.(summary(888, 99));
	ensure(!usageTokens(surface, 888), "FIXTURE_PROVIDER_LATE_REPLAY", "old callback replaced the active provider");
	await removeService();
	await provideService({ current() {} });
	ensure(/不符合公开 Service 契约/u.test(rendered(surface.render())), "FIXTURE_PROVIDER_INVALID_FALLBACK", "invalid provider did not fail visibly");
	await removeService();
	await provideService(domainFixture.service);
});

function scanUi(label, node, widths) {
	for (const width of widths) {
		const viewport = { columns: width, rows: 40 };
		const compiled = core.compileBlueUiNode(node, {
			components: compilerComponents,
			colors: themeDark.DARK_COLORS,
			getViewport: () => viewport,
			screenMode: "alternate",
			emit: () => {}
		});
		ensure(compiled.ok, "FIXTURE_UI_COMPILE", `${label}: ${compiled.message ?? "canonical compilation failed"}`);
		const rows = compiled.value.component.render(width);
		ensure(rows.some((row) => core.visibleWidth(row) > 0), "FIXTURE_UI_BLANK", `${label} rendered blank at ${String(width)} columns`);
		assertNoRawVisibleIds(rows, label);
		for (const [index, row] of rows.entries()) ensure(core.visibleWidth(row) <= width, "FIXTURE_WIDTH_OVERFLOW", `${label} row ${String(index)} exceeded ${String(width)} columns`);
	}
}

await scenario("renderer.width-scan-20-40-80-120", async () => {
	const widths = [20, 40, 80, 120];
	const surface = overlayContribution().request;
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.range-tabs", tabId: "all" }, { signal: new AbortController().signal });
	const node = surface.render();
	const wire = rendered(node);
	ensure(findControl(node, "tokenledger.account-tabs") !== undefined && findControl(node, "tokenledger.range-tabs") !== undefined, "FIXTURE_WIDTH_TAB_LEVELS", "width scan lost one of the tab levels");
	ensure(/"maxWidth":39/u.test(wire) && /"minWidth":40,"maxWidth":63/u.test(wire) && /"minWidth":64,"maxWidth":87/u.test(wire) && /"minWidth":88,"maxWidth":111/u.test(wire) && /"minWidth":112/u.test(wire), "FIXTURE_ACTIVITY_RESPONSIVE", "activity heatmap variants are missing");
	const heatmaps = [];
	const inspect = (value) => {
		if (value === null || typeof value !== "object") return;
		if (value.kind === "stack" && value.children?.length === 5 && value.children.every((child) => child.when !== undefined && child.node?.kind === "stack")) heatmaps.push(value);
		for (const child of Object.values(value)) inspect(child);
	};
	inspect(node);
	ensure(heatmaps.length === 1 && heatmaps[0].children.every((child) => child.node.children.length === 7), "FIXTURE_ACTIVITY_SEVEN_ROWS", "activity heatmap is not seven weekday rows");
	ensure(heatmaps[0].children.every((child) => child.node.children.every((weekday) => weekday.node.spans.slice(1).every((span) => span.text.length === 2))), "FIXTURE_ACTIVITY_SQUARE_CELLS", "activity days do not occupy two terminal columns");
	const nodes = [
		["dashboard", node],
		["loading", companion.buildTokenLedgerView({ serviceAvailable: true, range: "all", modelSort: "tokens", modelSortDirection: "desc", pages: {}, collectionPages: {}, loading: true })],
		["fallback", companion.buildTokenLedgerView({ serviceAvailable: false, range: "all", pages: {}, collectionPages: {} })]
	];
	for (const [label, value] of nodes) scanUi(label, value, widths);
	report.observations.push({ scenario: "renderer.width-scan-20-40-80-120", widths, views: nodes.map(([label]) => label), surface: "single-command-overlay" });
});

await scenario("consumer.unload-and-cleanup", async () => {
	await removeService();
	const manual = manualService(500, 1);
	await provideService(manual.service);
	const lateReplay = manual.listener;
	const overlay = overlayContribution();
	const retainedRender = overlay.request.render;
	ensure(ownerSnapshot().overlays.length === 1, "FIXTURE_UNLOAD_OVERLAY_SETUP", "overlay was not open before unload");

	await companionFiber.dispose();
	companionDisposed = true;
	await settle();
	const after = ownerSnapshot();
	ensure(after.commands.length === 0 && after.status.length === 0 && after.panes.length === 0 && after.overlays.length === 0, "FIXTURE_CONSUMER_CLEANUP", "unload did not dispose command and overlay");
	ensure(manual.listener === undefined && manual.subscriptionDisposed === 1, "FIXTURE_CONSUMER_SUBSCRIPTION", "unload left the Service subscription active");
	lateReplay?.(summary(999, 99));
	ensure(typeof retainedRender() === "object", "FIXTURE_RETAINED_RENDER_SAFE", "retained render callback failed unsafely");
	ensure(sessions.listenerCount === 1, "FIXTURE_SESSION_OWNER_UNEXPECTED", "consumer unload changed the host-owned session reader");
});

try {
	if (currentServiceDisposer !== undefined) await removeService();
	if (!companionDisposed && companionFiber !== undefined) await companionFiber.dispose();
	await domainFixture?.service.dispose();
	notificationRegistration?.dispose();
	sessionRegistration?.dispose();
	ownerLease?.dispose();
	await ctx?.fiber.dispose();
	await compilerContext?.fiber.dispose();
} catch (error) {
	failure("runner.cleanup", error, "FIXTURE_RUNTIME_CLEANUP_FAILED");
}

for (const name of DECLARED) {
	if (!report.executed.includes(name) && !report.skipped.some((entry) => entry.scenario === name)) {
		report.skipped.push({ scenario: name, reason: "scenario did not execute" });
	}
}
const valid = report.failures.length === 0 && report.skipped.length === 0 && report.declared.length === report.executed.length;
process.stdout.write(`${JSON.stringify({ ...report, valid }, null, 2)}\n`);
process.exitCode = valid ? 0 : 1;
