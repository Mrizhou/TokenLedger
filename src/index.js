/**
 * TokenLedger's public surface.
 *
 * ## The rule
 *
 * This entry point exports two things and nothing else:
 *
 * 1. **The Cordis plugin contract** — `apply`, `inject`, `name`. The loader
 *    entry in `cordis.patch.yml` names the bare package, so DSH loads *this*
 *    module as the plugin and these three are what it looks for.
 * 2. **The library entry the README documents** — the usage fold and its two
 *    standard rollups, for a consumer outside DSH.
 *
 * ## Why it is this short
 *
 * It used to re-export 88 symbols, including `zeroBuckets`, `normalizeRow`,
 * `parseRouteKey`, `scoreFingerprint`. There was no line between what this
 * package promises and what happens to be defined inside it, and the cost was
 * concrete: every internal rename became a breaking change, which is what had
 * blocked cleaning up the modules underneath.
 *
 * Nothing became unreachable. The modules a consumer reaches for keep a
 * subpath export in `package.json` — `dsh-tokenledger/store`, `/balance`,
 * `/pricing`, `/usage`, `/transport`, and the rest — while the plugin's own
 * internals (`blue/*`, `dashboard-controller`, `newapi-user`,
 * `settings-schema`) stay unexported on purpose: they belong to `apply()` and
 * carry no public contract.
 *
 * @module dsh-tokenledger
 */

import { apply as applyPlugin } from "./plugin.js";

export const name = "tokenledger";
export const inject = ["sessionPersistence"];

/** Run the implementation inside an observable root-owned Cordis effect. */
export function apply(ctx, config) {
	return ctx.effect(() => {
		applyPlugin(ctx, config);
		return () => {};
	}, "TokenLedger plugin");
}

export { byModel, bySite, foldUsage } from "./usage.js";
