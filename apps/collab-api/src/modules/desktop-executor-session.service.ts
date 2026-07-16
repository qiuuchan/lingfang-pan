import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, forbidden, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';

const SESSION_TTL_MS = 15 * 60 * 1000;
const HEARTBEAT_FRESHNESS_MS = 45 * 1000;
const MAX_INVENTORY_ITEMS = 512;
const INVENTORY_SCHEMA_VERSION = '1';

export type InventoryItem = {
  installation_id: string;
  package_id: string;
  release_id: string;
  sha256: string;
  dependency_status: 'pending' | 'preparing' | 'ready' | 'failed';
};

type SessionRow = {
  id: string;
  teamId: string;
  userId: string;
  deviceId: string;
  inventorySchemaVersion: string;
  inventorySha256: string;
  inventory: Prisma.JsonValue;
  tokenSha256: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  expiresAt: Date;
  lastHeartbeatAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function equalDigest(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'workflow_executor_session_invalid', '桌面执行器清单条目无效');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AppError(400, 'workflow_executor_session_invalid', `桌面执行器清单字段 ${field} 无效`);
  }
  return value.trim();
}

function parseInventory(raw: unknown): InventoryItem[] {
  if (!Array.isArray(raw) || raw.length > MAX_INVENTORY_ITEMS) {
    throw new AppError(400, 'workflow_executor_session_invalid', '桌面执行器清单无效');
  }
  const installations = new Set<string>();
  const packages = new Set<string>();
  const items = raw.map((entry) => {
    const item = asObject(entry);
    const installationId = text(item.installation_id, 'installation_id');
    const packageId = text(item.package_id, 'package_id');
    const releaseId = text(item.release_id, 'release_id');
    const sha256 = text(item.sha256, 'sha256', 64).toLowerCase();
    const dependencyStatus = item.dependency_status;
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new AppError(400, 'workflow_executor_session_invalid', '桌面执行器清单 sha256 无效');
    }
    if (!['pending', 'preparing', 'ready', 'failed'].includes(String(dependencyStatus))) {
      throw new AppError(400, 'workflow_executor_session_invalid', '桌面执行器依赖状态无效');
    }
    if (installations.has(installationId)) {
      throw new AppError(409, 'workflow_installation_mismatch', '桌面执行器清单包含重复 installation_id');
    }
    if (packages.has(packageId)) {
      throw new AppError(409, 'workflow_installation_mismatch', '桌面执行器清单包含重复 package_id');
    }
    installations.add(installationId);
    packages.add(packageId);
    return {
      installation_id: installationId,
      package_id: packageId,
      release_id: releaseId,
      sha256,
      dependency_status: dependencyStatus as InventoryItem['dependency_status'],
    };
  });
  return items.sort((a, b) => a.installation_id.localeCompare(b.installation_id)
    || a.package_id.localeCompare(b.package_id)
    || a.release_id.localeCompare(b.release_id));
}

function inventoryDigest(items: InventoryItem[]): string {
  return digest(JSON.stringify(items));
}

