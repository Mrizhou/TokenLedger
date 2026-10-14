import assert from "node:assert/strict";
import test from "node:test";

import {
	CN_HOLIDAYS,
	beijingDate,
	holidaySet,
	holidaysUntil,
	isOffPeak,
	normalizePeakConfig,
	peakView,
	phaseAt,
	phaseClassifier,
	upcomingChanges
} from "../src/peak.js";

/** An instant written in Beijing time, independent of the host's zone. */
const bj = (text) => Date.parse(`${text}+08:00`);

test("weekday window edges: 09:00 and 14:00 open peak, 12:00 and 18:00 close it", () => {
	// 2026-10-14 is a Wednesday and not a holiday.
	const cases = [
		["2026-10-14T08:59:59", "off"],
		["2026-10-14T09:00:00", "peak"],
		["2026-10-14T11:59:59", "peak"],
		["2026-10-14T12:00:00", "off"],
		["2026-10-14T13:59:59", "off"],
		["2026-10-14T14:00:00", "peak"],
		["2026-10-14T17:59:59", "peak"],
		["2026-10-14T18:00:00", "off"],
		["2026-10-14T23:30:00", "off"],
		["2026-10-15T00:30:00", "off"]
	];
	for (const [time, phase] of cases) assert.equal(phaseAt(bj(time)), phase, time);
});

test("weekends are off-peak all day, a 调休 working Saturday included", () => {
	assert.equal(phaseAt(bj("2026-10-17T10:00:00")), "off", "an ordinary Saturday");
	assert.equal(phaseAt(bj("2026-10-18T15:00:00")), "off", "an ordinary Sunday");
	assert.equal(phaseAt(bj("2026-10-10T10:00:00")), "off", "2026-10-10 is a 补班 Saturday and still a weekend");
});

test("a weekday holiday's peak hours are their own phase, so each rate can decide", () => {
	assert.equal(phaseAt(bj("2026-10-07T10:00:00")), "holiday", "国庆 Wednesday");
	assert.equal(phaseAt(bj("2026-02-23T15:00:00")), "holiday", "春节's substituted Monday");
	assert.equal(phaseAt(bj("2026-10-07T20:00:00")), "off", "outside the windows a holiday is plain off-peak");
	assert.equal(isOffPeak("holiday", true), true, "DeepSeek: holidays are off-peak");
	assert.equal(isOffPeak("holiday", false), false, "a gateway without a holiday clause");
	assert.equal(isOffPeak("off", false), true);
	assert.equal(isOffPeak("peak"), false);
	assert.equal(isOffPeak(""), false, "usage from before phases existed is never discounted");
});

test("the phase is anchored to Beijing, not the host clock", () => {
	// 01:00 UTC is 09:00 Beijing whatever zone this test runs in.
	assert.equal(phaseAt(Date.parse("2026-10-14T01:00:00Z")), "peak");
	assert.equal(phaseAt(Date.parse("2026-10-14T00:59:00Z")), "off");
	// 2026-10-16 Friday 23:00 UTC is already Saturday in Beijing.
	assert.equal(phaseAt(Date.parse("2026-10-16T23:00:00Z")), "off");
	assert.equal(beijingDate(Date.parse("2026-10-16T16:00:00Z")), "2026-10-17");
});

test("the shipped 2026 list matches the State Council notice and excludes 补班 weekends", () => {
	assert.equal(CN_HOLIDAYS.length, 33);
	for (const day of ["2026-01-01", "2026-02-15", "2026-02-23", "2026-04-06", "2026-05-05", "2026-06-19", "2026-09-25", "2026-10-07"]) {
		assert.ok(CN_HOLIDAYS.includes(day), day);
	}
	for (const day of ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"]) {
		assert.ok(!CN_HOLIDAYS.includes(day), `${day} is a working day`);
	}
	const extra = holidaySet(["2027-01-01", "garbage", 7]);
	assert.ok(extra.has("2027-01-01") && extra.has("2026-10-01") && !extra.has("garbage"));
});

test("upcoming changes skip weekends and holidays as one off-peak stretch", () => {
	const friday = upcomingChanges(bj("2026-10-16T17:00:00"));
	assert.deepEqual(friday.slice(0, 2), [
		{ at: bj("2026-10-16T18:00:00"), phase: "off" },
		{ at: bj("2026-10-19T09:00:00"), phase: "peak" }
	]);
	const beforeNationalDay = upcomingChanges(bj("2026-09-30T17:00:00"));
	assert.deepEqual(beforeNationalDay.slice(0, 2), [
		{ at: bj("2026-09-30T18:00:00"), phase: "off" },
		{ at: bj("2026-10-08T09:00:00"), phase: "peak" }
	]);
	const morning = upcomingChanges(bj("2026-10-14T08:00:00"));
	assert.deepEqual(morning.slice(0, 4).map((c) => [c.at, c.phase]), [
		[bj("2026-10-14T09:00:00"), "peak"],
		[bj("2026-10-14T12:00:00"), "off"],
		[bj("2026-10-14T14:00:00"), "peak"],
		[bj("2026-10-14T18:00:00"), "off"]
	]);
});

test("the classifier leaves usage before the cut-off unphased", () => {
	const since = bj("2026-10-14T12:30:00");
	const classify = phaseClassifier({ since, holidays: holidaySet() });
	assert.equal(classify(bj("2026-10-14T10:00:00")), "", "before phases were kept");
	assert.equal(classify(bj("2026-10-14T15:00:00")), "peak");
	assert.equal(classify(bj("2026-10-14T19:00:00")), "off");
	assert.equal(phaseClassifier({})(bj("2026-10-14T15:00:00")), "", "no cut-off, no phases");
});

test("the holiday-list reminder shows in the last ten days and after expiry", () => {
	assert.equal(holidaysUntil({}), "2026-12-31");
	assert.equal(peakView({}, bj("2026-12-21T10:00:00")).holidayNotice, undefined, "eleven days out");
	assert.deepEqual(peakView({}, bj("2026-12-22T00:00:00")).holidayNotice, { until: "2026-12-31", daysLeft: 9 });
	assert.deepEqual(peakView({}, bj("2026-12-31T23:00:00")).holidayNotice, { until: "2026-12-31", daysLeft: 0 });
	assert.deepEqual(peakView({}, bj("2027-01-03T09:00:00")).holidayNotice, { until: "2026-12-31", daysLeft: -3 });
	assert.equal(peakView({ holidays: ["2027-02-10"] }, bj("2026-12-25T10:00:00")).holidayNotice, undefined, "next year added");
	assert.deepEqual(
		peakView({ holidaysUntil: "2026-11-30", remindDays: 3 }, bj("2026-11-28T10:00:00")).holidayNotice,
		{ until: "2026-11-30", daysLeft: 2 },
		"configured date and lead"
	);
});

test("the view carries the alert settings and a DeepSeek-terms phase", () => {
	const view = peakView({ aheadMinutes: 3, target: "offpeak" }, bj("2026-10-07T10:00:00"));
	assert.equal(view.phase, "off", "a holiday is off-peak in DeepSeek's terms");
	assert.equal(view.holiday, true);
	assert.deepEqual(view.alert, { enabled: true, aheadMinutes: 3, target: "offpeak" });
	assert.ok(view.changes.length > 0);
	assert.deepEqual(normalizePeakConfig({ aheadMinutes: 0, target: "x", remindDays: 99, alert: false, holidays: "no" }), {
		alert: false,
		aheadMinutes: 5,
		target: "both",
		holidays: [],
		remindDays: 10
	});
});
