/**
 * Apply-local data controller for TokenLedger's optional Blue renderer.
 *
 * This is deliberately not a Cordis service or package export. Its caller is
 * trusted code in the same plugin Fiber, so it keeps operational bounds and
 * stale/abort fencing without implementing a hostile third-party boundary.
 */

const VIEW_LIMITS = Object.freeze({
	days: 400,
	activity: 371,
	activityModels: 2048,
	models: 256,
	sites: 128,
	projects: 256,
	providers: 256,
	directory: 128,
	accounts: 128
});

const COLLECTIONS = new Set(Object.keys(VIEW_LIMITS));
const SORT_FIELDS = Object.freeze({
	models: new Set(["model", "tokens", "requests", "inputTokens", "cacheReadTokens", "outputTokens", "cost"]),
	sites: new Set(["site", "tokens", "requests"]),
	projects: new Set(["project", "label", "tokens", "requests"]),
	accounts: new Set(["id", "displayName", "origin", "provider"])
});

export class DashboardControllerError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "DashboardControllerError";
		this.code = code;
	}
}

function clone(value, fallback = undefined) {
	try {
		return structuredClone(value);
	} catch {
		return fallback;
	}
}

function rows(value, limit) {
	return Array.isArray(value) ? clone(value.slice(0, limit), []) : [];
}

function bounds(source, name, returnedCount) {
	const sourceCount = Array.isArray(source[name]) ? source[name].length : 0;
	return {
		sourceCount,
		returnedCount,
		omittedCount: Math.max(0, sourceCount - returnedCount)
	};
}

function createView(input) {
	const source = input !== null && typeof input === "object" ? input : {};
	const value = {
		version: typeof source.version === "string" ? source.version : "unknown",
		generatedAt: Number.isFinite(source.generatedAt) ? source.generatedAt : Date.now(),
		timeZone: clone(source.timeZone, {}),
		range: clone(source.range, {}),
		...(typeof source.site === "string" ? { site: source.site } : {}),
		...(typeof source.provider === "string" ? { provider: source.provider } : {}),
		totals: clone(source.totals, {}),
		windows: clone(source.windows, {}),
		days: rows(source.days, VIEW_LIMITS.days),
		activity: rows(source.activity, VIEW_LIMITS.activity),
		activityModels: rows(source.activityModels, VIEW_LIMITS.activityModels),
		models: rows(source.models, VIEW_LIMITS.models),
		sites: rows(source.sites, VIEW_LIMITS.sites),
		projects: rows(source.projects, VIEW_LIMITS.projects),
		providers: rows(source.providers, VIEW_LIMITS.providers),
		directory: rows(source.directory, VIEW_LIMITS.directory),
		accounts: rows(source.accounts, VIEW_LIMITS.accounts),
		priced: clone(source.priced, null),
		lastSweepAt: Number.isFinite(source.lastSweepAt) ? source.lastSweepAt : undefined,
		diagnostics: clone(source.diagnostics, {})
	};
	value.collectionBounds = Object.fromEntries(
		Object.keys(VIEW_LIMITS).map((name) => [name, bounds(source, name, value[name].length)])
	);
	value.boundaryTruncated = Object.values(value.collectionBounds).some((entry) => entry.omittedCount > 0);
	return value;
}

function createSummary(input, revision) {
	const view = createView(input);
	return {
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
		freshness: view.lastSweepAt === undefined ? {} : { lastSweepAt: view.lastSweepAt },
		collectionBounds: view.collectionBounds,
		boundaryTruncated: view.boundaryTruncated
	};
}

function queryOf(request) {
	const source = request?.range;
	const range = {};
	if (typeof source?.from === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(source.from)) range.from = source.from;
	if (typeof source?.to === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(source.to)) range.to = source.to;
	const site = typeof request?.site === "string" && request.site.trim() !== "" ? request.site.trim().slice(0, 256) : undefined;
	const provider = typeof request?.provider === "string" && request.provider.trim() !== "" ? request.provider.trim().slice(0, 256) : undefined;
	return { range, ...(site === undefined ? {} : { site }), ...(provider === undefined ? {} : { provider }) };
}

function sortable(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : String(value ?? "");
}

function compare(left, right) {
	return typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
}

function stopped(signal) {
	if (signal?.aborted) throw new DashboardControllerError("ABORTED", "TokenLedger request was aborted");
}

export class DashboardController {
	#implementation;
	#revision = 0;
	#generation = 0;
	#snapshot;
	#fingerprint = "";
	#listeners = new Set();
	#closed = false;
	#lifetime = new AbortController();

	constructor(implementation) {
		this.#implementation = implementation;
		this.#publish(implementation.readUsage({ range: {} }), true);
	}

	current() {
		this.#active();
		return this.#snapshot;
	}

