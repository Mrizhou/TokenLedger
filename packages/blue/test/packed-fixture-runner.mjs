/**
 * Runtime half of TokenLedger's independent packed-install fixture.
 *
 * This file is copied into the throwaway install before execution. Every
 * non-Node import below therefore resolves through installed public package
 * exports, never through either source checkout.
 *
 * @module @dsh-blue/tokenledger/packed-fixture-runner
 */

const DECLARED = [
	"package.public-exports",
	"host.capability-absent-and-dynamic-arrival",
	"host.single-command-overlay-admission",
	"renderer.keyboard-navigation-visible-state",
	"projection.replay-and-duplicate-revision",
	"projection.collection-continuation-and-boundary-evidence",
	"action.success-abort-request-and-session-stale",
	"provider.swap-unload-fallback-and-late-result",
	"renderer.width-scan-20-40-80-120",
	"consumer.unload-and-cleanup"
];
const report = {
	declared: [...DECLARED],
	executed: [],
	skipped: [],
	failures: [],
	observations: []
};

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

function rendered(value) {
	return JSON.stringify(value);
}

const RAW_VISIBLE_IDS = [
	"tokenledger.model-sort",
	"tokenledger.export.run",
	"tokenledger.cancel"
];

function assertNoRawVisibleIds(rows, label) {
	const value = rows.join("\n");
	for (const id of RAW_VISIBLE_IDS) {
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

const many = (count, make) => Array.from({ length: count }, (_, index) => make(index));

function usage(tokens = 100, overrides = {}) {
	return {
		version: "0.1.0",
		generatedAt: 1_000 + tokens,
		timeZone: { id: "Asia/Shanghai", offset: "UTC+08:00" },
		range: {},
		totals: {
			inputTokens: Math.max(0, tokens - 30),
			outputTokens: 10,
			cacheReadTokens: 15,
			cacheWriteTokens: 2,
			reasoningTokens: 3,
			requests: 4,
			tokens,
			cacheHitRate: 25
		},
		windows: {
			today: { tokens: Math.floor(tokens / 4), requests: 1 },
			month: { tokens: Math.floor(tokens / 2), requests: 2 },
			all: { tokens, requests: 4 }
		},
		days: many(20, (index) => ({ day: `2026-08-${String((index % 28) + 1).padStart(2, "0")}`, tokens: index + 1, requests: 1 })),
		activity: [{ day: "2026-08-30", tokens, requests: 4 }],
		activityModels: many(20, (index) => ({ day: "2026-08-30", model: `fixture/model-${String(index)}`, tokens: tokens - index, requests: 1 })),
		models: many(300, (index) => ({ model: `fixture/model-${String(index)}`, tokens: 10_000 - index, requests: index + 1, inputTokens: 9_000 - index, outputTokens: 10, cacheReadTokens: 5, cacheHitRate: 20 })),
		sites: many(20, (index) => ({ site: index === 0 ? "direct" : `relay-${String(index)}.example`, tokens: tokens - index, requests: index + 1 })),
		projects: many(20, (index) => ({ project: `/fixture/project-${String(index)}`, label: `Project ${String(index)}`, path: `/fixture/project-${String(index)}`, tokens: tokens - index, requests: 1 })),
		providers: many(20, (index) => ({ provider: `provider-${String(index)}`, tokens: tokens - index, requests: 1 })),
		directory: many(20, (index) => ({ id: index === 0 ? "direct" : `relay-${String(index)}.example`, type: index % 2 === 0 ? "newapi" : "sub2api", routes: [`route-${String(index)}`] })),
		accounts: many(20, (index) => ({ id: `account-${String(index)}`, displayName: `Account ${String(index)}`, origin: `https://relay-${String(index)}.example`, provider: `provider-${String(index)}` })),
		diagnostics: { sessions: 8, unattributedRows: 1, lastUpdatedAt: 900 },
		lastSweepAt: 950,
		priced: {
			currency: "CNY",
			totals: { CNY: tokens / 10_000, USD: tokens / 70_000 },
			rows: many(300, (index) => ({ model: `fixture/model-${String(index)}`, cost: index / 100, currency: "CNY" }))
		},
		...overrides
	};
}

function configuration() {
	return {
		version: "0.1.0",
		settings: { available: true },
		relays: Object.fromEntries(many(20, (index) => [`route-${String(index)}`, { baseUrl: `https://relay-${String(index)}.example`, type: "newapi" }])),
		officialOrigins: ["https://api.deepseek.com"],
		fingerprint: true,
		sweepIntervalMs: 60_000,
		sweepOnStart: true,
		endpoints: [],
		rates: null,
		wallets: Object.fromEntries(many(20, (index) => [`https://relay-${String(index)}.example`, { userId: index + 1, hasToken: true }])),
		walletCache: {}
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
			return usage(tokens, { range: query.range ?? {}, ...(query.site === undefined ? {} : { site: query.site }) });
		},
		readConfiguration() {
			configurationReads += 1;
			return configuration();
		},
		async runAction(action, context) {
			const pending = actions.shift();
			if (pending !== undefined) return pending.promise;
			if (action.type === "usage.refresh" || action.type === "index.rebuild") {
				tokens += 25;
				context.commit();
				return { changed: true, view: usage(tokens), message: `${action.type} completed` };
			}
			if (action.type === "balance.refresh") {
				return {
					changed: false,
					message: "balance refreshed",
					data: {
						fetched: true,
						total: 12.5,
						used: 3,
						granted: 15.5,
						currency: "CNY",
						scheme: "newapi",
						windows: many(20, (index) => ({ kind: `window-${String(index)}`, usedPercent: index, resetsAt: 2_000 + index }))
					}
				};
			}
			if (action.type === "usage.export") {
				return {
					changed: false,
					message: "export generated",
					data: {
						format: action.format === "csv" ? "csv" : "json",
						content: "x".repeat(13_000),
						fileName: `tokenledger.${action.format === "csv" ? "csv" : "json"}`,
						mimeType: action.format === "csv" ? "text/csv" : "application/json"
					}
				};
			}
			return { changed: false, message: `${action.type} completed` };
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
		setTokens(value) {
			tokens = value;
			service.notifyChanged();
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
		current() {
			return summary(tokens, revision);
		},
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
		async queryUsage() {
			const pending = query;
			query = undefined;
			if (pending !== undefined) return pending.promise;
			return { revision, value: domain.createTokenLedgerView(usage(tokens)) };
		},
		async getConfiguration() {
			return { revision, value: configuration() };
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
		get revision() { return revision; },
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
				let disposed = false;
				return {
					get disposed() { return disposed; },
					dispose() {
						disposed = true;
						listeners.delete(next);
					}
				};
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
	return currentServiceDisposer;
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
	return rendered(surface.render()).includes(`\"label\":\"令牌总数\",\"value\":[{\"text\":\"${String(value)}\"`);
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
	ensure(absent.commands.length === 1 && absent.commands[0]?.id === "tokenledger", "FIXTURE_SINGLE_COMMAND", "Blue must expose exactly one /tokenledger command");
	ensure(absent.status.length === 0 && absent.panes.length === 0 && absent.overlays.length === 0, "FIXTURE_COMMAND_ONLY_IDLE", "TokenLedger registered an idle status, pane, or overlay");
	const fallbackOverlay = await openDashboard();
	ensure(/服务暂不可用/u.test(rendered(fallbackOverlay.request.render())), "FIXTURE_SERVICE_ABSENT_OVERLAY", "service-absent overlay did not expose the Chinese Web/plain fallback");
	ensure(ownerLease.closeOverlay(fallbackOverlay).ok, "FIXTURE_FALLBACK_OVERLAY_CLOSE", "service-absent overlay could not close");

	domainFixture = createDomainFixture(100);
	await provideService(domainFixture.service);
	const ready = ownerSnapshot();
	ensure(ready.commands.length === 1 && ready.status.length === 0 && ready.panes.length === 0 && ready.overlays.length === 0, "FIXTURE_DYNAMIC_SERVICE_IDLE", "late tokenLedgerV1 arrival created a persistent surface");
});

await scenario("host.single-command-overlay-admission", async () => {
	const overlay = await openDashboard();
	ensure(overlay.request.capturing === true && overlay.request.dismissible === true, "FIXTURE_OVERLAY_POLICY", "command did not open the expected capturing, dismissible overlay");
	ensure(overlay.request.title === undefined, "FIXTURE_OVERLAY_DOUBLE_FRAME", "managed overlay title would wrap the dynamic TokenLedger surface in a second frame");
	ensure(typeof overlay.request.onEvent === "function" && typeof overlay.request.render === "function", "FIXTURE_OVERLAY_CALLBACK", "managed overlay callbacks are incomplete");
	const node = overlay.request.render();
	ensure(node?.kind === "surface" && node.chrome === "overlay", "FIXTURE_OVERLAY_SINGLE_FRAME", "TokenLedger did not return the single dynamic overlay surface");
	const view = rendered(node);
	ensure(/TokenLedger · 总览/u.test(view) && /当前页：总览/u.test(view) && /"activeId":"overview"/u.test(view), "FIXTURE_OVERLAY_RENDER", "overlay did not expose its Chinese page state to the canonical renderer");
	ensure(!/(?:●|○) (?:总览|明细|账户|导出|站点|模型|项目|提供方|活动)/u.test(view), "FIXTURE_OVERLAY_RAW_TAB_MARKER", "wire tab labels duplicated renderer-owned active markers");
	ensure(/Tab\/Shift\+Tab 切换标签层级/u.test(view) && /←\/→ 切换本层标签/u.test(view) && /↓ 进入内容/u.test(view) && /↑\/↓ 浏览内容/u.test(view) && /Enter\/Space 确认/u.test(view) && /PgUp\/PgDn 翻页/u.test(view), "FIXTURE_OVERLAY_GUIDE", "overlay did not render the persistent Chinese keyboard guide");
	ensure(!/● 设置|○ 设置|运行设置|tokenledger\.(?:settings|relays|wallets|relay-form|wallet-form)/u.test(view), "FIXTURE_OVERLAY_SETTINGS", "overlay retained its retired settings surface");
	ensure(domainFixture.configurationReads === 0, "FIXTURE_OVERLAY_CONFIGURATION_READ", "overlay read the retired companion configuration surface");
});

await scenario("renderer.keyboard-navigation-visible-state", async () => {
	const overlay = overlayContribution().request;
	// The keyboard probe renders the complete 371-day overview so focus paint is
	// observable below the heatmap. Width/normal-height behavior has a separate
	// 20/40/80/120 width-scan scenario.
	const viewport = { columns: 100, rows: 120 };
	const compileSurface = (events) => {
		const result = core.compileBlueUiNode(overlay.render(), {
			components: compilerComponents,
			colors: themeDark.DARK_COLORS,
			getViewport: () => viewport,
			screenMode: "alternate",
			emit: (event) => events.push(event)
		});
		ensure(result.ok && result.value.focusTarget !== null, "FIXTURE_KEYBOARD_COMPILE", "interactive overlay did not compile with a focus target");
		result.value.focusTarget.focused = true;
		return result.value;
	};
	const rows = (compiled) => compiled.component.render(viewport.columns).join("\n");
	const identity = (compiled) => compiled.focusTarget.captureFocusIdentity?.();
	const replaceAfterRefresh = (previous, events, code) => {
		const previousIdentity = identity(previous);
		ensure(previousIdentity !== undefined, `${code}_CAPTURE`, "focused control did not expose a semantic identity before redraw");
		const next = compileSurface(events);
		ensure(next.focusTarget.restoreFocusIdentity?.(previousIdentity) === true, `${code}_RESTORE`, "replacement focus target did not restore the prior semantic candidate");
		next.focusTarget.focused = true;
		return next;
	};
	const assertCanonicalMarkers = (value, code) => {
		ensure(!/● ●|○ ○/u.test(value), code, "domain tab labels duplicated canonical renderer markers");
	};
	const moveToControl = (compiled, controlId) => {
		for (let count = 0; count < 12 && identity(compiled)?.controlId !== controlId; count += 1) compiled.focusTarget.handleInput?.("\x1b[B");
		return identity(compiled);
	};

	let events = [];
	let compiled = compileSurface(events);
	const before = rows(compiled);
	ensure(/‹ ● 总览 ›/u.test(before) && /○ 明细/u.test(before) && !/→[^\n]*‹ ● 总览 ›/u.test(before), "FIXTURE_INITIAL_FOCUS_VISIBLE", "canonical tabs did not render one active marker, one inactive marker, and no redundant active arrow");
	assertCanonicalMarkers(before, "FIXTURE_INITIAL_SINGLE_MARKERS");
	compiled.focusTarget.handleInput?.("\t");
	const tabStayed = rows(compiled);
	ensure(/‹ ● 总览 ›/u.test(tabStayed) && !/→[^\n]*‹ ● 总览 ›/u.test(tabStayed) && !/→[^\n]*全部时间/u.test(tabStayed), "FIXTURE_TAB_DOMAIN_ONLY", "Tab escaped the only visible tab group into an ordinary content control");
	compiled.focusTarget.handleInput?.("\x1b[B");
	const rangeFocused = rows(compiled);
	ensure(/→[^\n]*全部时间/u.test(rangeFocused), "FIXTURE_DOWN_ENTERS_CONTENT", "Down did not visibly enter the selected range list");
	compiled.focusTarget.handleInput?.("\x1b[Z");
	const tabFocused = rows(compiled);
	ensure(/‹ ● 总览 ›/u.test(tabFocused) && !/→[^\n]*‹ ● 总览 ›/u.test(tabFocused), "FIXTURE_SHIFT_TAB_GROUP_VISIBLE", "Shift+Tab from content did not restore the remembered tab group");
	compiled.focusTarget.handleInput?.("\x1b[C");
	const rightFocused = rows(compiled);
	ensure(/→[^\n]*○ 明细/u.test(rightFocused), "FIXTURE_RIGHT_FOCUS_VISIBLE", "Right did not visibly move focus to 明细");
	compiled.focusTarget.handleInput?.("\x1b[D");
	const leftFocused = rows(compiled);
	ensure(/‹ ● 总览 ›/u.test(leftFocused) && !/→[^\n]*‹ ● 总览 ›/u.test(leftFocused), "FIXTURE_LEFT_FOCUS_VISIBLE", "Left did not visibly restore focus to 总览");
	compiled.focusTarget.handleInput?.("\x1b[C");
	compiled.focusTarget.handleInput?.("\r");
	ensure(events.length === 1 && events[0]?.kind === "tab-change" && events[0]?.tabId === "breakdown", "FIXTURE_KEYBOARD_TAB_EVENT", "keyboard confirmation did not select the 明细 tab");
	const switched = await overlay.onEvent(events[0], { signal: new AbortController().signal });
	ensure(switched.ok, "FIXTURE_KEYBOARD_TAB_SWITCH", switched.message ?? "keyboard tab switch failed");
	events = [];
	compiled = replaceAfterRefresh(compiled, events, "FIXTURE_MAIN_TAB_REDRAW");
	const after = rows(compiled);
	ensure(/TokenLedger · 明细/u.test(after) && /当前页：明细/u.test(after) && /‹ ● 明细 ›/u.test(after), "FIXTURE_KEYBOARD_ACTIVE_STATE", "selected page was not visibly reflected after canonical redraw");
	ensure(identity(compiled)?.controlId === "tokenledger.tabs" && identity(compiled)?.itemId === "breakdown", "FIXTURE_MAIN_TAB_FOCUS_PERSIST", "main-tab selection reset focus after redraw");
	assertCanonicalMarkers(after, "FIXTURE_MAIN_TAB_SINGLE_MARKERS");

	compiled.focusTarget.handleInput?.("\t");
	ensure(/‹ ● 站点 ›/u.test(rows(compiled)) && !/→[^\n]*‹ ● 站点 ›/u.test(rows(compiled)), "FIXTURE_NESTED_TAB_FOCUS", "Tab did not visibly reach the active 站点 detail tab");
	compiled.focusTarget.handleInput?.("\x1b[B");
	ensure(/→[^\n]*直连 \/ 官方/u.test(rows(compiled)), "FIXTURE_NESTED_DOWN_CONTENT", "Down from the detail tab group did not enter the site list");
	compiled.focusTarget.handleInput?.("\t");
	ensure(/‹ ● 站点 ›/u.test(rows(compiled)) && !/→[^\n]*‹ ● 站点 ›/u.test(rows(compiled)), "FIXTURE_CONTENT_TAB_RETURN", "Tab from detail content did not restore the remembered detail tab group");
	compiled.focusTarget.handleInput?.("\x1b[C");
	ensure(/→[^\n]*○ 模型/u.test(rows(compiled)), "FIXTURE_NESTED_RIGHT_FOCUS", "Right did not visibly focus 模型");
	compiled.focusTarget.handleInput?.(" ");
	const nestedEvent = events.at(-1);
	ensure(nestedEvent?.kind === "tab-change" && nestedEvent.tabId === "models", "FIXTURE_NESTED_TAB_EVENT", "Space confirmation did not select the 模型 detail tab");
	const nestedSwitched = await overlay.onEvent(nestedEvent, { signal: new AbortController().signal });
	ensure(nestedSwitched.ok, "FIXTURE_NESTED_TAB_SWITCH", nestedSwitched.message ?? "detail tab switch failed");
	events = [];
	compiled = replaceAfterRefresh(compiled, events, "FIXTURE_DETAIL_TAB_REDRAW");
	ensure(/当前明细：模型/u.test(rows(compiled)) && /‹ ● 模型 ›/u.test(rows(compiled)), "FIXTURE_NESTED_ACTIVE_STATE", "selected detail was not visibly reflected after Space and redraw");
	ensure(identity(compiled)?.controlId === "tokenledger.breakdown.tabs" && identity(compiled)?.itemId === "models", "FIXTURE_DETAIL_TAB_FOCUS_PERSIST", "detail-tab selection reset focus after redraw");
	assertCanonicalMarkers(rows(compiled), "FIXTURE_DETAIL_TAB_SINGLE_MARKERS");

	// Return to overview, then reproduce the original range-list regression with
	// a genuinely pending query and a replacement canonical focus target.
	compiled.focusTarget.handleInput?.("\x1b[Z");
	compiled.focusTarget.handleInput?.("\x1b[D");
	compiled.focusTarget.handleInput?.("\r");
	const overviewEvent = events.at(-1);
	ensure(overviewEvent?.kind === "tab-change" && overviewEvent.tabId === "overview", "FIXTURE_RANGE_OVERVIEW_EVENT", "keyboard navigation did not return to 总览");
	ensure((await overlay.onEvent(overviewEvent, { signal: new AbortController().signal })).ok, "FIXTURE_RANGE_OVERVIEW_SWITCH", "overview tab switch failed");
	events = [];
	compiled = replaceAfterRefresh(compiled, events, "FIXTURE_RANGE_OVERVIEW_REDRAW");
	compiled.focusTarget.handleInput?.("\x1b[B");
	ensure(identity(compiled)?.controlId === "tokenledger.range-list" && identity(compiled)?.itemId === "range:all", "FIXTURE_RANGE_LIST_ENTRY", "Down did not focus the current range candidate");
	compiled.focusTarget.handleInput?.("\x1b[A");
	ensure(identity(compiled)?.itemId === "range:month", "FIXTURE_RANGE_MONTH_CANDIDATE", "Up did not move to 本月 within the range list");
	const monthRead = domainFixture.deferNextRead();
	compiled.focusTarget.handleInput?.(" ");
	const monthEvent = events.at(-1);
	ensure(monthEvent?.kind === "selection-change" && monthEvent.controlId === "tokenledger.range-list" && monthEvent.value === "range:month", "FIXTURE_RANGE_SPACE_EVENT", "Space did not confirm 本月");
	const monthRequest = overlay.onEvent(monthEvent, { signal: new AbortController().signal });
	await tick();
	monthRead.resolve(usage(domainFixture.tokens));
	ensure((await monthRequest).ok, "FIXTURE_RANGE_MONTH_QUERY", "async 本月 query failed");
	events = [];
	compiled = replaceAfterRefresh(compiled, events, "FIXTURE_RANGE_ASYNC_REDRAW");
	ensure(identity(compiled)?.controlId === "tokenledger.range-list" && identity(compiled)?.itemId === "range:month", "FIXTURE_RANGE_FOCUS_PERSIST", "async range redraw reset focus to the main tabs");
	ensure(/→[^\n]*本月/u.test(rows(compiled)), "FIXTURE_RANGE_FOCUS_VISIBLE", "restored 本月 focus was not visible");
	compiled.focusTarget.handleInput?.("\x1b[A");
	const todayRead = domainFixture.deferNextRead();
	compiled.focusTarget.handleInput?.("\r");
	const todayEvent = events.at(-1);
	ensure(todayEvent?.kind === "selection-change" && todayEvent.value === "range:today", "FIXTURE_RANGE_ENTER_EVENT", "Enter could not select 今天 without returning through Tab");
	const todayRequest = overlay.onEvent(todayEvent, { signal: new AbortController().signal });
	await tick();
	todayRead.resolve(usage(domainFixture.tokens));
	ensure((await todayRequest).ok, "FIXTURE_RANGE_TODAY_QUERY", "second range query failed");
	events = [];
	compiled = replaceAfterRefresh(compiled, events, "FIXTURE_RANGE_SECOND_REDRAW");
	ensure(identity(compiled)?.itemId === "range:today", "FIXTURE_RANGE_CONTINUED_FOCUS", "second range selection required a new Tab traversal");

	// PgUp/PgDn are real terminal escape sequences and must dispatch only while
	// the matching list scope owns focus; the paging actions never enter focus.
	compiled.focusTarget.handleInput?.("\t");
	compiled.focusTarget.handleInput?.("\x1b[C");
	compiled.focusTarget.handleInput?.("\r");
	const breakdownEvent = events.at(-1);
	ensure(breakdownEvent?.kind === "tab-change" && breakdownEvent.tabId === "breakdown", "FIXTURE_PAGING_BREAKDOWN_EVENT", "could not return to 明细 for scoped paging");
	ensure((await overlay.onEvent(breakdownEvent, { signal: new AbortController().signal })).ok, "FIXTURE_PAGING_BREAKDOWN_SWITCH", "breakdown tab switch failed");
	events = [];
	compiled = replaceAfterRefresh(compiled, events, "FIXTURE_PAGING_BREAKDOWN_REDRAW");
	compiled.focusTarget.handleInput?.("\t");
	ensure(identity(compiled)?.controlId === "tokenledger.breakdown.tabs" && identity(compiled)?.itemId === "models", "FIXTURE_PAGING_MODEL_FOCUS", "remembered detail level did not return to 模型");
	const beforeUnscoped = events.length;
	compiled.focusTarget.handleInput?.("\x1b[6~");
	ensure(events.length === beforeUnscoped, "FIXTURE_PAGEDOWN_TAB_SCOPE", "PgDn escaped the focused detail-tab scope");
	compiled.focusTarget.handleInput?.("\x1b[B");
	compiled.focusTarget.handleInput?.("\x1b[6~");
	ensure(events.length === beforeUnscoped, "FIXTURE_PAGEDOWN_FORM_SCOPE", "PgDn escaped the model-sort form scope");
	const modelIdentity = moveToControl(compiled, "tokenledger.models");
	ensure(modelIdentity?.controlId === "tokenledger.models", "FIXTURE_PAGING_LIST_FOCUS", "Down did not reach the model list paging scope");
	compiled.focusTarget.handleInput?.("\x1b[6~");
	const pageDownEvent = events.at(-1);
	ensure(pageDownEvent?.kind === "activate" && pageDownEvent.controlId === "tokenledger.page.models.next", "FIXTURE_PAGEDOWN_DISPATCH", "PgDn did not dispatch the scoped next-page action");
	ensure((await overlay.onEvent(pageDownEvent, { signal: new AbortController().signal })).ok, "FIXTURE_PAGEDOWN_ACTION", "scoped next-page action failed");
	events = [];
	compiled = compileSurface(events);
	compiled.focusTarget.handleInput?.("\t");
	const secondPageIdentity = moveToControl(compiled, "tokenledger.models");
	ensure(secondPageIdentity?.controlId === "tokenledger.models" && !secondPageIdentity.itemId?.includes("page.models"), "FIXTURE_PAGING_ACTION_NOT_FOCUSABLE", "pagination action entered the focus inventory");
	compiled.focusTarget.handleInput?.("\x1b[5~");
	const pageUpEvent = events.at(-1);
	ensure(pageUpEvent?.kind === "activate" && pageUpEvent.controlId === "tokenledger.page.models.prev", "FIXTURE_PAGEUP_DISPATCH", "PgUp did not dispatch the scoped previous-page action");
	ensure((await overlay.onEvent(pageUpEvent, { signal: new AbortController().signal })).ok, "FIXTURE_PAGEUP_ACTION", "scoped previous-page action failed");
});

await scenario("projection.replay-and-duplicate-revision", async () => {
	await removeService();
	const manual = manualService(300, 5);
	await provideService(manual.service);
	const overlay = overlayContribution().request;
	await overlay.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "overview" }, { signal: new AbortController().signal });
	ensure(usageTokens(overlay, 300), "FIXTURE_MANUAL_REPLAY", "replacement service replay did not activate");
	manual.emit(5, 999);
	ensure(!usageTokens(overlay, 999), "FIXTURE_DUPLICATE_REVISION", "same-revision conflicting replay replaced current state");
	manual.emit(4, 888);
	ensure(!usageTokens(overlay, 888), "FIXTURE_REGRESSED_REVISION", "regressed replay replaced current state");
	manual.emit(6, 600);
	ensure(usageTokens(overlay, 600), "FIXTURE_MONOTONIC_REPLAY", "newer replay did not replace current state");
	await removeService();
	ensure(manual.subscriptionDisposed === 1, "FIXTURE_REPLAY_SUBSCRIPTION_DISPOSE", "service subscription was not disposed exactly once");
	await provideService(domainFixture.service);
});

await scenario("projection.collection-continuation-and-boundary-evidence", async () => {
	const surface = overlayContribution().request;
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "breakdown" }, { signal: new AbortController().signal });
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.breakdown.tabs", tabId: "models" }, { signal: new AbortController().signal });
	const initial = rendered(surface.render());
	ensure(/初始边界外还有 44 条/u.test(initial), "FIXTURE_COLLECTION_BOUNDARY_NOTICE", "fixed model truncation was not disclosed with its exact omitted count");
	ensure(/第 1 \/ 19 页/u.test(initial), "FIXTURE_COLLECTION_TOTAL", "model pagination presented the returned prefix as the complete collection");

	const direct = await domainFixture.service.queryCollection({
		requestId: "fixture-model-page",
		expectedRevision: domainFixture.service.current().revision,
		collection: "models",
		offset: 288,
		limit: 16,
		sortBy: "tokens",
		direction: "desc"
	});
	ensure(direct.value.sourceCount === 300 && direct.value.returnedCount === 12 && direct.value.omittedCount === 288, "FIXTURE_COLLECTION_COUNTS", "collection continuation counts are not exact");
	ensure(direct.value.items.at(-1)?.model === "fixture/model-299", "FIXTURE_COLLECTION_LAST_ROW", "collection continuation did not retain the final source row");

	for (let page = 1; page < 19; page += 1) {
		const result = await surface.onEvent({ kind: "activate", controlId: "tokenledger.page.models.next" }, { signal: new AbortController().signal });
		ensure(result.ok, "FIXTURE_COLLECTION_NEXT", result.message ?? `model continuation page ${String(page + 1)} failed`);
	}
	const final = rendered(surface.render());
	ensure(/第 19 \/ 19 页/u.test(final), "FIXTURE_COLLECTION_FINAL_PAGE", "TUI did not reach the final continuation page");
	ensure(/fixture\/model-299/u.test(final), "FIXTURE_COLLECTION_FINAL_RENDER", "TUI did not render the final continued model row");
	const selected = await surface.onEvent({ kind: "selection-change", controlId: "tokenledger.models", value: "model:299" }, { signal: new AbortController().signal });
	ensure(selected.ok && /已选模型/u.test(rendered(surface.render())), "FIXTURE_COLLECTION_SELECTION", "absolute selection failed on a continued page");
	const sorted = await surface.onEvent({ kind: "submit", controlId: "tokenledger.model-sort-form", values: { sort: "cost" } }, { signal: new AbortController().signal });
	ensure(sorted.ok && /fixture\/model-299/u.test(rendered(surface.render())), "FIXTURE_COLLECTION_COST_SORT", "service-owned cost sorting did not surface the highest-cost row");
});

