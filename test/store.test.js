import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LedgerStore, SCHEMA_VERSION } from "../src/store.js";
import { applyUsageDelta, createUsageState } from "../src/usage.js";
import { RelaySiteRegistry, createSiteResolver } from "../src/relay-sites.js";

const DAY_A = Date.parse("2026-08-14T10:00:00");
const DAY_B = Date.parse("2026-08-15T10:00:00");

let seq = 0;
const ev = (type, data, time = DAY_A) => ({ type, seq: seq++, time, data });
const header = (provider, model, time = DAY_A) =>
	ev("request/header", { header: { config: { provider, model } } }, time);
const usageChunk = (turn, step, usage, time = DAY_A) =>
	ev("assistant/chunk", { turn, step, chunk: { type: "usage", usage } }, time);
const message = (turn, step, provider, model, usage, time = DAY_A) =>
	ev(
		"assistant/message",
		{ turn, step, message: { role: "assistant", source: { kind: "model", provider, model } }, usage },
		time
	);
const usage = (i, o, extra = {}) => ({ inputTokens: i, outputTokens: o, ...extra });

const withStore = (fn) => {
	const store = LedgerStore.open(":memory:");
	try {
		return fn(store);
	} finally {
		store.close();
	}
};

test("committing a session makes its totals queryable", () => {
	withStore((store) => {
		const state = applyUsageDelta(store.loadState("s1"), [
			header("deepseek", "v4"),
			message(1, 1, "deepseek", "v4", usage(100, 50))
		]);
		store.commitSession("s1", state);

		const totals = store.totals();
		assert.equal(totals.inputTokens, 100);
		assert.equal(totals.outputTokens, 50);
		assert.equal(totals.requests, 1);
		assert.equal(totals.tokens, 150);
	});
});

test("re-committing a session replaces its rows instead of adding to them", () => {
	withStore((store) => {
		const events = [header("deepseek", "v4"), message(1, 1, "deepseek", "v4", usage(100, 50))];
		for (let i = 0; i < 3; i++) {
			const state = store.loadState("s1");
			// Deliberately re-fold the SAME events every time, as a rebuild would.
			const fresh = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
			applyUsageDelta(fresh, events);
			store.commitSession("s1", fresh);
			assert.ok(state !== undefined);
		}
		assert.equal(store.totals().inputTokens, 100, "three identical folds still total one fold");
		assert.equal(store.totals().requests, 1);
	});
});

test("two sessions sum without interfering", () => {
	withStore((store) => {
		const s1 = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(s1, [message(1, 1, "deepseek", "v4", usage(100, 10))]);
		const s2 = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(s2, [message(1, 1, "deepseek", "v4", usage(200, 20))]);
		store.commitSession("s1", s1);
		store.commitSession("s2", s2);

		assert.equal(store.totals().inputTokens, 300);
		store.dropSession("s1");
		assert.equal(store.totals().inputTokens, 200);
		assert.equal(store.checkpointFor("s1"), undefined);
	});
});

test("an incremental fold across a restart equals a from-scratch fold", () => {
	const events = [
		header("deepseek", "v4"),
		usageChunk(1, 1, usage(100, 20)),
		message(1, 1, "deepseek", "v4", usage(100, 50)),
		header("ark", "flash"),
		message(2, 1, "ark", "flash", usage(300, 30), DAY_B)
	];

	const incremental = withStore((store) => {
		// Slice the log at every boundary, reloading state from the store between
		// slices exactly as a restarted collector would.
		for (let cut = 1; cut <= events.length; cut++) {
			const state = store.loadState("s1");
			const slice = events.slice(cut - 1, cut);
			applyUsageDelta(state, slice);
			store.commitSession("s1", state, { logRevision: `r${cut}` });
		}
		assert.equal(store.checkpointFor("s1").consumedSeq, events.at(-1).seq);
		assert.equal(store.checkpointFor("s1").logRevision, `r${events.length}`);
		return store.byRoute();
	});

	const wholesale = withStore((store) => {
		const state = store.loadState("s1");
		applyUsageDelta(state, events);
		store.commitSession("s1", state);
		return store.byRoute();
	});

	assert.deepEqual(incremental, wholesale, "slicing the log must not change the answer");
});

