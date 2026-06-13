import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsObject, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

/** 插件包内单个文件条目：相对路径 + 文本内容。
 *  路径穿越/字节上限等业务校验由 normalizePluginPackage 负责（保留），DTO 仅校验类型。 */
export class PluginFileDto {
  @ApiProperty({ description: '文件相对路径（不可为绝对路径或含 ..）' })
  @IsString()
  path!: string;

  @ApiProperty({ description: '文件内容（UTF-8 文本）' })
  @IsString()
  content!: string;
}

/** 插件 manifest。字段名容忍 runtime_type/runtimeType 双写法，
 *  具体的 runtime/visibility/能力白名单由 normalizePluginPackage 统一归一与校验。
 *  capabilities 结构与 plugin-package.ts 的 PluginManifestInput 对齐，
 *  保证 PluginPackageDto 结构兼容 PluginPackageInput（service 入参类型）。 */
export class PluginManifestDto {
  @IsOptional() @IsString() id?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() version?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() runtime_type?: string;
  @IsOptional() @IsString() runtimeType?: string;
  @IsOptional() @IsString() entry?: string;
  @IsOptional() @IsString() visibility?: string;
  @IsOptional()
  @IsArray()
  capabilities?: Array<{ kind?: string; reason?: string; risk?: string; requires_admin?: boolean; scope?: unknown }>;
}

/** 上传/编辑插件草稿请求体 DTO。 */
export class PluginPackageDto {
  @ApiPropertyOptional({ description: '插件 manifest 描述对象' })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PluginManifestDto)
  manifest?: PluginManifestDto;

  @ApiPropertyOptional({ description: '插件文件条目数组（至少 1 项）', type: [PluginFileDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'files 不能为空' })
  @ValidateNested({ each: true })
  @Type(() => PluginFileDto)
  files?: PluginFileDto[];

  @ApiPropertyOptional({ description: '定价（分），非负整数；未传保持原价' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'priceCents 必须是整数' })
  @Min(0, { message: 'priceCents 不能为负' })
  priceCents?: number;
}

/** 提交插件到市场审核请求体 DTO。priceCents 语义：undefined 保持原价、0 免费化。 */
export class SubmitMarketplaceDto {
  @ApiPropertyOptional({ description: '定价（分）；undefined 保持原价，0 表示免费' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'priceCents 必须是整数' })
  @Min(0, { message: 'priceCents 不能为负' })
  priceCents?: number;
}

/** 市场插件安装请求体 DTO。 */
export class MarketplaceInstallDto {
  @ApiProperty({ description: '要安装的市场插件 ID' })
  @IsString()
  plugin_id!: string;
}

/** 市场插件评分请求体 DTO。score 为 1-5 的整数。 */
export class MarketplaceRateDto {
  @ApiProperty({ description: '要评分的市场插件 ID' })
  @IsString()
  plugin_id!: string;

  @ApiProperty({ description: '评分（1-5 整数）', minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt({ message: 'score 必须是整数' })
  @Min(1, { message: 'score 至少为 1' })
  @Max(5, { message: 'score 最大为 5' })
  score!: number;

  @ApiPropertyOptional({ description: '评分评论' })
  @IsOptional()
  @IsString()
  comment?: string;
}
