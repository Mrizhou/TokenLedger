/** TokenLedger Blue interaction-model admission and parity tests. */

import assert from "node:assert/strict";
import test from "node:test";

import {
	TOKEN_LEDGER_BLUE_MODEL,
	activityLevelScale,
	buildTokenLedgerView,
	copyPublicJson,
	normalizeTokenLedgerBalance,
	normalizeTokenLedgerConfiguration,
	normalizeTokenLedgerExport,
	normalizeTokenLedgerSummary,
	normalizeTokenLedgerView
} from "../lib/model.js";

function usage(overrides = {}) {
	const many = (count, make) => Array.from({ length: count }, (_, index) => make(index));
	return {
		version: "0.1.0",
		generatedAt: 1_000,
		timeZone: { id: "Asia/Shanghai", offset: "UTC+08:00" },
		range: {},
		totals: {
			inputTokens: 30_000,
			outputTokens: 2_000,
			cacheReadTokens: 8_000,
			cacheWriteTokens: 500,
			reasoningTokens: 1_000,
			requests: 42,
			tokens: 40_500,
			cacheHitRate: 21.1
		},
		windows: {
			today: { tokens: 1_000, requests: 2 },
			month: { tokens: 20_000, requests: 20 },
			all: { tokens: 40_500, requests: 42 }
		},
		days: many(40, (index) => ({ day: `2026-08-${String((index % 28) + 1).padStart(2, "0")}`, tokens: index * 100, requests: index })),
		activity: many(40, (index) => ({ day: `2026-07-${String((index % 28) + 1).padStart(2, "0")}`, tokens: index * 100, requests: index })),
		activityModels: many(40, (index) => ({ day: "2026-07-28", model: `model-${String(index)}`, tokens: 1_000 - index, requests: 1 })),
		models: many(40, (index) => ({ model: `model-${String(index)}`, tokens: 10_000 - index, requests: index, inputTokens: 8_000 - index, outputTokens: 100, cacheReadTokens: 200, cacheHitRate: 10 + index })),
		sites: many(24, (index) => ({ site: index === 0 ? "direct" : `relay-${String(index)}.example`, tokens: 4_000 - index, requests: index })),
		projects: many(28, (index) => ({ project: `/work/project-${String(index)}`, label: `Project ${String(index)}`, path: `/work/project-${String(index)}`, tokens: 3_000 - index, requests: index })),
		providers: many(22, (index) => ({ provider: `provider-${String(index)}`, tokens: 2_000 - index, requests: index })),
		directory: many(24, (index) => ({ id: index === 0 ? "direct" : `relay-${String(index)}.example`, type: index % 2 === 0 ? "newapi" : "sub2api", routes: [`route-${String(index)}`] })),
		accounts: many(20, (index) => ({ id: `account-${String(index)}`, displayName: `Account ${String(index)}`, origin: `https://relay-${String(index)}.example`, provider: `provider-${String(index)}` })),
		diagnostics: { sessions: 8, unattributedRows: 2, lastUpdatedAt: 900 },
		lastSweepAt: 950,
		priced: {
			currency: "CNY",
			totals: { CNY: 1.2345, USD: 0.25 },
			rows: many(40, (index) => ({ model: `model-${String(index)}`, cost: index / 100, currency: "CNY" }))
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
		providers: view.providers,
		directory: view.directory,
		accounts: view.accounts,
		diagnostics: view.diagnostics,
		priced: view.priced,
		freshness: { lastSweepAt: view.lastSweepAt },
		...overrides
	};
}

function state(overrides = {}) {
	return {
		tab: "overview",
		breakdownTab: "sites",
		range: "all",
		modelSort: "tokens",
		pages: {},
		exportFormat: "json",
		exportPage: 0,
		serviceAvailable: true,
		snapshot: normalizeTokenLedgerSummary(summary()),
		view: normalizeTokenLedgerView(usage()),
		loading: false,
		error: "",
		...overrides
	};
}

function auditWire(root) {
	let nodes = 0;
	let textUnits = 0;
	const active = new WeakSet();
	const visit = (value, depth = 0) => {
		if (value === undefined) return;
		if (value === null || typeof value === "boolean" || typeof value === "number") return;
		if (typeof value === "string") {
			textUnits += value.length;
			assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), false);
			return;
		}
		assert.equal(typeof value, "object");
		assert.ok(depth <= 16, `wire depth ${String(depth)}`);
		assert.equal(active.has(value), false, "wire cycle");
		assert.equal(Object.isFrozen(value), true, "wire node must be deeply frozen");
		active.add(value);
		nodes += 1;
		if (Array.isArray(value)) {
			assert.ok(value.length <= 200, `wire collection ${String(value.length)}`);
			for (const item of value) visit(item, depth + 1);
		} else {
			for (const child of Object.values(value)) visit(child, depth + 1);
		}
		active.delete(value);
	};
	visit(root);
	// Responsive heatmap variants retain one bounded span per visible day. This
	// counts every JSON container, while Blue's 256-node admission limit counts
	// UI nodes; keep the stricter all-container budget explicit and bounded.
	assert.ok(nodes <= 3_000, `wire values ${String(nodes)}`);
	assert.ok(textUnits <= 20_000, `wire text ${String(textUnits)}`);
}

