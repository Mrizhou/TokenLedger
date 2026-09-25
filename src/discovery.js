/**
 * Learn the relay sites from the host instead of asking the user to restate
 * them.
 *
 * A user who routes DSH through a relay has already typed that relay's base URL
 * once, into the provider configuration DSH itself owns. Asking for it a second
 * time in this plugin's config is not a configuration surface, it is a defect:
 * two copies of one fact, silently drifting apart the first time one changes.
 *
 * ## The chain
 *
 * Verified against `@deepseek-ai/dsh-llm@0.1.0-rc.6` and `dsh-llm-pi-ai`:
 *
 * ```js
 * ctx.llm.listConfigurableProviders()
 * // → [{ provider, displayName, settingsNs, settingsPath, declared? }]
 * //   pi-ai answers settingsNs 'llm-pi-ai', settingsPath ['providers', route]
 *
 * ctx.settings.get(settingsNs)   // any REGISTERED namespace is readable,
 * //                                not only one's own
 * // → walk settingsPath → that route's profile → its `baseURL`
 * ```
 *
 * 0.1.7 removed `settings.get`; the same section now comes from
 * `settings.describe()` — see `sectionReader` in `balance.js`.
 *
 * ## Why the origin, and not the `declared` flag, is the key
 *
 * `declared` is upstream's word for a route "the owning adapter knows only
 * because configuration declared it — a gateway or self-hosted server it ships
 * nothing about". That is nearly our definition of a relay, and it is a useful
 * label, but it is the wrong discriminator to key on:
 *
 * - a **shipped** route can be pointed at a relay by overriding its `baseURL`
 *   (pi-ai resolves `spec.baseURL ?? base.baseUrl`), and that route reports
 *   `declared: false` while serving a relay;
 * - two declared routes — one key per model group is a common relay setup —
 *   are one site, one invoice, and must not become two rows.
 *
 * Grouping by origin gets both right, so `declared` is carried for display and
 * diagnostics only.
 *
 * ## What is deliberately not read
 *
 * A provider profile holds its credential reference beside its base URL
 * (`apiKeyEnv: z.string().role('credential-ref')`). {@link discoverSites} reads
 * exactly one field, `baseURL`. No other key of the profile is copied into a
 * site record, logged, or returned — and `RelaySiteRegistry` independently
 * rejects any record carrying `apiKey` or `token`, so this is enforced twice.
 *
 * @module dsh-tokenledger/discovery
 */

import { BUILTIN_PROVIDER_ORIGINS, sectionReader } from "./balance.js";
import { domainOf, firstString, normalizeOrigin } from "./relay-sites.js";

/**
 * The DeepSeek routes the harness ships, by the settings entry that owns each.
 * With no baseURL override both call DeepSeek's own API, so their traffic is
 * direct. `deepseek-account` (0.1.7, sign-in instead of an API key) was missing
 * here and its whole history landed in `unrouted`.
 */
const SHIPPED_DEEPSEEK_ROUTES = new Map([
	["deepseek-official", "llm-deepseek"],
	["deepseek-account", "llm-deepseek-account"]
]);

/**
 * Walk a dotted path into a resolved settings section.
 *
 * @param section - the resolved section, or anything at all.
 * @param path - path from the section root to the profile; empty means the
 *   whole section is the profile.
 * @returns the value at that path, or undefined if any hop is missing or the
 *   traversal leaves plain-object territory.
 */
export function readAtPath(section, path = []) {
	let cursor = section;
	for (const key of path) {
		if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
		cursor = cursor[key];
	}
	return cursor;
}

/**
 * Derive relay sites from the host's provider directory.
 *
 * Pure: every host interaction arrives as an argument, so the whole chain is
 * testable without booting a harness.
 *
 * @param options - `{ providers, readSection, officialOrigins?, logger? }`.
 *   `providers` is `listConfigurableProviders()`'s array; `readSection(ns)`
 *   returns a resolved settings section (or undefined); `officialOrigins` names
 *   origins that are the vendor's own endpoint and therefore not a relay.
 * @returns `{ sites, providerBaseUrls, directProviders, skipped }`. `sites` carries one entry
 *   per distinct origin, each listing the routes that reach it. `skipped`
 *   counts routes whose base URL could not be resolved — the honest reason a
 *   relay might be missing from a report.
 */
