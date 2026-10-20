/**
 * tools/ledger-maintenance.mjs, run as the user runs it: a child process
 * against a real database file, with HOME pointed at a temp directory so its
 * backups never land in the real ~/.dsh.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LedgerStore } from "../src/store.js";
import { applyUsageDelta } from "../src/usage.js";

const TOOL = fileURLToPath(new URL("../tools/ledger-maintenance.mjs", import.meta.url));
const DAY = Date.parse("2026-10-20T10:00:00");

/** A ledger file with one row per `[sessionId, provider, model, site]`. */
function ledger(rows) {
	const dir = mkdtempSync(join(tmpdir(), "tokenledger-tool-"));
	const db = join(dir, "tokenledger.sqlite");
	const store = LedgerStore.open(db);
	for (const [sessionId, provider, model, site] of rows) {
		const event = {
			type: "assistant/message",
			seq: 1,
			time: DAY,
			data: { turn: 1, step: 1, message: { role: "assistant", source: { kind: "model", provider, model } }, usage: { inputTokens: 100, outputTokens: 1 } }
		};
		store.commitSession(sessionId, applyUsageDelta(store.loadState(sessionId), [event], { resolveSite: () => site }));
	}
	return { dir, db, store };
}

const run = (dir, ...args) =>
	spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { ...process.env, USERPROFILE: dir, HOME: dir } });

test("rename-model refuses without --force and prints the merge config instead", () => {
	const { dir, db, store } = ledger([["s1", "bd", "gemini-high", "cloud"]]);
	try {
		const result = run(dir, "rename-model", "--from", "gemini-high", "--to", "gemini", "--db", db, "--apply");
		assert.equal(result.status, 2);
		assert.match(result.stderr, /merge:\s+models:\s+"gemini-high": "gemini"/);
		assert.deepEqual(store.distinctModels().map((r) => r.model), ["gemini-high"], "nothing was written");
		assert.equal(existsSync(join(dir, ".dsh", "backups")), false, "nor backed up");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rename-model --force --apply renames, backs up first, and conserves the totals", () => {
	const { dir, db, store } = ledger([["s1", "bd", "gemini-high", "cloud"], ["s2", "plugin", "gemini", "cloud"]]);
	try {
		const result = run(dir, "rename-model", "--from", "gemini-high", "--to", "gemini", "--db", db, "--apply", "--force");
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(store.distinctModels().map((r) => r.model), ["gemini"]);
		assert.equal(store.totals().inputTokens, 200);
		const backups = readdirSync(join(dir, ".dsh", "backups"));
		assert.equal(backups.length, 1);
		const copy = LedgerStore.open(join(dir, ".dsh", "backups", backups[0], "tokenledger.sqlite"));
		try {
			assert.equal(copy.totals().inputTokens, 200, "the backup is a whole snapshot");
			assert.deepEqual(copy.distinctModels().map((r) => r.model).sort(), ["gemini", "gemini-high"], "taken before the rename");
		} finally {
			copy.close();
		}
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("status shows the rebuild record and a route split across two sites", () => {
	const { dir, db, store } = ledger([["s1", "relay", "m", "unrouted"], ["s2", "relay", "m", "relay.example"]]);
	try {
		store.recordRebuildStart("relay: unrouted -> relay.example", DAY);
		store.recordRebuildDone(0, DAY + 61_000);
		const result = run(dir, "status", "--db", db);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /共 1 次；.*用时 61 秒/);
		assert.match(result.stdout, /原因: relay: unrouted -> relay\.example/);
		assert.match(result.stdout, /⚠ relay: /);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
