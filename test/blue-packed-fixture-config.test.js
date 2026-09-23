/** Packed fixture acceptance-pin admission tests. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(packageRoot, "test/blue-packed-fixture.mjs");

function runFixture(args) {
	const result = spawnSync(process.execPath, [fixture, "--install", ...args], {
		cwd: packageRoot,
		encoding: "utf8",
		timeout: 10_000
	});
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	assert.equal(result.status, 1);
	// A blanket "stderr is empty" made this suite red for reasons that have
	// nothing to do with the fixture: any machine with `NODE_USE_ENV_PROXY`
	// set makes every node process print an experimental EnvHttpProxyAgent
	// warning. Strip known runtime noise; anything else still fails the assert.
	const stray = String(result.stderr ?? "")
		.split("\n")
		.filter(
			(line) =>
				line.trim() !== "" &&
				!/^\(node:\d+\) (\[UNDICI-EHPA\]|ExperimentalWarning)/.test(line) &&
				!/^\(Use `node --trace-warnings/.test(line)
		)
		.join("\n");
	assert.equal(stray, "");
	return JSON.parse(result.stdout);
}

test("packed fixture requires an explicit full Blue acceptance revision before packing", () => {
	for (const [args, code] of [
		[[], "FIXTURE_BLUE_REVISION_REQUIRED"],
		[["--blue-revision", "abc"], "FIXTURE_BLUE_REVISION_INVALID"]
	]) {
		const report = runFixture(args);
		assert.equal(report.valid, false);
		assert.equal(report.fixtureCleaned, true);
		assert.deepEqual(report.executed, []);
		assert.deepEqual(report.localTarballs, []);
		assert.equal(report.failures.length, 1);
		assert.equal(report.failures[0].scenario, "fixture.blue-revision-pin");
		assert.equal(report.failures[0].code, code);
		assert.equal(report.skipped.some((entry) => entry.scenario === "fixture.blue-revision-pin"), false);
		assert.match(report.reproduce, /--blue-revision <full-clean-blue-commit>/u);
	}
});
