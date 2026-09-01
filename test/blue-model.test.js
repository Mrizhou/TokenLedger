/** TokenLedger Blue interaction-model admission and Web-parity tests. */

import assert from "node:assert/strict";
import test from "node:test";

import {
	TOKEN_LEDGER_BLUE_MODEL,
	activityLevelScale,
	buildTokenLedgerView,
	copyPublicJson,
	normalizeTokenLedgerBalance,
	normalizeTokenLedgerSummary,
	normalizeTokenLedgerView,
	tokenLedgerAccountTabId
} from "../src/blue/model.js";

const many = (count, make) => Array.from({ length: count }, (_, index) => make(index));

function usage(overrides = {}) {
	return {
		version: "0.1.0",
		generatedAt: Date.UTC(2026, 7, 30, 12),
		timeZone: { id: "Asia/Shanghai", offset: "UTC+08:00" },
		range: {},
		totals: {
			inputTokens: 30_000,
			outputTokens: 2_000,
			cacheReadTokens: 8_000,
			requests: 42,
			tokens: 40_500,
			cacheHitRate: 21.1
		},
		windows: {
			today: { tokens: 1_000, requests: 2 },
			month: { tokens: 20_000, requests: 20 },
			all: { tokens: 40_500, requests: 42 }
		},
		activity: many(371, (index) => {
			const day = new Date(Date.UTC(2025, 7, 25) + index * 86_400_000);
			return { day: day.toISOString().slice(0, 10), tokens: index % 17 === 0 ? index + 1 : 0, requests: index % 17 === 0 ? 1 : 0 };
		}),
		activityModels: [{ day: "2026-08-30", model: "deepseek-chat", tokens: 100, requests: 1 }],
		models: many(24, (index) => ({
			model: `model-${String(index)}`,
			tokens: 10_000 - index,
			requests: index,
			inputTokens: 8_000 - index,
			outputTokens: 100,
			cacheReadTokens: 200
		})),
		sites: many(18, (index) => ({ site: index === 0 ? "direct" : `relay-${String(index)}.example`, tokens: 4_000 - index, requests: index })),
		projects: many(20, (index) => ({ project: `/work/project-${String(index)}`, label: `项目 ${String(index)}`, tokens: 2_025, requests: index })),
		accounts: many(12, (index) => ({ id: `account-${String(index)}`, displayName: `账户 ${String(index)}`, origin: `https://relay-${String(index)}.example`, provider: `provider-${String(index)}` })),
		diagnostics: { sessions: 8, unattributedRows: 2, lastUsageAt: Date.UTC(2026, 7, 30, 12) },
		lastSweepAt: Date.UTC(2026, 7, 30, 12),
		priced: {
			currency: "CNY",
			totals: { CNY: 1.2345 },
			rows: many(24, (index) => ({ model: `model-${String(index)}`, cost: index / 100, currency: "CNY" }))
		},
		...overrides
	};
}

function summary(overrides = {}) {
	const view = usage();
	return {
		revision: 3,
		capturedAt: view.generatedAt,
		version: view.version,
		timeZone: view.timeZone,
		totals: { selected: view.totals, today: view.windows.today, month: view.windows.month, all: view.windows.all },
		activity: view.activity,
		models: view.models,
		sites: view.sites,
		projects: view.projects,
		accounts: view.accounts,
		diagnostics: view.diagnostics,
		priced: view.priced,
		freshness: { lastSweepAt: view.lastSweepAt },
		...overrides
	};
}

function state(overrides = {}) {
	return {
		range: "all",
		modelSort: "tokens",
		modelSortDirection: "desc",
		pages: {},
		collectionPages: {},
		controllerAvailable: true,
		snapshot: normalizeTokenLedgerSummary(summary()),
		view: normalizeTokenLedgerView(usage()),
		viewRevision: 3,
		loading: false,
		error: "",
		...overrides
	};
}

