/**
 * Disposable SQLite index over the authoritative DSH session logs.
 *
 * The DSH log is the fact. Everything here is a projection that can be thrown
 * away and rebuilt, and the code is arranged so that rebuilding is the normal
 * path rather than a recovery path — a rebuild you only run after a disaster is
 * a rebuild you find out is broken during one.
 *
 * The load-bearing choice is that rollups are stored **per session**, keyed
 * `(sessionId, day, site, provider, model)`, not as one globally accumulated
 * figure. Re-folding a session then means deleting its rows and writing the new
 * ones; global numbers come from `GROUP BY`. The alternative — a single global
 * counter that each session adds into — requires subtracting a session's old
 * contribution before re-adding it, and a single arithmetic slip there corrupts
 * the total permanently with no way to notice. Here, a wrong session's rows are
 * replaced wholesale by the next fold and the damage cannot spread.
 *
 * Fold state that is not expressible as rollup rows — the last usage sample and
 * the current route, both needed to keep replacement semantics exact across a
 * fold boundary — rides the checkpoint row as JSON. It is O(1) per session.
 *
 * Uses Node's built-in `node:sqlite`, so the package keeps zero runtime
 * dependencies. Node emits an ExperimentalWarning for it on v22; that is
 * upstream's warning to give, not ours to swallow.
 *
 * @module dsh-tokenledger/store
 */

import { DatabaseSync } from "node:sqlite";

import { createUsageState, totalTokens, cacheHitRate, parseRouteKey, routeKey, zeroBuckets } from "./usage.js";

export const SCHEMA_VERSION = 5;

