// 帮助与反馈工单：后台 admin API 客户端 + 类型。
// 提交回复走 multipart（FormData，与 release uploadAsset 同款）；附件下载需 Bearer，故 fetch+blob 触发。
import { api, apiBase, getToken } from '@/lib/api';

export type TicketCategory = 'BUG' | 'FEATURE' | 'ACCOUNT' | 'OTHER';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type TicketPriority = 'LOW' | 'NORMAL' | 'HIGH';
export type TicketAttachmentKind = 'LOG' | 'IMAGE' | 'OTHER';

export interface TicketAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: TicketAttachmentKind;
  createdAt: string;
}

export interface TicketMessage {
  id: string;
  authorRole: 'USER' | 'ADMIN';
  authorUserId: string;
  body: string;
  createdAt: string;
  attachments: TicketAttachment[];
}

export interface TicketRef {
  id: string;
  displayName: string | null;
}

export interface TicketSummary {
  id: string;
  category: TicketCategory;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  messageCount: number;
  attachmentCount: number;
  lastReplyAt: string | null;
  createdAt: string;
  updatedAt: string;
  submitter: { id: string; displayName: string; email: string } | null;
  team: { id: string; name: string } | null;
  handler: TicketRef | null;
}

export interface TicketDetail {
  id: string;
  category: TicketCategory;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  teamId: string | null;
  lastReplyAt: string | null;
  createdAt: string;
  updatedAt: string;
  submitter: { id: string; displayName: string; email: string } | null;
  team: { id: string; name: string } | null;
  handler: TicketRef | null;
  messages: TicketMessage[];
  attachments: TicketAttachment[];
}

export interface AdminTicketListResult {
  items: TicketSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  BUG: '问题反馈',
  FEATURE: '功能建议',
  ACCOUNT: '账号相关',
  OTHER: '其他',
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: '待处理',
  IN_PROGRESS: '处理中',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  LOW: '低',
  NORMAL: '普通',
  HIGH: '高',
};

export interface AdminTicketListQuery {
  status?: TicketStatus;
  category?: TicketCategory;
  teamId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

/** 工单列表（筛选 + 分页）。 */
export async function listAdminTickets(query: AdminTicketListQuery, signal?: AbortSignal): Promise<AdminTicketListResult> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.category) params.set('category', query.category);
  if (query.teamId) params.set('teamId', query.teamId);
  if (query.q) params.set('q', query.q);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const qs = params.toString();
  return api<AdminTicketListResult>(`/api/admin/tickets${qs ? `?${qs}` : ''}`, { signal });
}

/** 工单详情。 */
export async function getAdminTicket(id: string): Promise<{ ticket: TicketDetail }> {
  return api<{ ticket: TicketDetail }>(`/api/admin/tickets/${id}`);
}

/** 管理员回复（multipart：body + files[]）。 */
export async function replyAdminTicket(id: string, input: { body: string; files: File[] }): Promise<{ ticket: TicketDetail }> {
  const form = new FormData();
  if (input.body) form.append('body', input.body);
  for (const f of input.files) form.append('files', f);
  return api<{ ticket: TicketDetail }>(`/api/admin/tickets/${id}/messages`, { method: 'POST', formData: form });
}

/** 变更状态/优先级。 */
export async function updateAdminTicket(id: string, body: { status?: TicketStatus; priority?: TicketPriority }): Promise<{ ticket: TicketDetail }> {
  return api<{ ticket: TicketDetail }>(`/api/admin/tickets/${id}`, { method: 'PATCH', body });
}

/** 下载附件：需 Bearer，fetch 取 blob 后用临时 <a> 触发。 */
export async function downloadAttachment(ticketId: string, attachment: TicketAttachment): Promise<void> {
  const token = getToken();
  const res = await fetch(`${apiBase()}/api/admin/tickets/${ticketId}/attachments/${attachment.id}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error('附件下载失败');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
