import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/** 提交插件到市场审核请求体 DTO。priceCents 语义：undefined 保持原价、0 免费化。 */
export class SubmitMarketplaceDto {
  @ApiPropertyOptional({ description: '定价（分）；undefined 保持原价，0 表示免费' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'priceCents 必须是整数' })
  @Min(0, { message: 'priceCents 不能为负' })
  priceCents?: number;
}
