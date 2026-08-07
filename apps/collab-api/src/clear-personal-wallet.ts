// clear-personal-wallet.ts —— 个人钱包余额清零脚本（R2：个人 Wallet 退役）。
//
// ⚠️⚠️⚠️ 生产数据破坏操作，禁止在本任务中自动执行 ⚠️⚠️⚠️
//   - 本脚本仅作为「迁移工具」交付。执行时机/操作由运维在确认 pg_dump 备份完成后手动进行。
//   - 决策依据：design §4.4 / §7 决策 2——存量个人余额「不迁移、直接清零作废」，
//     团队余额从 0 起，靠 collab-admin 后台充值。无资金搬运。
//
// 执行前置（运维手动，缺一不可）：
//   1) 备份（唯一还原依据）：
//        pg_dump -t wallet -t wallet_transaction "$DATABASE_URL" > backup-wallet-clear-$(date +%s).sql
//      妥善归档备份文件路径（回滚时 psql < 该文件 还原）。
//   2) 先在 staging 试跑，核对受影响行数符合预期，再上 production。
//   3) 上线前运营公告：个人余额作废属用户可感知变更（design 风险 R-6）。
//
// 本脚本行为（幂等、纯清零、不删表、不搬运、不写团队流水）：
//   UPDATE wallet SET balanceCents = 0 WHERE balanceCents <> 0
//   - 保留 wallet 行 + 历史 walletTransaction（便于回滚与历史审计）。
//   - DROP TABLE 留到观察期（≥1 发布周期）后另议（design §7 决策 6），本脚本不做。
//
// 运行方式（运维手动）：
//   tsx src/clear-personal-wallet.ts            # 实际清零（需 CONFIRM_CLEAR=1）
//   tsx src/clear-personal-wallet.ts --dry-run  # 仅打印将受影响行数，不写库
//
// 安全闸门：未设置环境变量 CONFIRM_CLEAR=1 时，脚本拒绝执行写操作（防误跑）。

import { PrismaClient } from '@prisma/client';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const confirmed = process.env.CONFIRM_CLEAR === '1';

  const prisma = new PrismaClient();
  try {
    // 受影响行数预览（balanceCents <> 0 的个人钱包）。
    const affected = await prisma.wallet.count({ where: { balanceCents: { not: 0 } } });
    const totalCents = await prisma.wallet.aggregate({ _sum: { balanceCents: true } });
    console.log(`[clear-personal-wallet] 待清零钱包行数: ${affected}`);
    console.log(
      `[clear-personal-wallet] 当前个人钱包余额总额(分): ${totalCents._sum.balanceCents ?? 0}`
    );

    if (dryRun) {
      console.log('[clear-personal-wallet] --dry-run：未写库，退出。');
      return;
    }
    if (!confirmed) {
      console.error('[clear-personal-wallet] 拒绝执行：未设置 CONFIRM_CLEAR=1。');
      console.error('  请先 pg_dump 备份 wallet/wallet_transaction，再以 CONFIRM_CLEAR=1 重跑。');
      process.exitCode = 1;
      return;
    }

    const result = await prisma.wallet.updateMany({
      where: { balanceCents: { not: 0 } },
      data: { balanceCents: 0 },
    });
    console.log(`[clear-personal-wallet] 已清零 ${result.count} 个钱包余额（保留行 + 历史流水）。`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[clear-personal-wallet] 执行失败:', err);
  process.exitCode = 1;
});
