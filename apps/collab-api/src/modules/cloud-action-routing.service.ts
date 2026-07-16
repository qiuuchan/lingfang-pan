import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { ActionTarget } from '@lingfang/contract';
import { AppError, conflict, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import type { UpdateCloudActionRoutingDto } from './dto/cloud-action-deployment.dto';

type Environment = 'PREVIEW' | 'PRODUCTION';
type ExactRouteTarget = Pick<ActionTarget, 'release_id' | 'action_id' | 'action_contract_version' | 'action_surface_sha256'> & { environment: Environment };

export function cloudRoutingBucket(runId: string, nodePath: string, generation: number): number {
  return createHash('sha256').update(`${runId}\0${nodePath}\0${generation}`).digest().readUInt32BE(0) % 100;
}

@Injectable()
export class CloudActionRoutingService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(AuthService) private readonly auth: AuthService) {}

  async update(userId: string, releaseId: string, actionId: string, input: UpdateCloudActionRoutingDto) {
    const membership = await this.managementContext(userId);
    const target = { release_id: releaseId, action_id: actionId, action_contract_version: input.action_contract_version, action_surface_sha256: input.action_surface_sha256, environment: input.environment };
    await this.assertOwnedRelease(membership.teamId, releaseId);
    const stable = await this.readyDeployment(membership.teamId, target, input.stable_deployment_id);
    const candidateId = input.candidate_deployment_id || null;
    const candidatePercent = input.candidate_percent ?? 0;
    if (candidatePercent > 0 && !candidateId) throw new AppError(400, 'cloud_routing_conflict', 'candidate_percent 大于 0 时必须指定 candidate deployment');
    if (candidateId === stable.id) throw new AppError(400, 'cloud_routing_conflict', 'stable 与 candidate 不能相同');
    if (candidateId) await this.readyDeployment(membership.teamId, target, candidateId);
    const where = { releaseId_actionId_actionContractVersion_actionSurfaceSha256_environment: { releaseId, actionId, actionContractVersion: input.action_contract_version, actionSurfaceSha256: input.action_surface_sha256, environment: input.environment } } as const;
    const current = await this.prisma.cloudActionRouting.findUnique({ where });
    let route;
    if (!current) {
      if (input.expected_generation !== 0) throw conflict('Cloud routing generation 已变化');
      try {
        route = await this.prisma.cloudActionRouting.create({ data: { releaseId, actionId, actionContractVersion: input.action_contract_version, actionSurfaceSha256: input.action_surface_sha256, environment: input.environment, stableDeploymentId: stable.id, candidateDeploymentId: candidateId, candidatePercent, generation: 1 } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('Cloud routing generation 已变化');
        throw error;
      }
    } else {
      const changed = await this.prisma.cloudActionRouting.updateMany({ where: { id: current.id, generation: input.expected_generation }, data: { stableDeploymentId: stable.id, candidateDeploymentId: candidateId, candidatePercent, generation: { increment: 1 } } });
      if (changed.count !== 1) throw conflict('Cloud routing generation 已变化');
      route = await this.prisma.cloudActionRouting.findUnique({ where: { id: current.id } });
      if (!route) throw notFound('Cloud routing 不存在');
    }
    return { routing: this.publicRoute(route) };
  }

  async freeze(userId: string, target: ActionTarget, environment: Environment, runId: string, nodePath: string) {
    await this.auth.ensureCurrentTeam(userId);
    const release = await this.prisma.pluginRelease.findFirst({ where: { id: target.release_id, packageId: target.package_id, sha256: target.sha256, status: 'PUBLISHED', package: { governanceStatus: 'ACTIVE' } }, select: { package: { select: { ownerTeamId: true } } } });
    if (!release) throw notFound('插件发行版不存在或身份不匹配');
    const route = await this.prisma.cloudActionRouting.findUnique({
      where: { releaseId_actionId_actionContractVersion_actionSurfaceSha256_environment: { releaseId: target.release_id, actionId: target.action_id, actionContractVersion: target.action_contract_version, actionSurfaceSha256: target.action_surface_sha256, environment } },
      include: { stableDeployment: true, candidateDeployment: true },
    });
    if (!route) throw new AppError(409, 'cloud_endpoint_not_ready', 'Action 尚未配置 Cloud routing');
    const bucket = cloudRoutingBucket(runId, nodePath, route.generation);
    const selected = route.candidateDeployment && route.candidatePercent > bucket ? route.candidateDeployment : route.stableDeployment;
    if (!this.matchesReadyDeployment(selected, release.package.ownerTeamId, { release_id: target.release_id, action_id: target.action_id, action_contract_version: target.action_contract_version, action_surface_sha256: target.action_surface_sha256, environment })) {
      throw new AppError(409, 'cloud_endpoint_not_ready', '冻结的 Cloud deployment 当前不可用');
    }
    return { node_path: nodePath, deployment_id: selected.id, routing_generation: route.generation, environment, policy_decision_id: '' };
  }

  private async managementContext(userId: string) {
    await this.auth.ensurePermission(userId, 'team.plugin.edit_draft');
    return this.auth.ensureCurrentTeam(userId);
  }

  private async assertOwnedRelease(teamId: string, releaseId: string, packageId?: string, sha256?: string) {
    const release = await this.prisma.pluginRelease.findFirst({ where: { id: releaseId, ...(packageId ? { packageId } : {}), ...(sha256 ? { sha256 } : {}), status: 'PUBLISHED', package: { ownerTeamId: teamId, governanceStatus: 'ACTIVE' } }, select: { id: true } });
    if (!release) throw notFound('插件发行版不存在或不属于当前团队');
  }

  private async readyDeployment(teamId: string, target: ExactRouteTarget, id: string) {
    const deployment = await this.prisma.cloudActionDeployment.findFirst({ where: { id, teamId, releaseId: target.release_id, actionId: target.action_id, actionContractVersion: target.action_contract_version, actionSurfaceSha256: target.action_surface_sha256, environment: target.environment, status: 'READY' } });
    if (!deployment) throw new AppError(409, 'cloud_endpoint_not_ready', 'routing 只能引用同一精确 Action 的 READY deployment');
    return deployment;
  }

  private matchesReadyDeployment(deployment: any, teamId: string, target: ExactRouteTarget): boolean {
    return Boolean(deployment && deployment.teamId === teamId && deployment.status === 'READY' && deployment.releaseId === target.release_id && deployment.actionId === target.action_id && deployment.actionContractVersion === target.action_contract_version && deployment.actionSurfaceSha256 === target.action_surface_sha256 && deployment.environment === target.environment);
  }

  private publicRoute(route: any) {
    return { target: { release_id: route.releaseId, action_id: route.actionId, action_contract_version: route.actionContractVersion, action_surface_sha256: route.actionSurfaceSha256, environment: route.environment }, stable_deployment_id: route.stableDeploymentId, candidate_deployment_id: route.candidateDeploymentId, candidate_percent: route.candidatePercent, generation: route.generation, updated_at: route.updatedAt.toISOString() };
  }
  async get(userId: string, releaseId: string, actionId: string, actionContractVersion: string, actionSurfaceSha256: string, environment: Environment) {
    const membership = await this.managementContext(userId); await this.assertOwnedRelease(membership.teamId, releaseId);
    const route = await this.prisma.cloudActionRouting.findUnique({ where: { releaseId_actionId_actionContractVersion_actionSurfaceSha256_environment: { releaseId, actionId, actionContractVersion, actionSurfaceSha256, environment } } });
    return { routing: route ? this.publicRoute(route) : null };
  }
}
