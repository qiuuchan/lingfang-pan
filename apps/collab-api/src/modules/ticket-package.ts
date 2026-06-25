// 工单系统纯函数（附件校验、kind 推断、状态机转移）。
// 抽离为纯函数便于单测直接断言，无需 mock Prisma 或文件系统（与 plugin-package.ts 同款思路）。
import { badRequest } from '../common';

/** 单个附件上传上限（10MB）。日志/截图场景足够，避免超大文件占满磁盘。 */
export const MAX_TICKET_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** 单次请求附件数量上限。 */
export const MAX_TICKET_ATTACHMENTS = 5;
/** 标题长度上限。 */
export const MAX_TICKET_TITLE_LEN = 200;
/** 单条消息正文长度上限。 */
export const MAX_TICKET_BODY_LEN = 10_000;

/** 允许的附件 MIME 前缀/精确值白名单（日志文本 + 常见图片 + JSON）。 */
const ALLOWED_MIME_EXACT = new Set([
  'application/json',
  'application/x-ndjson',
  'application/octet-stream', // .log 有时被识别为此，配合扩展名白名单放行
]);
const ALLOWED_MIME_PREFIX = ['text/', 'image/'];
/** 允许的图片 MIME（精确，用于 kind 推断与额外校验）。 */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** 允许的扩展名白名单（兜底 octet-stream 的日志/文本类文件）。 */
const ALLOWED_EXT = new Set(['.log', '.txt', '.json', '.ndjson', '.csv', '.yaml', '.yml', '.png', '.jpg', '.jpeg', '.webp', '.gif']);

export type TicketAttachmentKindValue = 'LOG' | 'IMAGE' | 'OTHER';

/** 从文件名取小写扩展名（含点），无扩展名返回空串。 */
export function fileExt(filename: string): string {
  const m = /(\.[a-zA-Z0-9]+)$/.exec(filename.trim());
  return m ? m[1].toLowerCase() : '';
}

/** 判断 MIME + 文件名是否在允许范围内。 */
export function isAllowedAttachment(mimeType: string, filename: string): boolean {
  const mime = (mimeType || '').toLowerCase();
  const ext = fileExt(filename);
  if (ALLOWED_MIME_PREFIX.some((p) => mime.startsWith(p))) return true;
  if (ALLOWED_MIME_EXACT.has(mime) && ALLOWED_EXT.has(ext)) return true;
  // 兜底：MIME 不可信但扩展名在白名单（如 application/octet-stream 的 .log）。
  if (ALLOWED_EXT.has(ext)) return true;
  return false;
}

/** 由 MIME + 文件名推断附件 kind。 */
export function inferAttachmentKind(mimeType: string, filename: string): TicketAttachmentKindValue {
  const mime = (mimeType || '').toLowerCase();
  const ext = fileExt(filename);
  if (mime.startsWith('image/') || IMAGE_MIME.has(mime) || ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'IMAGE';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/x-ndjson' || ['.log', '.txt', '.json', '.ndjson', '.csv', '.yaml', '.yml'].includes(ext)) return 'LOG';
  return 'OTHER';
}

export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  path?: string;
}

/** 校验一批上传文件（数量、单文件大小、MIME 白名单）。不合规抛 badRequest。 */
export function validateAttachments(files: UploadedFileLike[]): void {
  if (files.length > MAX_TICKET_ATTACHMENTS) {
    throw badRequest(`附件数量超限（最多 ${MAX_TICKET_ATTACHMENTS} 个）`);
  }
  for (const f of files) {
    if (f.size > MAX_TICKET_ATTACHMENT_BYTES) {
      throw badRequest('单个附件过大', { filename: f.originalname, limitBytes: MAX_TICKET_ATTACHMENT_BYTES });
    }
    if (!isAllowedAttachment(f.mimetype, f.originalname)) {
      throw badRequest('附件类型不被允许（仅支持日志文本与常见图片）', { filename: f.originalname, mimeType: f.mimetype });
    }
  }
}

/** 校验并归一化标题。 */
export function cleanTitle(value: unknown): string {
  const title = String(value || '').trim();
  if (!title) throw badRequest('工单标题不能为空');
  if (title.length > MAX_TICKET_TITLE_LEN) throw badRequest(`工单标题过长（最多 ${MAX_TICKET_TITLE_LEN} 字）`);
  return title;
}

/** 校验并归一化消息正文。allowEmpty=true 时（仅带附件的消息）放行空串。 */
export function cleanBody(value: unknown, allowEmpty = false): string {
  const body = String(value || '').trim();
  if (!body && !allowEmpty) throw badRequest('内容不能为空');
  if (body.length > MAX_TICKET_BODY_LEN) throw badRequest(`内容过长（最多 ${MAX_TICKET_BODY_LEN} 字）`);
  return body;
}

export type TicketStatusValue = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

/** 管理员允许的状态转移图。CLOSED 为终态（需重开则新建工单）。 */
const ADMIN_STATUS_TRANSITIONS: Record<TicketStatusValue, TicketStatusValue[]> = {
  OPEN: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['OPEN', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

/** 校验管理员状态转移是否合法（相同状态视为合法 no-op）。不合法抛 badRequest。 */
export function assertAdminStatusTransition(from: TicketStatusValue, to: TicketStatusValue): void {
  if (from === to) return;
  if (!ADMIN_STATUS_TRANSITIONS[from].includes(to)) {
    throw badRequest(`不允许将工单状态从 ${from} 变更为 ${to}`);
  }
}

/** 用户追加回复时的状态推进：RESOLVED→IN_PROGRESS（重开讨论），其余活跃态保持；CLOSED 不可追加（调用方先拦截）。 */
export function nextStatusOnUserReply(current: TicketStatusValue): TicketStatusValue {
  if (current === 'RESOLVED') return 'IN_PROGRESS';
  return current;
}

/** 管理员回复时的状态推进：OPEN→IN_PROGRESS（开始处理），其余保持（管理员可另行 PATCH 改状态）。 */
export function nextStatusOnAdminReply(current: TicketStatusValue): TicketStatusValue {
  if (current === 'OPEN') return 'IN_PROGRESS';
  return current;
}
