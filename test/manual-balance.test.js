/**
 * A balance the user types in (小米 MiMo), kept current against the ledger.
 *
 * 用户 2026-10-04「这种改成自己输入吧」「填的数减去之后的估算花费」「单价需要你去核实」.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	manualBalanceCard,
	manualRateLookup,
	normalizeManualAmount,
	normalizeManualCurrency,
	spentBetween,
	usageSnapshot
} from "../src/manual-balance.js";
import { MIMO_OFFICIAL_RATES } from "../src/pricing.js";

const row = (model, buckets, provider = "xiaomi") => ({
	provider,
	model,
	inputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
	...buckets
});

const official = manualRateLookup(undefined, MIMO_OFFICIAL_RATES);

test("MiMo's shipped prices are the official page's, per million tokens, CNY", () => {
	// https://mimo.mi.com/static/docs/price/pay-as-you-go.md, fetched 2026-10-04.
	const at = (model) => official(model, "2026-10-04").perMillion;
	assert.deepEqual(at("mimo-v2.6-pro"), { inputTokens: 3, cacheReadTokens: 0.025, cacheWriteTokens: 0, outputTokens: 6 });
	assert.deepEqual(at("mimo-v2.6-flash"), { inputTokens: 1, cacheReadTokens: 0.02, cacheWriteTokens: 0, outputTokens: 2 });
	assert.deepEqual(at("mimo-v2.6-pro-ultraspeed"), { inputTokens: 30, cacheReadTokens: 0.25, cacheWriteTokens: 0, outputTokens: 60 });
	assert.deepEqual(at("mimo-v2.5-pro"), at("mimo-v2.6-pro"), "billed with its successor on the same page");
	assert.deepEqual(at("mimo-v2.5"), at("mimo-v2.6-flash"));
	for (const rate of MIMO_OFFICIAL_RATES) assert.equal(rate.currency, "CNY");
});

test("a typed amount tolerates a currency sign and separators, and refuses anything else", () => {
	assert.equal(normalizeManualAmount("¥36.50"), 36.5);
	assert.equal(normalizeManualAmount("￥1,234.5"), 1234.5);
	assert.equal(normalizeManualAmount(" 12 "), 12);
	assert.equal(normalizeManualAmount(0), 0);
	assert.equal(normalizeManualAmount("-3"), undefined, "a balance is not negative");
	assert.equal(normalizeManualAmount("abc"), undefined);
	assert.equal(normalizeManualAmount(""), undefined);
	assert.equal(normalizeManualAmount(undefined), undefined);
	assert.equal(normalizeManualCurrency(undefined), "CNY");
	assert.equal(normalizeManualCurrency("usd"), "USD");
	assert.equal(normalizeManualCurrency("EUR"), undefined);
});

test("only usage after the snapshot is charged, at the model's own price", () => {
	const baseline = [row("mimo-v2.6-pro", { inputTokens: 5_000_000, cacheReadTokens: 100_000_000, outputTokens: 1_000_000 })];
	const now = [
		// +1M input, +10M cache read, +0.5M output on Pro: ¥3 + ¥0.25 + ¥3 = ¥6.25
		row("mimo-v2.6-pro", { inputTokens: 6_000_000, cacheReadTokens: 110_000_000, outputTokens: 1_500_000 }),
		// A model first used after the snapshot: +2M input, +1M output on Flash: ¥2 + ¥2 = ¥4
		row("mimo-v2.6-flash", { inputTokens: 2_000_000, outputTokens: 1_000_000 })
	];
	const spent = spentBetween(baseline, now, official, "2026-10-04", "CNY");
	assert.equal(spent.cost, 10.25);
	assert.deepEqual(spent.unpricedModels, []);

	const card = manualBalanceCard({ amount: 36.44, currency: "CNY", at: 1, baseline }, now, official, "2026-10-04");
	assert.equal(card.total, 26.19);
	assert.equal(card.spentSince, 10.25);
	assert.equal(card.enteredAmount, 36.44);
	assert.equal(card.manual, true);
	assert.equal(card.fetched, true);
	assert.equal(card.isAvailable, true);
});

test("nothing used since is nothing spent, and a shrunken ledger is never a refund", () => {
	const baseline = [row("mimo-v2.6-pro", { inputTokens: 5_000_000, outputTokens: 1_000_000 })];
	assert.equal(spentBetween(baseline, baseline, official, "2026-10-04", "CNY").cost, 0);
	// A refold that lost deleted sessions' logs: totals fall below the snapshot.
	const refolded = [row("mimo-v2.6-pro", { inputTokens: 1_000_000, outputTokens: 0 })];
	assert.equal(spentBetween(baseline, refolded, official, "2026-10-04", "CNY").cost, 0);
	// One bucket fell, another grew: only the growth is charged (+1M output on
	// Pro is ¥6), the fall is not netted against it.
	const mixed = [row("mimo-v2.6-pro", { inputTokens: 1_000_000, outputTokens: 2_000_000 })];
	assert.equal(spentBetween(baseline, mixed, official, "2026-10-04", "CNY").cost, 6);
});

test("a model with no price is named, not charged as free", () => {
	const now = [row("mimo-v9-unknown", { inputTokens: 1_000_000 })];
	const card = manualBalanceCard({ amount: 10, currency: "CNY", at: 1, baseline: [] }, now, official, "2026-10-04");
	assert.equal(card.total, 10);
	assert.deepEqual(card.unpricedModels, ["mimo-v9-unknown"]);
});

test("the user's own rates win; the shipped list covers what they leave out", () => {
	const rateFor = manualRateLookup(
		[{ model: "mimo-v2.6-pro", currency: "CNY", effectiveFrom: "2026-08-01", perMillion: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 0 } }],
		MIMO_OFFICIAL_RATES
	);
	assert.equal(rateFor("mimo-v2.6-pro", "2026-10-04").perMillion.inputTokens, 10);
	assert.equal(rateFor("mimo-v2.6-flash", "2026-10-04").perMillion.inputTokens, 1);
	// A malformed user table is not a reason to lose the estimate.
	assert.equal(manualRateLookup([{ model: "" }], MIMO_OFFICIAL_RATES)("mimo-v2.6-flash", "2026-10-04").perMillion.outputTokens, 2);
});

test("the snapshot reads every route folded into the account", () => {
	const asked = [];
	const store = {
		byProviderModel: (range, site, provider) => {
			asked.push(provider);
			return [{ provider, model: "mimo-v2.6-flash", inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 3, tokens: 6 }];
		}
	};
	const snap = usageSnapshot(store, ["xiaomi", "xiaomi-tp", "xiaomi"]);
	assert.deepEqual(asked, ["xiaomi", "xiaomi-tp"]);
	assert.deepEqual(snap[0], { provider: "xiaomi", model: "mimo-v2.6-flash", inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 3 });
});
