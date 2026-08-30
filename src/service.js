/**
 * Renderer-neutral public service for TokenLedger.
 *
 * The host plugin remains the only owner of the SQLite index, relay directory,
 * provider readers, and settings scopes. Consumers receive bounded immutable
 * views and structured actions; they never receive the store or Cordis objects.
 *
 * @module dsh-tokenledger/service
 */

import { isPromise, isProxy } from "node:util/types";

/** Maximum serialized size of the replayed summary snapshot. */
export const TOKEN_LEDGER_SUMMARY_MAX_BYTES = 128 * 1024;

/** Maximum serialized size of one detailed usage view. */
export const TOKEN_LEDGER_VIEW_MAX_BYTES = 512 * 1024;

/** Maximum serialized size of an export returned through the public service. */
export const TOKEN_LEDGER_EXPORT_MAX_BYTES = 1024 * 1024;

/** Maximum serialized size of one admitted structured action. */
export const TOKEN_LEDGER_ACTION_MAX_BYTES = 64 * 1024;

/** Maximum serialized size of one collection continuation page. */
export const TOKEN_LEDGER_COLLECTION_MAX_BYTES = 256 * 1024;

/** Maximum rows admitted by one collection continuation request. */
export const TOKEN_LEDGER_COLLECTION_PAGE_MAX = 128;

const COLLECTION_LIMITS = Object.freeze({
	days: 400,
	activity: 371,
	activityModels: 2048,
	models: 256,
	sites: 128,
	projects: 256,
	providers: 256,
	directory: 128,
	accounts: 128,
	pricedRows: 256
});

const COLLECTION_NAMES = new Set(Object.keys(COLLECTION_LIMITS));
const COLLECTION_SORTS = Object.freeze({
	days: new Set(["day", "tokens", "requests"]),
	activity: new Set(["day", "tokens", "requests"]),
	activityModels: new Set(["day", "model", "tokens", "requests"]),
	models: new Set(["model", "tokens", "requests", "inputTokens", "cacheReadTokens", "outputTokens", "cost"]),
	sites: new Set(["site", "tokens", "requests"]),
	projects: new Set(["project", "label", "tokens", "requests"]),
	providers: new Set(["provider", "tokens", "requests"]),
	directory: new Set(["id", "type"]),
	accounts: new Set(["id", "displayName", "origin", "provider"]),
	pricedRows: new Set(["model", "cost"])
});
const MAX_BOUNDARY_OMISSIONS = 64;
const COLLECTION_SCAN_MAX = 65_536;
const CLONE_NODE_MAX = 32_768;
const CLONE_TEXT_MAX_BYTES = TOKEN_LEDGER_VIEW_MAX_BYTES;
const ACTION_NODE_MAX = 8_192;
const ACTION_KEY_MAX = 8_192;
const ACTION_ARRAY_LENGTH_MAX = 8_192;

const ACTION_TYPES = new Set([
	"usage.refresh",
	"index.rebuild",
	"balance.refresh",
	"usage.export",
	"settings.relay.set",
	"settings.relay.remove",
	"settings.wallet.set",
	"settings.wallet.clear"
]);

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

/** Stable failures surfaced by the public renderer-neutral seam. */
export class TokenLedgerError extends Error {
	/**
	 * @param {string} code stable machine-readable failure code.
	 * @param {string} message human-readable diagnostic.
	 * @param {{ requestId?: string }} [options] public error context.
	 */
	constructor(code, message, options = {}) {
		// The implementation error is intentionally not attached as `cause`: a
		// provider/settings error may retain credentials or response bodies, while
		// this error crosses the public renderer-neutral boundary.
		super(message);
		this.name = "TokenLedgerError";
		this.code = code;
		if (typeof options.requestId === "string") this.requestId = options.requestId;
	}
}

function deepFreeze(value, seen = new WeakSet()) {
	if (value === null || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
		if ("value" in descriptor) deepFreeze(descriptor.value, seen);
	}
	return Object.freeze(value);
}

function safeCount(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeAdd(left, right) {
	return Math.min(Number.MAX_SAFE_INTEGER, safeCount(left) + safeCount(right));
}

function omission(tracker, path, kind, sourceCount, returnedCount) {
	const safeSourceCount = safeCount(sourceCount);
	const safeReturnedCount = Math.min(safeSourceCount, safeCount(returnedCount));
	const omittedCount = safeSourceCount - safeReturnedCount;
	if (omittedCount === 0) return;
	tracker.truncated = true;
	tracker.omittedCount = safeAdd(tracker.omittedCount, omittedCount);
	if (tracker.details.length < MAX_BOUNDARY_OMISSIONS) {
		tracker.details.push({
			path: path.slice(0, 512),
			kind: kind.slice(0, 64),
			sourceCount: safeSourceCount,
			returnedCount: safeReturnedCount,
			omittedCount
		});
	} else {
		tracker.unreported = safeAdd(tracker.unreported, 1);
	}
}

function boundaryTracker() {
	return { truncated: false, omittedCount: 0, unreported: 0, details: [] };
}

function copyBoundaryTracker(source) {
	return {
		truncated: source.truncated,
		omittedCount: source.omittedCount,
		unreported: source.unreported,
		details: [...source.details]
	};
}

function childPath(path, key) {
	const segment = String(key).slice(0, 96).replaceAll(/[^a-z0-9_.-]/gi, "_");
	return `${path}.${segment}`;
}

function cloneBudget() {
	return { nodes: CLONE_NODE_MAX, textBytes: CLONE_TEXT_MAX_BYTES, exhausted: false };
}

function validTextEnd(value, end) {
	if (end <= 0 || end >= value.length) return end;
	const previous = value.charCodeAt(end - 1);
	const next = value.charCodeAt(end);
	return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
		? end - 1
		: end;
}

function utf8Prefix(value, characterLimit, byteLimit) {
	let low = 0;
	let high = Math.min(value.length, characterLimit, byteLimit);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const end = validTextEnd(value, middle);
		if (Buffer.byteLength(value.slice(0, end), "utf8") <= byteLimit) low = middle;
		else high = middle - 1;
	}
	const end = validTextEnd(value, low);
	return value.slice(0, end);
}

function boundedText(value, limit, tracker, path, fallback = "", budget = undefined) {
	if (typeof value !== "string") return fallback;
	const candidate = value.slice(0, validTextEnd(value, Math.min(value.length, limit)));
	let result = candidate;
	if (budget !== undefined) {
		if (budget.exhausted || budget.textBytes <= 0) {
			omission(tracker, path, "text-budget", Math.max(1, candidate.length), 0);
			budget.exhausted = true;
			budget.textBytes = 0;
			return "";
		}
		const candidateBytes = Buffer.byteLength(candidate, "utf8");
		if (candidateBytes > budget.textBytes) {
			result = utf8Prefix(candidate, candidate.length, budget.textBytes);
			const returnedBytes = Buffer.byteLength(result, "utf8");
			omission(tracker, path, "text-budget", candidateBytes, returnedBytes);
			budget.textBytes = 0;
			budget.exhausted = true;
		} else {
			budget.textBytes -= candidateBytes;
		}
	}
	omission(tracker, path, "string", value.length, result.length);
	return result;
}

