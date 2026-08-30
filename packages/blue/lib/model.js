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
const PAGE_SIZE = 16;
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
const ACTIVITY_CELL_WIDTH = 3;
const ACTIVITY_MAX_VISIBLE_DAYS = 32;
const ACTIVITY_SURFACE_COLUMNS = 4;
const DAY_MS = 86_400_000;
const TABS = [
	{ id: "overview", label: "总览" },
	{ id: "breakdown", label: "明细" },
	{ id: "accounts", label: "账户" },
	{ id: "export", label: "导出" }
];
const BREAKDOWN_TABS = [
	{ id: "sites", label: "站点" },
	{ id: "models", label: "模型" },
	{ id: "projects", label: "项目" },
	{ id: "providers", label: "提供方" },
	{ id: "activity", label: "活动" }
];
const RANGE_ITEMS = [
	{ id: "today", label: "今天" },
	{ id: "month", label: "本月" },
	{ id: "all", label: "全部时间" }
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
	{ glyph: "░", tone: "muted" },
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

function column(children, gap = 1) {
	return { kind: "stack", direction: "column", gap, children: children.filter(Boolean).map((node) => ({ node })) };
}

function section(title, body, collapsed = false) {
	return { title, body, ...(collapsed ? { collapsed: true } : {}) };
}

function sections(value) {
	return { kind: "sections", sections: value };
}

function navigationLabel(items, activeId, fallback) {
	return items.find((item) => item.id === activeId)?.label ?? fallback;
}

function cancelableLoader(messageText) {
	return column([
		{ kind: "loader", message: messageText, variant: "braille" },
		actionBar("tokenledger.loading.actions", [
			{ id: "tokenledger.cancel", label: "取消加载" }
		])
	]);
}

function totalsRows(value) {
	const totals = record(value);
	return [
		row("令牌总数", fmt(totals.tokens)),
		row("请求数", fmt(totals.requests)),
		row("输入", fmt(totals.inputTokens)),
		row("缓存读取", fmt(totals.cacheReadTokens)),
		row("缓存写入", fmt(totals.cacheWriteTokens)),
		row("输出", fmt(totals.outputTokens)),
		row("推理", fmt(totals.reasoningTokens)),
		row("缓存命中率", percentage(totals.cacheHitRate))
	];
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

function activityStrip(cells, visibleDays, levelAt) {
	const visible = cells.slice(-visibleDays);
	return {
		kind: "rich-text",
		spans: visible.map((cell) => {
			const level = ACTIVITY_LEVELS[levelAt(cell.tokens)];
			return { text: `${level.glyph}${level.glyph} `, tone: level.tone };
		})
	};
}

function activityHeatmap(source) {
	const cells = activityCells(source);
	if (cells === undefined) return column([
		{ kind: "divider", label: "按日活动热力图" },
		message("暂无可绘制的活动日期。", "muted")
	], 0);
	const zone = text(record(source.timeZone).id || record(source.timeZone).offset, 120) || "宿主时区";
	const levelAt = activityLevelScale(cells.map((cell) => cell.tokens));
	const variants = Array.from({ length: ACTIVITY_MAX_VISIBLE_DAYS }, (_, index) => {
		const visibleDays = index + 1;
		const minWidth = visibleDays * ACTIVITY_CELL_WIDTH + ACTIVITY_SURFACE_COLUMNS;
		return {
			node: activityStrip(cells, visibleDays, levelAt),
			when: {
				...(visibleDays === 1 ? {} : { minWidth }),
				...(visibleDays === ACTIVITY_MAX_VISIBLE_DAYS ? {} : { maxWidth: minWidth + ACTIVITY_CELL_WIDTH - 1 })
			}
		};
	});
	return column([
		{ kind: "divider", label: "按日活动热力图" },
		message(`截止 ${cells.at(-1).day} · ${zone} · 按宽度显示最近日期 · 完整 371 天见“明细 → 活动”`, "muted"),
		{ kind: "stack", direction: "column", gap: 0, children: variants },
		{
			kind: "rich-text",
			spans: [
				{ text: "少 ", tone: "muted" },
				...ACTIVITY_LEVELS.map((level) => ({ text: `${level.glyph}${level.glyph} `, tone: level.tone })),
				{ text: "多", tone: "muted" }
			]
		}
	], 0);
}

function pricedRows(priced) {
	const totals = record(record(priced).totals);
	return Object.entries(totals).slice(0, 12).map(([currency, value]) => row(`预估费用 ${text(currency, 12)}`, money(value, currency)));
}

function pagination(key, state, total) {
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const current = Math.min(integer(record(state.pages)[key]), pages - 1);
	return {
		page: current,
		pages,
		start: current * PAGE_SIZE,
		end: Math.min(total, (current + 1) * PAGE_SIZE),
		node: actionBar(`tokenledger.page.${key}`, [
			{ id: `tokenledger.page.${key}.prev`, label: "PgUp 上一页", shortcut: "pageup", shortcutFor: `tokenledger.${key}`, focusable: false, disabled: current === 0 },
			{ id: `tokenledger.page.${key}.next`, label: "PgDn 下一页", shortcut: "pagedown", shortcutFor: `tokenledger.${key}`, focusable: false, disabled: current + 1 >= pages }
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
		activityModels: "活动模型记录",
		models: "模型",
		sites: "站点",
		projects: "项目",
		providers: "提供方",
		directory: "目录项",
		accounts: "账户",
		pricedRows: "计价记录"
	};
	const omitted = Object.entries(record(source.collectionBounds))
		.map(([key, value]) => [key, integer(record(value).omittedCount)])
		.filter(([, count]) => count > 0)
		.map(([key, count]) => `${labels[key] ?? key}：初始边界外还有 ${String(count)} 条`);
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
	if (state.view !== undefined && integer(state.viewRevision) >= integer(state.snapshot?.revision)) return record(state.view.totals);
	return record(record(state.snapshot?.totals).selected);
}

function overview(state) {
	const source = state.view ?? state.snapshot ?? {};
	const totals = selectedTotals(state);
	const windows = state.view === undefined ? record(state.snapshot?.totals) : record(state.view.windows);
	const windowItems = RANGE_ITEMS.map((item) => {
		const total = record(windows[item.id]);
		return {
			id: `range:${item.id}`,
			label: item.label,
			detail: `${fmt(total.tokens)} 令牌 · ${fmt(total.requests)} 次请求`,
			...(state.range === item.id ? { badge: "当前" } : {})
		};
	});
	const diagnostics = record(source.diagnostics);
	const timeZone = record(source.timeZone);
	const freshness = state.view === undefined ? record(state.snapshot?.freshness) : source;
	return column([
		boundaryNotice(source),
		sections([
			section("当前用量", fields([...totalsRows(totals), ...pricedRows(source.priced)]))
		]),
		activityHeatmap(source),
		{ kind: "divider", label: "统计范围" },
		listNode("tokenledger.range-list", windowItems, `range:${state.range}`, "没有可用的统计范围"),
		sections([
			section("数据状态", fields([
				row("站点筛选", state.site === undefined ? "全部站点" : state.site),
				row("生成时间", fmt(source.generatedAt ?? state.snapshot?.capturedAt)),
				row("最近扫描", fmt(freshness.lastSweepAt)),
				row("宿主时区", text(timeZone.id || timeZone.offset || "未知", 120)),
				row("已索引会话", fmt(diagnostics.sessions)),
				row("未归属记录", fmt(diagnostics.unattributedRows)),
				row("当前会话", state.sessionId === undefined ? "未授权读取" : state.sessionId)
			]))
		]),
		actionBar("tokenledger.overview.actions", [
			{ id: "tokenledger.refresh", label: "刷新用量", intent: "primary", busy: state.busyAction === "usage.refresh" },
			{ id: "tokenledger.clear-site", label: "全部站点", disabled: state.site === undefined },
			{ id: "tokenledger.rebuild", label: "重建索引", intent: "danger", confirm: "要从持久化会话日志重新构建 TokenLedger 索引吗？", busy: state.busyAction === "index.rebuild" }
		])
	]);
}

function siteRows(state, source) {
	const localValues = array(source.sites);
	const window = collectionWindow("sites", state, source, localValues);
	const { page } = window;
	const total = number(record(source.totals).tokens) || localValues.reduce((sum, value) => sum + number(record(value).tokens), 0);
	const directoryValues = [...array(source.directory), ...array(record(record(state.collectionPages).directory).items)];
	const directory = new Map(directoryValues.map((value) => [text(record(value).id), record(value)]));
	const rows = window.values.map((value, offset) => {
		const item = record(value);
		const site = text(item.site) || "未知站点";
		const directoryEntry = directory.get(site);
		const share = total > 0 ? (number(item.tokens) / total) * 100 : 0;
		return {
			id: `site:${String(page.start + offset)}`,
			label: site === "direct" ? "直连 / 官方" : site === "unrouted" ? "未知路由" : site,
			detail: `${fmt(item.tokens)} 令牌 · ${fmt(item.requests)} 次请求 · ${share.toFixed(1)}%`,
			...(text(directoryEntry?.type) || site === "direct" ? { badge: text(directoryEntry?.type) || "直连" } : {})
		};
	});
	const selectedOffset = window.values.findIndex((value) => text(record(value).site) === state.siteDetail);
	const selectedLocal = localValues.find((value) => text(record(value).site) === state.siteDetail);
	const selected = selectedOffset >= 0 ? record(window.values[selectedOffset]) : selectedLocal === undefined ? undefined : record(selectedLocal);
	const selectedIndex = selectedOffset >= 0 ? page.start + selectedOffset : localValues.indexOf(selectedLocal);
	const directoryEntry = selected === undefined ? undefined : directory.get(text(selected.site));
	return column([
		collectionNotice(source, "sites", "站点"),
		collectionNotice(source, "directory", "中转站目录"),
		listNode("tokenledger.sites", rows, selectedIndex >= page.start && selectedIndex < page.end ? `site:${String(selectedIndex)}` : undefined, "此范围内没有站点"),
		message(`第 ${String(page.page + 1)} / ${String(page.pages)} 页 · 共 ${String(window.total)} 个站点`, "muted"),
		page.node,
		selected === undefined ? undefined : sections([
			section("已选站点", fields([
				row("站点", text(selected.site)),
				...totalsRows(selected),
				row("软件", text(directoryEntry?.type) || "未知"),
				row("路由", array(directoryEntry?.routes).map((value) => text(value)).filter(Boolean).join(", ") || "-")
			]))
		]),
		actionBar("tokenledger.site.actions", [
			{ id: "tokenledger.filter-selected-site", label: "仅查看所选站点", disabled: selected === undefined || text(selected.site) === state.site },
			{ id: "tokenledger.clear-site", label: "清除筛选", disabled: state.site === undefined }
		])
	]);
}

function modelCost(source, model) {
	const direct = optionalNumber(record(model.pricing).cost);
	if (direct !== undefined) return direct;
	const priced = array(record(source.priced).rows).find((value) => text(record(value).model) === text(model.model));
	return priced === undefined ? undefined : optionalNumber(record(priced).cost);
}

function modelRows(state, source) {
	const values = array(source.models).map((value) => record(value));
	const sortKey = MODEL_SORTS.some((item) => item.id === state.modelSort) ? state.modelSort : "tokens";
	const sorted = values.map((value) => ({ value, cost: modelCost(source, value) })).sort((left, right) => {
		const leftValue = sortKey === "cost" ? left.cost ?? -1 : number(left.value[sortKey]);
		const rightValue = sortKey === "cost" ? right.cost ?? -1 : number(right.value[sortKey]);
		return rightValue - leftValue || text(left.value.model).localeCompare(text(right.value.model));
	});
	const window = collectionWindow("models", state, source, sorted.map((entry) => entry.value));
	const { page } = window;
	const pageEntries = window.values.map((value) => ({ value: record(value), cost: modelCost(source, record(value)) }));
	const rows = pageEntries.map((entry, offset) => ({
		id: `model:${String(page.start + offset)}`,
		label: text(entry.value.model) || "未知模型",
		detail: `${fmt(entry.value.tokens)} 令牌 · ${fmt(entry.value.requests)} 次请求 · 缓存命中 ${percentage(entry.value.cacheHitRate)}`,
		...(entry.cost === undefined ? {} : { badge: money(entry.cost, record(entry.value.pricing).currency || record(source.priced).currency) })
	}));
	const selectedOffset = pageEntries.findIndex((entry) => text(entry.value.model) === state.selectedModel);
	const selectedLocal = sorted.find((entry) => text(entry.value.model) === state.selectedModel);
	const selected = selectedOffset >= 0 ? pageEntries[selectedOffset] : selectedLocal;
	const selectedIndex = selectedOffset >= 0 ? page.start + selectedOffset : sorted.indexOf(selectedLocal);
	return column([
		{
			kind: "form",
			id: "tokenledger.model-sort-form",
			fields: [{ kind: "select", id: "sort", label: "模型排序", value: sortKey, options: MODEL_SORTS }],
			submitActionId: "应用排序"
		},
		collectionNotice(source, "models", "模型"),
		collectionNotice(source, "pricedRows", "计价记录"),
		listNode("tokenledger.models", rows, selectedIndex >= page.start && selectedIndex < page.end ? `model:${String(selectedIndex)}` : undefined, "此范围内没有模型"),
		message(`第 ${String(page.page + 1)} / ${String(page.pages)} 页 · 共 ${String(window.total)} 个模型`, "muted"),
		page.node,
		selected === undefined ? undefined : sections([
			section("已选模型", fields([
				row("模型", text(selected.value.model)),
				...totalsRows(selected.value),
				row("预估费用", selected.cost === undefined ? "-" : money(selected.cost, record(source.priced).currency))
			]))
		])
	]);
}

function genericBreakdownRows(state, source, key, identity, labelOf, detailOf, title) {
	const values = array(source[key]).map((value) => record(value));
	const sorted = values.toSorted((left, right) => number(right.tokens) - number(left.tokens));
	const window = collectionWindow(key, state, source, sorted);
	const { page } = window;
	const rows = window.values.map((value, offset) => ({
		id: `${key}:${String(page.start + offset)}`,
		label: text(labelOf(value)) || `未知${title}`,
		detail: text(detailOf(value), DETAIL_LIMIT)
	}));
	const selectedValue = state[identity];
	const selectedOffset = window.values.findIndex((value) => text(labelOf(record(value))) === selectedValue);
	const selectedLocal = sorted.find((value) => text(labelOf(value)) === selectedValue);
	const selected = selectedOffset >= 0 ? record(window.values[selectedOffset]) : selectedLocal;
	const selectedIndex = selectedOffset >= 0 ? page.start + selectedOffset : sorted.indexOf(selectedLocal);
	return column([
		collectionNotice(source, key, title),
		listNode(`tokenledger.${key}`, rows, selectedIndex >= page.start && selectedIndex < page.end ? `${key}:${String(selectedIndex)}` : undefined, `此范围内没有${title}`),
		message(`第 ${String(page.page + 1)} / ${String(page.pages)} 页 · 共 ${String(window.total)} 个${title}`, "muted"),
		page.node,
		selected === undefined ? undefined : sections([
			section(`已选${title}`, fields([
				row("名称", text(labelOf(selected))),
				...totalsRows(selected),
				...(text(selected.path) === "" ? [] : [row("路径", text(selected.path, DETAIL_LIMIT))])
			]))
		])
	]);
}

function activityRows(state, source) {
	const values = array(source.activity).map((value) => record(value)).toReversed();
	const window = collectionWindow("activity", state, source, values);
	const { page } = window;
	const rows = window.values.map((value, offset) => ({
		id: `activity:${String(page.start + offset)}`,
		label: text(value.day) || "未知日期",
		detail: `${fmt(value.tokens)} 令牌 · ${fmt(value.requests)} 次请求`
	}));
	const selectedOffset = window.values.findIndex((value) => text(record(value).day) === state.selectedDay);
	const selectedLocal = values.find((value) => text(value.day) === state.selectedDay);
	const selected = selectedOffset >= 0 ? record(window.values[selectedOffset]) : selectedLocal;
	const selectedIndex = selectedOffset >= 0 ? page.start + selectedOffset : values.indexOf(selectedLocal);
	const localModels = selected === undefined ? [] : array(source.activityModels)
		.map((value) => record(value))
		.filter((value) => text(value.day) === text(selected.day))
		.toSorted((left, right) => number(right.tokens) - number(left.tokens));
	const modelWindow = collectionWindow("activity-models", state, source, localModels, {
		collection: "activityModels",
		day: text(selected?.day),
		filtered: true
	});
	const modelPage = modelWindow.page;
	return column([
		collectionNotice(source, "activity", "活动日期"),
		listNode("tokenledger.activity", rows, selectedIndex >= page.start && selectedIndex < page.end ? `activity:${String(selectedIndex)}` : undefined, "固定历史窗口内没有活动"),
		message(`第 ${String(page.page + 1)} / ${String(page.pages)} 页 · 共 ${String(window.total)} 天`, "muted"),
		page.node,
		selected === undefined ? undefined : sections([
			section("已选日期", fields([row("日期", text(selected.day)), ...totalsRows(selected)]))
		]),
		selected === undefined ? undefined : { kind: "divider", label: "当日模型" },
		selected === undefined ? undefined : collectionNotice(source, "activityModels", "活动模型记录"),
		selected === undefined ? undefined : listNode("tokenledger.activity-models", modelWindow.values.map((value, offset) => ({
				id: `activity-model:${String(modelPage.start + offset)}`,
				label: text(value.model) || "未知模型",
				detail: `${fmt(value.tokens)} 令牌 · ${fmt(value.requests)} 次请求`
			})), undefined, "当日没有模型明细"),
		selected === undefined ? undefined : message(`第 ${String(modelPage.page + 1)} / ${String(modelPage.pages)} 页 · 共 ${String(modelWindow.total)} 个模型`, "muted"),
		selected === undefined ? undefined : modelPage.node
	]);
}

function breakdown(state) {
	const source = state.view ?? {};
	let body;
	if (state.breakdownTab === "models") body = modelRows(state, source);
	else if (state.breakdownTab === "projects") {
		body = genericBreakdownRows(state, source, "projects", "selectedProject", (value) => value.unattributed === true ? "未归属" : value.label || value.project, (value) => `${fmt(value.tokens)} 令牌 · ${text(value.path, 320)}`, "项目");
	} else if (state.breakdownTab === "providers") {
		body = genericBreakdownRows(state, source, "providers", "selectedProvider", (value) => value.provider, (value) => `${fmt(value.tokens)} 令牌 · ${fmt(value.requests)} 次请求`, "提供方");
	} else if (state.breakdownTab === "activity") body = activityRows(state, source);
	else body = siteRows(state, source);
	return column([
		boundaryNotice(source),
		{ kind: "tabs", id: "tokenledger.breakdown.tabs", activeId: state.breakdownTab, items: BREAKDOWN_TABS },
		{ kind: "divider", label: `当前明细：${navigationLabel(BREAKDOWN_TABS, state.breakdownTab, "站点")}` },
		body
	]);
}

function accountLabel(value) {
	return text(value.displayName || value.name || value.id || value.origin) || "未知账户";
}

function accounts(state) {
	const source = state.view ?? state.snapshot ?? {};
	const values = array(source.accounts).map((value) => record(value));
	const window = collectionWindow("accounts", state, source, values);
	const { page } = window;
	const rows = window.values.map((value, offset) => ({
		id: `account:${String(page.start + offset)}`,
		label: accountLabel(value),
		detail: [text(value.origin, 320), text(value.provider, 80), text(value.type, 80)].filter(Boolean).join(" · "),
		...(value.userToken === true || value.hasToken === true ? { badge: "个人钱包" } : {})
	}));
	const selectedOffset = window.values.findIndex((value) => text(record(value).id || record(value).origin) === state.selectedAccount);
	const selectedLocal = values.find((value) => text(value.id || value.origin) === state.selectedAccount);
	const selected = selectedOffset >= 0 ? record(window.values[selectedOffset]) : selectedLocal ?? record(window.values[0]);
	const resolvedIndex = selectedOffset >= 0 ? page.start + selectedOffset : selectedLocal === undefined ? page.start : values.indexOf(selectedLocal);
	const balance = state.balance;
	const windows = array(record(balance).windows);
	const quotaPage = pagination("quota-windows", state, windows.length);
	return column([
		boundaryNotice(source),
		collectionNotice(source, "accounts", "账户"),
		listNode("tokenledger.accounts", rows, resolvedIndex >= page.start && resolvedIndex < page.end ? `account:${String(resolvedIndex)}` : undefined, "没有发现可查询余额的账户"),
		message(`第 ${String(page.page + 1)} / ${String(page.pages)} 页 · 共 ${String(window.total)} 个账户`, "muted"),
		page.node,
		selected === undefined ? undefined : sections([
			section("已选账户", fields([
				row("账户", accountLabel(selected)),
				row("ID", text(selected.id) || "-"),
				row("来源地址", text(selected.origin, DETAIL_LIMIT) || "-"),
				row("提供方", text(selected.provider || selected.type) || "-")
			])),
			...(balance === undefined ? [] : [section("余额", fields([
				row("状态", balance.fetched === false ? "读取失败" : balance.isAvailable === false ? "不可用" : "可用"),
				row("可用额度", balance.total === undefined ? fmt(record(balance.quota).available) : money(balance.total, balance.currency)),
				row("已使用", balance.used === undefined ? "-" : money(balance.used, balance.currency)),
				row("总额度", balance.granted === undefined ? "-" : money(balance.granted, balance.currency)),
				row("套餐", text(balance.plan) || "-"),
				row("数据源", text(balance.scheme) || "-")
			]))])
		]),
		balance?.boundaryTruncated === true ? boundaryNotice(balance) : undefined,
		balance === undefined ? undefined : { kind: "divider", label: "额度周期" },
		balance === undefined ? undefined : listNode("tokenledger.quota-windows", windows.slice(quotaPage.start, quotaPage.end).map((value, offset) => {
			const window = record(value);
			return { id: `quota:${String(quotaPage.start + offset)}`, label: text(window.kind) || "额度周期", detail: `已使用 ${percentage(window.usedPercent)} · 重置时间 ${fmt(window.resetsAt)}` };
		}), undefined, "没有额度周期数据"),
		balance === undefined ? undefined : message(`第 ${String(quotaPage.page + 1)} / ${String(quotaPage.pages)} 页 · 共 ${String(windows.length)} 个周期`, "muted"),
		balance === undefined ? undefined : quotaPage.node,
		actionBar("tokenledger.account.actions", [
			{ id: "tokenledger.balance.refresh", label: "刷新余额", intent: "primary", disabled: selected === undefined, busy: state.busyAction === "balance.refresh" }
		])
	]);
}

function exportView(state) {
	const result = state.exportResult;
	const content = result?.content ?? "";
	const pages = Math.max(1, Math.ceil(content.length / EXPORT_PAGE_CHARS));
	const page = Math.min(integer(state.exportPage), pages - 1);
	const snippet = content.slice(page * EXPORT_PAGE_CHARS, (page + 1) * EXPORT_PAGE_CHARS);
	return column([
		{
			kind: "form",
			id: "tokenledger.export-form",
			fields: [{
				kind: "select",
				id: "format",
				label: "格式",
				value: state.exportFormat === "csv" ? "csv" : "json",
				options: [{ id: "json", label: "JSON" }, { id: "csv", label: "CSV" }]
			}],
			submitActionId: "生成导出内容"
		},
		result === undefined ? { kind: "empty", title: "尚未生成导出文件", description: "通过 TokenLedger 公开服务生成有界导出内容。" } : sections([
			section("导出信息", fields([
				row("文件名", result.fileName || `tokenledger.${result.format}`),
				row("MIME 类型", result.mimeType || "-"),
				row("字符数", fmt(content.length)),
				row("预览页", `${String(page + 1)} / ${String(pages)}`)
			])),
			section("完整分页内容", { kind: "code", code: snippet, language: result.format })
		]),
		actionBar("tokenledger.export.actions", [
			{ id: "tokenledger.export.prev", label: "PgUp 上一页", shortcut: "pageup", shortcutFor: "tokenledger.export-form", focusable: false, disabled: result === undefined || page === 0 },
			{ id: "tokenledger.export.next", label: "PgDn 下一页", shortcut: "pagedown", shortcutFor: "tokenledger.export-form", focusable: false, disabled: result === undefined || page + 1 >= pages },
			{ id: "tokenledger.export.clear", label: "清除", disabled: result === undefined }
		])
	]);
}

/** Build the complete TokenLedger Blue dashboard for the current frontend tree. */
export function buildTokenLedgerView(stateInput) {
	const state = stateInput ?? {};
	const activeTab = TABS.some((item) => item.id === state.tab) ? state.tab : "overview";
	const pageLabel = navigationLabel(TABS, activeTab, "总览");
	let body;
	if (state.serviceAvailable !== true) {
		body = { kind: "empty", title: "TokenLedger 服务暂不可用", description: "Blue 正在等待 tokenLedgerV1；用量采集和原有 Web 界面不受影响。" };
	} else if (state.tab === "breakdown") body = breakdown(state);
	else if (state.tab === "accounts") body = accounts(state);
	else if (state.tab === "export") body = exportView(state);
	else body = overview(state);
	const content = column([
		{ kind: "tabs", id: "tokenledger.tabs", activeId: activeTab, items: TABS },
		{ kind: "divider", label: `当前页：${pageLabel}` },
		message("操作：Tab/Shift+Tab 切换标签层级 · ←/→ 直接切换本层标签页 · ↓ 进入内容 · ↑/↓ 浏览内容 · Enter/Space 选择内容项 · PgUp/PgDn 翻页", "muted"),
		state.error ? message(state.error, "danger") : undefined,
		state.loading === true && state.view === undefined ? cancelableLoader("正在加载 TokenLedger") : undefined,
		body
	]);
	return freezeNode({
		kind: "surface",
		title: `TokenLedger · ${pageLabel}`,
		subtitle: state.site === undefined ? "全部中转站" : `已筛选：${text(state.site)}`,
		badges: [
			{ text: state.range === "today" ? "今天" : state.range === "month" ? "本月" : "全部时间", tone: "accent" },
			...(state.busyAction === undefined ? [] : [{ text: "处理中", tone: "warning" }])
		],
		chrome: "overlay",
		padding: 1,
		child: { kind: "scroll", child: content, follow: "none", scrollbar: true }
	});
}

/** Public constants used by the adapter and independent fixtures. */
export const TOKEN_LEDGER_BLUE_MODEL = Object.freeze({
	pageSize: PAGE_SIZE,
	exportPageChars: EXPORT_PAGE_CHARS,
	activityDays: ACTIVITY_DAYS,
	activityCellWidth: ACTIVITY_CELL_WIDTH,
	tabs: deepFreeze(TABS),
	breakdownTabs: deepFreeze(BREAKDOWN_TABS),
	ranges: deepFreeze(RANGE_ITEMS),
	modelSorts: deepFreeze(MODEL_SORTS)
});