test("a replacement spanning a restart is still not double counted", () => {
	withStore((store) => {
		let state = store.loadState("s1");
		applyUsageDelta(state, [header("deepseek", "v4"), usageChunk(1, 1, usage(100, 20))]);
		store.commitSession("s1", state);
		assert.equal(store.totals().outputTokens, 20);

		// Restart: nothing survives but the store.
		state = store.loadState("s1");
		applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 50))]);
		store.commitSession("s1", state);

		const totals = store.totals();
		assert.equal(totals.outputTokens, 50, "the later sample replaced the earlier one");
		assert.equal(totals.inputTokens, 100);
		assert.equal(totals.requests, 1);
	});
});

test("the rebuild record counts rebuilds, survives reset, and only appears once there is one", () => {
	withStore((store) => {
		assert.equal(store.diagnostics().lastRebuild, undefined, "no record, no field");
		store.recordRebuildStart("x: direct -> relay", 1000);
		assert.deepEqual(store.rebuildRecord(), { count: 1, at: 1000, reason: "x: direct -> relay" });
		store.recordRebuildDone(2, 4000);
		store.reset();
		assert.deepEqual(store.diagnostics().lastRebuild, { count: 1, at: 1000, reason: "x: direct -> relay", doneAt: 4000, dropped: 2 });
		store.recordRebuildStart("again", 5000);
		assert.deepEqual(store.rebuildRecord(), { count: 2, at: 5000, reason: "again" }, "a new start clears the old outcome");
	});
});

test("a rebuild drops only the sessions whose log is gone, never one that merely failed to read", () => {
	// 2026-10-24 on a real install: a rebuild dropped rows for sessions whose
	// logs were still on disk — 19 of them, 176M tokens — because "not
	// re-committed" was the only test. Two of those logs were present and
	// unreadable (a corrupt first frame, a zero-byte file). Only a session the
	// host no longer lists at all is safe to drop.
	withStore((store) => {
		const fold = () => {
			const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
			applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 10))]);
			return state;
		};
		for (const id of ["gone", "corrupt", "ok"]) store.commitSession(id, fold());
		assert.equal(store.totals().inputTokens, 300);

		// A rebuild forgets every checkpoint, then re-commits only "ok".
		store.forgetCheckpoints();
		store.commitSession("ok", fold());

		// "corrupt" was LISTED but did not fold; "gone" was not listed at all.
		assert.equal(store.dropUnfolded(["corrupt"]), 1, "only the unlisted session is dropped");
		assert.equal(store.totals().inputTokens, 200, "the unreadable session keeps the rows its log still holds");
		assert.equal(store.checkpointFor("corrupt"), undefined, "but it has no checkpoint, so the next pass retries it");
		assert.notEqual(store.checkpointFor("ok"), undefined);
	});
});

test("the unreadable-log record appears in diagnostics only while there is something to report", () => {
	withStore((store) => {
		assert.equal(store.diagnostics().unreadableLogs, undefined, "a healthy install says nothing");
		store.recordUnreadable([{ sessionId: "s1", reason: "empty log" }], 1000);
		assert.deepEqual(store.diagnostics().unreadableLogs, {
			count: 1,
			at: 1000,
			sample: [{ sessionId: "s1", reason: "empty log" }]
		});
		store.recordUnreadable([], 2000);
		assert.equal(store.diagnostics().unreadableLogs, undefined, "a pass that read everything clears it");
	});
});

test("reset clears everything so the next pass rebuilds from seq 0", () => {
	withStore((store) => {
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 10))]);
		store.commitSession("s1", state);
		store.reset();

		assert.equal(store.totals().inputTokens, 0);
		assert.equal(store.checkpointFor("s1"), undefined);
		assert.equal(store.loadState("s1").consumedSeq, -1, "a cleared session folds from the beginning");
	});
});

