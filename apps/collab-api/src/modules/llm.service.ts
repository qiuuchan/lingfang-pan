// LLM 单 provider 云分发 + 租户绑定服务（v3 定稿）。
//
// 设计契约（见 design.md §3.3 service 改造）：
//  - 应用界面零 provider 概念：getActiveProvider 返回当前启用 provider 的 apiUrl（全表最多一条 isActive=true）。
//  - 平台 provider 目录方法（adminListProviders/adminCreateProvider/adminUpdateProvider/adminDeleteProvider/adminActivateProvider）首行 ensurePlatformAdmin。
//  - 租户方法分两档：
//    · 只读（getActiveProvider/listBindings）用 ensureCurrentTeam，普通成员可见（拿 apiUrl 拉模型/查看脱敏串）。
//    · 写操作（upsertBinding/deleteBinding/decryptBindingKey）用 ensureTeamAdmin，仅 TEAM_ADMIN 可改。
//  - 审计 metadata 固定 shape（无 gatewayId/provider 概念后简化为 {teamId, kind?, enabled?}），**永不记 apiKey 明文/密文/脱敏串/hint/fingerprint**。
//  - PUT/DELETE/decrypt 用 prisma.$transaction 同事务写 binding 操作 + auditLog（原子性）。
//  - GET /binding 零解密：apiKeyHint/keyFingerprint 在 PUT 时计算落库，列表读取不调 decryptApiKey。
//  - apiKey 可选语义：undefined 保留原密（kind=config_only），非空重新加密 + 轮换 hint/fingerprint（kind=key_rotated 或 create）。
//  - adminActivateProvider 用 $transaction 维护唯一 active：先 updateMany 所有 isActive=true → false，再 update 目标 → true。
//  - 所有出参字段 camelCase。
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type TenantLlmBinding, type LlmGateway } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AppError, badRequest } from '../common';
import { AuthService } from './auth.service';
import { decryptApiKey, encryptApiKey, fingerprintApiKey, getLlmKey, maskApiKey } from '../crypto/credential-cipher';
import { LLM_PROVIDER } from './dto/enums';
import type { BindingUpsertDto, ProviderCreateDto, ProviderUpdateDto } from './dto/llm.dto';
import { AppCacheService, CACHE_DEFAULT_TTL_MS, createMemoryCacheStore } from '../cache.service';

/** 当前启用 provider 的内存缓存 TTL（毫秒）。
 *  active-provider 极少变更（仅 adminActivateProvider 切换或 adminCreate/Update/Delete provider 时变），
 *  但被桌面端高频读取（启动拉模型 + 每次 AI 生成可能解密 key 间接依赖 provider 存在性）。
 *  组E 性能：module-level cache + 手动失效（admin 写操作清缓存），TTL 兜底防数据漂移。 */
const ACTIVE_PROVIDER_CACHE_KEY = 'llm:active-provider';
const fallbackActiveProviderCache = new AppCacheService(createMemoryCacheStore());

/** 重置 active-provider 缓存（仅供测试隔离用例间状态）。
 *  生产代码通过 admin 写操作自动失效。导出以让单测在每个用例前清空 module-level 状态。 */
export function resetActiveProviderCache(): void {
  void fallbackActiveProviderCache.delete(ACTIVE_PROVIDER_CACHE_KEY);
}

