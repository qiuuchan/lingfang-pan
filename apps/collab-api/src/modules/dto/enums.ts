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