function collect(root, predicate) {
	const found = [];
	const seen = new WeakSet();
	const visit = (value) => {
		if (value === null || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (predicate(value)) found.push(value);
		for (const child of Object.values(value)) visit(child);
	};
	visit(root);
	return found;
}

function control(root, id) {
	return collect(root, (value) => value.id === id)[0];
}

function auditWire(root) {
	let values = 0;
	let textUnits = 0;
	const active = new WeakSet();
	const visit = (value, depth = 0) => {
		if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") return;
		if (typeof value === "string") {
			textUnits += value.length;
			assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), false);
			return;
		}
		assert.equal(typeof value, "object");
		assert.ok(depth <= 20, `wire depth ${String(depth)}`);
		assert.equal(active.has(value), false, "wire cycle");
		assert.equal(Object.isFrozen(value), true, "wire value must be deeply frozen");
		active.add(value);
		values += 1;
		for (const child of Object.values(value)) visit(child, depth + 1);
		active.delete(value);
	};
	visit(root);
	assert.ok(values <= 3_000, `wire values ${String(values)}`);
	assert.ok(textUnits <= 24_000, `wire text ${String(textUnits)}`);
}

test("normalizers reject proxies and accessors without invoking them", () => {
	let invoked = false;
	const accessor = {};
	Object.defineProperty(accessor, "revision", { get() { invoked = true; throw new Error("must not run"); } });
	assert.equal(normalizeTokenLedgerSummary(accessor), undefined);
	assert.equal(invoked, false);

	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	for (const normalize of [copyPublicJson, normalizeTokenLedgerView, normalizeTokenLedgerBalance]) {
		assert.equal(normalize(revoked.proxy), undefined);
	}
});

test("public copies are bounded, frozen, and credential filtered", () => {
	const copied = copyPublicJson({
		visible: "yes",
		password: "hidden",
		nested: { authorization: "Bearer hidden", value: "kept" },
		rows: many(2_200, (index) => ({ index, value: "x".repeat(10) }))
	});
	assert.ok(copied);
	assert.equal(copied.truncated, true);
	assert.equal(Object.isFrozen(copied.value), true);
	assert.equal(JSON.stringify(copied.value).includes("hidden"), false);
	assert.equal(copied.value.rows.length, 2_048);

	const wide = { visible: "yes" };
	Object.defineProperties(wide, {
		__proto__: { value: { polluted: true }, enumerable: true },
		constructor: { value: "unsafe", enumerable: true },
		prototype: { value: "unsafe", enumerable: true }
	});
	for (let index = 0; index < 50_000; index += 1) wide[`field-${String(index)}`] = index;
	const bounded = copyPublicJson(wide);
	assert.ok(bounded);
	assert.equal(bounded.truncated, true);
	assert.equal(bounded.value.visible, "yes");
	for (const key of ["__proto__", "constructor", "prototype"]) assert.equal(Object.hasOwn(bounded.value, key), false);
	assert.ok(Object.keys(bounded.value).length <= 128);
});

test("one Chinese dashboard mirrors the Web section order and exposes only two tab levels", () => {
	const view = buildTokenLedgerView(state());
	const rendered = JSON.stringify(view);
	auditWire(view);
	assert.equal(view.kind, "surface");
	assert.equal(view.chrome, "none");
	assert.equal(view.title, undefined, "the managed overlay request owns the single frame title");

	const order = ["余额", "Token 用量", "中转站分布", "按项目", "活跃度", "模型", "数据状态"];
	let previous = -1;
	for (const label of order) {
		const position = rendered.indexOf(label);
		assert.ok(position > previous, `${label} follows the Web dashboard order`);
		previous = position;
	}

	const tabs = collect(view, (value) => value.kind === "tabs");
	assert.deepEqual(tabs.map((value) => value.id), ["tokenledger.account-tabs", "tokenledger.range-tabs"]);
	assert.equal(tabs[0].activeId, tokenLedgerAccountTabId({ id: "account-0" }));
	assert.equal(tabs[1].activeId, "all");
	assert.deepEqual(tabs[1].items.map((item) => item.label), ["今日 1,000", "本月 20,000", "累计 40,500"]);
	assert.doesNotMatch(rendered, /Tab 切换账户\/区间|PgUp\/PgDn 项目翻页/u, "Blue core owns contextual keyboard hints");
	assert.doesNotMatch(rendered, /tokenledger\.(?:tabs|breakdown|export|rebuild|providers|activity-models)/u);
	assert.doesNotMatch(rendered, /(?:Today|This month|All time|Overview|Breakdown|Export)/u);
	assert.doesNotMatch(rendered, /[○●]/u, "tab state glyphs belong to the Blue renderer");
});

