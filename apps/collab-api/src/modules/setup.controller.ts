// 首次启动安装向导控制器：GET /api/setup/status + POST /api/setup（@Public，不鉴权）。
//
// 设计契约（严格仅未初始化时可用，防被恶意创建管理员）：
//  - status 端点：查 User where platformRole=PLATFORM_ADMIN 计数，count===0 → needsSetup=true。
//  - setup 端点：进入前复检 needsSetup；事务内先创建固定 PlatformSetting lock，利用 key 主键兜住并发。
//    复检负责常规已初始化场景，lock 负责两个首次 setup 请求同时通过复检的竞态。
//  - 全程 $transaction 原子完成：创建 bootstrap lock + 建管理员（bcrypt hash）+ 写 platformName + 审计
//    platform_admin.bootstrap，避免部分成功（建了管理员却没写平台名 / 审计缺失）。
//  - platformName 复用 SettingsService.KEY_VALIDATORS 的同款归一化（trim + 长度上限），保持单一来源语义。
import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import bcrypt from 'bcryptjs';
import {
  SYSTEM_PLATFORM_ADMIN_ROLE_ID,
  SYSTEM_PLATFORM_ADMIN_ROLE_CODE,
} from './permissions/permission-codes';
import { PrismaService } from '../prisma.service';
import { AppError, Public } from '../common';
import { SetupDto } from './dto/setup.dto';

const SETUP_BOOTSTRAP_LOCK_KEY = '__setup_bootstrap_lock__';

@ApiTags('Setup')
@Controller('setup')
export class SetupController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 是否需要初始化：DB 中无任何 PLATFORM_ADMIN 时为 true（首次部署）。
   *  @Public：安装向导在登录前触发，不鉴权。 */
  @Get('status')
  @Public()
  @ApiOperation({ summary: '查询是否需要首次安装向导（免登录）' })
  async status() {
    const count = await this.prisma.user.count({ where: { platformRole: 'PLATFORM_ADMIN' } });
    return { needsSetup: count === 0 };
  }

  /** 执行首次安装：创建首个 PLATFORM_ADMIN + 写 platformName + 审计。
   *  @Public：安装向导在登录前触发。严格仅 needsSetup=true 时可用，否则 403 setup_already_done。 */
  @Post()
  @Public()
  @ApiOperation({ summary: '首次安装向导：创建首个平台管理员并初始化平台名称（仅未初始化时可用）' })
  async setup(@Body() body: SetupDto) {
    // 进入即复检 needsSetup：防「status 查询返回 true 后、本请求到达前，seed-admin 已建管理员」的竞态。
    const adminCount = await this.prisma.user.count({ where: { platformRole: 'PLATFORM_ADMIN' } });
    if (adminCount > 0)
      throw new AppError(403, 'forbidden', '平台已完成初始化，安装向导已关闭', {
        reason: 'setup_already_done',
      });

    // 邮箱归一化（与 register/login 一致：trim + lowercase）。
    const email = body.email.trim().toLowerCase();
    // 已存在同邮箱的非管理员账号：不覆盖（避免把已注册用户提升为平台管理员，越权风险）。
    // 这种情况极罕见（首次部署一般无用户），但必须显式拒绝而非静默 upsert 提权。
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing)
      throw new AppError(403, 'forbidden', '该邮箱已被占用，无法作为管理员创建', {
        reason: 'email_taken',
      });

    // platformName 归一化：与 SettingsService.KEY_VALIDATORS.platformName 同款（trim + 100 上限），
    // 保持单一来源语义；空则不写（保留 SettingsService.getPublicInfo 的 'LingFang' 默认兜底）。
    const platformName = (body.platformName ?? '').trim();
    if (platformName.length > 100)
      throw new AppError(400, 'bad_request', '平台名称过长（上限 100 字符）');

    const passwordHash = await bcrypt.hash(body.password, 12);
    const displayName = (body.displayName ?? '').trim() || email;

    // $transaction 原子完成四件事：创建 bootstrap lock + 建管理员 + 写 platformName + 审计。
    // lock 使用 PlatformSetting.key 主键兜住并发：两个首次 setup 同时通过复检时，只能一个插入成功。
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.platformSetting.create({
          data: {
            key: SETUP_BOOTSTRAP_LOCK_KEY,
            value: 'completed',
            description: '首次安装向导一次性初始化锁',
          },
        });
        // RBAC：确保系统平台管理员角色存在（兜底，权限填充由 seed-rbac 负责）。
        await tx.role.upsert({
          where: { id: SYSTEM_PLATFORM_ADMIN_ROLE_ID },
          update: {},
          create: {
            id: SYSTEM_PLATFORM_ADMIN_ROLE_ID,
            name: '系统平台管理员',
            code: SYSTEM_PLATFORM_ADMIN_ROLE_CODE,
            scope: 'PLATFORM',
            teamId: null,
            isSystem: true,
            description: '内置平台管理员角色，拥有全部平台权限',
            permissions: [],
          },
        });
        // RBAC 双写：platformRole 枚举 + platformRoleId 同步，否则新权限守卫解析不到平台角色权限。
        const user = await tx.user.create({
          data: {
            email,
            displayName,
            passwordHash,
            platformRole: 'PLATFORM_ADMIN',
            platformRoleId: SYSTEM_PLATFORM_ADMIN_ROLE_ID,
          },
        });
        // platformName 非空才写 PlatformSetting（空则保留 getPublicInfo 的默认 'LingFang' 兜底）。
        if (platformName) {
          await tx.platformSetting.upsert({
            where: { key: 'platformName' },
            create: { key: 'platformName', value: platformName, updatedById: user.id },
            update: { value: platformName, updatedById: user.id },
          });
        }
        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            action: 'platform_admin.bootstrap',
            targetType: 'User',
            targetId: user.id,
            metadata: { email, via: 'setup-wizard' },
          },
        });
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        throw new AppError(403, 'forbidden', '平台已完成初始化，安装向导已关闭', {
          reason: 'setup_already_done',
        });
      }
      throw error;
    }

    // 完成后该端点自动失效：下次调用 status 返回 needsSetup=false，setup 进入即被 adminCount 复检或 bootstrap lock 拦截。
    return { ok: true };
  }
}
