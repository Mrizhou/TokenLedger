/**
 * DeepSeek peak / off-peak schedule.
 *
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ (fetched
 * 2026-10-14): 「北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 -
 * 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。空闲时段
 * 价格为高峰时段价格的一半。」
 *
 * The same hours are resold by two gateways, each stating the rule WITHOUT the
 * holiday clause (fetched the same day):
 * - Command Code, https://commandcode.ai/docs/resources/pricing-limits —
 *   "01–04 & 06–10 UTC, Mon–Fri" on its DeepSeek models;
 * - OpenCode Go, https://opencode.ai/docs/go — "Peak hours are 01:00-04:00 and
 *   06:00-10:00 UTC, Monday through Friday; all other hours, including
 *   weekends, are Off-Peak".
 * Read literally, a weekday holiday is off-peak at DeepSeek and peak at those
 * two. So a moment is classified into one of three phases, not two:
 * `peak`, `off`, and `holiday` (a weekday peak hour that falls on a holiday),
 * and each rate decides what `holiday` means for it (`offPeak.holidays`).
 *
 * A working weekend (调休补班) is still a weekend: DeepSeek's text puts
 * 「周末」 in the off-peak list with no exception, and so do both gateways.
 *
 * Everything here is anchored to UTC+8, never the host's zone — a laptop in
 * another zone must not move China's peak hours.
 *
 * @module dsh-tokenledger/peak
 */

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Peak windows in Beijing hours, `[from, to)`, Monday to Friday. */
export const PEAK_HOURS = Object.freeze([
	Object.freeze([9, 12]),
	Object.freeze([14, 18])
]);

/**
 * China's 2026 public-holiday days off, Beijing dates — every 放假 day, the
 * substituted weekdays included (2026-02-23, 2026-10-07 …), which is what
 * 「法定节假日全天」 means to anyone reading it.
 *
 * Source: 国务院办公厅关于2026年部分节假日安排的通知, Xinhua full text
 * https://www.news.cn/politics/20251104/88bcffd88ae249e58c699b8772548e3d/c.html
 * (published 2025-11-04, fetched 2026-10-14). The 调休 working weekends
 * (01-04, 02-14, 02-28, 05-09, 09-20, 10-10) are NOT listed: they are weekends.
 *
 * Next year's list is published by the State Council around November; until
 * it is added (config `peak.holidays`), the panel nags from ten days before
 * the end of the last covered year.
 */
