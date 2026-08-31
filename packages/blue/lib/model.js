/**
 * Renderer-neutral TokenLedger interaction model and Blue wire-node builders.
 *
 * This module accepts only bounded public service values and emits plain Blue
 * UI data. It has no Cordis, Harness, terminal, DOM, React, ANSI, or width
 * dependency. Mutable selection and request ownership stay in `index.js`.
 *
 * @module @dsh-blue/tokenledger/model
 */

import { isProxy } from "node:util/types";

const PRIVATE_KEYS = new Set([
	"accesstoken",
	"apikey",
	"authorization",
	"body",
	"cookie",
	"credential",
	"credentialreference",
	"credentials",
	"headers",
	"password",
	"secret",
	"token",
	"userauth"
]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PAGE_SIZE = 8;
const EXPORT_PAGE_CHARS = 6_000;
const MAX_COPY_DEPTH = 10;
const MAX_COPY_NODES = 8_000;
const MAX_COPY_CHARS = 600_000;
const MAX_ARRAY_LENGTH = 2_048;
const MAX_OBJECT_KEYS = 128;
const MAX_OBJECT_KEY_LENGTH = 64;
const LABEL_LIMIT = 240;
const DETAIL_LIMIT = 600;
const ACTIVITY_DAYS = 371;
const ACTIVITY_CELL_WIDTH = 2;
const ACTIVITY_MAX_VISIBLE_WEEKS = 54;
const DAY_MS = 86_400_000;
const RANGE_ITEMS = [
	{ id: "today", label: "今日" },
	{ id: "month", label: "本月" },
	{ id: "all", label: "累计" }
];
const MODEL_SORTS = [
	{ id: "tokens", label: "令牌总数" },
	{ id: "requests", label: "请求数" },
	{ id: "inputTokens", label: "输入" },
	{ id: "cacheReadTokens", label: "缓存读取" },
	{ id: "outputTokens", label: "输出" },
	{ id: "cost", label: "预估费用" }
];
const ACTIVITY_LEVELS = [
	{ glyph: "·", tone: "muted" },
	{ glyph: "░", tone: "success" },
	{ glyph: "▒", tone: "success" },
	{ glyph: "▓", tone: "success" },
	{ glyph: "█", tone: "success" }
];

function deepFreeze(value, seen = new WeakSet()) {
	if (value === null || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	return Object.freeze(value);
}

function normalizedKey(key) {
	return key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

function dataProperty(value, key) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Copy untrusted service data without invoking accessors or proxy traps.
 *
 * @param {unknown} input public service value.
 * @returns {{ value: unknown, truncated: boolean } | undefined} safe copy.
 */
export function copyPublicJson(input) {
	const budget = { nodes: MAX_COPY_NODES, chars: MAX_COPY_CHARS, truncated: false };
	const active = new WeakSet();
	const copy = (value, depth) => {
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") return Number.isFinite(value) ? value : 0;
		if (typeof value === "string") {
			const remaining = Math.max(0, budget.chars);
			const result = value.slice(0, Math.min(4_096, remaining));
			budget.chars -= result.length;
			if (result.length !== value.length) budget.truncated = true;
			return result;
		}
		if (typeof value !== "object" || depth > MAX_COPY_DEPTH || budget.nodes <= 0) {
			budget.truncated = true;
			return null;
		}
		try {
			if (isProxy(value) || active.has(value)) {
				budget.truncated = true;
				return null;
			}
			budget.nodes -= 1;
			active.add(value);
			if (Array.isArray(value)) {
				const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
				const length = lengthDescriptor !== undefined && "value" in lengthDescriptor && Number.isSafeInteger(lengthDescriptor.value)
					? Math.min(lengthDescriptor.value, MAX_ARRAY_LENGTH)
					: 0;
				if (lengthDescriptor?.value > length) budget.truncated = true;
				const result = [];
				for (let index = 0; index < length; index += 1) {
					const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
					if (descriptor === undefined || !("value" in descriptor)) {
						budget.truncated = true;
						continue;
					}
					result.push(copy(descriptor.value, depth + 1));
				}
				active.delete(value);
				return result;
			}
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== null && prototype !== Object.prototype) {
				active.delete(value);
				budget.truncated = true;
				return null;
			}
			const result = Object.create(null);
			let inspected = 0;
			for (const key in value) {
				if (!Object.hasOwn(value, key)) continue;
				if (inspected >= MAX_OBJECT_KEYS) {
					budget.truncated = true;
					break;
				}
				inspected += 1;
				if (key.length > MAX_OBJECT_KEY_LENGTH) {
					budget.truncated = true;
					continue;
				}
				if (UNSAFE_OBJECT_KEYS.has(key) || PRIVATE_KEYS.has(normalizedKey(key))) continue;
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
					budget.truncated = true;
					continue;
				}
				if (descriptor.value !== undefined) result[key] = copy(descriptor.value, depth + 1);
			}
			active.delete(value);
			return result;
		} catch {
			budget.truncated = true;
			return null;
		}
	};
	const value = copy(input, 0);
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return { value: deepFreeze(value), truncated: budget.truncated };
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : Object.freeze({});
}

function array(value) {
	return Array.isArray(value) ? value : Object.freeze([]);
}

function text(value, limit = LABEL_LIMIT) {
	return typeof value === "string" ? value.replaceAll(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, limit) : "";
}

/** Stable bounded wire id for an account across provider-directory reordering. */
export function tokenLedgerAccountTabId(input) {
	const value = record(input);
	const identity = text(value.id || value.origin, 512);
	if (identity === "") return undefined;
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < identity.length; index += 1) {
		hash ^= BigInt(identity.charCodeAt(index));
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return `account:${hash.toString(36).padStart(13, "0")}`;
}

function number(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integer(value, fallback = 0) {
	return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function freezeNode(value) {
	return deepFreeze(value);
}

/** Normalize one summary replay while retaining explicit truncation evidence. */
export function normalizeTokenLedgerSummary(input) {
	const copied = copyPublicJson(input);
	if (copied === undefined) return undefined;
	const value = record(copied.value);
	const revision = integer(value.revision);
	if (revision < 1) return undefined;
	return deepFreeze({ ...value, revision, boundaryTruncated: copied.truncated || value.boundaryTruncated === true || value.reduced === true });
}

/** Normalize one full range/site view from the public service. */
export function normalizeTokenLedgerView(input) {
	const copied = copyPublicJson(input);
	if (copied === undefined) return undefined;
	const value = record(copied.value);
	return deepFreeze({ ...value, boundaryTruncated: copied.truncated || value.boundaryTruncated === true || value.reduced === true });
}

/** Normalize the public sanitized configuration view. */
export function normalizeTokenLedgerConfiguration(input) {
	const copied = copyPublicJson(input);
	if (copied === undefined) return undefined;
	const value = record(copied.value);
	return deepFreeze({ ...value, boundaryTruncated: copied.truncated || value.boundaryTruncated === true });
}

/** Normalize a balance action result without accepting credentials. */
export function normalizeTokenLedgerBalance(input) {
	const copied = copyPublicJson(input);
	if (copied === undefined) return undefined;
	const value = record(copied.value);
	return deepFreeze({ ...value, boundaryTruncated: copied.truncated || value.boundaryTruncated === true });
}

/** Normalize one export result while keeping its complete bounded content. */
export function normalizeTokenLedgerExport(input) {
	if (input === null || typeof input !== "object" || isProxy(input)) return undefined;
	try {
		const value = (key) => dataProperty(input, key);
		const content = value("content");
		if (typeof content !== "string" || content.length > 1_048_576) return undefined;
		return deepFreeze({
			format: value("format") === "csv" ? "csv" : "json",
			content,
			fileName: text(value("fileName"), 256),
			mimeType: text(value("mimeType"), 128)
		});
	} catch {
		return undefined;
	}
}

function fmt(value) {
	const numeric = optionalNumber(value);
	return numeric === undefined ? "-" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(numeric);
}

function money(value, currency) {
	const numeric = optionalNumber(value);
	if (numeric === undefined) return "-";
	const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${text(currency, 12)} `;
	return `${symbol}${numeric.toFixed(Math.abs(numeric) < 1 ? 4 : 2)}`.trim();
}

function percentage(value) {
	const numeric = optionalNumber(value);
	return numeric === undefined ? "-" : `${numeric.toFixed(1)}%`;
}

function row(label, value, tone) {
	return { label: text(label, 80), value: [{ text: text(String(value), DETAIL_LIMIT), ...(tone === undefined ? {} : { tone }) }] };
}

function fields(rows) {
	return { kind: "fields", rows };
}

function message(content, tone) {
	return { kind: "text", content: text(content, 2_000), ...(tone === undefined ? {} : { tone }) };
}

function actionBar(id, items) {
	return { kind: "actions", id, items };
}

function tabs(id, activeId, items) {
	return { kind: "tabs", id, activeId, items };
}

function column(children, gap = 1) {
	return { kind: "stack", direction: "column", gap, children: children.filter(Boolean).map((node) => ({ node })) };
}

function section(title, body, collapsed = false) {
	return { title, body, ...(collapsed ? { collapsed: true } : {}) };
}

function sections(value) {
	return { kind: "sections", sections: value };
}

function cancelableLoader(messageText) {
	return column([
		{ kind: "loader", message: messageText, variant: "braille" },
		actionBar("tokenledger.loading.actions", [
			{ id: "tokenledger.cancel", label: "取消加载" }
		])
	]);
}

/** Match the WebUI activity strip's quantile-based zero-to-four intensity. */
export function activityLevelScale(values) {
	const active = values.filter((value) => value > 0).sort((left, right) => left - right);
	if (active.length === 0) return () => 0;
	const distinct = [...new Set(active)];
	if (distinct.length < 4) {
		const ranks = new Map(distinct.map((value, index) => [value, distinct.length === 1 ? 4 : 1 + Math.round((index * 3) / (distinct.length - 1))]));
		return (value) => value > 0 ? ranks.get(value) ?? 4 : 0;
	}
	const quantile = (ratio) => {
		const position = (active.length - 1) * ratio;
		const base = Math.floor(position);
		const remainder = position - base;
		const left = active[base];
		const right = active[Math.min(active.length - 1, base + 1)];
		return left + (right - left) * remainder;
	};
	const median = quantile(0.5);
	const upper = quantile(0.75);
	const peak = quantile(0.9);
	return (value) => {
		if (!(value > 0)) return 0;
		if (value <= median) return 1;
		if (value <= upper) return 2;
		if (value <= peak) return 3;
		return 4;
	};
}

function calendarDay(timestamp, timeZone) {
	if (!Number.isFinite(timestamp)) return undefined;
	const value = new Date(timestamp);
	if (!Number.isFinite(value.getTime())) return undefined;
	const id = text(record(timeZone).id, 120);
	if (id !== "") {
		try {
			const parts = new Intl.DateTimeFormat("en", { timeZone: id, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
			const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
			const result = `${values.year}-${values.month}-${values.day}`;
			if (dayTime(result) !== undefined) return result;
		} catch {}
	}
	const offset = /^UTC([+-])(\d{2}):(\d{2})$/u.exec(text(record(timeZone).offset, 16));
	if (offset !== null) {
		const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === "+" ? 1 : -1);
		return calendarDayUtc(timestamp + minutes * 60_000);
	}
	return calendarDayUtc(timestamp);
}

function dayTime(day) {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return undefined;
	const [year, month, date] = day.split("-").map(Number);
	const value = Date.UTC(year, month - 1, date);
	return calendarDayUtc(value) === day ? value : undefined;
}

function calendarDayUtc(timestamp) {
	const value = new Date(timestamp);
	return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function activityCells(source) {
	const rows = array(source.activity).map((value) => record(value));
	const totals = new Map(rows.map((value) => [text(value.day, 10), Math.max(0, number(value.tokens))]));
	const lastRecorded = [...totals.keys()].filter((day) => dayTime(day) !== undefined).sort().at(-1);
	const generatedDay = calendarDay(optionalNumber(source.generatedAt ?? source.capturedAt), source.timeZone);
	const endDay = [generatedDay, lastRecorded].filter(Boolean).sort().at(-1);
	const end = endDay === undefined ? undefined : dayTime(endDay);
	if (end === undefined) return undefined;
	const values = [];
	for (let offset = ACTIVITY_DAYS - 1; offset >= 0; offset -= 1) {
		const day = calendarDayUtc(end - offset * DAY_MS);
		values.push({ day, tokens: totals.get(day) ?? 0 });
	}
	return values;
}

function activityWeeks(cells) {
	const first = dayTime(cells[0]?.day);
	if (first === undefined) return [];
	const firstWeekday = (new Date(first).getUTCDay() + 6) % 7;
	const padded = [...Array.from({ length: firstWeekday }, () => undefined), ...cells];
	while (padded.length % 7 !== 0) padded.push(undefined);
	return Array.from({ length: padded.length / 7 }, (_, index) => padded.slice(index * 7, index * 7 + 7));
}

function activityGrid(weeks, visibleWeeks, levelAt) {
	const visible = weeks.slice(-visibleWeeks);
	const labels = ["一", "二", "三", "四", "五", "六", "日"];
	return {
		kind: "stack",
		direction: "column",
		gap: 0,
		children: labels.map((label, weekday) => ({
			node: {
				kind: "rich-text",
				spans: [
					{ text: `${label} `, tone: "muted" },
					...visible.map((week) => {
						const cell = week[weekday];
						const level = ACTIVITY_LEVELS[cell === undefined ? 0 : levelAt(cell.tokens)];
						return { text: level.glyph.repeat(ACTIVITY_CELL_WIDTH), tone: level.tone };
					})
				]
			}
		}))
	};
}

function recentActivity(source) {
	const rows = array(source.activity).map((value) => record(value)).filter((value) => dayTime(text(value.day)) !== undefined);
	const latest = rows.toSorted((left, right) => text(left.day).localeCompare(text(right.day))).at(-1);
	if (latest === undefined) return message("暂无活动记录。", "muted");
	const models = array(source.activityModels)
		.map((value) => record(value))
		.filter((value) => text(value.day) === text(latest.day))
		.toSorted((left, right) => number(right.tokens) - number(left.tokens))
		.slice(0, 3)
		.map((value) => `${text(value.model) || "未知模型"} ${fmt(value.tokens)}`);
	return message([
		`最近活动：${text(latest.day)} · ${fmt(latest.tokens)} 令牌 · ${fmt(latest.requests)} 次请求`,
		...(models.length === 0 ? [] : [models.join(" · ")])
	].join("\n"), "muted");
}

function activityHeatmap(source) {
	const cells = activityCells(source);
	if (cells === undefined) return column([
		{ kind: "divider", label: "活跃度" },
		message("暂无可绘制的活动日期。", "muted")
	], 0);
	const weeks = activityWeeks(cells);
	const zone = text(record(source.timeZone).id || record(source.timeZone).offset, 120) || "宿主时区";
	const levelAt = activityLevelScale(cells.map((cell) => cell.tokens));
	const variants = [
		{ weeks: Math.min(16, weeks.length), when: { maxWidth: 39 } },
		{ weeks: Math.min(18, weeks.length), when: { minWidth: 40, maxWidth: 63 } },
		{ weeks: Math.min(30, weeks.length), when: { minWidth: 64, maxWidth: 87 } },
		{ weeks: Math.min(42, weeks.length), when: { minWidth: 88, maxWidth: 111 } },
		{ weeks: Math.min(ACTIVITY_MAX_VISIBLE_WEEKS, weeks.length), when: { minWidth: 112 } }
	].map((variant) => ({ node: activityGrid(weeks, variant.weeks, levelAt), when: variant.when }));
	return column([
		{ kind: "divider", label: "活跃度" },
		message(`截止 ${cells.at(-1).day} · ${zone}`, "muted"),
		{ kind: "stack", direction: "column", gap: 0, children: variants },
		{
			kind: "rich-text",
			spans: [
				{ text: "少 ", tone: "muted" },
				...ACTIVITY_LEVELS.map((level) => ({ text: `${level.glyph.repeat(ACTIVITY_CELL_WIDTH)} `, tone: level.tone })),
				{ text: "多", tone: "muted" }
			]
		},
		recentActivity(source)
	], 0);
}

function pricedRows(priced) {
	const totals = record(record(priced).totals);
	return Object.entries(totals).slice(0, 12).map(([currency, value]) => row(`预估费用 ${text(currency, 12)}`, money(value, currency)));
}

function pagination(key, state, total) {
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const current = Math.min(integer(record(state.pages)[key]), pages - 1);
	const shortcutFor = key === "projects" ? "*" : key === "accounts" ? "tokenledger.account-tabs" : `tokenledger.${key}`;
	return {
		page: current,
		pages,
		start: current * PAGE_SIZE,
		end: Math.min(total, (current + 1) * PAGE_SIZE),
		node: actionBar(`tokenledger.page.${key}`, [
			{ id: `tokenledger.page.${key}.prev`, label: "PgUp 上一页", shortcut: "pageup", shortcutFor, focusable: false, disabled: current === 0 },
			{ id: `tokenledger.page.${key}.next`, label: "PgDn 下一页", shortcut: "pagedown", shortcutFor, focusable: false, disabled: current + 1 >= pages }
		])
	};
}

function collectionWindow(key, state, source, localValues, options = {}) {
	const collection = options.collection ?? key;
	const bound = record(record(source.collectionBounds)[collection]);
	const cached = record(record(state.collectionPages)[key]);
	const cacheMatches = integer(cached.page, -1) === integer(record(state.pages)[key])
		&& Array.isArray(cached.items)
		&& (options.day === undefined || cached.day === options.day);
	const total = Math.max(
		localValues.length,
		cacheMatches ? integer(cached.sourceCount) : 0,
		options.filtered === true ? 0 : integer(bound.sourceCount)
	);
	const page = pagination(key, state, total);
	return {
		page,
		total,
		values: cacheMatches ? array(cached.items) : localValues.slice(page.start, page.end),
		cached: cacheMatches
	};
}

function listNode(id, rows, selectedId, emptyTitle) {
	return {
		kind: "list",
		id,
		mode: "single",
		selectedIds: selectedId === undefined ? [] : [selectedId],
		items: rows,
		empty: { kind: "empty", title: emptyTitle }
	};
}

function boundaryNotice(source) {
	if (source?.boundaryTruncated !== true) return undefined;
	const labels = {
		days: "所选范围的日期",
		activity: "活动日期",
		models: "模型",
		sites: "站点",
		projects: "项目",
		accounts: "账户",
		pricedRows: "计价记录"
	};
	const omitted = Object.entries(record(source.collectionBounds))
		.map(([key, value]) => [key, labels[key], integer(record(value).omittedCount)])
		.filter(([, label, count]) => label !== undefined && count > 0)
		.map(([, label, count]) => `${label}：初始边界外还有 ${String(count)} 条`);
	const nested = array(source.boundaryOmissions).reduce((sum, value) => sum + integer(record(value).omittedCount), 0);
	const details = [
		...omitted,
		...(nested > 0 ? [`嵌套数据因边界省略 ${String(nested)} 条`] : [])
	];
	return message(details.length === 0
		? "公开服务返回了精简后的边界视图。"
		: `边界详情 · ${details.join(" · ")}`, "warning");
}

function collectionNotice(source, collection, label) {
	const omittedCount = integer(record(record(source.collectionBounds)[collection]).omittedCount);
	return omittedCount > 0
		? message(`${label}：初始边界外还有 ${String(omittedCount)} 条，可用“下一页”继续读取。`, "warning")
		: undefined;
}

function selectedTotals(state) {
	if (state.view !== undefined) return record(state.view.totals);
	return record(record(state.snapshot?.totals).selected);
}

function usageDashboard(state, source) {
	const totals = selectedTotals(state);
	const windows = state.view === undefined ? record(state.snapshot?.totals) : record(state.view.windows);
	const windowItems = RANGE_ITEMS.map((item) => {
		const total = record(windows[item.id]);
		return {
			id: item.id,
			label: `${item.label} ${fmt(total.tokens)}`
		};
	});
	return column([
		{ kind: "divider", label: "Token 用量" },
		tabs("tokenledger.range-tabs", RANGE_ITEMS.some((item) => item.id === state.range) ? state.range : "all", windowItems),
		fields([
			row("请求数", fmt(totals.requests)),
			row("缓存命中率", percentage(totals.cacheHitRate)),
			...pricedRows(source.priced)
		])
	]);
}

function siteDistribution(values, total, width) {
	const tones = ["accent", "muted", "warning", "success"];
	let remaining = width;
	return {
		kind: "rich-text",
		spans: values.map((value, index) => {
			const share = total > 0 ? number(record(value).tokens) / total : 0;
			const size = index + 1 === values.length ? remaining : Math.min(remaining, Math.max(1, Math.round(share * width)));
			remaining -= size;
			return { text: "█".repeat(Math.max(0, size)), tone: tones[index % tones.length] };
		}).filter((value) => value.text !== "")
	};
}

function siteDashboard(state, source) {
	const localValues = array(source.sites);
	const window = collectionWindow("sites", state, source, localValues);
	const { page } = window;
	const total = number(record(source.totals).tokens) || localValues.reduce((sum, value) => sum + number(record(value).tokens), 0);
	const rows = window.values.map((value, offset) => {
		const item = record(value);
		const site = text(item.site) || "未知站点";
		const share = total > 0 ? (number(item.tokens) / total) * 100 : 0;
		return {
			id: `site:${String(page.start + offset)}`,
			label: site === "direct" ? "直连 / 官方" : site === "unrouted" ? "未知路由" : site,
			detail: `${fmt(item.tokens)} 令牌 · ${fmt(item.requests)} 次请求 · ${share.toFixed(1)}%`
		};
	});
	const selectedIndex = window.values.findIndex((value) => text(record(value).site) === state.site);
	return column([
		{ kind: "divider", label: "中转站分布" },
		{
			kind: "stack",
			direction: "column",
			gap: 0,
			children: [
				{ node: siteDistribution(localValues, total, 12), when: { maxWidth: 39 } },
				{ node: siteDistribution(localValues, total, 32), when: { minWidth: 40 } }
			]
		},
		collectionNotice(source, "sites", "站点"),
		listNode("tokenledger.sites", rows, selectedIndex >= 0 ? `site:${String(page.start + selectedIndex)}` : undefined, "此范围内没有站点"),
		page.pages > 1 ? message(`第 ${String(page.page + 1)} / ${String(page.pages)} 页 · 共 ${String(window.total)} 个站点`, "muted") : undefined,
		page.pages > 1 ? page.node : undefined
	]);
}

function modelCost(source, model) {
	const direct = optionalNumber(record(model.pricing).cost);
	if (direct !== undefined) return direct;
	const priced = array(record(source.priced).rows).find((value) => text(record(value).model) === text(model.model));
	return priced === undefined ? undefined : optionalNumber(record(priced).cost);
}

function modelDashboard(state, source) {
	const values = array(source.models).map((value) => record(value));
	const sortKey = MODEL_SORTS.some((item) => item.id === state.modelSort) ? state.modelSort : "tokens";
	const direction = state.modelSortDirection === "asc" ? 1 : -1;
	const sorted = values.map((value) => ({ value, cost: modelCost(source, value) })).sort((left, right) => {
		const leftValue = sortKey === "cost" ? left.cost ?? -1 : number(left.value[sortKey]);
		const rightValue = sortKey === "cost" ? right.cost ?? -1 : number(right.value[sortKey]);
		return direction * (leftValue - rightValue) || text(left.value.model).localeCompare(text(right.value.model));
	});
	const window = collectionWindow("models", state, source, sorted.map((entry) => entry.value));
	const { page } = window;
	const pageEntries = window.values.map((value) => ({ value: record(value), cost: modelCost(source, record(value)) }));
	const rows = pageEntries.map((entry, offset) => ({
		id: `model:${String(page.start + offset)}`,
		label: text(entry.value.model) || "未知模型",
		detail: `${fmt(entry.value.requests)} 次请求 · 总量 ${fmt(entry.value.tokens)} · 输入 ${fmt(entry.value.inputTokens)} · 缓存 ${fmt(entry.value.cacheReadTokens)} · 输出 ${fmt(entry.value.outputTokens)}`,
		...(entry.cost === undefined ? {} : { badge: money(entry.cost, record(entry.value.pricing).currency || record(source.priced).currency) })
	}));
	return column([
		{ kind: "divider", label: "模型" },
		actionBar("tokenledger.model-sort-actions", MODEL_SORTS.map((item) => ({
			id: `tokenledger.model-sort.${item.id}`,
			label: `${item.label}${sortKey === item.id ? state.modelSortDirection === "asc" ? " ↑" : " ↓" : ""}`,
			...(sortKey === item.id ? { intent: "primary" } : {})
		}))),
		collectionNotice(source, "models", "模型"),
		collectionNotice(source, "pricedRows", "计价记录"),
		listNode("tokenledger.models", rows, undefined, "此范围内没有模型"),
		page.pages > 1 ? message(`第 ${String(page.page + 1)} / ${String(page.pages)} 页 · 共 ${String(window.total)} 个模型`, "muted") : undefined,
		page.pages > 1 ? page.node : undefined
	]);
}

function projectDashboard(state, source) {
	const values = array(source.projects).map((value) => record(value));
	const sorted = values.toSorted((left, right) => number(right.tokens) - number(left.tokens));
	const window = collectionWindow("projects", state, source, sorted);
	const { page } = window;
	const total = number(record(source.totals).tokens) || sorted.reduce((sum, value) => sum + number(value.tokens), 0);
	const rows = window.values.map((value, offset) => ({
		id: `project:${String(offset)}`,
		label: value.unattributed === true || text(value.project) === "" ? "未记录目录" : text(value.label || value.project) || "未知项目",
		detail: `${fmt(value.tokens)} 令牌 · ${total > 0 ? ((number(value.tokens) / total) * 100).toFixed(1) : "0.0"}%${text(value.project) === "" ? "" : ` · ${text(value.project, 320)}`}`
	}));
	const pending = record(state.pendingPage);
	return column([
		{ kind: "divider", label: "按项目" },
		collectionNotice(source, "projects", "项目"),
		pending.key === "projects" ? message(`正在读取第 ${String(integer(pending.page) + 1)} 页，其他数据保持不变。`, "muted") : undefined,
		listNode("tokenledger.projects", rows, undefined, "此范围内没有项目"),
		page.pages > 1 ? message(`第 ${String(page.page + 1)} / ${String(page.pages)} 页 · 共 ${String(window.total)} 个项目`, "muted") : undefined,
		page.pages > 1 ? page.node : undefined
	]);
}

function accountLabel(value) {
	return text(value.displayName || value.name || value.id || value.origin) || "未知账户";
}

function accountDashboard(state, source) {
	const values = array(source.accounts).map((value) => record(value));
	const window = collectionWindow("accounts", state, source, values);
	const { page } = window;
	const items = window.values.map((value, offset) => ({
		id: tokenLedgerAccountTabId(value) ?? `account:${String(page.start + offset)}`,
		label: accountLabel(value)
	}));
	const selectedOffset = window.values.findIndex((value) => text(record(value).id || record(value).origin) === state.selectedAccount);
	const selected = record(selectedOffset >= 0 ? window.values[selectedOffset] : window.values[0]);
	const selectedId = text(selected.id || selected.origin) || undefined;
	const activeTabId = tokenLedgerAccountTabId(selected) ?? items[0]?.id;
	const balance = selectedId !== undefined && state.balanceAccount === selectedId ? state.balance : undefined;
	const windows = array(record(balance).windows);
	const status = balance === undefined
		? state.busyAction === "balance.refresh" ? "读取中" : "-"
		: balance.fetched === false ? "读取失败" : balance.isAvailable === false ? "不可用" : "可用";
	const available = balance === undefined ? "-" : balance.total === undefined ? fmt(record(balance.quota).available) : money(balance.total, balance.currency);
	const used = balance?.used === undefined ? "-" : money(balance.used, balance.currency);
	const granted = balance?.granted === undefined ? "-" : money(balance.granted, balance.currency);
	return column([
		{ kind: "divider", label: "余额" },
		collectionNotice(source, "accounts", "账户"),
		items.length === 0
			? message("没有发现可查询余额的账户。", "muted")
			: tabs("tokenledger.account-tabs", activeTabId, items),
		page.pages > 1 ? message(`第 ${String(page.page + 1)} / ${String(page.pages)} 页 · 共 ${String(window.total)} 个账户`, "muted") : undefined,
		page.pages > 1 ? page.node : undefined,
		...(items.length === 0 ? [] : [
			message(`账户：${accountLabel(selected)} · 来源：${text(selected.origin, DETAIL_LIMIT) || "-"} · 提供方：${text(selected.provider || selected.type) || "-"}`),
			message(`状态：${status} · 可用：${available} · 已使用：${used} · 总额度：${granted} · 套餐：${text(balance?.plan) || "-"} · 数据源：${text(balance?.scheme) || "-"}`)
		]),
		balance?.boundaryTruncated === true ? boundaryNotice(balance) : undefined,
		windows.length === 0 ? undefined : sections([
			section("额度周期", fields(windows.map((value) => {
				const window = record(value);
				return row(text(window.kind) || "额度周期", `已使用 ${percentage(window.usedPercent)} · 重置时间 ${text(window.resetsAt) || "-"}`);
			})))
		]),
		state.busyAction === "balance.refresh" ? message("正在刷新账户余额，当前数据保持不变。", "muted") : undefined
	], 0);
}

/** Build the complete TokenLedger Blue dashboard for the current frontend tree. */
export function buildTokenLedgerView(stateInput) {
	const state = stateInput ?? {};
	const source = state.view ?? state.snapshot ?? {};
	let body;
	if (state.serviceAvailable !== true) {
		body = { kind: "empty", title: "TokenLedger 服务暂不可用", description: "Blue 正在等待 tokenLedgerV1；用量采集和原有 Web 界面不受影响。" };
	} else body = column([
		boundaryNotice(source),
		accountDashboard(state, source),
		usageDashboard(state, source),
		siteDashboard(state, source),
		projectDashboard(state, source),
		activityHeatmap(source),
		modelDashboard(state, source),
		sections([
			section("数据状态", fields([
				row("最近扫描", fmt(source.lastSweepAt ?? record(state.snapshot?.freshness).lastSweepAt)),
				row("最近活动", fmt(record(source.diagnostics).lastUsageAt)),
				row("未归属记录", fmt(record(source.diagnostics).unattributedRows))
			]))
		]),
		actionBar("tokenledger.dashboard-actions", [
			{ id: "tokenledger.refresh", label: "刷新", intent: "primary", busy: state.busyAction === "usage.refresh" || state.busyAction === "balance.refresh" }
		])
	]);
	const content = column([
		state.error ? message(state.error, "danger") : undefined,
		state.loading === true && state.view === undefined ? cancelableLoader("正在加载 TokenLedger") : undefined,
		body
	]);
	return freezeNode({
		kind: "surface",
		title: "TokenLedger 用量账本",
		subtitle: state.site === undefined ? "全部中转站" : `只看：${text(state.site)}`,
		badges: [
			{ text: state.range === "today" ? "今日" : state.range === "month" ? "本月" : "累计", tone: "accent" },
			...(state.busyAction === undefined ? [] : [{ text: "处理中", tone: "warning" }])
		],
		chrome: "overlay",
		padding: 1,
		child: { kind: "scroll", child: content, follow: "none", scrollbar: true },
		footer: message("Tab 切换账户/区间 · ←/→ 切换当前标签 · ↓ 进入内容 · PgUp/PgDn 项目翻页 · Esc 关闭", "muted")
	});
}

/** Public constants used by the adapter and independent fixtures. */
export const TOKEN_LEDGER_BLUE_MODEL = Object.freeze({
	pageSize: PAGE_SIZE,
	exportPageChars: EXPORT_PAGE_CHARS,
	activityDays: ACTIVITY_DAYS,
	activityCellWidth: ACTIVITY_CELL_WIDTH,
	activityMaxVisibleWeeks: ACTIVITY_MAX_VISIBLE_WEEKS,
	ranges: deepFreeze(RANGE_ITEMS),
	modelSorts: deepFreeze(MODEL_SORTS)
});