await scenario("action.success-abort-request-and-session-stale", async () => {
	const surface = overlayContribution().request;
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "overview" }, { signal: new AbortController().signal });
	const refreshed = await surface.onEvent({ kind: "activate", controlId: "tokenledger.refresh" }, { signal: new AbortController().signal });
	ensure(refreshed.ok && domainFixture.tokens === 125, "FIXTURE_ACTION_SUCCESS", "Service-owned usage refresh did not commit");
	ensure(usageTokens(surface, 125), "FIXTURE_ACTION_REPLAY", "committed action did not publish a new summary");
	ensure(notices.some((notice) => notice.tone === "success"), "FIXTURE_ACTION_NOTIFICATION", "successful action did not publish a notification");

	const lateAction = domainFixture.deferNextAction();
	const actionAbort = new AbortController();
	const pendingAction = surface.onEvent({ kind: "activate", controlId: "tokenledger.refresh" }, { signal: actionAbort.signal });
	await tick();
	actionAbort.abort();
	const abortedAction = await pendingAction;
	ensure(abortedAction.code === "BLUE_ABORTED", "FIXTURE_ACTION_ABORT", "caller abort did not reject the in-flight action");
	lateAction.resolve({ changed: false, message: "late action" });
	await settle();
	ensure(!/late action/u.test(rendered(surface.render())), "FIXTURE_ACTION_LATE_RESULT", "late aborted action republished UI state");

	const firstRead = domainFixture.deferNextRead();
	const first = surface.onEvent({ kind: "selection-change", controlId: "tokenledger.range-list", value: "range:month" }, { signal: new AbortController().signal });
	await tick();
	const second = await surface.onEvent({ kind: "selection-change", controlId: "tokenledger.range-list", value: "range:today" }, { signal: new AbortController().signal });
	ensure(second.ok, "FIXTURE_REQUEST_REPLACEMENT", "replacement range request did not complete");
	firstRead.resolve(usage(999));
	const stale = await first;
	ensure(stale.code === "BLUE_ABORTED" || stale.code === "BLUE_STALE", "FIXTURE_REQUEST_STALE", "superseded range request did not reject as stale/aborted");
	ensure(!usageTokens(surface, 999), "FIXTURE_REQUEST_LATE_RESULT", "superseded range result reached the dashboard");

	const sessionRead = domainFixture.deferNextRead();
	const pendingSessionRead = surface.onEvent({ kind: "selection-change", controlId: "tokenledger.range-list", value: "range:all" }, { signal: new AbortController().signal });
	await tick();
	sessions.publish({ revision: 2, sessionEpoch: 2, id: "fixture-session-b", cwd: "/fixture/b", status: "idle", mode: "normal", model: { id: "fixture-model", provider: "fixture" } });
	await settle();
	sessionRead.resolve(usage(777));
	const sessionStale = await pendingSessionRead;
	ensure(sessionStale.code === "BLUE_ABORTED" || sessionStale.code === "BLUE_STALE", "FIXTURE_SESSION_STALE", "session swap did not fence the old usage request");
	ensure(!usageTokens(surface, 777), "FIXTURE_SESSION_LATE_RESULT", "old-session result reached the new frontend tree");
});

