import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { conflict, notFound } from '../common';
import { PrismaService } from '../prisma.service';

type PolicyDocument = { schema_version: 1; enforcement_mode: 'AUDIT' | 'ENFORCE'; allowed_source_kinds: string[]; denied_capability_kinds: string[]; rules: unknown[] };
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`; return JSON.stringify(value); }
function documentHash(document: PolicyDocument): string { return createHash('sha256').update(canonicalJson(document)).digest('hex'); }

@Injectable()
export class PluginGovernancePolicyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async active(teamId: string) { const policy = await this.prisma.teamPluginPolicy.findUnique({ where: { teamId }, include: { activeRevision: true } }); return policy?.activeRevision ? this.revisionJson(policy.activeRevision) : { teamId, revision: 0, document: null, enforcementMode: 'ENFORCE' as const }; }
  async history(teamId: string) { return (await this.prisma.teamPluginPolicyRevision.findMany({ where: { teamId }, orderBy: { revision: 'desc' } })).map((revision) => this.revisionJson(revision)); }
  async publish(teamId: string, actorId: string, expectedRevision: number, document: PolicyDocument, changeReason = '') { return this.serializable(async (tx) => {
    const existing = await tx.teamPluginPolicy.findUnique({ where: { teamId }, include: { activeRevision: true } }); const currentRevision = existing?.activeRevision?.revision ?? 0;
    if (currentRevision !== expectedRevision) throw conflict('插件策略已被其他管理员更新，请刷新后重试', { expectedRevision, currentRevision });
    const policy = existing ?? await tx.teamPluginPolicy.create({ data: { teamId } });
    const revision = await tx.teamPluginPolicyRevision.create({ data: { policyId: policy.id, teamId, revision: currentRevision + 1, schemaVersion: 1, enforcementMode: document.enforcement_mode, document: document as Prisma.InputJsonValue, documentSha256: documentHash(document), createdById: actorId, changeReason: changeReason.slice(0, 500) } });
    await tx.teamPluginPolicy.update({ where: { id: policy.id }, data: { activeRevisionId: revision.id } });
    await tx.auditLog.create({ data: { actorUserId: actorId, action: 'plugin.policy.published', targetType: 'TeamPluginPolicy', targetId: policy.id, metadata: { teamId, revision: revision.revision, documentSha256: revision.documentSha256 } } }); return this.revisionJson(revision);
  }); }
  async rollback(teamId: string, actorId: string, expectedRevision: number, sourceRevision: number, changeReason = '') { return this.serializable(async (tx) => {
    const policy = await tx.teamPluginPolicy.findUnique({ where: { teamId }, include: { activeRevision: true } }); if (!policy?.activeRevision) throw notFound('团队尚未发布插件策略');
    if (policy.activeRevision.revision !== expectedRevision) throw conflict('插件策略已被其他管理员更新，请刷新后重试', { expectedRevision, currentRevision: policy.activeRevision.revision });
    const source = await tx.teamPluginPolicyRevision.findFirst({ where: { policyId: policy.id, teamId, revision: sourceRevision } }); if (!source) throw notFound('目标策略修订不存在');
    const revision = await tx.teamPluginPolicyRevision.create({ data: { policyId: policy.id, teamId, revision: expectedRevision + 1, schemaVersion: source.schemaVersion, enforcementMode: source.enforcementMode, document: source.document as Prisma.InputJsonValue, documentSha256: source.documentSha256, createdById: actorId, sourceRevisionId: source.id, changeReason: changeReason.slice(0, 500) } });
    await tx.teamPluginPolicy.update({ where: { id: policy.id }, data: { activeRevisionId: revision.id } }); await tx.auditLog.create({ data: { actorUserId: actorId, action: 'plugin.policy.rolled_back', targetType: 'TeamPluginPolicy', targetId: policy.id, metadata: { teamId, revision: revision.revision, sourceRevision } } }); return this.revisionJson(revision);
  }); }
  private revisionJson(revision: { id: string; teamId: string; revision: number; schemaVersion: number; enforcementMode: string; document: unknown; documentSha256: string; sourceRevisionId: string | null; changeReason: string; createdAt: Date }) { return { id: revision.id, teamId: revision.teamId, revision: revision.revision, schemaVersion: revision.schemaVersion, enforcementMode: revision.enforcementMode, document: revision.document, documentSha256: revision.documentSha256, sourceRevisionId: revision.sourceRevisionId, changeReason: revision.changeReason, createdAt: revision.createdAt.toISOString() }; }
  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError
          && (error.code === 'P2034' || error.code === 'P2002');
        if (!retryable || attempt === 3) throw conflict('插件策略发生并发冲突，请刷新后重试');
      }
    }
    throw conflict('插件策略发生并发冲突，请刷新后重试');
  }
}
