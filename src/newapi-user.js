/**
 * New API's personal wallet, read with the user's own console token.
 *
 * ## Why a second credential exists at all
 *
 * An ordinary `sk-` key reads that KEY's quota (`/api/usage/token/`), which is
 * the right answer for a limited key and no answer at all for the account
 * behind it: an unlimited key reports a negated usage as its remaining quota,
 * and no key reports the wallet. New API's console API answers the account
 * question — `GET /api/user/self` with a **system access token** (个人设置 →
 * 系统访问令牌) plus the numeric user id in `New-Api-User` — and returns the
 * wallet: `data.quota` remaining, `data.used_quota` spent, the username.
 *
 * ## The throttle, and the cache that respects it
 *
 * Console reads are rate-limited per site — by default **5 per 20 minutes** —
 * so this module never lets a panel open become a network request. One cache
 * per ORIGIN (the wallet belongs to the site's user, not to any one route):
 *
 * - fresh within the base interval → served from memory, zero requests, which
 *   is also why the panel opens instantly now;
 * - inside a backoff window after a limit → the cached card, flagged `stale`,
 *   with `retryAt` saying when the next attempt is even worth making;
 * - otherwise → one request. A limit doubles the backoff (4 min floor, the
 *   throttle's own steady-state interval, up to a 30 min ceiling); a success
 *   clears it. The panel's refresh button may force past the freshness window
 *   but never past a backoff — hammering through a throttle is the one thing
 *   this cache exists to prevent.
 *
 * Setting a user token also REPLACES the per-key read for that origin (see
 * `shouldUseWallet`): the key's query spends from the same budget the wallet
 * query needs, and the wallet answers with everything the card shows.
 *
 * ## What is stored, and what is never echoed
 *
 * The token and user id live in the plugin's settings namespace, one entry per
 * origin, written by the panel's 设置余额 dialog. This module reads them as
 * arguments and sends them as headers — never query strings — and the GET that
 * lets the dialog show what is configured returns only `userId` and a
 * `hasToken` flag. The token itself crosses this module exactly once: into an
 * Authorization header.
 *
 * @module dsh-tokenledger/newapi-user
 */

/** The console route that answers with the user's own account. */
import { DEFAULT_MAX_BYTES, fetchNoCrossOriginRedirect, readCapped } from "./transport.js";

export const USER_SELF_PATH = "/api/user/self";
/** The public site-config route that names the quota unit. */
export const STATUS_PATH = "/api/status";

/**
 * Freshness window for a successful read.
 *
 * The throttle's floor is one request per 4 minutes (5 per 20). Sitting just
 * above it keeps a panel that is opened often inside the budget forever, and
 * a panel opened rarely loses nothing — the price of a stale figure for a few
 * minutes is a number the vendor itself only recalculates on spend.
 */
export const BASE_TTL_MS = 5 * 60_000;
/** First backoff after a limit: exactly the throttle's own interval. */
export const MIN_BACKOFF_MS = 4 * 60_000;
/** Backoff ceiling; a site that is still refusing after half an hour is not
 *  going to be persuaded by the 31st minute either. */
export const MAX_BACKOFF_MS = 30 * 60_000;
/** How long a site's unit answer is trusted; it is configuration, not state. */
export const STATUS_TTL_MS = 30 * 60_000;
/** New API's shipped default, used when the site will not name its own unit. */
export const DEFAULT_QUOTA_PER_UNIT = 500_000;

/** Site display currencies this panel can render a symbol for. */
const UNITS = new Map([["CNY", "CNY"], ["USD", "USD"], ["EUR", "EUR"]]);

/** Create one plugin-instance-owned wallet and unit cache. */
function createCache() {
	return { wallets: new Map(), units: new Map() };
}

// Kept only for the original function exports. The Cordis plugin uses
// `createNewApiWalletReader()` and therefore never shares this compatibility
// cache with another plugin instance or Fiber.
const compatibilityCache = createCache();

/** A number an API may send as a string; `undefined` for everything else. */
function toNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/** Internal quota → money, rounded to six decimals like the billing does. */
function toMoney(quota, perUnit) {
	const value = toNumber(quota);
	if (value === undefined || !(perUnit > 0)) return undefined;
	return Math.round((value / perUnit) * 1e6) / 1e6;
}

/** A trimmed non-empty string, or undefined. */
function label(value) {
	const text = typeof value === "string" ? value.trim() : "";
	return text === "" ? undefined : text;
}

/** Drop one origin's caches — after its credentials changed. */
export function forgetWallet(origin) {
	compatibilityCache.wallets.delete(origin);
}

/** Drop everything; used when the whole namespace changes underneath us. */
export function forgetAllWallets() {
	compatibilityCache.wallets.clear();
	compatibilityCache.units.clear();
}

