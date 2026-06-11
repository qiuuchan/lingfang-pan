// LingFang 平台契约：单一事实来源（见 docs/02 领域模型）。
// 服务端（Rust）按相同字段实现；插件 SDK 复用这些类型。契约漂移即视为缺陷。
export * from './identity';
export * from './plugin';
export * from './draft';
export * from './llm';
