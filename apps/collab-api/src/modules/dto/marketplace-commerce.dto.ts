import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsISO8601, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, Matches, ValidateNested } from 'class-validator';

export class MarketplacePurchaseDto {
  @IsOptional() @IsString() @Matches(/^pv1\.[A-Za-z0-9_-]{43}$/) expectedPriceVersion?: string;
  @IsOptional() @IsString() @MaxLength(4096) campaignToken?: string;
}

export class MarketplaceRefundRequestDto {
  @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
}

export class MarketplaceRefundReviewDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class MarketplaceSettlementTriggerDto {
  @IsOptional() @IsISO8601() now?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
}

export class MarketplaceCutoverGenerationDto {
  @IsInt() @Min(0) expectedGeneration!: number;
}

export class MarketplaceCutoverPauseDto {
  @IsInt() @Min(0) expectedGeneration!: number;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class MarketplaceBackfillDto {
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(100000) limit?: number;
}

export class MarketplacePriceUpdateDto {
  @IsInt() @Min(0) @Max(2_147_483_647) priceCents!: number;
  @IsString() @Matches(/^pv1\.[A-Za-z0-9_-]{43}$/) expectedPriceVersion!: string;
}

export class MarketplaceDiscountCreateDto {
  @IsInt() @Min(1) @Max(2_147_483_647) priceCents!: number;
  @IsISO8601() startsAt!: string;
  @IsISO8601() endsAt!: string;
  @IsString() @Matches(/^pv1\.[A-Za-z0-9_-]{43}$/) expectedPriceVersion!: string;
}

export class MarketplacePriceVersionDto {
  @IsString() @Matches(/^pv1\.[A-Za-z0-9_-]{43}$/) expectedPriceVersion!: string;
}

export class MarketplaceCampaignItemDto {
  @IsUUID() packageId!: string;
  @IsInt() @Min(0) @Max(99) rank!: number;
}

export class MarketplaceCampaignCreateDto {
  @IsString() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(128) slug!: string;
  @IsString() @MinLength(1) @MaxLength(128) name!: string;
  @IsOptional() @IsString() @MaxLength(4096) description?: string;
  @IsISO8601() startsAt!: string;
  @IsISO8601() endsAt!: string;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => MarketplaceCampaignItemDto) items!: MarketplaceCampaignItemDto[];
}

export class MarketplaceOrderQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  @IsOptional() @IsUUID() packageId?: string;
  @IsOptional() @IsIn(['PENDING_SETTLEMENT', 'REFUND_REQUESTED', 'SETTLED', 'REFUNDED']) status?: 'PENDING_SETTLEMENT' | 'REFUND_REQUESTED' | 'SETTLED' | 'REFUNDED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class MarketplaceRefundAdminQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED']) status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
