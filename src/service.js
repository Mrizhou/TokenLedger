/**
 * Renderer-neutral public service for TokenLedger.
 *
 * The host plugin remains the only owner of the SQLite index, relay directory,
 * provider readers, and settings scopes. Consumers receive bounded immutable
 * views and structured actions; they never receive the store or Cordis objects.
 *
 * @module dsh-tokenledger/service
 */

/** Maximum serialized size of the replayed summary snapshot. */
export const TOKEN_LEDGER_SUMMARY_MAX_BYTES = 128 * 1024;

/** Maximum serialized size of one detailed usage view. */
export const TOKEN_LEDGER_VIEW_MAX_BYTES = 512 * 1024;

/** Maximum serialized size of an export returned through the public service. */
export const TOKEN_LEDGER_EXPORT_MAX_BYTES = 1024 * 1024;

/** Maximum serialized size of one admitted structured action. */
export const TOKEN_LEDGER_ACTION_MAX_BYTES = 64 * 1024;

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
	for (const child of Object.values(value)) deepFreeze(child, seen);
	return Object.freeze(value);
}

function boundedClone(value, depth = 0, arrayLimit = 128) {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	if (typeof value === "string") return value.slice(0, 2048);
	if (depth >= 8 || typeof value !== "object") return null;
	if (Array.isArray(value)) {
		return value.slice(0, arrayLimit).map((entry) => boundedClone(entry, depth + 1, arrayLimit));
	}
	const out = {};
	for (const [key, child] of Object.entries(value).slice(0, 96)) {
		const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
		if (PRIVATE_KEYS.has(normalized)) continue;
		if (child !== undefined) out[key] = boundedClone(child, depth + 1, arrayLimit);
	}
	return out;
}

