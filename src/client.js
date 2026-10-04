/**
 * TokenLedger — browser half.
 *
 * A hand-written `__ModuleLoader__` bundle. There is deliberately **no build
 * step**: the module system materializes a registered factory and hands it a
 * synchronous `require`, so React arrives from the host and a bundler would add
 * a toolchain without adding a capability. That also means no JSX syntax — the
 * runtime's `jsx`/`jsxs` are called directly.
 *
 * ## Why it looks the way it does
 *
 * The style follows DSH itself, read from its own token file rather than from a
 * screenshot: the harness is **achromatic** (`--dsw-alias-brand-primary`
 * resolves to a neutral, not a hue), depth comes from alpha borders rather than
 * from fills — in light mode `bg-layer-1` and `bg-layer-2` are the same white —
 * radii run 12 / 8 / 6, and the type scale is tight at 11–14px. A panel built
 * to some other product's look reads as foreign inside the harness, which is
 * the whole reason this is not styled after a relay dashboard.
 *
 * Colour is reserved for state and for data. The activity strip is green
 * because green-for-activity is read at a glance; nothing else is tinted.
 *
 * ## What this file is not
 *
 * It renders; it does not compute. Every figure comes from the host half's
 * `/api/tokenledger/usage`, which serves the same store queries `/tokenledger`
 * renders — so the panel and the command have no second aggregation to drift
 * apart, and "the numbers match the command" is a meaningful test.
 *

 * ## This half loading proves nothing about the other one
 *
 * The two halves mount by different mechanisms: the browser half is found by
 * scanning installed packages for `dsh.client`, while the host half is a loader
 * entry contributed through `dsh.profile.bundles`. So every log line below can
 * print, the panel can render, and the host half can be absent entirely — which
 * has happened, and cost a day of looking in the wrong place. A healthy console
 * here is not evidence about the server. See `docs/HOST-CONTRACT.md`.
 *
 * ## Why this is one file, and has to stay one
 *
 * It is long — CSS, both dictionaries, every component, the data hooks. That
 * looks like a file begging to be split, and it cannot be. Checked against
 * `dsh-client-modules` rather than assumed:
 *
 * - The host resolves `exports["./client"]` to **one** path, reads it with
 *   `readFileSync`, and serves it as-is (`lib/index.js`). There is no bundler
 *   in the path, so one graph row is one URL is one file.
 * - The synchronous `require` handed to a factory resolves seed words, shell
 *   modules, and **already-registered factories** — it has no load branch,
 *   because loading is async (`lib/client.js`, `makeRequire`). A sibling file
 *   nothing fetched can therefore never be required; the panel would die at
 *   materialization.
 *
 * Two `load()` calls inside *this* file would work — `factories` is keyed only
 * by what was registered, with no boot-graph check — but that splits nothing.
 *
 * One thing that would break even then: `claimStyles` tags untagged `<style>`
 * elements with whichever id is materializing, for HMR bookkeeping. Injecting
 * the stylesheet from a child module would file it under the child, and
 * invalidating the panel would leave the stylesheet behind. The injection
 * belongs to the factory whose id owns it.
 *
 * A build step would dissolve all of this, and cost the property this file is
 * shaped around: with no toolchain, the browser half can be materialized and
 * tested in Node, which is what `test/client.test.js` does.
 *
 * @module dsh-tokenledger/client
 */

// Stage zero. If this line never prints, the bundle was never fetched or never
// executed, and every later explanation is beside the point — the delivery is
// what to look at, not the code. Logged unconditionally because the only
// alternative when a panel does not appear is guessing, which has cost several
// rounds already.
console.info("[tokenledger] bundle script executing (client half present)");