await scenario("provider.swap-unload-fallback-and-late-result", async () => {
	const surface = overlayContribution().request;
	await removeService();
	ensure(/服务暂不可用/u.test(rendered(surface.render())), "FIXTURE_PROVIDER_UNLOAD_FALLBACK", "domain provider unload did not restore the visible fallback");

	const first = manualService(300, 1);
	await provideService(first.service);
	const pending = first.deferNextQuery();
	const lateRead = surface.onEvent({ kind: "selection-change", controlId: "tokenledger.range-list", value: "range:today" }, { signal: new AbortController().signal });
	await tick();
	const lateReplay = first.listener;
	await removeService();
	pending.resolve({ revision: 1, value: domain.createTokenLedgerView(usage(999)) });
	const rejected = await lateRead;
	ensure(rejected.code === "BLUE_ABORTED" || rejected.code === "BLUE_STALE", "FIXTURE_PROVIDER_LATE_READ", "unloaded provider read did not reject");
	ensure(!usageTokens(surface, 999), "FIXTURE_PROVIDER_LATE_READ_RENDER", "unloaded provider read republished dashboard state");

	const replacement = manualService(400, 1);
	await provideService(replacement.service);
	ensure(usageTokens(surface, 400), "FIXTURE_PROVIDER_SWAP", "replacement provider did not activate");
	lateReplay?.(summary(888, 99));
	ensure(!usageTokens(surface, 888), "FIXTURE_PROVIDER_LATE_REPLAY", "old provider callback replaced the active provider");
	await removeService();
	await provideService({ current() {} });
	ensure(/不符合公开 Service 契约/u.test(rendered(surface.render())), "FIXTURE_PROVIDER_INVALID_FALLBACK", "invalid provider did not fail visibly and locally");
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
		ensure(compiled.ok, "FIXTURE_UI_COMPILE", `${label}: ${compiled.message ?? "canonical UI compilation failed"}`);
		const rows = compiled.value.component.render(width);
		assertNoRawVisibleIds(rows, label);
		for (const [index, row] of rows.entries()) {
			ensure(core.visibleWidth(row) <= width, "FIXTURE_WIDTH_OVERFLOW", `${label} row ${String(index)} exceeded ${String(width)} columns`);
		}
	}
}

