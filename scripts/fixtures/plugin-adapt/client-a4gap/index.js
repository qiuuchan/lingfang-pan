// 灵坊 Client 插件入口（A4 改写破坏 · 缺陷探针）
//
// 探针形状：把待归一化的第三方 base URL 写成**顶层 const 赋值**，而不是对象字面量的属性。
// 引擎 A4（AI 边界归一化）按「对象属性」的形状做替换，会把赋值号一起吃掉，
// 产出 `const baseURL:(...)` 这种语法非法的 JS
// （node --check 报 SyntaxError: Missing initializer in const declaration）。
//
// 而 client 运行时确证只做 HTML 有效性 + 桥握手，不会 node --check 脚本，
// 所以报告仍是 canRun=true，坏掉的产物照样打包发布。
//
// 注意：本文件注释里不要出现任何字面量 URL，否则会额外触发服务端策略诊断、掩盖真正要看的缺陷。

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
