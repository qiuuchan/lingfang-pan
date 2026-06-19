import { describe, expect, it } from 'vitest';
import {
  INVITATION_CODE_EXAMPLE,
  INVITATION_CODE_PLACEHOLDER,
  validateInvitationCodeInput,
} from './invitations';

describe('invitation code input helpers', () => {
  it('uses a full-length example in the placeholder', () => {
    expect(INVITATION_CODE_EXAMPLE).toBe('LF-XXXXXXXXXXXX');
    expect(INVITATION_CODE_PLACEHOLDER).toContain(INVITATION_CODE_EXAMPLE);
  });

  it('rejects empty and prefix-only invitation codes before submit', () => {
    expect(validateInvitationCodeInput('')).toBe('输入团队邀请码');
    expect(validateInvitationCodeInput('LF-ABCD')).toBe('请输入完整邀请码');
  });

  it('accepts a complete invitation code regardless of case or surrounding spaces', () => {
    expect(validateInvitationCodeInput(' lf-abcdefghijkl ')).toBeNull();
  });
});
