import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { BALANCE_DIRECTION, PLATFORM_ROLE, PLUGIN_STATUS, TEAM_STATUS, USER_STATUS } from './enums';

/** 管理端创建用户请求体 DTO。 */
export class AdminCreateUserDto {
  @ApiProperty({ description: '邮箱地址' })
  @IsString()
  email!: string;

  @ApiProperty({ description: '初始密码' })
  @IsString()
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

/** 更新平台插件请求体 DTO。priceCents 可选非负整数。 */
export class AdminUpdatePluginDto {
  @ApiPropertyOptional({ description: '插件名称' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: '插件描述' })
  @IsOptional()
  @IsString()
  description?: string;

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
}

/** 驳回团队管理员申请请求体 DTO。reason 可选。 */
export class AdminRejectApplicationDto {
  @ApiPropertyOptional({ description: '驳回原因' })
  @IsOptional()
  @IsString()
  reason?: string;
}
