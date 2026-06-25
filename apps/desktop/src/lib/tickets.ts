// 帮助与反馈工单：前台 API 边界 + 类型。
// 提交/回复走 multipart（FormData），下载附件需 Bearer，故用 fetch + blob 触发下载（不能用裸链接）。
import { api, apiBase, getAuthToken } from '@/lib/api';

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
}

export interface TicketDetail extends Omit<TicketSummary, 'messageCount' | 'attachmentCount'> {
  teamId: string | null;
  messages: TicketMessage[];
  attachments: TicketAttachment[];
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

/** 提交工单（multipart：title/body/category + files[]）。 */
export async function submitTicket(input: { title: string; body: string; category: TicketCategory; files: File[] }) {
  const form = new FormData();
  form.append('title', input.title);
  form.append('body', input.body);
  form.append('category', input.category);
  for (const f of input.files) form.append('files', f);
  return api<{ ticket: TicketDetail }>('/api/tickets', { method: 'POST', formData: form });
}

/** 本人工单列表。 */
export async function listMyTickets(status?: TicketStatus) {
  const qs = status ? `?status=${status}` : '';
  return api<{ tickets: TicketSummary[] }>(`/api/tickets${qs}`);
}

/** 本人工单详情。 */
export async function getMyTicket(id: string) {
  return api<{ ticket: TicketDetail }>(`/api/tickets/${id}`);
}

/** 用户追加回复（multipart：body + files[]）。 */
export async function replyTicket(id: string, input: { body: string; files: File[] }) {
  const form = new FormData();
  if (input.body) form.append('body', input.body);
  for (const f of input.files) form.append('files', f);
  return api<{ ticket: TicketDetail }>(`/api/tickets/${id}/messages`, { method: 'POST', formData: form });
}

/** 下载附件：需 Bearer，故 fetch 取 blob 后用临时 <a> 触发下载。 */
export async function downloadAttachment(ticketId: string, attachment: TicketAttachment) {
  const base = apiBase();
  const token = getAuthToken();
  const res = await fetch(`${base}/api/tickets/${ticketId}/attachments/${attachment.id}`, {
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

/** 人类可读的文件大小。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
