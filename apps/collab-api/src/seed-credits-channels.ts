// 计费与模型中转 seed：写入默认模型版本配置、模型定价、灵石全局参数。
// 见 docs/billing-and-relay-design.md §10。幂等：按主键/唯一键跳过已存在行。
//
// 设计：
//  - ModelTierConfig：FAST/PREMIUM 各一行，底层模型用经济/旗舰占位（admin 部署后改为真实模型 id）。
//  - ModelPricing：示例定价（按 token / 按张 / 按次），admin 可在后台调整。
//  - PlatformSetting：creditSignupBonus（注册赠送灵石）、creditReserveCap<tier>（预扣上限）、
//    aiUsageGuardRule（系统提示词规则，默认值即需求 #3 原文）。
//  - 不 seed Channel（上游需真实 key，由 admin 在后台创建 + 健康测试）。
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from './prisma.adapter';

/** 默认系统提示词强制规则（需求 #3）。与 packages/contract/src/billing.ts DEFAULT_AI_USAGE_GUARD_RULE 保持一致。 */
const DEFAULT_AI_USAGE_GUARD_RULE =
  '凡涉及 AI 生图或其他 AI 能力调用，必须且仅能使用灵坊平台提供的服务，禁止使用任何其他第三方或自定义接口。';

const adapter = createPrismaAdapter(process.env);
const prisma = new PrismaClient({ adapter });

/** ModelTierConfig 已移除（版本=渠道标签）。默认版本配置随之删除。 */

/** 默认模型定价（整数分；1 灵石=100 分）。PER_TOKEN_* 的 pricePerUnit = 每 1M token 灵石分（v0.0.6 改为每百万）。admin 可调整。 */
const DEFAULT_PRICING = [
  // chat：每 1M token（例：每百万输入 token 100000 分=1000 灵石 ≈ 500 token 扣 100 分=1 灵石）
  {
    capability: 'chat',
    model: 'gpt-4o-mini',
    label: 'GPT-4o mini（快速版）',
    unit: 'PER_TOKEN_INPUT' as const,
    pricePerUnit: 100000,
    tier: 'FAST' as const,
  },
  {
    capability: 'chat',
    model: 'claude-sonnet-4-6',
    label: 'Claude Sonnet（高级版）',
    unit: 'PER_TOKEN_INPUT' as const,
    pricePerUnit: 300000,
    tier: 'PREMIUM' as const,
  },
  // image：按张
  {
    capability: 'image',
    model: 'dall-e-3',
    label: 'DALL·E 3 生图',
    unit: 'PER_IMAGE' as const,
    pricePerUnit: 5000,
    tier: null,
  },
  {
    capability: 'image',
    model: 'dall-e-2',
    label: 'DALL·E 2 生图',
    unit: 'PER_IMAGE' as const,
    pricePerUnit: 2000,
    tier: null,
  },
  // action：按次（示例：创建插件聊天会话固定扣 Y 灵石）
  {
    capability: 'action',
    model: 'create_plugin_session',
    label: '创建插件会话',
    unit: 'PER_CALL' as const,
    pricePerUnit: 1000,
    tier: null,
  },
  // video：按秒（RunningHub 动作迁移视频生成，按参考视频时长计费）
  {
    capability: 'video',
    model: 'video_generate',
    label: '视频生成（动作迁移）',
    unit: 'PER_SECOND' as const,
    pricePerUnit: 50,
    tier: null,
  },
  // audio：按秒（RunningHub 声音克隆，按目标文本估算的输出音频时长计费）
  {
    capability: 'audio',
    model: 'voice_clone',
    label: '声音克隆（文本转语音）',
    unit: 'PER_SECOND' as const,
    pricePerUnit: 50,
    tier: null,
  },
];

/** 默认灵石全局参数（PlatformSetting 键值表）。 */
const DEFAULT_SETTINGS = [
  { key: 'creditSignupBonus', value: '100000', description: '新团队注册赠送灵石数（存储单位=分，1 灵石=100 分 → 1000 灵石）' },
  {
    key: 'creditReserveCapFast',
    value: '20000',
    description: '快速版单次调用预扣灵石上限（整数分；实算后冲销）',
  },
  {
    key: 'creditReserveCapPremium',
    value: '200000',
    description: '高级版单次调用预扣灵石上限（整数分；实算后冲销）',
  },
  {
    key: 'aiUsageGuardRule',
    value: DEFAULT_AI_USAGE_GUARD_RULE,
    description: '系统提示词强制规则（AI 能力必须且仅能使用灵坊平台服务）',
  },
  // RBFLow 视频生成服务配置（平台运营实例，后台管理配置；空值=未配置）
  {
    key: 'rbflowUrl',
    value: '',
    description: 'RBFLow 视频生成服务地址（平台运营实例，服务端转发用，用户不可见）',
  },
  {
    key: 'rbflowApiKey',
    value: '',
    description: 'RBFLow 静态 API-KEY（服务端转发用，非用户可见；后台 reveal-secret 可查）',
  },
];

async function main() {
  // ModelTierConfig 已移除（版本=渠道标签）。seed 不再配版本→固定模型。

  // 模型定价：按 (capability, model, tier) 唯一键跳过已存在。
  for (const p of DEFAULT_PRICING) {
    const existing = await prisma.modelPricing.findFirst({
      where: { capability: p.capability, model: p.model, tier: p.tier },
      select: { id: true },
    });
    if (existing) {
      console.log(`pricing seed 跳过：${p.capability}/${p.model}/${p.tier ?? '-'}`);
      continue;
    }
    await prisma.modelPricing.create({ data: p });
    console.log(`pricing seed 创建：${p.label}（${p.pricePerUnit} 灵石/${p.unit}）`);
  }

  // 全局参数：按 key upsert（已存在则不改值，避免覆盖 admin 自定义）。
  for (const s of DEFAULT_SETTINGS) {
    await prisma.platformSetting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value, description: s.description },
      update: {}, // 已存在不改（保留 admin 调整）
    });
    console.log(`setting seed 就绪：${s.key}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