function dataProperty(value, key, tracker, path = String(key)) {
	if (value === null || typeof value !== "object") return undefined;
	if (isProxy(value)) {
		if (tracker !== undefined) omission(tracker, path, "proxy", 1, 0);
		return undefined;
	}
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined) return undefined;
		if (!("value" in descriptor)) {
			if (tracker !== undefined) omission(tracker, path, "accessor", 1, 0);
			return undefined;
		}
		return descriptor.value;
	} catch {
		if (tracker !== undefined) omission(tracker, path, "property", 1, 0);
		return undefined;
	}
}

function arrayLength(value, tracker, path) {
	if (value === null || typeof value !== "object") return undefined;
	if (isProxy(value)) {
		if (tracker !== undefined) omission(tracker, path, "proxy", 1, 0);
		return undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const length = dataProperty(value, "length", tracker, `${path}.length`);
	return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

function arrayValues(value, tracker, path, offset, limit) {
	const sourceCount = arrayLength(value, tracker, path) ?? 0;
	const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, sourceCount) : 0;
	const safeLimit = Number.isSafeInteger(limit) && limit >= 0 ? limit : 0;
	const returnedCount = Math.min(safeLimit, sourceCount - safeOffset);
	const result = [];
	for (let relativeIndex = 0; relativeIndex < returnedCount; relativeIndex += 1) {
		const index = safeOffset + relativeIndex;
		const itemPath = `${path}[${String(index)}]`;
		let descriptor;
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		} catch {
			if (tracker !== undefined) omission(tracker, itemPath, "property", 1, 0);
			result.push(undefined);
			continue;
		}
		if (descriptor !== undefined && "value" in descriptor) result.push(descriptor.value);
		else {
			if (descriptor !== undefined && tracker !== undefined) omission(tracker, itemPath, "accessor", 1, 0);
			result.push(undefined);
		}
	}
	return { sourceCount, values: result };
}

const OMITTED = Symbol("tokenledger.omitted");

function reserveCloneNode(budget, tracker, path) {
	if (budget.exhausted || budget.nodes <= 0) {
		omission(tracker, path, "node-budget", 1, 0);
		budget.exhausted = true;
		budget.nodes = 0;
		return false;
	}
	budget.nodes -= 1;
	return true;
}

function reserveCloneKey(key, budget, tracker, path) {
	if (budget.exhausted || budget.textBytes <= 0 || key.length > budget.textBytes) {
		omission(tracker, path, "text-budget", Math.max(1, key.length), 0);
		budget.exhausted = true;
		budget.textBytes = 0;
		return false;
	}
	const keyBytes = Buffer.byteLength(key, "utf8");
	if (keyBytes > budget.textBytes) {
		omission(tracker, path, "text-budget", keyBytes, 0);
		budget.exhausted = true;
		budget.textBytes = 0;
		return false;
	}
	budget.textBytes -= keyBytes;
	return true;
}

function rejectedKeyKind(key) {
	if (key.length > 64) return "key";
	const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
	if (
		PRIVATE_KEYS.has(normalized)
		|| normalized === "prototype"
		|| normalized === "constructor"
		|| key.toLowerCase() === "__proto__"
	) return "private-key";
	return undefined;
}

function boundedClone(value, depth = 0, arrayLimit = 128, tracker = boundaryTracker(), path = "value", budget = cloneBudget()) {
	if (!reserveCloneNode(budget, tracker, path)) return OMITTED;
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	if (typeof value === "string") return boundedText(value, 2048, tracker, path, "", budget);
	if (depth >= 8 || typeof value !== "object") {
		if (typeof value === "object") omission(tracker, path, "depth", 1, 0);
		return null;
	}
	if (isProxy(value)) {
		omission(tracker, path, "proxy", 1, 0);
		return null;
	}
	if (Array.isArray(value)) {
		const allowed = Math.min(arrayLimit, Math.max(0, budget.nodes));
		const { sourceCount, values } = arrayValues(value, tracker, path, 0, allowed);
		omission(tracker, path, "array", sourceCount, values.length);
		const result = [];
		for (let index = 0; index < values.length; index += 1) {
			const cloned = boundedClone(values[index], depth + 1, arrayLimit, tracker, `${path}[${String(index)}]`, budget);
			if (cloned === OMITTED) break;
			result.push(cloned);
			if (budget.exhausted) break;
		}
		return result;
	}
	const out = {};
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== null && prototype !== Object.prototype) {
			omission(tracker, path, "prototype", 1, 0);
			return null;
		}
	} catch {
		omission(tracker, path, "object", 1, 0);
		return null;
	}
	let inspected = 0;
	try {
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			inspected += 1;
			if (inspected > 96) {
				omission(tracker, path, "object", inspected, inspected - 1);
				break;
			}
			const rejectedKind = rejectedKeyKind(key);
			if (rejectedKind !== undefined) {
				const rejectedPath = rejectedKind === "key" ? `${path}.[key]` : childPath(path, key);
				omission(tracker, rejectedPath, rejectedKind, 1, 0);
				continue;
			}
			const nextPath = childPath(path, key);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !descriptor.enumerable) continue;
			if (!("value" in descriptor)) {
				omission(tracker, nextPath, "accessor", 1, 0);
				continue;
			}
			if (descriptor.value === undefined) continue;
			if (!reserveCloneKey(key, budget, tracker, nextPath)) break;
			const cloned = boundedClone(descriptor.value, depth + 1, arrayLimit, tracker, nextPath, budget);
			if (cloned === OMITTED) break;
			Object.defineProperty(out, key, { value: cloned, enumerable: true, configurable: true, writable: true });
			if (budget.exhausted) break;
		}
	} catch {
		omission(tracker, path, "object", 1, 0);
	}
	return out;
}

function boundedCloneOr(value, arrayLimit, tracker, path, budget, fallback) {
	const cloned = boundedClone(value, 0, arrayLimit, tracker, path, budget);
	return cloned === OMITTED ? fallback : cloned;
}