export const CN_HOLIDAYS = Object.freeze([
	// 元旦
	"2026-01-01", "2026-01-02", "2026-01-03",
	// 春节
	"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
	"2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
	// 清明节
	"2026-04-04", "2026-04-05", "2026-04-06",
	// 劳动节
	"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
	// 端午节
	"2026-06-19", "2026-06-20", "2026-06-21",
	// 中秋节
	"2026-09-25", "2026-09-26", "2026-09-27",
	// 国庆节
	"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
	return typeof value === "string" && DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** The Beijing calendar date of an instant. */
export function beijingDate(timeMs) {
	return new Date(timeMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** Shipped holidays plus the configured ones, as a set of Beijing dates. */
export function holidaySet(extra = undefined) {
	const set = new Set(CN_HOLIDAYS);
	if (Array.isArray(extra)) for (const date of extra) if (validDate(date)) set.add(date);
	return set;
}

/**
 * The phase of one instant.
 * @param timeMs - epoch milliseconds.
 * @param holidays - a set of Beijing dates, from {@link holidaySet}.
 * @returns `"peak"`, `"off"`, or `"holiday"` (a weekday peak hour on a holiday).
 */
export function phaseAt(timeMs, holidays = holidaySet()) {
	const shifted = new Date(timeMs + BEIJING_OFFSET_MS);
	const weekday = shifted.getUTCDay();
	if (weekday === 0 || weekday === 6) return "off";
	const hour = shifted.getUTCHours() + shifted.getUTCMinutes() / 60 + shifted.getUTCSeconds() / 3600;
	const inWindow = PEAK_HOURS.some(([from, to]) => hour >= from && hour < to);
	if (!inWindow) return "off";
	return holidays.has(shifted.toISOString().slice(0, 10)) ? "holiday" : "peak";
}

/**
 * Whether a phase is billed at the off-peak price.
 * @param phase - a stored phase; `""` (recorded before phases existed) is not.
 * @param holidaysOffPeak - whether a holiday counts as off-peak for this rate.
 */
export function isOffPeak(phase, holidaysOffPeak = true) {
	return phase === "off" || (phase === "holiday" && holidaysOffPeak);
}

/**
 * A classifier for the usage fold: the phase of an event's moment, or `""` for
 * an event before `since` — usage recorded before phases existed keeps the
 * single price it was always given (用户 2026-10-14：「以前的不算了，以后的要算」).
 */
export function phaseClassifier({ since, holidays } = {}) {
	if (!Number.isFinite(since)) return () => "";
	return (timeMs) => (Number.isFinite(timeMs) && timeMs >= since ? phaseAt(timeMs, holidays) : "");
}

/**
 * Upcoming phase changes in DeepSeek's own terms (a holiday is off-peak).
 *
 * Candidate boundaries are every Beijing midnight and every window edge; a
 * change is emitted only where the phase actually differs, so a weekend or a
 * holiday reads as one long off-peak stretch.
 *
 * @returns `[{ at, phase }]`, ascending, `phase` is `"peak"` or `"off"`.
 */
export function upcomingChanges(nowMs, holidays = holidaySet(), days = 8) {
	const official = (t) => (phaseAt(t, holidays) === "peak" ? "peak" : "off");
	const edges = [0, ...PEAK_HOURS.flat()];
	const dayStart = Date.parse(`${beijingDate(nowMs)}T00:00:00Z`) - BEIJING_OFFSET_MS;
	const out = [];
	let current = official(nowMs);
	for (let d = 0; d <= days; d++) {
		for (const hour of edges) {
			const at = dayStart + d * DAY_MS + hour * HOUR_MS;
			if (at <= nowMs) continue;
			const phase = official(at);
			if (phase !== current) {
				out.push({ at, phase });
				current = phase;
			}
		}
	}
	return out;
}

/**
 * The last date the holiday list is trusted for: the configured one, else
 * December 31 of the latest year the list covers.
 */
export function holidaysUntil(config = {}, holidays = holidaySet(config.holidays)) {
	if (validDate(config.holidaysUntil)) return config.holidaysUntil;
	let year = 0;
	for (const date of holidays) year = Math.max(year, Number(date.slice(0, 4)));
	return `${year}-12-31`;
}

/** Shape the `peak` config, filling defaults and dropping what is malformed. */
export function normalizePeakConfig(raw = {}) {
	const input = raw !== null && typeof raw === "object" ? raw : {};
	const ahead = Number(input.aheadMinutes);
	const remind = Number(input.remindDays);
	return {
		alert: input.alert !== false,
		aheadMinutes: Number.isInteger(ahead) && ahead >= 1 && ahead <= 60 ? ahead : 5,
		target: ["peak", "offpeak", "both"].includes(input.target) ? input.target : "both",
		holidays: Array.isArray(input.holidays) ? input.holidays.filter(validDate) : [],
		...(validDate(input.holidaysUntil) ? { holidaysUntil: input.holidaysUntil } : {}),
		remindDays: Number.isInteger(remind) && remind >= 1 && remind <= 60 ? remind : 10
	};
}

/**
 * What the sidebar needs: the phase now, the next changes, the alert settings,
 * and — inside the reminder window — that the holiday list is running out.
 */
export function peakView(rawConfig, nowMs = Date.now()) {
	const config = normalizePeakConfig(rawConfig);
	const holidays = holidaySet(config.holidays);
	const phase = phaseAt(nowMs, holidays);
	const until = holidaysUntil(config, holidays);
	const today = beijingDate(nowMs);
	const daysLeft = Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
	return {
		phase: phase === "peak" ? "peak" : "off",
		holiday: holidays.has(today),
		changes: upcomingChanges(nowMs, holidays),
		alert: { enabled: config.alert, aheadMinutes: config.aheadMinutes, target: config.target },
		holidaysUntil: until,
		...(daysLeft < config.remindDays ? { holidayNotice: { until, daysLeft } } : {})
	};
}