export function discoverSites(options = {}) {
	const { providers = [], readSection, officialOrigins = [] } = options;
	const official = new Set(officialOrigins.map((o) => normalizeOrigin(o)).filter(Boolean));

	// One read per namespace, not per route: pi-ai answers the same namespace
	// for every route it serves, and `get` resolves the whole document section.
	const sections = new Map();
	const readable = new Map();
	const sectionFor = (ns) => {
		if (!sections.has(ns)) {
			let value;
			let ok = true;
			try {
				value = readSection?.(ns);
			} catch {
				// A namespace this composition cannot resolve costs its routes,
				// not the discovery pass. It also costs the origin table below:
				// an unreadable profile is NOT an absent one, and asserting a
				// catalog origin for a route whose override we could not read
				// names a destination we do not know.
				value = undefined;
				ok = false;
			}
			sections.set(ns, value);
			readable.set(ns, ok);
		}
		return sections.get(ns);
	};

	const byOrigin = new Map();
	const providerBaseUrls = {};
	const directProviders = [];
	let skipped = 0;

	for (const entry of providers) {
		const route = entry?.provider;
		if (typeof route !== "string" || route === "") continue;

		const profile = readAtPath(sectionFor(entry.settingsNs), entry.settingsPath ?? []);
		// A catalog route the harness resolves by itself carries no `baseURL` in
		// its profile; the shared table is where its endpoint lives. Attribution
		// asks where the call went, not what the install set up, so the table
		// speaks for every route in it either way — gating it on a stored profile
		// kept glm traffic inside DeepSeek's `direct` row on a live install, since
		// `zai` was mounted by a preset and never configured. (`listAccounts`
		// draws a different line on purpose: the balance picker lists what is set
		// up to be read, so a route nobody configured still gets no card.) A
		// blank/junk base URL is read as absent, and an UNREADABLE namespace gets
		// no table answer at all — see `firstString` and `sectionFor`.
		const baseUrl =
			firstString(profile?.baseURL, profile?.baseUrl) ??
			(readable.get(entry.settingsNs) !== false ? BUILTIN_PROVIDER_ORIGINS.get(route) : undefined);
		if (typeof baseUrl !== "string" || baseUrl === "") {
			// A shipped catalog route with no override uses its vendor default. Keep
			// the route in the directory as explicitly direct; dropping it here made
			// the resolver later mistake that known official route for an unknown one.
			const builtInDeepSeek =
				SHIPPED_DEEPSEEK_ROUTES.get(route) === entry.settingsNs && (entry.settingsPath ?? []).length === 0;
			if (entry.declared === false || builtInDeepSeek) {
				directProviders.push(route);
				continue;
			}
			// A user-declared route without a readable profile proves neither direct
			// nor relay traffic, so leave it unresolved and make the omission visible.
			skipped++;
			continue;
		}

		const origin = normalizeOrigin(baseUrl);
		if (origin === undefined || origin === "") {
			skipped++;
			continue;
		}
		// `defineProperty`, not plain assignment: a route named `__proto__`
		// would set the prototype instead of the entry, losing its origin.
		Object.defineProperty(providerBaseUrls, route, { value: baseUrl, enumerable: true, writable: true, configurable: true });
		if (official.has(origin)) continue;

		const existing = byOrigin.get(origin);
		if (existing === undefined) {
			byOrigin.set(origin, {
				id: domainOf(baseUrl) ?? origin,
				baseUrl,
				routes: [route],
				// A site is user-declared only if every route reaching it is; one
				// shipped route pointed here makes the label wrong.
				declared: entry.declared === true,
				discovered: true
			});
		} else {
			existing.routes.push(route);
			existing.declared = existing.declared && entry.declared === true;
		}
	}

	return { sites: [...byOrigin.values()], providerBaseUrls, directProviders, skipped };
}

/**
 * Read the host's provider directory, tolerating every way it can be absent.
 *
 * `llm` and `settings` are both optional capabilities here — a composition may
 * mount neither — so this reaches for them with `ctx.get` and answers with an
 * empty discovery rather than throwing. An empty answer is a correct answer: it
 * means every request is attributed to `direct`, which is what an install with
 * no relays should report anyway.
 *
 * @param ctx - the Cordis context.
 * @param options - `{ officialOrigins? }`.
 * @returns the same shape as {@link discoverSites}, plus `available`, which
 *   distinguishes "no relays configured" from "this host cannot be asked".
 */
export function discoverFromContext(ctx, options = {}) {
	const llm = typeof ctx?.get === "function" ? ctx.get("llm") : undefined;
	const settings = typeof ctx?.get === "function" ? ctx.get("settings") : undefined;
	if (llm === undefined || settings === undefined) {
		return { sites: [], providerBaseUrls: {}, directProviders: [], skipped: 0, available: false };
	}

	let providers;
	try {
		providers = llm.listConfigurableProviders?.() ?? [];
	} catch {
		return { sites: [], providerBaseUrls: {}, directProviders: [], skipped: 0, available: false };
	}

	return {
		...discoverSites({
			providers,
			readSection: sectionReader(settings),
			officialOrigins: options.officialOrigins
		}),
		available: true
	};
}

/**
 * Fill in each site's software from what fingerprinting has already learned.
 *
 * Separate from the site objects on purpose. Those are rebuilt from scratch on
 * every sweep, so anything written onto them is lost at the next rebuild — which
 * is exactly how a detected type once survived for one interval and then read
 * "unknown" forever, with the once-only guard ensuring it was never asked again.
 * The learned answers therefore live in a map that outlives the rebuild, and are
 * re-applied here.
 *
 * @param sites - freshly built site records.
 * @param known - site id → software, from fingerprinting.
 * @returns new records; a hand-written `type` is an override and is kept.
 */
export function withKnownSoftware(sites = [], known = new Map()) {
	return sites.map((s) => (s.type === undefined ? { ...s, type: known.get(s.id) } : s));
}

/**
 * Merge discovered sites with hand-written ones.
 *
 * Manual configuration is an override, so it wins: a user who wrote a site down
 * did so because discovery got it wrong or could not see it, and having their
 * entry silently replaced by the thing they were correcting would be the worst
 * possible outcome.
 *
 * @param discovered - {@link discoverSites}' result.
 * @param manual - the normalized `relays` config.
 * @returns `{ sites, providerBaseUrls, directProviders }` ready for a site registry.
 */
export function mergeSites(discovered = {}, manual = {}) {
	const sites = new Map();
	for (const site of discovered.sites ?? []) sites.set(site.id, site);
	for (const site of manual.sites ?? []) sites.set(site.id, { ...sites.get(site.id), ...site, discovered: false });
	const providerBaseUrls = { ...(discovered.providerBaseUrls ?? {}), ...(manual.providerBaseUrls ?? {}) };
	return {
		sites: [...sites.values()],
		providerBaseUrls,
		// `Object.hasOwn`, not `in`: `in` sees the prototype chain, so a route
		// named `toString`/`constructor` was filtered out of `directProviders`
		// as "already mapped" and folded as unknown.
		directProviders: (discovered.directProviders ?? []).filter((route) => !Object.hasOwn(providerBaseUrls, route))
	};
}
