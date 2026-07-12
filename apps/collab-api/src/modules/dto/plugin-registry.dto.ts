import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { RELEASE_SOURCE_KINDS, type ReleaseSourceKind } from '../plugin-registry-model';

export class AdminPluginPackageListQueryDto {
  @ApiPropertyOptional({ description: '页码（从 1 开始，默认 1）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（1-100，默认 20）', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({ description: '按名称、manifest id、描述或团队搜索' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';

  @ApiPropertyOptional({ enum: ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED'])
  reviewStatus?: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ enum: RELEASE_SOURCE_KINDS, description: '只返回包含该发布来源发行版的插件包' })
  @IsOptional()
  @IsIn(RELEASE_SOURCE_KINDS)
  sourceKind?: ReleaseSourceKind;
}

export class AdminPluginPageQueryDto {
  @ApiPropertyOptional({ description: '页码（从 1 开始，默认 1）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（1-100，默认 20）', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class AdminPluginReasonDto {
  @ApiProperty({ description: '操作原因，1-500 字符' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class UpdatePluginPackageStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status!: 'ACTIVE' | 'ARCHIVED';
}

export class UpdatePluginReleaseStatusDto {
  @ApiProperty({ enum: ['PUBLISHED', 'YANKED'] })
  @IsIn(['PUBLISHED', 'YANKED'])
  status!: 'PUBLISHED' | 'YANKED';
}

export class UpdateMarketplaceListingStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'DELISTED'] })
  @IsIn(['ACTIVE', 'DELISTED'])
  status!: 'ACTIVE' | 'DELISTED';

  @ApiPropertyOptional({ description: '下架或恢复说明，最多 500 字符' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PluginLifecycleReasonDto {
  @ApiPropertyOptional({ description: '状态变更原因，最多 500 字符' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
