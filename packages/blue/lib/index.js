/**
 * Blue frontend entry for TokenLedger.
 *
 * The companion owns only frontend-tree selection, managed-surface
 * registrations, subscriptions, and request controllers. Accounting truth,
 * exports, balance reads, and every settings write remain behind the public
 * renderer-neutral `tokenLedgerV1` service. The existing Web client remains
 * the named fallback.
 *
 * @module @dsh-blue/tokenledger
 */

import { readFileSync } from "node:fs";
import {
	TOKEN_LEDGER_BLUE_MODEL,
	buildTokenLedgerView,
	copyPublicJson,
	normalizeTokenLedgerBalance,
	normalizeTokenLedgerConfiguration,
	normalizeTokenLedgerExport,
	normalizeTokenLedgerSummary,
	normalizeTokenLedgerView
} from "./model.js";

/** @typedef {import("@deepseek-ai/cordis").Context & { bluePluginHost: unknown, tokenLedgerV1?: unknown }} TokenLedgerBlueContext */

/** Stable Cordis entry name. */
export const name = "@dsh-blue/tokenledger";

/** Blue is required; TokenLedger arrives dynamically so absence has a UI fallback. */
export const inject = ["bluePluginHost"];

const MANIFEST = Object.freeze(JSON.parse(readFileSync(new URL("../blue.plugin.json", import.meta.url), "utf8")));
const MAIN_TABS = new Set(TOKEN_LEDGER_BLUE_MODEL.tabs.map((item) => item.id));
const BREAKDOWN_TABS = new Set(TOKEN_LEDGER_BLUE_MODEL.breakdownTabs.map((item) => item.id));
const RANGES = new Set(TOKEN_LEDGER_BLUE_MODEL.ranges.map((item) => item.id));
const MODEL_SORTS = new Set(TOKEN_LEDGER_BLUE_MODEL.modelSorts.map((item) => item.id));
const FORM_FIELDS = Object.freeze({
	"tokenledger.model-sort-form": ["sort"],
	"tokenledger.export-form": ["format"]
});
const COLLECTION_PAGE_SPECS = Object.freeze({
	sites: { collection: "sites", sortBy: "tokens", direction: "desc" },
	models: { collection: "models", direction: "desc" },
	projects: { collection: "projects", sortBy: "tokens", direction: "desc" },
	providers: { collection: "providers", sortBy: "tokens", direction: "desc" },
	activity: { collection: "activity", sortBy: "day", direction: "desc" },
	"activity-models": { collection: "activityModels", sortBy: "tokens", direction: "desc" },
	accounts: { collection: "accounts" },
	directory: { collection: "directory" }
});

function ok(value) {
	return { ok: true, value };
}

function fail(code, message) {
	return { ok: false, code, message };
}

function object(value) {
	if (value === null || typeof value !== "object") return undefined;
	return value;
}

