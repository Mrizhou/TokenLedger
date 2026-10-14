import assert from "node:assert/strict";
import test from "node:test";

import {
	DEEPSEEK_OFFICIAL_RATES,
	RATE_BUCKETS,
	RateTable,
	defineRate,
	definePeriod,
	estimateCost,
	inPeriod,
	priceRows
} from "../src/pricing.js";

// A time-of-day window for the windowed-rate tests. Not DeepSeek's schedule —
// that lives in peak.js now, with weekdays and holidays a period cannot say.
const NIGHT = definePeriod({ name: "night", utcOffsetMinutes: 480, fromHour: 0.5, toHour: 8.5 });

const buckets = (o = {}) => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
	requests: 0,
	...o
});

test("a rate must declare a model, currency, effective date, and some price", () => {
	assert.throws(() => defineRate({ currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 1 } }), /model/);
	assert.throws(() => defineRate({ model: "m", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 1 } }), /currency/);
	assert.throws(() => defineRate({ model: "m", currency: "CNY", perMillion: { inputTokens: 1 } }), /effectiveFrom/);
	assert.throws(() => defineRate({ model: "m", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: {} }), /prices nothing/);
	assert.throws(
		() => defineRate({ model: "m", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: -1 } }),
		/invalid inputTokens/
	);
});

test("each bucket is priced separately", () => {
	const rate = defineRate({
		model: "v4",
		currency: "CNY",
		effectiveFrom: "2026-01-01",
		perMillion: { inputTokens: 4, cacheReadTokens: 0.4, cacheWriteTokens: 8, outputTokens: 12 }
	});
	const result = estimateCost(
		buckets({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 }),
		rate
	);
	assert.equal(result.cost, 24.4);
	assert.equal(result.currency, "CNY");
	assert.equal(result.priced, true);
});

test("an unpriced model costs null, never zero", () => {
	const result = estimateCost(buckets({ inputTokens: 5_000_000 }), undefined);
	assert.equal(result.cost, null);
	assert.equal(result.priced, false);
	assert.deepEqual(result.unpricedBuckets, [...RATE_BUCKETS]);
});

test("a partial rate names the buckets it could not price", () => {
	const rate = defineRate({
		model: "v4",
		currency: "CNY",
		effectiveFrom: "2026-01-01",
		perMillion: { inputTokens: 4, outputTokens: 12 }
	});
	const result = estimateCost(buckets({ inputTokens: 1_000_000, cacheReadTokens: 500_000 }), rate);
	assert.equal(result.cost, 4);
	assert.deepEqual(result.unpricedBuckets, ["cacheReadTokens"], "silence here would understate the bill");
});

test("a bucket the rate omits but that carried no tokens is not reported unpriced", () => {
	const rate = defineRate({ model: "v4", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 4 } });
	assert.deepEqual(estimateCost(buckets({ inputTokens: 1_000_000 }), rate).unpricedBuckets, []);
});

test("a price change does not rewrite what an earlier day cost", () => {
	const table = new RateTable([
		{ model: "v4", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 4 } },
		{ model: "v4", currency: "CNY", effectiveFrom: "2026-06-01", perMillion: { inputTokens: 2 } }
	]);
	const million = buckets({ inputTokens: 1_000_000 });
	assert.equal(estimateCost(million, table.rateFor("v4", "2026-05-31")).cost, 4);
	assert.equal(estimateCost(million, table.rateFor("v4", "2026-06-01")).cost, 2, "effective date is inclusive");
	assert.equal(estimateCost(million, table.rateFor("v4", "2026-12-31")).cost, 2);
});

test("a day before any effective date has no rate", () => {
	const table = new RateTable([
		{ model: "v4", currency: "CNY", effectiveFrom: "2026-06-01", perMillion: { inputTokens: 2 } }
	]);
	assert.equal(table.rateFor("v4", "2026-05-31"), undefined);
	assert.equal(table.rateFor("unknown-model", "2026-06-01"), undefined);
});

test("periods are anchored to a timezone, not the host clock", () => {
	const beijingNight = definePeriod({ name: "off-peak", utcOffsetMinutes: 480, fromHour: 0.5, toHour: 8.5 });
	// 2026-08-14 02:00 Beijing == 2026-08-13 18:00 UTC.
	assert.equal(inPeriod(beijingNight, Date.parse("2026-08-13T18:00:00Z")), true);
	// 2026-08-14 12:00 Beijing == 04:00 UTC.
	assert.equal(inPeriod(beijingNight, Date.parse("2026-08-14T04:00:00Z")), false);
	// Boundary: 08:30 Beijing is outside, 08:29 inside.
	assert.equal(inPeriod(beijingNight, Date.parse("2026-08-14T00:30:00Z")), false);
	assert.equal(inPeriod(beijingNight, Date.parse("2026-08-14T00:29:00Z")), true);
});

