/** Runtime checks executed only from independently installed tarballs. */

const DECLARED = [
	"package.public-entry",
	"host.single-command-overlay",
	"domain.real-log-projection-and-refresh",
	"renderer.width-scan-20-40-80-120",
	"consumer.unload-cleanup"
];
const report = { declared: [...DECLARED], executed: [], skipped: [], failures: [], observations: [] };

class FixtureFailure extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function ensure(condition, code, message) {
	if (!condition) throw new FixtureFailure(code, message);
}

async function scenario(name, callback) {
	try {
		await callback();
		report.executed.push(name);
	} catch (error) {
		report.failures.push({
			scenario: name,
			code: error instanceof FixtureFailure ? error.code : "FIXTURE_SCENARIO_FAILED",
			message: error instanceof Error ? error.message : String(error)
		});
	}
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const rendered = (value) => JSON.stringify(value);

function findControl(root, id) {
	const seen = new WeakSet();
	const visit = (value) => {
		if (value === null || typeof value !== "object" || seen.has(value)) return undefined;
		seen.add(value);
		if (value.id === id) return value;
		for (const child of Object.values(value)) {
			const found = visit(child);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	return visit(root);
}

let cordis;
let blueApi;
let core;
let themeDark;
let plugin;

await scenario("package.public-entry", async () => {
	[cordis, blueApi, core, themeDark, plugin] = await Promise.all([
		import("@deepseek-ai/cordis"),
		import("@dsh-blue/blue-api"),
		import("@dsh-blue/blue-core"),
		import("@dsh-blue/blue-core/theme-dark"),
		import("dsh-tokenledger")
	]);
	ensure(plugin.name === "tokenledger", "FIXTURE_PLUGIN_NAME", "root package has the wrong Cordis name");
	ensure(typeof plugin.apply === "function", "FIXTURE_PLUGIN_APPLY", "root package has no callable apply");
	ensure(typeof core.compileBlueUiNode === "function", "FIXTURE_COMPILER", "Blue compiler export is missing");
});

let ctx;
let compilerContext;
let components;
let ownerLease;
let pluginFiber;
let persistenceDispose;
let overlay;

function ownerSnapshot() {
	const result = ownerLease.snapshot();
	ensure(result.ok, "FIXTURE_OWNER_STALE", result.message ?? "Blue owner became stale");
	return result.value;
}

await scenario("host.single-command-overlay", async () => {
	ctx = new cordis.Context();
	await ctx.plugin(blueApi);
	const control = ctx.get("bluePluginControl");
	ensure(control !== undefined, "FIXTURE_BLUE_CONTROL", "Blue host control is missing");
	ownerLease = control.attachCapabilities(ctx, ["commands", "overlays", "notifications.publish"]);

	let firstRead = true;
	persistenceDispose = ctx.provide("sessionPersistence", {
		async listSnapshots() {
			return [{ header: { id: "fixture-session", cwd: "/fixture/project" }, revision: "fixture-r1" }];
		},
		async readFrom(_id, from) {
			if (!firstRead || from > 0) return { events: [] };
			firstRead = false;
			return {
				events: [{
					type: "assistant/message",
					seq: 1,
					time: Date.UTC(2026, 7, 30, 12),
					data: {
						turn: 1,
						step: 1,
						message: { role: "assistant", source: { kind: "model", provider: "deepseek", model: "fixture/model" } },
						usage: { inputTokens: 1_000, outputTokens: 100 }
					}
				}]
			};
		}
	});
	pluginFiber = await ctx.plugin(plugin, { database: ":memory:", sweepIntervalMs: 0, sweepOnStart: true });
	for (let turn = 0; turn < 5; turn += 1) await settle();

	const idle = ownerSnapshot();
	ensure(idle.commands.length === 1 && idle.status.length === 0 && idle.panes.length === 0, "FIXTURE_COMMAND_ONLY", "TokenLedger did not contribute exactly one idle command");
	const command = idle.commands[0];
	const opened = await ownerLease.runUserGesture("commands", (userGesture) => command.execute([], { userGesture }));
	ensure(opened.ok, "FIXTURE_COMMAND_EXECUTE", opened.message ?? "TokenLedger command failed");
	overlay = ownerSnapshot().overlays.find((entry) => entry.id === "tokenledger.dashboard.overlay");
	ensure(overlay !== undefined, "FIXTURE_OVERLAY_MISSING", "TokenLedger overlay did not open");
	ensure(overlay.request.title === "TokenLedger 用量账本" && overlay.request.width === "96%", "FIXTURE_OVERLAY_POLICY", "managed overlay metadata drifted");
	const node = overlay.request.render();
	ensure(node.kind === "surface" && node.chrome === "none", "FIXTURE_SINGLE_FRAME", "dashboard attempted to own the managed frame");
	ensure(findControl(node, "tokenledger.range-tabs")?.kind === "tabs", "FIXTURE_RANGE_TABS", "range tabs are missing");
});

await scenario("domain.real-log-projection-and-refresh", async () => {
	const initial = rendered(overlay.request.render());
	ensure(/Token 用量/u.test(initial) && /中转站分布/u.test(initial) && /按项目/u.test(initial) && /活跃度/u.test(initial) && /模型/u.test(initial), "FIXTURE_SECTIONS", "dashboard is missing a Web-parity section");
	ensure(/累计 1,100/u.test(initial) && /fixture\/model/u.test(initial), "FIXTURE_REAL_USAGE", "durable log usage did not reach the Blue dashboard");
	const refreshed = await overlay.request.onEvent({ kind: "activate", controlId: "tokenledger.refresh" }, { signal: new AbortController().signal });
	ensure(refreshed.ok, "FIXTURE_REFRESH", refreshed.message ?? "dashboard refresh failed");
});

await scenario("renderer.width-scan-20-40-80-120", async () => {
	compilerContext = new cordis.Context();
	components = new core.BlueComponentsService(compilerContext, { theme: { colors: themeDark.DARK_COLORS }, tui: {} });
	const body = overlay.request.render();
	const managed = { kind: "surface", chrome: "overlay", title: overlay.request.title, padding: 1, child: body };
	for (const width of [20, 40, 80, 120]) {
		const compiled = core.compileBlueUiNode(managed, {
			components,
			colors: themeDark.DARK_COLORS,
			getViewport: () => ({ columns: width, rows: 40 }),
			screenMode: "alternate",
			emit: () => {}
		});
		ensure(compiled.ok, "FIXTURE_UI_COMPILE", compiled.message ?? `compile failed at ${String(width)} columns`);
		const rows = compiled.value.component.render(width);
		ensure(rows.some((row) => core.visibleWidth(row) > 0), "FIXTURE_UI_BLANK", `dashboard was blank at ${String(width)} columns`);
		for (const row of rows) ensure(core.visibleWidth(row) <= width, "FIXTURE_WIDTH_OVERFLOW", `dashboard exceeded ${String(width)} columns`);
	}
	report.observations.push({ scenario: "renderer.width-scan-20-40-80-120", widths: [20, 40, 80, 120], nodes: 1 });
});

await scenario("consumer.unload-cleanup", async () => {
	await pluginFiber.dispose();
	await settle();
	const after = ownerSnapshot();
	ensure(after.commands.length === 0 && after.overlays.length === 0, "FIXTURE_UNLOAD", "plugin unload left Blue registrations behind");
});

try {
	if (pluginFiber !== undefined && ownerSnapshot().commands.length > 0) await pluginFiber.dispose();
	if (persistenceDispose !== undefined) await persistenceDispose();
	ownerLease?.dispose();
	await ctx?.fiber.dispose();
	await compilerContext?.fiber.dispose();
} catch (error) {
	report.failures.push({ scenario: "runner.cleanup", code: "FIXTURE_CLEANUP", message: error instanceof Error ? error.message : String(error) });
}

for (const name of DECLARED) {
	if (!report.executed.includes(name) && !report.failures.some((failure) => failure.scenario === name)) {
		report.skipped.push({ scenario: name, reason: "scenario did not execute" });
	}
}
const valid = report.failures.length === 0 && report.skipped.length === 0 && report.executed.length === report.declared.length;
process.stdout.write(`${JSON.stringify({ ...report, valid }, null, 2)}\n`);
process.exitCode = valid ? 0 : 1;
