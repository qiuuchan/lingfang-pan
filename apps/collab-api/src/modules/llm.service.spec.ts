// LlmService 单测：design.md §10.1 六项覆盖。
//  - member_cannot_upsert_binding（AC8，403）：MEMBER 调 PUT 应被 ensureTeamAdmin 守卫拒绝。
//  - disabled_gateway_rejected（AC10）：status=DISABLED 的网关拒绝 upsert，返回 gateway_disabled。
//  - cross_tenant_invisible：A 团队的 binding 不在 B 团队列表中。
//  - dto_whitelist_strips_unknown：unknown 字段不透传（由全局 ValidationPipe 强制，此处验证 service 显式挑字段）。
//  - audit_metadata_has_no_key（AC12）：upsert 的 auditLog.metadata 不含 apiKey 明文/密文/hint/fingerprint。
//  - decrypt_writes_audit（AC9）：decrypt 调用后审计 action='llm_binding.key_decrypted'，metadata 不含明文。
// 参考 plugin.service.spec.ts：Mock PrismaService + AuthService，不连真实 DB。
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { LlmService } from './llm.service';

const now = new Date('2026-06-14T00:00:00.000Z');

// 测试用 32 字节 hex 密钥（64 位 hex 字符）。getLlmKey 读 process.env.LLM_KEY_ENCRYPTION_KEY。
const TEST_KEY_HEX = 'a'.repeat(64);

// 测试用 AES-256-GCM 合法密文（由 encryptApiKey 在测试中动态生成，避免硬编码）。
function makeEncryptedKey(plain: string): string {
  // 复刻 credential-cipher 的打包格式，但不依赖其实现，保证测试独立。
  // 直接用 crypto 原语，与生产代码一致。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCipheriv, randomBytes } = require('node:crypto') as typeof import('node:crypto');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(TEST_KEY_HEX, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function makeGateway(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'gateway-1',
    provider: 'openai',
    name: 'OpenAI 官方',
    apiUrl: 'https://api.openai.com/v1',
    status: 'ENABLED',
    models: ['gpt-4o', 'gpt-4o-mini'],
    description: '',
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeBinding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'binding-1',
    teamId: 'team-1',
    gatewayId: 'gateway-1',
    provider: 'openai',
    encryptedApiKey: makeEncryptedKey('sk-test-1234567890'),
    apiKeyHint: 'sk-***7890',
    keyFingerprint: 'abcdef0123456789',
    enabled: true,
    modelOverride: null,
    createdById: 'user-admin',
    updatedById: 'user-admin',
    createdAt: now,
    updatedAt: now,
    gateway: makeGateway(), // 解密端点 include: { gateway: { status, provider } }
    ...overrides,
  };
}

interface CreateServiceOptions {
  /** 当前用户在 ensureCurrentTeam/ensureTeamAdmin 返回的角色。 */
  membershipRole?: 'MEMBER' | 'TEAM_ADMIN';
  /** teamId（默认 team-1）。 */
  teamId?: string;
  /** gateway 查询返回（findUnique）。 */
  gateway?: unknown;
  /** 已存在的 binding（findUnique）。 */
  existingBinding?: unknown;
  /** binding 列表（findMany）。 */
  bindings?: unknown[];
}

function createService(options: CreateServiceOptions = {}) {
  const teamId = options.teamId ?? 'team-1';
  const role = options.membershipRole ?? 'TEAM_ADMIN';

  const llmGatewayFindUnique = vi.fn(async () => options.gateway ?? null);
  const tenantLlmBindingFindUnique = vi.fn(async () => options.existingBinding ?? null);
  const tenantLlmBindingFindMany = vi.fn(async () => options.bindings ?? []);
  const tenantLlmBindingUpsert = vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    // 合并 create/update 模拟 upsert 返回（与 Prisma 行为一致）。
    const merged = { ...makeBinding(), ...create, ...update };
    // 把 Prisma.JsonNull 还原成 null，便于断言。
    return {
      ...merged,
      modelOverride: null,
      gateway: options.gateway ?? makeGateway(),
      updatedBy: { id: 'user-admin', displayName: '管理员' },
    };
  });
  const tenantLlmBindingDelete = vi.fn(async () => ({}));
  const auditLogCreate = vi.fn(async () => ({}));
  const prisma = {
    llmGateway: { findUnique: llmGatewayFindUnique, findMany: vi.fn(async () => []) },
    tenantLlmBinding: {
      findUnique: tenantLlmBindingFindUnique,
      findMany: tenantLlmBindingFindMany,
      upsert: tenantLlmBindingUpsert,
      delete: tenantLlmBindingDelete,
    },
    auditLog: { create: auditLogCreate },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const auth = {
    ensureCurrentTeam: vi.fn(async () => ({
      teamId,
      role,
      team: { id: teamId, status: 'ACTIVE' },
    })),
    ensureTeamAdmin: vi.fn(async () => {
      // 复刻 auth.service.ts:140-144：非 TEAM_ADMIN 抛 forbidden（AppError 403）。
      if (role !== 'TEAM_ADMIN') {
        const { forbidden } = await import('../common');
        throw forbidden('仅团队管理员可操作');
      }
      return { teamId, role, team: { id: teamId, status: 'ACTIVE' } };
    }),
    ensurePlatformAdmin: vi.fn(async () => ({ id: 'user-admin', platformRole: 'PLATFORM_ADMIN' })),
  };
  return { service: new LlmService(prisma as never, auth as never), prisma, auth };
}

