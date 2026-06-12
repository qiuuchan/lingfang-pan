export type PlatformRole = 'NONE' | 'PLATFORM_ADMIN';
export type TeamRole = string;
export type OnboardingState = 'NEEDS_INVITATION' | 'PENDING_APPROVAL' | 'APPLICATION_REJECTED' | 'TEAM_SPACE' | 'TEAM_ADMIN_SPACE' | 'PLATFORM_ADMIN_WEB_ONLY';

export interface Session {
  token: string | null;
  userId: string | null;
  displayName: string | null;
  email: string | null;
  tenantId: string | null;
  tenantName: string | null;
  role: TeamRole | null;
  isPlatformAdmin: boolean;
  onboarding: OnboardingState | null;
  application?: TeamAdminApplication | null;
}

export interface CollabSessionResponse {
  token?: string;
  user: { id: string; email: string; displayName: string; platformRole: PlatformRole; status: string };
  team: { id: string; name: string; slug: string; role: TeamRole } | null;
  application: TeamAdminApplication | null;
  onboarding: OnboardingState;
}

export interface TeamAdminApplication {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  teamName: string;
  reviewReason?: string;
}

export interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
  balanceCents: number;
}

export interface TeamMember {
  userId: string;
  role: TeamRole;
  joinedAt: string;
  user: { id: string; email: string; displayName: string; status: string };
}

export interface InvitationCode {
  id: string;
  displayCodePrefix: string;
  code?: string;
  status: string;
  maxUses: number;
  usedCount: number;
  expiresAt?: string | null;
  createdAt: string;
}

export interface BalanceLedger {
  id: string;
  amountCents: number;
  direction: 'CREDIT' | 'DEBIT';
  reason: string;
  createdAt: string;
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
  status?: string;
  source?: 'builtin' | 'published' | 'installed' | 'platform' | 'team' | 'marketplace';
  files?: DraftFile[];
  manifest?: unknown;
  reviewStatus?: string;
  reviewReason?: string;
  marketplace?: boolean;
  priceCents?: number;
  updatedAt?: string;
}

export type View = 'home' | 'team' | 'team-manage' | 'plugins' | 'settings' | 'market' | 'wallet' | 'review';