function own(value, key) {
	const source = object(value);
	if (source === undefined) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(source, key);
		return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function method(value, key) {
	const receiver = object(value);
	if (receiver === undefined) return undefined;
	let source = receiver;
	for (let depth = 0; source !== null && depth < 10; depth += 1) {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (descriptor !== undefined) {
				if (!("value" in descriptor) || typeof descriptor.value !== "function") return undefined;
				return (...args) => Reflect.apply(descriptor.value, receiver, args);
			}
			source = Object.getPrototypeOf(source);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function safeCall(callback, fallback) {
	try {
		return callback();
	} catch {
		return fallback;
	}
}

function text(value, limit = 2_000) {
	return typeof value === "string" ? value.replaceAll(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, limit) : "";
}

function integer(value, fallback = 0) {
	return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function signalOf(value) {
	try {
		return value instanceof AbortSignal ? value : undefined;
	} catch {
		return undefined;
	}
}

function resultValue(value) {
	const success = own(value, "ok");
	if (success === true) return { ok: true, value: own(value, "value") };
	if (success === false) {
		return fail(text(own(value, "code"), 128) || "BLUE_INTERNAL_FAILURE", text(own(value, "message")) || "Blue 拒绝了此操作");
	}
	return fail("BLUE_INVALID_CONTRIBUTION", "Blue 返回了无效结果");
}

function registrationDispose(value) {
	const parsed = resultValue(value);
	if (!parsed.ok) return { result: parsed };
	const dispose = method(parsed.value, "dispose");
	const close = method(parsed.value, "close");
	const refresh = method(parsed.value, "refresh");
	return {
		result: parsed,
		registration: {
			dispose: dispose ?? (() => {}),
			close: close ?? (() => {}),
			refresh: refresh ?? (() => ok(undefined))
		}
	};
}

function errorResult(error, fallback = "TokenLedger 操作失败") {
	const code = text(own(error, "code"), 128);
	if (code === "ABORTED") return fail("BLUE_ABORTED", "操作已取消");
	if (code === "STALE") return fail("BLUE_STALE", "数据已变化，请重试");
	if (code === "UNAVAILABLE") return fail("BLUE_CAPABILITY_ABSENT", "TokenLedger 服务暂不可用");
	if (code === "INVALID_REQUEST") return fail("BLUE_ACTION_REJECTED", "TokenLedger 拒绝了无效请求");
	if (code === "RESULT_TOO_LARGE" || code === "VIEW_TOO_LARGE" || code === "SUMMARY_TOO_LARGE") {
		return fail("BLUE_LIMIT_EXCEEDED", "TokenLedger 返回的数据超出显示边界");
	}
	return fail("BLUE_ACTION_REJECTED", fallback);
}

function serviceFacade(value) {
	const current = method(value, "current");
	const subscribe = method(value, "subscribe");
	const queryUsage = method(value, "queryUsage");
	const execute = method(value, "execute");
	if (current === undefined || subscribe === undefined || queryUsage === undefined || execute === undefined) return undefined;
	return Object.freeze({
		identity: value,
		current,
		subscribe,
		queryUsage,
		queryCollection: method(value, "queryCollection"),
		execute
	});
}

function localDayKey(date) {
	return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function rangeFor(id) {
	if (id === "all") return {};
	const now = new Date();
	now.setHours(0, 0, 0, 0);
	if (id === "month") now.setDate(1);
	return { from: localDayKey(now) };
}

function valuesOf(event, formId) {
	const fields = FORM_FIELDS[formId] ?? [];
	const source = own(event, "values");
	const values = {};
	for (const field of fields) {
		const limit = field === "token" ? 32 * 1_024 : field === "baseUrl" || field === "origin" ? 2_048 : 256;
		values[field] = text(own(source, field), limit);
	}
	return values;
}

function eventOf(value) {
	return {
		kind: text(own(value, "kind"), 64),
		controlId: text(own(value, "controlId"), 160),
		tabId: text(own(value, "tabId"), 64),
		value: own(value, "value"),
		values: own(value, "values")
	};
}

function contextOf(value) {
	return {
		signal: signalOf(own(value, "signal")),
		userGesture: own(value, "userGesture")
	};
}

function sessionIdOf(value) {
	if (value === null) return undefined;
	const parsed = resultValue(value);
	const snapshot = parsed.ok ? parsed.value : value;
	return text(own(snapshot, "id"), 256) || undefined;
}

function sessionRegistration(value) {
	const parsed = resultValue(value);
	const registration = parsed.ok ? parsed.value : value;
	return method(registration, "dispose") ?? (() => {});
}

function actionResult(value, expectedRequestId) {
	const requestId = text(own(value, "requestId"), 128);
	const revision = integer(own(value, "revision"));
	const status = own(value, "status");
	if (status !== "applied" && status !== "rejected") {
		return fail("BLUE_INVALID_CONTRIBUTION", "TokenLedger 返回了无效的操作状态");
	}
	const snapshot = normalizeTokenLedgerSummary(own(value, "snapshot"));
	if (snapshot === undefined) return fail("BLUE_INVALID_CONTRIBUTION", "TokenLedger 未返回有效的操作快照");
	if (requestId !== expectedRequestId || revision < 1 || revision !== snapshot.revision) {
		return fail("BLUE_INVALID_CONTRIBUTION", "TokenLedger 返回了其他请求或版本的操作结果");
	}
	if (status === "rejected") return fail("BLUE_ACTION_REJECTED", "TokenLedger 拒绝了此操作");
	return ok({
		snapshot,
		message: text(own(value, "message")),
		data: own(value, "data")
	});
}

function queryResult(value) {
	const copied = copyPublicJson(value);
	if (copied === undefined) return undefined;
	const revision = integer(own(copied.value, "revision"));
	const view = normalizeTokenLedgerView(own(copied.value, "value"));
	return revision < 1 || view === undefined ? undefined : { revision, view };
}

function collectionResult(value, expectedCollection) {
	const copied = copyPublicJson(value);
	if (copied === undefined || copied.truncated) return undefined;
	const revision = integer(own(copied.value, "revision"));
	const page = own(copied.value, "value");
	const collection = text(own(page, "collection"), 64);
	const offset = integer(own(page, "offset"), -1);
	const sourceCount = integer(own(page, "sourceCount"), -1);
	const returnedCount = integer(own(page, "returnedCount"), -1);
	const items = own(page, "items");
	if (
		revision < 1 || collection !== expectedCollection || offset < 0 || sourceCount < 0 || returnedCount < 0 ||
		!Array.isArray(items) || returnedCount !== items.length || offset + returnedCount > sourceCount
	) return undefined;
	return { revision, page };
}

function selectedAccount(state) {
	const source = state.view ?? state.snapshot ?? {};
	const cached = own(own(state.collectionPages, "accounts"), "items");
	const accounts = [
		...(Array.isArray(source.accounts) ? source.accounts : []),
		...(Array.isArray(cached) ? cached : [])
	];
	return accounts.find((value) => text(value?.id ?? value?.origin) === state.selectedAccount) ?? accounts[0];
}

function sortedRows(state, key) {
	const cached = own(own(state.collectionPages, key), "items");
	const values = Array.isArray(cached) && integer(own(own(state.collectionPages, key), "page"), -1) === integer(state.pages[key])
		? cached
		: Array.isArray(state.view?.[key]) ? state.view[key] : [];
	return values.toSorted((left, right) => Number(right?.tokens ?? 0) - Number(left?.tokens ?? 0));
}

function sortedModels(state) {
	const cached = own(own(state.collectionPages, "models"), "items");
	const values = Array.isArray(cached) && integer(own(own(state.collectionPages, "models"), "page"), -1) === integer(state.pages.models)
		? cached
		: Array.isArray(state.view?.models) ? state.view.models : [];
	const key = state.modelSort === "cost" ? "cost" : state.modelSort;
	const priced = new Map((Array.isArray(state.view?.priced?.rows) ? state.view.priced.rows : []).map((value) => [text(value?.model), value]));
	return values.toSorted((left, right) => {
		const leftValue = key === "cost" ? Number(left?.pricing?.cost ?? priced.get(text(left?.model))?.cost ?? -1) : Number(left?.[key] ?? 0);
		const rightValue = key === "cost" ? Number(right?.pricing?.cost ?? priced.get(text(right?.model))?.cost ?? -1) : Number(right?.[key] ?? 0);
		return rightValue - leftValue || text(left?.model).localeCompare(text(right?.model));
	});
}

/**
 * Register TokenLedger's complete renderer-neutral Blue companion.
 *
 * @param {TokenLedgerBlueContext} ctx owning consumer Fiber.
 */
export function apply(ctx) {
	const host = ctx.bluePluginHost;
	const open = method(host, "open");
	if (open === undefined) return;
	const opened = resultValue(safeCall(() => open(ctx, MANIFEST), fail("BLUE_OWNER_UNAVAILABLE", "Blue 插件宿主不可用")));
	if (!opened.ok) return;
	const api = object(own(opened.value, "api")) ?? object(opened.value);
	if (api === undefined) return;

	const state = {
		tab: "overview",
		breakdownTab: "sites",
		range: "all",
		site: undefined,
		siteDetail: undefined,
		selectedModel: undefined,
		selectedProject: undefined,
		selectedProvider: undefined,
		selectedDay: undefined,
		selectedAccount: undefined,
		modelSort: "tokens",
		pages: {},
		collectionPages: {},
		exportFormat: "json",
		exportPage: 0,
		exportResult: undefined,
		snapshot: undefined,
		view: undefined,
		viewRevision: 0,
		balance: undefined,
		service: undefined,
		serviceAvailable: false,
		sessionId: undefined,
		loading: false,
		busyAction: undefined,
		error: "",
		disposed: false,
		serviceGeneration: 0,
		requestEpoch: 0,
		requestSerial: 0,
		operations: new Map()
	};
	const registrations = [];
	let overlay;
	let serviceDispose = () => {};
	let sessionDispose = () => {};

	const refreshRegistrations = () => {
		if (state.disposed) return;
		safeCall(() => overlay?.refresh(), undefined);
	};

	const renderView = () => buildTokenLedgerView(state);

	const notify = (message, tone = "default") => {
		const notifications = object(own(api, "notifications"));
		const publish = method(notifications, "publish");
		if (publish === undefined || state.disposed) return;
		safeCall(() => publish({
			id: `tokenledger.${String(state.serviceGeneration)}.${String(state.requestSerial)}`,
			view: { kind: "text", content: text(message) || "TokenLedger 操作已完成" },
			tone
		}), undefined);
	};

	const abortOperations = () => {
		for (const operation of state.operations.values()) operation.controller.abort();
		state.operations.clear();
		state.loading = false;
		state.busyAction = undefined;
	};

	const startOperation = (kind, callerSignal) => {
		state.operations.get(kind)?.controller.abort();
		const controller = new AbortController();
		const relay = () => controller.abort(callerSignal?.reason);
		if (callerSignal?.aborted === true) controller.abort(callerSignal.reason);
		else callerSignal?.addEventListener("abort", relay, { once: true });
		const operation = {
			kind,
			controller,
			relay,
			callerSignal,
			serviceGeneration: state.serviceGeneration,
			requestEpoch: state.requestEpoch,
			serial: ++state.requestSerial
		};
		state.operations.set(kind, operation);
		return operation;
	};

	const operationCurrent = (operation) => !state.disposed
		&& state.serviceGeneration === operation.serviceGeneration
		&& state.requestEpoch === operation.requestEpoch
		&& state.operations.get(operation.kind) === operation
		&& !operation.controller.signal.aborted;

	const finishOperation = (operation) => {
		operation.callerSignal?.removeEventListener("abort", operation.relay);
		if (state.operations.get(operation.kind) === operation) state.operations.delete(operation.kind);
	};

	const setSnapshot = (value, generation = state.serviceGeneration) => {
		if (state.disposed || generation !== state.serviceGeneration) return false;
		const snapshot = normalizeTokenLedgerSummary(value);
		if (snapshot === undefined) {
				state.error = "TokenLedger 返回了无效的摘要回放";
			refreshRegistrations();
			return false;
		}
		if (state.snapshot !== undefined && snapshot.revision <= state.snapshot.revision) return false;
			state.snapshot = snapshot;
			if (state.viewRevision < snapshot.revision) state.collectionPages = {};
			state.error = "";
		refreshRegistrations();
		return true;
	};

	const loadView = async (callerSignal) => {
		const service = state.service;
		if (service === undefined) return fail("BLUE_CAPABILITY_ABSENT", "TokenLedger 服务暂不可用");
		const operation = startOperation("view", callerSignal);
		state.loading = true;
		state.error = "";
		refreshRegistrations();
		try {
			const requestId = `blue-view-${String(operation.serviceGeneration)}-${String(operation.requestEpoch)}-${String(operation.serial)}`;
			const expectedRevision = state.snapshot?.revision;
			if (expectedRevision === undefined) return fail("BLUE_INVALID_CONTRIBUTION", "TokenLedger 没有有效的摘要版本");
			const raw = await service.queryUsage({ requestId, range: rangeFor(state.range), ...(state.site === undefined ? {} : { site: state.site }) }, { signal: operation.controller.signal });
			if (!operationCurrent(operation)) return fail(operation.controller.signal.aborted ? "BLUE_ABORTED" : "BLUE_STALE", "用量读取已过期");
			const result = queryResult(raw);
			if (result === undefined) {
				state.error = "TokenLedger 返回了无效的用量明细";
				return fail("BLUE_INVALID_CONTRIBUTION", state.error);
			}
			if (result.revision !== expectedRevision || state.snapshot?.revision !== expectedRevision) {
				return fail("BLUE_STALE", "用量明细与当前摘要版本不一致");
			}
				state.view = result.view;
				state.viewRevision = result.revision;
				state.collectionPages = {};
				state.error = "";
			return ok(undefined);
		} catch (error) {
			if (!operationCurrent(operation)) return fail(operation.controller.signal.aborted ? "BLUE_ABORTED" : "BLUE_STALE", "用量读取已过期");
			const result = errorResult(error, "TokenLedger 用量读取失败");
			state.error = result.message;
			return result;
		} finally {
			if (state.operations.get("view") === operation) state.loading = false;
			finishOperation(operation);
			refreshRegistrations();
		}
	};

	const loadCollectionPage = async (key, page, callerSignal) => {
		const service = state.service;
		const specification = COLLECTION_PAGE_SPECS[key];
		if (service === undefined) return fail("BLUE_CAPABILITY_ABSENT", "TokenLedger 服务暂不可用");
		if (service.queryCollection === undefined) {
			return fail("BLUE_CAPABILITY_UNSUPPORTED", "当前 TokenLedger 服务无法读取初始边界以外的数据");
		}
		if (specification === undefined) return fail("BLUE_ACTION_REJECTED", "未知的 TokenLedger 集合页面");
		if (key === "activity-models" && state.selectedDay === undefined) {
			return fail("BLUE_ACTION_REJECTED", "请先选择活动日期，再读取当日模型");
		}
		const operation = startOperation(`collection:${key}`, callerSignal);
		state.error = "";
		refreshRegistrations();
		try {
			const requestId = `blue-collection-${key}-${String(operation.serviceGeneration)}-${String(operation.requestEpoch)}-${String(operation.serial)}`;
			const expectedRevision = state.viewRevision || state.snapshot?.revision;
			if (expectedRevision === undefined) return fail("BLUE_INVALID_CONTRIBUTION", "TokenLedger 没有有效的集合版本");
			const sortBy = key === "models" ? state.modelSort : specification.sortBy;
			const raw = await service.queryCollection({
				requestId,
				...(expectedRevision === undefined ? {} : { expectedRevision }),
				collection: specification.collection,
				offset: page * TOKEN_LEDGER_BLUE_MODEL.pageSize,
				limit: TOKEN_LEDGER_BLUE_MODEL.pageSize,
				...(sortBy === undefined ? {} : { sortBy, direction: specification.direction }),
				...(key === "activity-models" ? { day: state.selectedDay } : {}),
				range: rangeFor(state.range),
				...(state.site === undefined ? {} : { site: state.site })
			}, { signal: operation.controller.signal });
			if (!operationCurrent(operation)) return fail(operation.controller.signal.aborted ? "BLUE_ABORTED" : "BLUE_STALE", "集合页面已过期");
			const result = collectionResult(raw, specification.collection);
			if (result === undefined) {
				state.error = "TokenLedger 返回了无效的集合页面";
				return fail("BLUE_INVALID_CONTRIBUTION", state.error);
			}
			if (result.revision !== expectedRevision || state.snapshot?.revision !== expectedRevision) {
				return fail("BLUE_STALE", "集合页面与当前用量版本不一致");
			}
			state.collectionPages = {
				...state.collectionPages,
				[key]: { ...result.page, page }
			};
			state.error = "";
			return ok(undefined);
		} catch (error) {
			if (!operationCurrent(operation)) return fail(operation.controller.signal.aborted ? "BLUE_ABORTED" : "BLUE_STALE", "集合页面已过期");
			const result = errorResult(error, "TokenLedger 集合页面读取失败");
			state.error = result.message;
			return result;
		} finally {
			finishOperation(operation);
			refreshRegistrations();
		}
	};

	const executeAction = async (action, callerSignal, options = {}) => {
		const service = state.service;
		if (service === undefined) return fail("BLUE_CAPABILITY_ABSENT", "TokenLedger 服务暂不可用");
		const operation = startOperation("action", callerSignal);
		state.busyAction = text(action.type, 80);
		state.error = "";
		refreshRegistrations();
		try {
			const requestId = `blue-action-${String(operation.serviceGeneration)}-${String(operation.requestEpoch)}-${String(operation.serial)}`;
			const expectedRevision = state.snapshot?.revision;
			if (expectedRevision === undefined) return fail("BLUE_INVALID_CONTRIBUTION", "TokenLedger 没有有效的操作版本");
			const raw = await service.execute({ requestId, ...(expectedRevision === undefined ? {} : { expectedRevision }), action }, { signal: operation.controller.signal });
			if (!operationCurrent(operation)) return fail(operation.controller.signal.aborted ? "BLUE_ABORTED" : "BLUE_STALE", "TokenLedger 操作已过期");
			const result = actionResult(raw, requestId);
			if (!result.ok) {
				state.error = result.message;
				notify(result.message, result.code === "BLUE_STALE" ? "warning" : "danger");
				return result;
			}
			const resultRevision = result.value.snapshot.revision;
			const currentRevision = state.snapshot?.revision;
			const readOnly = action.type === "balance.refresh" || action.type === "usage.export";
			if (
				resultRevision < expectedRevision ||
				(currentRevision !== undefined && resultRevision < currentRevision) ||
				(readOnly && resultRevision !== expectedRevision)
			) return fail("BLUE_STALE", "TokenLedger 操作结果与当前版本不一致");
			setSnapshot(result.value.snapshot, operation.serviceGeneration);
			state.error = "";
			if (options.balance === true) {
				const balance = normalizeTokenLedgerBalance(result.value.data);
				if (balance === undefined) return fail("BLUE_INVALID_CONTRIBUTION", "TokenLedger 返回了无效的余额结果");
				state.balance = balance;
				state.pages = { ...state.pages, "quota-windows": 0 };
			}
			if (options.export === true) {
				const exportResult = normalizeTokenLedgerExport(result.value.data);
				if (exportResult === undefined) return fail("BLUE_INVALID_CONTRIBUTION", "TokenLedger 返回了无效的导出结果");
				state.exportResult = exportResult;
				state.exportPage = 0;
			}
			notify("TokenLedger 操作已完成", "success");
			if (options.reloadView === true) await loadView(operation.controller.signal);
			return ok(undefined);
		} catch (error) {
			if (!operationCurrent(operation)) return fail(operation.controller.signal.aborted ? "BLUE_ABORTED" : "BLUE_STALE", "TokenLedger 操作已过期");
			const result = errorResult(error);
			state.error = result.message;
			notify(result.message, result.code === "BLUE_STALE" ? "warning" : "danger");
			return result;
		} finally {
			if (state.operations.get("action") === operation) state.busyAction = undefined;
			finishOperation(operation);
			refreshRegistrations();
		}
	};

	const setRange = async (range, callerSignal) => {
		if (!RANGES.has(range)) return fail("BLUE_ACTION_REJECTED", "未知的 TokenLedger 统计范围");
		state.range = range;
		state.pages = {};
		state.collectionPages = {};
		state.exportResult = undefined;
		refreshRegistrations();
		return loadView(callerSignal);
	};

	const cachedItem = (key, index) => {
		const page = own(state.collectionPages, key);
		const items = own(page, "items");
		const offset = integer(own(page, "offset"), -1);
		return Array.isArray(items) && offset >= 0 && index >= offset ? items[index - offset] : undefined;
	};

	const collectionOmitted = (collection) => integer(own(own(own(state.view, "collectionBounds"), collection), "omittedCount"));

	const localCollectionLength = (key) => {
		if (key === "activity-models") {
			return (state.view?.activityModels ?? []).filter((value) => text(value?.day) === state.selectedDay).length;
		}
		const collection = COLLECTION_PAGE_SPECS[key]?.collection;
		return Array.isArray(state.view?.[collection]) ? state.view[collection].length : 0;
	};

	const selectByIndex = (controlId, value) => {
		const index = integer(Number(text(value).split(":").at(-1)), -1);
		if (index < 0) return false;
		if (controlId === "tokenledger.sites") state.siteDetail = text(cachedItem("sites", index)?.site ?? state.view?.sites?.[index]?.site) || undefined;
		else if (controlId === "tokenledger.models") {
			state.selectedModel = text(cachedItem("models", index)?.model ?? sortedModels(state)[index]?.model) || undefined;
		}
		else if (controlId === "tokenledger.projects") {
			const selected = cachedItem("projects", index) ?? sortedRows(state, "projects")[index];
			state.selectedProject = text(selected?.label ?? selected?.project) || undefined;
		}
		else if (controlId === "tokenledger.providers") {
			state.selectedProvider = text(cachedItem("providers", index)?.provider ?? sortedRows(state, "providers")[index]?.provider) || undefined;
		}
		else if (controlId === "tokenledger.activity") {
			state.selectedDay = text(cachedItem("activity", index)?.day ?? [...(state.view?.activity ?? [])].reverse()[index]?.day) || undefined;
			state.pages = { ...state.pages, "activity-models": 0 };
		} else if (controlId === "tokenledger.accounts") {
			const selected = cachedItem("accounts", index) ?? (state.view?.accounts ?? state.snapshot?.accounts ?? [])[index];
			state.selectedAccount = text(selected?.id ?? selected?.origin) || undefined;
			state.balance = undefined;
			state.pages = { ...state.pages, "quota-windows": 0 };
		}
		else return false;
		return true;
	};

	const pageAction = (controlId) => {
		const match = /^tokenledger\.page\.(sites|models|projects|providers|activity|activity-models|accounts|quota-windows)\.(prev|next)$/u.exec(controlId);
		if (match === null) return undefined;
		const key = match[1];
		const delta = match[2] === "next" ? 1 : -1;
		const nextPage = Math.max(0, integer(state.pages[key]) + delta);
		return { key, nextPage };
	};

	const activate = async (controlId, callerSignal) => {
		const requestedPage = pageAction(controlId);
		if (requestedPage !== undefined) {
			const { key, nextPage } = requestedPage;
			const specification = COLLECTION_PAGE_SPECS[key];
			const firstIndex = nextPage * TOKEN_LEDGER_BLUE_MODEL.pageSize;
			const shouldContinue = specification !== undefined && (
				key === "activity-models" ||
				(key === "models" && collectionOmitted("models") > 0) ||
				firstIndex >= localCollectionLength(key)
			);
			if (shouldContinue) {
				const loaded = await loadCollectionPage(key, nextPage, callerSignal);
				if (!loaded.ok) return loaded;
				if (key === "sites" && collectionOmitted("directory") > 0) {
					await loadCollectionPage("directory", nextPage, callerSignal);
				}
			}
			state.pages = { ...state.pages, [key]: nextPage };
			refreshRegistrations();
			return ok(undefined);
		}
		if (controlId === "tokenledger.cancel") {
			abortOperations();
			refreshRegistrations();
			return ok(undefined);
		}
		if (controlId === "tokenledger.refresh") return executeAction({ type: "usage.refresh" }, callerSignal, { reloadView: true });
		if (controlId === "tokenledger.rebuild") return executeAction({ type: "index.rebuild" }, callerSignal, { reloadView: true });
		if (controlId === "tokenledger.clear-site") {
			state.site = undefined;
			state.pages = {};
			state.collectionPages = {};
			return loadView(callerSignal);
		}
		if (controlId === "tokenledger.filter-selected-site") {
			if (state.siteDetail === undefined) return fail("BLUE_ACTION_REJECTED", "尚未选择 TokenLedger 站点");
			state.site = state.siteDetail;
			state.pages = {};
			state.collectionPages = {};
			return loadView(callerSignal);
		}
		if (controlId === "tokenledger.balance.refresh") {
			const account = selectedAccount(state);
			if (account === undefined) return fail("BLUE_ACTION_REJECTED", "尚未选择 TokenLedger 账户");
			return executeAction({ type: "balance.refresh", ...(text(account.id) === "" ? {} : { accountId: text(account.id) }) }, callerSignal, { balance: true });
		}
		if (controlId === "tokenledger.export.prev") state.exportPage = Math.max(0, state.exportPage - 1);
		else if (controlId === "tokenledger.export.next") state.exportPage += 1;
		else if (controlId === "tokenledger.export.clear") {
			state.exportResult = undefined;
			state.exportPage = 0;
		} else return ok(undefined);
		refreshRegistrations();
		return ok(undefined);
	};

	const submit = async (event, controlId, callerSignal) => {
		const values = valuesOf(event, controlId);
		if (controlId === "tokenledger.model-sort-form") {
			if (!MODEL_SORTS.has(values.sort)) return fail("BLUE_ACTION_REJECTED", "未知的 TokenLedger 模型排序方式");
			state.modelSort = values.sort;
			state.pages = { ...state.pages, models: 0 };
			if (collectionOmitted("models") > 0) {
				const loaded = await loadCollectionPage("models", 0, callerSignal);
				if (!loaded.ok) return loaded;
			}
			refreshRegistrations();
			return ok(undefined);
		}
		if (controlId === "tokenledger.export-form") {
			state.exportFormat = values.format === "csv" ? "csv" : "json";
			return executeAction({ type: "usage.export", format: state.exportFormat, range: rangeFor(state.range), ...(state.site === undefined ? {} : { site: state.site }) }, callerSignal, { export: true });
		}
		return ok(undefined);
	};

	const handleEvent = async (rawEvent, rawContext) => {
		if (state.disposed) return fail("BLUE_ACTION_REJECTED", "TokenLedger Blue 适配器已卸载");
		const event = eventOf(rawEvent);
		const context = contextOf(rawContext);
		if (event.kind === "tab-change") {
			if (event.controlId === "tokenledger.tabs") {
				if (!MAIN_TABS.has(event.tabId)) return fail("BLUE_INVALID_CONTRIBUTION", "未知的 TokenLedger 页面");
				state.tab = event.tabId;
				state.error = "";
				refreshRegistrations();
				if ((event.tabId === "breakdown" || event.tabId === "accounts") && state.view === undefined) return loadView(context.signal);
				return ok(undefined);
			}
			if (event.controlId === "tokenledger.breakdown.tabs") {
				if (!BREAKDOWN_TABS.has(event.tabId)) return fail("BLUE_INVALID_CONTRIBUTION", "未知的 TokenLedger 明细页面");
				state.breakdownTab = event.tabId;
				state.error = "";
				refreshRegistrations();
				return ok(undefined);
			}
		}
		if (event.kind === "selection-change" || event.kind === "value-change") {
			const value = text(event.value, 512);
			if (event.controlId === "tokenledger.range-list" && value.startsWith("range:")) return setRange(value.slice(6), context.signal);
			if (selectByIndex(event.controlId, value)) {
				refreshRegistrations();
				if (event.controlId === "tokenledger.activity" && collectionOmitted("activityModels") > 0) {
					return loadCollectionPage("activity-models", 0, context.signal);
				}
				return ok(undefined);
			}
			return ok(undefined);
		}
		if (event.kind === "submit") return submit(event, event.controlId, context.signal);
		if (event.kind === "activate") return activate(event.controlId, context.signal);
		return ok(undefined);
	};

	const onEvent = async (rawEvent, rawContext) => {
		try {
			return await handleEvent(rawEvent, rawContext);
		} catch (error) {
			return errorResult(error);
		}
	};

	const openOverlay = (userGesture) => {
		const overlays = object(own(api, "overlays"));
		const openManagedOverlay = method(overlays, "open");
		if (openManagedOverlay === undefined) return fail("BLUE_CAPABILITY_ABSENT", "TokenLedger 浮层不可用");
		if (userGesture === undefined) return fail("BLUE_ACTION_REJECTED", "打开 TokenLedger 需要有效的用户操作");
		safeCall(() => overlay?.close(), undefined);
		const registered = registrationDispose(safeCall(() => openManagedOverlay({
			id: "tokenledger.dashboard.overlay",
			capturing: true,
			dismissible: true,
			anchor: "center",
			width: "86%",
			maxHeight: "90%",
			render: renderView,
			onEvent
		}, { userGesture }), fail("BLUE_INTERNAL_FAILURE", "TokenLedger 浮层打开失败")));
		if (registered.registration === undefined) return registered.result;
		overlay = registered.registration;
		return ok(undefined);
	};

	const commands = object(own(api, "commands"));
	const registerCommand = method(commands, "register");
	if (registerCommand !== undefined) {
		const registered = registrationDispose(safeCall(() => registerCommand({
			id: "tokenledger",
			label: "打开 TokenLedger 用量账本",
			execute: async (rawArgs, rawOptions = {}) => {
				const args = Array.isArray(rawArgs) ? rawArgs.map((value) => text(value, 256)).filter(Boolean).slice(0, 16) : [];
				const signal = signalOf(own(rawOptions, "signal"));
				const userGesture = own(rawOptions, "userGesture");
				const tabArgument = args.find((value) => value.startsWith("--tab="));
				const requestedTab = tabArgument === undefined ? undefined : tabArgument.slice(6);
				if (requestedTab !== undefined && MAIN_TABS.has(requestedTab)) state.tab = requestedTab;
				const range = args.find((value) => RANGES.has(value));
				if (range !== undefined) state.range = range;
				const site = args.find((value) => !value.startsWith("--") && !RANGES.has(value));
				if (site !== undefined) state.site = site;
			state.pages = {};
			state.collectionPages = {};
				if (state.serviceAvailable) {
					const result = args.includes("--refresh")
						? await executeAction({ type: "usage.refresh" }, signal, { reloadView: true })
						: await loadView(signal);
					if (!result.ok && result.code !== "BLUE_CAPABILITY_ABSENT") return result;
				}
				return openOverlay(userGesture);
			}
		}), fail("BLUE_INTERNAL_FAILURE", "TokenLedger 命令注册失败")));
		if (registered.registration !== undefined) registrations.push(registered.registration);
	}

	const detachService = (identity) => {
		if (identity !== undefined && state.service?.identity !== identity) return;
		state.serviceGeneration += 1;
		state.requestEpoch += 1;
		abortOperations();
		serviceDispose();
		serviceDispose = () => {};
		state.service = undefined;
		state.serviceAvailable = false;
		state.snapshot = undefined;
		state.view = undefined;
		state.viewRevision = 0;
		state.collectionPages = {};
		state.balance = undefined;
		state.exportResult = undefined;
		state.error = "";
		refreshRegistrations();
	};

	const attachService = (rawService, scoped) => {
		const service = serviceFacade(rawService);
		if (service === undefined) {
			state.error = "tokenLedgerV1 不符合公开 Service 契约";
			refreshRegistrations();
			return;
		}
		detachService();
		state.serviceGeneration += 1;
		const generation = state.serviceGeneration;
		state.service = service;
		state.serviceAvailable = true;
		state.error = "";
		setSnapshot(safeCall(() => service.current(), undefined), generation);
		const lifetime = new AbortController();
		const disposeSubscription = safeCall(() => service.subscribe((snapshot) => {
			if (state.disposed || generation !== state.serviceGeneration) return;
			setSnapshot(snapshot, generation);
		}, { signal: lifetime.signal }), undefined);
		serviceDispose = () => {
			lifetime.abort();
			if (typeof disposeSubscription === "function") safeCall(() => disposeSubscription(), undefined);
		};
		scoped.effect(() => () => detachService(rawService), "TokenLedger Blue service binding");
		refreshRegistrations();
		void loadView();
	};

	ctx.inject(["tokenLedgerV1"], (scoped) => {
		if (state.disposed) return;
		const serviceContext = /** @type {TokenLedgerBlueContext} */ (scoped);
		attachService(serviceContext.tokenLedgerV1, scoped);
	});

	const session = object(own(api, "session"));
	const setSession = (value) => {
		const next = sessionIdOf(value);
		if (next === state.sessionId) return;
		state.sessionId = next;
		state.requestEpoch += 1;
		abortOperations();
		state.balance = undefined;
		state.exportResult = undefined;
		state.error = "";
		refreshRegistrations();
		if (state.serviceAvailable) void loadView();
	};
	if (session !== undefined) {
		const current = method(session, "current");
		const subscribe = method(session, "subscribe");
		if (current !== undefined) setSession(safeCall(() => current(), null));
		if (subscribe !== undefined) {
			const subscription = safeCall(() => subscribe((value) => {
				if (!state.disposed) setSession(value);
			}), undefined);
			sessionDispose = sessionRegistration(subscription);
		}
	}

	ctx.effect(() => () => {
		state.disposed = true;
		state.serviceGeneration += 1;
		state.requestEpoch += 1;
		abortOperations();
		serviceDispose();
		sessionDispose();
		safeCall(() => overlay?.close(), undefined);
		for (const registration of registrations.toReversed()) safeCall(() => registration.dispose(), undefined);
	}, "TokenLedger Blue companion");
}

export {
	TOKEN_LEDGER_BLUE_MODEL,
	buildTokenLedgerView,
	copyPublicJson,
	normalizeTokenLedgerBalance,
	normalizeTokenLedgerConfiguration,
	normalizeTokenLedgerExport,
	normalizeTokenLedgerSummary,
	normalizeTokenLedgerView
};
