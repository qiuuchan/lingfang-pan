import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

/** 角色编码格式：小写字母/数字开头，允许小写字母、数字、下划线、连字符，1-64 字符。 */
const ROLE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Bounded role list query used by platform admin and managed-team role views. */
export class RoleListQueryDto {
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

  @ApiPropertyOptional({ description: '角色名称、编码或描述关键词' })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(200, { message: 'q 最多为 200 字' })
  q?: string;
}

/** 创建角色请求体 DTO。permissions 为权限码数组（必须来自注册表白名单，service 层校验）。 */
export class CreateRoleDto {
  @ApiProperty({ description: '角色显示名（1-64 字符）' })
  @IsString({ message: 'name 必须是字符串' })
  @MinLength(1, { message: 'name 不能为空' })
  @MaxLength(64, { message: 'name 最长 64 字符' })
  name!: string;

  @ApiPropertyOptional({ description: '角色编码（可选、同 scope+teamId 下唯一，如 admin/operator）' })
  @IsOptional()
  @IsString({ message: 'code 必须是字符串' })
  @MaxLength(64, { message: 'code 最长 64 字符' })
  @Matches(ROLE_CODE_PATTERN, { message: '编码只能包含小写字母、数字、下划线、连字符，须以字母或数字开头' })
  code?: string;

  @ApiPropertyOptional({ description: '角色描述（最长 255 字符）' })
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'description 最长 255 字符' })
  description?: string;

  @ApiPropertyOptional({ description: '权限码数组（来自注册表，scope 须与目标角色 scope 一致）', type: [String] })
  @IsOptional()
  @IsArray({ message: 'permissions 必须是数组' })
  @ArrayMinSize(0)
  @IsString({ each: true, message: 'permissions 每项必须是字符串' })
  permissions?: string[];
}

/** 更新角色请求体 DTO。全部可选；系统角色仅允许改 name/description，permissions 由 service 层拒绝。 */
export class UpdateRoleDto {
  @ApiPropertyOptional({ description: '角色显示名' })
  @IsOptional()
  @IsString({ message: 'name 必须是字符串' })
  @MinLength(1, { message: 'name 不能为空' })
  @MaxLength(64, { message: 'name 最长 64 字符' })
  name?: string;

  @ApiPropertyOptional({ description: '角色编码' })
  @IsOptional()
  @IsString({ message: 'code 必须是字符串' })
  @MaxLength(64, { message: 'code 最长 64 字符' })
  @Matches(ROLE_CODE_PATTERN, { message: '编码只能包含小写字母、数字、下划线、连字符，须以字母或数字开头' })
  code?: string;

  @ApiPropertyOptional({ description: '角色描述' })
  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'description 最长 255 字符' })
  description?: string;

  @ApiPropertyOptional({ description: '权限码数组（系统角色不可修改）', type: [String] })
  @IsOptional()
  @IsArray({ message: 'permissions 必须是数组' })
  @IsString({ each: true, message: 'permissions 每项必须是字符串' })
  permissions?: string[];
}

/** 分配成员角色请求体 DTO（团队级：为团队成员指定团队角色）。 */
export class AssignMemberRoleDto {
  @ApiProperty({ description: '成员用户 id' })
  @IsString()
  userId!: string;

  @ApiProperty({ description: '团队角色 id（scope=TEAM，归属本团队）' })
  @IsString()
  roleId!: string;
}

/** 设置插件授权请求体 DTO。subjectKind=USER 时 subjectId=userId；ROLE 时 subjectId=团队角色 id。 */
export class SetPluginGrantDto {
  @ApiProperty({ description: '授权主体类型：USER 指定用户 / ROLE 指定角色', enum: ['USER', 'ROLE'] })
  @IsString()
  subjectKind!: 'USER' | 'ROLE';

  @ApiProperty({ description: '主体 id（userId 或团队角色 id）' })
  @IsString()
  subjectId!: string;

  @ApiProperty({ description: '授权效果：ALLOW 放行 / DENY 拒绝（deny 优先）', enum: ['ALLOW', 'DENY'] })
  @IsString()
  effect!: 'ALLOW' | 'DENY';
}

/** upsert 权限组显示名请求体 DTO（管理员自定义模块显示名覆盖）。 */
export class UpsertPermissionGroupDto {
  @ApiProperty({ description: '分组键（已注册的 moduleKey，不允许新增模块本身）' })
  @IsString({ message: 'groupKey 必须是字符串' })
  @MinLength(1, { message: 'groupKey 不能为空' })
  @MaxLength(64, { message: 'groupKey 最长 64 字符' })
  groupKey!: string;

  @ApiProperty({ description: '分组显示名（1-64 字符）' })
  @IsString({ message: 'displayName 必须是字符串' })
  @MinLength(1, { message: 'displayName 不能为空' })
  @MaxLength(64, { message: 'displayName 最长 64 字符' })
  displayName!: string;
}
