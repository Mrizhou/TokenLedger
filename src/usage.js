/**
 * Per-day, per-route token-usage aggregation over DSH session event logs.
 *
 * A *route* is the triple `(relay site, provider, model)`. Recording the site
 * alongside the provider is what makes site attribution possible: the same model
 * bought through two different relays must never collapse into one bucket, and
 * the same relay serving several models must be summable on its own.
 *
 * Aggregation semantics mirror `@deepseek-ai/dsh-token-meter`'s `tokenUsage`
 * projection:
 *
 * - A usage sample rides either an `assistant/chunk` whose
 *   `data.chunk.type === 'usage'`, or an `assistant/message` with `data.usage`.
 *   Collecting BOTH is load-bearing: a request that reported usage and then
 *   failed never produces an `assistant/message`, and the provider still bills
 *   it. Reading only `assistant/message` silently undercounts exactly the calls
 *   a user most wants explained when a relay invoice looks too high.
 * - A repeated sample for the same `(turn, step)` REPLACES the earlier value
 *   rather than adding to it, and the replacement is re-attributed to the day
 *   and route of the later event.
 *
 * Route attribution:
 *
 * - `assistant/message` names its own provider and model at
 *   `data.message.source` (`ModelMessageSource extends AssistantProvenance`).
 * - A usage chunk carries no provenance at all — `StreamChunk`'s usage variant
 *   is only `{ type: 'usage', usage }` — so an orphan chunk falls back to the
 *   most recent `request/header` at `data.header.config`.
 * - Anything still unattributed lands in an explicit `unknown` bucket. It is
 *   never guessed.
 *
 * The relay site is resolved at fold time, not at render time, and the resolved
 * value is baked into the stored route. Reconfiguring a provider's base URL
 * therefore changes future attribution only; history is never rewritten.
 *
 * Token buckets are disjoint. DSH's `TokenUsage.inputTokens` already excludes
 * cache reads and writes (adapters whose providers fold cache hits into one
 * prompt count, such as DeepSeek's `prompt_tokens`, subtract them out), so the
 * three prompt-side buckets sum to billed input. `reasoningTokens` is a
 * subdivision of `outputTokens` and is tracked for display only — it is never
 * added to any total.
 *
 * @module dsh-tokenledger/usage
 */

/** Route component used when DSH reported no provider, model, or site. */
export const UNKNOWN = "unknown";

/** Route site component for calls that did not go through a configured relay. */
export const DIRECT = "direct";

/**
 * Traffic through a route the provider directory does not contain.
 *
 * Distinct from `DIRECT`, and the distinction is the whole point. A route that
 * is configured and simply does not point at a relay went straight to the
 * vendor — that is `direct`, and it is a fact. A route the directory has never
 * heard of (renamed since, removed since, or configured somewhere this plugin
 * cannot see) went SOMEWHERE, and we do not know where.
 *
 * These were one bucket, and a real install showed 88% of its tokens under
 * "direct/official" when much of that had gone through a relay whose route no
 * longer resolved. Reporting an unknown as a specific answer is the failure
 * this codebase guards against everywhere else; it had a hole here.
 *
 * The rollup row keeps the route name either way, so nothing is lost by having
 * been mislabelled, and re-adding the route re-attributes the history.
 */
export const UNROUTED = "unrouted";

const SEP = "\u0000";

/** The day bucket for events that carry no usable timestamp. */
export const UNKNOWN_DAY = "0000-00-00";

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * `YYYY-MM-DD` key for a millisecond epoch.
 *
 * With no `offsetMinutes` this is the host's LOCAL calendar — the store keys
 * days by the clock of the process that folded them. With `offsetMinutes` it
 * is that fixed offset from UTC instead (`480` for Asia/Shanghai), so an
 * install cuts its days where its owner's days are cut rather than where the
 * machine happens to sit. A non-finite time folds into {@link UNKNOWN_DAY}
 * rather than into `"NaN-NaN-NaN"`.
 */
