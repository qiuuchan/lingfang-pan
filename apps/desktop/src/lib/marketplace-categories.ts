// marketplace-categories.ts — 插件市场自动分类（Task 1）。
//
// 不依赖后端新增字段：根据插件的 name / description / capabilities / runtime 做关键词匹配，
// 自动归入预设分类。匹配优先级按 CATEGORIES 数组顺序（更具体的分类放前面，兜底 'other'）。
// 后端若将来下发 category 字段，可在此优先采用（见 categorizePlugin 注释）。
export interface MarketPlugin {
  id: string;
  name: string;
  description?: string;
  manifest?: unknown;
  capabilities?: unknown[];
  [key: string]: unknown;
}

export type CategoryKey =
  | 'ai'
  | 'productivity'
  | 'dev'
  | 'files'
  | 'data'
  | 'media'
  | 'network'
  | 'system'
  | 'other';

export interface PluginCategory {
  key: CategoryKey;
  label: string;
  /** 匹配关键词（小写）；命中 name/description/capabilities/runtime 任意即归此类。 */
  keywords: string[];
}

// 预置分类标签（Task 1「为市场界面预置一系列分类标签」）。顺序即匹配优先级。
export const CATEGORIES: PluginCategory[] = [
  {
    key: 'ai',
    label: 'AI 与助手',
    // 关键词从严：避免「生成/智能」等泛词误吞 productivity（如「会议纪要生成器」）。
    keywords: ['ai', 'gpt', 'llm', '助手', '对话', 'chat', '总结', '翻译', '摘要', 'assistant', '写作', '大模型'],
  },
  {
    key: 'productivity',
    label: '效率与办公',
    keywords: ['笔记', 'note', 'todo', '任务', '待办', '日历', '会议', '纪要', '效率', '清单', '备忘', '事项', '看板', 'kanban'],
  },
  {
    key: 'dev',
    label: '开发工具',
    keywords: ['代码', '开发', 'code', 'dev', 'git', '构建', '编译', '调试', 'debug', '工具链', 'sdk', '命令行', 'cli', '终端'],
  },
  {
    key: 'data',
    label: '数据与可视化',
    // 关键词具体化：去掉泛词「数据/分析」（「抓取接口数据」「静态分析与调试」会误命中），
    // 改用「数据可视化/数据分析」等组合词 + 可视化/图表/统计等明确信号。
    keywords: ['可视化', '数据可视化', '数据分析', 'chart', '图表', '统计', '报表', 'excel', '表格', 'csv', 'bi', 'dashboard'],
  },
  {
    key: 'media',
    label: '图像与多媒体',
    keywords: ['图片', '图像', '视频', '音频', '音乐', 'image', 'video', 'audio', '音乐', '换衣', '美颜', '剪辑', '压缩', '转码', '水印'],
  },
  {
    key: 'files',
    label: '文件与存储',
    keywords: ['文件', 'file', '资源管理', '目录', '搜索文件', '同步', '云盘', '备份', 'archive', 'zip', '解压'],
  },
  {
    key: 'network',
    label: '网络与接口',
    keywords: ['网络', '请求', 'http', 'api', '爬虫', '抓取', '代理', 'proxy', '测速', 'dns', '下载器'],
  },
  {
    key: 'system',
    label: '系统与监控',
    keywords: ['系统', '监控', '性能', 'system', 'info', '进程', '硬件', 'cpu', '内存', '磁盘', '网络监控', '通知'],
  },
];

const CATEGORY_BY_KEY: Record<CategoryKey, PluginCategory> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c]),
) as Record<CategoryKey, PluginCategory>;

const OTHER: PluginCategory = { key: 'other', label: '其他', keywords: [] };

/** 取插件可参与匹配的文本（name + description + capabilities kind + runtime），统一小写。 */
function pluginText(plugin: MarketPlugin): string {
  const parts: string[] = [plugin.name ?? '', plugin.description ?? ''];
  if (Array.isArray(plugin.capabilities)) {
    for (const cap of plugin.capabilities) {
      if (typeof cap === 'string') parts.push(cap);
      else if (cap && typeof cap === 'object') {
        const kind = (cap as Record<string, unknown>).kind;
        if (typeof kind === 'string') parts.push(kind);
      }
    }
  }
  // runtime_type 若挂在 MarketPlugin 上也纳入（部分后端会带）。
  const rt = (plugin as MarketPlugin & { runtime_type?: string }).runtime_type;
  if (rt) parts.push(rt);
  return parts.join(' ').toLowerCase();
}

/**
 * 自动分类单个插件（Task 1 核心）。
 * 优先级：后端显式 category > 关键词匹配 > 'other'。
 */
export function categorizePlugin(plugin: MarketPlugin): CategoryKey {
  // 后端若已下发 category 且命中预置分类，优先采用（向前兼容）。
  const explicit = (plugin as MarketPlugin & { category?: string }).category;
  if (typeof explicit === 'string' && explicit) {
    const hit = CATEGORIES.find((c) => c.key === explicit || c.label === explicit);
    if (hit) return hit.key;
  }
  const text = pluginText(plugin);
  for (const cat of CATEGORIES) {
    if (cat.keywords.some((kw) => text.includes(kw))) return cat.key;
  }
  return 'other';
}

/** 分类标签展示名。 */
export function categoryLabel(key: CategoryKey): string {
  return (CATEGORY_BY_KEY[key] || OTHER).label;
}

/** 用于「全部」入口的聚合分类（顺序 = 展示顺序，含「全部」）。 */
export interface CategoryTab { key: CategoryKey | 'all'; label: string }

export const CATEGORY_TABS: CategoryTab[] = [
  { key: 'all', label: '全部' },
  ...CATEGORIES.map((c) => ({ key: c.key, label: c.label })),
];

/**
 * 按分类过滤插件列表。key='all' 返回全部；否则返回该分类下的插件。
 * 同时可叠加关键字 q（子串匹配 name/description，与现有搜索语义一致）。
 */
export function filterByCategory(plugins: MarketPlugin[], key: CategoryKey | 'all', q: string): MarketPlugin[] {
  const query = q.trim().toLowerCase();
  return plugins.filter((p) => {
    if (key !== 'all' && categorizePlugin(p) !== key) return false;
    if (query) {
      const hay = `${p.name ?? ''} ${p.description ?? ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}