function bytes(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function rows(value, limit) {
	return Array.isArray(value) ? boundedClone(value.slice(0, limit), 0, limit) : [];
}

function coreView(source) {
	return {
		version: typeof source.version === "string" ? source.version.slice(0, 64) : "unknown",
		generatedAt: Number(source.generatedAt) || Date.now(),
		timeZone: boundedClone(source.timeZone ?? {}),
		range: boundedClone(source.range ?? {}),
		...(typeof source.site === "string" ? { site: source.site.slice(0, 256) } : {}),
		totals: boundedClone(source.totals ?? {}),
		windows: boundedClone(source.windows ?? {}),
		lastSweepAt: Number.isFinite(Number(source.lastSweepAt)) ? Number(source.lastSweepAt) : undefined,
		diagnostics: boundedClone(source.diagnostics ?? {})
	};
}

/**
 * Clone and bound the complete usage payload used by Web and future renderers.
 *
 * @param {object} input output of `usagePayload()`.
 * @returns {object} deeply frozen renderer-neutral view.
 */
export function createTokenLedgerView(input) {
	const source = input !== null && typeof input === "object" ? input : {};
	let view = {
		...coreView(source),
		days: rows(source.days, 400),
		activity: rows(source.activity, 371),
		activityModels: rows(source.activityModels, 2048),
		models: rows(source.models, 256),
		sites: rows(source.sites, 128),
		projects: rows(source.projects, 256),
		providers: rows(source.providers, 256),
		directory: rows(source.directory, 128),
		accounts: rows(source.accounts, 128),
		priced: source.priced === null ? null : boundedClone(source.priced ?? null, 0, 256)
	};
	if (bytes(view) > TOKEN_LEDGER_VIEW_MAX_BYTES) {
		view = {
			...view,
			activityModels: view.activityModels.slice(0, 512),
			models: view.models.slice(0, 128),
			projects: view.projects.slice(0, 128),
			providers: view.providers.slice(0, 128)
		};
	}
	if (bytes(view) > TOKEN_LEDGER_VIEW_MAX_BYTES) {
		view = {
			...coreView(source),
			days: rows(source.days, 90),
			activity: rows(source.activity, 90),
			activityModels: [],
			models: rows(source.models, 64),
			sites: rows(source.sites, 64),
			projects: rows(source.projects, 64),
			providers: rows(source.providers, 64),
			directory: rows(source.directory, 64),
			accounts: rows(source.accounts, 64),
			priced: null,
			reduced: true
		};
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
		freshness: {
			...(view.lastSweepAt === undefined ? {} : { lastSweepAt: view.lastSweepAt })
		}
	};
	if (bytes(summary) > TOKEN_LEDGER_SUMMARY_MAX_BYTES) {
		summary = {
			...summary,
			activity: summary.activity.slice(-90),
			models: summary.models.slice(0, 32),
			projects: summary.projects.slice(0, 32),
			providers: summary.providers.slice(0, 32),
			priced: null,
			reduced: true
		};
	}
	if (bytes(summary) > TOKEN_LEDGER_SUMMARY_MAX_BYTES) {
		summary = {
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
		};
	}
	if (bytes(summary) > TOKEN_LEDGER_SUMMARY_MAX_BYTES) {
		throw new TokenLedgerError("SUMMARY_TOO_LARGE", "tokenledger summary exceeded its serialized size limit");
	}
	return deepFreeze(summary);
}

function requestIdOf(request) {
	const id = typeof request?.requestId === "string" ? request.requestId.trim() : "";
	if (id.length === 0 || id.length > 128) {
		throw new TokenLedgerError("INVALID_REQUEST", "requestId must contain 1-128 characters");
	}
	return id;
}

function throwIfAborted(signal, requestId) {
	if (signal?.aborted === true) {
		throw new TokenLedgerError("ABORTED", "tokenledger request was aborted", { requestId });
	}
}

function queryOf(request) {
	const source = request?.range !== null && typeof request?.range === "object" ? request.range : {};
	const date = /^\d{4}-\d{2}-\d{2}$/;
	const range = {};
	if (typeof source.from === "string" && date.test(source.from)) range.from = source.from;
	if (typeof source.to === "string" && date.test(source.to)) range.to = source.to;
	const site = typeof request?.site === "string" && request.site.trim() !== ""
		? request.site.trim().slice(0, 256)
		: undefined;
	return { range, site };
}

function exportData(value) {
	const source = value !== null && typeof value === "object" ? value : {};
	const content = typeof source.content === "string" ? source.content : "";
	if (Buffer.byteLength(content, "utf8") > TOKEN_LEDGER_EXPORT_MAX_BYTES) {
		throw new TokenLedgerError("RESULT_TOO_LARGE", "tokenledger export exceeded its serialized size limit");
	}
	return deepFreeze({
		format: source.format === "csv" ? "csv" : "json",
		content,
		...(typeof source.fileName === "string" ? { fileName: source.fileName.slice(0, 256) } : {}),
		...(typeof source.mimeType === "string" ? { mimeType: source.mimeType.slice(0, 128) } : {})
	});
}

function actionData(type, value) {
	if (value === undefined) return undefined;
	if (type === "usage.export") return exportData(value);
	return deepFreeze(boundedClone(value, 0, 128));
}

function cloneAction(value, requestId) {
	let action;
	try {
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
		if (initial !== null && typeof initial === "object" && typeof initial.then === "function") {
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
		const dispose = () => {
			this.#listeners.delete(listener);
			options.signal?.removeEventListener("abort", dispose);
		};
		if (options.signal?.aborted === true) dispose();
		else options.signal?.addEventListener("abort", dispose, { once: true });
		return dispose;
	}

	/** Read and, when changed, publish the current bounded summary. */
	getSummary(request, options = {}) {
		const requestId = requestIdOf(request);
		return this.#withRequest(requestId, options.signal, async (signal) => {
			const generation = this.#generation;
			const view = await this.#implementation.readUsage({ range: {}, site: undefined }, { signal });
			throwIfAborted(signal, requestId);
			if (generation !== this.#generation) {
				throw new TokenLedgerError("STALE", "tokenledger changed while the summary was loading", { requestId });
			}
			return this.#publish(view);
		});
	}

	/** Read one bounded range/site view without mutating the replayed summary. */
	queryUsage(request, options = {}) {
		const requestId = requestIdOf(request);
		const query = queryOf(request);
		return this.#withRequest(requestId, options.signal, async (signal) => {
			const generation = this.#generation;
			const view = await this.#implementation.readUsage(query, { signal });
			throwIfAborted(signal, requestId);
			if (generation !== this.#generation) {
				throw new TokenLedgerError("STALE", "tokenledger changed while the usage view was loading", { requestId });
			}
			return deepFreeze({ revision: this.#revision, value: createTokenLedgerView(view) });
		});
	}

	/** Read the sanitized renderer-neutral configuration view. */
	getConfiguration(request, options = {}) {
		const requestId = requestIdOf(request);
		return this.#withRequest(requestId, options.signal, async (signal) => {
			if (typeof this.#implementation.readConfiguration !== "function") {
				throw new TokenLedgerError("UNAVAILABLE", "tokenledger configuration is unavailable", { requestId });
			}
			const generation = this.#generation;
			const value = await this.#implementation.readConfiguration({ signal });
			throwIfAborted(signal, requestId);
			if (generation !== this.#generation) {
				throw new TokenLedgerError("STALE", "tokenledger changed while configuration was loading", { requestId });
			}
			return deepFreeze({ revision: this.#revision, value: boundedClone(value, 0, 128) });
		});
	}

	/** Execute one structured domain action. */
	execute(request, options = {}) {
		const requestId = requestIdOf(request);
		const action = cloneAction(request?.action, requestId);
		const type = action?.type;
		const expectedRevision = request.expectedRevision;
		if (!ACTION_TYPES.has(type)) {
			throw new TokenLedgerError("INVALID_REQUEST", "unknown tokenledger action type", { requestId });
		}
		if (
			expectedRevision !== undefined &&
			(!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
		) {
			throw new TokenLedgerError("INVALID_REQUEST", "expectedRevision must be a positive safe integer", { requestId });
		}
		return this.#withRequest(requestId, options.signal, async (signal, markCommitted) => {
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
				const result = await this.#implementation.runAction(action, {
					signal,
					lifetimeSignal: this.#lifetime.signal,
					requestId,
					commit
				});
				if (generation !== this.#generation) {
					throw new TokenLedgerError("STALE", "tokenledger action result was superseded", { requestId });
				}
				if (result?.changed === true && !committed) {
					throwIfAborted(signal, requestId);
					commit();
				}
				let snapshot = this.#snapshot;
				if (result?.changed === true) {
					const view = result.view ?? await this.#implementation.readUsage({ range: {}, site: undefined }, { signal: this.#lifetime.signal });
					this.#assertActive(requestId);
					snapshot = this.#publish(view, true);
				}
				return deepFreeze({
					requestId,
					revision: snapshot.revision,
					status: result?.ok === false ? "rejected" : "applied",
					message: typeof result?.message === "string" ? result.message.slice(0, 2048) : "",
					...(result?.data === undefined ? {} : { data: actionData(type, result.data) }),
					snapshot
				});
			} finally {
				release();
			}
		});
	}

	/** Publish a synchronous host-owned change, such as a settings watch. */
	notifyChanged() {
		if (this.#closed) return this.#snapshot;
		try {
			return this.#publish(this.#implementation.readUsage({ range: {}, site: undefined }));
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
		await this.#implementation.dispose?.();
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
		for (const listener of [...this.#listeners]) {
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