/** Read-only view for diagnostics and tests. */
export function walletCacheSnapshot() {
	return [...compatibilityCache.wallets.entries()].map(([origin, entry]) => ({ origin, ...entry, state: undefined }));
}

/**
 * Create a host-instance-owned New API wallet reader.
 *
 * @returns `{ read, forget, clear, snapshot, dispose }`. None of the methods
 *   exposes credentials or cached wallet values through diagnostics.
 */
export function createNewApiWalletReader() {
	const cache = createCache();
	let closed = false;
	let generation = 0;
	const assertOpen = () => {
		if (closed) throw Object.assign(new Error("disposed"), { kind: "aborted" });
	};
	const clear = () => {
		cache.wallets.clear();
		cache.units.clear();
	};
	return Object.freeze({
		read: async (options) => {
			assertOpen();
			const captured = generation;
			try {
				const value = await readWallet(cache, options);
				if (closed || captured !== generation) {
					clear();
					throw Object.assign(new Error("disposed"), { kind: "aborted" });
				}
				return value;
			} catch (error) {
				if (closed || captured !== generation) {
					clear();
					throw Object.assign(new Error("disposed"), { kind: "aborted", cause: error });
				}
				throw error;
			}
		},
		forget: (origin) => cache.wallets.delete(origin),
		clear,
		snapshot: () => [...cache.wallets.entries()].map(([origin, entry]) => ({ origin, ...entry, state: undefined })),
		dispose: () => {
			closed = true;
			generation++;
			clear();
		}
	});
}

/**
 * Whether this account's balance should come from the wallet instead of the
 * per-key read.
 *
 * Credentials are the user's explicit declaration, so an unknown relay program
 * still routes to the wallet — the dialog only offers itself where the card
 * already said "New API", and a wrong guess answers with a readable 404. The
 * seatbelt is for the reverse: a KNOWN non-New-API vendor keeps its own reader
 * even if an entry lingers in the settings.
 *
 * @param account - one of `listAccounts`' entries: `{ origin, scheme, ... }`.
 * @param auth - the origin's stored entry: `{ userId, token }` or undefined.
 */
export function shouldUseWallet(account, auth) {
	const KNOWN_NON_NEWAPI = new Set([
		"deepseek", "openrouter", "moonshot", "zai", "kimi", "minimax", "opencode-go", "sub2api", "mimo"
	]);
	if (auth === null || typeof auth !== "object") return false;
	if (typeof auth.token !== "string" || auth.token === "") return false;
	if (typeof auth.userId !== "number" || !Number.isInteger(auth.userId) || auth.userId <= 0) return false;
	if (account === null || typeof account !== "object" || typeof account.origin !== "string" || account.origin === "") {
		return false;
	}
	return !KNOWN_NON_NEWAPI.has(account.scheme);
}

/**
 * The site's quota unit, from a `/api/status` payload.
 *
 * One place owns this because two readers need it: the wallet below and the
 * per-key read in `balance.js` both divide internal quota by the site's own
 * divisor, and both must label the result with the unit the site itself
 * displays — `quota_display_type` first, a fork's custom symbol second, and
 * no unit at all rather than a guessed one when the site names neither.
 *
 * @param data - the `data` object of a `/api/status` body.
 * @returns `{ currency, perUnit }`; `currency` is undefined when the site
 *   names nothing this panel can honestly render.
 */
export function unitFromStatus(data) {
	const perUnitRaw = toNumber(data?.quota_per_unit) ?? DEFAULT_QUOTA_PER_UNIT;
	const byType = UNITS.get(data?.quota_display_type);
	const symbol = label(data?.custom_currency_symbol);
	return {
		perUnit: perUnitRaw > 0 ? perUnitRaw : DEFAULT_QUOTA_PER_UNIT,
		currency: byType ?? (symbol !== undefined && symbol !== "¤" ? symbol : undefined)
	};
}

/**
 * The site's quota unit, read and cached per origin.
 *
 * Unauthenticated and static — the two properties that make it safe to read
 * rarely and cache long. A site that refuses or cannot answer still gets a
 * wallet: the shipped default divisor applies, and the number renders without
 * a symbol rather than under a made-up one.
 */
