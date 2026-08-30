/** Packed companion payload and discovery contract. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("companion pack contains every public entry and canonical manifest", () => {
	const destination = mkdtempSync(join(tmpdir(), "tokenledger-blue-pack-"));
	try {
		const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: root, encoding: "utf8" });
		const packed = JSON.parse(output)[0];
		const files = new Set(packed.files.map((file) => file.path));
		for (const path of ["package.json", "blue.plugin.json", "cordis.patch.yml", "lib/index.js", "lib/model.js", "README.md", "README.zh.md"]) {
			assert.ok(files.has(path), path);
		}
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const domainPkg = JSON.parse(readFileSync(resolve(root, "../..", "package.json"), "utf8"));
		const manifest = JSON.parse(readFileSync(join(root, "blue.plugin.json"), "utf8"));
		const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
		assert.equal(pkg.blue.manifest, "./blue.plugin.json");
		assert.equal(pkg.version, "0.1.1-blue.0");
		assert.equal(domainPkg.version, pkg.version, "domain and companion candidates must move together");
		assert.equal(pkg.peerDependencies["dsh-tokenledger"], ">=0.1.1-blue.0 <0.2.0");
		assert.equal(manifest.id, pkg.name);
		assert.equal(manifest.entry, ".");
		assert.equal(manifest.compatibility.blue, ">=0.1.1-rc.2 <0.1.2");
		assert.equal(manifest.compatibility.harness, ">=0.1.1-rc.1 <0.1.2");
		assert.equal(pkg.peerDependencies["@deepseek-ai/cordis"], "^4.0.1");
		assert.equal(pkg.dependencies?.["@deepseek-ai/cordis"], undefined);
		assert.match(patch, /database:\s+!!js dshHomePath\('tokenledger\.sqlite'\)/u);
		assert.match(patch, /sweepIntervalMs:\s+60000/u);
		assert.match(patch, /sweepOnStart:\s+true/u);
	} finally {
		rmSync(destination, { recursive: true, force: true });
	}
});
