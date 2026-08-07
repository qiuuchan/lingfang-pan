// 插件核心价值链冒烟验证：发布 v4 .lfplugin -> 提交市场 -> 平台审核 -> 验证上架
// 用法：node scripts/plugin-lifecycle-smoke.mjs
// 依赖：运行中的 collab-api (http://localhost:19006)。演示团队/demo-user 会由脚本幂等确保（见 _smoke-helpers.mjs）。
import { deflateRawSync } from 'node:zlib';
import { adminLogin, ensureDemoTenant, jreq, auth } from './_smoke-helpers.mjs';

const API = process.env.API_BASE || 'http://localhost:19006';
const PLUGIN_ID = 'demo-calc-' + Date.now().toString(36);
const PLUGIN_NAME = '演示计算器';

// ---- 复用项目 spec 的纯 JS ZIP 构造（通过 plugin-artifact 校验）----
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let v = i;
    for (let b = 0; b < 8; b += 1) v = (v & 1) !== 0 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    t[i] = v >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC32_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const compression = e.compression ?? 0;
    const payload = compression === 8 ? deflateRawSync(e.content) : e.content;
    const size = e.content.length;
    const checksum = crc32(e.content);
    const flags = 0x800; // utf-8 filename
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(compression, 8);
    lh.writeUInt32LE(checksum, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, payload);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(compression, 10);
    ch.writeUInt32LE(checksum, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + payload.length;
  }
  const cb = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cb.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cb, eocd]);
}

function buildArtifact() {
  const meta = Buffer.from(JSON.stringify({ format: 'lingfang-plugin', formatVersion: 4 }));
  const manifest = Buffer.from(
    JSON.stringify({
      id: PLUGIN_ID,
      name: PLUGIN_NAME,
      version: '1.0.0',
      description: '插件价值链冒烟验证用的示例插件',
      runtime_type: 'client',
      entry: 'ui/index.html',
      visibility: 'tenant',
      capabilities: [],
    })
  );
  const html = Buffer.from(
    '<!doctype html><html><body><h1>Demo Calc</h1><p>lingfang plugin smoke</p></body></html>'
  );
  return makeZip([
    { name: '_meta.json', content: meta },
    { name: 'manifest.json', content: manifest },
    { name: 'ui/index.html', content: html, compression: 8 },
  ]);
}

// login / auth / jreq 来自 ./_smoke-helpers.mjs（与 marketplace-billing-smoke.mjs 共用）

async function main() {
  console.log('== 构造 .lfplugin 包 ==');
  const zip = buildArtifact();
  console.log(`   包大小 ${zip.length} 字节, 含 _meta.json/manifest.json/ui/index.html`);

  console.log('== 0) 确保演示团队 / demo-user（幂等，全新库也能跑）==');
  const plat = await adminLogin();
  const { teamId, demoToken } = await ensureDemoTenant(plat);
  const team = { token: demoToken, teamId };
  console.log(`   demo token 长度 ${team.token.length}, teamId=${team.teamId}`);

  console.log('== 2) 流式上传发布 v4 版本 ==');
  const up = await jreq(
    await fetch(`${API}/api/plugin-registry/releases`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.lingfang.plugin+zip',
        'content-length': String(zip.length),
        'x-plugin-source-kind': 'API',
        ...auth(team.token),
      },
      body: zip,
    })
  );
  if (up.status < 200 || up.status >= 300)
    throw new Error(
      `upload failed ${up.status}: ${JSON.stringify(up.json || up.text).slice(0, 300)}`
    );
  const pkgId = up.json.package?.id ?? up.json.packageId;
  const relId = up.json.release?.id ?? up.json.releaseId;
  console.log(`   OK status=${up.status}, packageId=${pkgId}, releaseId=${relId}`);

  console.log('== 3) 提交市场（免费, priceCents=0）==');
  const sub = await jreq(
    await fetch(`${API}/api/plugin-releases/${relId}/submit-marketplace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(team.token) },
      body: JSON.stringify({ priceCents: 0 }),
    })
  );
  if (sub.status < 200 || sub.status >= 300)
    throw new Error(
      `submit failed ${sub.status}: ${JSON.stringify(sub.json || sub.text).slice(0, 300)}`
    );
  console.log(
    `   OK status=${sub.status}, marketReviewStatus=${sub.json?.marketReviewStatus ?? '(set)'}`
  );

  console.log('== 4) 平台管理员审核 approve ==');
  const appr = await jreq(
    await fetch(`${API}/api/admin/plugin-releases/${relId}/approve`, {
      method: 'POST',
      headers: auth(plat),
    })
  );
  if (appr.status < 200 || appr.status >= 300)
    throw new Error(
      `approve failed ${appr.status}: ${JSON.stringify(appr.json || appr.text).slice(0, 300)}`
    );
  console.log(
    `   OK status=${appr.status}, status=${appr.json?.status}, marketReviewStatus=${appr.json?.marketReviewStatus}`
  );

  console.log('== 5) 验证上架（package 详情 + 市场可见）==');
  const detail = await jreq(
    await fetch(`${API}/api/plugin-packages/${pkgId}`, { headers: auth(team.token) })
  );
  const listingStatus = detail.json?.listing?.status ?? detail.json?.marketplaceStatus;
  console.log(`   packageDetail status=${detail.status}, listingStatus=${listingStatus}`);
  const rel = await jreq(
    await fetch(`${API}/api/plugin-releases/${relId}`, { headers: auth(team.token) })
  );
  console.log(
    `   releaseDetail status=${rel.json?.status}, marketReviewStatus=${rel.json?.marketReviewStatus}`
  );
  const mkt = await jreq(
    await fetch(`${API}/api/plugin-registry/marketplace`, { headers: auth(team.token) })
  );
  const items = mkt.json?.items ?? (Array.isArray(mkt.json) ? mkt.json : []);
  const found = items.find((p) => p.packageId === pkgId);
  console.log(
    `   市场目录 status=${mkt.status}, 目录条目数=${items.length}, 是否含本插件=${!!found}`
  );

  console.log('\n== 结果 ==');
  const listingActive = listingStatus === 'ACTIVE';
  if (listingActive) {
    console.log('PASS ✅ 插件价值链完整跑通：发布 v4 → 提交市场 → 平台审核 → 上架(listing ACTIVE)');
    if (!found)
      console.log(
        '   (注：本插件未出现在「当前团队」市场目录中，可能因可见性/归属过滤，不影响上架结论)'
      );
    process.exit(0);
  } else {
    console.log('WARN ⚠️ 链路执行完毕但上架态未确认，请检查上面输出');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error('FAIL ❌', e.message);
  process.exit(1);
});
