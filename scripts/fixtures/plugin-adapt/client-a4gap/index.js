// 灵坊 Client 插件入口（A4 缺陷探针）
//
// 故意把硬编码第三方 base URL 写成**顶层 const 赋值**（而不是对象字面量的属性）。
// 引擎 A4（AI 边界归一化）按「对象属性」的形状做替换，于是把
//     const baseURL = "https://api.openai.com/v1";
// 改写成
//     const baseURL:(typeof process!=='undefined'?(...):'')+'/v1';
// —— `=` 被吃掉，产物是语法非法的 JS（SyntaxError: Missing initializer in const declaration）。
// 而 client 运行时确证只做 HTML 有效性 + 桥握手，不会 node --check 脚本，
// 于是报告仍是 ADAPTED_PASSED / canRun=true，坏掉的产物一路发布成功。

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
