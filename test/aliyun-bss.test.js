/**
 * 阿里云 account balance through the billing center's OpenAPI, signed V3.
 *
 * 用户 2026-10-04「llm-7ub39ukw6sjudiit.cn-beijing.maas.aliyuncs.com 这个是阿里云百炼的，真的抓不到吗」→「尝试一下」.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	BSS_HOST,
	isAliyunModelStudio,
	maskAccessKeyId,
	normalizeAccessKey,
	readAliyunBalance,
	signAliyunRequest
} from "../src/aliyun-bss.js";

test("the signature matches Alibaba Cloud's own worked V3 example", () => {
	// https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
	// (fetched 2026-10-04): the RunInstances example, every input fixed.
	const headers = signAliyunRequest({
		method: "POST",
		host: "ecs.cn-shanghai.aliyuncs.com",
		action: "RunInstances",
		version: "2014-05-26",
		query: { RegionId: "cn-shanghai", ImageId: "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd" },
		accessKeyId: "YourAccessKeyId",
		accessKeySecret: "YourAccessKeySecret",
		date: new Date("2023-10-26T10:22:32Z"),
		nonce: "3156853299f313e23d1673dc12e1703d"
	});
	assert.equal(
		headers.authorization,
		"ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0"
	);
	assert.equal(headers["x-acs-date"], "2023-10-26T10:22:32Z", "no milliseconds in the date");
	assert.equal(headers["x-acs-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

/** A billing-center stub answering one status and body, recording the request. */
function bss(status, body) {
	const seen = [];
	return {
		seen,
		fetch: async (url, init) => {
			seen.push({ url, init });
			return { ok: status >= 200 && status < 300, status, json: async () => body };
		}
	};
}

const KEY = { accessKeyId: "LTAI5tExampleKeyId01", accessKeySecret: "ExampleSecretValue0123456789ab" };

test("the balance is the billing center's available amount, read with a signed POST", async () => {
	// The response example from the QueryAccountBalance page.
	const stub = bss(200, {
		Code: "200",
		Message: "success",
		RequestId: "16176743-6DC7-4CB3-BB25-A13982D8DFAD",
		Success: true,
		Data: { AvailableAmount: "10000.00", CreditAmount: "0.00", MybankCreditAmount: "0.00", Currency: "CNY", AvailableCashAmount: "10000.00", QuotaLimit: "10000.00" }
	});
	const card = await readAliyunBalance({ ...KEY, fetch: stub.fetch });
	assert.deepEqual(card, { supported: true, fetched: true, currency: "CNY", total: 10000, isAvailable: true });

	const [{ url, init }] = stub.seen;
	assert.equal(url, `https://${BSS_HOST}/`);
	assert.equal(init.method, "POST");
	assert.equal(init.headers["x-acs-action"], "QueryAccountBalance");
	assert.equal(init.headers["x-acs-version"], "2017-12-14");
	assert.match(init.headers.authorization, /^ACS3-HMAC-SHA256 Credential=LTAI5tExampleKeyId01,SignedHeaders=host;x-acs-action;/);
	assert.equal(JSON.stringify(init).includes(KEY.accessKeySecret), false, "the secret signs; it is never sent");
	assert.equal(init.redirect, "manual", "a redirect cannot carry the signature elsewhere");

	// Credit on top of cash: the cash part is shown beside the total.
	const credit = await readAliyunBalance({
		...KEY,
		fetch: bss(200, { Code: "200", Success: true, Data: { AvailableAmount: "150.50", AvailableCashAmount: "50.50", Currency: "CNY" } }).fetch
	});
	assert.equal(credit.total, 150.5);
	assert.equal(credit.toppedUp, 50.5);
});

test("a refused key says whether it is wrong or merely unauthorized", async () => {
	for (const [status, code, hint] of [
		[404, "InvalidAccessKeyId.NotFound", "aliyun-ak-invalid"],
		[400, "SignatureDoesNotMatch", "aliyun-ak-invalid"],
		[400, "NoPermission", "aliyun-ak-permission"],
		[400, "NotAuthorized", "aliyun-ak-permission"]
	]) {
		const card = await readAliyunBalance({ ...KEY, fetch: bss(status, { Code: code, Message: "x", RequestId: "r" }).fetch });
		assert.equal(card.fetched, false, code);
		assert.equal(card.reason, code);
		assert.equal(card.hint, hint, code);
	}
	// A refusal in the body of a 200 is still a refusal.
	const body = await readAliyunBalance({ ...KEY, fetch: bss(200, { Code: "InternalError", Success: false }).fetch });
	assert.equal(body.fetched, false);
	// No balance field is no balance, not a zero.
	assert.deepEqual(await readAliyunBalance({ ...KEY, fetch: bss(200, { Code: "200", Success: true, Data: {} }).fetch }), {
		supported: true,
		fetched: false,
		reason: "invalid-response"
	});
	const down = await readAliyunBalance({ ...KEY, fetch: async () => { throw new Error("ECONNRESET"); } });
	assert.deepEqual(down, { supported: true, fetched: false, reason: "unreachable" });
});

test("百炼's hosts are recognised by pattern, and only those", () => {
	assert.equal(isAliyunModelStudio("llm-7ub39ukw6sjudiit.cn-beijing.maas.aliyuncs.com"), true);
	assert.equal(isAliyunModelStudio("dashscope.aliyuncs.com"), true);
	assert.equal(isAliyunModelStudio("maas.aliyuncs.com.evil.example"), false);
	assert.equal(isAliyunModelStudio("evilmaas.aliyuncs.com"), false);
	assert.equal(isAliyunModelStudio(undefined), false);
});

test("an AccessKey is two runs of letters and digits, and its ID is shown masked", () => {
	assert.deepEqual(normalizeAccessKey(" LTAI5tExampleKeyId01 ", " ExampleSecretValue0123456789ab\n"), KEY);
	assert.equal(normalizeAccessKey("LTAI5tExampleKeyId01", ""), undefined);
	assert.equal(normalizeAccessKey("sk-0123456789abcdef", KEY.accessKeySecret), undefined, "a 百炼 API key is not an AccessKey");
	assert.equal(maskAccessKeyId("LTAI5tExampleKeyId01"), "LTAI…Id01");
});