function bytes(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function collectionArray(value, name, tracker = undefined) {
	if (name === "pricedRows") {
		const priced = dataProperty(value, "priced", tracker, "priced");
		return { value: dataProperty(priced, "rows", tracker, "priced.rows"), path: "priced.rows" };
	}
	return { value: dataProperty(value, name, tracker, name), path: name };
}

function collectionSourceCount(value, name, tracker = undefined) {
	const source = collectionArray(value, name, tracker);
	return arrayLength(source.value, tracker, source.path) ?? 0;
}

function collectionSource(value, name, tracker, requestId) {
	const source = collectionArray(value, name, tracker);
	const sourceCount = arrayLength(source.value, tracker, source.path) ?? 0;
	if (sourceCount > COLLECTION_SCAN_MAX) {
		throw new TokenLedgerError("VIEW_TOO_LARGE", "tokenledger collection source exceeded its safe scan limit", {
			requestId
		});
	}
	return arrayValues(source.value, tracker, source.path, 0, sourceCount).values;
}

function rows(value, limit, tracker, path, budget) {
	const result = boundedClone(value, 0, limit, tracker, path, budget);
	return Array.isArray(result) ? result : [];
}

function collectionBounds(source, value, tracker) {
	const inheritedBounds = dataProperty(source, "collectionBounds", tracker, "collectionBounds");
	return Object.fromEntries(Object.keys(COLLECTION_LIMITS).map((name) => {
		const inherited = dataProperty(inheritedBounds, name, tracker, `collectionBounds.${name}`);
		const inheritedCount = dataProperty(inherited, "sourceCount", tracker, `collectionBounds.${name}.sourceCount`);
		const sourceCount = Number.isSafeInteger(inheritedCount) && inheritedCount >= 0
			? inheritedCount
			: collectionSourceCount(source, name, tracker);
		const returnedCount = collectionSourceCount(value, name);
		return [name, {
			sourceCount,
			returnedCount,
			omittedCount: Math.max(0, sourceCount - returnedCount)
		}];
	}));
}

function boundaryDetail(value, tracker, index) {
	const entryPath = `boundaryOmissions[${String(index)}]`;
	const path = dataProperty(value, "path", tracker, `${entryPath}.path`);
	const kind = dataProperty(value, "kind", tracker, `${entryPath}.kind`);
	const sourceCount = dataProperty(value, "sourceCount", tracker, `${entryPath}.sourceCount`);
	const returnedCount = dataProperty(value, "returnedCount", tracker, `${entryPath}.returnedCount`);
	const omittedCount = dataProperty(value, "omittedCount", tracker, `${entryPath}.omittedCount`);
	if (
		typeof path !== "string"
		|| typeof kind !== "string"
		|| !Number.isSafeInteger(sourceCount)
		|| sourceCount < 0
		|| !Number.isSafeInteger(returnedCount)
		|| returnedCount < 0
		|| returnedCount > sourceCount
		|| !Number.isSafeInteger(omittedCount)
		|| omittedCount !== sourceCount - returnedCount
	) return undefined;
	return {
		path: path.slice(0, 512).replaceAll(/[^a-z0-9_.[\]-]/gi, "_"),
		kind: kind.slice(0, 64).replaceAll(/[^a-z0-9_.-]/gi, "_"),
		sourceCount,
		returnedCount,
		omittedCount
	};
}

function withBoundary(source, value, tracker = boundaryTracker()) {
	const bounds = collectionBounds(source, value, tracker);
	const inheritedSource = dataProperty(source, "boundaryOmissions", tracker, "boundaryOmissions");
	const inherited = arrayValues(inheritedSource, tracker, "boundaryOmissions", 0, MAX_BOUNDARY_OMISSIONS);
	const rebuiltInherited = inherited.values
		.map((entry, index) => boundaryDetail(entry, tracker, index))
		.filter((entry) => entry !== undefined);
	const sourceOverflow = dataProperty(source, "boundaryOmissionOverflow", tracker, "boundaryOmissionOverflow");
	const inheritedTruncated = dataProperty(source, "boundaryTruncated", tracker, "boundaryTruncated") === true;
	const reduced = dataProperty(value, "reduced", tracker, "reduced") === true;
	const inheritedOverflow = Number.isSafeInteger(sourceOverflow) && sourceOverflow >= 0 ? sourceOverflow : 0;
	const boundaryOmissions = [...rebuiltInherited, ...tracker.details].slice(0, MAX_BOUNDARY_OMISSIONS);
	const boundaryOmissionOverflow = safeAdd(
		safeAdd(inheritedOverflow, Math.max(0, inherited.sourceCount - rebuiltInherited.length)),
		safeAdd(tracker.unreported, Math.max(0, rebuiltInherited.length + tracker.details.length - MAX_BOUNDARY_OMISSIONS))
	);
	const boundaryTruncated = inheritedTruncated
		|| reduced
		|| Object.values(bounds).some((entry) => entry.omittedCount > 0)
		|| boundaryOmissions.length > 0
		|| boundaryOmissionOverflow > 0;
	return {
		...value,
		collectionBounds: bounds,
		boundaryOmissions,
		boundaryOmissionOverflow,
		boundaryTruncated
	};
}

function withCloneBoundary(value, tracker) {
	if (!tracker.truncated && tracker.unreported === 0) return value;
	const boundary = {
		boundaryOmissions: tracker.details,
		boundaryOmissionOverflow: tracker.unreported,
		boundaryTruncated: tracker.truncated || tracker.unreported > 0
	};
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { value, ...boundary };
	}
	return { ...value, ...boundary };
}

function clonePublicObject(value, arrayLimit, path) {
	const tracker = boundaryTracker();
	const cloned = boundedClone(value, 0, arrayLimit, tracker, path, cloneBudget());
	const publicClone = cloned === OMITTED ? null : cloned;
	return withCloneBoundary(publicClone, tracker);
}

function coreView(source, tracker, budget) {
	const version = dataProperty(source, "version", tracker, "version");
	const generatedAt = dataProperty(source, "generatedAt", tracker, "generatedAt");
	const site = dataProperty(source, "site", tracker, "site");
	const lastSweepAt = dataProperty(source, "lastSweepAt", tracker, "lastSweepAt");
	return {
		version: boundedText(version, 64, tracker, "version", "unknown"),
		generatedAt: typeof generatedAt === "number" && Number.isFinite(generatedAt) ? generatedAt : Date.now(),
		timeZone: boundedCloneOr(dataProperty(source, "timeZone", tracker, "timeZone") ?? {}, 128, tracker, "timeZone", budget, {}),
		range: boundedCloneOr(dataProperty(source, "range", tracker, "range") ?? {}, 128, tracker, "range", budget, {}),
		...(typeof site === "string" ? { site: boundedText(site, 256, tracker, "site") } : {}),
		totals: boundedCloneOr(dataProperty(source, "totals", tracker, "totals") ?? {}, 128, tracker, "totals", budget, {}),
		windows: boundedCloneOr(dataProperty(source, "windows", tracker, "windows") ?? {}, 128, tracker, "windows", budget, {}),
		lastSweepAt: typeof lastSweepAt === "number" && Number.isFinite(lastSweepAt) ? lastSweepAt : undefined,
		diagnostics: boundedCloneOr(dataProperty(source, "diagnostics", tracker, "diagnostics") ?? {}, 128, tracker, "diagnostics", budget, {})
	};
}

