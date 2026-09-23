/**
 * Transport guards shared by every credentialed reader.
 *
 * Both guards exist because of demonstrated attacks, not hygiene:
 *
 * - {@link fetchNoCrossOriginRedirect} — the default `follow` sends the
 *   Authorization header wherever a redirect points, so one `302` from a
 *   hostile or compromised relay hands the user's key to a collector. The
 *   balance readers have refused cross-origin hops since the red team proved
 *   the leak; the wallet reader used a bare `fetch` and followed one in
 *   testing (its `new-api-user` header reached the attacker's sink — the
 *   Bearer survived only because undici strips it per fetch spec, which is
 *   platform behaviour, not this package's defence). Every credentialed
 *   request now takes the guarded path.
 * - {@link readCapped} — a relay answers with a body of whatever size it
 *   likes. A bare `response.json()` on a 120 MB body grew the heap from 8 MB
 *   to 367 MB in testing. Responses are read under a byte ceiling; the
 *   ceiling is what actually bounds the cost, so it streams where the runtime
 *   gives a reader and length-checks otherwise.
 *
 * These live in their own module rather than in `balance.js` so that
 * `newapi-user.js` can take them without a balance↔wallet import cycle: the
 * wallet reader is the component that most needed them and had none.
 *
 * @module dsh-tokenledger/transport
 */

/** How many hops to follow before giving up on a same-origin redirect loop. */
export const MAX_REDIRECTS = 3;

/**
 * Fetch, following redirects only while they stay on the same origin.
 *
 * A stub `fetch` in a test returns no `status` and no `headers`, so the 3xx
 * branch is simply never entered.
 */
export async function fetchNoCrossOriginRedirect(doFetch, url, init) {
	let current = url;
	for (let hop = 0; ; hop++) {
		const response = await doFetch(current, { ...init, redirect: "manual" });
		const status = response?.status;
		if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) return response;

		const location = response.headers?.get?.("location");
		if (location === undefined || location === null || location === "" || hop >= MAX_REDIRECTS) {
			throw Object.assign(new Error(`http-${status}`), { status });
		}
		const next = new URL(location, current);
		if (next.origin !== new URL(current).origin) {
			// Not a transport failure — a refusal to hand the credential over.
			throw Object.assign(new Error("cross-origin-redirect"), { kind: "cross-origin-redirect" });
		}
		current = next.href;
	}
}

/**
 * Read a response body with a byte ceiling.
 *
 * A relay or declared endpoint is not one of ours, so its answer is not
 * assumed to be a reasonable size. Streamed where the runtime gives us a
 * reader — which is what actually bounds the cost — and length-checked
 * otherwise, which at least bounds the parse.
 */
export async function readCapped(response, maxBytes) {
	const tooLarge = () => Object.assign(new Error("response-too-large"), { kind: "too-large" });

	const reader = response.body?.getReader?.();
	if (reader === undefined || reader === null) {
		// No stream to bound. Fall back to the whole text — or to the
		// pre-parsed body when the response only speaks `json()` (test doubles
		// shaped that way), same probe-and-degrade rule this package applies to
		// the harness's own seams. The ceiling still applies to whatever we end
		// up holding.
		const text = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
		if (text.length > maxBytes) throw tooLarge();
		return text;
	}

	const chunks = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel().catch(() => {});
			throw tooLarge();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** The ceiling applied when a caller names none: 1 MiB of JSON is generous. */
export const DEFAULT_MAX_BYTES = 1_000_000;
