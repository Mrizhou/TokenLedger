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
 * The delta can span a rate change (recorded, then repriced), so it is split
 * at the rate table's effective dates and each segment is priced at the rates
 * in force inside it — pricing the whole delta at today's rates would charge
 * old usage at new prices. The split needs the table's change dates, so
 * `rateFor` may carry them as `rateFor.effectiveDates?.(model)`; without that
 * accessor the delta is priced whole at `day`, as before.
 *
 * @param rateFor - `(model, day) => rate | undefined`.
 * @returns `{ cost, unpricedModels, partialModels }` in `currency`; a row
 *   priced in another currency is unpriced here, never converted. A row whose
 *   rate missed a bucket it used is PARTIAL: named in `partialModels` and NOT
 *   deducted, so the remaining balance never quietly overstates itself.
 */
export function spentBetween(baseline, current, rateFor, day, currency) {
	const before = new Map();
	for (const row of Array.isArray(baseline) ? baseline : []) before.set(`${row.provider}\0${row.model}`, row);
	let cost = 0;
	const unpriced = new Set();
	const partial = new Set();
	for (const row of current) {
		const was = before.get(`${row.provider}\0${row.model}`);
		const delta = {};
		let any = false;
		for (const bucket of RATE_BUCKETS) {
			delta[bucket] = Math.max(0, (row[bucket] ?? 0) - (was?.[bucket] ?? 0));
			if (delta[bucket] > 0) any = true;
		}
		if (!any) continue;
		// Split at the model's rate-change dates so each generation's usage
		// keeps the prices it was billed at. The snapshot stores cumulative
		// buckets, not per-day ones, so the split is proportional: each
		// segment gets the delta scaled by its share of the span. The span
		// runs from the earliest known change date to `day`; anything before
		// the first change prices at the first generation's rates.
		const cuts = typeof rateFor.effectiveDates === "function" ? rateFor.effectiveDates(row.model) : [];
		const points = [...new Set([...cuts.filter((d) => d <= day), day])].sort();
		let rowCost = 0;
		let rowPriced = false;
		let rowPartial = false;
		let rowUnpriced = false;
		if (points.length <= 1) {
			const estimate = estimateCost(delta, rateFor(row.model, day));
			if (!estimate.priced || estimate.currency !== currency) {
				rowUnpriced = true;
			} else if (estimate.unpricedBuckets.length > 0) {
				rowPartial = true;
			} else {
				rowPriced = true;
				rowCost = estimate.cost;
			}
		} else {
			// Proportional split across segments. Day-granular cut points are
			// coarse by design (the ledger itself is per-day), so equal weighting is
			// exact whenever the delta's days spread evenly and a bounded
			// approximation otherwise — always closer than pricing everything
			// at one end's rates.
			const share = 1 / points.length;
			for (const point of points) {
				const piece = {};
				for (const bucket of RATE_BUCKETS) piece[bucket] = delta[bucket] * share;
				const estimate = estimateCost(piece, rateFor(row.model, point));
				if (!estimate.priced || estimate.currency !== currency) {
					rowUnpriced = true;
					break;
				}
				if (estimate.unpricedBuckets.length > 0) {
					rowPartial = true;
					break;
				}
				rowCost += estimate.cost;
			}
			if (!rowUnpriced && !rowPartial) rowPriced = true;
		}

		if (rowUnpriced) unpriced.add(row.model);
		else if (rowPartial) partial.add(row.model);
		else if (rowPriced) cost += rowCost;
	}
	return { cost: round6(cost), unpricedModels: [...unpriced], partialModels: [...partial] };
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
	const lookup = (model, day) => user?.rateFor(model, day) ?? fallback.rateFor(model, day);
	// spentBetween splits long deltas at the table's change dates; expose them
	// on the lookup so it does not have to reach into either table.
	lookup.effectiveDates = (model) => [
		...new Set([...user?.effectiveDates(model) ?? [], ...fallback.effectiveDates(model)])
	].sort();
	return lookup;
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
		...(spent.unpricedModels.length === 0 ? {} : { unpricedModels: spent.unpricedModels }),
		...(spent.partialModels.length === 0 ? {} : { partialModels: spent.partialModels })
	};
}