function viewAttempt(source, limits, options = {}) {
	const tracker = boundaryTracker();
	const budget = cloneBudget();
	if (options.rootRejected === true) omission(tracker, "value", "proxy", 1, 0);
	const includePriced = options.includePriced !== false;
	const priced = dataProperty(source, "priced", tracker, "priced");
	if (!includePriced && priced !== null && priced !== undefined) {
		omission(tracker, "priced", "value", 1, 0);
	}
	const value = {
		...coreView(source, tracker, budget),
		days: rows(dataProperty(source, "days", tracker, "days"), limits.days, tracker, "days", budget),
		activity: rows(dataProperty(source, "activity", tracker, "activity"), limits.activity, tracker, "activity", budget),
		activityModels: rows(dataProperty(source, "activityModels", tracker, "activityModels"), limits.activityModels, tracker, "activityModels", budget),
		models: rows(dataProperty(source, "models", tracker, "models"), limits.models, tracker, "models", budget),
		sites: rows(dataProperty(source, "sites", tracker, "sites"), limits.sites, tracker, "sites", budget),
		projects: rows(dataProperty(source, "projects", tracker, "projects"), limits.projects, tracker, "projects", budget),
		providers: rows(dataProperty(source, "providers", tracker, "providers"), limits.providers, tracker, "providers", budget),
		directory: rows(dataProperty(source, "directory", tracker, "directory"), limits.directory, tracker, "directory", budget),
		accounts: rows(dataProperty(source, "accounts", tracker, "accounts"), limits.accounts, tracker, "accounts", budget),
		priced: includePriced ? (priced === null ? null : boundedCloneOr(priced ?? null, limits.pricedRows, tracker, "priced", budget, null)) : null,
		...(options.reduced === true ? { reduced: true } : {})
	};
	return withBoundary(source, value, tracker);
}

/**
 * Clone and bound the complete usage payload used by Web and future renderers.
 *
 * @param {object} input output of `usagePayload()`.
 * @returns {object} deeply frozen renderer-neutral view.
 */
export function createTokenLedgerView(input) {
	const rootRejected = input !== null && typeof input === "object" && isProxy(input);
	const source = input !== null && typeof input === "object" && !rootRejected ? input : {};
	let view = viewAttempt(source, COLLECTION_LIMITS, { rootRejected });
	if (bytes(view) > TOKEN_LEDGER_VIEW_MAX_BYTES) {
		view = viewAttempt(source, {
			...COLLECTION_LIMITS,
			activityModels: 512,
			models: 128,
			projects: 128,
			providers: 128
		}, { reduced: true, rootRejected });
	}
	if (bytes(view) > TOKEN_LEDGER_VIEW_MAX_BYTES) {
		view = viewAttempt(source, {
			days: 90,
			activity: 90,
			activityModels: 0,
			models: 64,
			sites: 64,
			projects: 64,
			providers: 64,
			directory: 64,
			accounts: 64,
			pricedRows: 0
		}, { includePriced: false, reduced: true, rootRejected });
	}
	if (bytes(view) > TOKEN_LEDGER_VIEW_MAX_BYTES) {
		throw new TokenLedgerError("VIEW_TOO_LARGE", "tokenledger usage view exceeded its serialized size limit");
	}
	return deepFreeze(view);
}

function snapshotFingerprint(snapshot) {
	const { revision: _revision, capturedAt: _capturedAt, ...content } = snapshot;
	return JSON.stringify(content);
}

/**
 * Project a complete usage view into the compact replayed service snapshot.
 *
 * @param {object} input output of `usagePayload()`.
 * @param {number} revision monotonic service revision.
 * @returns {object} deeply frozen summary.
 */
export function createTokenLedgerSummary(input, revision) {
	const view = createTokenLedgerView(input);
	let summary = {
		revision,
		capturedAt: view.generatedAt,
		version: view.version,
		timeZone: view.timeZone,
		totals: {
			selected: view.totals,
			today: view.windows.today ?? {},
			month: view.windows.month ?? {},
			all: view.windows.all ?? {}
		},
		activity: view.activity.slice(-371),
		models: view.models.slice(0, 64),
		sites: view.sites.slice(0, 64),
		projects: view.projects.slice(0, 64),
		providers: view.providers.slice(0, 64),
		directory: view.directory.slice(0, 64),
		accounts: view.accounts.slice(0, 64),
		diagnostics: view.diagnostics,
		priced: view.priced,
		freshness: view.lastSweepAt === undefined ? {} : { lastSweepAt: view.lastSweepAt }
	};
	summary = withBoundary(view, summary);
	if (bytes(summary) > TOKEN_LEDGER_SUMMARY_MAX_BYTES) {
		summary = withBoundary(view, {
			...summary,
			activity: summary.activity.slice(-90),
			models: summary.models.slice(0, 32),
			projects: summary.projects.slice(0, 32),
			providers: summary.providers.slice(0, 32),
			priced: null,
			reduced: true
		});
	}
	if (bytes(summary) > TOKEN_LEDGER_SUMMARY_MAX_BYTES) {
		summary = withBoundary(view, {
			revision,
			capturedAt: view.generatedAt,
			version: view.version,
			timeZone: view.timeZone,
			totals: summary.totals,
			activity: [],
			models: [],
			sites: summary.sites.slice(0, 16),
			projects: [],
			providers: [],
			directory: [],
			accounts: [],
			diagnostics: summary.diagnostics,
			priced: null,
			freshness: summary.freshness,
			reduced: true
		});
	}
	if (bytes(summary) > TOKEN_LEDGER_SUMMARY_MAX_BYTES) {
		throw new TokenLedgerError("SUMMARY_TOO_LARGE", "tokenledger summary exceeded its serialized size limit");
	}
	return deepFreeze(summary);
}

function requestIdOf(request) {
	const requestId = dataProperty(request, "requestId");
	const id = typeof requestId === "string" ? requestId.trim() : "";
	if (id.length === 0 || id.length > 128) {
		throw new TokenLedgerError("INVALID_REQUEST", "requestId must contain 1-128 characters");
	}
	return id;
}

function signalOf(options) {
	const signal = dataProperty(options, "signal");
	if (signal === undefined || signal === null || typeof signal !== "object" || isProxy(signal)) return undefined;
	try {
		return signal instanceof AbortSignal ? signal : undefined;
	} catch {
		return undefined;
	}
}

function throwIfAborted(signal, requestId) {
	if (signal?.aborted === true) {
		throw new TokenLedgerError("ABORTED", "tokenledger request was aborted", { requestId });
	}
}

function queryOf(request) {
	const requestedRange = dataProperty(request, "range");
	const source = requestedRange !== null && typeof requestedRange === "object" && !isProxy(requestedRange) ? requestedRange : {};
	const date = /^\d{4}-\d{2}-\d{2}$/;
	const range = {};
	const from = dataProperty(source, "from");
	const to = dataProperty(source, "to");
	if (typeof from === "string" && date.test(from)) range.from = from;
	if (typeof to === "string" && date.test(to)) range.to = to;
	const requestedSite = dataProperty(request, "site");
	const site = typeof requestedSite === "string" && requestedSite.trim() !== ""
		? requestedSite.trim().slice(0, 256)
		: undefined;
	return { range, site };
}

