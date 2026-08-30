#!/usr/bin/env node
/**
 * Independent packed-install fixture for the TokenLedger Blue companion.
 *
 * The orchestrator packs TokenLedger, the companion, and the minimum local
 * Blue renderer closure with lifecycle scripts disabled. Runtime scenarios
 * execute in a throwaway npm project and import package names only.
 *
 * @module @dsh-blue/tokenledger/packed-fixture
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const companionRoot = join(packageRoot, "packages/blue");
const argumentsList = process.argv.slice(2);
let blueRoot = process.env.BLUE_REPOSITORY;
let expectedBlueRevision;
let harnessLine;
let argumentError;
for (let index = 0; index < argumentsList.length; index += 1) {
	const value = argumentsList[index];
	if (value === "--" || value === "--install") continue;
	if (value === "--blue-root" || value === "--blue-revision" || value === "--harness-line") {
		const next = argumentsList[index + 1];
		if (next === undefined || next.startsWith("--")) argumentError = `${value} requires a value`;
		else {
			if (value === "--blue-root") blueRoot = next;
			else if (value === "--blue-revision") expectedBlueRevision = next;
			else harnessLine = next;
			index += 1;
		}
		continue;
	}
	if (value?.startsWith("--blue-root=")) blueRoot = value.slice("--blue-root=".length);
	else if (value?.startsWith("--blue-revision=")) expectedBlueRevision = value.slice("--blue-revision=".length);
	else if (value?.startsWith("--harness-line=")) harnessLine = value.slice("--harness-line=".length);
	else if (value?.startsWith("--")) argumentError = `unknown option: ${value}`;
}
blueRoot = resolve(blueRoot ?? resolve(packageRoot, "../../blue"));
const install = argumentsList.includes("--install");
const harnessSource = join(blueRoot, "packages/interaction/src/session-commands.ts");
const harnessMatch = existsSync(harnessSource)
	? /HARNESS_LINE\s*=\s*['"]([^'"]+)['"]/u.exec(readFileSync(harnessSource, "utf8"))
	: null;
const pinnedHarnessLine = harnessMatch?.[1];
const requestedHarnessLine = harnessLine ?? pinnedHarnessLine;
const reproduce = `node packages/blue/test/packed-fixture.mjs --blue-root <blue-repository> --blue-revision <full-clean-blue-commit> --install${harnessLine === undefined ? "" : ` --harness-line ${harnessLine}`}`;
const fixtureRoot = await mkdtemp(join(tmpdir(), "tokenledger-blue-fixture-"));
const tarballRoot = join(fixtureRoot, "tarballs");

const report = {
	package: "@dsh-blue/tokenledger",
	harnessLine: requestedHarnessLine ?? null,
	peerResolution: "normal",
	blueRepository: {
		expectedRevision: expectedBlueRevision ?? null,
		actualRevision: null,
		clean: false
	},
	installed: false,
	independentInstall: false,
	fixtureCleaned: false,
	localTarballs: [],
	harnessPackages: {},
	harnessPackageInstances: [],
	declared: [
		"fixture.blue-revision-pin",
		"fixture.pack-script-disabled-tarballs",
		"fixture.independent-peer-install",
		"fixture.harness-instance-closure",
		"fixture.short-lived-public-entry-probe"
	],
	executed: [],
	skipped: [],
	failures: [],
	observations: [],
	reproduce
};

class FixtureFailure extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

class FixtureStop extends Error {}

function ensure(condition, code, message) {
	if (!condition) throw new FixtureFailure(code, message);
}

function digestFile(file) {
	return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function failure(scenarioName, error, fallbackCode = "FIXTURE_SCENARIO_FAILED") {
	report.failures.push({
		package: report.package,
		scenario: scenarioName,
		code: error instanceof FixtureFailure ? error.code : fallbackCode,
		message: error instanceof Error ? error.message : String(error),
		reproduce
	});
}

async function scenario(name, callback) {
	try {
		await callback();
		report.executed.push(name);
		return true;
	} catch (error) {
		failure(name, error);
		return false;
	}
}

function packageManifest(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function packWithoutScripts(directory, packageManager) {
	const before = new Set(readdirSync(tarballRoot));
	const args = packageManager === "pnpm"
		? ["pack", "--config.ignore-scripts=true", "--pack-destination", tarballRoot]
		: ["pack", "--json", "--ignore-scripts", "--pack-destination", tarballRoot];
	execFileSync(packageManager, args, { cwd: directory, stdio: "ignore" });
	const created = readdirSync(tarballRoot).find((name) => name.endsWith(".tgz") && !before.has(name));
	ensure(created !== undefined, "FIXTURE_PACK_MISSING", `no tarball was produced for ${directory}`);
	return join(tarballRoot, created);
}

function registryMetadata(name, version) {
	const output = execFileSync("npm", ["view", `${name}@${version}`, "--json"], { encoding: "utf8" }).trim();
	return output === "" ? {} : JSON.parse(output);
}

function installedPackageInstances() {
	const instances = [];
	const visited = new Set();
	const hiddenLockPath = join(fixtureRoot, "node_modules/.package-lock.json");
	const hiddenLock = existsSync(hiddenLockPath) ? JSON.parse(readFileSync(hiddenLockPath, "utf8")) : {};
	const lockPackages = hiddenLock.packages ?? {};
	const visitPackage = (directory) => {
		if (visited.has(directory)) return;
		visited.add(directory);
		const manifestPath = join(directory, "package.json");
		if (!existsSync(manifestPath)) return;
		const value = JSON.parse(readFileSync(manifestPath, "utf8"));
		const path = relative(fixtureRoot, directory).split(sep).join("/");
		if (typeof value.name === "string" && value.name.startsWith("@deepseek-ai/dsh-")) {
			instances.push({
				name: value.name,
				version: value.version,
				path,
				integrity: lockPackages[path]?.integrity ?? null,
				packageJsonDigest: digestFile(manifestPath)
			});
		}
		visitNodeModules(join(directory, "node_modules"));
	};
	const visitNodeModules = (directory) => {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory)) {
			if (entry.startsWith(".")) continue;
			const child = join(directory, entry);
			const info = lstatSync(child);
			if (!info.isDirectory() || info.isSymbolicLink()) continue;
			if (entry.startsWith("@")) {
				for (const scopedEntry of readdirSync(child)) visitPackage(join(child, scopedEntry));
			} else visitPackage(child);
		}
	};
	visitNodeModules(join(fixtureRoot, "node_modules"));
	return instances.toSorted((left, right) => left.path.localeCompare(right.path));
}

function summarizeHarness(instances) {
	const values = new Map();
	for (const instance of instances) {
		const versions = values.get(instance.name) ?? new Set();
		versions.add(instance.version);
		values.set(instance.name, versions);
	}
	return Object.fromEntries([...values.keys()].sort().map((name) => {
		const versions = [...values.get(name)].sort();
		return [name, versions.length === 1 ? versions[0] : versions];
	}));
}

	try {
		ensure(argumentError === undefined, "FIXTURE_ARGUMENT_INVALID", argumentError ?? "");
		ensure(install, "FIXTURE_INSTALL_REQUIRED", "independent scenarios require --install");
		mkdirSync(tarballRoot, { recursive: true });
		const revisionAccepted = await scenario("fixture.blue-revision-pin", async () => {
			ensure(expectedBlueRevision !== undefined, "FIXTURE_BLUE_REVISION_REQUIRED", "--blue-revision must name the final clean Blue acceptance commit");
			ensure(/^[0-9a-f]{40}$/u.test(expectedBlueRevision), "FIXTURE_BLUE_REVISION_INVALID", "--blue-revision must be one full lowercase SHA-1 commit id");
			ensure(existsSync(join(blueRoot, "package.json")), "FIXTURE_BLUE_ROOT_MISSING", `Blue repository was not found at ${blueRoot}`);
			const actualRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: blueRoot, encoding: "utf8" }).trim();
			const status = execFileSync("git", ["status", "--porcelain"], { cwd: blueRoot, encoding: "utf8" });
			report.blueRepository.actualRevision = actualRevision;
			report.blueRepository.clean = status === "";
			ensure(actualRevision === expectedBlueRevision, "FIXTURE_BLUE_REVISION_MISMATCH", `Blue revision ${actualRevision} differs from ${expectedBlueRevision}`);
			ensure(status === "", "FIXTURE_BLUE_WORKTREE_DIRTY", "Blue repository contains uncommitted changes");
		});
		if (!revisionAccepted) throw new FixtureStop();
		ensure(
			requestedHarnessLine !== undefined && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(requestedHarnessLine),
			"FIXTURE_HARNESS_LINE_INVALID",
			`invalid Harness line: ${String(requestedHarnessLine)}`
		);

	const localDirectories = [
		{ directory: packageRoot, packageManager: "npm" },
		{ directory: companionRoot, packageManager: "npm" },
		{ directory: join(blueRoot, "packages/api"), packageManager: "pnpm" },
		{ directory: join(blueRoot, "packages/ui"), packageManager: "pnpm" },
		{ directory: join(blueRoot, "packages/frontend"), packageManager: "pnpm" },
		{ directory: join(blueRoot, "packages/core"), packageManager: "pnpm" }
	];
	const packed = new Map();
	await scenario("fixture.pack-script-disabled-tarballs", async () => {
		for (const item of localDirectories) {
			const manifest = packageManifest(item.directory);
			const tarball = packWithoutScripts(item.directory, item.packageManager);
			packed.set(manifest.name, tarball);
			report.localTarballs.push({
				name: manifest.name,
				version: manifest.version,
				file: relative(fixtureRoot, tarball).split(sep).join("/"),
				digest: digestFile(tarball),
				packageManager: item.packageManager,
				lifecycleScripts: "disabled"
			});
		}
	});

	const dependencies = Object.fromEntries([...packed].map(([name, tarball]) => [name, `file:${tarball}`]));
	const localNames = new Set(packed.keys());
	const harnessNames = new Set();
	for (const item of localDirectories) {
		const manifest = packageManifest(item.directory);
		for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
			if (!localNames.has(name)) dependencies[name] ??= range;
			if (name.startsWith("@deepseek-ai/dsh-")) harnessNames.add(name);
		}
		for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
			if (name.startsWith("@deepseek-ai/dsh-")) harnessNames.add(name);
		}
	}
	const harnessQueue = [...harnessNames];
	while (harnessQueue.length > 0) {
		const name = harnessQueue.shift();
		const metadata = registryMetadata(name, requestedHarnessLine);
		for (const dependencyName of Object.keys({
			...metadata.dependencies,
			...metadata.optionalDependencies,
			...metadata.peerDependencies
		})) {
			if (!dependencyName.startsWith("@deepseek-ai/dsh-") || harnessNames.has(dependencyName)) continue;
			harnessNames.add(dependencyName);
			harnessQueue.push(dependencyName);
		}
	}
	for (const name of harnessNames) dependencies[name] = requestedHarnessLine;
	const overrides = Object.fromEntries([...harnessNames].map((name) => [name, requestedHarnessLine]));
	writeFileSync(join(fixtureRoot, "package.json"), `${JSON.stringify({
		private: true,
		type: "module",
		dependencies,
		overrides
	}, null, 2)}\n`);

	await scenario("fixture.independent-peer-install", async () => {
		const installArguments = [
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund"
		];
		execFileSync("npm", installArguments, { cwd: fixtureRoot, stdio: "ignore" });
		report.installed = true;
		report.independentInstall = existsSync(join(fixtureRoot, "node_modules"));
		ensure(report.independentInstall, "FIXTURE_INSTALL_MISSING", "npm install produced no node_modules directory");
		for (const name of localNames) {
			const directory = join(fixtureRoot, "node_modules", ...name.split("/"));
			ensure(existsSync(join(directory, "package.json")), "FIXTURE_LOCAL_PACKAGE_MISSING", `${name} was not installed`);
			ensure(!lstatSync(directory).isSymbolicLink(), "FIXTURE_LOCAL_PACKAGE_LINKED", `${name} was linked instead of installed from a tarball`);
		}
	});

	await scenario("fixture.harness-instance-closure", async () => {
		const instances = installedPackageInstances();
		report.harnessPackageInstances.push(...instances);
		Object.assign(report.harnessPackages, summarizeHarness(instances));
		const mismatches = instances.filter((instance) => instance.version !== requestedHarnessLine);
		ensure(
			mismatches.length === 0,
			"FIXTURE_HARNESS_LINE_MISMATCH",
			`${mismatches.map((item) => `${item.name}@${item.version} at ${item.path}`).join("; ")}, expected ${requestedHarnessLine}`
		);
		for (const name of harnessNames) {
			ensure(Object.hasOwn(report.harnessPackages, name), "FIXTURE_HARNESS_PACKAGE_MISSING", `${name} was not installed`);
		}
		for (const instance of instances) {
			ensure(instance.integrity !== null, "FIXTURE_HARNESS_INTEGRITY_MISSING", `${instance.path} has no npm lockfile integrity`);
		}
	});

	await scenario("fixture.short-lived-public-entry-probe", async () => {
		const sentinel = "__TOKENLEDGER_BLUE_ENTRY_PROBE__";
		const probePath = join(fixtureRoot, ".entry-probe.mjs");
		writeFileSync(probePath, [
			`const companion = await import(${JSON.stringify("@dsh-blue/tokenledger")})`,
			`const domain = await import(${JSON.stringify("dsh-tokenledger/service")})`,
			`process.stdout.write(${JSON.stringify(sentinel)} + JSON.stringify({ name: typeof companion.name, apply: typeof companion.apply, service: typeof domain.TokenLedgerService }) + "\\n")`,
			""
		].join("\n"));
		const startedAt = Date.now();
		const probe = spawnSync(process.execPath, [probePath], {
			cwd: fixtureRoot,
			encoding: "utf8",
			timeout: 5_000,
			stdio: ["ignore", "pipe", "pipe"]
		});
		const expected = `${sentinel}{"name":"string","apply":"function","service":"function"}\n`;
		ensure(probe.error === undefined && probe.signal === null && probe.status === 0, "FIXTURE_ENTRY_PROBE_FAILED", `entry probe ended with ${probe.error?.message ?? probe.signal ?? `exit ${String(probe.status)}`}`);
		ensure(probe.stderr === "" && probe.stdout === expected, "FIXTURE_ENTRY_PROBE_STDIO", "entry probe emitted unexpected output");
		report.observations.push({ scenario: "fixture.short-lived-public-entry-probe", timeoutMs: 5_000, durationMs: Date.now() - startedAt });
	});

	if (report.failures.length === 0) {
		const runnerSource = join(companionRoot, "test/packed-fixture-runner.mjs");
		const runnerPath = join(fixtureRoot, ".tokenledger-blue-runner.mjs");
		copyFileSync(runnerSource, runnerPath);
		const runner = spawnSync(process.execPath, [runnerPath], {
			cwd: fixtureRoot,
			encoding: "utf8",
			timeout: 45_000,
			stdio: ["ignore", "pipe", "pipe"]
		});
		ensure(runner.error === undefined && runner.signal === null, "FIXTURE_RUNNER_TIMEOUT", runner.error?.message ?? String(runner.signal));
		ensure(runner.stderr === "", "FIXTURE_RUNNER_STDERR", runner.stderr);
		let runtimeReport;
		try {
			runtimeReport = JSON.parse(runner.stdout);
		} catch {
			throw new FixtureFailure("FIXTURE_RUNNER_REPORT_INVALID", "runtime fixture did not emit one JSON report");
		}
		report.declared.push(...runtimeReport.declared);
		report.executed.push(...runtimeReport.executed);
		report.skipped.push(...runtimeReport.skipped);
		report.failures.push(...runtimeReport.failures.map((item) => ({ ...item, package: report.package, reproduce })));
		report.observations.push(...runtimeReport.observations);
		ensure(runner.status === 0 && runtimeReport.valid === true, "FIXTURE_RUNNER_FAILED", `runtime fixture exited ${String(runner.status)}`);
	}
} catch (error) {
	if (!(error instanceof FixtureStop)) failure("fixture.setup", error, "FIXTURE_SETUP_FAILED");
}

for (const name of report.declared) {
	if (!report.executed.includes(name)
		&& !report.failures.some((entry) => entry.scenario === name)
		&& !report.skipped.some((entry) => entry.scenario === name)) {
		report.skipped.push({ scenario: name, reason: "scenario did not execute" });
	}
}
try {
	await rm(fixtureRoot, { recursive: true, force: true });
	report.fixtureCleaned = true;
} catch (error) {
	failure("fixture.cleanup", error, "FIXTURE_CLEANUP_FAILED");
}
const valid = report.failures.length === 0
	&& report.skipped.length === 0
	&& report.declared.length === report.executed.length
	&& report.fixtureCleaned;
process.stdout.write(`${JSON.stringify({ ...report, valid }, null, 2)}\n`);
process.exitCode = valid ? 0 : 1;
