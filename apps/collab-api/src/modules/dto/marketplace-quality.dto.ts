import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class MarketplaceRatingDto {
  @ApiProperty({ description: '1 到 5 的团队评分', minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  @ApiPropertyOptional({ description: '公开评论', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class MarketplaceRatingListQueryDto {
  @ApiPropertyOptional({ description: '页码', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页数量', default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

export class MarketplaceQualityAppealDto {
  @ApiProperty({ description: '申诉说明', minLength: 1, maxLength: 10000 })
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;
}

export class MarketplaceQualityRecomputeDto {
  @ApiPropertyOptional({ description: '客户端幂等请求号', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}

export class MarketplaceQualityReasonDto {
  @ApiProperty({ description: '公开且可审计的操作原因', minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class MarketplaceFeatureDto extends MarketplaceQualityReasonDto {
  @ApiPropertyOptional({ description: '稳定精选排序，数值越小越靠前', minimum: 0, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  rank?: number;

  @ApiPropertyOptional({ description: '可选精选结束时间（ISO 8601）' })
  @IsOptional()
  @IsDateString()
  until?: string;
}
