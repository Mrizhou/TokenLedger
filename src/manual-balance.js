/**
 * A balance the user typed in, for a vendor whose API keys cannot read one.
 *
 * 小米 MiMo is the case (用户 2026-10-04「这种改成自己输入吧」): no inference
 * host answers for money with a key, and the console cookie that could lasted
 * about a day. So the user types the balance the console shows, and from that
 * moment the ledger keeps it current — the figure on the card is the typed
 * amount minus what the ledger has priced on that account's routes since.
 *
 * The ledger rolls up per session per DAY, so "since" cannot be a timestamp
 * filter. It is a snapshot instead: entering a balance records each (route,
 * model)'s all-time token buckets, and the spend later is the priced
 * DIFFERENCE between then and now. That is exact to the sweep, needs no time
 * column, and survives the day boundary.
 *
 * A full refold (`reindex`, a schema change) can only shrink the current
 * totals below the snapshot for usage whose logs were deleted; a bucket never
 * counts as negative spend.
 *
 * @module dsh-tokenledger/manual-balance
 */

import { RATE_BUCKETS, RateTable, estimateCost, round6 } from "./pricing.js";

/** Currencies a typed balance may be in. */
const CURRENCIES = new Set(["CNY", "USD"]);

/**
 * A typed amount, cleaned, or undefined when it is not one: a leading currency
 * sign, thousands separators and surrounding space are tolerated.
 */
export function normalizeManualAmount(value) {
	const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
	const cleaned = text.replace(/^[¥￥$]\s*/, "").replace(/,/g, "");
	if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
	const amount = Number(cleaned);
	return Number.isFinite(amount) && amount < 1e9 ? round6(amount) : undefined;
}

/** A currency code the card can print, defaulting to CNY. */
export function normalizeManualCurrency(value) {
	const code = typeof value === "string" ? value.trim().toUpperCase() : "";
	return CURRENCIES.has(code) ? code : code === "" ? "CNY" : undefined;
}

/** Each (route, model)'s all-time buckets on the given routes. */
export function usageSnapshot(store, routes) {
	const rows = [];
	for (const route of new Set(routes)) {
		for (const row of store.byProviderModel({}, undefined, route)) {
			const entry = { provider: row.provider, model: row.model };
			for (const bucket of RATE_BUCKETS) entry[bucket] = row[bucket] ?? 0;
			rows.push(entry);
		}
	}
	return rows;
}

/**
 * Price the usage between two snapshots.
 *
 * @param rateFor - `(model, day) => rate | undefined`.
 * @returns `{ cost, unpricedModels }` in `currency`; a row priced in another
 *   currency is unpriced here, never converted.
 */
export function spentBetween(baseline, current, rateFor, day, currency) {
	const before = new Map();
	for (const row of Array.isArray(baseline) ? baseline : []) before.set(`${row.provider}\0${row.model}`, row);
	let cost = 0;
	const unpriced = new Set();
	for (const row of current) {
		const was = before.get(`${row.provider}\0${row.model}`);
		const delta = {};
		let any = false;
		for (const bucket of RATE_BUCKETS) {
			delta[bucket] = Math.max(0, (row[bucket] ?? 0) - (was?.[bucket] ?? 0));
			if (delta[bucket] > 0) any = true;
		}
		if (!any) continue;
		const estimate = estimateCost(delta, rateFor(row.model, day));
		if (!estimate.priced || estimate.currency !== currency || estimate.unpricedBuckets.length > 0) {
			unpriced.add(row.model);
		}
		if (estimate.priced && estimate.currency === currency) cost += estimate.cost;
	}
	return { cost: round6(cost), unpricedModels: [...unpriced] };
}

/**
 * The rate lookup for a typed balance: the user's own `rates` first, the
 * shipped list for any model they do not price.
 */
export function manualRateLookup(userRates, shipped) {
	let user;
	try {
		user = Array.isArray(userRates) ? new RateTable(userRates) : undefined;
	} catch {
		// A malformed user table falls back to the shipped prices.
		user = undefined;
	}
	const fallback = new RateTable(shipped);
	return (model, day) => user?.rateFor(model, day) ?? fallback.rateFor(model, day);
}

/**
 * The card for a typed balance.
 *
 * @param entry - `{ amount, currency, at, baseline }` as stored.
 * @param current - the routes' snapshot now ({@link usageSnapshot}).
 * @param day - `YYYY-MM-DD` to price at.
 */
export function manualBalanceCard(entry, current, rateFor, day) {
	const spent = spentBetween(entry.baseline, current, rateFor, day, entry.currency);
	const total = round6(entry.amount - spent.cost);
	return {
		supported: true,
		fetched: true,
		manual: true,
		currency: entry.currency,
		total,
		isAvailable: total > 0,
		enteredAmount: entry.amount,
		enteredAt: entry.at,
		spentSince: spent.cost,
		...(spent.unpricedModels.length === 0 ? {} : { unpricedModels: spent.unpricedModels })
	};
}
