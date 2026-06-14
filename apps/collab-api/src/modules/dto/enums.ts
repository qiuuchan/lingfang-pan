// 各 @Body DTO 共用的字面量联合枚举常量。
// 与 prisma/schema.prisma 的 enum 大写值一一对应（运行时以大写串校验）。
// 提取为常量而非直接内联字符串数组，避免多处重复后漂移。

/** 用户状态：启用 / 禁用（与 UserStatus 对齐）。 */
export const USER_STATUS = ['ACTIVE', 'DISABLED'] as const;
/** 平台角色：普通 / 平台管理员（与 PlatformRole 对齐）。 */
export const PLATFORM_ROLE = ['NONE', 'PLATFORM_ADMIN'] as const;
/** 团队状态：启用 / 挂起（团队软删除用 SUSPENDED）。 */
export const TEAM_STATUS = ['ACTIVE', 'SUSPENDED'] as const;
/** 插件启用状态（与 PluginStatus 对齐）。 */
export const PLUGIN_STATUS = ['ENABLED', 'DISABLED'] as const;
/** 余额调整方向：加款 / 扣款（与 BalanceDirection 对齐）。 */
export const BALANCE_DIRECTION = ['CREDIT', 'DEBIT'] as const;

// === LLM 网关目录相关常量 ===

/** LLM 网关提供方白名单（平台维护，provider 为 String 非 enum，design.md D2）。
 *  seed 默认网关用这些值；custom 兜底自建网关。Service 层校验 provider 属于此集合。 */
export const LLM_PROVIDER = [
  'openai',
  'anthropic',
  'azure',
  'deepseek',
  'moonshot',
  'qwen',
  'custom',
] as const;

/** LLM 网关状态（与 LlmGatewayStatus 对齐，ENABLED 租户可见 / DISABLED 软删除）。 */
export const LLM_GATEWAY_STATUS = ['ENABLED', 'DISABLED'] as const;

// === 应用版本发布相关常量 ===

/** 发布通道（与 ReleaseChannel 对齐，STABLE 正式 / BETA 预览）。 */
export const RELEASE_CHANNEL = ['STABLE', 'BETA'] as const;
/** 发布状态（与 ReleaseStatus 对齐，DRAFT 草稿 / PUBLISHED 已发布 / ARCHIVED 已归档）。 */
export const RELEASE_STATUS = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
/** 产物平台（与 AssetPlatform 对齐，WINDOWS / DARWIN=macOS / LINUX）。 */
export const ASSET_PLATFORM = ['WINDOWS', 'DARWIN', 'LINUX'] as const;
/** 产物架构（与 AssetArch 对齐，X86_64 / AARCH64 / UNIVERSAL）。 */
export const ASSET_ARCH = ['X86_64', 'AARCH64', 'UNIVERSAL'] as const;
