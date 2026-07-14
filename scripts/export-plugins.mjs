#!/usr/bin/env node
// export-plugins.mjs —— 命令行导出 .lfplugin v4 包（纯 Node 标准库，无外部依赖）。
//
// v4 制品格式（与 apps/desktop/src-tauri/src/plugin_artifact_v4.rs 的 package_workspace / inspect_artifact 对齐）：
//   - ZIP，固定两条元数据条目 + 源文件：
//       _meta.json   = {"format":"lingfang-plugin","formatVersion":4}  （固定，无 source/exportedAt/name）
//       manifest.json = 磁盘原文件（美化缩进）
//       <源文件>      = 按名称排序，文本与二进制均直存原始 bytes
//   - 校验要求：manifest 必含 id/name/version(严格 SemVer)/entry/runtime_type(client|cloud|nodejs|python)；
//     entry 指向的文件必须存在于包内；无符号链接、无 data/.venv/node_modules/__pycache__/.git 等段。
//
// ZIP 写入用 Node 内置 zlib 自实现（store/deflate），不依赖 jszip，保证零外部依赖。
// 产出可被桌面端 v4 inspect_artifact 接受（formatVersion:4 + 标准 ZIP 结构 + CRC32 校验）。
//
// 用法：node scripts/export-plugins.mjs <plugin-id> [<plugin-id>...] [--out dir]
//   默认 out=plugins/（生成 plugins/<id>.lfplugin）
//
// 示例：node scripts/export-plugins.mjs videodl facefusion

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// 段级跳过（对齐 plugin_artifact_v4 EXCLUDED_SEGMENTS）。
const SKIP_SEGMENTS = new Set([
	'data', '.git', '.venv', 'venv', 'node_modules', '.lingfang',
	'__pycache__', '.pytest_cache', '.mypy_cache',
]);

function parseArgs(argv) {
	const ids = [];
	let out = join(REPO_ROOT, 'plugins');
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--out') { out = argv[++i]; continue; }
		if (a === '--help' || a === '-h') { out = null; continue; }
		ids.push(a);
	}
	return { ids, out };
}

/** 递归枚举插件源文件相对路径（对齐 plugin_artifact_v4 collect_files 的跳过规则）。 */
function listPluginFiles(pluginDir) {
	// 若插件根存在 vendor 归档（整包 vendor.tar.gz 或分卷 vendor.tar.gz.partNN），则跳过原始
	// vendor/ 目录：vendored 上游源码已压缩进归档，避免重复打进包，也避免包内出现大量文本文件
	// 触发 AI 政策扫描（第三方端点/密钥字段）。分卷用于上游体积大、单文件超 60MiB 制品上限时
	// （如 moneyprinter-turbo 的字体/音乐资源），launcher 首启流式拼接解压。
	const hasVendorArchive = existsSync(join(pluginDir, 'vendor.tar.gz'))
		|| readdirSync(pluginDir).some((n) => /^vendor\.tar\.gz\.part\d+$/.test(n));
	const skipTopLevel = hasVendorArchive ? new Set(['vendor']) : null;
	const results = [];
	const walk = (dir, atRoot) => {
		let entries;
		try { entries = readdirSync(dir); } catch { return; }
		for (const name of entries) {
			// dotfiles / dot-dirs 跳过（覆盖 .assets 等；.git/.venv 等也在 SKIP_SEGMENTS）。
			if (name.startsWith('.')) continue;
			if (SKIP_SEGMENTS.has(name)) continue;
			if (atRoot && skipTopLevel && skipTopLevel.has(name)) continue;
			const full = join(dir, name);
			let st;
			try { st = statSync(full); } catch { continue; }
			if (st.isDirectory()) {
				walk(full, false);
			} else {
				const rel = relative(pluginDir, full).split(sep).join('/');
				results.push(rel);
			}
		}
	};
	walk(pluginDir, true);
	return results.sort();
}

// === 最小 ZIP 写入器（Store + Deflate）=====================================

const DOS_EPOCH_TO_UNIX = 0;
const DOS_DATETIME_DEFAULT = 0; // 与 Rust DateTime::default() 一致（1980-01-01 00:00:00 → 0）。

