// 灵石计费购买链路冒烟验证（跨团队真实购买 + 灵石扣减）：
//   平台管理员建「购买方团队」 -> 注册 buyer 用户并任命为管理员
//   -> demo 团队发布并上架定价插件 -> buyer 团队跨团队购买 -> 验证 buyer 团队灵石余额扣减
// 前置：MarketplaceCommerceState.writerMode 须为 SETTLEMENT_V2（脚本启动时幂等确保，见 enableSettlementV2）。
// 用法：node scripts/marketplace-billing-smoke.mjs
import { deflateRawSync } from 'node:zlib';
import {
  adminLogin,
  ensureDemoTenant,
  enableSettlementV2,
  login,
  jreq,
  auth,
  jsonH,
} from './_smoke-helpers.mjs';

const API = process.env.API_BASE || 'http://localhost:19006';
const PRICE_CENTS = 100; // 1 灵石

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
    const flags = 0x800;
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
function buildArtifact(pluginId) {
  const meta = Buffer.from(JSON.stringify({ format: 'lingfang-plugin', formatVersion: 4 }));
  const manifest = Buffer.from(
    JSON.stringify({
      id: pluginId,
      name: '计费演示插件',
      version: '1.0.0',
      description: '灵石计费购买链路冒烟验证',
      runtime_type: 'client',
      entry: 'ui/index.html',
      visibility: 'tenant',
      capabilities: [],
    })
  );
  const html = Buffer.from('<!doctype html><html><body><h1>Billing Demo</h1></body></html>');
  return makeZip([
    { name: '_meta.json', content: meta },
    { name: 'manifest.json', content: manifest },
    { name: 'ui/index.html', content: html, compression: 8 },
  ]);
}
// login / auth / jsonH / jreq 来自 ./_smoke-helpers.mjs（与 plugin-lifecycle-smoke.mjs 共用）
const pickBalance = (j) =>
  j ? (j.balanceCents ?? j.team?.balanceCents ?? j.data?.balanceCents) : undefined;

async function main() {
  const ts = Date.now().toString(36);
  const plat = await adminLogin();
  enableSettlementV2();

  console.log('== 1) 平台管理员建「购买方团队」(初始 100000 分) ==');
  const ct = await jreq(
    await fetch(`${API}/api/admin/teams`, {
      method: 'POST',
      headers: jsonH(plat),
      body: JSON.stringify({ name: '购买方团队' + ts, slug: 'buyer-' + ts, balanceCents: 100000 }),
    })
  );
  if (ct.status >= 300)
    throw new Error(`createTeam ${ct.status}: ${JSON.stringify(ct.json || ct.text).slice(0, 150)}`);
  const buyerTeamId = ct.json.id ?? ct.json.team?.id;
  console.log(`   buyerTeamId=${buyerTeamId}, 初始余额=${ct.json.balanceCents}`);

  console.log('== 2) 注册 buyer 用户并任命为团队管理员 ==');
  const be = `buyer-${ts}@lingfang.dev`;
  const reg = await jreq(
    await fetch(`${API}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: be, password: 'Buyer123!', displayName: '购买方' }),
    })
  );
  if (reg.status >= 300)
    throw new Error(
      `register ${reg.status}: ${JSON.stringify(reg.json || reg.text).slice(0, 150)}`
    );
  const buyerUserId = reg.json.user?.id ?? reg.json.id;
  const sa = await jreq(
    await fetch(`${API}/api/admin/teams/${buyerTeamId}/admins`, {
      method: 'POST',
      headers: jsonH(plat),
      body: JSON.stringify({ userId: buyerUserId }),
    })
  );
  if (sa.status >= 300)
    throw new Error(`setAdmin ${sa.status}: ${JSON.stringify(sa.json || sa.text).slice(0, 150)}`);
  console.log(`   buyer 用户=${be}, userId=${buyerUserId}, 已任命为管理员`);

  console.log('== 3) demo 团队发布并上架定价插件 ==');
  const { demoToken } = await ensureDemoTenant(plat);
  const team = demoToken;
  const pluginId = 'biz-demo-' + ts;
  const zip = buildArtifact(pluginId);
  const up = await jreq(
    await fetch(`${API}/api/plugin-registry/releases`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.lingfang.plugin+zip',
        'content-length': String(zip.length),
        'x-plugin-source-kind': 'API',
        ...auth(team),
      },
      body: zip,
    })
  );
  if (up.status >= 300)
    throw new Error(`upload ${up.status}: ${JSON.stringify(up.json || up.text).slice(0, 200)}`);
  const pkgId = up.json.package?.id;
  const relId = up.json.release?.id;
  console.log(`   packageId=${pkgId}, releaseId=${relId}`);
  const sub = await jreq(
    await fetch(`${API}/api/plugin-releases/${relId}/submit-marketplace`, {
      method: 'POST',
      headers: jsonH(team),
      body: JSON.stringify({ priceCents: PRICE_CENTS }),
    })
  );
  if (sub.status >= 300)
    throw new Error(`submit ${sub.status}: ${JSON.stringify(sub.json || sub.text).slice(0, 200)}`);
  const appr = await jreq(
    await fetch(`${API}/api/admin/plugin-releases/${relId}/approve`, {
      method: 'POST',
      headers: auth(plat),
    })
  );
  if (appr.status >= 300)
    throw new Error(
      `approve ${appr.status}: ${JSON.stringify(appr.json || appr.text).slice(0, 200)}`
    );
  console.log('   已上架(审核通过)');

  console.log('== 4) buyer 团队跨团队购买（查询余额前后）==');
  const buyerToken = (await login(be, 'Buyer123!')).token;
  const before = await jreq(
    await fetch(`${API}/api/admin/teams/${buyerTeamId}/detail`, { headers: auth(plat) })
  );
  const balBefore = pickBalance(before.json);
  const buy = await jreq(
    await fetch(`${API}/api/plugin-packages/${pkgId}/purchase`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'smoke-' + Date.now(),
        ...auth(buyerToken),
      },
      body: JSON.stringify({}),
    })
  );
  if (buy.status >= 300)
    throw new Error(
      `purchase ${buy.status}: ${JSON.stringify(buy.json || buy.text).slice(0, 200)}`
    );
  console.log(
    `   purchase status=${buy.status}, entitlementId=${buy.json?.entitlementId}, purchaseId=${buy.json?.purchaseId}`
  );
  const after = await jreq(
    await fetch(`${API}/api/admin/teams/${buyerTeamId}/detail`, { headers: auth(plat) })
  );
  const balAfter = pickBalance(after.json);

  const delta = (balBefore ?? 0) - (balAfter ?? 0);
  console.log('\n== 结果 ==');
  if (delta === PRICE_CENTS) {
    console.log(
      `PASS ✅ 灵石计费链路跑通：buyer 团队跨团队购买 demo 插件，灵石扣减 ${delta} 分(=${PRICE_CENTS / 100} 灵石), 余额 ${balBefore} -> ${balAfter}`
    );
    process.exit(0);
  } else {
    console.log(
      `WARN ⚠️ 余额变化 ${delta} 分, 预期 ${PRICE_CENTS} (before=${balBefore}, after=${balAfter})`
    );
    process.exit(2);
  }
}
main().catch((e) => {
  console.error('FAIL ❌', e.message);
  process.exit(1);
});