@Injectable()
export class LlmService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AppCacheService) private readonly cache: AppCacheService = fallbackActiveProviderCache,
  ) {}

  // === 租户：当前启用 provider ===

  /** GET /api/llm/active-provider：返回当前启用 provider 的 apiUrl + defaultModels。
   *  无启用 provider → 404 no_active_provider（应用提示「平台尚未配置模型服务」）。
   *  组E 性能：命中内存缓存直接返回（TTL 内零 DB 查询），过期或被 admin 写操作失效后回源查库。 */
  async getActiveProvider(actorId: string) {
    await this.auth.ensureCurrentTeam(actorId);
    const cached = await this.cache.remember(ACTIVE_PROVIDER_CACHE_KEY, CACHE_DEFAULT_TTL_MS, async () => {
      const provider = await this.prisma.llmGateway.findFirst({
        where: { isActive: true, status: 'ENABLED' },
      });
      if (!provider) return null;
      return {
        name: provider.name,
        apiUrl: provider.apiUrl,
        defaultModels: (provider.models as string[]) ?? [],
      };
    });
    if (!cached) {
      throw new AppError(404, 'no_active_provider', '平台尚未配置模型服务，请联系管理员');
    }
    return cached;
  }

  // === 平台 Admin provider 目录方法 ===

  /** GET /api/admin/llm-providers：含 DISABLED + isActive + 全字段。 */
  async adminListProviders(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const providers = await this.prisma.llmGateway.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { providers: providers.map((p) => this.adminProvider(p)) };
  }

  /** POST /api/admin/llm-providers（isActive 不在此设，通过 activate 端点）。 */
  async adminCreateProvider(actorId: string, dto: ProviderCreateDto) {
    await this.auth.ensurePlatformAdmin(actorId);
    // provider 宽松校验：DTO 为 String，service 在 LLM_PROVIDER 集合内校验（D2 平台管理）。
    // custom 兜底允许自建 provider，避免硬编码枚举限制未来扩展。
    if (!LLM_PROVIDER.includes(dto.provider as (typeof LLM_PROVIDER)[number])) {
      throw badRequest(`provider 不在白名单：${LLM_PROVIDER.join('/')}`);
    }
    const apiUrl = this.normalizeApiUrl(dto.apiUrl);
    const provider = await this.prisma.llmGateway.create({
      data: {
        provider: dto.provider,
        name: dto.name,
        apiUrl,
        models: (dto.models ?? []) as unknown as Prisma.InputJsonValue,
        description: dto.description ?? '',
        sortOrder: dto.sortOrder ?? 0,
        status: dto.status ?? 'ENABLED',
      },
    });
    await this.audit(actorId, 'admin.llm_provider.created', 'LlmGateway', provider.id, {
      provider: provider.provider,
      name: provider.name,
    });
    // 组E 性能：provider 目录变更后失效 active-provider 缓存（虽 create 默认 isActive=false，但 status 可能 ENABLED，
    // 保守失效避免遗漏任何影响 active 查询结果集的改动）。
    await this.cache.delete(ACTIVE_PROVIDER_CACHE_KEY);
    return { provider: this.adminProvider(provider) };
  }

  /** PATCH /api/admin/llm-providers/:id（全可选字段，isActive 不在此改）。 */
  async adminUpdateProvider(actorId: string, id: string, dto: ProviderUpdateDto) {
    await this.auth.ensurePlatformAdmin(actorId);
    const existing = await this.prisma.llmGateway.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new AppError(404, 'provider_not_found', 'provider 不存在');
    if (dto.provider !== undefined && !LLM_PROVIDER.includes(dto.provider as (typeof LLM_PROVIDER)[number])) {
      throw badRequest(`provider 不在白名单：${LLM_PROVIDER.join('/')}`);
    }
    // 显式字段白名单（不依赖拦截器），仅取 DTO 声明字段，避免越权字段透传进 prisma.update。
    // 注意：isActive 不在 update 端点改（只能通过 activate 端点事务维护唯一）。
    const data: Prisma.LlmGatewayUpdateInput = {};
    if (dto.provider !== undefined) data.provider = dto.provider;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.apiUrl !== undefined) data.apiUrl = this.normalizeApiUrl(dto.apiUrl);
    if (dto.models !== undefined) data.models = dto.models as unknown as Prisma.InputJsonValue;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.status !== undefined) data.status = dto.status;
    const provider = await this.prisma.llmGateway.update({ where: { id }, data });
    await this.audit(actorId, 'admin.llm_provider.updated', 'LlmGateway', provider.id, {
      provider: provider.provider,
      name: provider.name,
    });
    // 组E 性能：update 可能改 status（ENABLED↔DISABLED），影响 active-provider 查询的 status 过滤结果，需失效缓存。
    await this.cache.delete(ACTIVE_PROVIDER_CACHE_KEY);
    return { provider: this.adminProvider(provider) };
  }

  /** DELETE /api/admin/llm-providers/:id（active 的拒绝删，提示先切换）。 */
  async adminDeleteProvider(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const existing = await this.prisma.llmGateway.findUnique({ where: { id }, select: { id: true, isActive: true, name: true } });
    if (!existing) throw new AppError(404, 'provider_not_found', 'provider 不存在');
    if (existing.isActive) {
      throw new AppError(
        409,
        'provider_active_not_deletable',
        '该 provider 当前已启用，请先切换到其他 provider',
      );
    }
    await this.prisma.llmGateway.delete({ where: { id } });
    await this.audit(actorId, 'admin.llm_provider.deleted', 'LlmGateway', id, { name: existing.name });
    // 组E 性能：provider 删除后失效 active-provider 缓存（删除的虽是 isActive=false 的，但保守失效确保一致性）。
    await this.cache.delete(ACTIVE_PROVIDER_CACHE_KEY);
    return { ok: true };
  }

  /** PATCH /api/admin/llm-providers/:id/activate：设为当前启用，$transaction 维护唯一 active。
   *  先把所有 isActive=true 置 false，再把目标置 true（同事务原子）。 */
  async adminActivateProvider(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const existing = await this.prisma.llmGateway.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new AppError(404, 'provider_not_found', 'provider 不存在');
    const provider = await this.prisma.$transaction(async (tx) => {
      // 先把所有 isActive=true 置 false（唯一 active 维护），再设目标为 true。
      await tx.llmGateway.updateMany({ where: { isActive: true }, data: { isActive: false } });
      return tx.llmGateway.update({ where: { id }, data: { isActive: true } });
    });
    await this.audit(actorId, 'admin.llm_provider.activated', 'LlmGateway', provider.id, {
      provider: provider.provider,
      name: provider.name,
    });
    // 组E 性能：activate 切换了 isActive 唯一启用项，active-provider 查询结果必然改变，必须失效缓存。
    await this.cache.delete(ACTIVE_PROVIDER_CACHE_KEY);
    return { provider: this.adminProvider(provider) };
  }

  // === 租户绑定方法 ===

  /** GET /api/llm/binding：当前团队的单条绑定，publicBinding 映射，零解密。 */
  async listBindings(actorId: string) {
    const membership = await this.auth.ensureCurrentTeam(actorId);
    const binding = await this.prisma.tenantLlmBinding.findUnique({
      where: { teamId: membership.team.id },
      include: { updatedBy: { select: { id: true, displayName: true } } },
    });
    return { binding: binding ? this.publicBinding(binding) : null };
  }

  /** PUT /api/llm/binding：ensureTeamAdmin，按 teamId upsert，写库即加密 + $transaction + 审计。 */
  async upsertBinding(actorId: string, dto: BindingUpsertDto) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const teamId = membership.team.id;

    const existing = await this.prisma.tenantLlmBinding.findUnique({
      where: { teamId },
    });

    // apiKey 可选语义：undefined=保留原密（config_only）；非空=重新加密轮换（key_rotated/create）。
    const apiKeyProvided = dto.apiKey !== undefined && dto.apiKey !== null && dto.apiKey.length > 0;
    if (!existing && !apiKeyProvided) {
      // undefined 且无 binding：返 binding_not_found（design.md B5），前端按 ErrorCode 引导填表。
      throw new AppError(404, 'binding_not_found', '尚未绑定，首次绑定必须提供 apiKey');
    }

    let kind: 'create' | 'key_rotated' | 'config_only';
    if (!existing) {
      kind = 'create';
    } else if (apiKeyProvided) {
      kind = 'key_rotated';
    } else {
      kind = 'config_only';
    }

    // 计算 apiKey 相关字段（只在 apiKeyProvided 时计算，避免无谓加密）。
    let encryptedApiKey: string | undefined;
    let apiKeyHint: string | undefined;
    let keyFingerprint: string | undefined;
    if (apiKeyProvided) {
      const key = getLlmKey(); // 未配置时抛 llm_key_not_configured（main.ts 启动断言已覆盖生产）
      encryptedApiKey = encryptApiKey(dto.apiKey as string, key);
      apiKeyHint = maskApiKey(dto.apiKey as string);
      keyFingerprint = fingerprintApiKey(dto.apiKey as string);
    }

    // modelOverride：undefined=不改；null=清空选择；string[]=用户选的子集。
    // Prisma 的 NullableJson 字段 null 用 Prisma.JsonNull（非 JS null）。
    const modelOverrideValue =
      dto.modelOverride === undefined
        ? undefined
        : dto.modelOverride === null
          ? Prisma.JsonNull
          : (dto.modelOverride as unknown as Prisma.InputJsonValue);

    // $transaction 原子写 binding + auditLog。upsert 保证 create/update 分支一致。
    const binding = await this.prisma.$transaction(async (tx) => {
      // create 分支：字段补齐默认值；update 分支：仅传需要改的字段。
      const createData: Prisma.TenantLlmBindingUncheckedCreateInput = {
        teamId,
        encryptedApiKey: encryptedApiKey ?? '', // 首次绑定已校验 apiKeyProvided，理论不会到 ''
        apiKeyHint: apiKeyHint ?? '',
        keyFingerprint: keyFingerprint ?? '',
        enabled: dto.enabled ?? true,
        modelOverride: modelOverrideValue ?? Prisma.JsonNull,
        createdById: actorId,
        updatedById: actorId,
      };
      const updateData: Prisma.TenantLlmBindingUncheckedUpdateInput = {
        updatedById: actorId,
        ...(encryptedApiKey !== undefined ? { encryptedApiKey } : {}),
        ...(apiKeyHint !== undefined ? { apiKeyHint } : {}),
        ...(keyFingerprint !== undefined ? { keyFingerprint } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(modelOverrideValue !== undefined ? { modelOverride: modelOverrideValue } : {}),
      };
      const result = await tx.tenantLlmBinding.upsert({
        where: { teamId },
        create: createData,
        update: updateData,
        include: { updatedBy: { select: { id: true, displayName: true } } },
      });
      // 审计 metadata 永远只 {teamId, kind, enabled}，绝不记 key 明文/密文/hint/fingerprint（v3 去 gatewayId/provider 后简化 shape）。
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'llm_binding.upserted',
          targetType: 'TenantLlmBinding',
          targetId: result.id,
          metadata: { teamId, kind, enabled: result.enabled },
        },
      });
      return result;
    });
    return { binding: this.publicBinding(binding) };
  }

  /** DELETE /api/llm/binding：ensureTeamAdmin，$transaction: delete + audit（按 teamId 唯一）。 */
  async deleteBinding(actorId: string) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const teamId = membership.team.id;
    const existing = await this.prisma.tenantLlmBinding.findUnique({
      where: { teamId },
      select: { id: true },
    });
    if (!existing) throw new AppError(404, 'binding_not_found', '尚未绑定');
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantLlmBinding.delete({ where: { id: existing.id } });
      // 审计 metadata 只记 teamId，绝不记 key 相关字段（无 gatewayId/provider 了）。
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'llm_binding.deleted',
          targetType: 'TenantLlmBinding',
          targetId: existing.id,
          metadata: { teamId },
        },
      });
    });
    return { ok: true };
  }

  /** POST /api/llm/binding/decrypt：ensureTeamAdmin，返回明文供桌面 CLI 使用（按 teamId 唯一绑定）。
   *  - 库泄漏 ≠ key 泄漏（库是密文）。
   *  - 明文经 HTTPS 返回给已认证桌面客户端。
   *  - 强审计：每次解密写 llm_binding.key_decrypted（metadata 不含 key）。 */
  async decryptBindingKey(actorId: string) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const teamId = membership.team.id;
    const binding = await this.prisma.tenantLlmBinding.findUnique({
      where: { teamId },
    });
    if (!binding) throw new AppError(404, 'binding_not_found', '尚未绑定');

    const key = getLlmKey();
    const plaintext = decryptApiKey(binding.encryptedApiKey, key);

    await this.prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'llm_binding.key_decrypted',
          targetType: 'TenantLlmBinding',
          targetId: binding.id,
          metadata: { teamId },
        },
      });
    });

    return { apiKey: plaintext };
  }

  // === 辅助方法 ===

  /** 平台 Admin 视角的 provider 全字段出参（含 status/isActive）。 */
  private adminProvider(p: LlmGateway) {
    return {
      id: p.id,
      provider: p.provider,
      name: p.name,
      apiUrl: p.apiUrl,
      status: p.status,
      models: (p.models as string[]) ?? [],
      description: p.description,
      sortOrder: p.sortOrder,
      isActive: p.isActive,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  /** 租户绑定出参：显式挑字段白名单（不依赖拦截器），零解密。无 gatewayId/provider 概念（v3 定稿）。 */
  private publicBinding(b: TenantLlmBinding & { updatedBy?: { id: string; displayName: string } | null }) {
    const modelOverride =
      b.modelOverride === null || b.modelOverride === undefined ? null : (b.modelOverride as string[]);
    return {
      id: b.id,
      apiKeyHint: b.apiKeyHint, // 脱敏串（非敏感，明文存库）
      keyFingerprint: b.keyFingerprint, // sha256 前 16 位（非敏感，明文存库）
      enabled: b.enabled,
      modelOverride,
      updatedBy: b.updatedBy ?? null,
      updatedAt: b.updatedAt.toISOString(),
    };
  }

  /** 规范化 apiUrl：去尾斜杠（保留协议前的 //）。 */
  private normalizeApiUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}
