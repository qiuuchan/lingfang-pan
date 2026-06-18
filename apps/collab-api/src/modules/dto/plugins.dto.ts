import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

// 插件图标存入 manifest.icon（字符串），上限防止 manifest JSON 膨胀。
// 取 64KB 字符（约 48KB 位图的 base64 data URI），超限 DTO 直接拒绝。
const ICON_MAX_LEN = 64 * 1024;

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

/** 作者设置插件定价请求体 DTO。与 SubmitMarketplaceDto 同结构（priceCents 语义一致），
 *  但走独立端点 POST /api/plugins/:id/set-price（不改源码、不触发审核流程）。 */
export class SetPluginPriceDto {
  @ApiPropertyOptional({ description: '定价（分）；undefined 保持原价，0 表示免费', example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'priceCents 必须是整数' })
  @Min(0, { message: 'priceCents 不能为负' })
  priceCents?: number;
}

/** 作者切换插件启用/禁用请求体 DTO。status 仅 ENABLED / DISABLED（与 Prisma PluginStatus 对齐）。
 *  走独立端点 POST /api/plugins/:id/set-status（仅作者/团队管理员，不改其他治理字段）。 */
export class SetPluginStatusDto {
  @ApiProperty({ description: '插件治理状态（ENABLED 启用 / DISABLED 禁用）', example: 'ENABLED' })
  @IsString()
  status!: 'ENABLED' | 'DISABLED';
}

/** 作者编辑插件元数据请求体 DTO（名称/描述/图标）。
 *  与 PluginPackageDto（编辑草稿）区别：不带 files、不重算 contentHash、不重置审核态，
 *  仅改展示信息，走独立端点 POST /api/plugins/:id/edit-meta。三字段均可选，service 兜底「至少一项」校验。 */
export class EditPluginMetaDto {
  @ApiPropertyOptional({ description: '插件名称（≤80 字符）' })
  @IsOptional()
  @IsString()
  @MaxLength(80, { message: '插件名称不能超过 80 字符' })
  name?: string;

  @ApiPropertyOptional({ description: '插件描述（≤500 字符，可为空串）' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: '插件描述不能超过 500 字符' })
  description?: string;

  @ApiPropertyOptional({ description: '插件图标：emoji 或位图 base64 data URI（不接受 svg，上限约 64KB 字符）' })
  @IsOptional()
  @IsString()
  @MaxLength(ICON_MAX_LEN, { message: '图标体积过大，请使用更小的图片' })
  icon?: string;
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