describe('LlmService', () => {
  beforeAll(() => {
    // 测试需要密钥才能加解密。
    process.env.LLM_KEY_ENCRYPTION_KEY = TEST_KEY_HEX;
  });

  it('AC8: MEMBER 调 upsertBinding 被拒绝（403 forbidden）', async () => {
    const { service } = createService({ membershipRole: 'MEMBER' });

    await expect(
      service.upsertBinding('user-member', { gatewayId: 'gateway-1', apiKey: 'sk-new' }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('AC10: DISABLED 网关拒绝 upsert（gateway_disabled）', async () => {
    const { service } = createService({
      gateway: makeGateway({ status: 'DISABLED' }),
    });

    await expect(
      service.upsertBinding('user-admin', { gatewayId: 'gateway-1', apiKey: 'sk-new' }),
    ).rejects.toMatchObject({ code: 'gateway_disabled', status: 409 });
  });

  it('cross_tenant_invisible: listBindings 仅查当前 team 的 binding', async () => {
    // 模拟 team-2 的成员调 listBindings：service 应按 membership.team.id='team-2' 过滤，
    // 查询条件不应包含 team-1（防跨租户泄漏）。
    const { service, prisma } = createService({
      teamId: 'team-2',
      bindings: [], // team-2 无 binding
    });

    const result = await service.listBindings('user-b');

    expect(result.bindings).toEqual([]);
    // 验证查询用 team-2 而非 team-1（防跨租户泄漏）。
    expect(prisma.tenantLlmBinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: 'team-2' } }),
    );
  });

  it('dto_whitelist_strips_unknown: upsert 不透传未知字段', async () => {
    const gateway = makeGateway();
    const { service, prisma } = createService({ gateway });

    // 模拟客户端偷传 teamId/encryptedApiKey 字段（DTO 未声明，实际由 ValidationPipe 剥离，
    // 但 service 的显式挑字段是第二道防线：测试确认 service 不用这些值）。
    await service.upsertBinding('user-admin', {
      gatewayId: 'gateway-1',
      apiKey: 'sk-newkey',
      // 以下字段 DTO 未声明（ValidationPipe 会剥离），但 TS 类型已禁止，
      // 此处通过 as any 模拟「ValidationPipe 失效」的极端场景，验证 service 显式挑字段。
      ...({ teamId: 'team-evil', encryptedApiKey: 'evil' } as unknown as Record<string, unknown>),
    } as never);

    const upsertCall = (prisma.tenantLlmBinding.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // create 数据必须用 service 计算的 teamId（从 membership），不是客户端偷传的 team-evil。
    expect(upsertCall.create.teamId).toBe('team-1');
    expect(upsertCall.create.encryptedApiKey).not.toBe('evil');
    // encryptedApiKey 应是密文（base64 格式，长度远大于明文 sk-newkey）。
    expect(upsertCall.create.encryptedApiKey).not.toBe('sk-newkey');
    expect(upsertCall.create.encryptedApiKey.length).toBeGreaterThan(20);
  });

  it('AC12: upsert 审计 metadata 永不含 apiKey 明文/密文/hint/fingerprint', async () => {
    const gateway = makeGateway();
    const { service, prisma } = createService({ gateway });

    const plainKey = 'sk-supersecret-1234567890';
    await service.upsertBinding('user-admin', {
      gatewayId: 'gateway-1',
      apiKey: plainKey,
    });

    const auditCall = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const metadata = auditCall.data.metadata as Record<string, unknown>;

    // metadata 必须含 teamId/gatewayId/provider/kind。
    expect(metadata.teamId).toBe('team-1');
    expect(metadata.gatewayId).toBe('gateway-1');
    expect(metadata.provider).toBe('openai');
    expect(metadata.kind).toBe('create'); // 首次绑定
    expect(typeof metadata.enabled).toBe('boolean');

    // metadata 绝不含敏感字段（AC12 核心）。
    const metadataStr = JSON.stringify(metadata);
    expect(metadataStr).not.toContain(plainKey);
    expect(metadataStr).not.toContain('encryptedApiKey');
    expect(metadataStr).not.toContain('apiKeyHint');
    expect(metadataStr).not.toContain('keyFingerprint');
    // 防止 hint（如 sk-***7890）或密文 base64 泄漏。
    expect(metadataStr).not.toContain('***');
  });

  it('AC9: decryptBindingKey 返回明文 + 写审计（metadata 不含明文）', async () => {
    const plainKey = 'sk-decrypt-test-1234567890';
    const gateway = makeGateway();
    const binding = makeBinding({
      encryptedApiKey: makeEncryptedKey(plainKey),
    });
    const { service, prisma } = createService({ gateway, existingBinding: binding });

    const result = await service.decryptBindingKey('user-admin', 'gateway-1');

    expect(result.apiKey).toBe(plainKey);

    // 验证审计写了一条 key_decrypted。
    const auditCall = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditCall.data.action).toBe('llm_binding.key_decrypted');
    expect(auditCall.data.targetType).toBe('TenantLlmBinding');
    expect(auditCall.data.targetId).toBe('binding-1');

    // metadata 不含明文。
    const metadataStr = JSON.stringify(auditCall.data.metadata);
    expect(metadataStr).not.toContain(plainKey);
    expect(metadataStr).not.toContain('apiKeyHint');
    expect(metadataStr).not.toContain('keyFingerprint');
  });
});
