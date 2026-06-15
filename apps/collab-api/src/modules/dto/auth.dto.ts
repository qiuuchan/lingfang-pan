import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/** 注册请求体 DTO。校验邮箱格式、密码长度与可选的团队管理员申请字段。 */
export class RegisterDto {
  @ApiProperty({ description: '邮箱地址', example: 'alice@example.com' })
  @IsEmail({}, { message: '请输入有效邮箱' })
  email!: string;

  @ApiProperty({ description: '登录密码（至少 8 位）', minLength: 8 })
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  password!: string;

  @ApiPropertyOptional({ description: '展示名称（默认用邮箱）' })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional({ description: '是否同时提交团队管理员申请' })
  @IsOptional()
  @IsBoolean()
  wantsTeamAdmin?: boolean;

  @ApiPropertyOptional({ description: '申请建团名称（wantsTeamAdmin 为 true 时生效）' })
  @IsOptional()
  @IsString()
  teamName?: string;

  @ApiPropertyOptional({ description: '建团申请理由' })
  @IsOptional()
  @IsString()
  reason?: string;
}

/** 登录请求体 DTO。 */
export class LoginDto {
  @ApiProperty({ description: '邮箱地址' })
  @IsEmail({}, { message: '请输入有效邮箱' })
  email!: string;

  @ApiProperty({ description: '登录密码' })
  @IsString()
  password!: string;
}

/** 找回密码请求体 DTO。 */
export class ForgotPasswordDto {
  @ApiProperty({ description: '注册邮箱地址' })
  @IsEmail({}, { message: '请输入有效邮箱' })
  email!: string;
}

/** 重置密码请求体 DTO。 */
export class ResetPasswordDto {
  @ApiProperty({ description: '邮件下发的重置 token' })
  @IsString()
  token!: string;

  @ApiProperty({ description: '新密码（至少 8 位）', minLength: 8 })
  @IsString()
  @MinLength(8, { message: '新密码至少 8 位' })
  newPassword!: string;
}

/** 邮箱验证请求体 DTO（verify-email 端点）。 */
export class VerifyEmailDto {
  @ApiProperty({ description: '邮件下发的验证 token' })
  @IsString()
  token!: string;
}
