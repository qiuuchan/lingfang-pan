// LLM provider 目录 seed：应用发布时写入一批默认 provider，方便开箱即用（design.md §9 / prd.md D2）。
// v3 定稿：单 provider 云分发。把 OpenAI 那条设为 isActive=true（当前启用），
// 方便全新库首次部署即可填 key 拉模型（无需 Admin 手动激活）。
// 注意：仅「全新库首次 seed」时写 isActive=true；升级库（已有同名 provider）重跑 seed 会 skip，
// 此时若全表无 active，需 Admin 手动激活一条（design.md §9 首版无生产数据，破坏式重建可接受）。
// 幂等：按 name upsert，重复执行不报错、不覆盖已调整的 models/sortOrder/isActive（仅 create 时用默认值，
// 已存在则跳过——允许平台 Admin 在 seed 后自定义）。
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/** 默认 provider 清单（provider / name / apiUrl / models / sortOrder）。
 *  winget-style: apiUrl 已规范化去尾斜杠。
 *  对应 prd.md AC14 + design.md §9。 */
const DEFAULT_PROVIDERS = [
  {
    provider: 'openai',
    name: 'OpenAI 官方',
    apiUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    description: 'OpenAI 官方 API（GPT 系列模型）',
    sortOrder: 1,
    isActive: true, // 默认启用 OpenAI（当前启用 provider，全表最多一条 true）
  },
  {
    provider: 'anthropic',
    name: 'Anthropic 官方',
    apiUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-6', 'claude-opus-4-8'],
    description: 'Anthropic 官方 API（Claude 系列模型）',
    sortOrder: 2,
  },
  {
    provider: 'deepseek',
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    description: 'DeepSeek 官方 API（深度求索系列模型）',
    sortOrder: 3,
  },
  {
    provider: 'moonshot',
    name: '月之暗面 Kimi',
    apiUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    description: 'Moonshot AI 官方 API（Kimi 系列模型）',
    sortOrder: 4,
  },
  {
    provider: 'qwen',
    name: '通义千问',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    description: '阿里云通义千问（DashScope OpenAI 兼容模式）',
    sortOrder: 5,
  },
  {
    provider: 'azure',
    name: 'Azure OpenAI',
    apiUrl: 'https://<your-resource>.openai.azure.com',
    models: ['gpt-4o', 'gpt-4o-mini'],
    description: 'Azure OpenAI Service（需替换为自有 resource name）',
    sortOrder: 6,
  },
];

async function main() {
  let created = 0;
  let skipped = 0;
  for (const provider of DEFAULT_PROVIDERS) {
    // 幂等 upsert by name（name 唯一约束）。已存在时不覆盖，保留 Admin 的自定义。
    // 用 findUnique 避免 upsert 在已存在时仍写 update: {}（触发 updatedAt 变化）。
    const existing = await prisma.llmGateway.findUnique({ where: { name: provider.name } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.llmGateway.create({
      data: {
        provider: provider.provider,
        name: provider.name,
        apiUrl: provider.apiUrl,
        models: provider.models,
        description: provider.description,
        sortOrder: provider.sortOrder,
        status: 'ENABLED',
        isActive: provider.isActive ?? false,
      },
    });
    created++;
  }
  console.log(`LLM provider seed 完成：新增 ${created} 条，跳过已存在 ${skipped} 条。`);
}

main().finally(async () => prisma.$disconnect());
