/**
 * Renderer-facing metadata on the TokenLedger settings namespace.
 *
 * @module dsh-tokenledger/test/settings-schema
 */

import test from "node:test";
import assert from "node:assert/strict";
import z from "@deepseek-ai/schemastery";
import { buildSchema } from "../src/settings-schema.js";

test("the settings schema exposes Chinese labels without changing resolved defaults", () => {
	const schema = buildSchema(z);
	assert.equal(schema.dict.relays.meta.description, "中转路由");
	assert.equal(schema.dict.relays.meta.comment, "按 DSH provider route 覆盖中转站地址与类型");
	assert.equal(schema.dict.userAuth.meta.description, "站点钱包凭据");
	assert.equal(schema.dict.database.meta.description, "数据库路径");
	assert.equal(schema.dict.sweepIntervalMs.meta.description, "后台汇总间隔（毫秒）");
	assert.deepEqual(schema({}), {
		endpoints: [],
		userAuth: {},
		relays: {},
		officialOrigins: [],
		fingerprint: false,
		database: "tokenledger.sqlite",
		sweepIntervalMs: 60_000,
		sweepOnStart: true
	});
});

test("wallet tokens are schema-declared write-only secrets", () => {
	const schema = buildSchema(z);
	const token = schema.dict.userAuth.inner.dict.token;
	assert.equal(token.meta.description, "访问令牌");
	assert.equal(token.meta.role, "secret");

	const serialized = schema.toJSON();
	const root = serialized.refs[serialized.uid];
	const userAuth = serialized.refs[root.dict.userAuth];
	const wallet = serialized.refs[userAuth.inner];
	const serializedToken = serialized.refs[wallet.dict.token];
	assert.equal(serializedToken.meta.role, "secret");
});
