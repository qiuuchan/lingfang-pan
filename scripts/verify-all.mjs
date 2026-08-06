// 全量自检入口：依次运行三个冒烟脚本，汇总结果。
// 用法（项目根目录）：node scripts/verify-all.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const jobs = [
  { name: '基础健康检查(鉴权/RBAC/平台信息)', file: 'scripts/smoke.mjs' },
  { name: '插件发布价值链(发布→上架)', file: 'scripts/plugin-lifecycle-smoke.mjs' },
  { name: '灵石计费购买链路(跨团队购买→扣费)', file: 'scripts/marketplace-billing-smoke.mjs' },
];

let pass = 0;
let fail = 0;
for (const j of jobs) {
  console.log(`\n──────── ${j.name} (${j.file}) ────────`);
  const r = spawnSync(process.execPath, [j.file], { cwd: root, stdio: 'inherit' });
  if (r.status === 0) { pass += 1; console.log(`✓ ${j.name} 通过`); }
  else { fail += 1; console.log(`✗ ${j.name} 失败 (exit ${r.status})`); }
}
console.log(`\n════ 全量验证汇总：通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail === 0 ? 0 : 1);