function auditPassiveSections(root) {
	const passiveKinds = new Set(["text", "fields", "code", "diff", "sections"]);
	const seen = new WeakSet();
	const visit = (value) => {
		if (value === null || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (!Array.isArray(value) && value.kind === "sections") {
			for (const entry of value.sections ?? []) {
				assert.ok(passiveKinds.has(entry?.body?.kind), `section body must be passive, received ${String(entry?.body?.kind)}`);
			}
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(root);
}

test("normalizers reject proxies and accessors without invoking them", () => {
	let invoked = false;
	const accessor = {};
	Object.defineProperty(accessor, "revision", { get() { invoked = true; throw new Error("must not run"); } });
	assert.equal(normalizeTokenLedgerSummary(accessor), undefined);
	Object.defineProperty(accessor, "content", { get() { invoked = true; throw new Error("must not run"); } });
	assert.equal(normalizeTokenLedgerExport(accessor), undefined);
	assert.equal(invoked, false);

	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	assert.equal(copyPublicJson(revoked.proxy), undefined);
	assert.equal(normalizeTokenLedgerView(revoked.proxy), undefined);
	assert.equal(normalizeTokenLedgerConfiguration(revoked.proxy), undefined);
	assert.equal(normalizeTokenLedgerBalance(revoked.proxy), undefined);
	assert.equal(normalizeTokenLedgerExport(revoked.proxy), undefined);
});

test("public copies are bounded, frozen, and credential filtered", () => {
	const copied = copyPublicJson({
		visible: "yes",
		password: "hidden",
		nested: { authorization: "Bearer hidden", value: "kept" },
		rows: Array.from({ length: 2_200 }, (_, index) => ({ index, value: "x".repeat(10) }))
	});
	assert.ok(copied);
	assert.equal(copied.truncated, true);
	assert.equal(Object.isFrozen(copied.value), true);
	const serialized = JSON.stringify(copied.value);
	assert.equal(serialized.includes("hidden"), false);
	assert.equal(copied.value.rows.length, 2_048);
});

test("public copies inspect wide objects incrementally and omit unsafe keys", () => {
	const wide = {};
	const paddedCredentialKey = `${".".repeat(100_000)}accessToken`;
	wide[paddedCredentialKey] = "padded-secret";
	wide.visible = "yes";
	Object.defineProperties(wide, {
		__proto__: { value: { polluted: true }, enumerable: true },
		constructor: { value: "unsafe", enumerable: true },
		prototype: { value: "unsafe", enumerable: true }
	});
	for (let index = 0; index < 50_000; index += 1) wide[`field-${String(index)}`] = index;
	const originalBulkRead = Object.getOwnPropertyDescriptors;
	Object.getOwnPropertyDescriptors = () => {
		throw new Error("copyPublicJson must not materialize every descriptor");
	};
	let copied;
	try {
		copied = copyPublicJson(wide);
	} finally {
		Object.getOwnPropertyDescriptors = originalBulkRead;
	}

	assert.ok(copied);
	assert.equal(copied.truncated, true);
	assert.equal(copied.value.visible, "yes");
	assert.equal(Object.hasOwn(copied.value, paddedCredentialKey), false);
	assert.equal(JSON.stringify(copied.value).includes("padded-secret"), false);
	assert.equal(Object.hasOwn(copied.value, "__proto__"), false);
	assert.equal(Object.hasOwn(copied.value, "constructor"), false);
	assert.equal(Object.hasOwn(copied.value, "prototype"), false);
	assert.ok(Object.keys(copied.value).length <= 128);
});

test("every complete dashboard tab stays within Blue wire admission budgets", () => {
	for (const tab of TOKEN_LEDGER_BLUE_MODEL.tabs.map((item) => item.id)) {
		if (tab !== "breakdown") {
			const view = buildTokenLedgerView(state({ tab }));
			auditWire(view);
			auditPassiveSections(view);
		}
	}
	for (const breakdownTab of TOKEN_LEDGER_BLUE_MODEL.breakdownTabs.map((item) => item.id)) {
		const view = buildTokenLedgerView(state({ tab: "breakdown", breakdownTab }));
		auditWire(view);
		auditPassiveSections(view);
	}
	auditWire(buildTokenLedgerView(state({ serviceAvailable: false, snapshot: undefined, view: undefined })));
});

test("forms and loading controls expose Chinese labels while keeping stable event ids", () => {
	const models = JSON.stringify(buildTokenLedgerView(state({ tab: "breakdown", breakdownTab: "models" })));
	assert.match(models, /"submitActionId":"应用排序"/u);
	assert.doesNotMatch(models, /"submitActionId":"tokenledger\.model-sort"/u);

	const exportNode = JSON.stringify(buildTokenLedgerView(state({ tab: "export" })));
	assert.match(exportNode, /"submitActionId":"生成导出内容"/u);

	const loading = buildTokenLedgerView(state({ snapshot: undefined, view: undefined, loading: true }));
	const loadingText = JSON.stringify(loading);
	assert.match(loadingText, /"id":"tokenledger.cancel","label":"取消加载"/u);
	assert.doesNotMatch(loadingText, /"cancelActionId"/u);
	assert.equal(loading.chrome, "overlay");
});

test("breakdowns paginate rather than silently slicing service rows", () => {
	const first = buildTokenLedgerView(state({ tab: "breakdown", breakdownTab: "models" }));
	const firstText = JSON.stringify(first);
	assert.match(firstText, /第 1 \/ 3 页/);
	assert.match(firstText, /共 40 个模型/);
	assert.match(firstText, /tokenledger\.page\.models\.next/);
	assert.match(firstText, /"shortcut":"pagedown","shortcutFor":"tokenledger\.models","focusable":false/u);

	const last = buildTokenLedgerView(state({ tab: "breakdown", breakdownTab: "models", pages: { models: 2 } }));
	const lastText = JSON.stringify(last);
	assert.match(lastText, /第 3 \/ 3 页/);
	assert.match(lastText, /model-39/);

	const activity = buildTokenLedgerView(state({
		tab: "breakdown",
		breakdownTab: "activity",
		selectedDay: "2026-07-28",
		pages: { "activity-models": 2 }
	}));
	const activityText = JSON.stringify(activity);
	assert.match(activityText, /第 3 \/ 3 页/);
	assert.match(activityText, /model-39/);
});

test("account details paginate every bounded service row", () => {
	const windows = Array.from({ length: 33 }, (_, index) => ({ kind: `window-${String(index)}`, usedPercent: index, resetsAt: index + 1 }));
	const accountView = buildTokenLedgerView(state({
		tab: "accounts",
		balance: normalizeTokenLedgerBalance({ fetched: true, total: 12.5, currency: "CNY", windows }),
		pages: { "quota-windows": 2 }
	}));
	const accountText = JSON.stringify(accountView);
	assert.match(accountText, /第 3 \/ 3 页/);
	assert.match(accountText, /window-32/);
	assert.match(accountText, /tokenledger\.page\.quota-windows\.prev/);
	assert.match(accountText, /"shortcut":"pageup","shortcutFor":"tokenledger\.quota-windows","focusable":false/u);
});

test("site, model, project, provider, activity, account, and balance details are represented", () => {
	const cases = [
		state({ tab: "breakdown", breakdownTab: "sites", siteDetail: "relay-1.example" }),
		state({ tab: "breakdown", breakdownTab: "models", selectedModel: "model-1" }),
		state({ tab: "breakdown", breakdownTab: "projects", selectedProject: "Project 1" }),
		state({ tab: "breakdown", breakdownTab: "providers", selectedProvider: "provider-1" }),
		state({ tab: "breakdown", breakdownTab: "activity", selectedDay: "2026-07-28" }),
		state({ tab: "accounts", selectedAccount: "account-1", balance: normalizeTokenLedgerBalance({ fetched: true, total: 12.5, used: 3, currency: "CNY", scheme: "newapi", windows: [{ kind: "daily", usedPercent: 25 }] }) })
	];
	const serialized = cases.map((value) => JSON.stringify(buildTokenLedgerView(value))).join("\n");
	for (const expected of ["已选站点", "已选模型", "已选项目", "已选提供方", "已选日期", "刷新余额"]) {
		assert.ok(serialized.includes(expected), expected);
	}
});

test("every main page keeps the Chinese keyboard guide and exposes no settings tab", () => {
	assert.deepEqual(TOKEN_LEDGER_BLUE_MODEL.tabs.map((item) => item.id), ["overview", "breakdown", "accounts", "export"]);
	for (const tab of TOKEN_LEDGER_BLUE_MODEL.tabs) {
		const rendered = JSON.stringify(buildTokenLedgerView(state({ tab: tab.id })));
		assert.match(rendered, /Tab\/Shift\+Tab 切换标签层级/);
		assert.match(rendered, /←\/→ 直接切换本层标签页/);
		assert.match(rendered, /↓ 进入内容/);
		assert.match(rendered, /↑\/↓ 浏览内容/);
		assert.match(rendered, /Enter\/Space 选择内容项/);
		assert.match(rendered, /PgUp\/PgDn 翻页/);
		assert.doesNotMatch(rendered, /tokenledger\.(?:settings|relays|wallets|relay-form|wallet-form)/);
	}
});

test("overview migrates the WebUI daily activity heatmap with the same quantile levels", () => {
	assert.equal(TOKEN_LEDGER_BLUE_MODEL.activityDays, 371);
	assert.equal(TOKEN_LEDGER_BLUE_MODEL.activityCellWidth, 3);
	assert.equal(TOKEN_LEDGER_BLUE_MODEL.narrowActivityWeeks, undefined);
	const view = buildTokenLedgerView(state());
	const rendered = JSON.stringify(view);
	assert.match(rendered, /按日活动热力图/u);
	assert.match(rendered, /完整 371 天见“明细 → 活动”/u);
	assert.doesNotMatch(rendered, /按日活动热力图 · 续|最近 \d+ 周/u);
	for (const glyph of ["░░", "▒▒", "▓▓", "██"]) assert.match(rendered, new RegExp(glyph, "u"));
	assert.doesNotMatch(rendered, /[□▫▪▣■]/u);
	const activityVariants = (root) => {
		let result;
		const collect = (value) => {
			if (value === null || typeof value !== "object") return;
			if (value.kind === "stack" && value.children?.length === 32
				&& value.children.every((child) => child.when !== undefined && child.node?.kind === "rich-text")) {
				assert.equal(result, undefined, "one responsive heatmap stack");
				result = value;
			}
			for (const child of Object.values(value)) collect(child);
		};
		collect(root);
		assert.ok(result, "responsive heatmap variants");
		return result.children;
	};
	const variants = activityVariants(view);
	assert.equal(variants.length, 32);
	for (const [index, variant] of variants.entries()) {
		const visibleDays = index + 1;
		const minWidth = visibleDays * TOKEN_LEDGER_BLUE_MODEL.activityCellWidth + 4;
		assert.deepEqual(variant.when, visibleDays === 1
			? { maxWidth: minWidth + TOKEN_LEDGER_BLUE_MODEL.activityCellWidth - 1 }
			: visibleDays === variants.length
				? { minWidth }
				: { minWidth, maxWidth: minWidth + TOKEN_LEDGER_BLUE_MODEL.activityCellWidth - 1 });
		const dataRow = variant.node;
		assert.equal(dataRow.spans.length, visibleDays);
		assert.equal(dataRow.spans.map((span) => span.text).join("").length, visibleDays * TOKEN_LEDGER_BLUE_MODEL.activityCellWidth);
		for (const span of dataRow.spans) {
			assert.match(span.text, /^(?:░░|▒▒|▓▓|██) $/u);
			assert.ok(span.tone === "muted" || span.tone === "success");
			assert.notEqual(span.tone, "accent");
		}
	}

	const recentView = normalizeTokenLedgerView(usage({
		generatedAt: Date.UTC(2026, 7, 30, 12),
		activity: [
			{ day: "2026-08-29", tokens: 1, requests: 1 },
			{ day: "2026-08-30", tokens: 2, requests: 1 }
		]
	}));
	const recentVariants = activityVariants(buildTokenLedgerView(state({ view: recentView, viewRevision: 3 })));
	assert.match(JSON.stringify(buildTokenLedgerView(state({ view: recentView, viewRevision: 3 }))), /截止 2026-08-30/u);
	assert.deepEqual(recentVariants[0].node.spans, [{ text: "██ ", tone: "success" }]);
	assert.deepEqual(recentVariants[1].node.spans, [
		{ text: "░░ ", tone: "success" },
		{ text: "██ ", tone: "success" }
	]);
	assert.deepEqual(recentVariants[2].node.spans, [
		{ text: "░░ ", tone: "muted" },
		{ text: "░░ ", tone: "success" },
		{ text: "██ ", tone: "success" }
	]);

	const steady = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
	const withSpike = activityLevelScale([...steady, 1_000_000]);
	assert.equal(withSpike(0), 0);
	assert.equal(withSpike(10), 1);
	assert.equal(withSpike(60), 1);
	assert.equal(withSpike(70), 2);
	assert.equal(withSpike(90), 3);
	assert.equal(withSpike(1_000_000), 4);
	const single = activityLevelScale([0, 5]);
	assert.equal(single(0), 0);
	assert.equal(single(5), 4);

	const idleView = normalizeTokenLedgerView(usage({
		generatedAt: Date.UTC(2026, 7, 30, 12),
		activity: []
	}));
	const idleSpans = activityVariants(buildTokenLedgerView(state({ view: idleView, viewRevision: 3 })))
		.flatMap((variant) => variant.node.spans);
	assert.equal(idleSpans.length, 32 * 33 / 2);
	assert.equal(idleSpans.every((span) => span.text === "░░ " && span.tone === "muted"), true);
	assert.deepEqual([20, 40, 80, 100].map((width) => variants.find((variant) => {
		const minimum = variant.when.minWidth ?? 1;
		const maximum = variant.when.maxWidth ?? Number.POSITIVE_INFINITY;
		return width >= minimum && width <= maximum;
	})?.node.spans.length), [5, 12, 25, 32]);
});

test("main and breakdown navigation leave canonical markers to the Blue renderer", () => {
	for (const tab of TOKEN_LEDGER_BLUE_MODEL.tabs) {
		const rendered = JSON.stringify(buildTokenLedgerView(state({ tab: tab.id })));
		assert.match(rendered, new RegExp(`TokenLedger · ${tab.label}`));
		assert.match(rendered, new RegExp(`当前页：${tab.label}`));
		assert.match(rendered, new RegExp(`"activeId":"${tab.id}"`));
		assert.match(rendered, new RegExp(`"id":"${tab.id}","label":"${tab.label}"`));
		assert.doesNotMatch(rendered, /(?:●|○) (?:总览|明细|账户|导出)/u);
	}
	for (const tab of TOKEN_LEDGER_BLUE_MODEL.breakdownTabs) {
		const rendered = JSON.stringify(buildTokenLedgerView(state({ tab: "breakdown", breakdownTab: tab.id })));
		assert.match(rendered, new RegExp(`当前明细：${tab.label}`));
		assert.match(rendered, new RegExp(`"activeId":"${tab.id}"`));
		assert.match(rendered, new RegExp(`"id":"${tab.id}","label":"${tab.label}"`));
		assert.doesNotMatch(rendered, /(?:●|○) (?:站点|模型|项目|提供方|活动)/u);
	}
});

test("exports retain complete bounded content through explicit pages", () => {
	const content = Array.from({ length: 20_000 }, (_, index) => String(index % 10)).join("");
	const result = normalizeTokenLedgerExport({ format: "json", content, fileName: "tokenledger.json", mimeType: "application/json", token: "hidden" });
	assert.ok(result);
	assert.equal(result.content.length, 20_000);
	for (let page = 0; page < 4; page += 1) {
		const view = buildTokenLedgerView(state({ tab: "export", exportResult: result, exportPage: page }));
		auditWire(view);
		assert.match(JSON.stringify(view), new RegExp(`\\"预览页\\",\\"value\\":\\[\\{\\"text\\":\\"${String(page + 1)} / 4`));
	}
});

test("invalid summaries and oversized exports fail closed", () => {
	assert.equal(normalizeTokenLedgerSummary({ revision: 0 }), undefined);
	assert.deepEqual(normalizeTokenLedgerSummary({ revision: 1 }), normalizeTokenLedgerSummary({ revision: 1 }));
	assert.equal(normalizeTokenLedgerExport({ content: "x".repeat(1_048_577) }), undefined);
	assert.equal(normalizeTokenLedgerExport({ content: "ok", apiKey: "hidden" }).apiKey, undefined);
});
