// ticket-package 纯函数单测：附件校验、kind 推断、状态机转移、文本清洗。
import { describe, expect, it } from 'vitest';
import {
  isAllowedAttachment,
  inferAttachmentKind,
  validateAttachments,
  cleanTitle,
  cleanBody,
  assertAdminStatusTransition,
  nextStatusOnUserReply,
  nextStatusOnAdminReply,
  fileExt,
  MAX_TICKET_ATTACHMENT_BYTES,
  MAX_TICKET_ATTACHMENTS,
  type UploadedFileLike,
} from './ticket-package';

function file(over: Partial<UploadedFileLike> = {}): UploadedFileLike {
  return { originalname: 'a.png', mimetype: 'image/png', size: 1024, buffer: Buffer.from('x'), ...over };
}

describe('ticket-package', () => {
  describe('fileExt', () => {
    it('提取小写扩展名', () => {
      expect(fileExt('App.LOG')).toBe('.log');
      expect(fileExt('screenshot.PNG')).toBe('.png');
      expect(fileExt('noext')).toBe('');
    });
  });

  describe('isAllowedAttachment', () => {
    it('放行图片与文本 MIME', () => {
      expect(isAllowedAttachment('image/png', 'a.png')).toBe(true);
      expect(isAllowedAttachment('text/plain', 'log.txt')).toBe(true);
      expect(isAllowedAttachment('application/json', 'data.json')).toBe(true);
    });
    it('放行 octet-stream 但扩展名在白名单（.log）', () => {
      expect(isAllowedAttachment('application/octet-stream', 'app.log')).toBe(true);
    });
    it('拒绝可执行文件', () => {
      expect(isAllowedAttachment('application/x-msdownload', 'virus.exe')).toBe(false);
      expect(isAllowedAttachment('application/octet-stream', 'binary.bin')).toBe(false);
    });
  });

  describe('inferAttachmentKind', () => {
    it('图片→IMAGE，日志/文本→LOG，其余→OTHER', () => {
      expect(inferAttachmentKind('image/jpeg', 'a.jpg')).toBe('IMAGE');
      expect(inferAttachmentKind('text/plain', 'a.log')).toBe('LOG');
      expect(inferAttachmentKind('application/json', 'a.json')).toBe('LOG');
      expect(inferAttachmentKind('application/octet-stream', 'a.log')).toBe('LOG');
      expect(inferAttachmentKind('application/pdf', 'a.pdf')).toBe('OTHER');
    });
  });

  describe('validateAttachments', () => {
    it('数量超限抛 bad_request', () => {
      const files = Array.from({ length: MAX_TICKET_ATTACHMENTS + 1 }, () => file());
      expect(() => validateAttachments(files)).toThrow();
    });
    it('单文件超大抛 bad_request', () => {
      expect(() => validateAttachments([file({ size: MAX_TICKET_ATTACHMENT_BYTES + 1 })]))
        .toThrowError(/过大/);
    });
    it('非白名单 MIME 抛 bad_request', () => {
      expect(() => validateAttachments([file({ originalname: 'x.exe', mimetype: 'application/x-msdownload' })]))
        .toThrowError(/不被允许/);
    });
    it('合规附件通过', () => {
      expect(() => validateAttachments([file(), file({ originalname: 'b.log', mimetype: 'text/plain' })])).not.toThrow();
    });
  });

  describe('cleanTitle / cleanBody', () => {
    it('空标题抛错', () => {
      expect(() => cleanTitle('   ')).toThrowError(/不能为空/);
    });
    it('body 允许空（allowEmpty=true，仅附件场景）', () => {
      expect(cleanBody('', true)).toBe('');
      expect(() => cleanBody('', false)).toThrowError(/不能为空/);
    });
  });

  describe('状态机', () => {
    it('管理员合法转移放行，非法抛错', () => {
      expect(() => assertAdminStatusTransition('OPEN', 'IN_PROGRESS')).not.toThrow();
      expect(() => assertAdminStatusTransition('IN_PROGRESS', 'CLOSED')).not.toThrow();
      // CLOSED 是终态，不能再转出。
      expect(() => assertAdminStatusTransition('CLOSED', 'OPEN')).toThrowError(/不允许/);
      // RESOLVED 不能直接回到 OPEN。
      expect(() => assertAdminStatusTransition('RESOLVED', 'OPEN')).toThrowError(/不允许/);
    });
    it('相同状态视为合法 no-op', () => {
      expect(() => assertAdminStatusTransition('OPEN', 'OPEN')).not.toThrow();
    });
    it('用户回复：RESOLVED→IN_PROGRESS，其余保持', () => {
      expect(nextStatusOnUserReply('RESOLVED')).toBe('IN_PROGRESS');
      expect(nextStatusOnUserReply('OPEN')).toBe('OPEN');
      expect(nextStatusOnUserReply('IN_PROGRESS')).toBe('IN_PROGRESS');
    });
    it('管理员回复：OPEN→IN_PROGRESS，其余保持', () => {
      expect(nextStatusOnAdminReply('OPEN')).toBe('IN_PROGRESS');
      expect(nextStatusOnAdminReply('RESOLVED')).toBe('RESOLVED');
    });
  });
});