function expectedRevisionOf(request, requestId) {
	const expectedRevision = dataProperty(request, "expectedRevision");
	if (
		expectedRevision !== undefined &&
		(!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
	) {
		throw new TokenLedgerError("INVALID_REQUEST", "expectedRevision must be a positive safe integer", { requestId });
	}
	return expectedRevision;
}

function collectionRequestOf(request, requestId) {
	const requestedCollection = dataProperty(request, "collection");
	const collection = typeof requestedCollection === "string" ? requestedCollection : "";
	if (!COLLECTION_NAMES.has(collection)) {
		throw new TokenLedgerError("INVALID_REQUEST", "unknown tokenledger collection", { requestId });
	}
	const requestedOffset = dataProperty(request, "offset");
	const requestedLimit = dataProperty(request, "limit");
	const offset = requestedOffset === undefined ? 0 : requestedOffset;
	const limit = requestedLimit === undefined ? 64 : requestedLimit;
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new TokenLedgerError("INVALID_REQUEST", "offset must be a non-negative safe integer", { requestId });
	}
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > TOKEN_LEDGER_COLLECTION_PAGE_MAX) {
		throw new TokenLedgerError(
			"INVALID_REQUEST",
			`limit must contain 1-${String(TOKEN_LEDGER_COLLECTION_PAGE_MAX)} rows`,
			{ requestId }
		);
	}
	const requestedDay = dataProperty(request, "day");
	const day = collection === "activityModels" && typeof requestedDay === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(requestedDay)
		? requestedDay
		: undefined;
	if (requestedDay !== undefined && day === undefined) {
		throw new TokenLedgerError("INVALID_REQUEST", "day is valid only for activityModels and must use YYYY-MM-DD", { requestId });
	}
	const requestedSort = dataProperty(request, "sortBy");
	const sortBy = typeof requestedSort === "string" && COLLECTION_SORTS[collection].has(requestedSort)
		? requestedSort
		: undefined;
	if (requestedSort !== undefined && sortBy === undefined) {
		throw new TokenLedgerError("INVALID_REQUEST", "sortBy is not supported for this collection", { requestId });
	}
	const requestedDirection = dataProperty(request, "direction");
	const direction = requestedDirection === "asc" ? "asc" : "desc";
	if (requestedDirection !== undefined && requestedDirection !== "asc" && requestedDirection !== "desc") {
		throw new TokenLedgerError("INVALID_REQUEST", "direction must be asc or desc", { requestId });
	}
	return { collection, offset, limit, day, sortBy, direction };
}

function sortableValue(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return typeof value === "string" ? value : "";
}

function compareValues(left, right) {
	if (typeof left === "number" && typeof right === "number") return left - right;
	return String(left).localeCompare(String(right));
}

function collectionPrices(source, parsed, tracker, requestId) {
	if (parsed.collection !== "models") return undefined;
	return new Map(collectionSource(source, "pricedRows", tracker, requestId).map((entry, index) => [
		dataProperty(entry, "model", tracker, `priced.rows[${String(index)}].model`),
		entry
	]));
}

function collectionEntry(value, index, parsed, prices, tracker) {
	return {
		value,
		index,
		pricing: parsed.collection === "models"
			? prices?.get(dataProperty(value, "model", tracker, `models[${String(index)}].model`))
			: undefined
	};
}

function sortCollectionEntries(entries, parsed, tracker) {
	if (parsed.sortBy === undefined) return;
	entries.sort((left, right) => {
		const leftValue = parsed.sortBy === "cost"
			? dataProperty(left.pricing, "cost", tracker, `priced.rows[${String(left.index)}].cost`)
			: dataProperty(left.value, parsed.sortBy, tracker, `${parsed.collection}[${String(left.index)}].${parsed.sortBy}`);
		const rightValue = parsed.sortBy === "cost"
			? dataProperty(right.pricing, "cost", tracker, `priced.rows[${String(right.index)}].cost`)
			: dataProperty(right.value, parsed.sortBy, tracker, `${parsed.collection}[${String(right.index)}].${parsed.sortBy}`);
		const compared = compareValues(sortableValue(leftValue), sortableValue(rightValue));
		return (parsed.direction === "asc" ? compared : -compared) || left.index - right.index;
	});
}

function collectionSelection(source, parsed, tracker, requestId) {
	const primary = collectionArray(source, parsed.collection, tracker);
	const declaredCount = arrayLength(primary.value, tracker, primary.path) ?? 0;
	const prices = collectionPrices(source, parsed, tracker, requestId);
	const fullScan = parsed.sortBy !== undefined || (parsed.collection === "activityModels" && parsed.day !== undefined);
	if (!fullScan) {
		return {
			sourceCount: declaredCount,
			page(offset, limit) {
				return arrayValues(primary.value, tracker, primary.path, offset, limit).values
					.map((value, index) => collectionEntry(value, offset + index, parsed, prices, tracker));
			}
		};
	}
	if (declaredCount > COLLECTION_SCAN_MAX) {
		throw new TokenLedgerError("VIEW_TOO_LARGE", "tokenledger collection source exceeded its safe scan limit", {
			requestId
		});
	}
	let entries = arrayValues(primary.value, tracker, primary.path, 0, declaredCount).values
		.map((value, index) => collectionEntry(value, index, parsed, prices, tracker));
	if (parsed.collection === "activityModels" && parsed.day !== undefined) {
		entries = entries.filter((entry) => (
			dataProperty(entry.value, "day", tracker, `activityModels[${String(entry.index)}].day`) === parsed.day
		));
	}
	sortCollectionEntries(entries, parsed, tracker);
	return {
		sourceCount: entries.length,
		page(offset, limit) {
			return entries.slice(offset, offset + limit);
		}
	};
}

function collectionItem(entry, parsed, source, tracker, path, budget) {
	const value = boundedClone(entry.value, 0, 128, tracker, path, budget);
	if (value === OMITTED) return OMITTED;
	if (
		budget.exhausted
		|| parsed.collection !== "models"
		|| value === null
		|| typeof value !== "object"
		|| Array.isArray(value)
		|| entry.pricing === undefined
	) return value;
	const pricing = boundedClone(entry.pricing, 0, 128, tracker, `${path}.pricing`, budget);
	if (pricing === OMITTED || pricing === null || typeof pricing !== "object" || Array.isArray(pricing)) return value;
	const priced = dataProperty(source, "priced", tracker, "priced");
	const currency = dataProperty(priced, "currency", tracker, "priced.currency");
	const inheritedCurrency = dataProperty(pricing, "currency");
	const publicCurrency = inheritedCurrency === undefined && typeof currency === "string" && !budget.exhausted
		? boundedText(currency, 32, tracker, "priced.currency", "", budget)
		: undefined;
	return {
		...value,
		pricing: {
			...pricing,
			...(publicCurrency === undefined ? {} : { currency: publicCurrency })
		}
	};
}

