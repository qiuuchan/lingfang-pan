#!/usr/bin/env node
/**
 * 统一版本同步脚本。
 *
 * 唯一版本源：根 package.json 的 "version" 字段。
 * 运行方式：
 *   node scripts/sync-version.mjs          → 同步到所有子包
 *   node scripts/sync-version.mjs 0.2.0    → 先升版本再同步
 *
 * 同步目标：
 *   - apps/desktop/package.json
 *   - apps/desktop/src-tauri/tauri.conf.json
 *   - apps/desktop/src-tauri/Cargo.toml
 *   - apps/collab-api/package.json
 *   - apps/collab-admin/package.json
 *
 * 同时生成 BUILD_INFO（版本 + 构建时间 + git hash），注入：
 *   - apps/collab-api/src/build-info.ts（运行时 /health 返回）
 *   - apps/desktop/src-tauri/tauri.conf.json 的 buildInfo 字段
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- 读取/设置版本 ---
const rootPkgPath = resolve(ROOT, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));

const argVersion = process.argv[2];
if (argVersion) {
	if (!/^\d+\.\d+\.\d+/.test(argVersion)) {
		console.error(`[sync-version] 无效版本号: ${argVersion}`);
		process.exit(1);
	}
	rootPkg.version = argVersion;
	writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
	console.log(`[sync-version] 根版本升至 ${argVersion}`);
}

const version = rootPkg.version;
if (!version) {
	console.error("[sync-version] 根 package.json 缺少 version 字段");
	process.exit(1);
}

// --- 构建元信息 ---
let gitHash = "unknown";
try {
	gitHash = execSync("git rev-parse --short HEAD", {
		cwd: ROOT,
		encoding: "utf8",
	}).trim();
} catch {
	/* non-git environment */
}

const buildTime = new Date().toISOString();
console.log(
	`[sync-version] version=${version} git=${gitHash} time=${buildTime}`,
);

// --- 同步 JSON 文件 ---
function syncJson(relPath, setter) {
	const abs = resolve(ROOT, relPath);
	try {
		const data = JSON.parse(readFileSync(abs, "utf8"));
		setter(data);
		writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
		console.log(`  ✓ ${relPath}`);
	} catch (e) {
		console.warn(`  ⚠ ${relPath}: ${e.message}`);
	}
}

syncJson("apps/desktop/package.json", (d) => {
	d.version = version;
});
syncJson("apps/collab-api/package.json", (d) => {
	d.version = version;
});
syncJson("apps/collab-admin/package.json", (d) => {
	d.version = version;
});
syncJson("apps/desktop/src-tauri/tauri.conf.json", (d) => {
	d.version = version;
	// tauri-build 严格校验 tauri.conf.json 顶层字段，注入未知字段 buildInfo 会导致 `tauri build` 失败；
	// 桌面端也未消费该字段（版本走 app.package_info().version）。此处主动删除历史残留，保证构建可用。
	delete d.buildInfo;
});

// --- 同步 Cargo.toml（只改顶层 [package] 的 version） ---
const cargoPath = resolve(ROOT, "apps/desktop/src-tauri/Cargo.toml");
try {
	let cargo = readFileSync(cargoPath, "utf8");
	cargo = cargo.replace(/^version = ".*"/m, `version = "${version}"`);
	writeFileSync(cargoPath, cargo);
	console.log("  ✓ apps/desktop/src-tauri/Cargo.toml");
} catch (e) {
	console.warn(`  ⚠ Cargo.toml: ${e.message}`);
}

// --- 生成 collab-api build-info.ts ---
const buildInfoTs = `// 自动生成，勿手动编辑。由 scripts/sync-version.mjs 写入。
export const BUILD_INFO = {
  version: '${version}',
  gitHash: '${gitHash}',
  buildTime: '${buildTime}',
} as const;
`;
const buildInfoPath = resolve(ROOT, "apps/collab-api/src/build-info.ts");
writeFileSync(buildInfoPath, buildInfoTs);
console.log("  ✓ apps/collab-api/src/build-info.ts");

console.log(`[sync-version] 完成 ✓ 全部子包已同步到 v${version}`);