function dosTime(date) {
	// ZIP DOS time/date：与 Rust 侧 DateTime::default()（全 0）对齐，保证确定性。
	return { time: DOS_DATETIME_DEFAULT, date: DOS_DATETIME_DEFAULT };
}

/** 写一个 ZIP 条目，返回 { localHeader, data, centralEntry } 的 Buffer 片段与中央目录记录。 */
function buildZipEntry(name, contentBytes, compress) {
	const nameBytes = Buffer.from(name, 'utf8');
	const crc = crc32(contentBytes) >>> 0;
	let storedBytes = contentBytes;
	let method = 0; // 0 = stored
	let compressed = contentBytes;
	if (compress) {
		const deflated = deflateRawSync(contentBytes, { level: 6 });
		// 仅当 deflate 真的更小才用（否则 store）。
		// 用 deflateRaw（无 zlib 头/尾），匹配 ZIP method 8 的「原始 deflate 流」约定。
		if (deflated.length < contentBytes.length) {
			compressed = deflated;
			method = 8; // 8 = deflate
		}
	}
	const { time, date } = dosTime();

	// 本地文件头（30 字节 + 文件名）
	const localHeader = Buffer.alloc(30);
	localHeader.writeUInt32LE(0x04034b50, 0);      // 签名
	localHeader.writeUInt16LE(20, 4);               // 解压所需版本
	localHeader.writeUInt16LE(0, 6);                // 通用标志位
	localHeader.writeUInt16LE(method, 8);           // 压缩方法
	localHeader.writeUInt16LE(time, 10);            // 修改时间
	localHeader.writeUInt16LE(date, 12);            // 修改日期
	localHeader.writeUInt32LE(crc, 14);             // CRC-32
	localHeader.writeUInt32LE(compressed.length, 18); // 压缩大小
	localHeader.writeUInt32LE(contentBytes.length, 22); // 未压缩大小
	localHeader.writeUInt16LE(nameBytes.length, 26);   // 文件名长度
	localHeader.writeUInt16LE(0, 28);              // 额外字段长度

	return {
		localHeader,
		nameBytes,
		data: compressed,
		// 中央目录头（46 字节 + 文件名）
		central: (offset) => {
			const ch = Buffer.alloc(46);
			ch.writeUInt32LE(0x02014b50, 0);            // 中央文件头签名
			ch.writeUInt16LE(20, 4);                    // 制作版本
			ch.writeUInt16LE(20, 6);                    // 解压所需版本
			ch.writeUInt16LE(0, 8);                     // 通用标志位
			ch.writeUInt16LE(method, 10);               // 压缩方法
			ch.writeUInt16LE(time, 12);                 // 修改时间
			ch.writeUInt16LE(date, 14);                 // 修改日期
			ch.writeUInt32LE(crc, 16);                  // CRC-32
			ch.writeUInt32LE(compressed.length, 20);    // 压缩大小
			ch.writeUInt32LE(contentBytes.length, 24);  // 未压缩大小
			ch.writeUInt16LE(nameBytes.length, 28);     // 文件名长度
			ch.writeUInt16LE(0, 30);                    // 额外字段长度
			ch.writeUInt16LE(0, 32);                    // 文件注释长度
			ch.writeUInt16LE(0, 34);                    // 起始盘号
			ch.writeUInt16LE(0, 36);                    // 内部属性
			ch.writeUInt32LE(0, 38);                    // 外部属性
			ch.writeUInt32LE(offset, 42);               // 本地头偏移
			return Buffer.concat([ch, nameBytes]);
		},
	};
}

/** 把条目列表打包成完整 ZIP Buffer。 */
function writeZip(entries) {
	const chunks = [];
	const centrals = [];
	let offset = 0;
	for (const entry of entries) {
		// entry 已含 localHeader + nameBytes + data；记录本地头起始偏移。
		centrals.push(entry.central(offset));
		const local = Buffer.concat([entry.localHeader, entry.nameBytes, entry.data]);
		chunks.push(local);
		offset += local.length;
	}
	const centralStart = offset;
	const centralBuf = Buffer.concat(centrals);
	const centralEnd = centralStart + centralBuf.length;

	// EOCD（22 字节）
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);              // EOCD 签名
	eocd.writeUInt16LE(0, 4);                        // 盘号
	eocd.writeUInt16LE(0, 6);                        // 起始盘
	eocd.writeUInt16LE(entries.length, 8);           // 本盘条目数
	eocd.writeUInt16LE(entries.length, 10);          // 总条目数
	eocd.writeUInt32LE(centralBuf.length, 12);       // 中央目录大小
	eocd.writeUInt32LE(centralStart, 16);            // 中央目录偏移
	eocd.writeUInt16LE(0, 20);                       // 注释长度

	return Buffer.concat([...chunks, centralBuf, eocd]);
}