await scenario("renderer.width-scan-20-40-80-120", async () => {
	const widths = [20, 40, 80, 120];
	const surface = overlayContribution().request;
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "overview" }, { signal: new AbortController().signal });
	const overviewNode = surface.render();
	const overviewWire = rendered(overviewNode);
	ensure(/按日活动热力图 · 最近 371 天/u.test(overviewWire), "FIXTURE_ACTIVITY_HEATMAP", "overview did not retain the WebUI-equivalent 371-day activity heatmap");
	ensure(/"text":"░░"/u.test(overviewWire) && /"text":"██"/u.test(overviewWire), "FIXTURE_ACTIVITY_LEVELS", "activity heatmap did not expose the double-cell intensity ramp");
	ensure(core.visibleWidth("░░") === 2 && core.visibleWidth("░░ ") === 3, "FIXTURE_ACTIVITY_CELL_WIDTH", "one activity day is not two terminal columns plus one gap");
	const nodes = [["overview", overviewNode]];
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "breakdown" }, { signal: new AbortController().signal });
	for (const tabId of ["sites", "models", "projects", "providers", "activity"]) {
		await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.breakdown.tabs", tabId }, { signal: new AbortController().signal });
		nodes.push([`breakdown.${tabId}`, surface.render()]);
	}
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "accounts" }, { signal: new AbortController().signal });
	await surface.onEvent({ kind: "activate", controlId: "tokenledger.balance.refresh" }, { signal: new AbortController().signal });
	nodes.push(["accounts", surface.render()]);
	await surface.onEvent({ kind: "tab-change", controlId: "tokenledger.tabs", tabId: "export" }, { signal: new AbortController().signal });
	await surface.onEvent({ kind: "submit", controlId: "tokenledger.export-form", values: { format: "json" } }, { signal: new AbortController().signal });
	nodes.push(["export", surface.render()]);
	nodes.push(["loading", companion.buildTokenLedgerView({ serviceAvailable: true, tab: "overview", range: "all", pages: {}, loading: true })]);
	for (const [label, node] of nodes) scanUi(label, node, widths);
	report.observations.push({ scenario: "renderer.width-scan-20-40-80-120", widths, views: nodes.map(([label]) => label), surface: "command-opened-overlay" });
});