test("queries group by day, model, and site, and the site filter narrows them", () => {
	withStore((store) => {
		const registry = new RelaySiteRegistry([
			{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example" },
			{ id: "sub", type: "sub2api", baseUrl: "https://api.relay-two.example" }
		]);
		const resolveSite = createSiteResolver(registry, {
			relayA: "https://api.relay-one.example/v1",
			relayB: "https://api.relay-two.example/v1",
			official: "https://api.deepseek.com"
		});
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(
			state,
			[
				message(1, 1, "relayA", "v4", usage(100, 10), DAY_A),
				message(2, 1, "relayB", "v4", usage(200, 20), DAY_A),
				message(3, 1, "official", "flash", usage(300, 30), DAY_B)
			],
			{ resolveSite }
		);
		store.commitSession("s1", state);

		assert.deepEqual(store.byDay().map((d) => [d.day, d.inputTokens]), [
			["2026-08-14", 300],
			["2026-08-15", 300]
		]);
		assert.deepEqual(store.bySite().map((s) => [s.site, s.inputTokens]).sort(), [
			["direct", 300],
			["nine", 100],
			["sub", 200]
		].sort());
		assert.deepEqual(store.byModel().map((m) => [m.model, m.inputTokens]).sort(), [
			["flash", 300],
			["v4", 300]
		].sort());
		assert.equal(store.byModel({}, "nine").length, 1);
		assert.equal(store.byModel({}, "nine")[0].inputTokens, 100);
		assert.equal(store.totals({ from: "2026-08-15" }).inputTokens, 300);
		assert.equal(store.totals({ to: "2026-08-14" }).inputTokens, 300);
		assert.equal(store.totals({}, "sub").inputTokens, 200);
		assert.equal(store.totals({}, undefined, "relayA").inputTokens, 100);
		assert.deepEqual(store.byDay({}, undefined, "official").map((d) => [d.day, d.inputTokens]), [["2026-08-15", 300]]);
		assert.deepEqual(store.bySite({}, "relayB").map((s) => [s.site, s.inputTokens]), [["sub", 200]]);
		assert.deepEqual(store.byModel({}, undefined, "official").map((m) => [m.model, m.inputTokens]), [["flash", 300]]);
		assert.deepEqual(store.byProvider({}, undefined, "relayA").map((p) => [p.provider, p.inputTokens]), [["relayA", 100]]);
		assert.equal(store.byRoute({}, undefined, "relayB")[0].inputTokens, 200);
	});
});

test("zero-valued route buckets are not persisted", () => {
	withStore((store) => {
		// A replacement that lands on another day empties the first day's route.
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(state, [header("deepseek", "v4"), usageChunk(1, 1, usage(100, 20), DAY_A)]);
		applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 50), DAY_B)]);
		store.commitSession("s1", state);

		assert.deepEqual(store.byDay().map((d) => d.day), ["2026-08-15"], "the emptied day is not stored");
		assert.equal(store.totals().outputTokens, 50);
	});
});

test("distinctRoutes is one row per route, not per unit of traffic", () => {
	// It runs on every sweep, so its size has to track the number of routes ever
	// seen rather than how much went through them.
	withStore((store) => {
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(state, [
			message(1, 1, "deepseek", "v4", usage(100, 10), DAY_A),
			message(2, 2, "deepseek", "v4", usage(200, 20), DAY_B),
			message(3, 3, "deepseek", "v4-mini", usage(5, 1), DAY_B)
		]);
		store.commitSession("s1", state, {});

		// node:sqlite hands back null-prototype rows, so compare the fields.
		const routes = store.distinctRoutes().map((r) => ({ site: r.site, provider: r.provider }));
		assert.deepEqual(routes, [{ site: "direct", provider: "deepseek" }], "three days and two models, one route");
	});
});

test("diagnostics report counts and identifiers only", () => {
	withStore((store) => {
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(state, [
			message(1, 1, "deepseek", "v4", usage(100, 10), DAY_A),
			usageChunk(9, 1, usage(7, 0), DAY_B) // no header seen for this one
		]);
		store.commitSession("s1", state, { dshVersion: "0.1.0-rc.6" });

		const d = store.diagnostics();
		assert.equal(d.schemaVersion, SCHEMA_VERSION);
		assert.equal(d.sessionsTracked, 1);
		assert.equal(d.sessionsWithUsage, 1);
		assert.equal(d.firstDay, "2026-08-14");
		assert.equal(d.lastDay, "2026-08-15");
		assert.equal(d.lastUsageAt, DAY_B, "last usage comes from the event timestamp");
		assert.equal(d.unattributedRows, 1, "the header-less sample is visible as unattributed");
		assert.equal(store.checkpointFor("s1").lastUsageAt, DAY_B, "the event timestamp survives a restart");
		assert.equal(store.checkpointFor("s1").dshVersion, "0.1.0-rc.6");
		assert.equal(JSON.stringify(d).includes("prompt"), false);
	});
});

test("csv export quotes cells that need it", () => {
	withStore((store) => {
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(state, [message(1, 1, "deepseek", 'weird,"model', usage(100, 10))]);
		store.commitSession("s1", state);

		const csv = store.exportCsv();
		const [head, row] = csv.split("\n");
		assert.equal(head.startsWith("day,site,provider,model,"), true);
		assert.ok(row.includes('"weird,""model"'), `unexpected row: ${row}`);
	});
});

