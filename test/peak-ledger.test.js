/**
 * Peak/off-peak phases through the ledger: the v4 -> v5 migration that keeps
 * every existing row, the fold that splits new usage by phase, and pricing
 * that bills each phase at its own price.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LedgerStore, SCHEMA_VERSION } from "../src/store.js";
import { applyUsageDelta, createUsageState } from "../src/usage.js";
import { holidaySet, phaseClassifier } from "../src/peak.js";
import { priceWithConfiguredRates } from "../src/plugin.js";

const bj = (text) => Date.parse(`${text}+08:00`);
const PEAK = bj("2026-10-14T10:00:00");
const OFF = bj("2026-10-14T19:00:00");
const SINCE = bj("2026-10-14T00:00:00");

let seq = 0;
const message = (turn, step, provider, model, usage, time) => ({
	type: "assistant/message",
	seq: seq++,
	time,
	data: { turn, step, message: { role: "assistant", source: { kind: "model", provider, model } }, usage }
});
const chunk = (turn, step, usage, time) => ({
	type: "assistant/chunk",
	seq: seq++,
	time,
	data: { turn, step, chunk: { type: "usage", usage } }
});
const phaseOf = phaseClassifier({ since: SINCE, holidays: holidaySet() });

const V4_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE session_rollups (
  sessionId TEXT NOT NULL, day TEXT NOT NULL, site TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0, cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
  reasoningTokens INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sessionId, day, site, provider, model)
) WITHOUT ROWID;
CREATE TABLE sessions (sessionId TEXT PRIMARY KEY, project TEXT NOT NULL DEFAULT '') WITHOUT ROWID;
CREATE TABLE checkpoints (
  sessionId TEXT PRIMARY KEY, consumedSeq INTEGER NOT NULL, logRevision TEXT, cursor TEXT NOT NULL,
  dshVersion TEXT, lastUsageAt INTEGER, updatedAt INTEGER NOT NULL
) WITHOUT ROWID;
INSERT INTO meta VALUES ('schemaVersion', '4');
`;

test("a v4 ledger is migrated in place: every row and checkpoint survives, unphased", () => {
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-v5-"));
	const path = join(dir, "ledger.sqlite");
	try {
		const old = new DatabaseSync(path);
		old.exec(V4_SCHEMA);
		old.prepare("INSERT INTO session_rollups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
			"lost-log", "2026-09-01", "direct", "deepseek-official", "deepseek-v4-flash", 1000, 200, 50, 0, 0, 3
		);
		old.prepare("INSERT INTO session_rollups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
			"merged", "2026-10-02", "direct", "deepseek-account", "deepseek-flash", 10, 2, 0, 0, 0, 1
		);
		old.prepare("INSERT INTO sessions VALUES (?, ?)").run("lost-log", "D:/work");
		old.prepare("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)").run("merged", 7, "r1", "{}", null, 1, 2);
		old.close();

		const before = Date.now();
		const store = LedgerStore.open(path);
		try {
			const d = store.diagnostics();
			assert.equal(d.schemaVersion, SCHEMA_VERSION);
			assert.equal(d.rollupRows, 2, "no row was dropped — a deleted log could never rebuild it");
			assert.equal(store.totals().inputTokens, 1010);
			assert.equal(store.checkpointFor("merged").consumedSeq, 7, "checkpoints survive, so nothing is re-folded");
			assert.deepEqual(store.byProject().map((r) => r.project).sort(), ["", "D:/work"]);
			assert.deepEqual(
				store.byModel({}, undefined, undefined, { phase: true }).map((r) => r.phase),
				["", ""],
				"migrated rows carry no phase and keep their old price"
			);
			assert.ok(store.phaseSince() >= before, "phases start at the migration");
		} finally {
			store.close();
		}

		const reopened = LedgerStore.open(path);
		try {
			const first = reopened.phaseSince();
			reopened.reset();
			assert.equal(reopened.phaseSince(), first, "a rebuild keeps the cut-off, so history stays unphased");
		} finally {
			reopened.close();
		}
		const raw = new DatabaseSync(path);
		assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'session_rollups_v5'").get().n, 0);
		raw.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fresh store starts keeping phases at creation", () => {
	const before = Date.now();
	const store = LedgerStore.open(":memory:");
	try {
		assert.ok(store.phaseSince() >= before);
	} finally {
		store.close();
	}
});

test("new usage is split by phase in storage and merged for display", () => {
	const store = LedgerStore.open(":memory:");
	try {
		const state = applyUsageDelta(
			createUsageState(),
			[
				message(1, 1, "deepseek-official", "deepseek-flash", { inputTokens: 100, outputTokens: 10 }, bj("2026-10-13T23:00:00")),
				message(2, 1, "deepseek-official", "deepseek-flash", { inputTokens: 200, outputTokens: 20 }, PEAK),
				message(3, 1, "deepseek-official", "deepseek-flash", { inputTokens: 300, outputTokens: 30 }, OFF)
			],
			{ phaseOf }
		);
		store.commitSession("s1", state);
		const merged = store.byModel();
		assert.equal(merged.length, 1);
		assert.equal(merged[0].inputTokens, 600);
		assert.equal(merged[0].phase, undefined, "display rows do not carry a phase");
		const split = Object.fromEntries(store.byModel({}, undefined, undefined, { phase: true }).map((r) => [r.phase, r.inputTokens]));
		assert.deepEqual(split, { "": 100, peak: 200, off: 300 });

		// Reloaded and folded on, the phased rows keep their keys.
		const next = applyUsageDelta(
			store.loadState("s1"),
			[message(4, 1, "deepseek-official", "deepseek-flash", { inputTokens: 1, outputTokens: 1 }, PEAK)],
			{ phaseOf }
		);
		store.commitSession("s1", next);
		const after = Object.fromEntries(store.byModel({}, undefined, undefined, { phase: true }).map((r) => [r.phase, r.inputTokens]));
		assert.deepEqual(after, { "": 100, peak: 201, off: 300 });
		assert.equal(store.byRoute().length, 2, "export rows: one per day/route, phases merged");
	} finally {
		store.close();
	}
});

test("a step re-reported across a phase change moves to the later phase, not counted twice", () => {
	const state = applyUsageDelta(
		createUsageState(),
		[
			chunk(1, 1, { inputTokens: 50, outputTokens: 5 }, bj("2026-10-14T11:59:30")),
			message(1, 1, "deepseek-official", "deepseek-flash", { inputTokens: 80, outputTokens: 8 }, bj("2026-10-14T12:00:30"))
		],
		{ phaseOf }
	);
	const routes = [...state.days.get("2026-10-14").routes.entries()].map(([key, b]) => [key.split("\u0000")[3] ?? "", b.inputTokens]);
	const byPhase = Object.fromEntries(routes);
	assert.equal(byPhase.off, 80);
	assert.equal(byPhase.peak ?? 0, 0);
});

test("pricing bills off-peak rows at half and leaves unphased history at peak", () => {
	const store = LedgerStore.open(":memory:");
	try {
		const million = { inputTokens: 1_000_000, outputTokens: 0 };
		const state = applyUsageDelta(
			createUsageState(),
			[
				message(1, 1, "deepseek-official", "deepseek-flash", million, bj("2026-10-13T20:00:00")),
				message(2, 1, "deepseek-official", "deepseek-flash", million, PEAK),
				message(3, 1, "deepseek-official", "deepseek-flash", million, OFF)
			],
			{ phaseOf }
		);
		store.commitSession("s1", state);
		const priced = priceWithConfiguredRates(store, {}, undefined, undefined);
		// deepseek-flash input is ¥2 peak: 2 (unphased, 10-13) + 2 (peak) + 1 (off).
		assert.deepEqual(priced.totals, { CNY: 5 });
		assert.equal(priced.rows.length, 1, "phases fold back into one row");
		assert.equal(priced.rows[0].cost, 5);
		assert.equal(priced.rows[0].phase, undefined);

		const routes = priceWithConfiguredRates(store, {}, undefined, undefined, undefined, true);
		assert.equal(routes.rows.length, 1);
		assert.equal(routes.rows[0].cost, 5);

		// A gateway rate whose rule has no holiday clause bills a holiday at peak.
		const holiday = bj("2026-10-07T10:00:00");
		const gw = LedgerStore.open(":memory:");
		try {
			gw.commitSession(
				"g",
				applyUsageDelta(createUsageState(), [message(1, 1, "commandcode", "deepseek/deepseek-v4.1-flash", million, holiday)], {
					phaseOf: phaseClassifier({ since: 0, holidays: holidaySet() })
				})
			);
			const rate = (holidays) => [
				{ model: "deepseek/deepseek-v4.1-flash", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 2.16 }, offPeak: { factor: 0.5, holidays } }
			];
			assert.deepEqual(priceWithConfiguredRates(gw, {}, undefined, rate(false)).totals, { CNY: 2.16 });
			assert.deepEqual(priceWithConfiguredRates(gw, {}, undefined, rate(true)).totals, { CNY: 1.08 });
		} finally {
			gw.close();
		}
	} finally {
		store.close();
	}
});