test("a period that wraps midnight is supported", () => {
	const night = definePeriod({ name: "night", utcOffsetMinutes: 0, fromHour: 23, toHour: 6 });
	assert.equal(inPeriod(night, Date.parse("2026-08-14T23:30:00Z")), true);
	assert.equal(inPeriod(night, Date.parse("2026-08-14T03:00:00Z")), true);
	assert.equal(inPeriod(night, Date.parse("2026-08-14T12:00:00Z")), false);
});

test("every shipped DeepSeek rate is a peak price with half-price off-peak, holidays included", () => {
	for (const rate of DEEPSEEK_OFFICIAL_RATES) {
		assert.deepEqual(rate.offPeak, { factor: 0.5, holidays: true }, rate.model);
	}
});

test("an offPeak rate bills off-peak phases at its factor and leaves peak and unphased usage alone", () => {
	const rate = defineRate({
		model: "m",
		currency: "CNY",
		effectiveFrom: "2026-01-01",
		perMillion: { inputTokens: 2, outputTokens: 8 },
		offPeak: { factor: 0.5 }
	});
	const usage = buckets({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
	assert.equal(estimateCost(usage, rate).cost, 10, "no phase: recorded before phases existed");
	assert.equal(estimateCost(usage, rate, "peak").cost, 10);
	assert.equal(estimateCost(usage, rate, "off").cost, 5);
	assert.equal(estimateCost(usage, rate, "holiday").cost, 5, "holidays default to off-peak");
	const gateway = defineRate({
		model: "m",
		currency: "CNY",
		effectiveFrom: "2026-01-01",
		perMillion: { inputTokens: 2, outputTokens: 8 },
		offPeak: { factor: 0.5, holidays: false }
	});
	assert.equal(estimateCost(usage, gateway, "holiday").cost, 10, "a gateway without a holiday clause bills peak");
	assert.equal(estimateCost(usage, gateway, "off").cost, 5);
	const plain = defineRate({ model: "m", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 2 } });
	assert.equal(estimateCost(usage, plain, "off").cost, 2, "a rate without offPeak ignores the phase");
});

test("offPeak is validated", () => {
	const base = { model: "m", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 1 } };
	assert.throws(() => defineRate({ ...base, offPeak: { factor: 0 } }), /offPeak.factor/);
	assert.throws(() => defineRate({ ...base, offPeak: { factor: 1.5 } }), /offPeak.factor/);
	assert.throws(() => defineRate({ ...base, offPeak: { factor: 0.5, holidays: "no" } }), /offPeak.holidays/);
});

test("priceRows prices each phase row by its own phase", () => {
	const table = new RateTable([
		{ model: "m", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 2 }, offPeak: { factor: 0.5 } }
	]);
	const priced = priceRows(
		[
			{ model: "m", phase: "peak", ...buckets({ inputTokens: 1_000_000 }) },
			{ model: "m", phase: "off", ...buckets({ inputTokens: 1_000_000 }) },
			{ model: "m", phase: "", ...buckets({ inputTokens: 1_000_000 }) }
		],
		table,
		"2026-10-14"
	);
	assert.deepEqual(priced.totals, { CNY: 5 });
});

test("a windowed rate outranks a general rate of the same date, and needs the time to apply", () => {
	const table = new RateTable([
		{ model: "v4", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 4 } },
		{
			model: "v4",
			currency: "CNY",
			effectiveFrom: "2026-01-01",
			window: NIGHT,
			perMillion: { inputTokens: 1 }
		}
	]);
	const offPeak = Date.parse("2026-08-13T17:00:00Z"); // 01:00 Beijing
	const peak = Date.parse("2026-08-14T06:00:00Z"); // 14:00 Beijing

	assert.equal(table.rateFor("v4", "2026-08-14", offPeak).perMillion.inputTokens, 1);
	assert.equal(table.rateFor("v4", "2026-08-14", peak).perMillion.inputTokens, 4);
	assert.equal(table.rateFor("v4", "2026-08-14").perMillion.inputTokens, 4, "no time given falls back to the general rate");
});

test("priceRows totals per currency and never sums across them", () => {
	const table = new RateTable([
		{ model: "v4", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 4 } },
		{ model: "gpt", currency: "USD", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 10 } }
	]);
	const { rows, totals, unpricedModels } = priceRows(
		[
			{ model: "v4", ...buckets({ inputTokens: 2_000_000 }) },
			{ model: "gpt", ...buckets({ inputTokens: 1_000_000 }) },
			{ model: "mystery", ...buckets({ inputTokens: 9_000_000 }) }
		],
		table,
		"2026-08-14"
	);
	assert.deepEqual(totals, { CNY: 8, USD: 10 });
	assert.deepEqual(unpricedModels, ["mystery"]);
	assert.equal(rows[2].cost, null);
	assert.equal(rows[2].priced, false);
});

