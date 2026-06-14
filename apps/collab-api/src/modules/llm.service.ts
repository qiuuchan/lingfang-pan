// LLM 网关目录 + 租户绑定服务。
//
// 设计契约（见 design.md §4.3 鉴权 + §4.4 审计）：
//  - 平台网关目录方法（adminListGateways/adminCreateGateway/adminUpdateGateway/adminSetGatewayStatus）首行 ensurePlatformAdmin。
//  - 租户方法分两档：
//    · 只读（listGatewaysForTenant/listBindings）用 ensureCurrentTeam，普通成员可见（用于选择/查看脱敏串）。
//    · 写操作（upsertBinding/deleteBinding/decryptBindingKey）用 ensureTeamAdmin，仅 TEAM_ADMIN 可改。
//  - 无物理 DELETE（B8）：网关目录仅 PATCH status=DISABLED 软删除；binding 上 gateway onDelete: Restrict，禁用网关不删绑定（只读保留）。
//  - 审计 metadata 固定 shape `{teamId, gatewayId, provider, kind?, enabled?}`，**永不记 apiKey 明文/密文/脱敏串/hint/fingerprint**（AC12）。
//  - PUT/DELETE/decrypt 用 prisma.$transaction 同事务写 binding 操作 + auditLog（B9 原子性）。
//  - GET /binding 零解密（B12）：apiKeyHint/keyFingerprint 在 PUT 时计算落库，列表读取不调 decryptApiKey。
//  - effectiveModels = modelOverride ?? gatewayModels（B23）：null/undefined 继承网关清单，string[] 为子集覆盖。
//  - apiKey 可选语义（B5）：undefined 保留原密（kind=config_only），非空重新加密 + 轮换 hint/fingerprint（kind=key_rotated 或 create）。
//  - 所有出参字段 camelCase（B11）。
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type TenantLlmBinding, type LlmGateway } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { badRequest, AppError, notFound } from '../common';
import { AuthService } from './auth.service';
import { decryptApiKey, encryptApiKey, fingerprintApiKey, getLlmKey, maskApiKey } from '../crypto/credential-cipher';
import { LLM_PROVIDER } from './dto/enums';
import type { BindingUpsertDto, GatewayCreateDto, GatewayUpdateDto } from './dto/llm.dto';

