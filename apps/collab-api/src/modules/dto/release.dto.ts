// 应用版本发布 + 产物相关 DTO（class-validator，对齐现有 dto/ 模式）。
// 字段白名单由全局 ValidationPipe（whitelist + forbidNonWhitelisted）强制，杜绝越权字段透传。
// 所有字段 camelCase（与 /api/releases/* 及 /api/admin/releases/* 契约一致）。
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUrl, Matches, Max, Min, MinLength } from 'class-validator';
import { ASSET_ARCH, ASSET_PLATFORM, RELEASE_CHANNEL } from './enums';

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
}

/** POST /api/admin/releases/:id/assets 入参：登记一个平台产物（外链下载地址）。 */
export class ReleaseAssetCreateDto {
  @ApiProperty({ description: '产物平台', enum: ASSET_PLATFORM })
  @IsEnum(ASSET_PLATFORM, { message: 'platform 只允许 WINDOWS / DARWIN / LINUX' })
  platform!: (typeof ASSET_PLATFORM)[number];

  @ApiProperty({ description: '产物架构', enum: ASSET_ARCH })
  @IsEnum(ASSET_ARCH, { message: 'arch 只允许 X86_64 / AARCH64 / UNIVERSAL' })
  arch!: (typeof ASSET_ARCH)[number];

  @ApiProperty({ description: '下载直链（外链，https 优先）', example: 'https://github.com/.../LingFang_1.0.0_x64-setup.exe' })
  @IsString()
  @MinLength(1, { message: 'url 不能为空' })
  url!: string;

  @ApiPropertyOptional({ description: '展示用文件名' })
  @IsOptional()
  @IsString()
  filename?: string;

  @ApiPropertyOptional({ description: 'Tauri updater base64 签名（未接入 updater 时留空）' })
  @IsOptional()
  @IsString()
  signature?: string;

  @ApiPropertyOptional({ description: '安装包字节大小（< 2GB）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'sizeBytes 必须是整数' })
  @Min(0, { message: 'sizeBytes 不能为负' })
  @Max(2_000_000_000, { message: 'sizeBytes 超出 Int 范围（< 2GB）' })
  sizeBytes?: number;
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

  @ApiPropertyOptional({ description: '当前版本（提供时返回 updateAvailable 标志）', example: '0.9.0' })
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

/** GET /api/releases/tauri-update?channel=&platform=&arch=&current_version= 入参（Tauri updater 契约端点）。
 *  - 全可选：channel 缺省 STABLE；platform/arch 宽松接收（不强制 IsEnum），Tauri 上报值与后端枚举不匹配时
 *    service 找不到匹配 asset 即返 null → controller 返 204（Tauri updater 把非 200 当「无更新」）。
 *  - 注意 query key 用 current_version（下划线，Tauri updater 协议约定），与 latest 的 currentVersion 区分。 */
export class ReleaseTauriQueryDto {
  @ApiPropertyOptional({ description: '发布通道（默认 STABLE）', enum: RELEASE_CHANNEL })
  @IsOptional()
  @IsEnum(RELEASE_CHANNEL)
  channel?: (typeof RELEASE_CHANNEL)[number];

  @ApiPropertyOptional({ description: '产物平台（WINDOWS / DARWIN / LINUX，宽松接收任意字符串）' })
  @IsOptional()
  @IsString()
  platform?: string;

  @ApiPropertyOptional({ description: '产物架构（X86_64 / AARCH64 / UNIVERSAL，宽松接收任意字符串）' })
  @IsOptional()
  @IsString()
  arch?: string;

  @ApiPropertyOptional({ description: '当前版本（Tauri updater 上报，仅用于日志/审计，不参与版本判定）', example: '0.0.1' })
  @IsOptional()
  @IsString()
  current_version?: string;
}