/**
 * Clone one stable continuation page without presenting omitted rows as a
 * complete collection.
 *
 * @param {object} input output of `usagePayload()`.
 * @param {{ collection: string, offset?: number, limit?: number, day?: string, requestId?: string }} request page request.
 * @returns {object} deeply frozen page with explicit source/returned counts.
 */
export function createTokenLedgerCollectionPage(input, request) {
	const rootRejected = input !== null && typeof input === "object" && isProxy(input);
	const source = input !== null && typeof input === "object" && !rootRejected ? input : {};
	const requestedId = dataProperty(request, "requestId");
	const parsed = collectionRequestOf(request, typeof requestedId === "string" ? requestedId : undefined);
	const sourceTracker = boundaryTracker();
	if (rootRejected) omission(sourceTracker, "value", "proxy", 1, 0);
	const selection = collectionSelection(
		source,
		parsed,
		sourceTracker,
		typeof requestedId === "string" ? requestedId : undefined
	);
	const sourceCount = selection.sourceCount;
	const offset = Math.min(parsed.offset, sourceCount);
	const available = Math.min(parsed.limit, Math.max(0, sourceCount - offset));
	const candidates = selection.page(offset, available);
	let take = available;
	while (true) {
		const tracker = copyBoundaryTracker(sourceTracker);
		const budget = cloneBudget();
		const items = [];
		for (let index = 0; index < take; index += 1) {
			const item = collectionItem(
				candidates[index],
				parsed,
				source,
				tracker,
				`${parsed.collection}[${String(offset + index)}]`,
				budget
			);
			if (item === OMITTED) break;
			items.push(item);
			if (budget.exhausted) break;
		}
		const returnedCount = items.length;
		if (take > 0 && returnedCount === 0) {
			throw new TokenLedgerError("VIEW_TOO_LARGE", "tokenledger collection row exceeded its structural limit", {
				requestId: typeof requestedId === "string" ? requestedId : undefined
			});
		}
		const nextOffset = offset + returnedCount < sourceCount ? offset + returnedCount : undefined;
		const page = {
			collection: parsed.collection,
			...(parsed.day === undefined ? {} : { day: parsed.day }),
			...(parsed.sortBy === undefined ? {} : { sortBy: parsed.sortBy, direction: parsed.direction }),
			offset,
			requestedLimit: parsed.limit,
			sourceCount,
			returnedCount,
			omittedCount: Math.max(0, sourceCount - returnedCount),
			omittedBefore: offset,
			omittedAfter: Math.max(0, sourceCount - offset - returnedCount),
			...(nextOffset === undefined ? {} : { nextOffset }),
			items,
			boundaryOmissions: tracker.details,
			boundaryOmissionOverflow: tracker.unreported,
			boundaryTruncated: tracker.truncated || tracker.unreported > 0,
			...(returnedCount < available ? { reduced: true } : {})
		};
		if (!budget.exhausted && bytes(page) <= TOKEN_LEDGER_COLLECTION_MAX_BYTES) return deepFreeze(page);
		if (take <= 1) {
			throw new TokenLedgerError("VIEW_TOO_LARGE", "tokenledger collection row exceeded its structural or serialized size limit", {
				requestId: typeof requestedId === "string" ? requestedId : undefined
			});
		}
		take = Math.max(1, Math.floor(take / 2));
	}
}

function exportData(value) {
	if (value === null || typeof value !== "object" || isProxy(value)) {
		throw new TokenLedgerError("INTERNAL", "tokenledger export returned an invalid result");
	}
	const source = value;
	const rawContent = dataProperty(source, "content");
	if (typeof rawContent !== "string") {
		throw new TokenLedgerError("INTERNAL", "tokenledger export returned no content");
	}
	const content = rawContent;
	if (Buffer.byteLength(content, "utf8") > TOKEN_LEDGER_EXPORT_MAX_BYTES) {
		throw new TokenLedgerError("RESULT_TOO_LARGE", "tokenledger export exceeded its serialized size limit");
	}
	return deepFreeze({
		format: dataProperty(source, "format") === "csv" ? "csv" : "json",
		content,
		...(typeof dataProperty(source, "fileName") === "string" ? { fileName: dataProperty(source, "fileName").slice(0, 256) } : {}),
		...(typeof dataProperty(source, "mimeType") === "string" ? { mimeType: dataProperty(source, "mimeType").slice(0, 128) } : {})
	});
}

function actionData(type, value) {
	if (value === undefined) return undefined;
	if (type === "usage.export") return exportData(value);
	return deepFreeze(clonePublicObject(value, 128, "action"));
}

function cloneAction(value, requestId) {
	let action;
	try {
		assertStructuredInput(value, 0, new WeakSet(), {
			nodes: 0,
			keys: 0,
			textBytes: 0,
			arrayLength: 0
		});
		action = structuredClone(value);
		if (bytes(action) > TOKEN_LEDGER_ACTION_MAX_BYTES) throw new Error("too-large");
	} catch (error) {
		throw new TokenLedgerError("INVALID_REQUEST", "tokenledger action must be structured data within its size limit", {
			requestId,
			cause: error
		});
	}
	return deepFreeze(action);
}

function consumeStructuredText(value, budget) {
	const remaining = TOKEN_LEDGER_ACTION_MAX_BYTES - budget.textBytes;
	if (remaining < 0 || value.length > remaining) throw new TypeError("structured input text budget exceeded");
	const textBytes = Buffer.byteLength(value, "utf8");
	if (textBytes > remaining) throw new TypeError("structured input text budget exceeded");
	budget.textBytes += textBytes;
}

function assertStructuredInput(value, depth, seen, budget) {
	budget.nodes += 1;
	if (budget.nodes > ACTION_NODE_MAX) throw new TypeError("structured input node budget exceeded");
	if (value === null || value === undefined || typeof value === "boolean") return;
	if (typeof value === "string") {
		consumeStructuredText(value, budget);
		return;
	}
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (typeof value !== "object" || depth >= 16 || isProxy(value)) throw new TypeError("unsafe structured input");
	if (seen.has(value)) return;
	seen.add(value);
	const prototype = Object.getPrototypeOf(value);
	const array = Array.isArray(value);
	if ((array && prototype !== Array.prototype) || (!array && prototype !== null && prototype !== Object.prototype)) {
		throw new TypeError("unsafe structured input prototype");
	}
	if (array) {
		const length = arrayLength(value, undefined, "action");
		if (length === undefined || length > ACTION_ARRAY_LENGTH_MAX - budget.arrayLength) {
			throw new TypeError("structured input array length budget exceeded");
		}
		budget.arrayLength += length;
	}
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		budget.keys += 1;
		if (budget.keys > ACTION_KEY_MAX) throw new TypeError("structured input key budget exceeded");
		consumeStructuredText(key, budget);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !descriptor.enumerable) continue;
		if (!("value" in descriptor)) throw new TypeError("structured input accessors are not allowed");
		assertStructuredInput(descriptor.value, depth + 1, seen, budget);
	}
}

