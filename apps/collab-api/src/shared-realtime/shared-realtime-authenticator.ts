import { Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { PrismaService } from '../prisma.service';
import { PluginGovernanceService } from '../modules/plugin-governance.service';
import type { SharedPresenceRoom, SharedPresenceSession } from './shared-presence.store';

type SessionJwt = jwt.JwtPayload & {
  sub: string;
  email: string;
  tokenVersion?: number;
  teamId: string;
  teamContextVersion: number;
};

type RealtimePrincipal = {
  userId: string;
  teamId: string;
  displayName: string;
  invocationId: string;
  packageId: string;
  releaseId: string;
  releaseSha256: string;
  actionId: string;
  actionContractVersion: string;
  actionSurfaceSha256: string;
  workflowReleaseId: string | null;
};

export type SharedRealtimeAuthContext = RealtimePrincipal;

@Injectable()
export class SharedRealtimeAuthenticator {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PluginGovernanceService) private readonly governance: PluginGovernanceService
  ) {}

  async authenticate(socket: Pick<Socket, 'handshake'>): Promise<SharedRealtimeAuthContext> {
    const token = bearerToken(socket.handshake);
    const payload = verifyToken(token);
    const invocationId =
      payload.scope === 'plugin_shared_realtime'
        ? requireText(payload.invocationId, 'invocation_id')
        : requireText(socket.handshake.auth?.invocation_id, 'invocation_id');

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true, tokenVersion: true, teamContextVersion: true, displayName: true },
    });
    if (!user || user.status !== 'ACTIVE') throw authError('shared_realtime_unauthorized');
    if (payload.tokenVersion !== undefined && Number(payload.tokenVersion) !== user.tokenVersion) {
      throw authError('shared_realtime_session_revoked');
    }
    if (
      payload.scope !== 'plugin_shared_realtime' &&
      payload.teamContextVersion !== user.teamContextVersion
    ) {
      throw authError('shared_realtime_session_revoked');
    }

    const membership = await this.prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId: payload.teamId, userId: payload.sub } },
      select: { status: true, team: { select: { status: true } } },
    });
    if (!membership || membership.status !== 'ACTIVE' || membership.team.status !== 'ACTIVE') {
      throw authError('shared_realtime_team_unavailable');
    }

    const invocation = await this.prisma.actionInvocation.findFirst({
      where: {
        id: invocationId,
        teamId: payload.teamId,
        principalUserId: payload.sub,
        kind: 'STANDARD',
        status: 'RUNNING',
      },
      select: {
        id: true,
        packageId: true,
        releaseId: true,
        releaseSha256: true,
        actionId: true,
        actionContractVersion: true,
        actionSurfaceSha256: true,
        workflowStepAttempt: { select: { run: { select: { workflowReleaseId: true } } } },
      },
    });
    if (!invocation) throw authError('shared_realtime_invocation_invalid');
    if (payload.scope === 'plugin_shared_realtime')
      assertRuntimeBinding(payload, invocation, payload.teamId);

    return {
      userId: payload.sub,
      teamId: payload.teamId,
      displayName: user.displayName,
      invocationId: invocation.id,
      packageId: invocation.packageId,
      releaseId: invocation.releaseId,
      releaseSha256: invocation.releaseSha256,
      actionId: invocation.actionId,
      actionContractVersion: invocation.actionContractVersion,
      actionSurfaceSha256: invocation.actionSurfaceSha256,
      workflowReleaseId: invocation.workflowStepAttempt?.run.workflowReleaseId ?? null,
    };
  }

  async authorizeRoom(
    principal: SharedRealtimeAuthContext,
    room: Pick<SharedPresenceRoom, 'namespaceId' | 'namespaceGeneration'>
  ): Promise<SharedPresenceRoom> {
    const namespace = await this.prisma.pluginSharedNamespace.findFirst({
      where: {
        id: room.namespaceId,
        teamId: principal.teamId,
        generation: room.namespaceGeneration,
        deletedAt: null,
      },
      select: { id: true, ownerKind: true, ownerId: true, generation: true },
    });
    if (!namespace) throw authError('shared_realtime_namespace_not_found');
    const owner =
      namespace.ownerKind === 'PACKAGE'
        ? namespace.ownerId === principal.packageId
        : namespace.ownerId === principal.workflowReleaseId;
    const decision = await this.governance.authorizeRelease(
      principal.userId,
      {
        releaseId: principal.releaseId,
        packageId: principal.packageId,
        sha256: principal.releaseSha256,
      },
      ['shared_data_read'],
      {
        enforce: !owner,
        action: {
          action_id: principal.actionId,
          action_contract_version: principal.actionContractVersion,
          action_surface_sha256: principal.actionSurfaceSha256,
        },
      }
    );
    if (!owner && !decision.decision.allowed) throw authError('shared_realtime_forbidden');
    if (
      owner &&
      !decision.decision.allowed &&
      decision.decision.reason_code !== 'high_risk_not_enabled'
    ) {
      throw authError('shared_realtime_forbidden');
    }
    return {
      teamId: principal.teamId,
      namespaceId: namespace.id,
      namespaceGeneration: namespace.generation,
    };
  }

  presenceSession(
    connectionId: string,
    principal: SharedRealtimeAuthContext
  ): SharedPresenceSession {
    return {
      connectionId,
      userId: principal.userId,
      displayName: principal.displayName,
      packageId: principal.packageId,
      workflowReleaseId: principal.workflowReleaseId,
    };
  }
}

function bearerToken(handshake: Socket['handshake']): string {
  const authToken = typeof handshake.auth?.token === 'string' ? handshake.auth.token.trim() : '';
  const header =
    typeof handshake.headers.authorization === 'string' ? handshake.headers.authorization : '';
  const headerToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const token = authToken || headerToken;
  if (!token) throw authError('shared_realtime_unauthorized');
  return token;
}

function verifyToken(token: string): SessionJwt {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('missing secret');
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as SessionJwt;
    if (
      !payload.sub ||
      !payload.email ||
      typeof payload.teamId !== 'string' ||
      !payload.teamId.trim()
    )
      throw new Error('invalid subject');
    if (payload.scope !== undefined && payload.scope !== 'plugin_shared_realtime')
      throw new Error('invalid scope');
    if (payload.scope !== 'plugin_shared_realtime' && !Number.isInteger(payload.teamContextVersion))
      throw new Error('invalid team context');
    return payload;
  } catch {
    throw authError('shared_realtime_unauthorized');
  }
}

function assertRuntimeBinding(
  payload: SessionJwt,
  invocation: { id: string; packageId: string; releaseId: string },
  teamId: string
): void {
  if (
    payload.teamId !== teamId ||
    payload.invocationId !== invocation.id ||
    payload.packageId !== invocation.packageId ||
    payload.releaseId !== invocation.releaseId
  ) {
    throw authError('shared_realtime_token_binding_invalid');
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw authError(`shared_realtime_${field}_required`);
  return value.trim();
}

function authError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
