/**
 * The `tokenledger` user-settings namespace.
 *
 * Isolated in its own module, and loaded with a dynamic import, because it is
 * the one part of this package that needs a dependency. Everything else runs on
 * Node built-ins. If `@deepseek-ai/schemastery` is missing — a composition
 * assembled by hand, an upstream that moved it — the import fails here, the
 * plugin logs it and carries on with its entry config, and no other capability
 * is lost.
 *
 * ## Why register at all
 *
 * Two things, neither available from entry config alone:
 *
 * - configuration lands in the `settings.yaml` the user already edits, instead
 *   of in `cordis.patch.yml`, which most users never open;
 * - `watch` makes an edit take effect without restarting DSH.
 *
 * Registration is also the prerequisite for writing: `update()` only works on a
 * registered namespace, which is what lets `/tokenledger site add` persist
 * without the user opening a file at all.
 *
 * @module dsh-tokenledger/settings-schema
 */

/**
 * Build the namespace schema.
 *
 * @param z - the schemastery module's default export.
 * @returns the schema for the `tokenledger` settings section.
 */
export function buildSchema(z) {
	// A relay may be written as a bare URL — the common case, and the shortest
	// thing that can express it — or as an object when something needs
	// overriding. Both forms mean the same site.
	const relay = z.union([
		z.string(),
		z.object({
			baseUrl: z.string(),
			id: z.string(),
			displayName: z.string(),
			type: z.string()
		})
	]);

	// One declared window. `kind` and `minutes` are values; every other field is
	// a dotted PATH into the response body. The split is deliberate: a window's
	// name and length are facts about the plan, and everything else is a
	// location in a document only the user has seen.
	const declaredWindow = z.object({
		kind: z.string(),
		minutes: z.number(),
		usedPercent: z.string(),
		usedRatio: z.string(),
		remainingPercent: z.string(),
		used: z.string(),
		limit: z.string(),
		resetsAt: z.string(),
		resetInSeconds: z.string()
	});

	// A balance endpoint for a vendor with no built-in reader. See
	// `declarative.js` for the boundary this runs inside — in particular, the
	// request goes to the matching ACCOUNT's origin, and `origin` here is only
	// the key used to find that account.
	const declaredEndpoint = z.object({
		origin: z.string(),
		displayName: z.string(),
		path: z.string(),
		/** Send the key without the `Bearer` prefix, as some console APIs want. */
		raw: z.boolean().default(false),
		/** Dotted paths for `total`, `granted`, `used`, `currency`, `plan`. */
		fields: z.dict(z.string()),
		windows: z.array(declaredWindow)
	});

	return z.object({
		/**
		 * Balance or quota endpoints declared by the user, for vendors the built-in
		 * table does not cover. Consulted only where nothing else could answer, so
		 * an entry can add a vendor and can never change how a known one is read.
		 */
		endpoints: z.array(declaredEndpoint),
		/**
		 * New API console credentials, keyed by ORIGIN — one entry per relay site,
		 * written by the panel's 设置余额 dialog. `/api/user/self` reads the site
		 * user's WALLET, which every key on that site draws from, so the origin is
		 * the unit the credential actually scopes to; two routes on one site share
		 * the entry and the card.
		 */
		userAuth: z.dict(
			z.object({
				/** The numeric 用户ID from 个人设置. */
				userId: z.number().step(1).min(1),
				/** The 系统访问令牌; sent as a header, never echoed back out. */
				token: z.string()
			})
		),
		/**
		 * Relay overrides, keyed by DSH provider route. Normally empty: sites are
		 * discovered from the host's own provider configuration. An entry here is
		 * for what discovery cannot see — a composition with no settings provider,
		 * or a provider mounted by an agent preset.
		 */
		relays: z.dict(relay),
		/** Origins that are a vendor's own endpoint, so not a relay site. */
		officialOrigins: z.array(z.string()),
		/**
		 * Probe each relay to identify its software. Off by default: the answer
		 * only labels the site in diagnostics, so leaving it
		 * on means unauthenticated requests to a third party for a column nothing
		 * currently reads.
		 */
		fingerprint: z.boolean().default(false),
		/** Rollup database path. */
		database: z.string().default("tokenledger.sqlite"),
		/** Milliseconds between background sweeps; 0 disables the timer. */
		sweepIntervalMs: z.number().step(1).min(0).default(60_000),
		/** Whether to sweep once at startup. */
		sweepOnStart: z.boolean().default(true),
		/**
		 * Rate table for cost estimation. Left unvalidated on purpose: rates are a
		 * nested, evolving shape owned by `pricing.js`, which already reports a
		 * malformed table by dropping the cost column rather than failing. A
		 * schema here would be a second, drifting definition of the same thing.
		 */
		rates: z.any()
	});
}

/** The namespace this plugin owns. */
export const NAMESPACE = "tokenledger";

/**
 * Register the namespace and keep the resolved value current.
 *
 * @param settings - the `settings` service, from `ctx.get('settings')`.
 * @param base - the plugin's entry config, which becomes the composition layer
 *   beneath the user's document section.
 * @param onChange - called with each newly resolved value, including the first.
 * @returns `{ scope, value }`, or undefined if registration was not possible.
 */
export async function registerNamespace(settings, base, onChange) {
	const { default: z } = await import("@deepseek-ai/schemastery");
	const scope = settings.register(NAMESPACE, buildSchema(z), { base });
	const value = scope.get();
	onChange?.(value);
	scope.watch?.((next) => onChange?.(next));
	return {
		scope,
		value,
		remove: (route) => removeRelay(settings, route),
		// The dialog's 清除 button. Bound here, where the service is at hand —
		// the caller only ever holds the registration, not the service.
		removeUserAuth: (origin) => removeUserAuth(settings, origin)
	};
}

/**
 * Delete one relay entry.
 *
 * **`update` cannot do this.** It deep-merges its patch into the user section,
 * so handing it a map with the entry left out changes nothing — the command
 * reported success while the relay stayed in the listing, which is exactly what
 * a real install showed. Upstream names `mutate` as the removal path, and the
 * `unset` op is the only one that names a key to drop rather than a shape to
 * merge. It lives on the service rather than on the registration scope, which
 * carries only `get`/`watch`/`update`.
 *
 * @param settings - the settings service.
 * @param route - the relay's provider-route key.
 */
export async function removeRelay(settings, route) {
	if (typeof settings.mutate !== "function") {
		throw new Error("这个 settings 服务没有 mutate，删不了单个键");
	}
	await settings.mutate(NAMESPACE, [{ op: "unset", path: ["relays", route] }]);
}

/**
 * Remove one site's console credentials.
 *
 * Same reason `removeRelay` reaches for `mutate`: a deep merge cannot express
 * "this origin's entry is gone", and `unset` names the key to drop. Called by
 * the panel dialog's 清除 button.
 *
 * @param settings - the settings service.
 * @param origin - the origin whose entry goes away.
 */
export async function removeUserAuth(settings, origin) {
	if (typeof settings.mutate !== "function") {
		throw new Error("这个 settings 服务没有 mutate，删不了单个键");
	}
	await settings.mutate(NAMESPACE, [{ op: "unset", path: ["userAuth", origin] }]);
}