/**
 * Public `ctx.tokenLedgerV1` service.
 *
 * The implementation is host-private. It supplies the existing canonical
 * aggregation and domain actions; this class owns public bounds, immutability,
 * revisioning, cancellation, supersede behavior, and unload fencing.
 */
export class TokenLedgerService {
	#implementation;
	#closed = false;
	#revision = 0;
	#generation = 0;
	#snapshot = null;
	#snapshotFingerprint = null;
	#listeners = new Set();
	#requests = new Map();
	#pending = new Set();
	#actionTail = Promise.resolve();
	#lifetime = new AbortController();

	/**
	 * @param {object} implementation host-private domain implementation.
	 */
	constructor(implementation) {
		if (implementation === null || typeof implementation !== "object") {
			throw new TypeError("TokenLedgerService requires an implementation");
		}
		if (typeof implementation.readUsage !== "function" || typeof implementation.runAction !== "function") {
			throw new TypeError("TokenLedgerService implementation is missing readUsage or runAction");
		}
		this.#implementation = implementation;
		const initial = implementation.readUsage({ range: {}, site: undefined });
		if (isPromise(initial)) {
			throw new TypeError("TokenLedgerService initial readUsage must be synchronous");
		}
		this.#publish(initial, true);
	}

	/** Latest bounded summary. */
	current() {
		return this.#snapshot;
	}

