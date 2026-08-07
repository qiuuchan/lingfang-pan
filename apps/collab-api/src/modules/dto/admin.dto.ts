import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApplicationStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  BALANCE_DIRECTION,
  PLATFORM_ROLE,
  PLUGIN_STATUS,
  PLUGIN_VISIBILITY,
  TEAM_ROLE,
  TEAM_STATUS,
  USER_STATUS,
} from './enums';

export const ADMIN_SORT_ORDER = ['asc', 'desc'] as const;
export const ADMIN_USER_SORT = ['createdAt', 'updatedAt', 'email', 'displayName'] as const;
export const ADMIN_TEAM_SORT = ['createdAt', 'updatedAt', 'name', 'balanceCents'] as const;

/** Shared bounded pagination query for admin read models. */
export class AdminPageQueryDto {
  @ApiPropertyOptional({ description: '页码（从 1 开始，默认 1）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 至少为 1' })
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（1-100，默认 20）', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 至少为 1' })
  @Max(100, { message: 'pageSize 最多为 100' })
  pageSize?: number;
}

/** GET /api/admin/users list query. */
export class AdminUsersQueryDto extends AdminPageQueryDto {
  @ApiPropertyOptional({ description: '邮箱或展示名称关键词' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200, { message: 'q 最多为 200 字' })
  q?: string;

  @ApiPropertyOptional({ description: '用户状态', enum: USER_STATUS })
  @IsOptional()
  @IsEnum(USER_STATUS, { message: 'status 只允许 ACTIVE 或 DISABLED' })
  status?: (typeof USER_STATUS)[number];

  @ApiPropertyOptional({ description: '平台角色', enum: PLATFORM_ROLE })
  @IsOptional()
  @IsEnum(PLATFORM_ROLE, { message: 'platformRole 只允许 NONE 或 PLATFORM_ADMIN' })
  platformRole?: (typeof PLATFORM_ROLE)[number];

  @ApiPropertyOptional({ description: '排序字段', enum: ADMIN_USER_SORT })
  @IsOptional()
  @IsEnum(ADMIN_USER_SORT, { message: 'sort 字段不受支持' })
  sort?: (typeof ADMIN_USER_SORT)[number];

  @ApiPropertyOptional({ description: '排序方向', enum: ADMIN_SORT_ORDER })
  @IsOptional()
  @IsEnum(ADMIN_SORT_ORDER, { message: 'order 只允许 asc 或 desc' })
  order?: (typeof ADMIN_SORT_ORDER)[number];
}

/** GET /api/admin/users/options bounded selector query. */
export class AdminUserOptionsQueryDto {
  @ApiPropertyOptional({ description: '邮箱或展示名称关键词' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200, { message: 'q 最多为 200 字' })
  q?: string;

  @ApiPropertyOptional({ description: '最大返回条数（1-50，默认 20）', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit 必须是整数' })
  @Min(1, { message: 'limit 至少为 1' })
  @Max(50, { message: 'limit 最多为 50' })
  limit?: number;
}

/** GET /api/admin/teams list query. */
export class AdminTeamsQueryDto extends AdminPageQueryDto {
  @ApiPropertyOptional({ description: '团队名称或 slug 关键词' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200, { message: 'q 最多为 200 字' })
  q?: string;

  @ApiPropertyOptional({ description: '团队状态', enum: TEAM_STATUS })
  @IsOptional()
  @IsEnum(TEAM_STATUS, { message: 'status 只允许 ACTIVE 或 SUSPENDED' })
  status?: (typeof TEAM_STATUS)[number];

  @ApiPropertyOptional({ description: '排序字段', enum: ADMIN_TEAM_SORT })
  @IsOptional()
  @IsEnum(ADMIN_TEAM_SORT, { message: 'sort 字段不受支持' })
  sort?: (typeof ADMIN_TEAM_SORT)[number];

  @ApiPropertyOptional({ description: '排序方向', enum: ADMIN_SORT_ORDER })
  @IsOptional()
  @IsEnum(ADMIN_SORT_ORDER, { message: 'order 只允许 asc 或 desc' })
  order?: (typeof ADMIN_SORT_ORDER)[number];
}

/** Team members support a DB-side user search; other team tabs use AdminPageQueryDto. */
export class AdminTeamMembersQueryDto extends AdminPageQueryDto {
  @ApiPropertyOptional({ description: '成员邮箱或展示名称关键词' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200, { message: 'q 最多为 200 字' })
  q?: string;
}

/** 管理端创建用户请求体 DTO。 */
export class AdminCreateUserDto {
  @ApiProperty({ description: '邮箱地址' })
  @IsString()
  email!: string;

  @ApiProperty({ description: '初始密码' })
  @IsString()
  @IsNotEmpty({ message: '初始密码不能为空' })
  password!: string;

  @ApiPropertyOptional({ description: '展示名称' })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional({ description: '平台角色', enum: PLATFORM_ROLE })
  @IsOptional()
  @IsEnum(PLATFORM_ROLE, { message: 'platformRole 只允许 NONE 或 PLATFORM_ADMIN' })
  platformRole?: (typeof PLATFORM_ROLE)[number];
}

/** 管理端更新用户请求体 DTO。status/platformRole 为枚举白名单，杜绝越权字段透传。 */
export class AdminUpdateUserDto {
  @ApiPropertyOptional({ description: '展示名称' })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional({ description: '用户状态', enum: USER_STATUS })
  @IsOptional()
  @IsEnum(USER_STATUS, { message: 'status 只允许 ACTIVE 或 DISABLED' })
  status?: (typeof USER_STATUS)[number];

  @ApiPropertyOptional({ description: '平台角色', enum: PLATFORM_ROLE })
  @IsOptional()
  @IsEnum(PLATFORM_ROLE, { message: 'platformRole 只允许 NONE 或 PLATFORM_ADMIN' })
  platformRole?: (typeof PLATFORM_ROLE)[number];

  @ApiPropertyOptional({ description: '邮箱（改后作废旧 token，需重新登录）' })
  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确' })
  email?: string;

  @ApiPropertyOptional({ description: '新密码（明文传入，服务端 hash；改后作废旧 token）' })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  password?: string;
}

/** 管理端创建团队请求体 DTO。 */
export class AdminCreateTeamDto {
  @ApiProperty({ description: '团队名称' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ description: '团队 slug（默认由名称生成）' })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ description: '初始余额（分），非负整数' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'balanceCents 必须是整数' })
  @Min(0, { message: 'balanceCents 不能为负' })
  balanceCents?: number;
}

/** 管理端更新团队请求体 DTO。字段白名单与 adminUpdateTeam 的显式提取对齐，
 *  杜绝此前 input 透传可静默改 balanceCents 绕过流水审计的问题。 */
export class AdminUpdateTeamDto {
  @ApiPropertyOptional({ description: '团队名称' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: '团队状态', enum: TEAM_STATUS })
  @IsOptional()
  @IsEnum(TEAM_STATUS, { message: 'status 只允许 ACTIVE 或 SUSPENDED' })
  status?: (typeof TEAM_STATUS)[number];

  @ApiPropertyOptional({ description: '默认资源池 ID（null 表示取消设置）' })
  @IsOptional()
  @IsString()
  defaultPoolId?: string | null;
}

/** 指定团队管理员请求体 DTO。 */
export class AdminSetTeamAdminDto {
  @ApiProperty({ description: '目标用户 ID' })
  @IsString()
  userId!: string;
}

/** 调整团队共享余额请求体 DTO。amountCents 正整数、direction 枚举。 */
export class AdminAdjustBalanceDto {
  @ApiProperty({ description: '调整金额（分），正整数' })
  @Type(() => Number)
  @IsInt({ message: 'amountCents 必须是正整数' })
  @Min(1, { message: 'amountCents 必须大于 0' })
  amountCents!: number;

  @ApiProperty({ description: '调整方向', enum: BALANCE_DIRECTION })
  @IsEnum(BALANCE_DIRECTION, { message: 'direction 只允许 CREDIT 或 DEBIT' })
  direction!: (typeof BALANCE_DIRECTION)[number];

  @ApiPropertyOptional({ description: '调整原因（写入流水）' })
  @IsOptional()
  @IsString()
  reason?: string;
}

/** 管理端创建平台插件请求体 DTO。
 *  注：服务端 adminCreatePlugin 始终拒绝该路径（仅允许 Agent 发布），DTO 仅声明字段以维持一致性。 */
export class AdminCreatePluginDto {
  @ApiProperty({ description: '插件名称（本接口始终拒绝）' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ description: '插件描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: '插件状态', enum: PLUGIN_STATUS })
  @IsOptional()
  @IsEnum(PLUGIN_STATUS, { message: 'status 只允许 ENABLED 或 DISABLED' })
  status?: (typeof PLUGIN_STATUS)[number];
}

/** 驳回市场插件请求体 DTO。reason 可选。 */
export class AdminRejectPluginDto {
  @ApiPropertyOptional({ description: '驳回原因' })
  @IsOptional()
  @IsString()
  reason?: string;
}

/** 更新平台插件请求体 DTO。字段白名单与服务层显式提取对齐，priceCents 可选非负整数。
 *  version 为展示用 semver 字符串（非严格校验，仅限长 32 防异常超长串），
 *  visibility 为枚举白名单（PRIVATE/TEAM/PUBLIC），杜绝越权字段透传。 */
export class AdminUpdatePluginDto {
  @ApiPropertyOptional({ description: '插件名称' })
  @IsOptional()
  @IsString()
  @MaxLength(128, { message: '插件名称过长' })
  name?: string;

  @ApiPropertyOptional({ description: '插件描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: '插件版本（semver 展示串）' })
  @IsOptional()
  @IsString()
  @MaxLength(32, { message: '版本号过长' })
  version?: string;

  @ApiPropertyOptional({ description: '插件状态', enum: PLUGIN_STATUS })
  @IsOptional()
  @IsEnum(PLUGIN_STATUS, { message: 'status 只允许 ENABLED 或 DISABLED' })
  status?: (typeof PLUGIN_STATUS)[number];

  @ApiPropertyOptional({ description: '定价（分），非负整数' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'priceCents 必须是整数' })
  @Min(0, { message: 'priceCents 不能为负' })
  priceCents?: number;

  @ApiPropertyOptional({ description: '可见性', enum: PLUGIN_VISIBILITY })
  @IsOptional()
  @IsEnum(PLUGIN_VISIBILITY, { message: 'visibility 只允许 PRIVATE、TEAM 或 PUBLIC' })
  visibility?: (typeof PLUGIN_VISIBILITY)[number];
}

/** GET /api/admin/team-admin-applications 查询参数。 */
export class AdminApplicationsQueryDto {
  @ApiPropertyOptional({ description: '页码（从 1 开始，默认 1）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 至少为 1' })
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（1-100，默认 20）', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 至少为 1' })
  @Max(100, { message: 'pageSize 最多为 100' })
  pageSize?: number;

  @ApiPropertyOptional({ description: '团队名、申请人邮箱或展示名称关键词' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'q 最多为 200 字' })
  q?: string;

  @ApiPropertyOptional({ description: '申请状态', enum: ApplicationStatus })
  @IsOptional()
  @IsEnum(ApplicationStatus, { message: 'status 只允许 PENDING、APPROVED 或 REJECTED' })
  status?: ApplicationStatus;
}

/** 驳回团队管理员申请请求体 DTO。 */
export class AdminRejectApplicationDto {
  @ApiProperty({ description: '驳回原因（1-500 字）' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: '驳回原因不能为空' })
  @MaxLength(500, { message: '驳回原因最多为 500 字' })
  reason!: string;
}

/** 调整团队成员角色请求体 DTO。
 *  - role：旧枚举白名单（TEAM_ADMIN/MEMBER），向后兼容旧前端。
 *  - roleId：新字段，指定任意团队自定义角色（child-4 D7：collab-admin 角色下拉传 roleId）。
 *  service 层按「传了哪个字段」分别处理；二者必填其一（class-validator 表达「至少一个」需运行时校验，
 *  这里用 @IsOptional 放宽，由 AdminService.adminUpdateMemberRole 显式拒绝「两个都没传」）。 */
export class AdminUpdateMemberRoleDto {
  @ApiPropertyOptional({ description: '成员角色（旧枚举，TEAM_ADMIN/MEMBER）', enum: TEAM_ROLE })
  @IsOptional()
  @IsEnum(TEAM_ROLE, { message: 'role 只允许 TEAM_ADMIN 或 MEMBER' })
  role?: (typeof TEAM_ROLE)[number];

  @ApiPropertyOptional({ description: '团队角色 id（替代 role 枚举，指定任意团队自定义角色）' })
  @IsOptional()
  @IsString()
  roleId?: string;
}

/** 团队启用/停用请求体 DTO。status 枚举白名单（ACTIVE/SUSPENDED）。 */
export class AdminUpdateTeamStatusDto {
  @ApiProperty({ description: '团队状态', enum: TEAM_STATUS })
  @IsEnum(TEAM_STATUS, { message: 'status 只允许 ACTIVE 或 SUSPENDED' })
  status!: (typeof TEAM_STATUS)[number];
}

/** 管理端调整用户平台角色请求体 DTO（专用端点 PATCH /platform-role）。
 *  platformRole 枚举白名单，与 AdminUpdateUserDto 区分：此端点仅改角色，
 *  且禁止自改自身（service 内 id === actorId 时拒绝，防自降级锁死末位管理员）。 */
export class AdminPlatformRoleDto {
  @ApiProperty({ description: '目标平台角色', enum: PLATFORM_ROLE })
  @IsEnum(PLATFORM_ROLE, { message: 'platformRole 只允许 NONE 或 PLATFORM_ADMIN' })
  platformRole!: (typeof PLATFORM_ROLE)[number];
}

/** 审计日志查询参数 DTO（组D 审计完善）。
 *  category：按 action 前缀分类筛选（auth/team/plugin/marketplace/wallet/llm/admin/system）。
 *  q：关键词搜索（匹配 action / actor email / targetId）。
 *  actorId / targetType：精确过滤。全部可选。 */
export const AUDIT_CATEGORY = [
  'auth',
  'team',
  'plugin',
  'marketplace',
  'wallet',
  'llm',
  'admin',
  'system',
] as const;

export class AdminAuditLogsQueryDto extends AdminPageQueryDto {
  @ApiPropertyOptional({ description: '分类筛选', enum: AUDIT_CATEGORY })
  @IsOptional()
  @IsEnum(AUDIT_CATEGORY, {
    message: 'category 只允许 auth/team/plugin/marketplace/wallet/llm/admin/system',
  })
  category?: (typeof AUDIT_CATEGORY)[number];

  @ApiPropertyOptional({ description: '关键词搜索（action / actor email / targetId）' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200, { message: 'q 最多为 200 字' })
  q?: string;

  @ApiPropertyOptional({ description: '操作者用户 ID（精确过滤）' })
  @IsOptional()
  @IsString()
  actorId?: string;

  @ApiPropertyOptional({ description: '对象类型（精确过滤，如 User/Team/Plugin）' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'targetType 最多为 100 字' })
  targetType?: string;
}
