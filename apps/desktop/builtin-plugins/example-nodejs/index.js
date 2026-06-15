// =============================================================================
// 示例 Node.js 插件入口（runtime_type: nodejs）
// -----------------------------------------------------------------------------
// 本文件是 LingFang 桌面壳「nodejs 脚本型插件」的参考实现，供大模型生成 nodejs
// 插件时对齐结构与约定。脚本由桌面壳 plugin_script::run_plugin_script 命令在
// app_data/plugin-sandbox/<plugin_id> 下落盘后带超时一次性执行（无参数）。
//
// 关键约束（开发者务必遵守，否则预览/运行会失败）：
// 1. 入口必须是 CommonJS（require/module.exports），不要用 ESM import（sandbox 未配 package.json type:module）。
// 2. stdout 是唯一与用户交互的「结果通道」——桌面壳把 stdout 视为插件输出展示给用户；
//    stderr 仅用于诊断信息（不进主结果区）。故结构化结果请用 console.log 输出到 stdout。
// 3. 中文输出无需特殊处理：Rust 侧已对 node 进程注入 UTF-8 环境，中文不会乱码。
// 4. 禁止死循环 / 阻塞读 stdin——run_plugin_script 默认 15s 超时后会强杀进程组（含孙进程）。
// 5. 脚本运行在用户权限下，等价于本地 `node index.js`：可读写用户文件、发起网络请求、
//    spawn 子进程。请勿执行破坏性操作（删除重要目录、覆盖系统文件等）。
// 6. 依赖：仅可用 Node.js 内置模块（fs/path/os 等）。sandbox 不含 node_modules，
//    第三方包需脚本内联或改走 cloud 运行时。
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

// -----------------------------------------------------------------------------
// 示例功能：一个简易「数据处理器」——生成一批示例订单，做分组统计与汇总，
// 输出结构化 JSON 结果到 stdout（便于宿主或后续插件解析）。
// 选这个例子的理由：覆盖「数据生成 → 内存计算 → 结构化输出」三类典型场景，
// 比 hello world 更能体现脚本型插件的价值。
// -----------------------------------------------------------------------------

/** 生成示例订单数据（模拟从外部数据源读入，此处用内存构造避免文件依赖）。 */
function generateSampleOrders(count) {
  const categories = ['办公', '餐饮', '差旅', '软件', '硬件'];
  const orders = [];
  for (let i = 0; i < count; i++) {
    orders.push({
      id: `ORD-${String(i + 1).padStart(4, '0')}`,
      category: categories[i % categories.length],
      amount: Math.round((Math.random() * 1000 + 50) * 100) / 100, // 保留两位小数
      createdAt: new Date(Date.now() - i * 3600_000).toISOString(),
    });
  }
  return orders;
}

/** 按类目分组统计：每个类目的订单数与金额合计。 */
function summarizeByCategory(orders) {
  const map = new Map();
  for (const order of orders) {
    const entry = map.get(order.category) || { category: order.category, count: 0, totalAmount: 0 };
    entry.count += 1;
    entry.totalAmount = Math.round((entry.totalAmount + order.amount) * 100) / 100;
    map.set(order.category, entry);
  }
  // 按金额降序，便于用户一眼看到主力类目。
  return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount);
}

// -----------------------------------------------------------------------------
// 主流程：生成 → 统计 → 汇总 → 结构化输出。
// 约定：stdout 输出两段——
//   1. 人类可读的摘要行（console.log 文本，用户在结果区直接看到）。
//   2. 一行 JSON（结构化结果，供宿主或下游插件解析；以 RESULT_JSON: 前缀标记便于提取）。
// stderr 输出诊断信息（不计入主结果，仅在排障时可见）。
// -----------------------------------------------------------------------------
function main() {
  const orderCount = 128; // 示例数据量：128 条订单
  const startedAt = Date.now();

  console.log(`[示例 Node.js 插件] 开始处理 ${orderCount} 条示例订单`);
  console.log(`运行环境：Node ${process.version} | 主机 ${os.hostname()} | PID ${process.pid}`);

  const orders = generateSampleOrders(orderCount);
  const summary = summarizeByCategory(orders);

  const totalAmount = Math.round(summary.reduce((sum, s) => sum + s.totalAmount, 0) * 100) / 100;
  const topCategory = summary[0];

  console.log('--- 处理结果 ---');
  console.log(`订单总数：${orders.length}`);
  console.log(`金额合计：¥${totalAmount.toFixed(2)}`);
  console.log(`主力类目：${topCategory.category}（¥${topCategory.totalAmount.toFixed(2)}，${topCategory.count} 单）`);
  console.log('类目明细：');
  for (const s of summary) {
    console.log(`  - ${s.category}：${s.count} 单，合计 ¥${s.totalAmount.toFixed(2)}`);
  }

  // 结构化结果（一行 JSON，带前缀便于宿主提取）。
  const result = {
    plugin: 'builtin.example-nodejs',
    runtime: 'nodejs',
    processedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    summary: {
      orderCount: orders.length,
      totalAmount,
      topCategory: topCategory.category,
      byCategory: summary,
    },
  };
  console.log(`RESULT_JSON: ${JSON.stringify(result)}`);

  // 诊断信息走 stderr（不污染 stdout 主结果区）。
  console.error(`[诊断] 内存占用 RSS=${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MB`);
  console.error(`[诊断] 耗时 ${result.elapsedMs}ms`);

  // 显式 exit 0 让宿主判定成功（脚本自然结束也会 exit 0，显式更清晰）。
  process.exit(0);
}

main();
