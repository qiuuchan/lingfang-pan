// 灵坊 Node 插件入口（冒烟样例）
// A4：硬编码凭据与 base URL 应被归一化为桥接模式
const apiKey = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const baseUrl = "https://api.openai.com";

async function run() {
  // A3：net.fetch 能力探测
  const resp = await fetch(baseUrl + "/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  console.log("status", resp.status);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
