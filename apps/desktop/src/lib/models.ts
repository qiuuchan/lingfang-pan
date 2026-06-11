// 本地模型元数据（来自 models.dev，打包于 public/models-catalog.json）。
// 用于把网关返回的模型 id 美化成「正式名 + 性能信息」。
export interface ModelMeta {
  name: string;
  reasoning: boolean;
  tool_call: boolean;
  attachment: boolean;
  context: number | null;
  output: number | null;
  input_cost: number | null;
  output_cost: number | null;
  modalities: string[] | null;
}

let catalog: Record<string, ModelMeta> | null = null;
let loading: Promise<void> | null = null;

export async function loadModelCatalog(): Promise<void> {
  if (catalog) return;
  if (!loading) {
    loading = fetch('models-catalog.json', { cache: 'force-cache' })
      .then((r) => r.json())
      .then((j) => { catalog = j as Record<string, ModelMeta>; })
      .catch(() => { catalog = {}; });
  }
  await loading;
}

export function fmtContext(n: number | null | undefined): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export interface ModelLabel {
  label: string;
  meta: string[];
}

// 给定网关返回的 model id，返回展示名 + 性能标签数组。
export function modelLabel(id: string): ModelLabel {
  const m = catalog?.[id];
  const label = m?.name || id;
  const meta: string[] = [];
  if (m?.context) meta.push(`${fmtContext(m.context)} 上下文`);
  if (m?.reasoning) meta.push('推理');
  if (m?.tool_call) meta.push('工具调用');
  if (m?.attachment) meta.push('多模态');
  if (m?.input_cost != null) meta.push(`$${m.input_cost}/1M`);
  return { label, meta };
}
