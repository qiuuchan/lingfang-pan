// 插件草稿与相关实体的前端类型（与后端 contract 对齐，宽松定义）。
export interface Session {
  token: string | null;
  userId: string | null;
  displayName: string | null;
  tenantId: string | null;
  tenantName: string | null;
  role: string | null;
  isPlatformAdmin: boolean;
}

export interface DraftTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface DraftFile {
  path: string;
  content: string;
}

export interface DraftDiagnostic {
  stage: string;
  status: string;
  message: string;
}

export interface PluginDraft {
  id: string;
  status: string;
  files: DraftFile[];
  turns: DraftTurn[];
  diagnostics: DraftDiagnostic[];
  [k: string]: unknown;
}

export interface LoadedPlugin {
  id: string;
  name: string;
  description?: string;
  version: string;
  builtin?: boolean;
  entry: string;
  // 数据来源：builtin=本地内置（Tauri 读盘）；published=本租户发布；installed=从市场安装（均走后端读文件）。
  source?: 'builtin' | 'published' | 'installed';
}

export interface GatewayConfig {
  name?: string;
  base_url?: string;
  models?: string[];
}

export type View = 'generator' | 'plugins' | 'market' | 'wallet' | 'review' | 'settings';