async function readUnit(cache, origin, doFetch, now, timeoutMs, externalSignal) {
	const cached = cache.units.get(origin);
	if (cached !== undefined && now - cached.fetchedAt < STATUS_TTL_MS) return cached;

	const controller = new AbortController();
	const onAbort = () => controller.abort(externalSignal?.reason);
	if (externalSignal?.aborted === true) controller.abort(externalSignal.reason);
	else externalSignal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		// Guarded fetch, capped body — the same two defences the balance
		// readers have: a bare fetch followed a cross-origin redirect with the
		// `new-api-user` header in red-team testing, and a hostile body had no
		// ceiling at all here.
		const response = await fetchNoCrossOriginRedirect(doFetch, new URL(STATUS_PATH, origin).href, {
			headers: { accept: "application/json" },
			signal: controller.signal
		});
		if (!response.ok) throw new Error(`http-${response.status}`);
		const body = JSON.parse(await readCapped(response, DEFAULT_MAX_BYTES));
		const entry = { ...unitFromStatus(body?.data ?? {}), fetchedAt: now };
		cache.units.set(origin, entry);
		return entry;
	} catch {
		// A status read that fails costs a symbol, never the wallet. Do not
		// cache the failure — the next open may land on a site that answers.
		return { perUnit: DEFAULT_QUOTA_PER_UNIT, currency: undefined, fetchedAt: now };
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Read one site's wallet.
 *
 * @param options - `{ origin, userId, token, fetch?, now?, force?, timeoutMs? }`.
 *   `now` is injectable so a test can walk through backoffs without sleeping;
 *   `force` skips the freshness window but never a backoff.
 * @returns the standard card shape plus `{ cached?, stale?, fetchedAt, retryAt? }`.
 * @throws an `Error` carrying `.kind`:
 *   - `"rate-limited"` with `.retryAt` — throttled with no cached card to show;
 *   - `"upstream-auth"` — the token was refused;
 *   - `"invalid-response"` — the body was not the shape the console answers;
 *   - `"timeout"` / `"unreachable"` — transport.
 */
async function readWallet(cache, options = {}) {
	const { origin, userId, token, force = false, timeoutMs = 10_000 } = options;
	const now = options.now ?? Date.now();
	const doFetch = options.fetch ?? globalThis.fetch;
	const externalSignal = options.signal;
	if (externalSignal?.aborted === true) {
		throw Object.assign(new Error("aborted"), { kind: "aborted" });
	}

	const entry = cache.wallets.get(origin);
	const fresh = entry !== undefined && now - entry.fetchedAt < BASE_TTL_MS;
	// Every card this reader returns carries `supported` and `fetched` — the
	// panel's failure branch keys off `fetched !== true`, and a success that
	// forgets the flag is rendered as a refusal with an empty reason.
	if (entry !== undefined && !fresh && now < entry.nextAttemptAt) {
		// Inside a backoff with a stale-but-real card: show it, say so.
		return { ...entry.state, supported: true, fetched: true, cached: true, stale: true, fetchedAt: entry.fetchedAt, retryAt: entry.nextAttemptAt };
	}
	if (entry !== undefined && fresh && !force) {
		return { ...entry.state, supported: true, fetched: true, cached: true, fetchedAt: entry.fetchedAt };
	}
	if (entry !== undefined && now < entry.nextAttemptAt) {
		// Forced past freshness but still inside a backoff: the throttle wins.
		return { ...entry.state, supported: true, fetched: true, cached: true, stale: true, fetchedAt: entry.fetchedAt, retryAt: entry.nextAttemptAt };
	}

	// The unit and the wallet are INDEPENDENT reads — fire them together. The
	// first query of a cold cache used to pay two serial round trips (status,
	// THEN wallet); on a far site that was half the wait the user feels, for
	// a dependency that does not exist: only the MAPPING needs the unit, and
	// it is applied after both land. `readUnit` never rejects (a failed
	// status read costs the symbol, not the wallet), so the race is safe.
	const unitPromise = readUnit(cache, origin, doFetch, now, timeoutMs, externalSignal);

	const controller = new AbortController();
	const onAbort = () => controller.abort(externalSignal?.reason);
	if (externalSignal?.aborted === true) controller.abort(externalSignal.reason);
	else externalSignal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let response;
	try {
		response = await fetchNoCrossOriginRedirect(doFetch, new URL(USER_SELF_PATH, origin).href, {
			headers: {
				// Both headers, and only headers — the token must never ride a URL.
				authorization: `Bearer ${token}`,
				"new-api-user": String(userId),
				accept: "application/json"
			},
			signal: controller.signal
		});
	} catch (error) {
		if (error?.name === "AbortError") {
			const kind = externalSignal?.aborted === true ? "aborted" : "timeout";
			throw Object.assign(new Error(kind), { kind });
		}
		// A guard's refusal (cross-origin-redirect, http-3xx) keeps its own
		// identity — "unreachable" would erase why the credential was withheld.
		if (error?.kind !== undefined) throw error;
		throw Object.assign(new Error("unreachable"), { kind: "unreachable" });
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", onAbort);
	}
	const unit = await unitPromise;
	if (externalSignal?.aborted === true) {
		throw Object.assign(new Error("aborted"), { kind: "aborted" });
	}

	if (response.status === 401 || response.status === 403) {
		throw Object.assign(new Error(`upstream-${response.status}`), { kind: "upstream-auth", status: response.status });
	}

	let body;
	try {
		body = JSON.parse(await readCapped(response, DEFAULT_MAX_BYTES));
	} catch {
		throw Object.assign(new Error("invalid-response"), { kind: "invalid-response" });
	}
	if (externalSignal?.aborted === true) {
		throw Object.assign(new Error("aborted"), { kind: "aborted" });
	}

	// New API answers refusals inside a 200 as well as with real statuses, and
	// the throttle itself arrives as a 429 — or, on some forks, as prose inside
	// a 200. A refusal that NAMES the throttle backs off; any other refusal is
	// not the cache's business and just fails this read.
	if (body?.success === false || response.ok !== true) {
		const message = label(body?.message) ?? "";
		if (response.status === 429 || isLimitMessage(message)) return limitOrStale(cache, origin, entry, now, message);
		if (body?.success === false) {
			throw Object.assign(new Error(message || "upstream-error"), { kind: "upstream-auth" });
		}
		throw Object.assign(new Error(`http-${response.status}`), { kind: "upstream", status: response.status });
	}

	const data = body?.data ?? {};
	const perUnit = unit.perUnit;
	const remaining = toMoney(data.quota, perUnit);
	// A fork that reports the spent figure in money directly wins over the
	// internal counter; both names have been seen in the wild.
	const used = toNumber(data.used) ?? toMoney(data.used_quota, perUnit);
	const granted = remaining === undefined || used === undefined ? undefined : Math.round((remaining + used) * 1e6) / 1e6;

	const state = {
		scheme: "newapi",
		userToken: true,
		isAvailable: remaining === undefined ? undefined : remaining > 0,
		currency: unit.currency,
		total: remaining,
		granted,
		used,
		keyName: label(data.username) ?? label(data.display_name)
	};

	cache.wallets.set(origin, { state, fetchedAt: now, nextAttemptAt: 0, backoffMs: 0 });
	return { ...state, supported: true, fetched: true, cached: false, fetchedAt: now };
}

/** Compatibility wrapper using the original module-local cache. */
export function readNewApiWallet(options = {}) {
	return readWallet(compatibilityCache, options);
}

/** What a throttle refusal looks like across the forks that send one in prose. */
function isLimitMessage(message) {
	return /上限|频繁|稍后|rate|limit|too many|frequent/i.test(message);
}

/**
 * The throttle's own parameters, off the refusal's headers.
 *
 * `retry-after` is the server answering "ask again at" in seconds;
 * `x-ratelimit-remaining` / `x-ratelimit-reset` describe the window it is
 * defending. All optional — plenty of deployments send none, which is what
 * the doubling fallback is for.
 */
function throttleHeaders(response) {
	const get = (name) => {
		const raw = response?.headers?.get?.(name);
		const value = raw === undefined || raw === null ? NaN : Number(raw);
		return Number.isFinite(value) ? value : undefined;
	};
	return {
		retryAfter: get("retry-after"),
		remaining: get("x-ratelimit-remaining"),
		reset: get("x-ratelimit-reset")
	};
}

/**
 * Record a limit, and answer with the previous card when there is one.
 *
 * The backoff comes from the refusal itself where it can: `retry-after`
 * exactly, `x-ratelimit-reset` when the window is known to be dry, and only
 * then the exponential doubling (floor = the throttle's own interval, ceiling
 * 30 min, absolute floor 1 s so a nonsense header cannot become a hot loop).
 * A previous result rides along as the card to show — `retryAt` goes to the
 * small print — and is thrown only when there is nothing to show.
 */
function limitOrStale(cache, origin, entry, now, message, response) {
	const headers = throttleHeaders(response);
	let backoffMs;
	if (headers.retryAfter !== undefined && headers.retryAfter >= 0) {
		backoffMs = headers.retryAfter * 1000;
	} else if (headers.remaining === 0 && headers.reset !== undefined && headers.reset >= 0) {
		backoffMs = headers.reset * 1000;
	} else {
		backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, entry?.backoffMs ? entry.backoffMs * 2 : MIN_BACKOFF_MS));
	}
	backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(1_000, backoffMs));
	const nextAttemptAt = now + backoffMs;
	if (entry !== undefined) cache.wallets.set(origin, { ...entry, nextAttemptAt, backoffMs });
	if (entry?.state !== undefined) {
		return { ...entry.state, supported: true, fetched: true, cached: true, stale: true, fetchedAt: entry.fetchedAt, retryAt: nextAttemptAt };
	}
	throw Object.assign(new Error(message || "rate-limited"), { kind: "rate-limited", retryAt: nextAttemptAt });
}