window.__ModuleLoader__.load({
	id: "dsh-tokenledger",
	factory: (require) => {
		console.info("[tokenledger] factory materializing");
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react;
		let jsx;
		let jsxs;
		let primitives;
		try {
			react = require("react");
			({ jsx, jsxs } = require("react/jsx-runtime"));
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			// A require that throws inside a factory takes the whole bundle down
			// with no other trace. Naming the specifier turns "the panel is missing"
			// into "this dependency is not in the graph".
			console.error("[tokenledger] a require failed; the panel cannot mount:", error);
			throw error;
		}

		// 0.1.7-rc.2 dropped the size-suffixed icons (`IconCloseOutline16`) for
		// stroke variants (`IconCloseOutlineRegular`) that take `size` as a prop.
		// An undefined element type is React #130, and inside a slot that takes
		// the whole desktop renderer down — so resolve once, newest name first,
		// and draw nothing rather than crash when a host has neither.
		const icon = (...names) => {
			for (const name of names) if (primitives[name]) return primitives[name];
			console.warn(`[tokenledger] none of ${names.join(" / ")} is exported; drawing no icon`);
			return () => null;
		};
		const IconClose = icon("IconCloseOutlineRegular", "IconCloseOutline16");
		const IconData = icon("IconDataOutlineRegular", "IconDataOutline16");
		const IconRefresh = icon("IconRefreshOutlineRegular", "IconRefreshOutline14");

		const NS = "tokenLedger";
		const USAGE_PATH = "/api/tokenledger/usage";
		const BALANCE_PATH = "/api/tokenledger/balance";
		const USERAUTH_PATH = "/api/tokenledger/userauth";
		/** A year of whole weeks; must match the host's window or the strip has holes. */
		const ACTIVITY_DAYS = 371;

		//#region style
		//
		// Injected once as a single tag. Every colour is a DSH token so the panel
		// follows whatever theme the user runs; the handful of `--tkl-*` values
		// are for what DSH has no token for, and are defined on the panel itself
		// so they cannot leak into the host.
		const css = [
			// -- the seat, beside the settings gear -------------------------------
			// `sidebar.footer.action` is a LIST slot, but its container is a
			// **nowrap row**, and every occupant so far claims `width:100%`. With
			// one action that is fine. With two, the first takes the whole column
			// and the second is laid out past the sidebar's right edge — rendered,
			// visible, `opacity: 1`, and completely off the panel. That is exactly
			// what happened here: the badge measured `x: 268` in a column ending
			// at 268, which looks identical to "the plugin never loaded".
			//
			// Shrinking alone does not fix it. The other occupant is `flex:none`
			// and will not yield, so a shrinkable item just gets squeezed to a
			// sliver still positioned after it. The container has to wrap, and
			// wrapping it is the only change that also holds when a third plugin
			// takes this seat.
			//
			// Reached through `:has()` on the slot marker rather than the
			// container's hashed CSS-module class, which is not ours to depend on.
			"div:has(> [data-slot='sidebar.footer.action']){flex-wrap:wrap}",
			// 0.1.7 moved the seat: the slot's own anchor is rendered
			// `display: contents` inside a height-bounded row, so launchers stop
			// being boxes and become flex siblings on one line — a full-row
			// launcher like this badge is then laid out of the visible seat while
			// still reporting `opacity: 1`. Give the anchor a box again and stack
			// its launchers, the same repair the desktop-era community plugin
			// ships for this exact seat (`dsh-plugin-desktop`'s
			// sidebar-footer-styles): `display: contents` must lose to an
			// explicit display, and the seat stays height-bounded so extra
			// launchers cannot swallow the workspace list.
			"body [data-slot='sidebar.footer.action']{display:flex !important;box-sizing:border-box;flex-direction:column;align-items:stretch;gap:4px;min-width:0;max-height:min(40vh,240px);overflow-y:auto;overscroll-behavior:contain}",
			"body [data-slot='sidebar.footer.action']>*{flex:none;min-width:0}",
			// Inside that column the layer's `flex: 0 0 100%` would claim the
			// container's height instead of the row's width; it keeps its own
			// height and spans the seat.
			"body [data-slot='sidebar.footer.action'] .tkl_layer{flex:0 0 auto;width:100%}",
			".tkl_layer{flex:0 0 100%;min-width:0;align-items:center;height:49px;margin:8px 0 0;display:flex;position:relative}",
			".tkl_badge{width:100%;min-width:0;height:49px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 8px 0 6px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}",
			".tkl_badge:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
			".tkl_badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}",
			// No fixed width: a 24px centring box pushed a 16px icon 4px further in
			// than the Settings row beside it, which reads as a misalignment rather
			// than as spacing. In the rail the badge itself does the centring.
			".tkl_badgeIcon{flex:none;display:inline-flex;align-items:center}",
			".tkl_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
			// 用量账本 over the current model's balance. The column keeps the
			// title where it was when there is no second line to show.
			".tkl_badgeText{display:flex;flex-direction:column;align-items:flex-start;min-width:0;text-align:left}",
			".tkl_badgeSub{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:11px;line-height:14px;text-overflow:ellipsis;white-space:nowrap;max-width:100%;overflow:hidden}",
			".tkl_badgeValue{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}",
			// Collapsed sidebar: the shell narrows to a 56px rail and every control
			// becomes a 36px circle. Without this the badge keeps its full width and
			// spills out of the rail.
			".tkl_layer.tkl_rail{flex:none;width:36px;height:36px;margin:0}",
			".tkl_layer.tkl_rail .tkl_badge{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}",
			".tkl_layer.tkl_rail .tkl_badgeText,.tkl_layer.tkl_rail .tkl_badgeValue{display:none}",

			// -- the panel ---------------------------------------------------------
			//
			// Everything that floats reaches for `--dsw-alias-bg-overlay` first.
			// `--dsw-alias-bg-base` is the PAGE's ground, and a skin that wants a
			// frosted look sets it to `transparent` — correct for the page, fatal
			// for a panel sitting on top of it, which then shows the wallpaper
			// through its own text. Themes that define no overlay token fall back
			// to the old value, so the default look is unchanged.
			//
			// The pane's solidity follows DSH's 玻璃透明度 appearance setting when
			// that token exists (`--dsw-alias-glass-opacity` — the same slider
			// that drives DSH's own menus and dialogs). DSH is itself a plugin:
			// older builds and other compositions never define the token, and
			// those fall back to a built-in frosted default instead of an opaque
			// pane — compatibility first, appearance second. No forced backdrop
			// blur in either case: with a wallpaper set, DSH frosts it itself,
			// and a second blur would fight it.
			".tkl_panel{z-index:30;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base)) var(--dsw-alias-glass-opacity,90%),transparent);width:620px;max-width:calc(100vw - 24px);max-height:76vh;box-shadow:var(--dsw-shadow-lv2);border-radius:12px;flex-direction:column;display:flex;position:fixed;bottom:128px;left:12px;overflow:hidden;" +
				// Scoped here rather than on :root so nothing escapes into the host.
				"--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);" +
				"--tkl-radius:12px;--tkl-radius-sm:8px;--tkl-radius-xs:6px;" +
				// The activity ramp: Tailwind's emerald over GitHub's neutral zero.
				// Level 0 is an alpha grey so it reads on both themes without a swap.
				"--tkl-level-0:rgba(128,128,128,0.16);--tkl-level-1:#a7f3d0;--tkl-level-2:#6ee7b7;--tkl-level-3:#34d399;--tkl-level-4:#10b981;" +
				// Categorical, mid-tone so each reads on either surface. `direct` is
				// the neutral one; the rest are the relay ramp.
				"--tkl-direct:#8b93a7;--tkl-series-0:#0ea5e9;--tkl-series-1:#f59e0b;--tkl-series-2:#8b5cf6;--tkl-series-3:#14b8a6;--tkl-series-4:#ec4899;--tkl-series-5:#84cc16}",
			"@media (prefers-color-scheme:dark){.tkl_panel{--tkl-level-1:#065f46;--tkl-level-2:#059669;--tkl-level-3:#10b981;--tkl-level-4:#34d399;--tkl-direct:#6b7280;--tkl-series-0:#38bdf8;--tkl-series-1:#fbbf24;--tkl-series-2:#a78bfa;--tkl-series-3:#2dd4bf;--tkl-series-4:#f472b6;--tkl-series-5:#a3e635}}",
			// An explicit theme choice must win over the media query in BOTH
			// directions, so each is stated rather than inherited.
			"[data-theme='dark'] .tkl_panel{--tkl-level-1:#065f46;--tkl-level-2:#059669;--tkl-level-3:#10b981;--tkl-level-4:#34d399;--tkl-direct:#6b7280;--tkl-series-0:#38bdf8;--tkl-series-1:#fbbf24;--tkl-series-2:#a78bfa;--tkl-series-3:#2dd4bf;--tkl-series-4:#f472b6;--tkl-series-5:#a3e635}",
			"[data-theme='light'] .tkl_panel{--tkl-level-1:#a7f3d0;--tkl-level-2:#6ee7b7;--tkl-level-3:#34d399;--tkl-level-4:#10b981;--tkl-direct:#8b93a7;--tkl-series-0:#0ea5e9;--tkl-series-1:#f59e0b;--tkl-series-2:#8b5cf6;--tkl-series-3:#14b8a6;--tkl-series-4:#ec4899;--tkl-series-5:#84cc16}",

			".tkl_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:transparent;flex:none;justify-content:space-between;align-items:center;min-height:44px;padding:10px 12px;display:flex;gap:8px}",
			".tkl_headerLeft{align-items:center;gap:8px;display:flex;min-width:0}",
			".tkl_title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;white-space:nowrap}",
			".tkl_headerActions{align-items:center;gap:2px;display:flex;flex:none}",
			".tkl_iconButton{cursor:pointer;width:26px;height:26px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:var(--tkl-radius-xs);justify-content:center;align-items:center;padding:0;display:inline-flex}",
			".tkl_iconButton:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".tkl_iconButton[data-busy]{opacity:.5;cursor:default}",
			".tkl_body{flex:1;min-height:0;padding:12px 14px 14px;overflow-y:auto}",
			".tkl_note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}",
			".tkl_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}",
			".tkl_retry{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-xs);margin-top:8px;padding:3px 10px;font:inherit;font-size:12px}",
			".tkl_retry:hover{background:var(--dsw-alias-interactive-bg-hover)}",

			// -- the range selector ------------------------------------------------
			// The stat cards ARE the range control, so they are buttons that read
			// as cards rather than a separate selector duplicating the same three
			// words in the header.
			".tkl_stat{cursor:pointer;font:inherit;text-align:left;transition:background .12s}",
			".tkl_stat:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".tkl_stat[data-on]{border-color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-active)}",
			".tkl_zone{color:var(--dsw-alias-label-caption);margin-left:auto;font-size:10px;line-height:16px;font-variant-numeric:tabular-nums}",
			".tkl_caption{color:var(--dsw-alias-label-tertiary);margin:6px 0 0;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",

			// -- sections ----------------------------------------------------------
			".tkl_section{margin-top:14px}",
			".tkl_section:first-child{margin-top:0}",
			".tkl_sectionTitle{color:var(--dsw-alias-label-tertiary);margin:0 0 6px;font-size:11px;line-height:16px;font-weight:500;display:flex;align-items:center;gap:4px;min-height:18px}",
			".tkl_filter{color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-interactive-bg-active);border:none;border-radius:999px;margin-left:6px;padding:1px 8px;font:inherit;font-size:11px;line-height:16px}",
			".tkl_filter:hover{color:var(--dsw-alias-label-primary)}",

			// -- stat row ----------------------------------------------------------
			".tkl_stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}",
			".tkl_stat{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-sm);padding:8px 10px;min-width:0}",
			".tkl_statValue{color:var(--dsw-alias-label-primary);font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".tkl_statLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:2px}",

			// -- the site breakdown ------------------------------------------------
			//
			// Categorical colour, and ONLY here. DSH's chrome is achromatic and the
			// panel keeps it that way; a distribution is data, and two relays drawn
			// in the same grey cannot be told apart at a glance — which is the one
			// thing this section exists to do.
			//
			// `direct` gets its own slot rather than a place in the ramp: it is not
			// a relay, and the whole point of the section is that distinction.
			".tkl_stack{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-fill-l2);margin-bottom:8px}",
			".tkl_stackSeg{height:8px;min-width:2px;transition:opacity .12s}",
			".tkl_stack[data-dim] .tkl_stackSeg:not([data-on]){opacity:.32}",
			".tkl_swatch{width:8px;height:8px;border-radius:2px;flex:none}",

			// -- generic rows (sites) ----------------------------------------------
			".tkl_rows{flex-direction:column;display:flex}",
			".tkl_row{width:100%;align-items:center;gap:8px;border:0;background:0 0;border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 4px;font:inherit;text-align:left;cursor:pointer;display:flex;border-radius:var(--tkl-radius-xs)}",
			".tkl_row:last-child{border-bottom:0}",
			// Same layout as a site row, without the affordances: projects are a
			// breakdown, not a filter, and a row that looks clickable and is not
			// is worse than one that plainly is not.
			".tkl_rowStatic{cursor:default}",
			".tkl_rowStatic:hover{background:0 0}",
			".tkl_rowPath{color:var(--dsw-alias-label-caption);font-size:10px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;min-width:0;flex:1}",
			".tkl_row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".tkl_row[data-on]{background:var(--dsw-alias-interactive-bg-active)}",
			".tkl_rowName{color:var(--dsw-alias-label-primary);flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
			".tkl_rowValue{color:var(--dsw-alias-label-primary);flex:none;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;text-align:right;min-width:64px}",
			".tkl_rowMeta{color:var(--dsw-alias-label-tertiary);flex:none;width:44px;font-size:11px;line-height:18px;font-variant-numeric:tabular-nums;text-align:right}",

			// -- activity strip ----------------------------------------------------
			// A strip, not a month grid: one row of weeks reads at a glance and
			// costs 90px instead of a viewport.
			".tkl_strip{overflow-x:auto;padding-bottom:2px;display:flex;gap:4px}",
			".tkl_weekdays{display:grid;grid-template-rows:repeat(7,12px);gap:3px;flex:none;padding-top:15px}",
			".tkl_weekday{color:var(--dsw-alias-label-caption);font-size:9px;line-height:12px;text-align:right;width:14px}",
			".tkl_stripCols{min-width:0}",
			".tkl_months{display:grid;grid-auto-flow:column;gap:3px;height:12px;margin-bottom:3px}",
			".tkl_month{color:var(--dsw-alias-label-caption);font-size:9px;line-height:12px;white-space:nowrap;overflow:visible}",
			// `grid-auto-columns` is the whole fix for the cells drifting apart:
			// without it the implicit columns are `auto` and stretch to fill the
			// panel, so twelve weeks of 12px cells spread across 430px and the
			// chart reads as a sparse scatter rather than a heatmap.
			".tkl_stripGrid{display:grid;grid-auto-flow:column;grid-auto-columns:12px;grid-template-rows:repeat(7,12px);gap:3px;justify-content:start}",
			".tkl_cell{width:12px;height:12px;border-radius:2px;background:var(--tkl-level-0);border:0;padding:0;cursor:pointer}",
			".tkl_cell:hover{outline:1px solid var(--dsw-alias-label-tertiary);outline-offset:1px}",
			".tkl_cell[data-l='1']{background:var(--tkl-level-1)}",
			".tkl_cell[data-l='2']{background:var(--tkl-level-2)}",
			".tkl_cell[data-l='3']{background:var(--tkl-level-3)}",
			".tkl_cell[data-l='4']{background:var(--tkl-level-4)}",
			".tkl_cellPad{width:12px;height:12px}",
			".tkl_legend{align-items:center;gap:3px;margin-top:5px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption);display:flex}",
			".tkl_legendSwatch{width:10px;height:10px;border-radius:2px}",

			// -- the day tooltip ---------------------------------------------------
			// A cell that only carries a `title` attribute answers "how much" after
			// a second of hovering and nothing else. The panel already has the
			// per-model split for that day, so showing it is nearly free and turns
			// the strip from decoration into something you read.
			// The tooltip floats over the panel's own content, so it needs an
			// opaque ground even more than the panel does.
			".tkl_tip{position:fixed;z-index:40;pointer-events:none;min-width:180px;max-width:250px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-sm);box-shadow:var(--dsw-shadow-lv2);padding:8px 10px}",
			// -- the trend line ----------------------------------------------------
			// One series on one axis. Its hue passes the palette checks against
			// both surfaces (lightness band, chroma, 3:1 contrast, light and dark
			// alike), so one value serves both themes; text stays in text tokens.
			".tkl_trend{--tkl-trend:#0284c7}",
			".tkl_trendControls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}",
			".tkl_trendTotal{color:var(--dsw-alias-label-tertiary);margin-left:auto;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".tkl_seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-xs);overflow:hidden}",
			".tkl_segBtn{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;padding:1px 8px;font:inherit;font-size:11px;line-height:16px}",
			".tkl_segBtn+.tkl_segBtn{border-left:1px solid var(--dsw-alias-border-l2)}",
			".tkl_segBtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".tkl_segBtn[data-on]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active)}",
			".tkl_segBtn:disabled{opacity:.45;cursor:default}",
			".tkl_trendSvg{display:block;width:100%;height:auto;overflow:visible;touch-action:none}",
			".tkl_trendGrid{stroke:var(--dsw-alias-border-l2);stroke-width:1}",
			".tkl_trendAxis{fill:var(--dsw-alias-label-caption);font-size:10px;font-variant-numeric:tabular-nums}",
			".tkl_trendLine{fill:none;stroke:var(--tkl-trend);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}",
			".tkl_trendGuide{stroke:var(--dsw-alias-label-tertiary);stroke-width:1;stroke-dasharray:2 2}",
			".tkl_trendDot{fill:var(--tkl-trend);stroke:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));stroke-width:2}",
			".tkl_trendHit{fill:transparent;cursor:crosshair}",
			".tkl_trendTip{min-width:150px}",
			".tkl_tipHead{display:flex;align-items:center;gap:6px;justify-content:space-between}",
			".tkl_tipDate{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".tkl_tipLevel{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;flex:none}",
			".tkl_tipTotal{color:var(--dsw-alias-label-primary);font-size:15px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}",
			".tkl_tipUnit{color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:400;margin-left:4px}",
			".tkl_tipModels{margin-top:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px;display:flex;flex-direction:column;gap:5px}",
			".tkl_tipRow{font-size:11px;line-height:15px}",
			".tkl_tipRowHead{display:flex;gap:6px;align-items:baseline}",
			".tkl_tipName{color:var(--dsw-alias-label-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tkl_tipValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;flex:none}",
			".tkl_tipPct{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;width:30px;text-align:right}",
			".tkl_tipBar{background:var(--dsw-alias-fill-l2);border-radius:2px;height:3px;margin-top:2px;overflow:hidden}",
			".tkl_tipBarFill{background:var(--tkl-level-4);border-radius:2px;height:3px}",
			".tkl_tipQuiet{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:6px 0 0}",

			// -- model table -------------------------------------------------------
			".tkl_table{width:100%;border-collapse:collapse;font-size:12px}",
			".tkl_table th{color:var(--dsw-alias-label-tertiary);font-weight:500;font-size:11px;line-height:16px;text-align:right;padding:0 0 5px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;cursor:pointer;user-select:none}",
			".tkl_table th:first-child{text-align:left}",
			".tkl_table th:hover{color:var(--dsw-alias-label-secondary)}",
			".tkl_table td{color:var(--dsw-alias-label-primary);text-align:right;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums;white-space:nowrap}",
			".tkl_table td:first-child{text-align:left;max-width:240px;overflow:hidden;text-overflow:ellipsis}",
			".tkl_table tr:last-child td{border-bottom:0}",
			".tkl_hit{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:3px}",
			".tkl_sortMark{color:var(--dsw-alias-label-secondary);margin-left:2px}",

			// -- balance -----------------------------------------------------------
			// One LINE per account (用户 2026-10-04「这样东西太多了 每个压缩成一行」):
			// the name, then the one figure that answers "how much is left". A
			// press opens that account's full card under its line.
			".tkl_balances{display:flex;flex-direction:column;gap:2px}",
			".tkl_balRow{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:4px 6px;border:none;border-radius:var(--tkl-radius-xs);background:0 0;cursor:pointer;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:left}",
			".tkl_balRow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".tkl_balRowMark{flex:none;width:10px;color:var(--dsw-alias-label-tertiary);font-size:9px}",
			".tkl_balRowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tkl_balRowValue{flex:none;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}",
			".tkl_balRowDim{color:var(--dsw-alias-label-tertiary);font-weight:400}",
			".tkl_balRowBad{color:var(--dsw-alias-state-warn-primary)}",
			".tkl_balItem > .tkl_balance{margin:2px 0 6px}",
			// The card is a column so quota windows can stack under the amount.
			// With no windows it holds a single child, the gap never applies, and
			// the row renders exactly as it did before they existed.
			".tkl_balance{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-sm);padding:9px 11px;display:flex;flex-direction:column;gap:9px}",
			".tkl_balanceTop{display:flex;align-items:center;gap:8px}",
			".tkl_balanceMain{min-width:0}",
			".tkl_balanceWho{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".tkl_balanceOk{color:var(--dsw-alias-state-success-primary)}",
			".tkl_balanceBad{color:var(--dsw-alias-state-warn-primary)}",
			".tkl_balanceAmount{color:var(--dsw-alias-label-primary);font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:8px}",
			".tkl_balanceMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-left:auto;text-align:right}",

			// -- the 设置余额 button and its dialog --------------------------------
			// A ghost chip sitting AFTER the balance amount: the amount is the
			// figure the card exists for, and the action that refreshes or
			// re-aims it belongs in its wake, not ahead of it.
			".tkl_setBtn{cursor:pointer;flex:none;background:var(--dsw-alias-interactive-bg-active);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;font-weight:400;line-height:16px;padding:0 8px}",
			".tkl_setBtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			// On a failed read there is no amount to follow, so the chip hangs
			// under the note instead.
			".tkl_balance > .tkl_setBtn{margin-top:8px;align-self:flex-start}",
			".tkl_dlgOverlay{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center}",
			".tkl_dlg{width:420px;max-width:calc(100vw - 32px);max-height:80vh;overflow-y:auto;box-sizing:border-box;background:color-mix(in srgb,var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base)) var(--dsw-alias-glass-opacity,90%),transparent);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--tkl-radius);box-shadow:var(--dsw-shadow-lv2);padding:14px 16px}",
			".tkl_dlgHead{display:flex;align-items:center;gap:8px;margin-bottom:8px}",
			".tkl_dlgTitle{color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:20px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tkl_steps{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;margin:0 0 10px;padding-left:18px}",
			".tkl_field{display:block;margin-bottom:10px}",
			".tkl_fieldLabel{color:var(--dsw-alias-label-secondary);display:block;font-size:11px;line-height:16px;margin-bottom:3px}",
			".tkl_input{background:var(--dsw-alias-interactive-bg-active);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-xs);box-sizing:border-box;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 8px;width:100%}",
			".tkl_input:focus{border-color:var(--dsw-alias-label-tertiary);outline:none}",
			".tkl_actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}",
			".tkl_btn{background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-xs);color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;padding:4px 12px}",
			".tkl_btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".tkl_btnPrimary{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}",
			".tkl_btnDanger{color:var(--dsw-alias-state-error-primary)}",
			".tkl_busy{cursor:default;opacity:.5}",

			// -- quota windows -------------------------------------------------------
			// A subscription's allowances: one row per window, each naming itself,
			// when it next empties, and how full it is. The percentage sits beside
			// the bar rather than inside it, so the state is legible without
			// relying on the fill colour — the colour is a second channel, never
			// the only one.
			".tkl_wins{display:flex;flex-direction:column;gap:7px}",
			".tkl_win{display:flex;flex-direction:column;gap:3px}",
			".tkl_winHead{display:flex;align-items:baseline;gap:6px;min-width:0}",
			".tkl_winName{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}",
			".tkl_winReset{color:var(--dsw-alias-label-caption);font-size:10px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tkl_winPct{color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;margin-left:auto;flex:none}",
			".tkl_winBar{height:4px;border-radius:999px;background:var(--tkl-level-0);overflow:hidden}",
			// The three states reuse DSH's own state tokens rather than inventing
			// colours, so they follow whatever the active theme or skin decided
			// those states should look like.
			".tkl_winFill{height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary)}",
			".tkl_winFill.tkl_winWarn{background:var(--dsw-alias-state-warn-primary)}",
			".tkl_winFill.tkl_winFull{background:var(--dsw-alias-state-error-primary)}",

			// -- footer ------------------------------------------------------------
			".tkl_footer{color:var(--dsw-alias-label-caption);border-top:1px solid var(--dsw-alias-border-l1);margin-top:14px;padding-top:8px;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".tkl_warn{color:var(--dsw-alias-state-warn-primary)}",

			// -- skeleton ----------------------------------------------------------
			".tkl_skel{background:var(--dsw-alias-bg-skeleton);border-radius:var(--tkl-radius-xs);height:12px;animation:tkl_pulse 1.4s ease-in-out infinite}",
			".tkl_skelStat{height:52px;border-radius:var(--tkl-radius-sm)}",
			"@keyframes tkl_pulse{0%,100%{opacity:1}50%{opacity:.45}}",
			"@media (prefers-reduced-motion:reduce){.tkl_skel{animation:none}}"
		].join("");

		const STYLE_ID = "dsh-tokenledger/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-tokenledger";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const S = {
			layer: "tkl_layer",
			rail: "tkl_rail",
			badge: "tkl_badge",
			badgeIcon: "tkl_badgeIcon",
			badgeLabel: "tkl_badgeLabel",
			badgeText: "tkl_badgeText",
			badgeSub: "tkl_badgeSub",
			badgeValue: "tkl_badgeValue",
			panel: "tkl_panel",
			header: "tkl_header",
			headerLeft: "tkl_headerLeft",
			title: "tkl_title",
			headerActions: "tkl_headerActions",
			iconButton: "tkl_iconButton",
			body: "tkl_body",
			note: "tkl_note",
			error: "tkl_error",
			retry: "tkl_retry",
			zone: "tkl_zone",
			caption: "tkl_caption",
			section: "tkl_section",
			sectionTitle: "tkl_sectionTitle",
			filter: "tkl_filter",
			stats: "tkl_stats",
			stat: "tkl_stat",
			statValue: "tkl_statValue",
			statLabel: "tkl_statLabel",
			stack: "tkl_stack",
			stackSeg: "tkl_stackSeg",
			swatch: "tkl_swatch",
			rows: "tkl_rows",
			row: "tkl_row",
			rowStatic: "tkl_rowStatic",
			rowPath: "tkl_rowPath",
			rowName: "tkl_rowName",
			rowValue: "tkl_rowValue",
			rowMeta: "tkl_rowMeta",
			strip: "tkl_strip",
			weekdays: "tkl_weekdays",
			weekday: "tkl_weekday",
			stripCols: "tkl_stripCols",
			months: "tkl_months",
			month: "tkl_month",
			stripGrid: "tkl_stripGrid",
			tip: "tkl_tip",
			trend: "tkl_trend",
			trendControls: "tkl_trendControls",
			trendTotal: "tkl_trendTotal",
			trendSvg: "tkl_trendSvg",
			trendGrid: "tkl_trendGrid",
			trendAxis: "tkl_trendAxis",
			trendLine: "tkl_trendLine",
			trendGuide: "tkl_trendGuide",
			trendDot: "tkl_trendDot",
			trendHit: "tkl_trendHit",
			trendTip: "tkl_trendTip",
			seg: "tkl_seg",
			segBtn: "tkl_segBtn",
			tipHead: "tkl_tipHead",
			tipDate: "tkl_tipDate",
			tipLevel: "tkl_tipLevel",
			tipTotal: "tkl_tipTotal",
			tipUnit: "tkl_tipUnit",
			tipModels: "tkl_tipModels",
			tipRow: "tkl_tipRow",
			tipRowHead: "tkl_tipRowHead",
			tipName: "tkl_tipName",
			tipValue: "tkl_tipValue",
			tipPct: "tkl_tipPct",
			tipBar: "tkl_tipBar",
			tipBarFill: "tkl_tipBarFill",
			tipQuiet: "tkl_tipQuiet",
			cell: "tkl_cell",
			cellPad: "tkl_cellPad",
			legend: "tkl_legend",
			legendSwatch: "tkl_legendSwatch",
			table: "tkl_table",
			hit: "tkl_hit",
			sortMark: "tkl_sortMark",
			balances: "tkl_balances",
			balItem: "tkl_balItem",
			balRow: "tkl_balRow",
			balRowMark: "tkl_balRowMark",
			balRowName: "tkl_balRowName",
			balRowValue: "tkl_balRowValue",
			balRowDim: "tkl_balRowDim",
			balRowBad: "tkl_balRowBad",
			balance: "tkl_balance",
			balanceTop: "tkl_balanceTop",
			balanceMain: "tkl_balanceMain",
			balanceWho: "tkl_balanceWho",
			balanceOk: "tkl_balanceOk",
			balanceBad: "tkl_balanceBad",
			balanceAmount: "tkl_balanceAmount",
			balanceMeta: "tkl_balanceMeta",
			setBtn: "tkl_setBtn",
			dlgOverlay: "tkl_dlgOverlay",
			dlg: "tkl_dlg",
			dlgHead: "tkl_dlgHead",
			dlgTitle: "tkl_dlgTitle",
			steps: "tkl_steps",
			field: "tkl_field",
			fieldLabel: "tkl_fieldLabel",
			input: "tkl_input",
			actions: "tkl_actions",
			btn: "tkl_btn",
			btnPrimary: "tkl_btnPrimary",
			btnDanger: "tkl_btnDanger",
			busy: "tkl_busy",
			wins: "tkl_wins",
			win: "tkl_win",
			winHead: "tkl_winHead",
			winName: "tkl_winName",
			winReset: "tkl_winReset",
			winPct: "tkl_winPct",
			winBar: "tkl_winBar",
			winFill: "tkl_winFill",
			winWarn: "tkl_winWarn",
			winFull: "tkl_winFull",
			footer: "tkl_footer",
			warn: "tkl_warn",
			skel: "tkl_skel",
			skelStat: "tkl_skelStat"
		};
		//#endregion

		//#region data

		/**
		 * The three windows, which are also the range control.
		 *
		 * A separate selector in the header made you change it three times to
		 * read three numbers everyone wants at once. Showing the windows as
		 * cards answers all three at a glance and doubles as the switch for
		 * everything below.
		 *
		 * `days` is what the request asks for; the card's own figure comes from
		 * the payload's `windows`, so all three are correct whichever is active.
		 */
		const RANGES = [
			{ id: "today", key: "today", days: () => 1 },
			// Day-of-month, so "this month" means the calendar month rather than
			// a rolling thirty days.
			{ id: "month", key: "month", days: () => new Date().getDate() },
			{ id: "all", key: "all", days: () => undefined }
		];

		/** Thousands separators plus tabular figures; an absent count is an em dash. */
		function fmt(value) {
			return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";
		}

		/**
		 * Compact token units — big figures must stay readable at 12px, and a
		 * bare sixteen-digit number reads as noise. 1.33B / 27.69M / 862.4K / 1234.
		 */
		function fmtCompact(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			const abs = Math.abs(value);
			if (abs >= 1e9) return `${trimZeros((value / 1e9).toFixed(2))}B`;
			if (abs >= 1e6) return `${trimZeros((value / 1e6).toFixed(2))}M`;
			if (abs >= 1e3) return `${trimZeros((value / 1e3).toFixed(1))}K`;
			return value.toLocaleString();
		}

		function trimZeros(text) {
			return text.replace(/\.0+$|(\.[0-9]*[1-9])0+$/, "$1");
		}

		/** Percentage of a whole, guarding the zero denominator. */
		function share(part, whole) {
			return typeof part === "number" && typeof whole === "number" && whole > 0 ? (part / whole) * 100 : 0;
		}

		/** A cache hit rate as text; `null` is "no prompt tokens", not "0%". */
		function fmtHit(rate) {
			return typeof rate === "number" && Number.isFinite(rate) ? `${rate}%` : "";
		}

		/** Money with its own currency symbol, or an em dash when unpriced. */
		function fmtMoney(amount, currency) {
			if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
			const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
			const text = amount.toFixed(amount < 1 ? 4 : 2);
			return symbol === "" ? `${text} ${currency ?? ""}`.trim() : `${symbol}${text}`;
		}

		async function fetchJson(path, signal) {
			// The write header on every call: the panel's `force=1` and the
			// userauth POST are write-class requests the host refuses without
			// it, which is what keeps a drive-by web page from spending the
			// wallet's throttle budget or planting a token through this local
			// surface (red-team proven before this gate existed).
			const response = await fetch(path, { headers: { accept: "application/json", "x-tokenledger": "1" }, signal });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			if (payload === null || typeof payload !== "object" || payload.ok !== true) {
				throw new Error("unexpected response");
			}
			return payload;
		}

		/** `?days=&site=`, mirroring the command's two arguments. */
		function buildQuery(days, site) {
			const parts = [];
			if (days !== undefined) parts.push(`days=${days}`);
			if (site !== undefined && site !== "") parts.push(`site=${encodeURIComponent(site)}`);
			return parts.length === 0 ? "" : `?${parts.join("&")}`;
		}

		function fetchUsage(days, site, signal) {
			return fetchJson(USAGE_PATH + buildQuery(days, site), signal);
		}

		/**
		 * Load the payload for a range, cancelling whatever is in flight.
		 *
		 * A stale response must never paint over a newer one: switching ranges
		 * quickly is the normal way to use this panel, and without the abort the
		 * slower of two requests wins whenever it happens to land last.
		 */
		function useUsage(open, days, site, nonce, tick) {
			const [state, setState] = react.useState({ status: "idle" });
			const wasOpen = react.useRef(false);

			react.useEffect(() => {
				// Read with the panel shut too: the badge shows today's figure, and
				// reading only on open left it blank until the first click. Closing
				// is the one change that needs no read — the badge keeps what the
				// panel just had.
				const closing = wasOpen.current && !open;
				wasOpen.current = open;
				if (closing) return undefined;
				const controller = new AbortController();
				// Keep the previous data while reloading: blanking the panel on every
				// range change makes it flicker through an empty state it is not in.
				setState((prev) => ({ status: "loading", data: prev.data }));
				fetchUsage(days, site, controller.signal).then(
					(data) => {
						if (!controller.signal.aborted) setState({ status: "ready", data });
					},
					(error) => {
						if (controller.signal.aborted) return;
						setState({ status: "error", message: error?.message ?? String(error) });
					}
				);
				return () => controller.abort();
			}, [open, days, site, nonce, tick]);

			return state;
		}

		/** How often the badge re-reads while nobody is looking at the panel. */
		const BADGE_REFRESH_MS = 5 * 60_000;

		/**
		 * EVERY account's balance, one read each, as the panel opens.
		 *
		 * One request per account rather than one for the account being looked
		 * at: the section lists them all now (用户 2026-10-04：「用量账本点开显示
		 * 全部余额，不要选择了」), and the host caches each account's card
		 * separately behind its own freshness window — so this is the read the
		 * picker used to make, once per account, in parallel.
		 *
		 * Separate from the usage payload because each read reaches a vendor
		 * over the network: a slow or unreachable balance API must not hold up
		 * figures that are already on disk. Each answer lands on its own, so one
		 * relay that takes ten seconds delays its own card and nothing else.
		 *
		 * Keyed by account id, and the map outlives a reopen, so a figure stays
		 * on screen while its next read is in flight — keeping the previous
		 * figure visible is the whole difference between "refreshing" and
		 * "balance loads slowly". The no-accounts fallback keeps the old single
		 * read with no `account` parameter, which the host answers for the first
		 * account it knows.
		 *
		 * `forceNonce` moves only when the refresh button is pressed; every other
		 * change re-reads through the host's freshness window.
		 */
		function useBalances(open, accounts, nonce, forceNonce) {
			const [cards, setCards] = react.useState({});
			const prevForce = react.useRef(0);
			// The ids are what this effect depends on, not the array's identity:
			// the accounts are rebuilt from every usage payload, and a dependency
			// on the reference would read every balance again on each of them.
			const watched = accounts.length === 0 ? [undefined] : accounts.map((a) => a.id);
			const key = watched.join("\u0000");

			react.useEffect(() => {
				if (!open) return undefined;
				const force = forceNonce !== prevForce.current;
				prevForce.current = forceNonce;
				const controllers = [];
				// Set before aborting, so a cancelled read's rejection cannot land
				// as this account's balance.
				let live = true;
				for (const id of watched) {
					const controller = new AbortController();
					controllers.push(controller);
					const params = id === undefined ? [] : [`account=${encodeURIComponent(id)}`];
					if (force) params.push("force=1");
					const query = params.length === 0 ? "" : `?${params.join("&")}`;
					const land = (card) => {
						if (live) setCards((prev) => ({ ...prev, [id ?? ""]: card }));
					};
					fetchJson(BALANCE_PATH + query, controller.signal).then(land, () => {
						// A balance that cannot be read is not worth an error banner over
						// a panel whose real subject is token usage — but on a list of
						// cards an account that simply vanished would be worse than a
						// card that says what happened, so the failure keeps its seat.
						land({ ok: false, supported: true, fetched: false, reason: "unreachable" });
					});
				}
				return () => {
					live = false;
					for (const controller of controllers) controller.abort();
				};
			}, [open, key, nonce, forceNonce]);

			return cards;
		}

		/**
		 * The Client root context `apply()` was handed, for the services the
		 * badge reads at render time. Unset outside a host (tests, a bundle that
		 * never registered), which reads as "no current model".
		 */
		let hostCtx;

		/**
		 * A host service, or undefined. Looked up with `ctx.get`, never declared
		 * in `inject`: a declared name has no optional form (HOST-CONTRACT §2), and
		 * a host without model selection must still get its badge.
		 */
		function serviceOf(name) {
			try {
				return typeof hostCtx?.get === "function" ? (hostCtx.get(name) ?? undefined) : undefined;
			} catch {
				return undefined;
			}
		}

		/** How often, and how many times, to look again for services not up yet. */
		const SERVICE_RETRY_MS = 2_000;
		const SERVICE_RETRIES = 60;

		/**
		 * The model the open session is set to, as `{ provider, model }`.
		 *
		 * Read from DSH's own model-selection store (`uiSession.current` names
		 * the main session, `modelDirectories` holds its selection) rather than
		 * guessed from the ledger, so this and the composer's model seat answer
		 * from one source. `provider` is the route id — the same id the balance
		 * route takes as `?account=`.
		 */
		function useCurrentModel() {
			const [selection, setSelection] = react.useState(undefined);
			const [attempt, setAttempt] = react.useState(0);
			react.useEffect(() => {
				const main = serviceOf("uiSession")?.current;
				const directories = serviceOf("modelDirectories");
				if (typeof main?.subscribe !== "function" || typeof directories?.directoryFor !== "function") {
					// The sidebar can mount before model selection has applied.
					if (hostCtx === undefined || attempt >= SERVICE_RETRIES) return undefined;
					const timer = setTimeout(() => setAttempt((n) => n + 1), SERVICE_RETRY_MS);
					return () => clearTimeout(timer);
				}
				let sessionId;
				let retry;
				let unfollowModel = () => {};
				const followSession = () => {
					const next = main.getSnapshot?.()?.key;
					if (next === sessionId) return;
					sessionId = next;
					unfollowModel();
					unfollowModel = () => {};
					let directory;
					let failed = false;
					try {
						directory = next === undefined ? undefined : directories.directoryFor(next);
					} catch {
						// The main session is named before its scope exists on a
						// fresh load. Forget it, so the retry below asks again
						// instead of treating the session as handled.
						failed = true;
					}
					if (directory === undefined) {
						setSelection(undefined);
						if (failed) {
							sessionId = undefined;
							if (attempt < SERVICE_RETRIES) retry = setTimeout(() => setAttempt((n) => n + 1), SERVICE_RETRY_MS);
						}
						return;
					}
					const read = () => {
						const current = directory.store.getSnapshot()?.current;
						const provider = typeof current?.provider === "string" ? current.provider : undefined;
						const model = typeof current?.model === "string" ? current.model : undefined;
						setSelection((prev) =>
							prev?.provider === provider && prev?.model === model
								? prev
								: provider === undefined
									? undefined
									: { provider, model }
						);
					};
					unfollowModel = directory.store.subscribe(read);
					read();
					// The selection is resolved against the shared catalog, which
					// loads on demand; one load per host generation, shared with
					// the composer. A subagent session refuses — no model then.
					Promise.resolve()
						.then(() => directory.load())
						.catch(() => undefined);
				};
				const unfollowSession = main.subscribe(followSession);
				followSession();
				return () => {
					clearTimeout(retry);
					unfollowSession();
					unfollowModel();
				};
			}, [attempt]);
			return selection;
		}

		/** When an unread balance line is asked again; the 5-minute tick takes over after. */
		const BALANCE_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

		/**
		 * The balance behind one route, for the badge's second line.
		 *
		 * Read with the panel shut, through the host's freshness window — never
		 * forced. A failed read keeps nothing: an old route's figure under a new
		 * model would be the one wrong thing this line could say.
		 */
		function useRouteBalance(route, nonce, tick) {
			const [state, setState] = react.useState(undefined);
			const [again, setAgain] = react.useState(0);
			const misses = react.useRef({ route: undefined, n: 0 });
			react.useEffect(() => {
				if (route === undefined) return undefined;
				if (misses.current.route !== route) misses.current = { route, n: 0 };
				const controller = new AbortController();
				let timer;
				// Right after a restart the host answers before its provider
				// directory and sign-ins are up, and that empty answer used to
				// stand until the 5-minute tick or a model switch. Ask again soon.
				const later = () => {
					const delay = BALANCE_RETRY_MS[misses.current.n++];
					if (delay !== undefined) timer = setTimeout(() => setAgain((n) => n + 1), delay);
				};
				fetchJson(`${BALANCE_PATH}?account=${encodeURIComponent(route)}`, controller.signal).then(
					(data) => {
						if (controller.signal.aborted) return;
						setState({ route, data });
						if (data?.fetched === true) misses.current.n = 0;
						else later();
					},
					() => {
						if (controller.signal.aborted) return;
						setState(undefined);
						later();
					}
				);
				return () => {
					controller.abort();
					clearTimeout(timer);
				};
			}, [route, nonce, tick, again]);
			return route !== undefined && state?.route === route ? state.data : undefined;
		}

		/**
		 * One balance as a few words, or undefined when there is nothing true to
		 * say in a line this short — an unread, unsupported or failed card stays
		 * blank here; the panel is where it explains itself.
		 */
		function badgeBalanceText(balance, translate, model) {
			if (balance?.fetched !== true) return undefined;
			if (typeof balance.total === "number") {
				return translate("badge.balance", { amount: fmtMoney(balance.total, balance.currency) });
			}
			if (typeof balance.used === "number") {
				return translate("badge.spent", { amount: fmtMoney(balance.used, balance.currency) });
			}
			if (balance.quota?.available !== undefined) return translate("balance.quota", { n: fmt(balance.quota.available) });
			// Windows split by model group (Antigravity) answer for the group the
			// selected model is in; Gemini by name, everything else the other one.
			const all = Array.isArray(balance.windows) ? balance.windows : [];
			const group = /gemini/i.test(model ?? "") ? "gemini" : "non-gemini";
			const scoped = all.some((w) => w?.group === group) ? all.filter((w) => w?.group === group) : all;
			// The short-label plans list every window on the one line, as bare
			// percentages: `5h 1.9% · week 37% · month 18.5%`.
			if (COMPACT_WINDOW_SCHEMES.has(balance.scheme)) {
				const parts = scoped
					.filter((w) => typeof w?.usedPercent === "number")
					.map((w) => `${compactWindowLabel(w, translate)} ${w.usedPercent}%`);
				if (parts.length === 0) return undefined;
				// Name the pool when the plan has several, so switching models
				// visibly switches the line (Claude and GPT share one at Antigravity).
				const pool = all.some((w) => w?.group === group) ? `${translate(`balance.group.${group}`)} ` : "";
				return pool + parts.join(" · ");
			}
			const window = scoped.find((w) => typeof w?.usedPercent === "number");
			if (window !== undefined) {
				return `${windowLabel(window, translate, COMPACT_WINDOW_SCHEMES.has(balance.scheme))} ${translate("balance.window.used", { pct: String(window.usedPercent) })}`;
			}
			return undefined;
		}
		//#endregion

		//#region view

		/**
		 * The three windows as cards, and the range control.
		 *
		 * Each card always shows its own window's total, not a slice of whatever
		 * is selected — which is the point of showing three. The selected one
		 * drives the sections below.
		 */
		function StatRow({ data, range, onRange, translate }) {
			const windows = data.windows ?? {};
			return jsx("div", {
				className: S.stats,
				children: RANGES.map((r) =>
					jsxs(
						"button",
						{
							type: "button",
							className: S.stat,
							...(r.id === range ? { "data-on": "" } : {}),
							onClick: () => onRange(r.id),
							children: [
								jsx("div", { className: S.statValue, children: fmtCompact(windows[r.key]?.tokens) }),
								jsx("div", { className: S.statLabel, children: translate(`range.${r.id}`) })
							]
						},
						r.id
					)
				)
			});
		}

		function Section({ title, action, children }) {
			return jsxs("div", {
				className: S.section,
				children: [
					jsxs("div", {
						className: S.sectionTitle,
						children: [title, action]
					}),
					children
				]
			});
		}

		/**
		 * The one-line summary of the SELECTED window.
		 *
		 * Requests, cache hit rate and estimated cost do not each deserve a card
		 * — they are qualifiers on the token figure above, and three more boxes
		 * would push the site breakdown below the fold. Cost is an em dash when
		 * unpriced, never a zero.
		 */
		function StatCaption({ data, translate }) {
			const totals = data.totals ?? {};
			const currencies = Object.entries(data.priced?.totals ?? {});
			const parts = [
				translate("caption.requests", { n: fmt(totals.requests) }),
				translate("caption.hit", { rate: fmtHit(totals.cacheHitRate) || "—" })
			];
			if (currencies.length > 0) {
				parts.push(translate("caption.cost", { cost: currencies.map(([c, v]) => fmtMoney(v, c)).join(" + ") }));
			}
			return jsx("p", { className: S.caption, children: parts.join(" · ") });
		}

		/**
		 * The site breakdown — the reason this panel exists.
		 *
		 * Rows are never filtered by the current selection: this list is how you
		 * change that selection, so hiding the others would strand you on whatever
		 * you last clicked. Clicking the active row clears the filter.
		 */
		/**
		 * A site's colour.
		 *
		 * `direct` is deliberately outside the ramp: it is not a relay, and the
		 * distinction between "the vendor" and "someone reselling the vendor" is
		 * the section's whole subject. Relays cycle a fixed palette rather than a
		 * generated hue, so the same site keeps the same colour across reloads.
		 *
		 * `unrouted` is outside it too, and for a sharper reason: it is not a
		 * place, it is the absence of one. Giving it a relay colour would put an
		 * unknown on equal footing with the sites we can actually name.
		 */
		function colorOf(site, index) {
			if (site === "direct") return "var(--tkl-direct)";
			if (site === "unrouted") return "var(--tkl-level-0)";
			return `var(--tkl-series-${index % 6})`;
		}

		/**
		 * The site breakdown — the reason this panel exists.
		 *
		 * Rows are never filtered by the current selection: this list is how you
		 * change that selection, so hiding the others would strand you on whatever
		 * you last clicked. Clicking the active row clears the filter.
		 */
		/**
		 * Which project the tokens went to.
		 *
		 * Keyed on the directory a session ran in, which is what a project is
		 * here. The workspace title is a label over the top of that, not the key
		 * — a session started in a subdirectory, or in a directory nobody
		 * registered, belongs to no workspace and would otherwise vanish.
		 *
		 * A breakdown, not a filter. The relay picker is the one selection the
		 * panel has, and a second one would double the states every other section
		 * has to be correct in for a question nobody has asked yet.
		 */
		function ProjectRows({ data, translate }) {
			const rows = data.projects ?? [];
			if (rows.length === 0) return jsx("p", { className: S.note, children: translate("projects.none") });
			const total = rows.reduce((sum, r) => sum + (r.tokens ?? 0), 0);

			return jsx("div", {
				className: S.rows,
				children: rows.map((row) => {
					// A session with no cwd in its header. Its own row, named as
					// such: usage that cannot be attributed has to be visible, or
					// the other rows silently stop adding up to the total.
					const label = row.unattributed === true ? translate("projects.unattributed") : row.label;
					return jsxs(
						"div",
						{
							className: `${S.row} ${S.rowStatic}`,
							title: row.path ?? label,
							children: [
								jsx("span", { className: S.rowName, children: label }),
								// Two projects called `web` in different trees are one
								// ambiguous row without this. Shown only where the
								// label is a workspace title, since otherwise the name
								// IS the last segment of the path.
								row.titled === true ? jsx("span", { className: S.rowPath, children: row.path }) : null,
								jsx("span", { className: S.rowValue, children: fmtCompact(row.tokens) }),
								jsx("span", { className: S.rowMeta, children: `${Math.round(share(row.tokens, total))}%` })
							]
						},
						row.project
					);
				})
			});
		}

		function SiteRows({ data, site, onSelect, translate }) {
			const rows = data.sites ?? [];
			if (rows.length === 0) return jsx("p", { className: S.note, children: translate("sites.none") });
			const total = rows.reduce((sum, r) => sum + (r.tokens ?? 0), 0);
			const byId = new Map((data.directory ?? []).map((d) => [d.id, d]));
			// Relays take the ramp in the order they appear; `direct` sits outside
			// it, so it must not consume a slot and shift everyone else.
			// `direct` and `unrouted` both sit outside the relay ramp: neither is a
			// relay, and letting either consume a slot shifts every real site's
			// colour.
			let relay = -1;
			const coloured = rows.map((row) => {
				if (row.site !== "direct" && row.site !== "unrouted") relay += 1;
				return { ...row, color: colorOf(row.site, relay) };
			});

			return jsxs("div", {
				children: [
					// One bar, segmented — a row of separate bars each scaled to the
					// largest made two sites look comparable when one was triple the
					// other. Shares of one whole are the honest shape.
					jsx("div", {
						className: S.stack,
						...(site === undefined ? {} : { "data-dim": "" }),
						children: coloured.map((row) =>
							jsx(
								"span",
								{
									className: S.stackSeg,
									...(row.site === site ? { "data-on": "" } : {}),
									title: `${row.site} · ${fmtCompact(row.tokens)}`,
									style: { width: `${share(row.tokens, total)}%`, background: row.color }
								},
								row.site
							)
						)
					}),
					jsx("div", {
						className: S.rows,
						children: coloured.map((row) => {
							const id = row.site;
							const known = byId.get(id);
							const label = id === "direct" ? translate("sites.direct") : id === "unrouted" ? translate("sites.unrouted") : id;
							const routes = known?.routes?.length ? known.routes.join(", ") : undefined;
							const software = SCHEME_LABELS[known?.type];
							return jsxs(
								"button",
								{
									type: "button",
									className: S.row,
									...(id === site ? { "data-on": "" } : {}),
									title: [label, routes, software].filter(Boolean).join(" · "),
									onClick: () => onSelect(id === site ? undefined : id),
									children: [
										jsx("span", { className: S.swatch, style: { background: row.color } }),
										jsx("span", { className: S.rowName, children: label }),
										jsx("span", { className: S.rowValue, children: fmtCompact(row.tokens) }),
										jsx("span", { className: S.rowMeta, children: `${Math.round(share(row.tokens, total))}%` })
									]
								},
								id
							);
						})
					})
				]
			});
		}

		/**
		 * A compact activity strip: weeks as columns, one 12px cell per day.
		 *
		 * A month grid was the obvious thing to copy and is the wrong shape — it
		 * answers "which days were busy" using a whole viewport, where a strip
		 * answers it in one band and shows more than a month at once.
		 *
		 * Levels are relative to the busiest day in view, so a quiet week still
		 * has contrast rather than rendering as one flat colour.
		 */
		function ActivityStrip({ data, translate }) {
			const [hover, setHover] = react.useState(null);
			const scroller = react.useRef(null);

			// Its own window, not the selected range. Tied to the range it
			// collapsed to a single cell whenever "today" was picked, leaving a
			// mostly empty seven-row grid that read as a broken chart.
			const days = data.activity ?? data.days ?? [];
			const byDay = new Map(days.map((d) => [d.day, d.tokens ?? 0]));
			const levelAt = makeLevelScale([...byDay.values()]);

			// Per-day model rows, grouped once rather than on every hover.
			const modelsByDay = react.useMemo(() => {
				const out = new Map();
				for (const row of data.activityModels ?? []) {
					if (!out.has(row.day)) out.set(row.day, []);
					out.get(row.day).push(row);
				}
				for (const rows of out.values()) rows.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
				return out;
			}, [data.activityModels]);

			// Whole weeks ending today, Monday first, idle days present as level
			// zero rather than absent.
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const cells = [];
			for (let back = ACTIVITY_DAYS - 1; back >= 0; back--) {
				const date = new Date(today.getTime() - back * 86_400_000);
				const key = localDayKey(date);
				cells.push({ day: key, date, tokens: byDay.get(key) ?? 0 });
			}
			const startPad = (cells[0].date.getDay() + 6) % 7;
			for (let i = 0; i < startPad; i++) cells.unshift(null);
			const endPad = (7 - (cells.length % 7)) % 7;
			for (let i = 0; i < endPad; i++) cells.push(null);

			// A month label over the column where that month starts. Anything
			// finer collides at 12px per week.
			const weeks = cells.length / 7;
			const monthLabels = [];
			let lastMonth = -1;
			for (let w = 0; w < weeks; w++) {
				const first = cells.slice(w * 7, w * 7 + 7).find(Boolean);
				const month = first === undefined ? lastMonth : first.date.getMonth();
				monthLabels.push(month !== lastMonth && first !== undefined ? translate(`month.${month}`) : "");
				if (first !== undefined) lastMonth = month;
			}

			// Land on the newest week; the year runs off the left edge otherwise.
			react.useEffect(() => {
				const el = scroller.current;
				if (el) el.scrollLeft = el.scrollWidth;
			}, [days.length]);

			const show = (cell) => (event) => {
				const box = event.currentTarget.getBoundingClientRect();
				setHover({ cell, x: box.left + box.width / 2, y: box.top });
			};

			return jsxs("div", {
				children: [
					jsxs("div", {
						className: S.strip,
						ref: scroller,
						children: [
							jsx("div", {
								className: S.weekdays,
								// Two of seven, like GitHub: seven labels at 12px is noise.
								children: [0, 1, 2, 3, 4, 5, 6].map((d) =>
									jsx("span", { className: S.weekday, children: d === 1 || d === 4 ? translate(`weekday.${d}`) : "" }, d)
								)
							}),
							jsxs("div", {
								className: S.stripCols,
								children: [
									jsx("div", {
										className: S.months,
										style: { gridTemplateColumns: `repeat(${weeks}, 12px)` },
										children: monthLabels.map((label, i) => jsx("span", { className: S.month, children: label }, i))
									}),
									jsx("div", {
										className: S.stripGrid,
										children: cells.map((cell, i) =>
											cell === null
												? jsx("span", { className: S.cellPad }, `p${i}`)
												: jsx(
														"span",
														{
															className: S.cell,
															"data-l": String(levelAt(cell.tokens)),
															onMouseEnter: show(cell),
															onMouseLeave: () => setHover(null)
														},
														cell.day
													)
										)
									})
								]
							})
						]
					}),
					jsxs("div", {
						className: S.legend,
						children: [
							jsx("span", { children: translate("activity.less") }),
							[0, 1, 2, 3, 4].map((level) =>
								jsx("span", { className: S.legendSwatch, style: { background: `var(--tkl-level-${level})` } }, level)
							),
							jsx("span", { children: translate("activity.more") })
						]
					}),
					hover === null
						? null
						: jsx(DayTip, {
								cell: hover.cell,
								x: hover.x,
								y: hover.y,
								level: levelAt(hover.cell.tokens),
								models: modelsByDay.get(hover.cell.day) ?? [],
								translate
							})
				]
			});
		}

		/**
		 * What a day was made of.
		 *
		 * A `title` attribute answers "how much" after a second of waiting and
		 * nothing else. The per-model split is already in the payload, so showing
		 * it costs a hover handler and turns the strip from decoration into
		 * something worth pointing at.
		 */
		function DayTip({ cell, x, y, level, models, translate }) {
			const total = cell.tokens ?? 0;
			// Clamped so a cell near either edge does not push the card off-screen.
			const left = Math.min(Math.max(x - 110, 8), Math.max(8, window.innerWidth - 258));
			return jsxs("div", {
				className: S.tip,
				style: { left: `${left}px`, top: `${Math.max(8, y - 8)}px`, transform: "translateY(-100%)" },
				children: [
					jsxs("div", {
						className: S.tipHead,
						children: [
							jsx("span", { className: S.tipDate, children: cell.day }),
							jsx("span", { className: S.tipLevel, children: translate("activity.level", { level }) })
						]
					}),
					jsxs("div", {
						className: S.tipTotal,
						children: [fmtCompact(total), jsx("span", { className: S.tipUnit, children: "tokens" })]
					}),
					models.length === 0
						? jsx("p", { className: S.tipQuiet, children: translate("activity.quiet") })
						: jsx("div", {
								className: S.tipModels,
								children: models.slice(0, 4).map((row) =>
									jsxs(
										"div",
										{
											className: S.tipRow,
											children: [
												jsxs("div", {
													className: S.tipRowHead,
													children: [
														jsx("span", { className: S.tipName, title: row.model, children: row.model }),
														jsx("span", { className: S.tipValue, children: fmtCompact(row.tokens) }),
														jsx("span", { className: S.tipPct, children: `${Math.round(share(row.tokens, total))}%` })
													]
												}),
												jsx("div", {
													className: S.tipBar,
													children: jsx("div", {
														className: S.tipBarFill,
														style: { width: `${Math.max(2, share(row.tokens, total))}%` }
													})
												})
											]
										},
										row.model
									)
								)
							})
				]
			});
		}

		/**
		 * Five buckets by QUANTILE of the days that had any usage.
		 *
		 * Scaling to the maximum was the obvious choice and the wrong one: one
		 * outlier day flattens every other day to level 1, so a year of steady
		 * work renders as a single bright square in a pale field. Median / 75th /
		 * 90th spreads the ramp across the distribution actually present, which is
		 * what makes a heatmap readable.
		 *
		 * @param values - every day's total in the window, zeros included.
		 * @returns a function from a day's total to 0-4.
		 */
		function makeLevelScale(values) {
			const active = values.filter((v) => v > 0).sort((a, b) => a - b);
			if (active.length === 0) return () => 0;

			// Quantiles need a distribution to describe. With only a handful of
			// distinct totals they all collapse onto the same threshold and every
			// active day comes out level 1 — a single busy day rendering as the
			// palest possible green, which reads as "nothing happened". Below four
			// distinct values, rank them instead.
			const distinct = [...new Set(active)];
			if (distinct.length < 4) {
				const rank = new Map(distinct.map((v, i) => [v, distinct.length === 1 ? 4 : 1 + Math.round((i * 3) / (distinct.length - 1))]));
				return (value) => (value > 0 ? (rank.get(value) ?? 4) : 0);
			}

			const at = (q) => {
				const pos = (active.length - 1) * q;
				const base = Math.floor(pos);
				const rest = pos - base;
				const left = active[base];
				const right = active[Math.min(active.length - 1, base + 1)];
				return left + (right - left) * rest;
			};
			const t1 = at(0.5);
			const t2 = at(0.75);
			const t3 = at(0.9);
			return (value) => {
				if (!(value > 0)) return 0;
				if (value <= t1) return 1;
				if (value <= t2) return 2;
				if (value <= t3) return 3;
				return 4;
			};
		}

		/**
		 * `YYYY-MM-DD` from a date's LOCAL components.
		 *
		 * `toISOString()` is the obvious call and the wrong one: it formats in UTC,
		 * while the store keys its days in local time. Mixing the two shifts every
		 * cell by a day for anyone not on UTC — the strip renders one leading blank
		 * and attributes each day's usage to the one before it. Caught by a test
		 * only because this machine happens to sit at UTC+9.
		 */
		function localDayKey(date) {
			const month = String(date.getMonth() + 1).padStart(2, "0");
			const day = String(date.getDate()).padStart(2, "0");
			return `${date.getFullYear()}-${month}-${day}`;
		}

		/** The model NAME: the last segment of a catalog id that carries a vendor namespace. */
		function modelName(model) {
			const text = String(model ?? "");
			const cut = text.lastIndexOf("/");
			return cut === -1 ? text : text.slice(cut + 1);
		}

		/**
		 * How a model row is named: `<provider>/<model name>`.
		 *
		 * The prefix is the DSH route that served the call, never the model's
		 * vendor. Command Code already namespaces its catalog ids by MODEL vendor
		 * (`deepseek/deepseek-v4.1-flash`), and prefixing that with the route put
		 * two slashes in one name — but the route answers the question the panel
		 * asks (who served this), so it REPLACES the vendor segment. A row from a
		 * host that sends model-only rows has no route to name, and keeps its id.
		 */
		function routeLabel(m) {
			const provider = typeof m.provider === "string" ? m.provider : "";
			return provider === "" ? String(m.model ?? "") : `${provider}/${modelName(m.model)}`;
		}

		/** The exact identity, for a cell's title: the route plus the id as recorded. */
		function exactLabel(m) {
			const provider = typeof m.provider === "string" ? m.provider : "";
			return provider === "" ? String(m.model ?? "") : `${provider}/${m.model}`;
		}

		/**
		 * Labels for one table, disambiguated against each other.
		 *
		 * Dropping the vendor segment is only safe while the short name is unique
		 * among these rows: two ids on one route that end in the same name (a
		 * `:batch` sibling reports its own id, a relay can re-list another
		 * vendor's model) would otherwise print the same name twice. Those rows
		 * keep the full id instead of being silently merged on screen.
		 */
		function routeLabels(rows) {
			const short = rows.map((m) => routeLabel(m));
			const counts = new Map();
			for (const label of short) counts.set(label, (counts.get(label) ?? 0) + 1);
			return rows.map((m, index) => (counts.get(short[index]) > 1 ? exactLabel(m) : short[index]));
		}

		/** A row is identified by its route AND its model: one model can be two rows. */
		function rowKey(m) {
			const provider = typeof m.provider === "string" ? m.provider : "";
			return provider === "" ? String(m.model ?? "") : `${provider}\u0000${m.model}`;
		}

		const MODEL_COLUMNS = [
			{ id: "model", label: "table.model", get: (m) => m.label ?? routeLabel(m), numeric: false },
			{ id: "requests", label: "table.requests", get: (m) => m.requests ?? 0 },
			{
				id: "tokens",
				label: "table.total",
				get: (m) =>
					m.tokens ??
					(m.inputTokens ?? 0) + (m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0) + (m.outputTokens ?? 0)
			},
			{ id: "inputTokens", label: "table.input", get: (m) => m.inputTokens ?? 0 },
			{ id: "cacheReadTokens", label: "table.cache", get: (m) => m.cacheReadTokens ?? 0 },
			{ id: "outputTokens", label: "table.output", get: (m) => m.outputTokens ?? 0 },
			{ id: "cost", label: "table.cost", get: (m) => m.cost ?? -1 }
		];

		/**
		 * The panel's model table.
		 *
		 * Columns match the text report's, but the name column is route-qualified
		 * (`<provider>/<model name>`) — the report keeps the bare id, because it
		 * prints each model once and the site breakdown above it already says where
		 * the traffic went. Rows come from `modelRoutes` when the host sends it (one
		 * row per route AND model); a host that only sends model-only rows still
		 * renders, named by the bare id. The exact id stays in each cell's title.
		 */
		function ModelTable({ data, translate }) {
			const [sort, setSort] = react.useState({ by: "tokens", desc: true });
			const priced = new Map((data.priced?.rows ?? []).map((r) => [r.model, r]));
			const routes = data.modelRoutes ?? [];
			const source = routes.length > 0 ? routes : (data.models ?? []);
			// A route row carries its own cost, and only its own fields: spreading a
			// priced row over it would overwrite the row's buckets with the totals
			// of EVERY route serving that model (the row would read as its own sum
			// twice). The model-wide row is still used for a host that sends
			// model-only rows, where the scopes match.
			const rows = source.map((m) => {
				if (m.cost !== undefined) return m;
				const money = priced.get(m.model);
				if (money === undefined) return m;
				return { ...m, cost: money.cost, currency: money.currency, priced: money.priced, unpricedBuckets: money.unpricedBuckets };
			});
			if (rows.length === 0) return jsx("p", { className: S.note, children: translate("table.none") });
			// Named as a set: a label may only drop a vendor segment while it stays
			// unique among these rows.
			const labels = routeLabels(rows);
			const named = rows.map((m, index) => ({ ...m, label: labels[index] }));

			const column = MODEL_COLUMNS.find((c) => c.id === sort.by) ?? MODEL_COLUMNS[2];
			const sorted = named.slice().sort((a, b) => {
				const x = column.get(a);
				const y = column.get(b);
				const order = column.numeric === false ? String(x).localeCompare(String(y)) : x - y;
				return sort.desc ? -order : order;
			});

			const toggle = (id) =>
				setSort((prev) => (prev.by === id ? { by: id, desc: !prev.desc } : { by: id, desc: true }));

			return jsxs("table", {
				className: S.table,
				children: [
					jsx("thead", {
						children: jsx("tr", {
							children: MODEL_COLUMNS.map((c) =>
								jsxs(
									"th",
									{
										onClick: () => toggle(c.id),
										children: [
											translate(c.label),
											sort.by === c.id ? jsx("span", { className: S.sortMark, children: sort.desc ? "↓" : "↑" }) : null
										]
									},
									c.id
								)
							)
						})
					}),
					jsx("tbody", {
						children: sorted.map((m) =>
							jsxs(
								"tr",
								{
									children: [
										jsx("td", { title: exactLabel(m), children: m.label }),
										jsx("td", { children: fmt(m.requests) }),
										jsx("td", { children: fmtCompact(MODEL_COLUMNS[2].get(m)) }),
										jsx("td", { children: fmtCompact(m.inputTokens) }),
										jsxs("td", {
											children: [
												fmtCompact(m.cacheReadTokens),
												jsx("span", { className: S.hit, children: fmtHit(m.cacheHitRate) }),
												// Cache WRITES count toward the total but had no column, so
												// the row did not add up to it — 520 tokens invisible on a
												// real install. The relay's own log marks them the same way.
												(m.cacheWriteTokens ?? 0) > 0
													? jsx("span", { className: S.hit, children: ` ↑${fmtCompact(m.cacheWriteTokens)}` })
													: null
											]
										}),
										jsx("td", { children: fmtCompact(m.outputTokens) }),
										jsx("td", { children: m.cost === null || m.cost === undefined ? "—" : fmtMoney(m.cost, m.currency) })
									]
								},
								rowKey(m)
							)
						)
					})
				]
			});
		}

		// 账户下拉（`AccountPicker`）原来在这里：一张卡加一个 `<select>` 选账户。
		// 2026-10-04 用户定「用量账本点开显示全部余额，不要选择了」→ 余额一节改成
		// 每个账户各一张卡，于是没有东西可选、没有原生下拉要配色。见
		// `docs/FORK-VS-UPSTREAM.md` 第 ⑪ 条（**合上游时这一处要保留**）。

		/**
		 * What to call one window.
		 *
		 * `minutes` is consulted only for `session`, because it is the only kind
		 * whose own name says nothing about how long it is — one plan's rolling
		 * window is five hours, another's is three, and a `session` row labelled
		 * "5 hours" on both would be a number the panel made up. `weekly` and
		 * `monthly` already state their period, so a length would only repeat it.
		 */
		function windowLabel(window, translate, compact = false) {
			if (compact) return compactWindowLabel(window, translate);
			if (window.kind === "session" && typeof window.minutes === "number") {
				const minutes = window.minutes;
				if (minutes % 1440 === 0) return translate("balance.window.days", { n: minutes / 1440 });
				if (minutes % 60 === 0) return translate("balance.window.hours", { n: minutes / 60 });
				return translate("balance.window.minutes", { n: minutes });
			}
			return translate(`balance.window.${window.kind}`);
		}

		/**
		 * Schemes whose windows read as `5h` / `7d` / `30d`, and whose badge
		 * line lists them all (用户 2026-10-04：cc 的用量这样标；antigravity 同样).
		 */
		const COMPACT_WINDOW_SCHEMES = new Set(["commandcode", "antigravity"]);

		/**
		 * The short form: the length for a rolling window, the period's own word
		 * otherwise. A kind with no short word keeps its full label.
		 */
		function compactWindowLabel(window, translate) {
			if (window.kind === "session" && typeof window.minutes === "number") {
				const minutes = window.minutes;
				if (minutes % 1440 === 0) return `${minutes / 1440}d`;
				if (minutes % 60 === 0) return `${minutes / 60}h`;
				return `${minutes}m`;
			}
			// Lengths, not names (用户 2026-10-04：「别写week 写7d 和30d吧」).
			const short = { daily: "1d", weekly: "7d", monthly: "30d" }[window.kind];
			return short ?? windowLabel(window, translate);
		}

		/**
		 * A subscription's rolling allowances.
		 *
		 * These accounts hold no money — several independent windows fill up and
		 * empty on their own clocks, and "how much of the current one is left" is
		 * the question the panel exists to answer. Rendered under the amount
		 * rather than instead of it: a plan with a wallet behind it has both.
		 */
		function QuotaWindows({ windows, translate, compact = false }) {
			if (!Array.isArray(windows) || windows.length === 0) return null;
			return jsx("div", {
				className: S.wins,
				children: windows.map((window) => {
					const used = window.usedPercent;
					const known = typeof used === "number";
					// Three bands, and the number is always spelled out beside the
					// bar — the colour repeats the state, it does not carry it.
					const tone = !known || used < 75 ? "" : used >= 100 ? ` ${S.winFull}` : ` ${S.winWarn}`;
					return jsxs("div", {
						className: S.win,
						children: [
							jsxs("div", {
								className: S.winHead,
								children: [
									jsx("span", {
										className: S.winName,
										// Antigravity has a 5 h and a week for EACH model group;
										// without the group the four rows read as two duplicated.
										children: window.group === undefined
											? windowLabel(window, translate, compact)
											: `${translate(`balance.group.${window.group}`)} · ${windowLabel(window, translate, compact)}`
									}),
									window.resetsAt === undefined
										? null
										: jsx("span", {
												className: S.winReset,
												children: translate("balance.window.reset", { at: fmtReset(window.resetsAt) })
											}),
									jsx("span", {
										className: S.winPct,
										children: window.unlimited === true
											? translate("balance.window.unlimited")
											: known
												? translate("balance.window.used", { pct: String(used) })
												: "—"
									})
								]
							}),
							// An unlimited window has no fraction to draw, and a bar
							// stuck at zero would read as "none used of a finite
							// allowance" — the opposite of what it means.
							window.unlimited === true || !known
								? null
								: jsx("div", {
										className: S.winBar,
										role: "progressbar",
										"aria-valuenow": used,
										"aria-valuemin": 0,
										"aria-valuemax": 100,
										"aria-label": windowLabel(window, translate, compact),
										children: jsx("div", { className: `${S.winFill}${tone}`, style: { width: `${used}%` } })
									})
						]
					});
				})
			});
		}

		/**
		 * A reset instant, to the minute.
		 *
		 * Rendered in the viewer's own locale and zone rather than the vendor's:
		 * the question is "when does this free up for me", and an instant printed
		 * in someone else's timezone answers a different one.
		 */
		function fmtReset(iso) {
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return iso;
			return date.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
		}

		/** A wall-clock hour:minute, for "you may retry at". */
		function fmtClock(ms) {
			const date = new Date(ms);
			return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		}

		/**
		 * The 设置查询API chip. Rendered right AFTER the balance amount — the
		 * figure first, the action that re-aims it second — and under the note
		 * on a failed read, where there is no figure to follow.
		 */
		function SetBalanceButton({ onConfigure, translate, label = "balance.setButton" }) {
			return jsx("button", {
				type: "button",
				className: S.setBtn,
				onClick: onConfigure,
				children: translate(label)
			});
		}

		/**
		 * One account's balance, whatever software serves it.
		 *
		 * Every scheme returns the same shape, so this renders DeepSeek, New API
		 * and Sub2API without branching on the vendor — the differences that do
		 * matter (an unlimited key, a plan name, a raw quota where the site
		 * publishes no unit price) are extra lines, not different cards.
		 *
		 * A New API account carries one extra control: 设置查询API, sitting right
		 * after the balance amount, opening the dialog that stores the site's
		 * console credentials. Shown on the failure states too — a site whose
		 * per-key read failed is exactly the one that needs them.
		 *
		 * The section lists one card per account (用户 2026-10-04「不要选择了」),
		 * so EVERY card has to say whose it is — the failure states included,
		 * where the host's payload may carry no name of its own and the account
		 * it was asked about is the only thing that can supply one. A card that
		 * could not be read and does not say whose money it failed to read is a
		 * card nobody can act on.
		 */
		function BalanceCard({ state, account, translate, onConfigure }) {
			if (state.status === "loading" && state.data === undefined) return jsx("div", { className: `${S.skel} ${S.skelStat}` });
			if (state.status !== "ready" && state.status !== "loading") return null;
			const balance = state.data;
			if (balance === undefined) return null;
			const who = [balance.displayName ?? account?.displayName, SCHEME_LABELS[balance.scheme]].filter(Boolean).join(" · ");
			const whoLine = who === "" ? null : jsx("div", { className: S.balanceWho, children: who });
			const setChip = () =>
				(balance.scheme === "newapi" || balance.scheme === "mimo") && typeof onConfigure === "function"
					? jsx(SetBalanceButton, { onConfigure, translate, label: balance.scheme === "mimo" ? "balance.setCookie" : undefined })
					: null;

			if (balance.supported === false) {
				const key =
					balance.reason === "unknown-software"
						? "balance.unknownSoftware"
						: balance.reason === "unknown-account"
							? "balance.unknownAccount"
							: "balance.unavailable";
				return jsxs("div", {
					className: S.balance,
					children: [whoLine, jsx("p", { className: S.note, children: translate(key) }), setChip()]
				});
			}
			if (balance.fetched !== true) {
				// A hint outranks the raw reason: some endpoints want a different
				// credential from the one the route carries, and "401" alone sends
				// people to check a key that is perfectly fine. A throttle says WHEN
				// it will answer again instead of dressing up as a failure. An
				// UNKNOWN hint falls back to the plain failure — a raw dictionary
				// key on a card is worse than fewer words — and an empty reason
				// loses the parentheses entirely rather than reading （）.
				const hintKey = balance.hint !== undefined ? `balance.hint.${balance.hint}` : undefined;
				const key =
					balance.reason === "rate-limited"
						? "balance.rateLimited"
						: hintKey !== undefined && hintKey in zh
							? hintKey
							: balance.reason === "no-credential"
								? "balance.noKey"
								: "balance.failed";
				const reason = balance.reason || "";
				const text =
					key === "balance.failed" && reason === ""
						? translate("balance.failedPlain")
						: translate(key, balance.reason === "rate-limited" ? { at: fmtClock(balance.retryAt) } : { reason });
				return jsxs("div", {
					className: S.balance,
					children: [whoLine, jsx("p", { className: S.note, children: text }), setChip()]
				});
			}

			// A remaining balance when there is one; otherwise what this key has
			// SPENT, labelled as such. An unlimited key has no remaining quota,
			// and the number New API returns for it is the negated usage — shown
			// as a balance it was a negative figure meaning nothing.
			const spent = typeof balance.used === "number";
			const amount =
				typeof balance.total === "number"
					? fmtMoney(balance.total, balance.currency)
					: spent
						? fmtMoney(balance.used, balance.currency)
						: balance.quota?.available !== undefined
							? translate("balance.quota", { n: fmt(balance.quota.available) })
							: "—";
			const amountLabel = typeof balance.total === "number" ? undefined : spent ? translate("balance.spent") : undefined;

			const notes = [];
			// The throttle hint is the one provenance note worth printing: it
			// says WHEN the next read can even happen. Plain cache age is noise
			// — the figure is either right or it refreshes, and the user asked
			// for the 缓存 line to go.
			if (balance.stale === true) {
				notes.push(translate("balance.stale", { ago: agoLabel(balance.fetchedAt, translate), at: fmtClock(balance.retryAt) }));
			}
			// Say it first. These numbers came out of paths the user wrote, so a
			// wrong one is a configuration mistake — and that has to be
			// distinguishable from the plugin misreading a vendor it claims to
			// support, or the first bug report will be filed against us.
			if (balance.declared === true) notes.push(translate("balance.declared"));
			if (balance.unlimited === true) notes.push(translate("balance.unlimited"));
			if (typeof balance.expiresAt === "number") {
				notes.push(translate("balance.expires", { at: new Date(balance.expiresAt * 1000).toLocaleDateString() }));
			}
			if (typeof balance.granted === "number" && balance.granted > 0 && balance.granted !== balance.used) {
				// Z.ai's granted figure is the RECHARGE total (top-ups plus gifts),
				// and a wallet's is what was ever put in — "赠送" on those cards
				// told a user their top-up was a gift, which is the one word that
				// must not be guessed. DeepSeek's really is its grant balance.
				// A drained wallet (remaining 0) makes granted EQUAL used — the
				// same number twice on one card says nothing twice.
				const grantedKey = balance.scheme === "zai" || balance.userToken === true ? "balance.grantedRecharge" : "balance.granted";
				notes.push(translate(grantedKey, { amount: fmtMoney(balance.granted, balance.currency) }));
			}
			if (typeof balance.plan === "string" && balance.plan !== "") {
				notes.push(translate("balance.plan", { plan: balance.plan }));
			}

			// A request that succeeded and produced nothing readable is the one
			// failure a blank card cannot express. These payloads have no
			// published schema, so the reader says which field it went looking
			// for and the user has something to forward instead of "it's empty".
			const unparsed =
				balance.windows === undefined && balance.total === undefined && typeof balance.reason === "string"
					? translate("balance.unparsed", { reason: balance.reason })
					: undefined;

			return jsxs("div", {
				className: S.balance,
				children: [
					jsxs("div", {
						className: S.balanceTop,
						children: [
					jsxs("div", {
						className: S.balanceMain,
						children: [
							// The origin and the software name say WHERE this money
							// lives; the username is dropped on purpose — the card's
							// own name is what attributes it, never an account number.
							whoLine,
							jsxs("div", {
								className: S.balanceAmount,
								children: [
									amount,
									amountLabel === undefined
										? null
										: jsx("span", { className: S.tipUnit, children: amountLabel }),
									// The action rides AFTER the figure it configures.
									setChip()
								]
							})
						]
					}),
					jsxs("div", {
						className: S.balanceMeta,
						children: [
							jsx("div", {
								className: balance.isAvailable === true ? S.balanceOk : S.balanceBad,
								children: balance.isAvailable === true ? translate("balance.active") : translate("balance.inactive")
							}),
							// 已用 sits directly under 账户可用: the card's second money
							// figure, shown only when the vendor reported BOTH what
							// remains and what left. When there is no remaining
							// figure the amount line already labels itself 已用 —
							// a second line here would say it twice.
							typeof balance.total === "number" && spent
								? jsx("div", {
										children: translate("balance.spentAmount", { amount: fmtMoney(balance.used, balance.currency) })
									})
								: null,
							// Each note its own line, and no note twice: the meta column
							// is narrow, and one long joined string wrapped mid-figure
							// reads as the same number printed again below itself.
							notes.length === 0
								? null
								: jsx("div", {
										children: [...new Set(notes)].map((note, i) => jsx("div", { children: note }, i))
									})
						]
					})
						]
					}),
					// Under the amount, not instead of it. An account can hold both
					// a wallet and a plan, and the card has to be able to say so.
					jsx(QuotaWindows, { windows: balance.windows, translate, compact: COMPACT_WINDOW_SCHEMES.has(balance.scheme) }),
					unparsed === undefined ? null : jsx("p", { className: S.note, children: unparsed })
				]
			});
		}

		/**
		 * How long a window runs, in minutes — only to pick a plan's longest. A
		 * billing period is a month; a kind with no length sorts last.
		 */
		function windowSpan(window) {
			if (window.kind === "session") return typeof window.minutes === "number" ? window.minutes : 0;
			return { daily: 1440, weekly: 10080, monthly: 43200, billing: 43200 }[window.kind] ?? 0;
		}

		/**
		 * The longest window of each pool (用户 2026-10-04「套餐的显示最长那个比如月周」):
		 * a month when the plan has one, else the week, else the shortest. A
		 * plan split by model group (Antigravity) keeps one per group, or the
		 * line would speak for one pool and hide the other.
		 */
		function longestWindows(windows) {
			const best = new Map();
			for (const window of Array.isArray(windows) ? windows : []) {
				if (typeof window?.usedPercent !== "number" && window?.unlimited !== true) continue;
				const held = best.get(window.group);
				if (held === undefined || windowSpan(window) > windowSpan(held)) best.set(window.group, window);
			}
			return [...best.values()];
		}

		/**
		 * The one figure an account's line shows: the balance when there is
		 * one, what was spent for an unlimited key, else the plan's longest
		 * window as a bare percentage used (the badge's form). A read that
		 * failed says so in two words; the card under the line explains.
		 */
		function balanceRowValue(balance, translate) {
			if (balance === undefined) return { text: "…", tone: "dim" };
			if (balance.supported === false) return { text: translate("balance.row.unsupported"), tone: "dim" };
			if (balance.fetched !== true) {
				const key =
					balance.reason === "rate-limited"
						? "balance.row.limited"
						: balance.reason === "no-credential"
							? "balance.row.noKey"
							: "balance.row.failed";
				return { text: translate(key), tone: "bad" };
			}
			const tone = balance.isAvailable === false ? "bad" : undefined;
			if (typeof balance.total === "number") return { text: fmtMoney(balance.total, balance.currency), tone };
			if (typeof balance.used === "number") return { text: translate("badge.spent", { amount: fmtMoney(balance.used, balance.currency) }), tone };
			if (balance.quota?.available !== undefined) return { text: translate("balance.quota", { n: fmt(balance.quota.available) }), tone };
			const windows = longestWindows(balance.windows);
			if (windows.length === 0) return { text: "—", tone: "dim" };
			const text = windows
				.map((w) => {
					const pool = w.group === undefined ? "" : `${translate(`balance.group.${w.group}`)} `;
					const used = w.unlimited === true ? translate("balance.window.unlimited") : `${w.usedPercent}%`;
					return `${pool}${compactWindowLabel(w, translate)} ${used}`;
				})
				.join(" · ");
			const full = windows.some((w) => typeof w.usedPercent === "number" && w.usedPercent >= 100);
			return { text, tone: full ? "bad" : tone };
		}

		/**
		 * One account as one line; a press opens its full card underneath, where
		 * the reset times, the notes and the 设置查询API button still live.
		 */
		function BalanceRow({ state, account, translate, onConfigure }) {
			const [open, setOpen] = react.useState(false);
			const balance = state.status === "ready" ? state.data : undefined;
			const name = account?.displayName ?? balance?.displayName ?? translate("section.balance");
			const value = balanceRowValue(balance, translate);
			const tone = value.tone === "bad" ? ` ${S.balRowBad}` : value.tone === "dim" ? ` ${S.balRowDim}` : "";
			return jsxs("div", {
				className: S.balItem,
				children: [
					jsxs("button", {
						type: "button",
						className: S.balRow,
						"aria-expanded": open,
						title: `${name} · ${value.text}`,
						onClick: () => setOpen(!open),
						children: [
							jsx("span", { className: S.balRowMark, children: open ? "▾" : "▸" }),
							jsx("span", { className: S.balRowName, children: name }),
							jsx("span", { className: `${S.balRowValue}${tone}`, children: value.text })
						]
					}),
					open && balance !== undefined ? jsx(BalanceCard, { state, account, translate, onConfigure }) : null
				]
			});
		}

		/**
		 * How each relay program is named on the card — the who-line keeps the
		 * origin and the software, and deliberately NOT the username: the 账号
		 * belongs to the site's console, not to a card the picker attributes.
		 */
		const SCHEME_LABELS = { deepseek: "API 余额", "deepseek-account": "登录账户余额", newapi: "New API", sub2api: "Sub2API", mimo: "控制台余额", antigravity: "Google 账户额度" };

		/** Where a scheme read through a console session signs in; the cookie is stored per console. */
		const CONSOLE_ORIGINS = { mimo: "https://platform.xiaomimimo.com" };

		/**
		 * The 设置查询API dialog: per-site console credentials for New API's
		 * personal wallet.
		 *
		 * The steps are the whole setup — a console login, a system access token,
		 * a numeric user id — so the dialog teaches them rather than linking out.
		 * What is already stored is shown as STATE ("已配置"), never as a value:
		 * the read route answers `hasToken`, and the token itself has no reason
		 * to cross the wire backwards. Saving an empty token keeps the stored one,
		 * which is what makes "change the user id alone" possible.
		 */
		function UserAuthDialog({ account, translate, onClose, onSaved }) {
			const [userId, setUserId] = react.useState(undefined);
			const [token, setToken] = react.useState("");
			const [saved, setSaved] = react.useState(undefined);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(undefined);

			react.useEffect(() => {
				let live = true;
				fetchJson(`${USERAUTH_PATH}?origin=${encodeURIComponent(account.origin)}`).then(
					(payload) => {
						if (!live) return;
						const entry = payload.origins?.[account.origin];
						setSaved(entry);
						// Prefill the STATE, not just the value attribute: an untouched
						// field must still submit the id it displays, or a second edit
						// saves `Number(undefined)` and is told its id is not a number.
						if (entry?.userId !== undefined) setUserId(String(entry.userId));
					},
					() => {}
				);
				return () => {
					live = false;
				};
			}, [account.origin]);

			// Escape closes the DIALOG, not the panel beneath it: the capture-phase
			// listener runs before the panel's own, and stopPropagation keeps it
			// that way.
			react.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onClose();
					}
				};
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, [onClose]);

			const post = async (payload) => {
				const response = await fetch(USERAUTH_PATH, {
					method: "POST",
					headers: { "content-type": "application/json", "x-tokenledger": "1" },
					body: JSON.stringify(payload)
				});
				// A 404 here has one meaning worth spelling out: the route the
				// dialog is posting to does not exist in the RUNNING host, which
				// still holds the pre-feature plugin code. A restart fixes it; no
				// amount of retyping the token will.
				if (response.status === 404) throw new Error(translate("dialog.hostStale"));
				const result = await response.json().catch(() => undefined);
				if (result?.ok !== true) throw new Error(result?.error ?? `HTTP ${response.status}`);
			};

			const save = async () => {
				const id = Number(userId);
				if (!Number.isInteger(id) || id <= 0) {
					setError(translate("dialog.badUserId"));
					return;
				}
				if (token === "" && saved?.hasToken !== true) {
					setError(translate("dialog.needToken"));
					return;
				}
				setBusy(true);
				setError(undefined);
				try {
					await post(
						token === ""
							? { origin: account.origin, userId: id }
							: { origin: account.origin, userId: id, token }
					);
					onSaved();
				} catch (e) {
					setError(translate("dialog.saveFailed", { reason: String(e?.message ?? e) }));
				} finally {
					setBusy(false);
				}
			};

			const remove = async () => {
				setBusy(true);
				setError(undefined);
				try {
					await post({ origin: account.origin, remove: true });
					onSaved();
				} catch (e) {
					setError(translate("dialog.saveFailed", { reason: String(e?.message ?? e) }));
				} finally {
					setBusy(false);
				}
			};

			return jsxs("div", {
				className: S.dlgOverlay,
				onPointerDown: (event) => {
					if (event.target === event.currentTarget) onClose();
				},
				children: [
					jsxs("div", {
						className: S.dlg,
						role: "dialog",
						"aria-label": translate("dialog.title"),
						children: [
							jsxs("div", {
								className: S.dlgHead,
								children: [
									jsx("span", { className: S.dlgTitle, children: `${translate("dialog.title")} · ${account.displayName}` }),
									jsx("button", {
										type: "button",
										className: S.iconButton,
										"aria-label": translate("action.close"),
										onClick: onClose,
										children: jsx(IconClose, { size: 16 })
									})
								]
							}),
							jsxs("ol", {
								className: S.steps,
								children: [
									jsx("li", { children: translate("dialog.step1") }),
									jsx("li", { children: translate("dialog.step2") }),
									jsx("li", { children: translate("dialog.step3") }),
									jsx("li", { children: translate("dialog.step4") })
								]
							}),
							jsx("p", { className: S.note, children: translate("dialog.note") }),
							jsxs("label", {
								className: S.field,
								children: [
									jsx("span", { className: S.fieldLabel, children: translate("dialog.userId") }),
									jsx("input", {
										className: S.input,
										type: "text",
										inputMode: "numeric",
										value: userId ?? (saved?.userId !== undefined ? String(saved.userId) : ""),
										onChange: (event) => setUserId(event.target.value),
										placeholder: translate("dialog.userIdPlaceholder"),
										autoComplete: "off"
									})
								]
							}),
							jsxs("label", {
								className: S.field,
								children: [
									jsx("span", { className: S.fieldLabel, children: translate("dialog.tokenLabel") }),
									jsx("input", {
										className: S.input,
										// Text, not password: the token is the user's own
										// console secret, pasted from the same console they
										// would re-read it from — hiding it only makes
										// paste mistakes invisible.
										type: "text",
										value: token,
										onChange: (event) => setToken(event.target.value),
										placeholder: saved?.hasToken === true ? translate("dialog.keepToken") : translate("dialog.tokenPlaceholder"),
										autoComplete: "off",
										spellCheck: false
									})
								]
							}),
							saved?.hasToken === true ? jsx("p", { className: S.note, children: translate("dialog.configured") }) : null,
							error === undefined ? null : jsx("p", { className: S.error, children: error }),
							jsxs("div", {
								className: S.actions,
								children: [
									saved?.hasToken === true
										? jsx("button", {
												type: "button",
												className: `${S.btn} ${S.btnDanger}${busy ? ` ${S.busy}` : ""}`,
												disabled: busy,
												onClick: remove,
												children: translate("dialog.remove")
											})
										: null,
									jsx("button", { type: "button", className: S.btn, disabled: busy, onClick: onClose, children: translate("action.close") }),
									jsx("button", {
										type: "button",
										className: `${S.btn} ${S.btnPrimary}${busy ? ` ${S.busy}` : ""}`,
										disabled: busy,
										onClick: save,
										children: translate("dialog.save")
									})
								]
							})
						]
					})
				]
			});
		}

		/**
		 * The 设置 Cookie dialog: a vendor console's session, for a vendor whose
		 * balance no API key can read (小米 MiMo).
		 *
		 * The session lasts about a day, so this is a dialog people come back to:
		 * the steps say exactly which request to copy the header from, and a
		 * stored cookie shows as STATE only — the read route answers `hasCookie`,
		 * never the value.
		 */
		function CookieDialog({ account, translate, onClose, onSaved }) {
			const consoleOrigin = CONSOLE_ORIGINS[account.scheme];
			const [cookie, setCookie] = react.useState("");
			const [saved, setSaved] = react.useState(undefined);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(undefined);

			react.useEffect(() => {
				let live = true;
				fetchJson(`${USERAUTH_PATH}?origin=${encodeURIComponent(consoleOrigin)}`).then(
					(payload) => {
						if (live) setSaved(payload.origins?.[consoleOrigin]);
					},
					() => {}
				);
				return () => {
					live = false;
				};
			}, [consoleOrigin]);

			react.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onClose();
					}
				};
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, [onClose]);

			const post = async (payload) => {
				const response = await fetch(USERAUTH_PATH, {
					method: "POST",
					headers: { "content-type": "application/json", "x-tokenledger": "1" },
					body: JSON.stringify({ origin: consoleOrigin, kind: "cookie", ...payload })
				});
				if (response.status === 404) throw new Error(translate("dialog.hostStale"));
				const result = await response.json().catch(() => undefined);
				if (result?.error === "invalid-cookie") throw new Error(translate("cookie.invalid"));
				if (result?.ok !== true) throw new Error(result?.error ?? `HTTP ${response.status}`);
			};

			const run = async (payload) => {
				setBusy(true);
				setError(undefined);
				try {
					await post(payload);
					onSaved();
				} catch (e) {
					setError(translate("dialog.saveFailed", { reason: String(e?.message ?? e) }));
				} finally {
					setBusy(false);
				}
			};

			const save = () => {
				if (cookie.trim() === "") {
					setError(translate("cookie.needCookie"));
					return;
				}
				void run({ cookie });
			};

			return jsxs("div", {
				className: S.dlgOverlay,
				onPointerDown: (event) => {
					if (event.target === event.currentTarget) onClose();
				},
				children: [
					jsxs("div", {
						className: S.dlg,
						role: "dialog",
						"aria-label": translate("cookie.title"),
						children: [
							jsxs("div", {
								className: S.dlgHead,
								children: [
									jsx("span", { className: S.dlgTitle, children: `${translate("cookie.title")} · ${account.displayName}` }),
									jsx("button", {
										type: "button",
										className: S.iconButton,
										"aria-label": translate("action.close"),
										onClick: onClose,
										children: jsx(IconClose, { size: 16 })
									})
								]
							}),
							jsxs("ol", {
								className: S.steps,
								children: [
									jsx("li", { children: translate("cookie.step1", { origin: consoleOrigin }) }),
									jsx("li", { children: translate("cookie.step2") }),
									jsx("li", { children: translate("cookie.step3") })
								]
							}),
							jsx("p", { className: S.note, children: translate("cookie.note") }),
							jsxs("label", {
								className: S.field,
								children: [
									jsx("span", { className: S.fieldLabel, children: translate("cookie.label") }),
									jsx("input", {
										className: S.input,
										type: "text",
										value: cookie,
										onChange: (event) => setCookie(event.target.value),
										placeholder: saved?.hasCookie === true ? translate("cookie.keep") : translate("cookie.placeholder"),
										autoComplete: "off",
										spellCheck: false
									})
								]
							}),
							saved?.hasCookie === true ? jsx("p", { className: S.note, children: translate("cookie.configured") }) : null,
							error === undefined ? null : jsx("p", { className: S.error, children: error }),
							jsxs("div", {
								className: S.actions,
								children: [
									saved?.hasCookie === true
										? jsx("button", {
												type: "button",
												className: `${S.btn} ${S.btnDanger}${busy ? ` ${S.busy}` : ""}`,
												disabled: busy,
												onClick: () => void run({ remove: true }),
												children: translate("dialog.remove")
											})
										: null,
									jsx("button", { type: "button", className: S.btn, disabled: busy, onClick: onClose, children: translate("action.close") }),
									jsx("button", {
										type: "button",
										className: `${S.btn} ${S.btnPrimary}${busy ? ` ${S.busy}` : ""}`,
										disabled: busy,
										onClick: save,
										children: translate("dialog.save")
									})
								]
							})
						]
					})
				]
			});
		}

		/** Index health. A stale or lossy index must say so on the page. */
		/**
		 * How long ago, in the words the question is actually asked in.
		 *
		 * The sweep runs every minute, so an absolute timestamp is always "about a
		 * minute ago" written as a clock time the reader has to subtract from. It
		 * also read as jargon — the line said "index updated", which is this
		 * package's internal word for its rollup table, and a user reasonably
		 * asked what an index was.
		 */
		function agoLabel(at, translate, now = Date.now()) {
			if (typeof at !== "number") return translate("footer.never");
			const seconds = Math.max(0, Math.round((now - at) / 1000));
			if (seconds < 90) return translate("footer.justNow");
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return translate("footer.minutes", { n: minutes });
			const hours = Math.round(minutes / 60);
			if (hours < 24) return translate("footer.hours", { n: hours });
			return translate("footer.days", { n: Math.round(hours / 24) });
		}

		//#region trend

		/** The trend line's spans, newest day last. `all` starts at the first recorded day. */
		const TREND_SPANS = [
			{ id: "30", days: 30 },
			{ id: "90", days: 90 },
			{ id: "all", days: undefined }
		];

		/** The drawing box, in viewBox units; the SVG scales it to the panel's width. */
		const TREND_BOX = { width: 560, height: 150, left: 46, right: 10, top: 10, bottom: 22 };

		/** A round ceiling for the y axis: 1, 2 or 5 times a power of ten. */
		function niceCeil(value) {
			if (!(value > 0)) return 1;
			const power = 10 ** Math.floor(Math.log10(value));
			for (const step of [1, 2, 5, 10]) if (step * power >= value) return step * power;
			return 10 * power;
		}

		/**
		 * Every day of a span, idle days present as zero. A line that skipped
		 * them would slope straight across a quiet week as if it had been busy.
		 */
		function trendPoints(daily, span, metric, today = new Date()) {
			const byDay = new Map((daily ?? []).map((d) => [d.day, d]));
			const end = new Date(today);
			end.setHours(0, 0, 0, 0);
			const first = (daily ?? [])[0]?.day;
			let start;
			if (span.days !== undefined) {
				start = new Date(end);
				start.setDate(start.getDate() - (span.days - 1));
			} else if (first !== undefined) {
				const [y, m, d] = first.split("-").map(Number);
				start = new Date(y, m - 1, d);
			} else {
				start = new Date(end);
			}
			const points = [];
			// Stepped by calendar date, not by 86 400 000 ms: a daylight-saving
			// day is 23 or 25 hours long, and a fixed step drifts off midnight.
			for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
				const key = localDayKey(date);
				const row = byDay.get(key);
				const value = metric === "cost" ? (row?.cost ?? 0) : (row?.tokens ?? 0);
				points.push({ day: key, value, row });
			}
			return points;
		}

		/** One value as the axis and the tooltip print it. */
		function trendValue(value, metric, currency) {
			return metric === "cost" ? fmtMoney(value, currency) : fmtCompact(value);
		}

		/**
		 * Daily usage as a line: tokens or estimated cost, over 30 / 90 days or
		 * the whole ledger. One series, so no legend — the toggle names it. One
		 * axis: the two measures are never drawn together.
		 *
		 * Days are the finest grain the ledger keeps (it rolls up per session per
		 * day), which is why there is no single-day, by-hour view.
		 */
		function TrendChart({ data, translate }) {
			const [metric, setMetric] = react.useState("tokens");
			const [spanId, setSpanId] = react.useState("30");
			const [hover, setHover] = react.useState(null);

			const daily = data.daily ?? [];
			const currency = daily.find((d) => typeof d.currency === "string")?.currency;
			// No priced day at all: there is no cost line to draw, only zeros.
			const costable = currency !== undefined && daily.some((d) => (d.cost ?? 0) > 0);
			const shown = metric === "cost" && costable ? "cost" : "tokens";
			const span = TREND_SPANS.find((s) => s.id === spanId) ?? TREND_SPANS[0];
			const points = trendPoints(daily, span, shown);

			const B = TREND_BOX;
			const plotW = B.width - B.left - B.right;
			const plotH = B.height - B.top - B.bottom;
			const max = niceCeil(Math.max(0, ...points.map((p) => p.value)));
			const xAt = (i) => B.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
			const yAt = (v) => B.top + plotH - (v / max) * plotH;
			const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join("");
			const total = points.reduce((sum, p) => sum + p.value, 0);

			// The crosshair snaps to the nearest DAY under the pointer; nobody has
			// to land on a 2px line to read it.
			const onMove = (event) => {
				const box = event.currentTarget.getBoundingClientRect();
				if (!(box.width > 0) || points.length === 0) return;
				const x = ((event.clientX - box.left) / box.width) * B.width;
				const ratio = points.length <= 1 ? 0 : (x - B.left) / plotW;
				const index = Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
				setHover({
					index,
					x: box.left + xAt(index) * (box.width / B.width),
					y: box.top + yAt(points[index].value) * (box.height / B.height)
				});
			};

			const seg = (options, value, onChange) =>
				jsx("div", {
					className: S.seg,
					role: "group",
					children: options.map((o) =>
						jsx(
							"button",
							{
								type: "button",
								className: S.segBtn,
								...(o.id === value ? { "data-on": "" } : {}),
								...(o.disabled ? { disabled: true, title: translate("trend.noCost") } : {}),
								onClick: () => onChange(o.id),
								children: o.label
							},
							o.id
						)
					)
				});

			const grid = [0, 0.5, 1].map((f) => f * max);
			const xTicks = points.length === 0 ? [] : [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
			const shortDay = (key) => {
				const [, m, d] = key.split("-").map(Number);
				return `${m}/${d}`;
			};
			const hovered = hover === null ? undefined : points[hover.index];

			return jsxs("div", {
				className: S.trend,
				children: [
					jsxs("div", {
						className: S.trendControls,
						children: [
							seg(
								[
									{ id: "tokens", label: translate("trend.tokens") },
									{ id: "cost", label: translate("trend.cost"), disabled: !costable }
								],
								shown,
								setMetric
							),
							seg(
								TREND_SPANS.map((s) => ({ id: s.id, label: translate(`trend.span.${s.id}`) })),
								span.id,
								setSpanId
							),
							jsx("span", {
								className: S.trendTotal,
								children: translate("trend.total", { value: trendValue(total, shown, currency) })
							})
						]
					}),
					jsxs("svg", {
						className: S.trendSvg,
						viewBox: `0 0 ${B.width} ${B.height}`,
						role: "img",
						"aria-label": translate("trend.aria", {
							span: translate(`trend.span.${span.id}`),
							metric: translate(`trend.${shown}`),
							value: trendValue(total, shown, currency)
						}),
						onPointerMove: onMove,
						onPointerLeave: () => setHover(null),
						children: [
							...grid.map((v, i) =>
								jsxs(
									"g",
									{
										children: [
											jsx("line", { className: S.trendGrid, x1: B.left, x2: B.width - B.right, y1: yAt(v), y2: yAt(v) }),
											jsx("text", { className: S.trendAxis, x: B.left - 6, y: yAt(v) + 3, textAnchor: "end", children: trendValue(v, shown, currency) })
										]
									},
									`g${i}`
								)
							),
							...xTicks.map((i) =>
								jsx(
									"text",
									{
										className: S.trendAxis,
										x: xAt(i),
										y: B.height - 6,
										textAnchor: i === 0 ? "start" : i === points.length - 1 ? "end" : "middle",
										children: shortDay(points[i].day)
									},
									`x${i}`
								)
							),
							points.length > 1 ? jsx("path", { className: S.trendLine, d: path }) : null,
							hovered === undefined
								? null
								: jsx("line", { className: S.trendGuide, x1: xAt(hover.index), x2: xAt(hover.index), y1: B.top, y2: B.top + plotH }),
							hovered === undefined && points.length !== 1
								? null
								: jsx("circle", {
										className: S.trendDot,
										cx: xAt(hovered === undefined ? 0 : hover.index),
										cy: yAt((hovered ?? points[0]).value),
										r: 4
									}),
							// The hit area: the whole plot, so the pointer only has to
							// be over the right date.
							jsx("rect", { className: S.trendHit, x: B.left, y: 0, width: plotW, height: B.height })
						]
					}),
					hovered === undefined
						? null
						: jsx(TrendTip, { point: hovered, x: hover.x, y: hover.y, metric: shown, currency, translate })
				]
			});
		}

		/** The crosshair's readout: the day, the charted figure, and the other one beside it. */
		function TrendTip({ point, x, y, metric, currency, translate }) {
			const left = Math.min(Math.max(x - 90, 8), Math.max(8, window.innerWidth - 198));
			const row = point.row;
			const other =
				metric === "cost"
					? `${fmtCompact(row?.tokens ?? 0)} tokens`
					: typeof row?.cost === "number" && currency !== undefined
						? translate("trend.costOf", { value: fmtMoney(row.cost, currency) })
						: undefined;
			return jsxs("div", {
				className: `${S.tip} ${S.trendTip}`,
				style: { left: `${left}px`, top: `${Math.max(8, y - 12)}px`, transform: "translateY(-100%)" },
				children: [
					jsx("div", { className: S.tipHead, children: jsx("span", { className: S.tipDate, children: point.day }) }),
					jsxs("div", {
						className: S.tipTotal,
						children: [
							trendValue(point.value, metric, currency),
							metric === "cost" ? null : jsx("span", { className: S.tipUnit, children: "tokens" })
						]
					}),
					jsx("p", {
						className: S.tipQuiet,
						children: [other, translate("caption.requests", { n: fmt(row?.requests ?? 0) })].filter(Boolean).join(" · ")
					})
				]
			});
		}
		//#endregion

		function Footer({ data, translate }) {
			const d = data.diagnostics ?? {};
			// When the logs were LOOKED AT, not when they last changed. Those are
			// different facts, and reporting the second as freshness made a quiet
			// hour look like a stuck panel — the figures were current the whole
			// time, and the line said they were an hour old.
			const checked = data.lastSweepAt;
			return jsxs("div", {
				className: S.footer,
				children: [
					jsx("span", {
						// The exact moment is still one hover away, for anyone who
						// wants to know rather than to judge freshness.
						title: typeof checked === "number" ? new Date(checked).toLocaleString() : "",
						children: translate("footer.updated", { ago: agoLabel(checked, translate) })
					}),
					typeof d.lastUsageAt === "number"
						? jsx("span", {
								title: new Date(d.lastUsageAt).toLocaleString(),
								children: ` · ${translate("footer.lastActivity", { ago: agoLabel(d.lastUsageAt, translate) })}`
							})
						: null,
					d.unattributedRows > 0
						? jsx("span", {
								className: S.warn,
								children: ` · ${translate("footer.unattributed", { n: fmt(d.unattributedRows) })}`
							})
						: null
				]
			});
		}

		function Skeleton() {
			return jsxs("div", {
				children: [
					jsx("div", {
						className: S.stats,
						children: [0, 1, 2].map((i) => jsx("div", { className: `${S.skel} ${S.skelStat}` }, i))
					}),
					jsx("div", { className: S.section, children: jsx("div", { className: S.skel, style: { height: "76px" } }) })
				]
			});
		}

		/** The card's props for one account: the payload that landed, or a skeleton. */
		function balanceStateOf(balances, account) {
			const card = (balances ?? {})[account?.id ?? ""];
			// Nothing landed yet is a card still loading, never a blank: the
			// section's height would jump on every open otherwise.
			return card === undefined ? { status: "loading" } : { status: "ready", data: card };
		}

		/** The panel body: every section, each complete. */
		function Body({ state, balances, site, onSelect, range, onRange, translate, onRetry, onConfigure }) {
			if (state.status === "error") {
				return jsxs("div", {
					children: [
						jsx("p", { className: S.error, children: translate("error.load") }),
						jsx("p", { className: S.note, children: state.message }),
						jsx("button", { type: "button", className: S.retry, onClick: onRetry, children: translate("action.retry") })
					]
				});
			}
			if (state.data === undefined) return jsx(Skeleton, {});

			const data = state.data;
			const empty = (data.totals?.requests ?? 0) === 0;
			// One card per account, in the host's own order — the panel no longer
			// asks which one to look at (用户 2026-10-04「显示全部余额，不要选择了」).
			// With none listed (no provider directory yet) the single card is the
			// old no-argument read, which the host answers for the first account.
			const accounts = data.accounts ?? [];
			const cards = accounts.length === 0 ? [undefined] : accounts;

			return jsxs("div", {
				children: [
					jsx(Section, {
						title: translate("section.balance"),
						children: jsx("div", {
							className: S.balances,
							children: cards.map((account) =>
								jsx(
									BalanceRow,
									{
										state: balanceStateOf(balances, account),
										account,
										translate,
										// Each card configures ITS own account: the dialog that
										// stores a site's console credentials belongs beside the
										// read that failed for that site, not beside a selection.
										onConfigure: account === undefined ? undefined : () => onConfigure(account)
									},
									account?.id ?? ""
								)
							)
						})
					}),
					jsx(Section, {
						title: translate("section.usage"),
						action: site === undefined
							? null
							: jsx("button", {
									type: "button",
									className: S.filter,
									onClick: () => onSelect(undefined),
									children: translate("filter.clear", { site })
								}),
						children: jsxs("div", {
							children: [
								jsx(StatRow, { data, range, onRange, translate }),
								empty
									? jsx("p", { className: S.note, children: translate("state.empty") })
									: jsx(StatCaption, { data, translate })
							]
						})
					}),
					jsx(Section, {
						title: translate("section.sites"),
						children: jsx(SiteRows, { data, site, onSelect, translate })
					}),
					// Above the activity strip: "which project" is asked more often
					// than "which day", and the strip is the tallest thing here.
					empty
						? null
						: jsx(Section, { title: translate("section.projects"), children: jsx(ProjectRows, { data, translate }) }),
					empty ? null : jsx(Section, { title: translate("section.models"), children: jsx(ModelTable, { data, translate }) }),
					empty
						? null
						: jsx(Section, {
								title: translate("section.activity"),
								// Days are cut by the HOST's clock, so the panel says whose.
								action:
									data.timeZone === undefined
										? null
										: jsx("span", {
												className: S.zone,
												title: data.timeZone.name ?? "",
												children: data.timeZone.offset
											}),
								children: jsx(ActivityStrip, { data, translate })
							}),
					// Last: the day-by-day line, with its own window and its own measure.
					(data.daily ?? []).length === 0
						? null
						: jsx(Section, { title: translate("section.trend"), children: jsx(TrendChart, { data, translate }) }),
					jsx(Footer, { data, translate })
				]
			});
		}

		/**
		 * The footer seat and its panel.
		 *
		 * The slot hands over only `wide` — whether the sidebar is expanded or
		 * collapsed to its rail — so everything else, including the panel's own
		 * open state and chrome, belongs to this component.
		 */
		function TokenLedgerPanel({ wide, t }) {
			const [open, setOpen] = react.useState(false);
			const [range, setRange] = react.useState("all");
			const [site, setSite] = react.useState(undefined);
			const [nonce, setNonce] = react.useState(0);
			// Moves only from the refresh button: a forced balance read skips the
			// host's freshness window (never its rate-limit backoff). Every other
			// re-render reads through the cache, which is what keeps a panel open
			// from becoming a request.
			const [forceNonce, setForceNonce] = react.useState(0);
			const [dialogFor, setDialogFor] = react.useState(undefined);
			const [tick, setTick] = react.useState(0);
			react.useEffect(() => {
				const timer = setInterval(() => setTick((n) => n + 1), BADGE_REFRESH_MS);
				return () => clearInterval(timer);
			}, []);
			const days = (RANGES.find((r) => r.id === range) ?? RANGES[2]).days();
			const state = useUsage(open, days, site, nonce, tick);
			// Every account's card, read off the same usage payload that lists
			// them: the two always agree on WHAT the accounts are, so a card can
			// never name an account the panel is not showing usage for. Waiting
			// for that payload is also what keeps an open from first asking for
			// "the first account" and then asking again for each one by name.
			const balances = useBalances(open && state.data !== undefined, state.data?.accounts ?? [], nonce, forceNonce);
			// After every hook above, so their state cells keep their order.
			const currentModel = useCurrentModel();
			const routeBalance = useRouteBalance(currentModel?.provider, nonce, tick);
			const reload = () => setNonce((n) => n + 1);
			const translate = translateWith(t);

			// Escape and a click anywhere else both close, and both listeners exist
			// only while open: a global handler that outlives the panel would
			// swallow the key, or the click, from whatever owns it next.
			//
			// The badge lives inside `root` too, so its own toggle handles it and
			// this does not fire — otherwise clicking the badge to close would
			// close and immediately reopen.
			//
			// `pointerdown` rather than `click`: a press that starts inside the
			// panel and drifts out (selecting a figure to copy, dragging the
			// activity strip) must not be read as a dismissal.
			const root = react.useRef(null);
			react.useEffect(() => {
				if (!open) return undefined;
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				const onDown = (event) => {
					if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
				};
				window.addEventListener("keydown", onKey);
				document.addEventListener("pointerdown", onDown, true);
				return () => {
					window.removeEventListener("keydown", onKey);
					document.removeEventListener("pointerdown", onDown, true);
				};
			}, [open]);

			const busy = state.status === "loading";
			// The badge answers today's two questions at a glance: tokens used and
			// what they cost, both independent of the range currently selected in
			// the panel. A compact figure keeps it readable at 12px.
			const todayWindow = state.data?.windows?.today;
			const todayCostAmount = state.data?.todayCost;
			const badgeTokens = state.data === undefined ? "" : fmtCompact(todayWindow?.tokens);
			const badgeCost = todayCostAmount === null || todayCostAmount === undefined
				? ""
				: fmtMoney(todayCostAmount.cost, todayCostAmount.currency);
			const totalLabel = [badgeTokens, badgeCost].filter(Boolean).join(" · ");
			// The second line: what is left behind the model the open session is
			// set to. The hover names that route and model, since the line itself
			// has room for the figure only.
			const balanceLine = badgeBalanceText(routeBalance, translate, currentModel?.model);
			const balanceTitle =
				balanceLine === undefined
					? undefined
					: [
							// The line itself first: three windows can outrun a narrow
							// sidebar, and the ellipsis must not be the only copy.
							balanceLine,
							[currentModel.model === undefined ? currentModel.provider : `${currentModel.provider}/${currentModel.model}`, routeBalance?.displayName]
								.filter(Boolean)
								.join(" · ")
						].join("\n");

			return jsxs("div", {
				ref: root,
				className: wide === false ? `${S.layer} ${S.rail}` : S.layer,
				children: [
					jsxs("button", {
						type: "button",
						className: S.badge,
						...(open ? { "data-active": "" } : {}),
						title: translate("panel.title"),
						"aria-label": translate("panel.title"),
						onClick: () => setOpen((value) => !value),
						children: [
							jsx("span", { className: S.badgeIcon, children: jsx(IconData, { size: 16 }) }),
							jsxs("span", {
								className: S.badgeText,
								children: [
									jsx("span", { className: S.badgeLabel, children: translate("panel.title") }),
									balanceLine === undefined
										? null
										: jsx("span", { className: S.badgeSub, title: balanceTitle, children: balanceLine })
								]
							}),
							jsx("span", { className: S.badgeValue, children: totalLabel })
						]
					}),
					open &&
						jsxs("div", {
							className: S.panel,
							role: "dialog",
							"aria-label": translate("panel.title"),
							children: [
								jsxs("div", {
									className: S.header,
									children: [
										jsx("div", {
											className: S.headerLeft,
											children: jsx("span", { className: S.title, children: translate("panel.title") })
										}),
										jsxs("div", {
											className: S.headerActions,
											children: [
													jsx("button", {
													type: "button",
													className: S.iconButton,
													...(busy ? { "data-busy": "" } : {}),
													"aria-label": translate("action.refresh"),
													onClick: () => {
														if (!busy) {
															reload();
															setForceNonce((f) => f + 1);
														}
													},
													children: jsx(IconRefresh, { size: 14 })
												}),
												jsx("button", {
													type: "button",
													className: S.iconButton,
													"aria-label": translate("action.close"),
													onClick: () => setOpen(false),
													children: jsx(IconClose, { size: 16 })
												})
											]
										})
									]
								}),
								jsx("div", {
									className: S.body,
									children: jsx(Body, {
										state,
										balances,
										site,
										onSelect: setSite,
										range,
										onRange: setRange,
										translate,
										onRetry: reload,
										onConfigure: setDialogFor
									})
								})
							]
						}),
						dialogFor === undefined
							? null
							: jsx(CONSOLE_ORIGINS[dialogFor.scheme] === undefined ? UserAuthDialog : CookieDialog, {
									account: dialogFor,
									translate,
									onClose: () => setDialogFor(undefined),
									// Whatever was just saved or cleared, the host dropped that
									// origin's cache; a plain reload reads the network.
									onSaved: () => {
										setDialogFor(undefined);
										reload();
									}
								})
				]
			});
		}
		//#endregion

		//#region locales
		const zh = {
			"panel.title": "用量账本",
			"badge.balance": "余额 {amount}",
			"badge.spent": "已用 {amount}",
			"range.today": "今日",
			"range.month": "本月",
			"range.all": "累计",
			"action.refresh": "刷新",
			"action.close": "关闭",
			"action.retry": "重试",
			"state.loading": "读取中…",
			"state.empty": "这个区间内没有记录到任何用量。",
			"error.load": "读不到用量数据。",
			"section.balance": "余额",
			"section.usage": "Token 用量",
			"section.sites": "中转站分布",
			"section.activity": "活跃度",
			"section.models": "模型",
			"section.projects": "按项目",
			"projects.none": "还没有能归到项目的用量。",
			"projects.unattributed": "未记录目录",
			"filter.clear": "只看 {site} ×",
			"caption.requests": "{n} 请求",
			"caption.hit": "缓存命中 {rate}",
			"caption.cost": "估算 {cost}",
			"sites.direct": "直连/官方",
			"sites.unrouted": "未知路由",
			"sites.none": "没有发现中转站——直连的话这就是全部。",
			"activity.none": "这个区间内没有活跃记录。",
			"activity.level": "等级 {level}",
			"activity.quiet": "这天没有跑过请求。",
			"month.0": "1月",
			"month.1": "2月",
			"month.2": "3月",
			"month.3": "4月",
			"month.4": "5月",
			"month.5": "6月",
			"month.6": "7月",
			"month.7": "8月",
			"month.8": "9月",
			"month.9": "10月",
			"month.10": "11月",
			"month.11": "12月",
			"weekday.0": "一",
			"weekday.1": "二",
			"weekday.2": "三",
			"weekday.3": "四",
			"weekday.4": "五",
			"weekday.5": "六",
			"weekday.6": "日",
			"activity.less": "少",
			"activity.more": "多",
			"section.trend": "日用量",
			"trend.tokens": "Token",
			"trend.cost": "估算费用",
			"trend.noCost": "没有可估算费用的记录",
			"trend.span.30": "30 天",
			"trend.span.90": "90 天",
			"trend.span.all": "全部",
			"trend.total": "合计 {value}",
			"trend.costOf": "估算 {value}",
			"trend.aria": "{span}每日{metric}折线，合计 {value}",
			"table.model": "模型",
			"table.requests": "请求",
			"table.total": "总计",
			"table.input": "输入",
			"table.cache": "缓存",
			"table.output": "输出",
			"table.cost": "估算",
			"table.none": "没有模型记录。",
			"balance.plan": "套餐 {plan}",
			"balance.declared": "自定义端点",
			"balance.unlimited": "不限额度",
			"balance.quota": "{n} 额度",
			"balance.spent": "已用",
			"balance.spentAmount": "已用 {amount}",
			"balance.expires": "{at} 到期",
			"balance.unknownSoftware": "没有可用的余额读取器：认不出这个站点的程序，或这类站点本就没有内置读取器。可点「设置查询API」自己声明查询端点。",
			"balance.unknownAccount": "找不到这个账户。",
			"balance.failed": "余额读取失败（{reason}）。",
			"balance.hint.openrouter-management-key": "OpenRouter 的额度接口要的是 Management Key，不是这条路由用的推理 key。",
			"balance.noKey": "这条路由没有配置密钥，查不了余额。",
			"balance.active": "账户可用",
			"balance.inactive": "账户不可用",
			"balance.granted": "其中赠送 {amount}",
			"balance.grantedRecharge": "其中累计充值 {amount}",
			"balance.failedPlain": "余额读取失败。",
			"balance.row.failed": "读取失败",
			"balance.row.unsupported": "不支持",
			"balance.row.limited": "限流中",
			"balance.row.noKey": "未配置密钥",
			"balance.setButton": "设置查询API",
			"balance.setCookie": "设置 Cookie",
			"balance.hint.mimo-cookie-missing": "小米 MiMo 的余额只能从控制台读：API key 没有余额接口。点「设置 Cookie」粘贴控制台的登录 Cookie。",
			"balance.hint.mimo-cookie-expired": "小米控制台的登录已过期（Cookie 约一天失效）。重新登录后点「设置 Cookie」换一份。",
			"balance.hint.antigravity-signin": "Antigravity 没有登录 Google 账号（{reason}）。在 DSH 设置里的 Antigravity 认证页登录后，这里会显示各模型组的 5 小时与每周额度。",
			"balance.group.gemini": "Gemini",
			"balance.group.non-gemini": "Claude 与 GPT",
			"balance.hint.deepseek-signin": "DeepSeek 没有登录（或登录已失效），这条路由的 key 也读不到余额（{reason}）。在 DSH 里登录 DeepSeek 后，这里会显示登录账户的钱包。",
			"cookie.title": "设置 Cookie — 控制台登录",
			"cookie.step1": "浏览器登录 {origin}",
			"cookie.step2": "F12 → 网络（Network）→ 刷新页面，点开任意一个 /api/v1/ 开头的请求（如 balance）",
			"cookie.step3": "在「请求标头」里复制 cookie 的整段值，粘贴到下面保存",
			"cookie.note": "Cookie 约一天过期，过期后余额卡会提示，照同样步骤换一份即可。它能登录你的整个控制台账户，只存在本机（~/.dsh/tokenledger-credentials.json），只发往上面这个控制台地址。",
			"cookie.label": "Cookie",
			"cookie.placeholder": "粘贴整段 cookie",
			"cookie.keep": "已配置——粘贴新的即替换",
			"cookie.configured": "已保存一份 Cookie。",
			"cookie.needCookie": "请粘贴 Cookie。",
			"cookie.invalid": "这不像控制台的登录 Cookie：需要同时含 serviceToken 和 userId 两项",
			"balance.rateLimited": "查询已限流，{at} 后可再试。",
			"balance.stale": "已限流，{at} 前不刷新 · {ago}的结果",
			"balance.unparsed": "接口答了，但认不出配额字段（{reason}）。可以把这句话反馈给我们。",
			"dialog.title": "设置余额 — New API 个人账户",
			"dialog.step1": "登录该中转站的网页控制台",
			"dialog.step2": "个人设置 → 生成「系统访问令牌」(access_token)",
			"dialog.step3": "个人设置 → 复制用户 ID（数字）",
			"dialog.step4": "填入下方保存；面板改用个人钱包接口查询，不再消耗模型 key 的查询次数",
			"dialog.note": "站点默认限流：20 分钟 5 次。面板会缓存并自适应重试，限流时沿用上次结果并以小字提示。同一站点的多条路由共用这份配置。",
			"dialog.userId": "用户 ID",
			"dialog.userIdPlaceholder": "用户ID",
			"dialog.tokenLabel": "系统访问令牌 (access_token)",
			"dialog.tokenPlaceholder": "粘贴令牌",
			"dialog.keepToken": "已配置——留空保持不变",
			"dialog.configured": "该站点已配置个人钱包查询。",
			"dialog.save": "保存",
			"dialog.remove": "清除",
			"dialog.badUserId": "用户 ID 必须是正整数。",
			"dialog.needToken": "请填写系统访问令牌。",
			"dialog.saveFailed": "保存失败（{reason}）。",
			"dialog.hostStale": "宿主还在运行旧版插件（接口不存在）。请完全退出 DeepSeek Harness 桌面应用（含托盘图标）后重新打开，再回到面板保存。",
			"balance.window.session": "当前窗口",
			"balance.window.daily": "每日窗口",
			"balance.window.weekly": "每周窗口",
			"balance.window.monthly": "每月窗口",
			"balance.window.billing": "计费周期",
			"balance.window.hours": "{n} 小时窗口",
			"balance.window.days": "{n} 天窗口",
			"balance.window.minutes": "{n} 分钟窗口",
			"balance.window.reset": "{at} 重置",
			"balance.window.used": "已用 {pct}%",
			"balance.window.unlimited": "不限量",
			"balance.noRoute": "没有直连 DeepSeek 官方的路由——中转站没有余额接口。",
			"balance.unavailable": "这个部署问不到 provider 配置。",
			"footer.updated": "{ago}从会话日志读取",
			"footer.justNow": "刚刚",
			"footer.minutes": "{n} 分钟前",
			"footer.hours": "{n} 小时前",
			"footer.days": "{n} 天前",
			"footer.never": "尚未",
			"footer.lastActivity": "最近一次用量{ago}",
			"footer.unattributed": "{n} 行认不出是哪个站"
		};
		const en = {
			"panel.title": "Token Ledger",
			"badge.balance": "Balance {amount}",
			"badge.spent": "Spent {amount}",
			"range.today": "Today",
			"range.month": "This month",
			"range.all": "All time",
			"action.refresh": "Refresh",
			"action.close": "Close",
			"action.retry": "Retry",
			"state.loading": "Loading…",
			"state.empty": "No usage recorded in this range.",
			"error.load": "Could not read usage data.",
			"section.balance": "Balance",
			"section.usage": "Token usage",
			"section.sites": "By relay site",
			"section.activity": "Activity",
			"section.models": "Models",
			"section.projects": "By project",
			"projects.none": "No usage has been attributed to a project yet.",
			"projects.unattributed": "No directory recorded",
			"filter.clear": "{site} only ×",
			"caption.requests": "{n} requests",
			"caption.hit": "{rate} cached",
			"caption.cost": "est. {cost}",
			"sites.direct": "Direct",
			"sites.unrouted": "Unrecognised route",
			"sites.none": "No relay sites found — if you go direct, this is all of it.",
			"activity.none": "No activity in this range.",
			"activity.level": "Level {level}",
			"activity.quiet": "Nothing ran this day.",
			"month.0": "Jan",
			"month.1": "Feb",
			"month.2": "Mar",
			"month.3": "Apr",
			"month.4": "May",
			"month.5": "Jun",
			"month.6": "Jul",
			"month.7": "Aug",
			"month.8": "Sep",
			"month.9": "Oct",
			"month.10": "Nov",
			"month.11": "Dec",
			"weekday.0": "Mon",
			"weekday.1": "Tue",
			"weekday.2": "Wed",
			"weekday.3": "Thu",
			"weekday.4": "Fri",
			"weekday.5": "Sat",
			"weekday.6": "Sun",
			"activity.less": "Less",
			"activity.more": "More",
			"section.trend": "Daily usage",
			"trend.tokens": "Tokens",
			"trend.cost": "Est. cost",
			"trend.noCost": "Nothing priced to estimate",
			"trend.span.30": "30 days",
			"trend.span.90": "90 days",
			"trend.span.all": "All",
			"trend.total": "Total {value}",
			"trend.costOf": "est. {value}",
			"trend.aria": "Daily {metric} over {span}, total {value}",
			"table.model": "Model",
			"table.requests": "Req",
			"table.total": "Total",
			"table.input": "Input",
			"table.cache": "Cache",
			"table.output": "Output",
			"table.cost": "Est.",
			"table.none": "No model records.",
			"balance.plan": "{plan} plan",
			"balance.declared": "declared endpoint",
			"balance.unlimited": "Unlimited",
			"balance.quota": "{n} quota",
			"balance.spent": "spent",
			"balance.spentAmount": "{amount} spent",
			"balance.expires": "expires {at}",
			"balance.unknownSoftware": "No balance reader for this site: its software is unrecognised, or none is built in for it. Declare a query endpoint with \"Set query API\".",
			"balance.unknownAccount": "No such account.",
			"balance.failed": "Could not read the balance ({reason}).",
			"balance.hint.openrouter-management-key": "OpenRouter's credits endpoint wants a Management Key, not the inference key this route uses.",
			"balance.noKey": "That route has no key configured.",
			"balance.active": "Account active",
			"balance.inactive": "Account inactive",
			"balance.granted": "{amount} granted",
			"balance.grantedRecharge": "of which recharged {amount}",
			"balance.failedPlain": "Could not read the balance.",
			"balance.row.failed": "unreadable",
			"balance.row.unsupported": "unsupported",
			"balance.row.limited": "rate-limited",
			"balance.row.noKey": "no key",
			"balance.setButton": "Set query API",
			"balance.setCookie": "Set cookie",
			"balance.hint.mimo-cookie-missing": "Xiaomi MiMo's balance is only readable from its console; API keys have no balance endpoint. Use \"Set cookie\" to paste the console's sign-in cookie.",
			"balance.hint.mimo-cookie-expired": "The Xiaomi console session has expired (cookies last about a day). Sign in again and use \"Set cookie\" to replace it.",
			"balance.hint.antigravity-signin": "Antigravity has no Google account signed in ({reason}). Sign in on the Antigravity auth page in DSH settings and this card shows each model group's five-hour and weekly quota.",
			"balance.group.gemini": "Gemini",
			"balance.group.non-gemini": "Claude and GPT",
			"balance.hint.deepseek-signin": "DeepSeek is not signed in on this Host (or the sign-in lapsed), and the route's key could not read a balance either ({reason}). Sign in to DeepSeek in DSH and this card shows the account's wallet.",
			"cookie.title": "Set cookie — console sign-in",
			"cookie.step1": "Sign in to {origin} in a browser.",
			"cookie.step2": "F12 → Network → reload, and open any request under /api/v1/ (balance, for one).",
			"cookie.step3": "Copy the whole cookie value from its request headers and paste it below.",
			"cookie.note": "The cookie expires after about a day; the balance card says so, and the same steps replace it. It signs in to your whole console account, is kept only on this machine (~/.dsh/tokenledger-credentials.json), and is sent only to the console above.",
			"cookie.label": "Cookie",
			"cookie.placeholder": "Paste the whole cookie",
			"cookie.keep": "Stored — paste a new one to replace it",
			"cookie.configured": "A cookie is stored.",
			"cookie.needCookie": "Paste the cookie.",
			"cookie.invalid": "That does not look like the console's sign-in cookie: it needs both serviceToken and userId",
			"balance.rateLimited": "Rate-limited; retry after {at}.",
			"balance.stale": "rate-limited until {at} · showing {ago}",
			"balance.unparsed": "The endpoint answered, but none of the quota fields were where they were expected ({reason}). Worth reporting.",
			"dialog.title": "Set balance — New API wallet",
			"dialog.step1": "Sign in to the relay's web console.",
			"dialog.step2": "Personal settings → generate a System Access Token (access_token).",
			"dialog.step3": "Personal settings → copy your numeric user ID.",
			"dialog.step4": "Fill in below; the panel then reads your personal wallet and stops spending the key's query budget.",
			"dialog.note": "Sites throttle console reads (default 5 per 20 minutes). The panel caches and backs off adaptively, showing the previous result with a small note while limited. Routes on one site share this entry.",
			"dialog.userId": "User ID",
			"dialog.userIdPlaceholder": "user ID",
			"dialog.tokenLabel": "System access token (access_token)",
			"dialog.tokenPlaceholder": "paste token",
			"dialog.keepToken": "configured — leave empty to keep",
			"dialog.configured": "This site is configured for wallet queries.",
			"dialog.save": "Save",
			"dialog.remove": "Clear",
			"dialog.badUserId": "The user ID must be a positive integer.",
			"dialog.needToken": "Paste the system access token.",
			"dialog.saveFailed": "Could not save ({reason}).",
			"dialog.hostStale": "The host is still running the previous plugin build (route missing). Fully quit the DeepSeek Harness desktop app — including the tray icon — and reopen it, then save again.",
			"balance.window.session": "Current window",
			"balance.window.daily": "Daily",
			"balance.window.weekly": "Weekly",
			"balance.window.monthly": "Monthly",
			"balance.window.billing": "Billing period",
			"balance.window.hours": "{n}-hour window",
			"balance.window.days": "{n}-day window",
			"balance.window.minutes": "{n}-minute window",
			"balance.window.reset": "resets {at}",
			"balance.window.used": "{pct}% used",
			"balance.window.unlimited": "Unlimited",
			"balance.noRoute": "No direct DeepSeek route — relays have no balance API.",
			"balance.unavailable": "This deployment exposes no provider directory.",
			"footer.updated": "Read from your session logs {ago}",
			"footer.justNow": "just now",
			"footer.minutes": "{n} min ago",
			"footer.hours": "{n} h ago",
			"footer.days": "{n} d ago",
			"footer.never": "never",
			"footer.lastActivity": "last usage {ago}",
			"footer.unattributed": "{n} rows could not be attributed"
		};

		/**
		 * Resolve a key through the host's locale service, then interpolate.
		 *
		 * `t` arrives as a prop because the registration names a `locale`
		 * namespace. It is still guarded: a composition without the service hands
		 * over nothing, and falling back to the zh dictionary renders words rather
		 * than raw keys.
		 */
		function translateWith(t) {
			return (key, params) => {
				const resolved = t === undefined ? undefined : t(key);
				const template = resolved === undefined || resolved === key ? (zh[key] ?? key) : resolved;
				if (params === undefined) return template;
				return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
			};
		}
		//#endregion

		/** Client-half services this bundle needs before it can register. */
		const inject = ["slots", "locale"];

		/**
		 * Register the seat.
		 *
		 * `slots.inject` rather than a bare `register`, so a late-declared or
		 * re-declared slot is followed instead of missed — the sidebar declares
		 * this hole, and this bundle must not assume it is already there.
		 */
		function apply(ctx) {
			console.info("[tokenledger] apply() called; registering the footer seat");
			hostCtx = ctx;
			// Warm the wallet cache at PAGE LOAD, once: one passive read per
			// configured site, so the first panel open finds the host's cache
			// hot and renders instantly instead of waiting on the network. The
			// host's freshness window and throttle backoff govern warm reads
			// exactly like panel-opened ones.
			let warmed = false;
			const warmWallets = () => {
				if (warmed || typeof fetch !== "function") return;
				warmed = true;
				fetchJson(`${USERAUTH_PATH}`)
					.then((payload) =>
						Promise.all(
							Object.entries(payload.origins ?? {})
								.filter(([, entry]) => entry.hasToken === true)
								.map(([origin]) =>
									fetchJson(`${BALANCE_PATH}?origin=${encodeURIComponent(origin)}`).catch(() => undefined)
								)
						)
					)
					.catch(() => undefined);
			};
			warmWallets();
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "tokenledger: dictionaries");
			} catch (error) {
				// Dictionaries are a nicety; the seat is the point. Losing one must
				// not cost the other.
				console.warn("[tokenledger] locale.register failed; falling back to built-in strings:", error);
			}
			try {
				ctx.slots.inject("sidebar.footer.action", () => {
					console.info("[tokenledger] sidebar.footer.action is available; registering");
					return ctx.slots.register(
						{ name: "sidebar.footer.action", id: "tokenledger", locale: NS, order: 20 },
						TokenLedgerPanel
					);
				});
			} catch (error) {
				console.error("[tokenledger] could not take the footer seat:", error);
				throw error;
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.TokenLedgerPanel = TokenLedgerPanel;
		exports.StatCaption = StatCaption;
		exports.ACTIVITY_DAYS = ACTIVITY_DAYS;
		exports.Body = Body;
		exports.StatRow = StatRow;
		exports.SiteRows = SiteRows;
		exports.ProjectRows = ProjectRows;
		exports.colorOf = colorOf;
		exports.ActivityStrip = ActivityStrip;
		exports.TrendChart = TrendChart;
		exports.trendPoints = trendPoints;
		exports.niceCeil = niceCeil;
		exports.ModelTable = ModelTable;
		exports.BalanceCard = BalanceCard;
		exports.BalanceRow = BalanceRow;
		exports.balanceRowValue = balanceRowValue;
		exports.badgeBalanceText = badgeBalanceText;
		exports.SetBalanceButton = SetBalanceButton;
		exports.UserAuthDialog = UserAuthDialog;
		exports.CookieDialog = CookieDialog;
		exports.QuotaWindows = QuotaWindows;
		exports.Footer = Footer;
		exports.agoLabel = agoLabel;
		exports.fmtClock = fmtClock;
		exports.translateWith = translateWith;
		exports.buildQuery = buildQuery;
		exports.makeLevelScale = makeLevelScale;
		exports.DayTip = DayTip;
		exports.localDayKey = localDayKey;
		exports.fmtMoney = fmtMoney;
		exports.fmtHit = fmtHit;
		exports.share = share;
		exports.fmt = fmt;
		exports.RANGES = RANGES;
		exports.USAGE_PATH = USAGE_PATH;
		exports.zh = zh;
		exports.en = en;
		console.info("[tokenledger] factory ready; exports:", Object.keys(module.exports).join(", "));
		return module.exports;
	}
});