test("project paging keeps the rest of the dashboard stable and shows token, share, and path", () => {
	assert.equal(TOKEN_LEDGER_BLUE_MODEL.pageSize, 8);
	const first = buildTokenLedgerView(state());
	const firstProjects = control(first, "tokenledger.projects");
	assert.equal(firstProjects.items.length, 8);
	assert.match(firstProjects.items[0].detail, /2,025 令牌 · 5\.0% · \/work\/project-0/u);
	assert.match(JSON.stringify(first), /第 1 \/ 3 页 · 共 20 个项目/u);
	assert.deepEqual(control(first, "tokenledger.page.projects").items.map((item) => item.label), ["上一页", "下一页"]);
	for (const item of control(first, "tokenledger.page.projects").items) {
		assert.deepEqual(Object.keys(item).sort(), item.disabled === undefined ? ["id", "label"] : ["disabled", "id", "label"]);
	}

	const second = buildTokenLedgerView(state({ pages: { projects: 1 } }));
	assert.equal(control(second, "tokenledger.projects").items[0].id, "project:0");
	assert.equal(control(second, "tokenledger.projects").items[0].label, "项目 8");
	assert.equal(control(second, "tokenledger.sites").items[0].label, control(first, "tokenledger.sites").items[0].label);
	assert.equal(control(second, "tokenledger.models").items[0].label, control(first, "tokenledger.models").items[0].label);

	const pending = buildTokenLedgerView(state({ pages: { projects: 1 }, pendingPage: { key: "projects", page: 2 } }));
	assert.equal(control(pending, "tokenledger.projects").items[0].label, "项目 8");
	assert.match(JSON.stringify(pending), /正在读取第 3 页，其他数据保持不变/u);
});

test("bounded site, model, and account collections use local pages without adding detail pages", () => {
	const view = buildTokenLedgerView(state({ pages: { sites: 1, models: 2, accounts: 1 } }));
	assert.equal(control(view, "tokenledger.sites").items[0].id, "site:8");
	assert.equal(control(view, "tokenledger.models").items[0].id, "model:16");
	assert.equal(control(view, "tokenledger.account-tabs").items[0].id, tokenLedgerAccountTabId({ id: "account-8" }));
	for (const key of ["sites", "models", "accounts"]) {
		const pager = control(view, `tokenledger.page.${key}`);
		assert.ok(pager);
		assert.equal(pager.items.every((item) => item.shortcut === undefined && item.shortcutFor === undefined && item.focusable === undefined), true);
	}
});

test("account tab identity survives provider-directory reordering", () => {
	const activeId = tokenLedgerAccountTabId({ id: "account-1" });
	const initial = buildTokenLedgerView(state({ selectedAccount: "account-1" }));
	const accounts = usage().accounts;
	const reorderedAccounts = [accounts[2], accounts[1], accounts[0], ...accounts.slice(3)];
	const reordered = buildTokenLedgerView(state({
		selectedAccount: "account-1",
		view: normalizeTokenLedgerView(usage({ accounts: reorderedAccounts }))
	}));
	assert.equal(control(initial, "tokenledger.account-tabs").activeId, activeId);
	assert.equal(control(reordered, "tokenledger.account-tabs").activeId, activeId);
	assert.ok(control(reordered, "tokenledger.account-tabs").items.some((item) => item.id === activeId && item.label === "账户 1"));
});

test("an accepted range view stays internally coherent after a later summary replay", () => {
	const today = buildTokenLedgerView(state({
		range: "today",
		viewRevision: 3,
		snapshot: normalizeTokenLedgerSummary(summary({ revision: 4 })),
		view: normalizeTokenLedgerView(usage({
			totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0, tokens: 0, cacheHitRate: null }
		}))
	}));
	const rendered = JSON.stringify(today);
	assert.match(rendered, /"label":"请求数","value":\[\{"text":"0"\}\]/u);
	assert.match(rendered, /"label":"缓存命中率","value":\[\{"text":"-"\}\]/u);
	assert.doesNotMatch(rendered, /"label":"请求数","value":\[\{"text":"42"\}\]/u);
});

