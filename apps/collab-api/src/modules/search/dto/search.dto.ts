// search/dto/search.dto.ts —— 搜索端点入参校验（class-validator，对齐现有 dto/ 模式）。
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUrl, Max, Min, MinLength } from 'class-validator';

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

/** POST /api/search/fetch 入参（WebFetch：抓取网页正文）。 */
export class WebFetchDto {
  @ApiProperty({ description: '要抓取正文的网页 URL', example: 'https://example.com/article' })
  @IsString()
  @IsUrl({}, { message: '请提供合法的 URL' })
  url!: string;

  @ApiProperty({ description: '正文最大字符数（500~20000，默认 6000）', required: false, example: 6000 })
  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(20_000)
  maxLength?: number;
}
