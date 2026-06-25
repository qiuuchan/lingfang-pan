// search/dto/search.dto.ts —— 搜索端点入参校验（class-validator，对齐现有 dto/ 模式）。
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

/** POST /api/search 入参。 */
export class SearchQueryDto {
  @ApiProperty({ description: '搜索关键词', example: 'Tauri 自定义安装器' })
  @IsString()
  @MinLength(1, { message: '搜索关键词不能为空' })
  query!: string;

  @ApiProperty({ description: '每源期望结果条数（1~20，默认 8）', required: false, example: 8 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
