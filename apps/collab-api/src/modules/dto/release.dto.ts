// 应用版本发布 + 产物相关 DTO（class-validator，对齐现有 dto/ 模式）。
// 字段白名单由全局 ValidationPipe（whitelist + forbidNonWhitelisted）强制，杜绝越权字段透传。
// 所有字段 camelCase（与 /api/releases/* 及 /api/admin/releases/* 契约一致）。
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ASSET_ARCH, ASSET_PLATFORM, RELEASE_CHANNEL, RELEASE_STATUS } from './enums';

/** semver 正则（宽松，支持 1.0.0 / 1.0.0-beta，不严格校验 prerelease 复杂规则，够用且可读）。 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// === 平台 Admin 版本管理 DTO ===

/** POST /api/admin/releases 入参：创建一个 DRAFT 版本（需后续 publish 才公开可见）。 */
export class ReleaseCreateDto {
  @ApiProperty({ description: '语义化版本号（如 1.0.0，同 channel 内唯一）', example: '1.0.0' })
  @IsString()
  @Matches(SEMVER_RE, { message: 'version 必须符合 semver（如 1.0.0）' })
  version!: string;

  @ApiPropertyOptional({ description: '发布通道（默认 STABLE）', enum: RELEASE_CHANNEL })
  @IsOptional()
  @IsEnum(RELEASE_CHANNEL, { message: 'channel 只允许 STABLE 或 BETA' })
  channel?: (typeof RELEASE_CHANNEL)[number];

  @ApiPropertyOptional({ description: '版本标题（展示用）' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: '更新说明（markdown）' })
  @IsOptional()
  @IsString()
  notes?: string;
}

/** PATCH /api/admin/releases/:id 入参（全可选，未发布前可改任意字段；已发布后仅改 title/notes）。 */
export class ReleaseUpdateDto {
  @ApiPropertyOptional({ description: '版本标题' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: '更新说明（markdown）' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: '发布通道（改后需不与同版本号冲突）', enum: RELEASE_CHANNEL })
  @IsOptional()
  @IsEnum(RELEASE_CHANNEL, { message: 'channel 只允许 STABLE 或 BETA' })
  channel?: (typeof RELEASE_CHANNEL)[number];

  @ApiPropertyOptional({
    description: '首发时间（ISO 字符串，手动修正；null 清空）',
    example: '2026-06-17T10:00:00.000Z',
  })
  @IsOptional()
  @IsString()
  publishedAt?: string | null;
}

/** GET /api/admin/releases：轻量摘要列表分页与筛选。 */
export class AdminReleaseListQueryDto {
  @ApiPropertyOptional({ description: '页码（从 1 开始，默认 1）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 至少为 1' })
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（1-100，默认 20）', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 至少为 1' })
  @Max(100, { message: 'pageSize 最多为 100' })
  pageSize?: number;

  @ApiPropertyOptional({ description: '发布通道', enum: RELEASE_CHANNEL })
  @IsOptional()
  @IsEnum(RELEASE_CHANNEL, { message: 'channel 只允许 STABLE 或 BETA' })
  channel?: (typeof RELEASE_CHANNEL)[number];

  @ApiPropertyOptional({ description: '发布状态', enum: RELEASE_STATUS })
  @IsOptional()
  @IsEnum(RELEASE_STATUS, { message: 'status 只允许 DRAFT、PUBLISHED 或 ARCHIVED' })
  status?: (typeof RELEASE_STATUS)[number];

  @ApiPropertyOptional({ description: '版本号或标题关键词' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200, { message: 'q 最多为 200 字' })
  q?: string;
}

/** POST /api/admin/releases/:id/assets 入参：登记一个平台产物（外链下载地址）。 */
export class ReleaseAssetCreateDto {
  @ApiProperty({ description: '产物平台', enum: ASSET_PLATFORM })
  @IsEnum(ASSET_PLATFORM, { message: 'platform 只允许 WINDOWS / DARWIN / LINUX' })
  platform!: (typeof ASSET_PLATFORM)[number];

  @ApiProperty({ description: '产物架构', enum: ASSET_ARCH })
  @IsEnum(ASSET_ARCH, { message: 'arch 只允许 X86_64 / AARCH64 / UNIVERSAL' })
  arch!: (typeof ASSET_ARCH)[number];

