/**
 * The 阿里云 account balance, read with an AccessKey.
 *
 * 阿里云百炼's inference hosts (`dashscope.aliyuncs.com`, a workspace's own
 * `{WorkspaceId}.{region}.maas.aliyuncs.com`) answer models and nothing else:
 * the official Base URL page lists `/compatible-mode/v1`, `/apps/anthropic` and
 * `/api/v1`, and no balance route takes the API key. The money lives in the
 * 阿里云 account's billing center, whose OpenAPI `QueryAccountBalance`
 * (BssOpenApi 2017-12-14) is signed with an AccessKey instead
 * (用户 2026-10-04「尝试一下」).
 *
 * The figure is the WHOLE 阿里云 account's — every product draws on one
 * wallet — not 百炼's alone, and free per-model quotas are not in it.
 *
 * Signature: V3 (`ACS3-HMAC-SHA256`), transcribed from the official
 * "V3 版本请求体&签名机制" page (fetched 2026-10-04). The only permission the
 * key needs is `bss:DescribeAcccount` (sic — three c's, as the API page
 * spells it), so a RAM user holding just that can read the balance and do
 * nothing else.
 *
 * @module dsh-tokenledger/aliyun-bss
 */

import { createHash, createHmac, randomUUID } from "node:crypto";

import { DEFAULT_MAX_BYTES, fetchNoCrossOriginRedirect, readCapped } from "./transport.js";

/**
 * The billing center's endpoint (China site), from the official SDK's endpoint
 * map (`alibabacloud-python-sdk` `bssopenapi-20171214` client: `cn-*` →
 * `business.aliyuncs.com`). `bssopenapi.aliyuncs.com` — the product code
 * dressed as a host — does not resolve; the first build shipped it and every
 * read failed as `unreachable`.
 */
export const BSS_HOST = "business.aliyuncs.com";
export const BSS_VERSION = "2017-12-14";

const ALGORITHM = "ACS3-HMAC-SHA256";

/** Whether an origin is one of 百炼's inference hosts. */
export function isAliyunModelStudio(hostname) {
	const host = String(hostname ?? "").toLowerCase();
	return host === "dashscope.aliyuncs.com" || host.endsWith(".maas.aliyuncs.com");
}

/** An AccessKey pair as typed, trimmed, or undefined when either half is not one. */
export function normalizeAccessKey(id, secret) {
	const accessKeyId = typeof id === "string" ? id.trim() : "";
	const accessKeySecret = typeof secret === "string" ? secret.trim() : "";
	if (!/^[A-Za-z0-9]{12,64}$/.test(accessKeyId)) return undefined;
	if (!/^[A-Za-z0-9]{20,64}$/.test(accessKeySecret)) return undefined;
	return { accessKeyId, accessKeySecret };
}

/** An AccessKey ID as the renderer may see it: enough to recognise, not to use. */
export function maskAccessKeyId(id) {
	return typeof id === "string" && id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : "…";
}

