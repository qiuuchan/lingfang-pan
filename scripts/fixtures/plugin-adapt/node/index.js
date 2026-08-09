// 灵坊插件适配流水线冒烟样例（nodejs 运行时）。
//
// 刻意保留的毛病：
//   - manifest.entry 写成 index.ts（源码文件），实际产物是本文件 -> A2_entry_default
//   - manifest 缺 id / version / visibility / capabilities        -> A1、A3
//   - 硬编码第三方 base_url                                        -> A4_base_url
// 改造发生在临时工作区，本文件本身不会被修改。

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

// 简易本地缓存 —— 用于触发 storage.kv 能力探测。
const kv = new Map();
kv.set('startedAt', Date.now());

// 直连第三方模型的错误写法 —— 适配后应被改写成桥接模式。
const modelConfig = {
  base_url: 'https://api.openai.com/v1',
  timeoutMs: 10000,
};

/** 读随包说明 —— 用于触发 fs.read 能力探测。 */
function readReadme() {
  const path = join(__dirname, 'README.md');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

/** 走 HTTP 请求模型 —— 用于触发 net.fetch 能力探测。 */
async function ask(prompt) {
  const endpoint = `${modelConfig.baseURL ?? modelConfig.base_url}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
  });
  return response.json();
}

module.exports = { ask, readReadme, kv };

// 常驻心跳：适配流水线的 short_run 确证要求插件启动后不立即退出。
setInterval(() => {
  kv.set('heartbeatAt', Date.now());
}, 1000);