test("costs are rounded to six decimals, not float noise", () => {
	const rate = defineRate({ model: "v4", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 0.7 } });
	assert.equal(estimateCost(buckets({ inputTokens: 3 }), rate).cost, 0.000002);
});

test("the shipped official schedule prices each day with its own generation's rates", () => {
	// DeepSeek renamed and repriced on 2026-09-10 and announced V4 Pro's
	// retirement; the retirement was reversed the next day, so 2026-09-14
	// restores V4 Pro's own prices. A day is priced with the schedule in
	// force that day, so history keeps the prices it was billed at.
	const table = new RateTable(DEEPSEEK_OFFICIAL_RATES);

	// V4 prices before the switch, V4.1 Flash prices from it.
	assert.equal(table.rateFor("deepseek-v4-flash", "2026-09-09").perMillion.inputTokens, 3.0);
	assert.equal(table.rateFor("deepseek-v4-flash", "2026-09-10").perMillion.inputTokens, 2.0);
	// The rename's new id prices from its first day.
	assert.equal(table.rateFor("deepseek-flash", "2026-09-10").perMillion.inputTokens, 2.0);
	assert.equal(table.rateFor("deepseek-flash", "2026-09-09"), undefined);
	// V4 Pro's announced retirement never took effect: its prices resume on
	// 09-14 instead of collapsing onto V4.1 Flash's.
	assert.equal(table.rateFor("deepseek-v4-pro", "2026-09-13").perMillion.inputTokens, 9.0);
	assert.equal(table.rateFor("deepseek-v4-pro", "2026-09-14").perMillion.inputTokens, 9.0);
	assert.equal(table.rateFor("deepseek-v4-pro", "2026-10-12").perMillion.inputTokens, 9.0);
	// Non-DeepSeek models stay unpriced.
	assert.equal(table.rateFor("gpt-5.6-sol", "2026-09-10"), undefined);
});

test("priceRows prices the official route through the shipped schedule", () => {
	const table = new RateTable(DEEPSEEK_OFFICIAL_RATES);
	const { totals, unpricedModels } = priceRows(
		[
			{ model: "deepseek-flash", ...buckets({ inputTokens: 1_000_000, outputTokens: 1_000_000 }) },
			{ model: "deepseek-v4-pro", ...buckets({ inputTokens: 1_000_000 }) }
		],
		table,
		"2026-09-12"
	);
	// flash: ¥2/M in + ¥8/M out on 1M each = 10; pro (pre-reversal): ¥9/M in.
	assert.deepEqual(totals, { CNY: 19 });
	assert.deepEqual(unpricedModels, []);
});

test("a partially priced row stays out of the totals and is named separately", () => {
	// The rate misses cacheReadTokens, which carried tokens: the row's cost
	// understates the truth, so it must not join the totals silently.
	const table = new RateTable([
		{ model: "full", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 2 } },
		{ model: "part", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 2 } }
	]);
	const result = priceRows(
		[
			{ model: "full", ...buckets({ inputTokens: 1_000_000 }) },
			{ model: "part", ...buckets({ inputTokens: 1_000_000, cacheReadTokens: 500_000 }) }
		],
		table,
		"2026-01-01"
	);
	assert.deepEqual(result.totals, { CNY: 2 }, "only the fully priced row joins the totals");
	assert.deepEqual(result.partialTotals, { CNY: 2 }, "the partial row's known part is kept visible, not dropped");
	assert.deepEqual(result.partialModels, ["part"]);
	assert.deepEqual(result.unpricedModels, [], "partial is not unpriced");
	assert.equal(result.rows.find((r) => r.model === "part").partial, true);
	assert.equal(result.rows.find((r) => r.model === "full").partial, false);
});

test("effectiveDates names a model's rate-change dates, ascending and deduplicated", () => {
	const table = new RateTable([
		{ model: "m", currency: "CNY", effectiveFrom: "2026-06-01", perMillion: { inputTokens: 2 } },
		{ model: "m", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 4 } },
		{ model: "m", currency: "CNY", effectiveFrom: "2026-06-01", perMillion: { inputTokens: 2 } }
	]);
	assert.deepEqual(table.effectiveDates("m"), ["2026-01-01", "2026-06-01"]);
	assert.deepEqual(table.effectiveDates("unknown"), []);
});

test("windowedModels names models whose time-of-day rates can never win here", () => {
	// No pricing entry passes timeMs, so a windowed rate is inert: rateFor
	// skips it. Naming it lets the panel say so instead of silently pricing
	// everything at the general rate.
	const table = new RateTable([
		{ model: "plain", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 4 } },
		{
			model: "peaky",
			currency: "CNY",
			effectiveFrom: "2026-01-01",
			window: NIGHT,
			perMillion: { inputTokens: 1 }
		}
	]);
	assert.deepEqual(table.windowedModels(), ["peaky"]);
	assert.deepEqual(new RateTable([]).windowedModels(), []);
});
