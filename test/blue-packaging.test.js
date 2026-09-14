/** Packed single-package Blue payload and discovery contract. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("single package contains the Web plugin and canonical Blue manifest", () => {
	const destination = mkdtempSync(join(tmpdir(), "tokenledger-blue-pack-"));
	try {
		// On Windows npm is `npm.cmd`, and since Node 18.20/20.12/22 a `.cmd` file
		// cannot be spawned without a shell — both execFileSync("npm", …) and
		// execFileSync("npm.cmd", …) fail, the first with ENOENT and the second
		// with EINVAL. Go through the shell there, and quote the one argument that
		// carries a path. POSIX keeps the shell-free spawn.
		const onWindows = process.platform === "win32";
		const destinationArgument = onWindows ? `"${destination}"` : destination;
		const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destinationArgument], { cwd: root, encoding: "utf8", shell: onWindows });
		const packed = JSON.parse(output)[0];
		const files = new Set(packed.files.map((file) => file.path));
		for (const path of ["package.json", "blue.plugin.json", "cordis.patch.yml", "src/blue/index.js", "src/blue/model.js", "README.md"]) {
			assert.ok(files.has(path), path);
		}
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const manifest = JSON.parse(readFileSync(join(root, "blue.plugin.json"), "utf8"));
		const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
		assert.equal(pkg.blue.manifest, "./blue.plugin.json");
		assert.equal(pkg.version, "0.1.1-blue.0");
		assert.equal(manifest.id, pkg.name);
		assert.equal(manifest.entry, ".");
		assert.equal(manifest.compatibility.blue, ">=0.1.2-alpha.1 <0.1.2");
		assert.equal(manifest.compatibility.harness, "0.1.2-alpha.2");
		assert.equal(pkg.peerDependencies["@deepseek-ai/cordis"], "^4.0.2");
		assert.equal(pkg.dependencies?.["@deepseek-ai/cordis"], undefined);
		assert.equal(pkg.peerDependencies["dsh-tokenledger"], undefined);
		assert.match(patch, /database:\s+!!js dshHomePath\('tokenledger\.sqlite'\)/u);
		assert.match(patch, /sweepIntervalMs:\s+60000/u);
		assert.match(patch, /sweepOnStart:\s+true/u);
	} finally {
		rmSync(destination, { recursive: true, force: true });
	}
});

test("developer dogfood uses the exact published Blue CLI", () => {
	const readme = readFileSync(join(root, "README.md"), "utf8");
	assert.match(readme, /npm install --global pnpm@11 @dsh-blue\/blue-cli@0\.1\.2-alpha\.1/u);
	assert.match(readme, /blue plugin add "file:\$PWD"/u);
	assert.doesNotMatch(readme, /@dsh-blue\/blue-cli@alpha/u);
});