	subscribe(listener, { signal } = {}) {
		this.#active();
		this.#listeners.add(listener);
		listener(this.#snapshot);
		const dispose = () => this.#listeners.delete(listener);
		if (signal?.aborted) dispose();
		else signal?.addEventListener("abort", dispose, { once: true });
		return dispose;
	}

	async queryUsage(request, { signal } = {}) {
		const generation = this.#generation;
		const revision = this.#revision;
		const value = await this.#implementation.readUsage(queryOf(request), { signal: this.#signal(signal) });
		this.#unchanged(generation, revision, signal);
		return { revision, value: createView(value) };
	}

	async queryCollection(request, { signal } = {}) {
		const collection = request?.collection;
		if (!COLLECTIONS.has(collection)) throw new DashboardControllerError("INVALID_REQUEST", "Unknown dashboard collection");
		const offset = Number.isSafeInteger(request.offset) && request.offset >= 0 ? request.offset : 0;
		const limit = Number.isSafeInteger(request.limit) && request.limit > 0 ? Math.min(request.limit, 128) : 64;
		const generation = this.#generation;
		const revision = this.#revision;
		if (request.expectedRevision !== undefined && request.expectedRevision !== revision) {
			throw new DashboardControllerError("STALE", "Dashboard revision changed");
		}
		const value = await this.#implementation.readUsage(queryOf(request), { signal: this.#signal(signal) });
		this.#unchanged(generation, revision, signal);
		let source = Array.isArray(value?.[collection]) ? [...value[collection]] : [];
		if (collection === "activityModels" && typeof request.day === "string") {
			source = source.filter((entry) => entry?.day === request.day);
		}
		const sortBy = SORT_FIELDS[collection]?.has(request.sortBy) ? request.sortBy : undefined;
		if (sortBy !== undefined) {
			const priced = new Map((value?.priced?.rows ?? []).map((entry) => [entry.model, entry]));
			source = source.map((entry, index) => ({ entry, index, pricing: collection === "models" ? priced.get(entry?.model) : undefined }));
			source.sort((left, right) => {
				const leftValue = sortBy === "cost" ? left.pricing?.cost : left.entry?.[sortBy];
				const rightValue = sortBy === "cost" ? right.pricing?.cost : right.entry?.[sortBy];
				const ordered = compare(sortable(leftValue), sortable(rightValue));
				return (request.direction === "asc" ? ordered : -ordered) || left.index - right.index;
			});
			source = source.map(({ entry, pricing }) => pricing === undefined ? entry : { ...entry, pricing: clone(pricing, {}) });
		}
		const start = Math.min(offset, source.length);
		const items = clone(source.slice(start, start + limit), []);
		return {
			revision,
			value: {
				collection,
				...(typeof request.day === "string" ? { day: request.day } : {}),
				...(sortBy === undefined ? {} : { sortBy, direction: request.direction === "asc" ? "asc" : "desc" }),
				offset: start,
				requestedLimit: limit,
				sourceCount: source.length,
				returnedCount: items.length,
				omittedCount: Math.max(0, source.length - items.length),
				omittedBefore: start,
				omittedAfter: Math.max(0, source.length - start - items.length),
				items
			}
		};
	}

	async execute(request, { signal } = {}) {
		this.#active();
		const requestId = typeof request?.requestId === "string" ? request.requestId : "dashboard";
		const expectedRevision = request?.expectedRevision;
		if (expectedRevision !== undefined && expectedRevision !== this.#revision) {
			throw new DashboardControllerError("STALE", "Dashboard revision changed");
		}
		const revision = this.#revision;
		const generation = this.#generation;
		const type = request?.action?.type;
		let data;
		if (type === "balance.refresh") {
			if (typeof this.#implementation.readBalance !== "function") {
				throw new DashboardControllerError("UNAVAILABLE", "Balance reader is unavailable");
			}
			data = await this.#implementation.readBalance(request.action, { signal: this.#signal(signal) });
			this.#unchanged(generation, revision, signal);
		} else if (type === "usage.refresh") {
			await this.#implementation.refresh({ signal: this.#signal(signal) });
			this.#unchanged(generation, revision, signal);
			this.#publish(this.#implementation.readUsage({ range: {} }), true);
		} else {
			throw new DashboardControllerError("INVALID_REQUEST", "Unknown dashboard action");
		}
		return {
			requestId,
			revision: this.#revision,
			status: "applied",
			message: `${type} done`,
			...(data === undefined ? {} : { data: clone(data, {}) }),
			snapshot: this.#snapshot
		};
	}

	notifyChanged(force = false) {
		if (this.#closed) return this.#snapshot;
		return this.#publish(this.#implementation.readUsage({ range: {} }), force);
	}

	async dispose() {
		if (this.#closed) return;
		this.#closed = true;
		this.#generation += 1;
		this.#lifetime.abort();
		this.#listeners.clear();
		await this.#implementation.dispose?.();
	}

	#signal(signal) {
		return signal === undefined ? this.#lifetime.signal : AbortSignal.any([signal, this.#lifetime.signal]);
	}

	#unchanged(generation, revision, signal) {
		stopped(signal);
		this.#active();
		if (generation !== this.#generation || revision !== this.#revision) {
			throw new DashboardControllerError("STALE", "Dashboard data changed while reading");
		}
	}

	#publish(input, force = false) {
		const candidate = createSummary(input, this.#revision + 1);
		const fingerprint = JSON.stringify({ ...candidate, revision: 0, capturedAt: 0 });
		if (!force && this.#snapshot !== undefined && fingerprint === this.#fingerprint) return this.#snapshot;
		this.#revision += 1;
		this.#generation += 1;
		this.#snapshot = candidate;
		this.#fingerprint = fingerprint;
		for (const listener of [...this.#listeners]) {
			try {
				listener(candidate);
			} catch {
				// Renderer failures remain renderer-local.
			}
		}
		return candidate;
	}

	#active() {
		if (this.#closed) throw new DashboardControllerError("UNAVAILABLE", "Dashboard controller is disposed");
	}
}