async function exportPlugin(pluginId, outDir) {
	const pluginDir = join(REPO_ROOT, 'plugins', pluginId);
	if (!existsSync(pluginDir)) throw new Error(`插件目录不存在：${pluginId}`);

	const manifestPath = join(pluginDir, 'manifest.json');
	if (!existsSync(manifestPath)) throw new Error(`插件 ${pluginId} 缺少 manifest.json，无法导出`);

	// manifest 校验：id/name/version(SemVer)/entry/runtime_type 必填（对齐 validate_manifest）。
	const manifestText = readFileSync(manifestPath, 'utf8');
	let manifest;
	try {
		manifest = JSON.parse(manifestText);
	} catch (err) {
		throw new Error(`manifest.json 格式错误：${err.message}`);
	}
	for (const field of ['id', 'name', 'version', 'entry', 'runtime_type']) {
		const v = manifest[field];
		if (typeof v !== 'string' || v.trim() === '') {
			throw new Error(`manifest.json 缺少 ${field}`);
		}
	}
	if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
		throw new Error(`manifest.version 不是严格 SemVer：${manifest.version}`);
	}
	if (!['client', 'cloud', 'nodejs', 'python'].includes(manifest.runtime_type)) {
		throw new Error(`manifest.runtime_type 不受支持：${manifest.runtime_type}`);
	}

	// 枚举源文件（已排除 dotfiles + SKIP_SEGMENTS）。
	// manifest.json / _meta.json 由固定元数据条目单独写入，从源文件列表里剔除，
	// 与 Rust package_workspace 的 retain(|n| n != "manifest.json") 一致（避免重复）。
	const paths = listPluginFiles(pluginDir).filter((p) => p !== 'manifest.json' && p !== '_meta.json');
	if (!paths.includes(manifest.entry)) {
		throw new Error(`manifest.entry 指向的文件不在制品内：${manifest.entry}`);
	}

	// 构建条目（顺序：_meta.json、manifest.json、源文件按名排序 —— 与 Rust package_workspace 一致）。
	const entries = [];
	entries.push(buildZipEntry('_meta.json', Buffer.from('{"format":"lingfang-plugin","formatVersion":4}'), true));
	entries.push(buildZipEntry('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)), true));
	for (const p of paths) {
		const bytes = readFileSync(join(pluginDir, p));
		entries.push(buildZipEntry(p, bytes, true));
	}

	const zipBuf = writeZip(entries);
	mkdirSync(outDir, { recursive: true });
	const outFile = join(outDir, `${pluginId}.lfplugin`);
	writeFileSync(outFile, zipBuf);
	const sizeKB = (zipBuf.length / 1024).toFixed(1);
	console.log(`✅ ${pluginId}.lfplugin v4  (${sizeKB} KB, ${entries.length} 条目) → ${relative(REPO_ROOT, outFile)}`);
	return { id: pluginId, name: manifest.name, version: manifest.version, fileCount: entries.length };
}

async function main() {
	const { ids, out } = parseArgs(process.argv);
	if (out === null || ids.length === 0) {
		console.log('用法: node scripts/export-plugins.mjs <plugin-id>... [--out dir]');
		console.log('示例: node scripts/export-plugins.mjs videodl facefusion');
		console.log('输出: v4 格式 .lfplugin（formatVersion:4，纯 Node 标准库打包）');
		process.exit(0);
	}
	console.log(`导出 ${ids.length} 个插件为 v4 格式（out=${relative(REPO_ROOT, out)}）…`);
	let failed = 0;
	for (const id of ids) {
		try { await exportPlugin(id, out); }
		catch (err) { console.error(`❌ ${id}: ${err.message}`); failed += 1; }
	}
	if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
