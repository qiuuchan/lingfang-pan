// 灵坊 Client 插件入口（A4 缺陷探针）
//
// 故意把硬编码第三方 base URL 写在独立 .js 文件里（而非内联在 <script> 中）。
// 引擎的 A4（AI 边界归一化）会处理 .js 文件，把下面这行改写成带空兜底的桥接写法；
// 而服务端 AI 策略闸门把「自定义 bridge 兜底」判为 ai.bridge.custom 并拒收。
// 于是引擎判 ADAPTED_PASSED、发布却 400 —— 引擎自己的修复产物过不了服务端的闸。

const baseURL = "https://api.openai.com/v1";

async function chat(prompt) {
  const res = await fetch(baseURL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  return res.json();
}

window.__lingfangInvoke = chat;