test("balance belongs to the active account tab and model sorting is explicit", () => {
	const balance = normalizeTokenLedgerBalance({ fetched: true, total: 12.5, used: 3, currency: "CNY", scheme: "newapi", windows: [{ kind: "每日", usedPercent: 25 }] });
	const matching = buildTokenLedgerView(state({ selectedAccount: "account-1", balanceAccount: "account-1", balance }));
	assert.equal(control(matching, "tokenledger.account-tabs").activeId, tokenLedgerAccountTabId({ id: "account-1" }));
	assert.match(JSON.stringify(matching), /¥12\.50/u);
	assert.match(JSON.stringify(matching), /账户：账户 1 · 来源：https:\/\/relay-1\.example · 提供方：provider-1/u);
	assert.match(JSON.stringify(matching), /状态：可用 · 可用：¥12\.50 · 已使用：¥3\.00/u);
	assert.equal(collect(matching, (value) => value.kind === "fields" && value.rows?.some((entry) => entry.label === "账户")).length, 0);
	const mismatched = buildTokenLedgerView(state({ selectedAccount: "account-1", balanceAccount: "account-2", balance }));
	assert.doesNotMatch(JSON.stringify(mismatched), /¥12\.50/u);

	const ascending = buildTokenLedgerView(state({ modelSort: "requests", modelSortDirection: "asc" }));
	assert.equal(control(ascending, "tokenledger.models").items[0].label, "model-0");
	assert.match(JSON.stringify(control(ascending, "tokenledger.model-sort-actions")), /请求数 ↑/u);
});

test("activity uses a seven-row Web-style heatmap with bounded responsive weeks", () => {
	assert.equal(TOKEN_LEDGER_BLUE_MODEL.activityDays, 371);
	assert.equal(TOKEN_LEDGER_BLUE_MODEL.activityCellWidth, 2);
	assert.equal(TOKEN_LEDGER_BLUE_MODEL.activityMaxVisibleWeeks, 54);
	const view = buildTokenLedgerView(state());
	const variants = collect(view, (value) => value.kind === "stack"
		&& value.children?.length === 5
		&& value.children.every((child) => child.when !== undefined && child.node?.kind === "stack"))[0];
	assert.ok(variants);
	assert.deepEqual(variants.children.map((child) => child.when), [
		{ maxWidth: 39 },
		{ minWidth: 40, maxWidth: 63 },
		{ minWidth: 64, maxWidth: 87 },
		{ minWidth: 88, maxWidth: 111 },
		{ minWidth: 112 }
	]);
	assert.deepEqual(variants.children.map((child) => child.node.children.length), [7, 7, 7, 7, 7]);
	assert.deepEqual(variants.children.map((child) => child.node.children[0].node.spans.length - 1), [16, 18, 30, 42, 53]);
	for (const variant of variants.children) {
		for (const weekday of variant.node.children) {
			assert.equal(weekday.node.spans.slice(1).every((span) => span.text.length === 2), true);
		}
	}
	assert.match(JSON.stringify(view), /截止 2026-08-30 · Asia\/Shanghai/u);

	const levelAt = activityLevelScale([0, 10, 20, 30, 40, 50, 1_000_000]);
	assert.equal(levelAt(0), 0);
	assert.equal(levelAt(10), 1);
	assert.equal(levelAt(40), 2);
	assert.equal(levelAt(50), 3);
	assert.equal(levelAt(1_000_000), 4);
});

test("fallback and loading states remain usable", () => {
	const absent = buildTokenLedgerView(state({ controllerAvailable: false, snapshot: undefined, view: undefined }));
	assert.match(JSON.stringify(absent), /服务暂不可用/u);
	const loading = buildTokenLedgerView(state({ snapshot: undefined, view: undefined, loading: true }));
	assert.match(JSON.stringify(loading), /取消加载/u);
	auditWire(absent);
	auditWire(loading);

	assert.equal(normalizeTokenLedgerSummary({ revision: 0 }), undefined);
});