await scenario("consumer.unload-and-cleanup", async () => {
	await removeService();
	const manual = manualService(500, 1);
	await provideService(manual.service);
	const lateReplay = manual.listener;
	const overlay = overlayContribution();
	const retainedRender = overlay.request.render;
	ensure(ownerSnapshot().overlays.length === 1, "FIXTURE_UNLOAD_OVERLAY_SETUP", "managed overlay was not open before consumer unload");

	await companionFiber.dispose();
	companionDisposed = true;
	await settle();
	const after = ownerSnapshot();
	ensure(after.commands.length === 0 && after.status.length === 0 && after.panes.length === 0 && after.overlays.length === 0, "FIXTURE_CONSUMER_CLEANUP", "consumer unload did not dispose the command and close its overlay");
	ensure(manual.listener === undefined && manual.subscriptionDisposed === 1, "FIXTURE_CONSUMER_SUBSCRIPTION", "consumer unload left the Service subscription active");
	lateReplay?.(summary(999, 99));
	ensure(ownerSnapshot().commands.length === 0, "FIXTURE_CONSUMER_LATE_REPLAY", "late callback recreated a disposed contribution");
	ensure(typeof retainedRender() === "object", "FIXTURE_RETAINED_RENDER_SAFE", "retained render callback failed closed unsafely");
	ensure(sessions.listenerCount === 1, "FIXTURE_SESSION_OWNER_UNEXPECTED", "consumer unload changed the host-owned session reader subscription");
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
const valid = report.failures.length === 0
	&& report.skipped.length === 0
	&& report.declared.length === report.executed.length;
process.stdout.write(`${JSON.stringify({ ...report, valid }, null, 2)}\n`);
process.exitCode = valid ? 0 : 1;