const COLUMNS = [
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens",
	"requests"
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_rollups (
  sessionId        TEXT    NOT NULL,
  day              TEXT    NOT NULL,
  site             TEXT    NOT NULL,
  provider         TEXT    NOT NULL,
  model            TEXT    NOT NULL,
  inputTokens      INTEGER NOT NULL DEFAULT 0,
  outputTokens     INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens  INTEGER NOT NULL DEFAULT 0,
  cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
  reasoningTokens  INTEGER NOT NULL DEFAULT 0,
  requests         INTEGER NOT NULL DEFAULT 0,
  -- Peak/off-peak phase of the usage (peak.js): 'peak', 'off', 'holiday', or
  -- '' for usage recorded before phases existed, which keeps its old price.
  phase            TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (sessionId, day, site, provider, model, phase)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_rollups_day  ON session_rollups (day);
CREATE INDEX IF NOT EXISTS idx_rollups_site ON session_rollups (site, day);
CREATE INDEX IF NOT EXISTS idx_rollups_provider ON session_rollups (provider, day);

-- Which directory a session ran in, which is what "project" means here.
--
-- Its own table rather than a column on session_rollups: the project is a
-- property of the SESSION, not of each (day, site, model) rollup row. As a
-- column it would store the same path dozens of times per session and widen a
-- primary key that is already five wide. Joined at query time instead.
--
-- The project column is the header's cwd with a trailing slash removed and
-- nothing else done to it. A session whose header carries no cwd is stored with
-- the empty string: present and countable, which is the point — a session that
-- cannot be attributed has to be visible as such, never quietly missing from a
-- total.
CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  project   TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project);

CREATE TABLE IF NOT EXISTS checkpoints (
  sessionId    TEXT PRIMARY KEY,
  consumedSeq  INTEGER NOT NULL,
  logRevision  TEXT,
  cursor       TEXT NOT NULL,
  dshVersion   TEXT,
  lastUsageAt  INTEGER,
  updatedAt    INTEGER NOT NULL
) WITHOUT ROWID;
`;

function rangeClause(range = {}, site = undefined, prefix = "", provider = undefined) {
	const where = [];
	const params = [];
	if (range.from !== undefined) {
		where.push(`${prefix}day >= ?`);
		params.push(range.from);
	}
	if (range.to !== undefined) {
		where.push(`${prefix}day <= ?`);
		params.push(range.to);
	}
	if (site !== undefined) {
		where.push(`${prefix}site = ?`);
		params.push(site);
	}
	if (provider !== undefined) {
		where.push(`${prefix}provider = ?`);
		params.push(provider);
	}
	return { sql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "", params };
}

/**
 * A session's project directory, as stored.
 *
 * Only a trailing separator is removed. Resolving symlinks would mean an
 * `fs.realpath` per session per sweep, against directories that may have been
 * deleted since — cost and a failure mode, to merge two spellings of a path
 * that in practice DSH records identically because the header is stamped once
 * at session creation and never rewritten.
 *
 * Absent becomes `''` rather than null: a session with no cwd still gets a row,
 * so it can be counted as unattributed instead of vanishing from the join.
 */
export function normalizeProject(cwd) {
	if (typeof cwd !== "string") return "";
	const trimmed = cwd.trim();
	if (trimmed === "" || trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed === "" ? "" : trimmed;
	return trimmed.replace(/[\\/]+$/, "");
}

const SUMS = COLUMNS.map((c) => `COALESCE(SUM(${c}), 0) AS ${c}`).join(", ");

function decorate(row) {
	const buckets = {};
	for (const column of COLUMNS) buckets[column] = Number(row[column] ?? 0);
	return { ...row, ...buckets, tokens: totalTokens(buckets), cacheHitRate: cacheHitRate(buckets) };
}

/**
 * The rollup index.
 */
export class LedgerStore {
	#db;
	#stmt = {};

	constructor(db) {
		this.#db = db;
		this.#migrate();
		this.#prepare();
	}

	/**
	 * Open (and migrate) a store.
	 * @param path - database file path, or `:memory:`.
	 */
	static open(path = ":memory:") {
		return new LedgerStore(new DatabaseSync(path));
	}

	#migrate() {
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec("PRAGMA foreign_keys = ON");
		const hasMeta = this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined;
		const before = hasMeta ? this.#db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() : undefined;
		// v4 -> v5 only adds the phase column, and is done IN PLACE: every row
		// keeps its numbers under phase '' (priced as before). Dropping and
		// re-folding instead would lose every session whose log has since been
		// deleted, and undo the hand-merged attributions (AGENTS.md 已知的坑).
		// Runs before SCHEMA so the v5 indexes land on the v5 table.
		if (before !== undefined && Number(before.value) === 4) this.#migrateV4();
		this.#db.exec(SCHEMA);
		const found = this.#db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
		if (found === undefined) {
			this.#db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION));
			this.#markPhaseSince();
			return;
		}
		const version = Number(found.value);
		if (version > SCHEMA_VERSION) {
			// A store written by a NEWER build is not ours to discard: dropping
			// it would destroy rows this build cannot even read, and only the
			// logs that still exist could ever rebuild them. Refuse to open —
			// the plugin's `apply` catches this, logs it and stays unloaded,
			// which costs the panel and spares the ledger.
			throw new Error(
				`tokenledger store schema ${found.value} is newer than this build's ${SCHEMA_VERSION}; refusing to drop it. Upgrade the plugin, or delete the store file yourself if the rows really are expendable.`
			);
		}
		if (version !== SCHEMA_VERSION) {
			// The index is disposable by design, so a version mismatch is discarded
			// rather than migrated. The logs it was built from are untouched.
			this.#db.exec("DROP TABLE IF EXISTS session_rollups; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS checkpoints;");
			this.#db.exec(SCHEMA);
			this.#db.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run(String(SCHEMA_VERSION));
		}
		this.#markPhaseSince();
	}

	#migrateV4() {
		const cols = ["sessionId", "day", "site", "provider", "model", ...COLUMNS].join(", ");
		this.#transaction(() => {
			this.#db.exec(`
				CREATE TABLE session_rollups_v5 (
				  sessionId        TEXT    NOT NULL,
				  day              TEXT    NOT NULL,
				  site             TEXT    NOT NULL,
				  provider         TEXT    NOT NULL,
				  model            TEXT    NOT NULL,
				  inputTokens      INTEGER NOT NULL DEFAULT 0,
				  outputTokens     INTEGER NOT NULL DEFAULT 0,
				  cacheReadTokens  INTEGER NOT NULL DEFAULT 0,
				  cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
				  reasoningTokens  INTEGER NOT NULL DEFAULT 0,
				  requests         INTEGER NOT NULL DEFAULT 0,
				  phase            TEXT    NOT NULL DEFAULT '',
				  PRIMARY KEY (sessionId, day, site, provider, model, phase)
				) WITHOUT ROWID;
				INSERT INTO session_rollups_v5 (${cols}, phase) SELECT ${cols}, '' FROM session_rollups;
				DROP TABLE session_rollups;
				ALTER TABLE session_rollups_v5 RENAME TO session_rollups;
			`);
			this.#db.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run(String(SCHEMA_VERSION));
		});
	}

	/**
	 * Record, once, the moment phases start being kept. Usage before it folds
	 * with phase '' — on every later re-fold too, so a rebuild cannot re-price
	 * history that was deliberately left alone (用户 2026-10-14：「以前的不算了，
	 * 以后的要算」). `reset()` keeps it: it clears rows, not meta.
	 */
	#markPhaseSince() {
		this.#db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('phaseSince', ?)").run(String(Date.now()));
	}

	/**
	 * Note that a rebuild started, and why. Kept in `meta`, which `reset()`
	 * leaves alone, so the record outlives the rebuild it describes.
	 *
	 * Every restart used to rebuild the ledger twice, and nobody could tell: the
	 * host keeps no plugin log, and the only trace was 454 checkpoints sharing a
	 * timestamp. A rebuild that says when and why is one that can be noticed.
	 */
	recordRebuildStart(reason, at = Date.now()) {
		const previous = this.rebuildRecord();
		this.#writeRebuild({ count: (previous?.count ?? 0) + 1, at, reason: String(reason).slice(0, 500) });
	}

	/** Close the record {@link recordRebuildStart} opened. */
	recordRebuildDone(dropped = 0, at = Date.now()) {
		const current = this.rebuildRecord();
		if (current === undefined) return;
		this.#writeRebuild({ ...current, doneAt: at, dropped });
	}

	/** `{ count, at, reason, doneAt?, dropped? }` for the last rebuild, or undefined. */
	rebuildRecord() {
		const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'rebuild'").get();
		if (row === undefined) return undefined;
		try {
			const value = JSON.parse(row.value);
			return value !== null && typeof value === "object" ? value : undefined;
		} catch {
			return undefined;
		}
	}

	#writeRebuild(value) {
		this.#db
			.prepare("INSERT INTO meta (key, value) VALUES ('rebuild', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
			.run(JSON.stringify(value));
	}

	/**
	 * Note the sessions the last pass listed but could not fold, and why.
	 *
	 * Kept beside the rebuild record for the same reason: a log that exists and
	 * cannot be read is invisible everywhere else. The sweep logs a warning the
	 * host never shows, the rows look stale to `staleAttributions`, and the only
	 * thing anyone sees is a total that will not grow. Naming them turns that
	 * into a fact with a number attached.
	 *
	 * @param entries - `[{ sessionId, reason }]`; empty clears the record.
	 */
	recordUnreadable(entries = [], at = Date.now()) {
		if (entries.length === 0) {
			this.#db.prepare("DELETE FROM meta WHERE key = 'unreadable'").run();
			return;
		}
		this.#db
			.prepare("INSERT INTO meta (key, value) VALUES ('unreadable', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
			.run(JSON.stringify({ count: entries.length, at, sample: entries.slice(0, 20).map((e) => ({ sessionId: e.sessionId, reason: String(e.reason ?? "").slice(0, 200) })) }));
	}

	/** The last {@link recordUnreadable} note, or undefined. */
	unreadableRecord() {
		const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'unreadable'").get();
		if (row === undefined) return undefined;
		try {
			const value = JSON.parse(row.value);
			return value !== null && typeof value === "object" ? value : undefined;
		} catch {
			return undefined;
		}
	}

	/** Epoch ms from which usage is split by peak/off-peak phase. */
	phaseSince() {
		const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'phaseSince'").get();
		const value = Number(row?.value);
		return Number.isFinite(value) ? value : undefined;
	}

	#prepare() {
		const cols = COLUMNS.join(", ");
		const marks = COLUMNS.map(() => "?").join(", ");
		this.#stmt.insertRollup = this.#db.prepare(
			`INSERT INTO session_rollups (sessionId, day, site, provider, model, phase, ${cols})
			 VALUES (?, ?, ?, ?, ?, ?, ${marks})`
		);
		this.#stmt.deleteRollups = this.#db.prepare("DELETE FROM session_rollups WHERE sessionId = ?");
		this.#stmt.upsertSession = this.#db.prepare(
			`INSERT INTO sessions (sessionId, project) VALUES (?, ?)
			 ON CONFLICT (sessionId) DO UPDATE SET project = excluded.project`
		);
		this.#stmt.deleteSession = this.#db.prepare("DELETE FROM sessions WHERE sessionId = ?");
		this.#stmt.upsertCheckpoint = this.#db.prepare(
			`INSERT INTO checkpoints (sessionId, consumedSeq, logRevision, cursor, dshVersion, lastUsageAt, updatedAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (sessionId) DO UPDATE SET
			   consumedSeq = excluded.consumedSeq,
			   logRevision = excluded.logRevision,
			   cursor      = excluded.cursor,
			   dshVersion  = excluded.dshVersion,
			   lastUsageAt = excluded.lastUsageAt,
			   updatedAt   = excluded.updatedAt`
		);
		this.#stmt.deleteCheckpoint = this.#db.prepare("DELETE FROM checkpoints WHERE sessionId = ?");
		this.#stmt.getCheckpoint = this.#db.prepare("SELECT * FROM checkpoints WHERE sessionId = ?");
		this.#stmt.allCheckpoints = this.#db.prepare("SELECT * FROM checkpoints ORDER BY sessionId");
		this.#stmt.sessionRollups = this.#db.prepare("SELECT * FROM session_rollups WHERE sessionId = ?");
	}

	close() {
		this.#db.close();
	}

	#transaction(fn) {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	/** The stored checkpoint for a session, or undefined if never folded. */
	checkpointFor(sessionId) {
		const row = this.#stmt.getCheckpoint.get(sessionId);
		if (row === undefined) return undefined;
		return {
			sessionId: row.sessionId,
			consumedSeq: Number(row.consumedSeq),
			logRevision: row.logRevision ?? undefined,
			dshVersion: row.dshVersion ?? undefined,
			lastUsageAt: row.lastUsageAt === null ? undefined : Number(row.lastUsageAt),
			updatedAt: Number(row.updatedAt)
		};
	}

	/** Every stored checkpoint, for discovery and diagnostics. */
	allCheckpoints() {
		return this.#stmt.allCheckpoints.all().map((row) => ({
			sessionId: row.sessionId,
			consumedSeq: Number(row.consumedSeq),
			logRevision: row.logRevision ?? undefined,
			dshVersion: row.dshVersion ?? undefined,
			lastUsageAt: row.lastUsageAt === null ? undefined : Number(row.lastUsageAt),
			updatedAt: Number(row.updatedAt)
		}));
	}

	/**
	 * Rehydrate a session's fold state so the next slice of events can be applied
	 * incrementally. Returns a fresh state when the session is unknown; the sweep
	 * then chooses seq 0 for a fresh session or the durable seed boundary for a
	 * fork whose leading events belong to its parent.
	 */
	loadState(sessionId) {
		const state = createUsageState();
		const checkpoint = this.#stmt.getCheckpoint.get(sessionId);
		if (checkpoint === undefined) return state;

		for (const row of this.#stmt.sessionRollups.all(sessionId)) {
			let entry = state.days.get(row.day);
			if (entry === undefined) {
				entry = { totals: zeroBuckets(), routes: new Map() };
				state.days.set(row.day, entry);
			}
			const buckets = zeroBuckets();
			for (const column of COLUMNS) buckets[column] = Number(row[column]);
			entry.routes.set(routeKey(row.site, row.provider, row.model, row.phase), buckets);
			for (const column of COLUMNS) entry.totals[column] += buckets[column];
		}

		let cursor;
		try {
			cursor = JSON.parse(checkpoint.cursor);
		} catch {
			// A corrupted cursor must not freeze the session forever: the rows
			// are still good, and consumedSeq alone suffices to keep reading
			// the tail. Drop the sample/route hints and carry on.
			cursor = null;
		}
		state.consumedSeq = Number(checkpoint.consumedSeq);
		state.lastSample = cursor?.lastSample ?? null;
		state.currentRoute = cursor?.currentRoute ?? null;
		state.lastUsageAt = checkpoint.lastUsageAt === null ? undefined : Number(checkpoint.lastUsageAt);
		return state;
	}

	/**
	 * Persist a session's fold state, replacing whatever was stored for it.
	 *
	 * The rollup replacement and the checkpoint advance happen in one
	 * transaction: a checkpoint that outran its rows would silently skip events
	 * forever, which is the one failure mode this index must not have.
	 */
	commitSession(sessionId, state, options = {}) {
		const cursor = JSON.stringify({ lastSample: state.lastSample, currentRoute: state.currentRoute });
		const updatedAt = options.updatedAt ?? Date.now();
		this.#transaction(() => {
			this.#stmt.deleteRollups.run(sessionId);
			// Written for every swept session, including one with no cwd, so the
			// "which project" question has an answer for all of them — even when
			// that answer is "we do not know".
			this.#stmt.upsertSession.run(sessionId, normalizeProject(options.project));
			for (const [day, entry] of state.days) {
				for (const [key, buckets] of entry.routes) {
					if (COLUMNS.every((column) => buckets[column] === 0)) continue;
					const { site, provider, model, phase = "" } = parseRouteKey(key);
					this.#stmt.insertRollup.run(
						sessionId,
						day,
						site,
						provider,
						model,
						phase,
						...COLUMNS.map((column) => buckets[column])
					);
				}
			}
			this.#stmt.upsertCheckpoint.run(
				sessionId,
				state.consumedSeq,
				options.logRevision ?? null,
				cursor,
				options.dshVersion ?? null,
				state.lastUsageAt ?? null,
				updatedAt
			);
		});
	}

	/** Forget one session entirely — its rows and its checkpoint. */
	dropSession(sessionId) {
		this.#transaction(() => {
			this.#stmt.deleteRollups.run(sessionId);
			this.#stmt.deleteSession.run(sessionId);
			this.#stmt.deleteCheckpoint.run(sessionId);
		});
	}

	/**
	 * Discard the whole index. The next collection pass rebuilds each session
	 * from its non-inherited boundary. This is the supported rebuild entry point,
	 * not a last-resort repair.
	 */
	reset() {
		this.#transaction(() => {
			this.#db.exec("DELETE FROM session_rollups");
			this.#db.exec("DELETE FROM sessions");
			this.#db.exec("DELETE FROM checkpoints");
		});
	}

	/**
	 * Start a rebuild that stays readable. Only the checkpoints go: every session
	 * is then re-read from its seed boundary, and `commitSession` swaps its rows
	 * one session at a time, so the totals a panel reads mid-rebuild stay whole
	 * instead of climbing from zero. Finish with {@link dropUnfolded}.
	 */
	forgetCheckpoints() {
		this.#db.exec("DELETE FROM checkpoints");
	}

	/**
	 * End a {@link forgetCheckpoints} rebuild: drop the sessions the full pass did
	 * not re-commit. Their rows still carry the old attribution, and left in
	 * place they would call the index stale again — the same loss `reset()`
	 * takes, only deferred to the end.
	 *
	 * ## Which sessions that means, exactly
	 *
	 * Only the ones whose log is genuinely GONE. "Not re-committed" used to be
	 * the whole test, and it conflated two different facts:
	 *
	 * - the session is no longer listed by the host at all → its log was
	 *   deleted, and the rows are unfaithful to any log. Drop them.
	 * - the session IS still listed but the sweep could not read it (a corrupt
	 *   first frame, an empty file, a transient I/O error) → the log is right
	 *   there. Dropping its rows destroys history the log still holds, and the
	 *   user sees a total quietly shrink for no stated reason.
	 *
	 * On a real install (2026-10-24) that difference cost 176M tokens of
	 * sessions that were never listed, plus two whose logs were present but
	 * unreadable. The second kind has to survive with its old rows.
	 *
	 * @param keep - session ids the pass listed but could not re-commit. Their
	 *   rows stay exactly as they were, still crediting the site that served
	 *   them; the checkpoint is what is missing, so the next pass retries.
	 * @returns how many sessions were dropped.
	 */
	dropUnfolded(keep = []) {
		return this.#transaction(() => {
			const kept = new Set(keep);
			const uncommitted = this.#db
				.prepare("SELECT sessionId, count(*) AS n FROM session_rollups GROUP BY sessionId")
				.all()
				.filter((row) => this.#stmt.getCheckpoint.get(row.sessionId) === undefined);
			const drop = uncommitted.filter((row) => !kept.has(row.sessionId)).map((row) => row.sessionId);
			const dropped = drop.length;
			for (const sessionId of drop) {
				this.#stmt.deleteRollups.run(sessionId);
				this.#stmt.deleteSession.run(sessionId);
			}
			return dropped;
		});
	}

	/** Totals over a date range, optionally restricted to one site and provider route. */
	totals(range = {}, site = undefined, provider = undefined) {
		const { sql, params } = rangeClause(range, site, "", provider);
		return decorate(this.#db.prepare(`SELECT ${SUMS} FROM session_rollups ${sql}`).get(...params));
	}

	/** Per-day totals, ascending. */
	byDay(range = {}, site = undefined, provider = undefined) {
		const { sql, params } = rangeClause(range, site, "", provider);
		return this.#db
			.prepare(`SELECT day, ${SUMS} FROM session_rollups ${sql} GROUP BY day ORDER BY day`)
			.all(...params)
			.map(decorate);
	}

	/**
	 * Per-model totals, descending by billed tokens. Site and provider are filters.
	 * `{ phase: true }` splits each row by peak/off-peak phase — for pricing
	 * only; every display reads the merged rows.
	 */
	byModel(range = {}, site = undefined, provider = undefined, options = {}) {
		const { sql, params } = rangeClause(range, site, "", provider);
		const group = options.phase === true ? "model, phase" : "model";
		return this.#db
			.prepare(`SELECT ${group}, ${SUMS} FROM session_rollups ${sql} GROUP BY ${group}`)
			.all(...params)
			.map(decorate)
			.sort((a, b) => b.tokens - a.tokens);
	}

	/**
	 * Per-route-and-model totals — `byModel`, split by the route that served it.
	 *
	 * The panel names a row `<provider>/<model>` because a model id alone does not
	 * say who served it. Several routes can report the SAME id (a relay and the
	 * vendor both serving `deepseek-v4-flash`), and one gateway namespaces ids by
	 * MODEL vendor (`deepseek/deepseek-v4.1-flash` on Command Code) — which reads
	 * like a provider prefix but is not one.
	 */
	byProviderModel(range = {}, site = undefined, provider = undefined, options = {}) {
		const { sql, params } = rangeClause(range, site, "", provider);
		const group = options.phase === true ? "provider, model, phase" : "provider, model";
		return this.#db
			.prepare(`SELECT ${group}, ${SUMS} FROM session_rollups ${sql} GROUP BY ${group}`)
			.all(...params)
			.map(decorate)
			.sort((a, b) => b.tokens - a.tokens);
	}

	/** Per-site totals — the panel's site breakdown and the report's. */
	bySite(range = {}, provider = undefined) {
		const { sql, params } = rangeClause(range, undefined, "", provider);
		return this.#db
			.prepare(`SELECT site, ${SUMS} FROM session_rollups ${sql} GROUP BY site`)
			.all(...params)
			.map(decorate)
			.sort((a, b) => b.tokens - a.tokens);
	}

	/**
	 * Per-project totals, biggest first.
	 *
	 * A LEFT JOIN, and deliberately so. A rollup row whose session predates the
	 * sessions table — or whose write failed — must still be counted, under `''`,
	 * rather than dropped by an inner join. Usage that silently leaves the totals
	 * is worse than usage nobody can name: the first is invisible, the second is
	 * a row on the panel saying so.
	 */
	byProject(range = {}, site = undefined, provider = undefined) {
		const { sql, params } = rangeClause(range, site, "r.", provider);
		return this.#db
			.prepare(
				`SELECT COALESCE(s.project, '') AS project, ${SUMS}
				 FROM session_rollups r LEFT JOIN sessions s ON s.sessionId = r.sessionId
				 ${sql}
				 GROUP BY COALESCE(s.project, '')`
			)
			.all(...params)
			.map(decorate)
			.sort((a, b) => b.tokens - a.tokens);
	}

	/**
	 * Per-provider-route totals.
	 *
	 * Always available with no configuration at all, because the route name
	 * rides every usage record. Grouping routes into relay sites is a separate,
	 * optional step, kept for cost estimation — basic attribution
	 * should not have to wait for it.
	 */
	byProvider(range = {}, site = undefined, provider = undefined) {
		const { sql, params } = rangeClause(range, site, "", provider);
		return this.#db
			.prepare(`SELECT provider, ${SUMS} FROM session_rollups ${sql} GROUP BY provider`)
			.all(...params)
			.map(decorate)
			.sort((a, b) => b.tokens - a.tokens);
	}

	/** Full route breakdown, for export and drill-down; `{ phase: true }` as in `byModel`. */
	byRoute(range = {}, site = undefined, provider = undefined, options = {}) {
		const { sql, params } = rangeClause(range, site, "", provider);
		const group = options.phase === true ? "day, site, provider, model, phase" : "day, site, provider, model";
		return this.#db
			.prepare(
				`SELECT ${group}, ${SUMS} FROM session_rollups ${sql}
				 GROUP BY ${group} ORDER BY ${group}`
			)
			.all(...params)
			.map(decorate);
	}

	/**
	 * Every `(site, provider)` pair the index holds.
	 *
	 * Small by construction — its size is the number of routes ever seen, not
	 * the amount of traffic — so it is cheap enough to check on every sweep.
	 * That matters, because it is the only way to notice that stored attribution
	 * has drifted from what the directory would say today.
	 */
	distinctRoutes() {
		return this.#db.prepare("SELECT DISTINCT site, provider FROM session_rollups").all();
	}

	/** Every distinct model id in the ledger. */
	distinctModels() {
		return this.#db.prepare("SELECT DISTINCT model FROM session_rollups").all();
	}

	/**
	 * Index health, for the diagnostics surface. Deliberately counts and
	 * identifiers only — never prompts, tool arguments, credentials, or content.
	 */
	diagnostics() {
		const counts = this.#db
			.prepare(
				`SELECT
				   (SELECT COUNT(*) FROM session_rollups)              AS rollupRows,
				   (SELECT COUNT(DISTINCT sessionId) FROM session_rollups) AS sessionsWithUsage,
				   (SELECT COUNT(*) FROM checkpoints)                  AS sessionsTracked,
				   (SELECT MIN(day) FROM session_rollups)              AS firstDay,
				   (SELECT MAX(day) FROM session_rollups)              AS lastDay,
				   (SELECT MAX(lastUsageAt) FROM checkpoints)           AS lastUsageAt,
				   (SELECT MAX(updatedAt) FROM checkpoints)             AS lastUpdatedAt`
			)
			.get();
		const unknownRoutes = this.#db
			.prepare("SELECT COUNT(*) AS n FROM session_rollups WHERE provider = 'unknown' OR model = 'unknown'")
			.get();
		const lastRebuild = this.rebuildRecord();
		const unreadable = this.unreadableRecord();
		return {
			schemaVersion: SCHEMA_VERSION,
			rollupRows: Number(counts.rollupRows),
			sessionsWithUsage: Number(counts.sessionsWithUsage),
			sessionsTracked: Number(counts.sessionsTracked),
			firstDay: counts.firstDay ?? undefined,
			lastDay: counts.lastDay ?? undefined,
			lastUsageAt: counts.lastUsageAt === null ? undefined : Number(counts.lastUsageAt),
			lastUpdatedAt: counts.lastUpdatedAt === null ? undefined : Number(counts.lastUpdatedAt),
			unattributedRows: Number(unknownRoutes.n),
			...(lastRebuild === undefined ? {} : { lastRebuild }),
			// Present only when the last pass found logs it could not fold.
			// Absence is the healthy state and says nothing worth printing.
			...(unreadable === undefined ? {} : { unreadableLogs: unreadable })
		};
	}

	/** The full route breakdown as JSON-ready rows. */
	exportJson(range = {}, site = undefined) {
		// Projects ride alongside the route rows rather than as a column on them.
		// A route row is one (day, site, provider, model) cell and a project is a
		// property of the session behind it, so folding one into the other would
		// split every row by a dimension most consumers of this export are not
		// asking about. The CSV keeps only the route table, because a second
		// table inside one CSV is worse than an absent one.
		return { generatedAt: Date.now(), range, site, rows: this.byRoute(range, site), projects: this.byProject(range, site) };
	}

	/** The full route breakdown as CSV. */
	exportCsv(range = {}, site = undefined) {
		const header = ["day", "site", "provider", "model", ...COLUMNS, "tokens", "cacheHitRate"];
		const lines = [header.join(",")];
		for (const row of this.byRoute(range, site)) {
			lines.push(header.map((column) => csvCell(row[column])).join(","));
		}
		return lines.join("\n");
	}
}

function csvCell(value) {
	if (value === null || value === undefined) return "";
	let text = String(value);
	// Formula injection: a model or project name comes from session logs, and
	// Excel executes a leading `=`/`+`/`-`/`@` as a formula (or DDE) on open —
	// quoting and comma-escaping do not touch that. A leading apostrophe is
	// spreadsheet convention for "this is text".
	if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
