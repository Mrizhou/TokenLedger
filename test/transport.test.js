/**
 * The desktop host's dispatcher seam: 0.1.7-rc.2 installs its own undici 8
 * dispatcher under Node's built-in `fetch`, `content-encoding` is lost on the
 * way, and a gzipped relay answer reaches `readCapped` still compressed. The
 * yos relay read as `invalid-response` in the panel while the same request
 * parsed fine in a plain process.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { readBalance } from "../src/balance.js";
import { fetchNoCrossOriginRedirect, readCapped } from "../src/transport.js";

/** A Response whose body is exactly these bytes, with no content-encoding — what the seam delivers. */
const rawResponse = (bytes, status = 200) => new Response(bytes, { status, headers: { "content-type": "application/json" } });

test("credentialed requests ask for an uncompressed body by default", async () => {
	const seen = [];
	const doFetch = async (url, init) => {
		seen.push(init.headers);
		return { status: 200 };
	};
	await fetchNoCrossOriginRedirect(doFetch, "https://relay.example/api", { headers: { authorization: "Bearer k", accept: "application/json" } });
	assert.equal(seen[0]["accept-encoding"], "identity");
	assert.equal(seen[0].authorization, "Bearer k", "the credential must survive the merge");

	await fetchNoCrossOriginRedirect(doFetch, "https://relay.example/api", undefined);
	assert.equal(seen[1]["accept-encoding"], "identity");
});

test("a caller's own accept-encoding is left alone, whatever its case", async () => {
	const seen = [];
	const doFetch = async (url, init) => {
		seen.push(init.headers);
		return { status: 200 };
	};
	await fetchNoCrossOriginRedirect(doFetch, "https://relay.example/api", { headers: { "Accept-Encoding": "br" } });
	assert.deepEqual(seen[0], { "Accept-Encoding": "br" });
});

test("a gzip body that arrives undecoded is inflated; a plain body is untouched", async () => {
	const json = JSON.stringify({ data: { total_available: 2745129 } });
	assert.equal(await readCapped(rawResponse(gzipSync(json)), 1_000_000), json);
	assert.equal(await readCapped(rawResponse(Buffer.from(json)), 1_000_000), json);
});

test("inflating stays under the byte ceiling, so a small gzip bomb cannot bypass it", async () => {
	const bomb = gzipSync(Buffer.alloc(5_000_000, 0x20));
	assert.ok(bomb.length < 10_000, "the compressed form is small enough to pass the streamed check");
	await assert.rejects(readCapped(rawResponse(bomb), 1_000_000), (error) => error?.kind === "too-large");
});

test("a New API balance whose answers arrive gzipped and undecoded still reads", async () => {
	const answers = {
		"/api/usage/token/": { code: true, data: { name: "honor", total_granted: 10033092, total_used: 7287963, total_available: 2745129, unlimited_quota: false } },
		"/api/status": { data: { quota_per_unit: 500000, quota_display_type: "CNY", usd_exchange_rate: 1 } }
	};
	const doFetch = async (url) => rawResponse(gzipSync(JSON.stringify(answers[new URL(url).pathname])));
	const result = await readBalance({ scheme: "newapi", origin: "https://relay.example", apiKey: "k", fetch: doFetch });
	assert.equal(result.fetched, true, `expected a read, got ${JSON.stringify(result)}`);
	assert.equal(result.keyName, "honor");
	assert.deepEqual(result.quota, { granted: 10033092, used: 7287963, available: 2745129 });
});