/** RFC 3986 percent-encoding, which `encodeURIComponent` falls short of by five characters. */
function rfc3986(value) {
	return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The headers of one V3-signed request.
 *
 * @param input - `{ method, host, action, version, query?, body?, accessKeyId,
 *   accessKeySecret, date?, nonce? }`. `date` (a `Date`) and `nonce` exist so
 *   a test can pin the signature.
 */
export function signAliyunRequest(input) {
	const { method, host, action, version, query = {}, body = "", accessKeyId, accessKeySecret } = input;
	const date = (input.date ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
	const headers = {
		host,
		"x-acs-action": action,
		"x-acs-content-sha256": sha256Hex(body),
		"x-acs-date": date,
		"x-acs-signature-nonce": input.nonce ?? randomUUID(),
		"x-acs-version": version
	};
	const names = Object.keys(headers).sort();
	const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim()}\n`).join("");
	const signedHeaders = names.join(";");
	const canonicalQuery = Object.keys(query)
		.sort()
		.map((key) => `${rfc3986(key)}=${rfc3986(String(query[key]))}`)
		.join("&");
	// RPC-style APIs sign the path "/".
	const canonicalRequest = [method, "/", canonicalQuery, canonicalHeaders, signedHeaders, headers["x-acs-content-sha256"]].join("\n");
	const stringToSign = `${ALGORITHM}\n${sha256Hex(canonicalRequest)}`;
	const signature = createHmac("sha256", accessKeySecret).update(stringToSign, "utf8").digest("hex");
	return {
		...headers,
		authorization: `${ALGORITHM} Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`
	};
}

/** Error codes that mean the key is wrong, and those that mean it lacks the permission. */
const INVALID_KEY = /^(?:InvalidAccessKeyId|SignatureDoesNotMatch|InvalidAccessKeySecret|IncompleteSignature)/;
const NO_PERMISSION = /^(?:NoPermission|NotAuthorized|Forbidden)/;

/** A decimal string as money, or undefined. */
function amount(value) {
	const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
	if (!/^-?\d+(?:\.\d+)?$/.test(text)) return undefined;
	return Number(text);
}

/**
 * Read `QueryAccountBalance`.
 *
 * @param options - `{ accessKeyId, accessKeySecret, fetch?, signal?, timeoutMs?, date?, nonce? }`.
 * @returns the card's fields: `{ supported, fetched, currency, total, toppedUp?, isAvailable }`
 *   on success; `{ supported, fetched: false, reason, hint? }` otherwise. Never throws.
 */
export async function readAliyunBalance(options) {
	const { accessKeyId, accessKeySecret, timeoutMs = 15_000, signal: external } = options;
	const doFetch = options.fetch ?? globalThis.fetch;
	const controller = new AbortController();
	const onAbort = () => controller.abort(external?.reason);
	if (external?.aborted === true) controller.abort(external.reason);
	else external?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers = signAliyunRequest({
			method: "POST",
			host: BSS_HOST,
			action: "QueryAccountBalance",
			version: BSS_VERSION,
			accessKeyId,
			accessKeySecret,
			date: options.date,
			nonce: options.nonce
		});
		const response = await fetchNoCrossOriginRedirect(doFetch, `https://${BSS_HOST}/`, {
			method: "POST",
			headers: { ...headers, accept: "application/json" },
			signal: controller.signal
		});
		let body;
		try {
			body = JSON.parse(await readCapped(response, DEFAULT_MAX_BYTES));
		} catch {
			body = undefined;
		}
		const code = typeof body?.Code === "string" ? body.Code : undefined;
		if (!response.ok || body?.Success === false || (code !== undefined && code !== "200")) {
			const hint = code === undefined ? undefined : INVALID_KEY.test(code) ? "aliyun-ak-invalid" : NO_PERMISSION.test(code) ? "aliyun-ak-permission" : undefined;
			return {
				supported: true,
				fetched: false,
				reason: code ?? `http-${response.status}`,
				...(hint === undefined ? {} : { hint })
			};
		}
		const data = body?.Data ?? {};
		const total = amount(data.AvailableAmount);
		if (total === undefined) return { supported: true, fetched: false, reason: "invalid-response" };
		const cash = amount(data.AvailableCashAmount);
		return {
			supported: true,
			fetched: true,
			currency: typeof data.Currency === "string" && data.Currency !== "" ? data.Currency.toUpperCase() : "CNY",
			total,
			...(cash === undefined || cash === total ? {} : { toppedUp: cash }),
			isAvailable: total > 0
		};
	} catch (error) {
		const reason = external?.aborted === true ? "aborted" : controller.signal.aborted ? "timeout" : error?.kind === "too-large" ? "too-large" : "unreachable";
		return { supported: true, fetched: false, reason };
	} finally {
		clearTimeout(timer);
		external?.removeEventListener("abort", onAbort);
	}
}
