// 计费/中转相关 DTO（资源池模型重构后）。字段白名单由全局 ValidationPipe 强制。
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min,
} from 'class-validator';

const CHANNEL_PROTOCOL = ['OPENAI', 'ANTHROPIC'] as const;
const CHANNEL_KIND = ['CHAT', 'IMAGE'] as const;
const CHANNEL_TIER = ['FAST', 'PREMIUM'] as const;
const CHANNEL_STATUS = ['ENABLED', 'DISABLED'] as const;
const POOL_SCOPE = ['SHARED', 'DEDICATED'] as const;
const PRICING_UNIT = ['PER_TOKEN_INPUT', 'PER_TOKEN_OUTPUT', 'PER_CALL', 'PER_IMAGE'] as const;
const PRICING_CAPABILITY = ['chat', 'image', 'action'] as const;
const TIER = ['FAST', 'PREMIUM'] as const;
const LEDGER_DIR = ['CREDIT', 'DEBIT'] as const;

// === 资源池 ===

export class PoolUpsertDto {
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiProperty({ enum: POOL_SCOPE }) @IsEnum(POOL_SCOPE) scope!: 'SHARED' | 'DEDICATED';
  @ApiPropertyOptional({ description: 'DEDICATED 时必填（teamId）；SHARED 留空' })
  @IsOptional() @IsString() teamId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
}

export class PoolUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
}

// === 渠道 ===

export class ChannelUpsertDto {
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiProperty({ enum: CHANNEL_KIND }) @IsEnum(CHANNEL_KIND) kind!: 'CHAT' | 'IMAGE';
  @ApiProperty({ enum: CHANNEL_TIER }) @IsEnum(CHANNEL_TIER) tier!: 'FAST' | 'PREMIUM';
  @ApiProperty({ enum: CHANNEL_PROTOCOL }) @IsEnum(CHANNEL_PROTOCOL) protocol!: 'OPENAI' | 'ANTHROPIC';
  @ApiProperty() @IsString() @IsNotEmpty() provider!: string;
  @ApiProperty() @IsString() @IsNotEmpty() poolId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() baseUrl!: string;
  @ApiProperty({ description: '上游 API Key 明文（创建必填；更新时省略=保留原密）' })
  @IsOptional() @IsString() upstreamKey?: string;
  @ApiPropertyOptional({ type: [String], description: '该渠道可调用的多个上游模型，轮询调用' })
  @IsOptional() @IsArray() @IsString({ each: true }) models?: string[];
  @ApiPropertyOptional({ enum: CHANNEL_STATUS }) @IsOptional() @IsEnum(CHANNEL_STATUS) status?: 'ENABLED' | 'DISABLED';
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
}

// === 定价（单位：PER_TOKEN_* = 每 1M token；PER_CALL 每次；PER_IMAGE 每张）===

export class PricingUpsertDto {
  @ApiProperty({ enum: PRICING_CAPABILITY }) @IsEnum(PRICING_CAPABILITY) capability!: 'chat' | 'image' | 'action';
  @ApiProperty() @IsString() @IsNotEmpty() model!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() label?: string;
  @ApiProperty({ enum: PRICING_UNIT }) @IsEnum(PRICING_UNIT) unit!: string;
  @ApiProperty({ description: '单价（灵石）；PER_TOKEN_* 时为每 1M token 灵石数，支持小数' })
  @Type(() => Number) @IsNumber() @Min(0) pricePerUnit!: number;
  @ApiPropertyOptional({ description: '该模型最大上下文窗口（token）' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) contextWindow?: number;
  @ApiPropertyOptional({ enum: TIER }) @IsOptional() @IsEnum(TIER) tier?: 'FAST' | 'PREMIUM';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
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
  @ApiPropertyOptional({ type: [String], description: '能力白名单：chat/image；空数组默认全能力。tier 标签仅展示，不做强限版' })
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
  @ApiPropertyOptional({ description: '兼容旧客户端；团队共享 Key 固定不过期' }) @IsOptional() @IsBoolean() noExpire?: boolean;
}

// === 渠道测试 ===

export class TestChatDto {
  @ApiProperty() @IsString() @IsNotEmpty() model!: string;
}

export class TestImageDto {
  @ApiProperty() @IsString() @IsNotEmpty() model!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() prompt?: string;
}
