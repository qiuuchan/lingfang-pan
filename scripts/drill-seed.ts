// 演练造数脚本（仅用于 T4 恢复演练，不进入生产代码路径）。
// 通过 Prisma Client 写入，自动处理 enum 与 FK。
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '../src/prisma.adapter';

const prisma = new PrismaClient({ adapter: createPrismaAdapter(process.env as unknown as Record<string, string | undefined>) });

async function main() {
  const team = await prisma.team.upsert({
    where: { id: 't000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: 't000000-0000-0000-0000-000000000001',
      name: 'DrillTeamA',
      slug: 'drill-team-a',
      status: 'ACTIVE',
      balanceCents: 0,
      allowPublicJoin: false,
      description: 'drill',
    },
  });
  const user = await prisma.user.upsert({
    where: { id: 'u000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: 'u000000-0000-0000-0000-000000000001',
      email: 'drill@lf.test',
      displayName: 'drilluser',
      passwordHash: 'x',
      status: 'ACTIVE',
      platformRole: 'NONE',
      tokenVersion: 0,
      failedLoginAttempts: 0,
      teamContextVersion: 0,
    },
  });
  const wallet = await prisma.wallet.upsert({
    where: { id: 'w000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: 'w000000-0000-0000-0000-000000000001',
      userId: user.id,
      balanceCents: 10000,
    },
  });
  await prisma.walletTransaction.upsert({
    where: { id: 'wt000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: 'wt000000-0000-0000-0000-000000000001',
      userId: user.id,
      amountCents: 10000,
      direction: 'CREDIT' as const,
      reason: 'DRILL_SEED',
    },
  });
  const pkg = await prisma.pluginPackage.upsert({
    where: { id: 'pp000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: 'pp000000-0000-0000-0000-000000000001',
      ownerTeamId: team.id,
      manifestId: 'm000000-0000-0000-0000-000000000001',
      name: 'DrillPlugin',
      description: 'drill',
      governanceStatus: 'ACTIVE',
    },
  });
  await prisma.pluginRelease.upsert({
    where: { id: 'pr000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: 'pr000000-0000-0000-0000-000000000001',
      packageId: pkg.id,
      version: '0.0.1',
      manifest: {},
      fileManifest: {},
      artifactKey: 'key',
      sha256: 'deadbeef',
      sizeBytes: 1,
      targetPlatform: 'win32-x64',
      status: 'PUBLISHED',
      marketReviewStatus: 'APPROVED',
      sourceKind: 'LINGFANG_CREATOR',
      sourceLabel: 'label',
      ingestChannel: 'DESKTOP',
      aiPolicyVersion: 1,
      aiPolicyStatus: 'PASS',
      aiPolicyReason: 'ok',
      readmeMarkdown: 'readme',
      packagePolicySurfaceSha256: 'sha',
      actionSurfaceManifest: [],
      adaptationStatus: 'ADAPTED',
    },
  });
  await prisma.teamCredit.upsert({
    where: { teamId: team.id },
    update: {},
    create: { teamId: team.id, balance: 5000 },
  });
  await prisma.creditLedger.upsert({
    where: { id: 'cl000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: 'cl000000-0000-0000-0000-000000000001',
      teamId: team.id,
      amount: 5000,
      direction: 'CREDIT' as const,
      source: 'GRANT',
      reason: 'drill',
    },
  });
  console.log('[drill-seed] done: team/user/wallet/walletTx/pkg/release/teamCredit/creditLedger');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('[drill-seed] failed:', e);
    prisma.$disconnect();
    process.exitCode = 1;
  });
