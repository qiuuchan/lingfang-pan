// 计费/中转相关 DTO（class-validator，对齐现有 dto/ 模式）。字段白名单由全局 ValidationPipe 强制。
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

const CHANNEL_PROTOCOL = ['OPENAI', 'ANTHROPIC'] as const;
const CHANNEL_STATUS = ['ENABLED', 'DISABLED'] as const;
const SCOPE_KIND = ['GLOBAL', 'TEAM', 'ROLE'] as const;
const PRICING_UNIT = ['PER_TOKEN_INPUT', 'PER_TOKEN_OUTPUT', 'PER_CALL', 'PER_IMAGE'] as const;
const PRICING_CAPABILITY = ['chat', 'image', 'action'] as const;
const TIER = ['FAST', 'PREMIUM'] as const;
const API_KEY_STATUS = ['ACTIVE', 'DISABLED'] as const;
const LEDGER_DIR = ['CREDIT', 'DEBIT'] as const;

// === 渠道 ===

export class ChannelUpsertDto {
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiProperty({ enum: CHANNEL_PROTOCOL }) @IsEnum(CHANNEL_PROTOCOL) protocol!: 'OPENAI' | 'ANTHROPIC';
  @ApiProperty() @IsString() @IsNotEmpty() provider!: string;
  @ApiProperty() @IsString() @IsNotEmpty() baseUrl!: string;
  @ApiProperty({ description: '上游 API Key 明文（创建必填；更新时省略=保留原密）' })
  @IsOptional() @IsString() upstreamKey?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) supportedModels?: string[];
  @ApiPropertyOptional({ enum: TIER, isArray: true }) @IsOptional() @IsArray() @IsEnum(TIER, { each: true }) supportedTiers?: ('FAST' | 'PREMIUM')[];
  @ApiPropertyOptional({ enum: CHANNEL_STATUS }) @IsOptional() @IsEnum(CHANNEL_STATUS) status?: 'ENABLED' | 'DISABLED';
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) priority?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) weight?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
}

export class ChannelBindingDto {
  @ApiProperty({ enum: SCOPE_KIND }) @IsEnum(SCOPE_KIND) scopeKind!: 'GLOBAL' | 'TEAM' | 'ROLE';
  @ApiPropertyOptional({ description: 'TEAM/ROLE 时必填（teamId/roleId）；GLOBAL 留空' })
  @IsOptional() @IsString() scopeId?: string;
}

// === 定价 ===

export class PricingUpsertDto {
  @ApiProperty({ enum: PRICING_CAPABILITY }) @IsEnum(PRICING_CAPABILITY) capability!: 'chat' | 'image' | 'action';
  @ApiProperty() @IsString() @IsNotEmpty() model!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() label?: string;
  @ApiProperty({ enum: PRICING_UNIT }) @IsEnum(PRICING_UNIT) unit!: string;
  @ApiProperty({ description: '单价（灵石）；PER_TOKEN_* 时为每 1k token 灵石数' })
  @Type(() => Number) @IsInt() @Min(0) pricePerUnit!: number;
  @ApiPropertyOptional({ enum: TIER }) @IsOptional() @IsEnum(TIER) tier?: 'FAST' | 'PREMIUM';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
}

// === 版本配置 ===

export class TierConfigDto {
  @ApiPropertyOptional() @IsOptional() @IsString() label?: string;
  @ApiProperty() @IsString() @IsNotEmpty() chatModel!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageModel?: string | null;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) temperature?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxTokens?: number;
}

// === 灵石调整 ===

export class CreditAdjustDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) amount!: number;
  @ApiProperty({ enum: LEDGER_DIR }) @IsEnum(LEDGER_DIR) direction!: 'CREDIT' | 'DEBIT';
  @ApiProperty() @IsString() @IsNotEmpty() reason!: string;
}

// === API Key ===

export class ApiKeyCreateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional({ type: [String], description: '能力白名单：chat/image/tier:fast/tier:premium' })
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() noExpire?: boolean;
}
