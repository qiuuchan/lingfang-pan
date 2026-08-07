import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 首次启动安装向导请求体 DTO（POST /api/setup）。
 *
 * 入参承载两件事：创建首个平台管理员账号 + 写入平台名称。
 * 校验约束与 RegisterDto 对齐：
 *  - email：@IsEmail 格式校验（结果再在 service 内 trim/lowercase 归一化）。
 *  - password：@MinLength(8) 与注册/重置密码一致，避免弱密码直接成为首个管理员。
 *  - displayName / platformName：可选（service 内有默认值兜底），但提供时校验非空字符串 + 长度上限。
 */
export class SetupDto {
  @ApiProperty({ description: '首个平台管理员邮箱（登录用）', example: 'admin@example.com' })
  @IsEmail({}, { message: '请输入有效邮箱' })
  email!: string;

  @ApiProperty({ description: '管理员登录密码（至少 8 位）', minLength: 8 })
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  password!: string;

  @ApiPropertyOptional({ description: '管理员展示名称（默认用邮箱前缀）' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: '显示名称过长（上限 100 字符）' })
  displayName?: string;

  @ApiPropertyOptional({
    description: '平台名称（写入 PlatformSetting.platformName，默认 LingFang）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: '平台名称过长（上限 100 字符）' })
  platformName?: string;
}
