// LLM provider 目录 seed：应用发布时写入一批默认 provider，方便开箱即用。
// v3 定稿：单 provider 云分发。models 字段不再使用（应用端通过 API 密钥动态拉取模型清单）。
// provider 只维护 apiUrl（连接信息），models 留空数组（前端不展示，拉取由客户端完成）。
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from './prisma.adapter';

const adapter = createPrismaAdapter(process.env);
const prisma = new PrismaClient({ adapter });

/** 默认 provider 清单（provider / name / apiUrl / sortOrder）。
 *  models 全部留空——应用端通过 fetch_models 命令动态拉取真实模型清单。 */
const DEFAULT_PROVIDERS = [
  {
    provider: 'openai',
    name: 'OpenAI 官方',
    apiUrl: 'https://api.openai.com/v1',
    description: 'OpenAI 官方 API',
    sortOrder: 1,
    isActive: true,
  },
  {
    provider: 'anthropic',
    name: 'Anthropic 官方',
    apiUrl: 'https://api.anthropic.com',
    description: 'Anthropic 官方 API',
    sortOrder: 2,
  },
  {
    provider: 'deepseek',
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com',
    description: 'DeepSeek 官方 API',
    sortOrder: 3,
  },
  {
    provider: 'moonshot',
    name: '月之暗面 Kimi',
    apiUrl: 'https://api.moonshot.cn/v1',
    description: 'Moonshot AI 官方 API',
    sortOrder: 4,
  },
  {
    provider: 'qwen',
    name: '通义千问',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    description: '阿里云通义千问',
    sortOrder: 5,
  },
  {
    provider: 'azure',
    name: 'Azure OpenAI',
    apiUrl: 'https://<your-resource>.openai.azure.com',
    description: 'Azure OpenAI Service（需替换为自有 resource name）',
    sortOrder: 6,
  },
];

async function main() {
  for (const p of DEFAULT_PROVIDERS) {
    const existing = await prisma.llmGateway.findUnique({
      where: { name: p.name },
      select: { id: true },
    });
    if (existing) {
      console.log(`provider seed 跳过：${p.name} 已存在。`);
      continue;
    }
    await prisma.llmGateway.create({
      data: {
        provider: p.provider,
        name: p.name,
        apiUrl: p.apiUrl,
        models: [],
        description: p.description,
        sortOrder: p.sortOrder,
        status: 'ENABLED',
        isActive: p.isActive ?? false,
      },
    });
    console.log(`provider seed 创建：${p.name}（${p.apiUrl}）${p.isActive ? ' [当前启用]' : ''}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
