// LLM 网关目录 seed：应用发布时写入一批默认网关，方便开箱即用（design.md §9 / prd.md D2）。
// 幂等：按 name upsert，重复执行不报错、不覆盖已调整的 models/sortOrder（仅 create 时用默认值，
// 已存在则跳过——允许平台 Admin 在 seed 后自定义）。
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/** 默认网关清单（provider / name / apiUrl / models / sortOrder）。
 *  winget-style: apiUrl 已规范化去尾斜杠。
 *  对应 prd.md AC14 + design.md §9。 */
const DEFAULT_GATEWAYS = [
  {
    provider: 'openai',
    name: 'OpenAI 官方',
    apiUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    description: 'OpenAI 官方 API（GPT 系列模型）',
    sortOrder: 1,
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
  for (const gateway of DEFAULT_GATEWAYS) {
    // 幂等 upsert by name（name 唯一约束）。已存在时不覆盖，保留 Admin 的自定义。
    // 用findFirst避免 upsert 在已存在时仍写 update: {}（触发 updatedAt 变化）。
    const existing = await prisma.llmGateway.findUnique({ where: { name: gateway.name } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.llmGateway.create({
      data: {
        provider: gateway.provider,
        name: gateway.name,
        apiUrl: gateway.apiUrl,
        models: gateway.models,
        description: gateway.description,
        sortOrder: gateway.sortOrder,
        status: 'ENABLED',
      },
    });
    created++;
  }
  console.log(`LLM 网关 seed 完成：新增 ${created} 条，跳过已存在 ${skipped} 条。`);
}

main().finally(async () => prisma.$disconnect());