	/**
	 * Observe summary revisions. The current snapshot is replayed immediately.
	 *
	 * @param {(snapshot: object) => void} listener observer.
	 * @param {{ signal?: AbortSignal }} [options] observer lifetime.
	 * @returns {() => void} disposer.
	 */
	subscribe(listener, options = {}) {
		if (typeof listener !== "function") throw new TypeError("tokenledger subscriber must be a function");
		this.#assertActive();
		this.#listeners.add(listener);
		try {
			listener(this.#snapshot);
		} catch {
			// A consumer failure must not break domain collection.
		}
		const signal = signalOf(options);
		const dispose = () => {
			this.#listeners.delete(listener);
			signal?.removeEventListener("abort", dispose);
		};
		if (signal?.aborted === true) dispose();
		else signal?.addEventListener("abort", dispose, { once: true });
		return dispose;
	}

	/** Read and, when changed, publish the current bounded summary. */
	getSummary(request, options = {}) {
		const requestId = requestIdOf(request);
		return this.#withRequest(requestId, signalOf(options), async (signal) => {
			const generation = this.#generation;
			const revision = this.#revision;
			const pending = this.#implementation.readUsage({ range: {}, site: undefined }, { signal });
			const view = isPromise(pending) ? await pending : pending;
			throwIfAborted(signal, requestId);
			if (generation !== this.#generation || revision !== this.#revision) {
				throw new TokenLedgerError("STALE", "tokenledger changed while the summary was loading", { requestId });
			}
			return this.#publish(view);
		});
	}

	/** Read one bounded range/site view without mutating the replayed summary. */
	queryUsage(request, options = {}) {
		const requestId = requestIdOf(request);
		const query = queryOf(request);
		return this.#withRequest(requestId, signalOf(options), async (signal) => {
			const generation = this.#generation;
			const revision = this.#revision;
			const pending = this.#implementation.readUsage(query, { signal });
			const view = isPromise(pending) ? await pending : pending;
			throwIfAborted(signal, requestId);
			if (generation !== this.#generation || revision !== this.#revision) {
				throw new TokenLedgerError("STALE", "tokenledger changed while the usage view was loading", { requestId });
			}
			return deepFreeze({ revision, value: createTokenLedgerView(view) });
		});
	}

	/** Read one complete collection through explicit bounded continuation pages. */
	queryCollection(request, options = {}) {
		const requestId = requestIdOf(request);
		const query = queryOf(request);
		const page = collectionRequestOf(request, requestId);
		const expectedRevision = expectedRevisionOf(request, requestId);
		return this.#withRequest(requestId, signalOf(options), async (signal) => {
			const generation = this.#generation;
			const revision = this.#revision;
			if (expectedRevision !== undefined && expectedRevision !== revision) {
				throw new TokenLedgerError(
					"STALE",
					`expected revision ${String(expectedRevision)}, current revision is ${String(revision)}`,
					{ requestId }
				);
			}
			const pending = this.#implementation.readUsage(query, { signal });
			const view = isPromise(pending) ? await pending : pending;
			throwIfAborted(signal, requestId);
			if (generation !== this.#generation || revision !== this.#revision) {
				throw new TokenLedgerError("STALE", "tokenledger changed while the collection page was loading", { requestId });
			}
			return deepFreeze({
				revision,
				value: createTokenLedgerCollectionPage(view, { requestId, ...page })
			});
		});
	}

	/** Read the sanitized renderer-neutral configuration view. */
	getConfiguration(request, options = {}) {
		const requestId = requestIdOf(request);
		return this.#withRequest(requestId, signalOf(options), async (signal) => {
			if (typeof this.#implementation.readConfiguration !== "function") {
				throw new TokenLedgerError("UNAVAILABLE", "tokenledger configuration is unavailable", { requestId });
			}
			const generation = this.#generation;
			const revision = this.#revision;
			const pending = this.#implementation.readConfiguration({ signal });
			const value = isPromise(pending) ? await pending : pending;
			throwIfAborted(signal, requestId);
			if (generation !== this.#generation || revision !== this.#revision) {
				throw new TokenLedgerError("STALE", "tokenledger changed while configuration was loading", { requestId });
			}
			return deepFreeze({ revision, value: clonePublicObject(value, 128, "configuration") });
		});
	}

	/** Execute one structured domain action. */
	execute(request, options = {}) {
		const requestId = requestIdOf(request);
		const action = cloneAction(dataProperty(request, "action"), requestId);
		const type = action?.type;
		const expectedRevision = expectedRevisionOf(request, requestId);
		if (!ACTION_TYPES.has(type)) {
			throw new TokenLedgerError("INVALID_REQUEST", "unknown tokenledger action type", { requestId });
		}
		return this.#withRequest(requestId, signalOf(options), async (signal, markCommitted) => {
			let release;
			const previous = this.#actionTail;
			this.#actionTail = new Promise((resolve) => {
				release = resolve;
			});
			await previous.catch(() => {});
			try {
				this.#assertActive(requestId);
				throwIfAborted(signal, requestId);
					if (expectedRevision !== undefined && expectedRevision !== this.#revision) {
					throw new TokenLedgerError(
						"STALE",
						`expected revision ${String(expectedRevision)}, current revision is ${String(this.#revision)}`,
						{ requestId }
					);
					}
					const revision = this.#revision;
					const generation = ++this.#generation;
				let committed = false;
				const commit = (mutation) => {
					this.#assertActive(requestId);
					if (generation !== this.#generation) {
						throw new TokenLedgerError("STALE", "tokenledger action was superseded before commit", { requestId });
					}
					markCommitted(mutation);
					committed = true;
				};
					const pending = this.#implementation.runAction(action, {
						signal,
					lifetimeSignal: this.#lifetime.signal,
					requestId,
						commit
					});
					const result = isPromise(pending) ? await pending : pending;
					if (generation !== this.#generation) {
						throw new TokenLedgerError("STALE", "tokenledger action result was superseded", { requestId });
					}
					if (!committed && revision !== this.#revision) {
						throw new TokenLedgerError("STALE", "tokenledger changed while the action was running", { requestId });
					}
					if (result === null || typeof result !== "object" || isProxy(result)) {
						throw new TokenLedgerError("INTERNAL", "tokenledger action returned an invalid result", { requestId });
					}
					const ok = dataProperty(result, "ok");
					const changed = dataProperty(result, "changed");
					if ((ok !== undefined && typeof ok !== "boolean") || (changed !== undefined && typeof changed !== "boolean")) {
						throw new TokenLedgerError("INTERNAL", "tokenledger action returned an invalid result", { requestId });
					}
					if (changed && !committed) {
						throwIfAborted(signal, requestId);
						commit();
					}
					let snapshot = this.#snapshot;
					if (changed) {
						const suppliedView = dataProperty(result, "view");
						const pendingView = suppliedView ?? this.#implementation.readUsage({ range: {}, site: undefined }, { signal: this.#lifetime.signal });
						const view = isPromise(pendingView) ? await pendingView : pendingView;
						this.#assertActive(requestId);
						if (generation !== this.#generation) {
							throw new TokenLedgerError("STALE", "tokenledger changed while the action snapshot was loading", { requestId });
						}
						snapshot = this.#publish(view, true);
				}
				return deepFreeze({
					requestId,
					revision: snapshot.revision,
						status: ok === false ? "rejected" : "applied",
						message: typeof dataProperty(result, "message") === "string" ? dataProperty(result, "message").slice(0, 2048) : "",
						...(dataProperty(result, "data") === undefined ? {} : { data: actionData(type, dataProperty(result, "data")) }),
					snapshot
				});
			} finally {
				release();
			}
		});
	}

	/**
	 * Publish a synchronous host-owned change, such as a settings watch.
	 *
	 * @param {boolean} [force] publish even when the usage summary is unchanged.
	 */
	notifyChanged(force = false) {
		if (this.#closed) return this.#snapshot;
		try {
			return this.#publish(this.#implementation.readUsage({ range: {}, site: undefined }), force === true);
		} catch {
			return this.#snapshot;
		}
	}

	/** Abort requests, fence late continuations, and await owned work. */
	async dispose() {
		if (this.#closed) return;
		this.#closed = true;
		this.#generation += 1;
		this.#lifetime.abort();
		for (const entry of this.#requests.values()) entry.controller.abort();
		this.#requests.clear();
		this.#listeners.clear();
		const pendingDispose = this.#implementation.dispose?.();
		if (isPromise(pendingDispose)) await pendingDispose;
		// AbortSignal is cooperative. A host implementation that ignores it must
		// not hold the Cordis Fiber open forever; generation/closed checks fence
		// every continuation when that operation eventually settles.
		this.#pending.clear();
	}

	#publish(input, force = false) {
		this.#assertActive();
		const next = createTokenLedgerSummary(input, this.#revision + 1);
		const fingerprint = snapshotFingerprint(next);
		if (!force && this.#snapshot !== null && fingerprint === this.#snapshotFingerprint) return this.#snapshot;
		this.#revision += 1;
		this.#snapshot = next;
		this.#snapshotFingerprint = fingerprint;
		const listeners = [...this.#listeners];
		for (const listener of listeners) {
			try {
				listener(next);
			} catch {
				// Subscriber errors remain consumer-local.
			}
		}
		return next;
	}

	async #withRequest(requestId, signal, callback) {
		this.#assertActive(requestId);
		const previous = this.#requests.get(requestId);
		if (previous !== undefined) {
			previous.superseded = true;
			previous.controller.abort();
		}
		const controller = new AbortController();
		const token = Symbol(requestId);
		const entry = { controller, token, superseded: false };
		let committed = false;
		let rejectStopped;
		const stopped = new Promise((_resolve, reject) => {
			rejectStopped = reject;
		});
		const onStopped = () => {
			if (committed) return;
			rejectStopped(new TokenLedgerError("ABORTED", "tokenledger request was aborted", { requestId }));
		};
		controller.signal.addEventListener("abort", onStopped, { once: true });
		let settlePending;
		const pending = new Promise((resolve) => {
			settlePending = resolve;
		});
		this.#pending.add(pending);
		const markCommitted = (mutation) => {
			this.#assertActive(requestId);
			throwIfAborted(controller.signal, requestId);
			if (this.#requests.get(requestId)?.token !== token) {
				throw new TokenLedgerError("STALE", "tokenledger request was superseded before commit", { requestId });
			}
			if (typeof mutation === "function") mutation();
			committed = true;
		};
		const onAbort = () => controller.abort(signal?.reason);
		if (signal?.aborted === true) controller.abort(signal.reason);
		else signal?.addEventListener("abort", onAbort, { once: true });
		this.#requests.set(requestId, entry);
		try {
			const operation = Promise.resolve().then(() => {
				throwIfAborted(controller.signal, requestId);
				return callback(controller.signal, markCommitted);
			});
			const value = await Promise.race([operation, stopped]);
			if (!committed) {
				if (this.#requests.get(requestId)?.token !== token) {
					throw new TokenLedgerError("STALE", "tokenledger request was superseded", { requestId });
				}
				throwIfAborted(controller.signal, requestId);
			}
			return value;
		} catch (error) {
			if (entry.superseded) {
				throw new TokenLedgerError("STALE", "tokenledger request was superseded", { requestId, cause: error });
			}
			if (error instanceof TokenLedgerError) throw error;
			if (!committed && controller.signal.aborted) {
				throw new TokenLedgerError("ABORTED", "tokenledger request was aborted", { requestId, cause: error });
			}
			throw new TokenLedgerError("INTERNAL", "tokenledger request failed", { requestId, cause: error });
		} finally {
			controller.signal.removeEventListener("abort", onStopped);
			signal?.removeEventListener("abort", onAbort);
			if (this.#requests.get(requestId)?.token === token) this.#requests.delete(requestId);
			settlePending();
			this.#pending.delete(pending);
		}
	}

	#assertActive(requestId) {
		if (this.#closed) {
			throw new TokenLedgerError("UNAVAILABLE", "tokenledger service has been disposed", { requestId });
		}
	}
}

export default TokenLedgerService;