export function dayKey(timeMs, offsetMinutes = undefined) {
	if (!Number.isFinite(timeMs)) return UNKNOWN_DAY;
	if (offsetMinutes === undefined) {
		const date = new Date(timeMs);
		return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
	}
	const date = new Date(timeMs + offsetMinutes * 60_000);
	return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Empty token bucket. */
/** `YYYY-MM-DD` for N days back, inclusive of today. */
export function fromDaysAgo(days, offsetMinutes = undefined) {
	return dayKey(Date.now() - (days - 1) * 86_400_000, offsetMinutes);
}

/**
 * Collapse route rows into one row per (day, model).
 *
 * `byRoute` is keyed by `(day, site, provider, model)`, so one model reached
 * through two relays is two rows — and the day tooltip listed the same model
 * twice, with each half of its real total. Zero-token rows are dropped as well:
 * a model that ran nothing that day is not part of that day's breakdown.
 *
 * @param rows - route rows for the activity window.
 * @returns `{ day, model, tokens }`, descending by tokens within each day.
 */
export function dailyModels(rows) {
	const byKey = new Map();
	for (const row of rows) {
		if (!(row.tokens > 0)) continue;
		const key = `${row.day}\u0000${row.model}`;
		const hit = byKey.get(key);
		if (hit === undefined) byKey.set(key, { day: row.day, model: row.model, tokens: row.tokens });
		else hit.tokens += row.tokens;
	}
	return [...byKey.values()].sort((a, b) => (a.day === b.day ? b.tokens - a.tokens : a.day < b.day ? -1 : 1));
}

/**
 * The host's IANA zone and UTC offset, as the panel should print it.
 *
 * @returns `{ name, offset }`, e.g. `{ name: "Asia/Shanghai", offset: "UTC+08:00" }`.
 */
export function hostTimeZone(now = new Date()) {
	// getTimezoneOffset is minutes WEST of UTC, so its sign is inverted from how
	// an offset is written.
	const minutes = -now.getTimezoneOffset();
	const sign = minutes < 0 ? "-" : "+";
	const abs = Math.abs(minutes);
	const hh = String(Math.floor(abs / 60)).padStart(2, "0");
	const mm = String(abs % 60).padStart(2, "0");
	let name;
	try {
		name = Intl.DateTimeFormat().resolvedOptions().timeZone;
	} catch {
		name = undefined;
	}
	return { name, offset: `UTC${sign}${hh}:${mm}` };
}

/** First day of the current month, in the same calendar days are keyed by. */
export function monthStart(offsetMinutes = undefined) {
	const now = Date.now();
	if (offsetMinutes === undefined) {
		const d = new Date(now);
		return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
	}
	const d = new Date(now + offsetMinutes * 60_000);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`;
}

export function zeroBuckets() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		requests: 0
	};
}

/**
 * Provider-reported usage → buckets. Cache and reasoning fields are optional
 * in `TokenUsage` and absent from some adapters' reports.
 *
 * Log-supplied numbers are coerced and clamped here: a string field used to
 * CONCATENATE into the totals (`"12"` made `"012"`) and a negative count was
 * summed as a negative. A bucket is a count of tokens — finite, and at worst
 * zero, never invented.
 */
export function bucketsOf(usage) {
	const count = (value) => {
		const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : 0;
		return Number.isFinite(n) && n > 0 ? n : 0;
	};
	return {
		inputTokens: count(usage.inputTokens),
		outputTokens: count(usage.outputTokens),
		cacheReadTokens: count(usage.cacheReadTokens),
		cacheWriteTokens: count(usage.cacheWriteTokens),
		reasoningTokens: count(usage.reasoningTokens),
		requests: 1
	};
}

/** Billed input: the three disjoint prompt-side buckets. */
export function inputTotal(buckets) {
	return buckets.inputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/**
 * Total billed tokens. `reasoningTokens` is deliberately excluded — it is
 * already part of `outputTokens` and adding it would double count.
 */
export function totalTokens(buckets) {
	return inputTotal(buckets) + buckets.outputTokens;
}

/**
 * Prompt-side cache hit rate in percent (0–100, one decimal), or null when no
 * prompt tokens were reported at all.
 */
export function cacheHitRate(buckets) {
	const prompt = inputTotal(buckets);
	if (prompt <= 0) return null;
	return Math.round((buckets.cacheReadTokens / prompt) * 1000) / 10;
}

function addInto(target, source) {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.reasoningTokens += source.reasoningTokens;
	target.requests += source.requests;
	return target;
}

function subtractFrom(target, source) {
	target.inputTokens -= source.inputTokens;
	target.outputTokens -= source.outputTokens;
	target.cacheReadTokens -= source.cacheReadTokens;
	target.cacheWriteTokens -= source.cacheWriteTokens;
	target.reasoningTokens -= source.reasoningTokens;
	target.requests -= source.requests;
	return target;
}

/** Extract the usage sample an event carries, if any. */
function sampleOf(event) {
	const usage =
		event.type === "assistant/chunk" && event.data?.chunk?.type === "usage"
			? event.data.chunk.usage
			: event.type === "assistant/message" && event.data?.usage !== undefined
				? event.data.usage
				: undefined;
	if (usage === undefined) return undefined;
	// Re-reports are identified by `(turn, step)`. When either is missing there
	// is NOTHING to identify a re-report by, and a shared fallback key made
	// every such sample silently replace the last one (three samples counted
	// as one). No key means count this sample and do not dedupe it — an
	// overcount is visible in a bill, a lost sample is not.
	const id = (value) =>
		(typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value !== "") ? String(value) : undefined;
	const turn = id(event.data?.turn);
	const step = id(event.data?.step);
	return { key: turn !== undefined && step !== undefined ? `${turn}:${step}` : undefined, usage };
}

/**
 * Provider and model an event names for itself, or undefined when it names
 * neither. `assistant/message` answers from its message source; `request/header`
 * answers from its call config.
 */
function provenanceOf(event) {
	const source = event.data?.message?.source;
	if (source !== undefined && typeof source.model === "string") {
		return {
			provider: typeof source.provider === "string" && source.provider.length > 0 ? source.provider : UNKNOWN,
			model: source.model
		};
	}
	const config = event.data?.header?.config;
	if (config !== undefined && typeof config.model === "string") {
		return {
			provider: typeof config.provider === "string" && config.provider.length > 0 ? config.provider : UNKNOWN,
			model: config.model
		};
	}
	return undefined;
}

/** Longest provider/model/site name the fold will store or render. */
const MAX_NAME = 128;

/**
 * A name fit to live in a route key.
 *
 * Two demonstrated corruptions die here: a log-supplied name containing the
 * separator silently split into other columns (`prov\0evil-site` ate the model
 * column), and an unbounded name turned every padded table downstream into
 * quadratic blowup. Both are neutralised at the one choke point every stored
 * name passes through.
 */
function cleanName(value) {
	return String(value).replaceAll(SEP, "�").slice(0, MAX_NAME);
}

/** Stable key for a `(site, provider, model)` route. */
export function routeKey(site, provider, model) {
	return `${cleanName(site)}${SEP}${cleanName(provider)}${SEP}${cleanName(model)}`;
}

/** Split a route key back into its components. */
export function parseRouteKey(key) {
	const [site, provider, model] = key.split(SEP);
	return { site, provider, model };
}

function entryOf(byDay, day) {
	let entry = byDay.get(day);
	if (entry === undefined) {
		entry = { totals: zeroBuckets(), routes: new Map() };
		byDay.set(day, entry);
	}
	return entry;
}

function routeBucketOf(entry, key) {
	let bucket = entry.routes.get(key);
	if (bucket === undefined) {
		bucket = zeroBuckets();
		entry.routes.set(key, bucket);
	}
	return bucket;
}

/**
 * One session's incremental fold state.
 *
 * `days` holds the already-folded per-day entries. `lastSample` and
 * `currentRoute` let a later slice preserve replace-last-sample semantics and
 * route attribution across fold boundaries, so a slice that begins mid-step
 * stays exact without replaying the whole log.
 */
export function createUsageState() {
	return { days: new Map(), lastSample: null, currentRoute: null, lastUsageAt: undefined, consumedSeq: -1 };
}

/**
 * Fold a slice of new events onto an existing session state, mutating it.
 *
 * @param state - session fold state, mutated in place.
 * @param events - new events in `seq` order, starting after `state.consumedSeq`.
 * @param options - `resolveSite(provider)` returns the configured relay site id
 *   for a DSH provider route, or a falsy value for a direct/official call.
 *   Omitting it attributes everything to {@link DIRECT}.
 */
export function applyUsageDelta(state, events, options = {}) {
	const resolveSite = options.resolveSite ?? (() => DIRECT);
	const dayOffset = options.dayOffsetMinutes;
	let last = state.lastSample;
	let currentRoute = state.currentRoute;
	// Re-report replacement is looked up across the WHOLE pass, not just
	// against the immediately preceding sample: interleaved steps (A, B, A)
	// used to leave A's first sample counted, double-charging one step's
	// tokens. Seeded with the previous pass's last sample so a slice that
	// begins mid-step stays exact.
	const seen = new Map();
	if (last !== null && last.key !== undefined) seen.set(last.key, last);

	for (const event of events) {
		if (typeof event.seq === "number" && event.seq > state.consumedSeq) {
			state.consumedSeq = event.seq;
		}

		if (event.type === "request/header") {
			const provenance = provenanceOf(event);
			if (provenance !== undefined) currentRoute = provenance;
		}

		const sample = sampleOf(event);
		if (sample === undefined) continue;
		const timed = typeof event.time === "number" && Number.isFinite(event.time);
		if (timed) state.lastUsageAt = Math.max(state.lastUsageAt ?? -Infinity, event.time);

		const provenance = provenanceOf(event) ?? currentRoute;
		const provider = provenance?.provider ?? UNKNOWN;
		const model = provenance?.model ?? UNKNOWN;
		// Three answers, not two. `undefined` from the resolver means the route
		// is absent from the directory — which is not the same as a route that
		// is present and points at no relay.
		const site = provider === UNKNOWN ? DIRECT : (resolveSite(provider) ?? UNROUTED);
		const key = routeKey(site, provider, model);

		// An event without a usable timestamp joins the last day it saw rather
		// than inventing `"NaN-NaN-NaN"` — a day key nothing could query.
		const day = timed
			? dayKey(event.time, dayOffset)
			: state.lastUsageAt !== undefined
				? dayKey(state.lastUsageAt, dayOffset)
				: UNKNOWN_DAY;
		const buckets = bucketsOf(sample.usage);

		// Same (turn, step) re-reported: undo the earlier sample from the exact
		// day and route it was attributed to, then add the new one.
		const previous = sample.key === undefined ? undefined : seen.get(sample.key);
		if (previous !== undefined) {
			const earlier = state.days.get(previous.day);
			if (earlier !== undefined) {
				subtractFrom(earlier.totals, previous.buckets);
				const previousRoute = earlier.routes.get(previous.route);
				if (previousRoute !== undefined) subtractFrom(previousRoute, previous.buckets);
			}
		}

		const entry = entryOf(state.days, day);
		addInto(entry.totals, buckets);
		addInto(routeBucketOf(entry, key), buckets);

		last = { key: sample.key, day, route: key, buckets };
		if (sample.key !== undefined) seen.set(sample.key, last);
	}

	state.lastSample = last;
	state.currentRoute = currentRoute;
	return state;
}

/**
 * Fold one complete session log into per-day, per-route buckets.
 * @returns `Map<'YYYY-MM-DD', { totals, routes: Map<routeKey, buckets> }>`
 *   holding only days that saw usage.
 */
export function foldUsage(events, options = {}) {
	return applyUsageDelta(createUsageState(), events, options).days;
}

/** Merge one session's folded days into a global per-day map, mutating it. */
export function mergeInto(byDay, sessionDays) {
	for (const [day, entry] of sessionDays) {
		const target = entryOf(byDay, day);
		addInto(target.totals, entry.totals);
		for (const [key, buckets] of entry.routes) addInto(routeBucketOf(target, key), buckets);
	}
}

/**
 * Sum a per-day map over a date range into one bucket set, optionally
 * restricted to a single relay site.
 * @param byDay - global day → entry map.
 * @param range - `{ from?, to? }` inclusive `YYYY-MM-DD` bounds.
 * @param site - relay site id to restrict to, or undefined for all sites.
 */
export function sumRange(byDay, range = {}, site = undefined) {
	const total = zeroBuckets();
	for (const [day, entry] of byDay) {
		if (range.from !== undefined && day < range.from) continue;
		if (range.to !== undefined && day > range.to) continue;
		if (site === undefined) {
			addInto(total, entry.totals);
			continue;
		}
		for (const [key, buckets] of entry.routes) {
			if (parseRouteKey(key).site === site) addInto(total, buckets);
		}
	}
	return total;
}

/**
 * Group a per-day map by model over a date range, optionally restricted to one
 * relay site. Model is the primary reporting dimension; site is a filter.
 * @returns array of `{ model, ...buckets, tokens, cacheHitRate }`, descending
 *   by billed tokens.
 */
export function byModel(byDay, range = {}, site = undefined) {
	const models = new Map();
	for (const [day, entry] of byDay) {
		if (range.from !== undefined && day < range.from) continue;
		if (range.to !== undefined && day > range.to) continue;
		for (const [key, buckets] of entry.routes) {
			const route = parseRouteKey(key);
			if (site !== undefined && route.site !== site) continue;
			let bucket = models.get(route.model);
			if (bucket === undefined) {
				bucket = zeroBuckets();
				models.set(route.model, bucket);
			}
			addInto(bucket, buckets);
		}
	}
	return [...models.entries()]
		.map(([model, buckets]) => ({
			model,
			...buckets,
			tokens: totalTokens(buckets),
			cacheHitRate: cacheHitRate(buckets)
		}))
		.sort((a, b) => b.tokens - a.tokens);
}

/**
 * Group a per-day map by relay site over a date range. This is the DSH-side
 * the DSH side of the ledger: each row is what TokenLedger believes was spent at
 * one site, ready to be compared against that site's own reported figures.
 */
export function bySite(byDay, range = {}) {
	const sites = new Map();
	for (const [day, entry] of byDay) {
		if (range.from !== undefined && day < range.from) continue;
		if (range.to !== undefined && day > range.to) continue;
		for (const [key, buckets] of entry.routes) {
			const { site } = parseRouteKey(key);
			let bucket = sites.get(site);
			if (bucket === undefined) {
				bucket = zeroBuckets();
				sites.set(site, bucket);
			}
			addInto(bucket, buckets);
		}
	}
	return [...sites.entries()]
		.map(([site, buckets]) => ({
			site,
			...buckets,
			tokens: totalTokens(buckets),
			cacheHitRate: cacheHitRate(buckets)
		}))
		.sort((a, b) => b.tokens - a.tokens);
}

/**
 * Render a global per-day map into the wire shape served to the UI.
 * @returns `{ days, total, updatedAt }`, `days` ascending by date, each day's
 *   `routes` descending by billed tokens.
 */
export function renderUsage(byDay, updatedAt) {
	const days = [...byDay.entries()]
		.map(([date, entry]) => ({
			date,
			...entry.totals,
			tokens: totalTokens(entry.totals),
			cacheHitRate: cacheHitRate(entry.totals),
			routes: [...entry.routes.entries()]
				.map(([key, buckets]) => ({
					...parseRouteKey(key),
					...buckets,
					tokens: totalTokens(buckets),
					cacheHitRate: cacheHitRate(buckets)
				}))
				.sort((a, b) => b.tokens - a.tokens)
		}))
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

	const total = zeroBuckets();
	for (const [, entry] of byDay) addInto(total, entry.totals);

	return {
		days,
		total: { ...total, tokens: totalTokens(total), cacheHitRate: cacheHitRate(total) },
		updatedAt
	};
}
