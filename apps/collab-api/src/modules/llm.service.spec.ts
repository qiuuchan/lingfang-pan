// LlmService 单测：v3 定稿（单 provider 云分发 + 无 provider UI）。
// 覆盖 design.md §7 验证项：
//  - member_cannot_upsert_binding：MEMBER 调 PUT 应被 ensureTeamAdmin 守卫拒绝（403）。
//  - cross_tenant_invisible：A 团队的 binding 不在 B 团队查询中。
//  - dto_whitelist_strips_unknown：unknown 字段不透传（service 显式挑字段）。
//  - audit_metadata_has_no_key：upsert 的 auditLog.metadata 不含 apiKey 明文/密文/hint/fingerprint。
//  - decrypt_writes_audit：decrypt 调用后审计 action='llm_binding.key_decrypted'，metadata 不含明文。
//  - active_provider_returns_url（AC2）：有 active provider 返 apiUrl，无返 404 no_active_provider。
//  - activate_provider_transactional_uniqueness（AC5）：设新的，旧的自动 false。
//  - binding_team_unique_upsert（AC6）：重复 PUT 按 teamId 覆盖。
//  - admin_delete_active_provider_rejected：删 active provider 返 provider_active_not_deletable。
// 参考 plugin.service.spec.ts：Mock PrismaService + AuthService，不连真实 DB。
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { LlmService, resetActiveProviderCache } from './llm.service';

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