@Injectable()
export class DesktopExecutorSessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async create(userId: string, deviceId: string, rawInventory: unknown) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const normalizedDeviceId = text(deviceId, 'device_id');
    const inventory = parseInventory(rawInventory);
    await this.assertExactReleases(membership.teamId, inventory);
    const inventorySha256 = inventoryDigest(inventory);
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const session = await this.prisma.desktopExecutorSession.create({
      data: {
        teamId: membership.teamId,
        userId,
        deviceId: normalizedDeviceId,
        inventorySchemaVersion: INVENTORY_SCHEMA_VERSION,
        inventorySha256,
        inventory: inventory as unknown as Prisma.InputJsonValue,
        tokenSha256: digest(token),
        expiresAt,
        lastHeartbeatAt: now,
      },
    });
    return { session: this.publicSession(session as SessionRow), token };
  }

  async heartbeat(userId: string, id: string, token: string, rawInventory: unknown) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const session = await this.findAuthenticated(membership.teamId, userId, id, token);
    const inventory = parseInventory(rawInventory);
    await this.assertExactReleases(membership.teamId, inventory);
    const inventorySha256 = inventoryDigest(inventory);
    const now = new Date();
    if (session.inventorySchemaVersion !== INVENTORY_SCHEMA_VERSION || !equalDigest(session.inventorySha256, inventorySha256)) {
      await this.revokeInternal(id, membership.teamId, userId, 'inventory_changed');
      throw new AppError(409, 'workflow_inventory_changed', '桌面安装清单已变化，执行器 session 已撤销');
    }
    if (session.expiresAt <= now || session.lastHeartbeatAt <= new Date(now.getTime() - HEARTBEAT_FRESHNESS_MS)) {
      await this.expireInternal(id, membership.teamId, userId);
      throw new AppError(409, 'workflow_executor_session_invalid', '桌面执行器 heartbeat 已过期，请重新预检');
    }
    const updated = await this.prisma.desktopExecutorSession.updateMany({
      where: { id, teamId: membership.teamId, userId, status: 'ACTIVE', tokenSha256: digest(token), inventorySha256: session.inventorySha256, expiresAt: { gt: now } },
      data: { lastHeartbeatAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
    });
    if (updated.count !== 1) throw new AppError(409, 'workflow_executor_session_invalid', '桌面执行器 session 已失效');
    return { session: await this.get(userId, id) };
  }

  async validate(userId: string, id: string, token: string, expectedInventorySha256?: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const session = await this.findAuthenticated(membership.teamId, userId, id, token);
    const now = new Date();
    if (session.expiresAt <= now) {
      await this.expireInternal(id, membership.teamId, userId);
      throw new AppError(409, 'workflow_executor_session_invalid', '桌面执行器 session 已过期');
    }
    if (session.lastHeartbeatAt <= new Date(now.getTime() - HEARTBEAT_FRESHNESS_MS)) {
      await this.expireInternal(id, membership.teamId, userId);
      throw new AppError(409, 'workflow_executor_session_invalid', '桌面执行器 heartbeat 已过期，请重新预检');
    }
    if (expectedInventorySha256 && !equalDigest(session.inventorySha256, expectedInventorySha256)) {
      await this.revokeInternal(id, membership.teamId, userId, 'inventory_changed');
      throw new AppError(409, 'workflow_inventory_changed', '桌面安装清单已变化');
    }
    return session;
  }

  async get(userId: string, id: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const session = await this.prisma.desktopExecutorSession.findFirst({ where: { id, teamId: membership.teamId, userId } });
    if (!session) throw notFound('桌面执行器 session 不存在');
    return this.publicSession(session as SessionRow);
  }

  async revoke(userId: string, id: string, token?: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    if (token) await this.findAuthenticated(membership.teamId, userId, id, token);
    const result = await this.prisma.desktopExecutorSession.updateMany({ where: { id, teamId: membership.teamId, userId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    if (result.count !== 1) throw forbidden('桌面执行器 session 已失效');
    return { ok: true };
  }

  private async findAuthenticated(teamId: string, userId: string, id: string, token: string): Promise<SessionRow> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
      throw new AppError(409, 'workflow_executor_session_invalid', '桌面执行器 session token 无效');
    }
    const session = await this.prisma.desktopExecutorSession.findFirst({ where: { id, teamId, userId, status: 'ACTIVE', tokenSha256: digest(token) } });
    if (!session) throw new AppError(409, 'workflow_executor_session_invalid', '桌面执行器 session 无效或已撤销');
    return session as SessionRow;
  }

  private async assertExactReleases(teamId: string, inventory: InventoryItem[]): Promise<void> {
    if (inventory.some((item) => item.dependency_status !== 'ready')) {
      throw new AppError(409, 'workflow_installation_mismatch', '桌面执行器仍有未就绪的插件依赖');
    }
    if (!inventory.length) return;
    const releases = await this.prisma.pluginRelease.findMany({
      where: { id: { in: inventory.map((item) => item.release_id) } },
      select: { id: true, packageId: true, sha256: true, status: true, package: { select: { id: true, ownerTeamId: true, governanceStatus: true } } },
    });
    const byId = new Map(releases.map((release) => [release.id, release]));
    for (const item of inventory) {
      const release = byId.get(item.release_id);
      if (!release || release.packageId !== item.package_id || release.package.id !== item.package_id || release.sha256 !== item.sha256 || release.status !== 'PUBLISHED' || release.package.governanceStatus !== 'ACTIVE') {
        throw new AppError(409, 'workflow_installation_mismatch', '桌面执行器清单未匹配到可运行的精确插件发行版', { package_id: item.package_id, release_id: item.release_id });
      }
      // PRIVATE package releases are only valid when the current team owns the package.
      if (release.package.ownerTeamId !== teamId) {
        const entitlement = await this.prisma.pluginEntitlement.findUnique({ where: { teamId_packageId: { teamId, packageId: item.package_id } }, select: { id: true } });
        if (!entitlement) throw new AppError(403, 'workflow_installation_mismatch', '当前团队没有该插件发行版的有效权益');
      }
    }
  }

  private async revokeInternal(id: string, teamId: string, userId: string, reason: string) {
    await this.prisma.desktopExecutorSession.updateMany({ where: { id, teamId, userId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    void reason;
  }

  private async expireInternal(id: string, teamId: string, userId: string) {
    await this.prisma.desktopExecutorSession.updateMany({ where: { id, teamId, userId, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
  }

  private publicSession(session: SessionRow) {
    return {
      id: session.id,
      device_id: session.deviceId,
      inventory_sha256: session.inventorySha256,
      status: session.status,
      expires_at: session.expiresAt.toISOString(),
      last_heartbeat_at: session.lastHeartbeatAt.toISOString(),
    };
  }
}
