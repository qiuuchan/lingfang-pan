import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** 创建角色请求体 DTO。permissions 为权限码数组（必须来自注册表白名单，service 层校验）。 */
export class CreateRoleDto {
  @ApiProperty({ description: '角色显示名（1-64 字符）' })
  @IsString({ message: 'name 必须是字符串' })
  @MinLength(1, { message: 'name 不能为空' })
  @MaxLength(64, { message: 'name 最长 64 字符' })
  name!: string;

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
