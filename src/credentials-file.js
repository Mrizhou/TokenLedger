/**
 * Console credentials kept beside the ledger, for hosts that give this plugin
 * nowhere else to keep them.
 *
 * Up to 0.1.6 the settings service registered a `tokenledger` namespace and the
 * panel's credentials were written into the user's settings document. 0.1.7
 * dropped `settings.register` — a plugin's editable config is now its profile
 * entry's `.volatile()` schema — so the registration fails, the write path is
 * `undefined`, and every save from the panel answered "internal". The New API
 * wallet dialog had been silently unable to store anything since the upgrade.
 *
 * This file is the fallback: a small JSON document next to the ledger, written
 * whole and renamed into place, read back once at start. It holds these and
 * nothing else:
 *
 * - `userAuth` — New API console credentials by site origin (`{ userId, token }`).
 *   Secrets: never logged, never sent to the renderer; the route that reads
 *   them answers only whether one exists.
 * - `manualBalances` — balances the user typed in, by account id
 *   (`{ amount, currency, at, baseline }`, see `manual-balance.js`). Not secret.
 * - `aliyunAccessKey` — the 阿里云 AccessKey the billing center is read with
 *   (`{ accessKeyId, accessKeySecret }`, see `aliyun-bss.js`). Secret: the
 *   renderer only ever sees a masked ID.
 *
 * A file written before 2026-10-04 may still carry `consoleCookies` (小米 MiMo's
 * console session, which the typed balance replaced). `load` reports it so the
 * plugin can rewrite the file without it; `save` never writes it.
 *
 * @module dsh-tokenledger/credentials-file
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The file name, beside the ledger database. */
export const CREDENTIALS_FILE = "tokenledger-credentials.json";

/** Where the credentials live for a given ledger path, or undefined for an in-memory ledger. */
export function credentialsPathFor(database) {
	if (typeof database !== "string" || database === "" || database === ":memory:") return undefined;
	return join(dirname(resolve(database)), CREDENTIALS_FILE);
}

/** A plain `{ key: value }` map, or an empty one. */
function plainMap(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

/** A stored AccessKey pair, or undefined when either half is missing. */
function accessKey(value) {
	return typeof value?.accessKeyId === "string" && typeof value?.accessKeySecret === "string"
		? { accessKeyId: value.accessKeyId, accessKeySecret: value.accessKeySecret }
		: undefined;
}

/**
 * @param path - the JSON file; undefined gives a store that holds nothing.
 * @returns `{ path, load, save }`. `load` never throws — a missing or unreadable
 *   file is an empty one — and `save` throws, because a credential the user
 *   was told is stored must actually be stored.
 */
export function createCredentialsFile(path) {
	return {
		path,
		load() {
			if (path === undefined) return { userAuth: {}, manualBalances: {}, aliyunAccessKey: undefined, hadConsoleCookies: false };
			let parsed;
			try {
				parsed = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				parsed = undefined;
			}
			return {
				userAuth: plainMap(parsed?.userAuth),
				manualBalances: plainMap(parsed?.manualBalances),
				aliyunAccessKey: accessKey(parsed?.aliyunAccessKey),
				hadConsoleCookies: parsed?.consoleCookies !== undefined
			};
		},
		save({ userAuth, manualBalances, aliyunAccessKey }) {
			if (path === undefined) throw Object.assign(new Error("settings-not-ready"), { kind: "settings-not-ready" });
			mkdirSync(dirname(path), { recursive: true });
			const staging = `${path}.tmp`;
			writeFileSync(staging, `${JSON.stringify({ userAuth: plainMap(userAuth), manualBalances: plainMap(manualBalances), ...(accessKey(aliyunAccessKey) === undefined ? {} : { aliyunAccessKey: accessKey(aliyunAccessKey) }) }, null, 2)}\n`, {
				mode: 0o600
			});
			renameSync(staging, path);
		}
	};
}