@Injectable()
export class LlmService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  // === 平台 Admin 网关目录方法 ===

  /** GET /api/admin/llm-gateways：含 DISABLED + 全字段。 */
  async adminListGateways(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const gateways = await this.prisma.llmGateway.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { gateways: gateways.map((g) => this.adminGateway(g)) };
  }

  /** POST /api/admin/llm-gateways。 */
  async adminCreateGateway(actorId: string, dto: GatewayCreateDto) {
    await this.auth.ensurePlatformAdmin(actorId);
    // provider 宽松校验：DTO 为 String，service 在 LLM_PROVIDER 集合内校验（D2 平台管理）。
    // custom 兜底允许自建网关，避免硬编码枚举限制未来扩展。
    if (!LLM_PROVIDER.includes(dto.provider as (typeof LLM_PROVIDER)[number])) {
      throw badRequest(`provider 不在白名单：${LLM_PROVIDER.join('/')}`);
    }
    const apiUrl = this.normalizeApiUrl(dto.apiUrl);
    const gateway = await this.prisma.llmGateway.create({
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
    await this.audit(actorId, 'admin.llm_gateway.created', 'LlmGateway', gateway.id, {
      provider: gateway.provider,
      name: gateway.name,
    });
    return { gateway: this.adminGateway(gateway) };
  }

  /** PATCH /api/admin/llm-gateways/:id（全可选字段）。 */
  async adminUpdateGateway(actorId: string, id: string, dto: GatewayUpdateDto) {
    await this.auth.ensurePlatformAdmin(actorId);
    const existing = await this.prisma.llmGateway.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw notFound('网关不存在');
    if (dto.provider !== undefined && !LLM_PROVIDER.includes(dto.provider as (typeof LLM_PROVIDER)[number])) {
      throw badRequest(`provider 不在白名单：${LLM_PROVIDER.join('/')}`);
    }
    // 显式字段白名单（不依赖拦截器），仅取 DTO 声明字段，避免越权字段透传进 prisma.update。
    const data: Prisma.LlmGatewayUpdateInput = {};
    if (dto.provider !== undefined) data.provider = dto.provider;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.apiUrl !== undefined) data.apiUrl = this.normalizeApiUrl(dto.apiUrl);
    if (dto.models !== undefined) data.models = dto.models as unknown as Prisma.InputJsonValue;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    // status 在此端点也可改（与 PATCH /:id/status 不同路径但允许，单端点便利）。
    if (dto.status !== undefined) data.status = dto.status;
    const gateway = await this.prisma.llmGateway.update({ where: { id }, data });
    await this.audit(actorId, 'admin.llm_gateway.updated', 'LlmGateway', gateway.id, {
      provider: gateway.provider,
      name: gateway.name,
    });
    return { gateway: this.adminGateway(gateway) };
  }

  /** PATCH /api/admin/llm-gateways/:id/status（软删除，无物理 DELETE，B8）。 */
  async adminSetGatewayStatus(actorId: string, id: string, status: 'ENABLED' | 'DISABLED') {
    await this.auth.ensurePlatformAdmin(actorId);
    const existing = await this.prisma.llmGateway.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw notFound('网关不存在');
    const gateway = await this.prisma.llmGateway.update({ where: { id }, data: { status } });
    await this.audit(actorId, 'admin.llm_gateway.disabled', 'LlmGateway', gateway.id, {
      provider: gateway.provider,
      name: gateway.name,
      status,
    });
    return { gateway: this.adminGateway(gateway) };
  }

  // === 租户方法 ===

  /** GET /api/llm/gateways：仅 ENABLED，无任何 key（租户选择用）。 */
  async listGatewaysForTenant(actorId: string) {
    const membership = await this.auth.ensureCurrentTeam(actorId);
    void membership; // 仅鉴权，teamId 不参与过滤（网关目录是平台级公开的）
    const gateways = await this.prisma.llmGateway.findMany({
      where: { status: 'ENABLED' },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { gateways: gateways.map((g) => this.publicGateway(g)) };
  }

  /** GET /api/llm/binding：当前团队的绑定列表，publicBinding 映射，零解密（B12）。 */
  async listBindings(actorId: string) {
    const membership = await this.auth.ensureCurrentTeam(actorId);
    const bindings = await this.prisma.tenantLlmBinding.findMany({
      where: { teamId: membership.team.id },
      include: {
        gateway: true,
        updatedBy: { select: { id: true, displayName: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return { bindings: bindings.map((b) => this.publicBinding(b, b.gateway)) };
  }

  /** PUT /api/llm/binding：ensureTeamAdmin，写库即加密 + $transaction + 审计（B9）。 */
  async upsertBinding(actorId: string, dto: BindingUpsertDto) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const teamId = membership.team.id;
    // 校验网关存在且 ENABLED（DISABLED 拒绝 upsert，gateway_disabled，AC10）。
    const gateway = await this.prisma.llmGateway.findUnique({ where: { id: dto.gatewayId } });
    if (!gateway) throw notFound('网关不存在');
    if (gateway.status !== 'ENABLED') throw new AppError(409, 'gateway_disabled', '该网关已被禁用，无法绑定');

    const existing = await this.prisma.tenantLlmBinding.findUnique({
      where: { teamId_gatewayId: { teamId, gatewayId: dto.gatewayId } },
    });

    // apiKey 可选语义（B5）：undefined=保留原密（config_only）；非空=重新加密轮换（key_rotated/create）。
    const apiKeyProvided = dto.apiKey !== undefined && dto.apiKey !== null && dto.apiKey.length > 0;
    if (!existing && !apiKeyProvided) {
      // undefined 且无 binding：返 binding_not_found（design.md B5），前端按 ErrorCode 引导填表。
      throw new AppError(404, 'binding_not_found', '未绑定该网关，首次绑定必须提供 apiKey');
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

    // modelOverride：undefined=不改（仅 create 分支需要从 undefined → null）；null=继承 gateway.models；string[]=子集。
    // Prisma 的 NullableJson 字段 null 用 Prisma.JsonNull（非 JS null）。
    const modelOverrideValue =
      dto.modelOverride === undefined
        ? undefined
        : dto.modelOverride === null
          ? Prisma.JsonNull
          : (dto.modelOverride as unknown as Prisma.InputJsonValue);

    // $transaction 原子写 binding + auditLog（B9）。upsert 保证 create/update 分支一致。
    const binding = await this.prisma.$transaction(async (tx) => {
      // create 分支：字段补齐默认值；update 分支：仅传需要改的字段。
      const createData: Prisma.TenantLlmBindingUncheckedCreateInput = {
        teamId,
        gatewayId: dto.gatewayId,
        provider: gateway.provider,
        encryptedApiKey: encryptedApiKey ?? '', // 首次绑定已校验 apiKeyProvided，理论不会到 ''
        apiKeyHint: apiKeyHint ?? '',
        keyFingerprint: keyFingerprint ?? '',
        enabled: dto.enabled ?? true,
        modelOverride: modelOverrideValue ?? Prisma.JsonNull,
        createdById: actorId,
        updatedById: actorId,
      };
      const updateData: Prisma.TenantLlmBindingUncheckedUpdateInput = {
        provider: gateway.provider,
        updatedById: actorId,
        ...(encryptedApiKey !== undefined ? { encryptedApiKey } : {}),
        ...(apiKeyHint !== undefined ? { apiKeyHint } : {}),
        ...(keyFingerprint !== undefined ? { keyFingerprint } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(modelOverrideValue !== undefined ? { modelOverride: modelOverrideValue } : {}),
      };
      const result = await tx.tenantLlmBinding.upsert({
        where: { teamId_gatewayId: { teamId, gatewayId: dto.gatewayId } },
        create: createData,
        update: updateData,
        include: { gateway: true, updatedBy: { select: { id: true, displayName: true } } },
      });
      // 审计 metadata 永远只 {teamId, gatewayId, provider, kind, enabled}，绝不记 key 明文/密文/hint/fingerprint（AC12）。
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'llm_binding.upserted',
          targetType: 'TenantLlmBinding',
          targetId: result.id,
          metadata: { teamId, gatewayId: dto.gatewayId, provider: gateway.provider, kind, enabled: result.enabled },
        },
      });
      return result;
    });
    return { binding: this.publicBinding(binding, binding.gateway) };
  }

  /** DELETE /api/llm/binding/:gatewayId：ensureTeamAdmin，$transaction: delete + audit。 */
  async deleteBinding(actorId: string, gatewayId: string) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const teamId = membership.team.id;
    const existing = await this.prisma.tenantLlmBinding.findUnique({
      where: { teamId_gatewayId: { teamId, gatewayId } },
      include: { gateway: { select: { provider: true } } },
    });
    if (!existing) throw new AppError(404, 'binding_not_found', '未绑定该网关');
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantLlmBinding.delete({ where: { id: existing.id } });
      // 审计 metadata 只记 teamId/gatewayId/provider，绝不记 key 相关字段。
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'llm_binding.deleted',
          targetType: 'TenantLlmBinding',
          targetId: existing.id,
          metadata: { teamId, gatewayId, provider: existing.gateway.provider },
        },
      });
    });
    return { ok: true };
  }

  /** POST /api/llm/binding/:gatewayId/decrypt：ensureTeamAdmin，返回明文供桌面 CLI 使用（D1）。
   *  - 库泄漏 ≠ key 泄漏（库是密文）。
   *  - 明文经 HTTPS 返回给已认证桌面客户端。
   *  - 强审计：每次解密写 llm_binding.key_decrypted（metadata 不含 key）。 */
  async decryptBindingKey(actorId: string, gatewayId: string) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const teamId = membership.team.id;
    const binding = await this.prisma.tenantLlmBinding.findUnique({
      where: { teamId_gatewayId: { teamId, gatewayId } },
      include: { gateway: { select: { provider: true, status: true } } },
    });
    if (!binding) throw new AppError(404, 'binding_not_found', '未绑定该网关');
    if (binding.gateway.status !== 'ENABLED') throw new AppError(409, 'gateway_disabled', '该网关已被禁用');

    const key = getLlmKey();
    const plaintext = decryptApiKey(binding.encryptedApiKey, key);

    await this.prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'llm_binding.key_decrypted',
          targetType: 'TenantLlmBinding',
          targetId: binding.id,
          metadata: { teamId, gatewayId, provider: binding.gateway.provider },
        },
      });
    });

    return { apiKey: plaintext };
  }

  // === 辅助方法 ===

  /** 平台 Admin 视角的网关全字段出参（含 status/disabled 字段）。 */
  private adminGateway(g: LlmGateway) {
    return {
      id: g.id,
      provider: g.provider,
      name: g.name,
      apiUrl: g.apiUrl,
      status: g.status,
      models: (g.models as string[]) ?? [],
      description: g.description,
      sortOrder: g.sortOrder,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    };
  }

  /** 租户视角的网关出参（仅 ENABLED 字段 + 公开字段，无 status）。 */
  private publicGateway(g: LlmGateway) {
    return {
      id: g.id,
      provider: g.provider,
      name: g.name,
      apiUrl: g.apiUrl,
      models: (g.models as string[]) ?? [],
      description: g.description,
      sortOrder: g.sortOrder,
    };
  }

  /** 租户绑定出参：显式挑字段白名单（不依赖拦截器），零解密（B12）。
   *  effectiveModels = modelOverride ?? gatewayModels（B23）。 */
  private publicBinding(
    b: TenantLlmBinding & { gateway: LlmGateway; updatedBy?: { id: string; displayName: string } | null },
    gateway: LlmGateway,
  ) {
    const gatewayModels = (gateway.models as string[]) ?? [];
    const modelOverride = b.modelOverride === null || b.modelOverride === undefined ? null : (b.modelOverride as string[]);
    const effectiveModels = modelOverride ?? gatewayModels;
    return {
      id: b.id,
      gatewayId: b.gatewayId,
      provider: b.provider,
      gatewayName: gateway.name,
      apiUrl: gateway.apiUrl,
      gatewayStatus: gateway.status,
      enabled: b.enabled,
      apiKeyHint: b.apiKeyHint, // 脱敏串（非敏感，明文存库）
      keyFingerprint: b.keyFingerprint, // sha256 前 16 位（非敏感，明文存库）
      gatewayModels,
      modelOverride,
      effectiveModels,
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
