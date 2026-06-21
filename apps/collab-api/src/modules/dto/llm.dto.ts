// LLM provider 目录 + 用户绑定相关 DTO（class-validator，对齐现有 dto/ 模式）。
// 字段白名单由全局 ValidationPipe（whitelist + forbidNonWhitelisted）强制，杜绝越权字段透传。
// 所有字段 camelCase（与 /api/llm/* 契约一致，design.md B11）。
// TenantLlmBinding 去 gatewayId，BindingUpsertDto 无 gatewayId；Provider DTO 新增 isActive 不在 create 时设。
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { LLM_GATEWAY_STATUS } from './enums';

// === 平台 Admin provider 目录 DTO ===

/** POST /api/admin/llm-providers 入参。
 *  - provider 为 String（非 enum），平台维护白名单（见 enums.ts LLM_PROVIDER），seed 时校验。
 *  - apiUrl 服务端规范化去尾斜杠（service 内 normalizeApiUrl）。
 *  - name 唯一（DB 约束 + seed upsert 幂等）。
 *  - isActive 不在此设，通过 PATCH /:id/activate 端点事务维护唯一。 */
export class ProviderCreateDto {
  @ApiProperty({ description: 'provider 提供方（平台维护白名单，如 openai/anthropic/azure）' })
  @IsString()
  @MinLength(1, { message: 'provider 不能为空' })
  provider!: string;

  @ApiProperty({ description: '展示名（唯一，如「OpenAI 官方」）' })
  @IsString()
  @MinLength(1, { message: 'name 不能为空' })
  name!: string;

  @ApiProperty({ description: 'API 基址（服务端去尾斜杠，如 https://api.openai.com/v1）' })
  @IsString()
  @MinLength(1, { message: 'apiUrl 不能为空' })
  apiUrl!: string;

  @ApiPropertyOptional({ description: '模型清单（string[]，默认空数组）', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  models?: string[];

  @ApiPropertyOptional({ description: '描述（默认空串）' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: '排序权重（小在前，默认 0）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'sortOrder 必须是整数' })
  @Min(0, { message: 'sortOrder 不能为负' })
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'provider 状态', enum: LLM_GATEWAY_STATUS })
  @IsOptional()
  @IsEnum(LLM_GATEWAY_STATUS, { message: 'status 只允许 ENABLED 或 DISABLED' })
  status?: (typeof LLM_GATEWAY_STATUS)[number];
}

/** PATCH /api/admin/llm-providers/:id 入参（全可选）。 */
export class ProviderUpdateDto {
  @ApiPropertyOptional({ description: 'provider 提供方' })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'provider 不能为空' })
  provider?: string;

  @ApiPropertyOptional({ description: '展示名' })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'name 不能为空' })
  name?: string;

  @ApiPropertyOptional({ description: 'API 基址' })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'apiUrl 不能为空' })
  apiUrl?: string;

  @ApiPropertyOptional({ description: '模型清单', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  models?: string[];

  @ApiPropertyOptional({ description: '描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: '排序权重' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'sortOrder 必须是整数' })
  @Min(0, { message: 'sortOrder 不能为负' })
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'provider 状态', enum: LLM_GATEWAY_STATUS })
  @IsOptional()
  @IsEnum(LLM_GATEWAY_STATUS, { message: 'status 只允许 ENABLED 或 DISABLED' })
  status?: (typeof LLM_GATEWAY_STATUS)[number];
}

// === 用户绑定 DTO（无 gatewayId，按 userId 唯一 upsert） ===

/** PUT /api/llm/binding 入参（无 gatewayId）。
 *  apiKey 语义（design.md B5）：
 *  - undefined：保留原密，仅改 enabled/modelOverride（kind=config_only）；
 *  - 非空：重新加密 + 轮换 hint/fingerprint（kind=key_rotated 或 create）。
 *  modelOverride：null=清空选择；string[]=子集；undefined=不改。 */
export class BindingUpsertDto {
  @ApiPropertyOptional({ description: 'apiKey 明文（undefined=保留原密，非空=重新加密轮换）' })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'apiKey 不能为空串（不更新请省略字段）' })
  apiKey?: string;

  @ApiPropertyOptional({ description: '是否启用绑定' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: '模型覆盖（从拉取结果选的子集；null=清空）', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  modelOverride?: string[] | null;
}