test("opening a v2 database rebuilds the disposable index with the v4 checkpoint shape", () => {
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-schema-"));
	const path = join(dir, "ledger.sqlite");
	try {
		const seeded = LedgerStore.open(path);
		const state = createUsageState();
		applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 10))]);
		seeded.commitSession("s1", state);
		seeded.close();

		const old = new DatabaseSync(path);
		old.exec(`
			DROP TABLE checkpoints;
			CREATE TABLE checkpoints (
			  sessionId TEXT PRIMARY KEY, consumedSeq INTEGER NOT NULL, logRevision TEXT,
			  cursor TEXT NOT NULL, dshVersion TEXT, updatedAt INTEGER NOT NULL
			) WITHOUT ROWID;
			UPDATE meta SET value = '2' WHERE key = 'schemaVersion';
		`);
		old.prepare("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?)").run("s1", 1, "r1", "{}", null, DAY_A);
		old.close();

		const migrated = LedgerStore.open(path);
		assert.equal(migrated.diagnostics().schemaVersion, SCHEMA_VERSION);
		assert.equal(migrated.diagnostics().rollupRows, 0, "old projections are rebuilt from logs instead of altered in place");
		assert.equal(migrated.checkpointFor("s1"), undefined);
		migrated.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("opening a v3 database rebuilds projections that may contain duplicated fork seeds", () => {
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-fork-schema-"));
	const path = join(dir, "ledger.sqlite");
	try {
		const seeded = LedgerStore.open(path);
		const state = createUsageState();
		applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 10))]);
		seeded.commitSession("fork-child", state);
		seeded.close();

		const old = new DatabaseSync(path);
		old.prepare("UPDATE meta SET value = '3' WHERE key = 'schemaVersion'").run();
		old.close();

		const migrated = LedgerStore.open(path);
		assert.equal(migrated.diagnostics().schemaVersion, SCHEMA_VERSION);
		assert.equal(migrated.diagnostics().rollupRows, 0, "v3 projections are rebuilt from the seed-aware boundary");
		assert.equal(migrated.checkpointFor("fork-child"), undefined);
		migrated.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("one model served by two routes is one row by model and two rows by route", () => {
	withStore((store) => {
		const state = applyUsageDelta(store.loadState("s1"), [
			header("relayA", "flash"),
			message(1, 1, "relayA", "flash", usage(100, 10)),
			header("official", "flash"),
			message(2, 1, "official", "flash", usage(300, 20))
		]);
		store.commitSession("s1", state);

		// The model-only view stays one line: the text report and the Blue
		// renderer read this one, and a model reached through two routes is still
		// one model.
		assert.deepEqual(store.byModel().map((m) => [m.model, m.inputTokens]), [["flash", 400]]);

		// The per-route view splits it, carrying WHO served each half.
		const rows = store.byProviderModel().map((m) => [m.provider, m.model, m.inputTokens]);
		assert.deepEqual(rows, [["official", "flash", 300], ["relayA", "flash", 100]]);
		assert.equal(
			rows.reduce((sum, [, , tokens]) => sum + tokens, 0),
			400,
			"splitting by route must not lose or double-count a token"
		);
	});
});

test("a corrupted checkpoint cursor does not freeze the session", () => {
	// The cursor is JSON; a torn write or a hand edit can leave it unparsable.
	// loadState used to throw, which the sweep caught per-session forever —
	// the session froze at its old totals with one warn per sweep. Now the
	// rows stand and the tail continues from consumedSeq.
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-cursor-"));
	const path = join(dir, "ledger.sqlite");
	try {
		const store = LedgerStore.open(path);
		try {
			const state = applyUsageDelta(store.loadState("s1"), [
				header("deepseek", "v4"),
				message(1, 1, "deepseek", "v4", usage(100, 50))
			]);
			store.commitSession("s1", state);
			assert.equal(store.totals().inputTokens, 100);
			const seq = state.consumedSeq;

			// Corrupt the cursor directly, the way a torn write would.
			const raw = new DatabaseSync(path);
			raw.prepare("UPDATE checkpoints SET cursor = 'not-json{{' WHERE sessionId = 's1'").run();
			raw.close();

			const reloaded = store.loadState("s1");
			assert.equal(reloaded.consumedSeq, seq, "the tail continues from the stored seq");
			assert.equal(reloaded.lastSample, null);
			assert.equal(reloaded.currentRoute, null);
			// The rows survived: totals still read.
			assert.equal(store.totals().inputTokens, 100);
		} finally {
			store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
