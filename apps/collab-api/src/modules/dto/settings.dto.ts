// 平台设置相关 DTO（class-validator，对齐现有 dto/ 模式）。
// 字段白名单由全局 ValidationPipe（whitelist + forbidNonWhitelisted）强制，杜绝越权字段透传。
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEmail, IsIn, IsString, MinLength, ValidateNested } from 'class-validator';

/** 单项设置：key 受 service 层 KEY_VALIDATORS 白名单约束（platformName/logoUrl 等），value 为字符串。 */
export class SettingItemDto {
  @ApiProperty({ description: '设置 key（白名单：platformName / logoUrl 等）', example: 'platformName' })
  @IsString()
  @MinLength(1, { message: 'key 不能为空' })
  key!: string;

  @ApiProperty({ description: '设置 value（字符串；URL 类需 http/https）', example: 'LingFang' })
  @IsString()
  value!: string;
}

/** PATCH /api/admin/settings 入参：批量 upsert 设置项。
 *  采用 { settings: SettingItem[] } 显式结构（而非裸对象 {key:value}）：
 *  - class-validator 的 @ValidateNested 仅对数组/对象成员做递归校验，裸对象需键值动态校验，难以与
 *    全局 forbidNonWhitelisted 兼容（任意 key 都会被当成「声明字段」放行，白名单失效）。
 *  - 数组形式天然承载 description/多字段扩展，且 key 作为 payload 值（非 JSON 键）受 KEY_VALIDATORS 校验。
 *  - 数组空提交直接 400（ArrayMinSize(1)），避免无效空写。 */
export class UpdateSettingsDto {
  @ApiProperty({ description: '待更新的设置项数组', type: [SettingItemDto] })
  @IsArray()
  @ArrayMinSize(1, { message: '至少提交一项设置' })
  @ValidateNested({ each: true })
  @Type(() => SettingItemDto)
  settings!: SettingItemDto[];
}

/** POST /api/admin/settings/test-email 入参：收件邮箱（Admin 手填，用于验证 SMTP 配置）。 */
export class TestEmailDto {
  @ApiProperty({ description: '测试收件邮箱', example: 'admin@example.com' })
  @IsEmail({}, { message: '收件邮箱格式不正确' })
  to!: string;
}

/** 可被 reveal-secret 解密的敏感配置 key 白名单。
 *  这些 key 都按密钥类配置保存，审计时只记录 configured，不记录明文。
 *  在 DTO 层用 @IsIn 强制，配合 service 层兜底，杜绝通过 reveal-secret 读取任意 key。 */
export const REVEALABLE_SECRET_KEYS = ['smtpPass', 'geetestCaptchaKey', 'giteeAccessToken', 'tavilyApiKey', 'braveApiKey', 'rbflowApiKey'] as const;
export type RevealableSecretKey = (typeof REVEALABLE_SECRET_KEYS)[number];

/** POST /api/admin/settings/reveal-secret 入参：admin 当前密码 + 要查看的敏感 key。
 *  密码校验由 service 层做（bcrypt.compare 与当前用户 passwordHash），DTO 仅校验非空 + key 白名单。
 *  密码不设最小长度（避免与「密码 ≥8 位」注册约束耦合，校验语义是「匹配当前哈希」而非「符合策略」）。 */
export class RevealSecretDto {
  @ApiProperty({ description: '当前管理员密码（用于二次确认，明文传输经 HTTPS）', example: 'ChangeMe123!' })
  @IsString()
  @MinLength(1, { message: 'password 不能为空' })
  password!: string;

  @ApiProperty({ description: '要查看明文的敏感 key（仅 smtpPass / geetestCaptchaKey / giteeAccessToken / tavilyApiKey / braveApiKey / rbflowApiKey）', example: 'smtpPass' })
  @IsString()
  @IsIn(REVEALABLE_SECRET_KEYS, { message: '仅支持查看 smtpPass、geetestCaptchaKey、giteeAccessToken、tavilyApiKey、braveApiKey 或 rbflowApiKey' })
  key!: RevealableSecretKey;
}
