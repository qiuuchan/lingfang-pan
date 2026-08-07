const INVITATION_CODE_PREFIX = 'LF-';
const INVITATION_CODE_RANDOM_CHARS = 12;
const INVITATION_CODE_LENGTH = INVITATION_CODE_PREFIX.length + INVITATION_CODE_RANDOM_CHARS;

export const INVITATION_CODE_EXAMPLE = `${INVITATION_CODE_PREFIX}${'X'.repeat(INVITATION_CODE_RANDOM_CHARS)}`;
export const INVITATION_CODE_PLACEHOLDER = `团队邀请码，例如 ${INVITATION_CODE_EXAMPLE}`;

export function validateInvitationCodeInput(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return '输入团队邀请码';
  if (
    !normalized.startsWith(INVITATION_CODE_PREFIX) ||
    normalized.length < INVITATION_CODE_LENGTH
  ) {
    return '请输入完整邀请码';
  }
  return null;
}
