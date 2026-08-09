// 灵坊 Node 插件入口（第三方 AI SDK 缺陷探针）
//
// 故意依赖第三方 AI SDK。引擎的静态分析只看硬编码 key/url/provider/model，不会剥离 SDK 依赖，
// 因此适配报告是 ADAPTED_PASSED、remaining=0；但服务端 assertPluginAiPolicy 会把
// require('@anthropic-ai/sdk') 与 package.json 里的依赖判为 ai.sdk.third_party 拒绝发布。
// 这就是「引擎判通过 ↔ 服务端拒收」的不对齐：作者拿到「适配通过」却发不上去，
// 且引擎侧没有任何指向该 SDK 的诊断可看。
try {
  const Anthropic = require('@anthropic-ai/sdk');
  void Anthropic;
} catch {
  // 本地没装该依赖也能跑：本样例只演示「静态依赖声明」会被服务端策略闸门拦下。
}

// 普通网络请求 —— 用于触发 net.fetch 能力探测。
async function run() {
  const endpoint = 'https://example.invalid/v1/invoke';
  await fetch(endpoint, { method: 'POST', body: '{}' }).catch(() => undefined);
}

run();

// 常驻一小会儿：运行时确证的 short_run 要求启动后不立即退出。
setTimeout(() => process.exit(0), 6000);