  @ApiProperty({
    description: '下载直链（外链，https 优先）',
    example: 'https://github.com/.../LingFang_1.0.0_x64-setup.exe',
  })
  @IsString()
  @MinLength(1, { message: 'url 不能为空' })
  url!: string;

  @ApiPropertyOptional({ description: '展示用文件名' })
  @IsOptional()
  @IsString()
  filename?: string;

  @ApiPropertyOptional({ description: '安装包字节大小（< 2GB）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'sizeBytes 必须是整数' })
  @Min(0, { message: 'sizeBytes 不能为负' })
  @Max(2_000_000_000, { message: 'sizeBytes 超出 Int 范围（< 2GB）' })
  sizeBytes?: number;
}

/** POST /api/admin/release-signature 入参：CI 上报某平台产物的 minisign 发布者签名（幂等 upsert）。
 *  签名文本即 .minisig 内容（untrusted comment / base64 主签名 / trusted comment / base64 全局签名）。
 *  真实性最终由桌面壳用编译期内嵌公钥验签把关；本端仅做结构校验 + 鉴权 + 幂等写入。 */
export class ReleaseSignatureDto {
  @ApiProperty({ description: '语义化版本号（与发布版本一致）', example: '1.0.0' })
  @IsString()
  @Matches(SEMVER_RE, { message: 'version 必须符合 semver（如 1.0.0）' })
  version!: string;

  @ApiPropertyOptional({ description: '发布通道（默认 STABLE）', enum: RELEASE_CHANNEL })
  @IsOptional()
  @IsEnum(RELEASE_CHANNEL, { message: 'channel 只允许 STABLE 或 BETA' })
  channel?: (typeof RELEASE_CHANNEL)[number];

  @ApiProperty({ description: '产物平台', enum: ASSET_PLATFORM })
  @IsEnum(ASSET_PLATFORM, { message: 'platform 只允许 WINDOWS / DARWIN / LINUX' })
  platform!: (typeof ASSET_PLATFORM)[number];

  @ApiProperty({ description: '产物架构', enum: ASSET_ARCH })
  @IsEnum(ASSET_ARCH, { message: 'arch 只允许 X86_64 / AARCH64 / UNIVERSAL' })
  arch!: (typeof ASSET_ARCH)[number];

  @ApiProperty({ description: 'minisign 签名文本（.minisig 内容）' })
  @IsString()
  @MinLength(1, { message: 'signature 不能为空' })
  signature!: string;
}

// === 公开端点查询 DTO（query，由 ValidationPipe transform 自动绑定）===

/** GET /api/releases/latest?channel=&platform=&arch=&currentVersion= 入参（全可选）。 */
export class ReleaseLatestQueryDto {
  @ApiPropertyOptional({ description: '发布通道（默认 STABLE）', enum: RELEASE_CHANNEL })
  @IsOptional()
  @IsEnum(RELEASE_CHANNEL, { message: 'channel 只允许 STABLE 或 BETA' })
  channel?: (typeof RELEASE_CHANNEL)[number];

  @ApiPropertyOptional({ description: '产物平台（提供时附带匹配 asset）', enum: ASSET_PLATFORM })
  @IsOptional()
  @IsEnum(ASSET_PLATFORM)
  platform?: (typeof ASSET_PLATFORM)[number];

  @ApiPropertyOptional({ description: '产物架构', enum: ASSET_ARCH })
  @IsOptional()
  @IsEnum(ASSET_ARCH)
  arch?: (typeof ASSET_ARCH)[number];

  @ApiPropertyOptional({
    description: '当前版本（提供时返回 updateAvailable 标志）',
    example: '0.9.0',
  })
  @IsOptional()
  @IsString()
  currentVersion?: string;
}

/** GET /api/releases?channel=&limit= 入参。
 *  - channel 用 DTO（枚举校验）；limit 不放 DTO（number 在 query 的 @IsInt 与隐式转换有已知边界），
 *    改为 controller 层 @Query('limit') 单参数 + service 内 Number()，对齐 marketplace.search 的单参数模式。 */
export class ReleaseListQueryDto {
  @ApiPropertyOptional({ description: '发布通道（默认 STABLE）', enum: RELEASE_CHANNEL })
  @IsOptional()
  @IsEnum(RELEASE_CHANNEL)
  channel?: (typeof RELEASE_CHANNEL)[number];
}