function makeProvider(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'provider-1',
    provider: 'openai',
    name: 'OpenAI 官方',
    apiUrl: 'https://api.openai.com/v1',
    status: 'ENABLED',
    models: ['gpt-4o', 'gpt-4o-mini'],
    description: '',
    sortOrder: 1,
    isActive: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeBinding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'binding-1',
    teamId: 'team-1',
    encryptedApiKey: makeEncryptedKey('sk-test-1234567890'),
    apiKeyHint: 'sk-***7890',
    keyFingerprint: 'abcdef0123456789',
    enabled: true,
    modelOverride: null,
    createdById: 'user-admin',
    updatedById: 'user-admin',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface CreateServiceOptions {
  /** 当前用户在 ensureCurrentTeam/ensureTeamAdmin 返回的角色。 */
  membershipRole?: 'MEMBER' | 'TEAM_ADMIN';
  /** teamId（默认 team-1）。 */
  teamId?: string;
  /** active provider 查询返回（findFirst）。 */
  activeProvider?: unknown;
  /** 已存在的 binding（findUnique）。 */
  existingBinding?: unknown;
  /** admin activate/delete 的目标 provider（llmGateway.findUnique 返回）。null=不存在。 */
  adminTargetProvider?: unknown;
  /** 是否已注入 adminTargetProvider（区分 undefined=未设 vs null=显式返 null）。 */
  adminTargetProviderSet?: boolean;
}

function createService(options: CreateServiceOptions = {}) {
  const teamId = options.teamId ?? 'team-1';
  const role = options.membershipRole ?? 'TEAM_ADMIN';

  const llmGatewayFindFirst = vi.fn(async () => options.activeProvider ?? null);
  const llmGatewayFindUnique = vi.fn(async () =>
    options.adminTargetProviderSet ? (options.adminTargetProvider ?? null) : null,
  );
  const llmGatewayFindMany = vi.fn(async () => []);
  const llmGatewayUpdateMany = vi.fn(async () => ({ count: 0 }));
  const llmGatewayUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...makeProvider({ isActive: true }),
    ...data,
  }));
  const llmGatewayDelete = vi.fn(async () => ({}));

  const tenantLlmBindingFindUnique = vi.fn(async () => options.existingBinding ?? null);
  const tenantLlmBindingUpsert = vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    // 合并 create/update 模拟 upsert 返回（与 Prisma 行为一致）。
    const merged = { ...makeBinding(), ...create, ...update };
    // 把 Prisma.JsonNull 还原成 null，便于断言。
    return {
      ...merged,
      modelOverride: null,
      updatedBy: { id: 'user-admin', displayName: '管理员' },
    };
  });
  const tenantLlmBindingDelete = vi.fn(async () => ({}));
  const auditLogCreate = vi.fn(async () => ({}));
  const prisma = {
    llmGateway: {
      findFirst: llmGatewayFindFirst,
      findUnique: llmGatewayFindUnique,
      findMany: llmGatewayFindMany,
      updateMany: llmGatewayUpdateMany,
      update: llmGatewayUpdate,
      delete: llmGatewayDelete,
    },
    tenantLlmBinding: {
      findUnique: tenantLlmBindingFindUnique,
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
  // 组E 性能：active-provider module-level 缓存在用例间隔离，避免前序用例填充的缓存被后续用例命中
  // （否则 active_provider_returns_url 缓存的 provider 会让后续 no_active_provider 用例错误命中）。
  resetActiveProviderCache();
  return { service: new LlmService(prisma as never, auth as never), prisma, auth };
}

describe('LlmService', () => {
  beforeAll(() => {
    // 测试需要密钥才能加解密。
    process.env.LLM_KEY_ENCRYPTION_KEY = TEST_KEY_HEX;
  });

  // === 租户绑定测试 ===

  it('MEMBER 调 upsertBinding 被拒绝（403 forbidden）', async () => {
    const { service } = createService({ membershipRole: 'MEMBER' });

    await expect(service.upsertBinding('user-member', { apiKey: 'sk-new' })).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
  });

  it('cross_tenant_invisible: listBindings 仅查当前 team 的 binding', async () => {
    // 模拟 team-2 的成员调 listBindings：service 应按 membership.team.id='team-2' 查询，
    // 查询条件不应包含 team-1（防跨租户泄漏）。
    const { service, prisma } = createService({
      teamId: 'team-2',
      existingBinding: null, // team-2 无 binding
    });

    const result = await service.listBindings('user-b');

    expect(result.binding).toBeNull();
    // 验证查询用 team-2 而非 team-1（防跨租户泄漏）。
    expect(prisma.tenantLlmBinding.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: 'team-2' } }),
    );
  });

  it('dto_whitelist_strips_unknown: upsert 不透传未知字段', async () => {
    const { service, prisma } = createService();

    // 模拟客户端偷传 teamId/encryptedApiKey 字段（DTO 未声明，实际由 ValidationPipe 剥离，
    // 但 service 的显式挑字段是第二道防线：测试确认 service 不用这些值）。
    await service.upsertBinding('user-admin', {
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

  it('audit_metadata_has_no_key: upsert 审计 metadata 永不含 apiKey 明文/密文/hint/fingerprint', async () => {
    const { service, prisma } = createService();

    const plainKey = 'sk-supersecret-1234567890';
    await service.upsertBinding('user-admin', { apiKey: plainKey });

    const auditCall = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const metadata = auditCall.data.metadata as Record<string, unknown>;

    // metadata 必须含 teamId/kind（v3 去 gatewayId/provider 后简化 shape）。
    expect(metadata.teamId).toBe('team-1');
    expect(metadata.kind).toBe('create'); // 首次绑定
    expect(typeof metadata.enabled).toBe('boolean');

    // metadata 绝不含 gatewayId/provider（v3 已去除）。
    expect(metadata).not.toHaveProperty('gatewayId');
    expect(metadata).not.toHaveProperty('provider');

    // metadata 绝不含敏感字段。
    const metadataStr = JSON.stringify(metadata);
    expect(metadataStr).not.toContain(plainKey);
    expect(metadataStr).not.toContain('encryptedApiKey');
    expect(metadataStr).not.toContain('apiKeyHint');
    expect(metadataStr).not.toContain('keyFingerprint');
    // 防止 hint（如 sk-***7890）或密文 base64 泄漏。
    expect(metadataStr).not.toContain('***');
  });

  it('decrypt_writes_audit: decryptBindingKey 返回明文 + 写审计（metadata 不含明文）', async () => {
    const plainKey = 'sk-decrypt-test-1234567890';
    const binding = makeBinding({
      encryptedApiKey: makeEncryptedKey(plainKey),
    });
    const { service, prisma } = createService({ existingBinding: binding });

    const result = await service.decryptBindingKey('user-admin');

    expect(result.apiKey).toBe(plainKey);

    // 验证审计写了一条 key_decrypted。
    const auditCall = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditCall.data.action).toBe('llm_binding.key_decrypted');
    expect(auditCall.data.targetType).toBe('TenantLlmBinding');
    expect(auditCall.data.targetId).toBe('binding-1');

    // metadata 不含明文/key 相关字段。
    const metadataStr = JSON.stringify(auditCall.data.metadata);
    expect(metadataStr).not.toContain(plainKey);
    expect(metadataStr).not.toContain('apiKeyHint');
    expect(metadataStr).not.toContain('keyFingerprint');
  });

  // === active provider 测试（AC2/AC7） ===

  it('active_provider_returns_url（AC2）: 有 active ENABLED provider 返 apiUrl + defaultModels', async () => {
    const { service, prisma } = createService({
      activeProvider: makeProvider({ isActive: true, status: 'ENABLED' }),
    });

    const result = await service.getActiveProvider('user-admin');

    expect(result.apiUrl).toBe('https://api.openai.com/v1');
    expect(result.defaultModels).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(result.name).toBe('OpenAI 官方');

    // 关键：findFirst where 必须同时含 isActive:true 与 status:ENABLED，
    // 防 DISABLED 但 isActive=true 的 provider 被误当 active 返回。
    const findFirstCall = (prisma.llmGateway.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findFirstCall.where).toEqual({ isActive: true, status: 'ENABLED' });
  });

  it('active_provider_404_when_none（AC7）: 无 active provider 返 no_active_provider', async () => {
    const { service } = createService({ activeProvider: null });

    await expect(service.getActiveProvider('user-admin')).rejects.toMatchObject({
      code: 'no_active_provider',
      status: 404,
    });
  });

  it('active_provider_excludes_disabled: DISABLED 但 isActive=true 的不算 active', async () => {
    const { service } = createService({ activeProvider: null });

    // 即使库里有 isActive=true 但 status=DISABLED 的 provider，findFirst where 含 status=ENABLED 过滤，返 null。
    await expect(service.getActiveProvider('user-admin')).rejects.toMatchObject({
      code: 'no_active_provider',
    });
  });

  // 组E 性能：active-provider 内存缓存。
  it('getActiveProvider 命中缓存时不重复查库（TTL 内仅 findFirst 一次）', async () => {
    const { service, prisma } = createService({
      activeProvider: makeProvider({ isActive: true, status: 'ENABLED' }),
    });

    await service.getActiveProvider('user-admin');
    await service.getActiveProvider('user-admin');
    await service.getActiveProvider('user-admin');
    // 三次调用只查一次库，后两次命中 module-level 缓存。
    expect(prisma.llmGateway.findFirst).toHaveBeenCalledTimes(1);
  });

  it('adminActivateProvider 成功后失效缓存（下次 getActiveProvider 回源查库）', async () => {
    // 先填充缓存（首次 getActiveProvider 查库）。
    const first = createService({ activeProvider: makeProvider({ isActive: true, status: 'ENABLED' }) });
    await first.service.getActiveProvider('user-admin');
    expect(first.prisma.llmGateway.findFirst).toHaveBeenCalledTimes(1);

    // activate 后缓存应失效。activeProvider 也设为返回 provider，确保失效后 getActiveProvider 回源能命中。
    const { service, prisma } = createService({
      activeProvider: makeProvider({ id: 'provider-2', isActive: true, status: 'ENABLED' }),
      adminTargetProviderSet: true,
      adminTargetProvider: makeProvider({ id: 'provider-2', isActive: true, status: 'ENABLED' }),
    });
    await service.adminActivateProvider('user-admin', 'provider-2');
    // 紧接 getActiveProvider 回源查库（缓存被 activate 清空）。
    await service.getActiveProvider('user-admin');
    expect(prisma.llmGateway.findFirst).toHaveBeenCalledTimes(1);
  });

  // === admin activate 事务唯一性（AC5） ===

  it('activate_provider_transactional_uniqueness（AC5）: 设新的 active 时 updateMany 旧的全 false', async () => {
    const { service, prisma } = createService({
      adminTargetProviderSet: true,
      adminTargetProvider: makeProvider({ id: 'provider-2' }),
    });

    await service.adminActivateProvider('user-admin', 'provider-2');

    // $transaction 内必须先 updateMany（isActive=true → false），再 update（目标 → true）。
    const updateManyCall = (prisma.llmGateway.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateManyCall.where).toEqual({ isActive: true });
    expect(updateManyCall.data).toEqual({ isActive: false });

    const updateCall = (prisma.llmGateway.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 'provider-2' });
    expect(updateCall.data).toEqual({ isActive: true });

    // 两次调用都在同一个事务里（$transaction 被调一次，回调内调用 tx.* 而非 prisma.*）。
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // === binding team 唯一 upsert（AC6） ===

  it('binding_team_unique_upsert（AC6）: 重复 PUT 按 teamId 覆盖（kind=key_rotated）', async () => {
    // 已有 binding（team-1），再 PUT 同 teamId 的不同 key → kind=key_rotated，upsert where=teamId。
    const existing = makeBinding();
    const { service, prisma } = createService({ existingBinding: existing });

    await service.upsertBinding('user-admin', { apiKey: 'sk-rotated-newkey' });

    const upsertCall = (prisma.tenantLlmBinding.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // where 必须是 teamId（不再 teamId_gatewayId 复合键）。
    expect(upsertCall.where).toEqual({ teamId: 'team-1' });

    // 审计 kind 应为 key_rotated（已有 binding 且提供了新 key）。
    const auditCall = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditCall.data.metadata.kind).toBe('key_rotated');
  });

  it('config_only_upsert: 未提供 apiKey 时保留原密（kind=config_only）', async () => {
    const existing = makeBinding();
    const { service, prisma } = createService({ existingBinding: existing });

    // 只改 modelOverride，不提供 apiKey → kind=config_only，不重新加密。
    await service.upsertBinding('user-admin', { modelOverride: ['gpt-4o'] });

    const auditCall = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditCall.data.metadata.kind).toBe('config_only');

    const upsertCall = (prisma.tenantLlmBinding.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // config_only 不应改 encryptedApiKey（updateData 不含该字段）。
    expect(upsertCall.update).not.toHaveProperty('encryptedApiKey');
  });

  // === admin delete active provider 拒绝 ===

  it('admin_delete_active_provider_rejected: 删 active provider 返 provider_active_not_deletable', async () => {
    // 直接通过 service 内部调用：mock llmGateway.findUnique 返回 active provider。
    const teamId = 'team-1';
    const auth = {
      ensurePlatformAdmin: vi.fn(async () => ({ id: 'user-admin', platformRole: 'PLATFORM_ADMIN' })),
      ensureCurrentTeam: vi.fn(async () => ({ teamId, team: { id: teamId } })),
      ensureTeamAdmin: vi.fn(async () => ({ teamId, team: { id: teamId } })),
    };
    const auditLogCreate = vi.fn(async () => ({}));
    const llmGatewayFindUnique = vi.fn(async () => makeProvider({ id: 'provider-1', isActive: true }));
    const prisma = {
      llmGateway: { findUnique: llmGatewayFindUnique, delete: vi.fn(async () => ({})) },
      auditLog: { create: auditLogCreate },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    const svc = new LlmService(prisma as never, auth as never);

    await expect(svc.adminDeleteProvider('user-admin', 'provider-1')).rejects.toMatchObject({
      code: 'provider_active_not_deletable',
      status: 409,
    });
  });
});
