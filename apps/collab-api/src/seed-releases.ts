// 应用版本发布 seed：写入一个示例 STABLE 0.0.1 版本 + 占位产物，方便官网首屏展示（无真实安装包时可空跑）。
// 幂等：按 (channel, version) upsert 语义——已存在则跳过，保留 Admin 的自定义。
//
// 注意：url 为占位（GitHub Releases 占位），正式发布前由平台 Admin 通过 /api/admin/releases 替换为真实链接。
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/** 示例版本：0.0.1 STABLE，含 Windows x86_64 占位产物。 */
const SAMPLE_RELEASE = {
  version: '0.0.1',
  channel: 'STABLE' as const,
  title: '首个公开预览版',
  notes: [
    '## 0.0.1',
    '',
    'LingFang 首个公开预览版。',
    '',
    '### 核心能力',
    '- **AI 插件生成**：自然语言描述需求，SSE 流式生成可运行插件，沙箱即时预览。',
    '- **市场与经济**：搜索 / 评分 / 安装插件，钱包余额体系与付费结算。',
    '- **多租户协作**：团队管理、管理员审批、团队共享余额。',
    '',
    '> 下载链接为占位，正式发布前会替换为真实安装包地址。',
  ].join('\n'),
};

/** 占位产物：Windows x86_64。url 指向 GitHub Releases（占位，发布前替换）。 */
const SAMPLE_ASSET = {
  platform: 'WINDOWS' as const,
  arch: 'X86_64' as const,
  url: 'https://github.com/LingFang/lingfang-platform/releases/tag/v0.0.1',
  filename: 'LingFang_0.0.1_x64-setup.exe',
};

async function main() {
  const existing = await prisma.release.findUnique({
    where: { channel_version: { channel: SAMPLE_RELEASE.channel, version: SAMPLE_RELEASE.version } },
  });
  if (existing) {
    console.log(`Release seed 跳过：${SAMPLE_RELEASE.channel}/${SAMPLE_RELEASE.version} 已存在。`);
    return;
  }

  const release = await prisma.release.create({
    data: {
      version: SAMPLE_RELEASE.version,
      channel: SAMPLE_RELEASE.channel,
      status: 'PUBLISHED',
      title: SAMPLE_RELEASE.title,
      notes: SAMPLE_RELEASE.notes,
      isLatest: true,
      publishedAt: new Date(),
      assets: {
        create: [SAMPLE_ASSET],
      },
    },
    include: { assets: true },
  });
  console.log(`Release seed 完成：${release.channel}/${release.version}（${release.assets.length} 个产物）。`);
}

main().finally(async () => prisma.$disconnect());
