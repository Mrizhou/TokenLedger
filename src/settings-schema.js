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
		z.string().description("接口地址"),
		z.object({
			baseUrl: z.string().description("接口地址"),
			id: z.string().description("站点 ID"),
			displayName: z.string().description("显示名称"),
			type: z.string().description("中转软件类型")
		}).description("中转路由")
	]);

	// One declared window. `kind` and `minutes` are values; every other field is
	// a dotted PATH into the response body. The split is deliberate: a window's
	// name and length are facts about the plan, and everything else is a
	// location in a document only the user has seen.
	const declaredWindow = z.object({
		kind: z.string().description("窗口类型"),
		minutes: z.number().description("窗口分钟数"),
		usedPercent: z.string().description("已用百分比路径"),
		usedRatio: z.string().description("已用比例路径"),
		remainingPercent: z.string().description("剩余百分比路径"),
		used: z.string().description("已用量路径"),
		limit: z.string().description("限额路径"),
		resetsAt: z.string().description("重置时间路径"),
		resetInSeconds: z.string().description("剩余秒数路径")
	}).description("限额窗口");

	// A balance endpoint for a vendor with no built-in reader. See
	// `declarative.js` for the boundary this runs inside — in particular, the
	// request goes to the matching ACCOUNT's origin, and `origin` here is only
	// the key used to find that account.
	const declaredEndpoint = z.object({
		origin: z.string().description("站点源地址"),
		displayName: z.string().description("显示名称"),
		path: z.string().description("接口路径"),
		/** Send the key without the `Bearer` prefix, as some console APIs want. */
		raw: z.boolean().default(false).description("直接发送令牌"),
		/** Dotted paths for `total`, `granted`, `used`, `currency`, `plan`. */
		fields: z.dict(z.string()).description("响应字段路径"),
		windows: z.array(declaredWindow).description("限额窗口")
	}).description("自定义余额端点");

	return z.object({
		/**
		 * Balance or quota endpoints declared by the user, for vendors the built-in
		 * table does not cover. Consulted only where nothing else could answer, so
		 * an entry can add a vendor and can never change how a known one is read.
		 */
		endpoints: z.array(declaredEndpoint)
			.description("自定义余额端点")
			.comment("为内置读取器未覆盖的供应商配置余额或配额接口"),
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
				userId: z.number().step(1).min(1).description("用户 ID"),
				/** The 系统访问令牌; sent as a header, never echoed back out. */
				token: z.string().role("secret").description("访问令牌")
			})
		)
			.description("站点钱包凭据")
			.comment("按站点源地址保存 New API 用户 ID 和访问令牌"),
		/**
		 * Relay overrides, keyed by DSH provider route. Normally empty: sites are
		 * discovered from the host's own provider configuration. An entry here is
		 * for what discovery cannot see — a composition with no settings provider,
		 * or a provider mounted by an agent preset.
		 */
		relays: z.dict(relay)
			.description("中转路由")
			.comment("按 DSH provider route 覆盖中转站地址与类型"),
		/** Origins that are a vendor's own endpoint, so not a relay site. */
		officialOrigins: z.array(z.string())
			.description("官方站点源地址")
			.comment("这些地址属于供应商官方接口，不计为中转站"),
		/**
		 * Probe each relay to identify its software. Off by default: the answer
		 * only labels the site in diagnostics, so leaving it
		 * on means unauthenticated requests to a third party for a column nothing
		 * currently reads.
		 */
		fingerprint: z.boolean().default(false)
			.description("探测中转软件")
			.comment("向中转站发起匿名探测以识别软件类型"),
		/** Rollup database path. */
		database: z.string().default("tokenledger.sqlite")
			.description("数据库路径")
			.comment("TokenLedger 汇总数据库文件"),
		/**
		 * Fixed offset in minutes EAST of UTC that cuts the ledger's days.
		 *
		 * Unset, days are the host's LOCAL calendar — where the machine sits,
		 * which is not always where its owner's days are cut (a London-zone
		 * host read by a UTC+8 owner sees "today" seven or eight hours off).
		 * `480` cuts the ledger on Beijing days. Changing it re-keys history at
		 * the next rebuild, the same way changing the host's own zone would.
		 */
		dayOffsetMinutes: z.number().step(1).min(-840).max(840)
			.description("切日时区偏移（分钟）")
			.comment("账本按此时区切「天」；不配则按宿主机本地时区。北京填 480"),
		/** Milliseconds between background sweeps; 0 disables the timer. */
		sweepIntervalMs: z.number().step(1).min(0).default(60_000)
			.description("后台汇总间隔（毫秒）")
			.comment("设为 0 可关闭定时汇总"),
		/** Whether to sweep once at startup. */
		sweepOnStart: z.boolean().default(true).description("启动时汇总"),
		/**
		 * Rate table for cost estimation. Left unvalidated on purpose: rates are a
		 * nested, evolving shape owned by `pricing.js`, which already reports a
		 * malformed table by dropping the cost column rather than failing. A
		 * schema here would be a second, drifting definition of the same thing.
		 *
		 * Left unset, the shipped DeepSeek official CNY list prices the official
		 * route's deepseek models; other models stay unpriced. A table here
		 * always wins.
		 */
		rates: z.any()
			.description("价格表")
			.comment("用于成本估算的模型费率 JSON；不配时按 DeepSeek 官方价（峰时）估算官方路由")
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
