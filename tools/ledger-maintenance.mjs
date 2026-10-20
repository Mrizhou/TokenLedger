#!/usr/bin/env node
/**
 * @file tools/ledger-maintenance.mjs
 * Ledger maintenance tool for tokenledger.sqlite.
 *
 * Supported commands:
 *   - status: Report current site distribution, unrouted routes, and model breakdown.
 *   - rename-model --from <oldModel> --to <newModel> [--apply] [--db <path>]
 *
 * Safe by default: runs in dry-run mode unless --apply is explicitly specified.
 * When --apply is given, an automatic timestamped backup is saved to ~/.dsh/backups/
 * before any database modification.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

function defaultDbPath() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || "";
	return path.join(userProfile, ".dsh", "tokenledger.sqlite");
}

function parseArgs(args) {
	const parsed = {
		command: "status",
		apply: false,
		from: undefined,
		to: undefined,
		db: defaultDbPath()
	};

	let i = 0;
	if (args.length > 0 && !args[0].startsWith("-")) {
		parsed.command = args[0];
		i = 1;
	}

	for (; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--apply") {
			parsed.apply = true;
		} else if (arg === "--dry-run") {
			parsed.apply = false;
		} else if (arg === "--from" && i + 1 < args.length) {
			parsed.from = args[++i];
		} else if (arg === "--to" && i + 1 < args.length) {
			parsed.to = args[++i];
		} else if (arg === "--db" && i + 1 < args.length) {
			parsed.db = path.resolve(args[++i]);
		}
	}

	return parsed;
}

function formatTokens(num) {
	if (typeof num !== "number") return "0";
	if (num >= 1e8) return `${(num / 1e8).toFixed(2)} 亿`;
	if (num >= 1e4) return `${(num / 1e4).toFixed(2)} 万`;
	return String(num);
}

function handleStatus(db) {
	console.log("=== 站点分布 ===");
	const sites = db.prepare(`
		SELECT site, count(*) as rows,
		       sum(inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens) as totalTokens,
		       sum(requests) as totalRequests
		FROM session_rollups
		GROUP BY site
		ORDER BY totalTokens DESC
	`).all();
	for (const s of sites) {
		console.log(`  ${s.site.padEnd(50)}: ${String(s.rows).padStart(4)} 行, ${formatTokens(s.totalTokens).padStart(10)} tokens, ${s.totalRequests} 请求`);
	}

	console.log("\n=== 未归属路由 (unrouted) ===");
	const unrouted = db.prepare(`
		SELECT provider, model, count(*) as rows,
		       sum(inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens) as totalTokens,
		       min(day) as firstDay, max(day) as lastDay
		FROM session_rollups
		WHERE site = 'unrouted'
		GROUP BY provider, model
		ORDER BY totalTokens DESC
	`).all();

	if (unrouted.length === 0) {
		console.log("  无未归属路由 (所有路由均已归位)");
	} else {
		for (const u of unrouted) {
			console.log(`  provider: ${u.provider.padEnd(16)} model: ${u.model.padEnd(35)} ${String(u.rows).padStart(3)} 行, ${formatTokens(u.totalTokens).padStart(10)} tokens (${u.firstDay} ~ ${u.lastDay})`);
		}
	}

	console.log("\n=== 模型汇总 (前 15) ===");
	const models = db.prepare(`
		SELECT model, count(distinct site) as siteCount, count(*) as rows,
		       sum(inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens) as totalTokens
		FROM session_rollups
		GROUP BY model
		ORDER BY totalTokens DESC
		LIMIT 15
	`).all();
	for (const m of models) {
		console.log(`  ${m.model.padEnd(45)}: ${String(m.rows).padStart(4)} 行 (跨 ${m.siteCount} 站), ${formatTokens(m.totalTokens).padStart(10)} tokens`);
	}
}

function backupDatabase(db) {
	const userProfile = process.env.USERPROFILE || process.env.HOME || "";
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const backupDir = path.join(userProfile, ".dsh", "backups", `ledger-maintenance-${ts}`);

	fs.mkdirSync(backupDir, { recursive: true });
	const target = path.join(backupDir, "tokenledger.sqlite");
	// 不能 copyFileSync 主文件：插件开着时最近的提交还在 -wal 里，单拷主文件是半截快照
	// （2026-10-20 实测那份备份的总量比前一天还少）。VACUUM INTO 走 SQLite 自己的读事务，含 WAL。
	db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
	console.log(`[Backup] 数据库已备份至: ${target}`);
	return target;
}

function handleRenameModel(db, dbPath, fromModel, toModel, apply) {
	if (!fromModel || !toModel) {
		console.error("错误: rename-model 需要提供 --from <oldModel> 和 --to <newModel>");
		process.exit(1);
	}
	if (fromModel === toModel) {
		console.error("错误: --from 与 --to 不能相同");
		process.exit(1);
	}

	const sourceRows = db.prepare("SELECT * FROM session_rollups WHERE model = ?").all(fromModel);
	if (sourceRows.length === 0) {
		console.log(`未找到 model = '${fromModel}' 的任何记录，无需修改。`);
		return;
	}

	console.log(`找到 ${sourceRows.length} 条 model = '${fromModel}' 的记录。`);

	let willUpdate = 0;
	let willMerge = 0;
	const collisionList = [];

	for (const row of sourceRows) {
		const targetExisting = db.prepare(`
			SELECT * FROM session_rollups
			WHERE sessionId = ? AND day = ? AND site = ? AND provider = ? AND phase = ? AND model = ?
		`).get(row.sessionId, row.day, row.site, row.provider, row.phase, toModel);

		if (targetExisting) {
			willMerge++;
			collisionList.push({ source: row, target: targetExisting });
		} else {
			willUpdate++;
		}
	}

	console.log(`计划: 直接重命名 ${willUpdate} 行, 主键合并 ${willMerge} 行。`);

	if (!apply) {
		console.log("\n[DRY RUN] 未加 --apply，未作任何写入。加上 --apply 确认执行。");
		return;
	}

	// 执行前备份
	backupDatabase(db);

	const initialSums = db.prepare(`
		SELECT sum(inputTokens) as i, sum(outputTokens) as o,
		       sum(cacheReadTokens) as cr, sum(cacheWriteTokens) as cw,
		       sum(reasoningTokens) as re, sum(requests) as req
		FROM session_rollups
	`).get();

	// IMMEDIATE：一开头就拿写锁，和插件的 commitSession（同样 BEGIN IMMEDIATE）排队，
	// 而不是读到一半升级写锁时撞 SQLITE_BUSY。
	db.exec("BEGIN IMMEDIATE");
	try {
		// 1. 处理需要累加合并的行
		for (const item of collisionList) {
			const s = item.source;
			const t = item.target;
			db.prepare(`
				UPDATE session_rollups
				SET inputTokens = inputTokens + ?,
				    outputTokens = outputTokens + ?,
				    cacheReadTokens = cacheReadTokens + ?,
				    cacheWriteTokens = cacheWriteTokens + ?,
				    reasoningTokens = reasoningTokens + ?,
				    requests = requests + ?
				WHERE sessionId = ? AND day = ? AND site = ? AND provider = ? AND phase = ? AND model = ?
			`).run(
				s.inputTokens, s.outputTokens, s.cacheReadTokens, s.cacheWriteTokens, s.reasoningTokens, s.requests,
				t.sessionId, t.day, t.site, t.provider, t.phase, toModel
			);

			// 删除源行
			db.prepare(`
				DELETE FROM session_rollups
				WHERE sessionId = ? AND day = ? AND site = ? AND provider = ? AND phase = ? AND model = ?
			`).run(s.sessionId, s.day, s.site, s.provider, s.phase, fromModel);
		}

		// 2. 处理直接 UPDATE 的行
		const updateResult = db.prepare(`
			UPDATE session_rollups
			SET model = ?
			WHERE model = ?
		`).run(toModel, fromModel);

		// 3. 校验总量守恒
		const finalSums = db.prepare(`
			SELECT sum(inputTokens) as i, sum(outputTokens) as o,
			       sum(cacheReadTokens) as cr, sum(cacheWriteTokens) as cw,
			       sum(reasoningTokens) as re, sum(requests) as req
			FROM session_rollups
		`).get();

		if (
			initialSums.i !== finalSums.i ||
			initialSums.o !== finalSums.o ||
			initialSums.cr !== finalSums.cr ||
			initialSums.cw !== finalSums.cw ||
			initialSums.re !== finalSums.re ||
			initialSums.req !== finalSums.req
		) {
			throw new Error("守恒校验失败: 执行前后 tokens/requests 总和不一致！自动回滚事务。");
		}

		db.exec("COMMIT");
		console.log(`[Success] 完成！重命名 ${updateResult.changes} 行，合并 ${willMerge} 行。`);
		console.log(`[Check] 总量守恒验证完全通过 (requests: ${finalSums.req}, tokens: ${finalSums.i + finalSums.o + finalSums.cr + finalSums.cw})。`);
	} catch (err) {
		db.exec("ROLLBACK");
		console.error(`[Error] 操作失败，已回滚事务: ${err.message}`);
		process.exit(1);
	}
}

function main() {
	const args = process.argv.slice(2);
	const opts = parseArgs(args);

	if (!fs.existsSync(opts.db)) {
		console.error(`错误: 数据库文件不存在: ${opts.db}`);
		process.exit(1);
	}

	// 插件运行时也在写这个库；等它的事务结束，最多 10 秒。
	const db = new DatabaseSync(opts.db, { timeout: 10_000 });

	switch (opts.command) {
		case "status":
			handleStatus(db);
			break;
		case "rename-model":
			handleRenameModel(db, opts.db, opts.from, opts.to, opts.apply);
			break;
		default:
			console.error(`未知命令: ${opts.command}。可用命令: status, rename-model`);
			process.exit(1);
	}
}

main();
