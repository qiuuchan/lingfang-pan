import { Inject, Injectable } from '@nestjs/common';
import { satisfiesActionVersionRange } from '@lingfang/contract';
import { AppError, notFound } from '../common';
import { PrismaService } from '../prisma.service';
type ActionProjection = { action_id: string; action_contract_version: string; action_surface_sha256: string; name?: string; description?: string; [key: string]: unknown };
@Injectable()
export class PluginActionRegistryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async list(releaseId: string) { const release = await this.load(releaseId); return { release_id: release.id, package_id: release.packageId, sha256: release.sha256, actions: this.actions(release.actionSurfaceManifest) }; }
  async resolve(input: { package_id: string; release_id: string; sha256: string; action_id: string; action_contract_version: string; action_surface_sha256: string }) { const release = await this.load(input.release_id); if (release.packageId !== input.package_id || release.sha256 !== input.sha256) throw new AppError(409, 'action_contract_mismatch', 'Action 目标发行版身份不匹配'); const action = this.actions(release.actionSurfaceManifest).find((candidate) => candidate.action_id === input.action_id); if (!action) throw new AppError(404, 'action_not_found', 'Action 不存在于指定发行版'); if (action.action_contract_version !== input.action_contract_version || action.action_surface_sha256 !== input.action_surface_sha256) throw new AppError(409, 'action_contract_mismatch', 'Action 契约或能力表面已变化'); return { target: input, action }; }
  async assertDeclaredDependency(caller: { package_id: string; release_id: string; sha256: string }, dependencyId: string, target: { package_id: string; release_id: string; sha256: string; action_id: string; action_contract_version: string }) {
    const callerRelease = await this.prisma.pluginRelease.findUnique({ where: { id: caller.release_id }, select: { packageId: true, sha256: true, status: true, manifest: true } });
    if (!callerRelease || callerRelease.status !== 'PUBLISHED' || callerRelease.packageId !== caller.package_id || callerRelease.sha256 !== caller.sha256) throw new AppError(403, 'action_dependency_denied', '调用方精确发行版身份无效');
    const manifest = callerRelease.manifest && typeof callerRelease.manifest === 'object' && !Array.isArray(callerRelease.manifest) ? callerRelease.manifest as Record<string, unknown> : {};
    const dependencies = Array.isArray(manifest.action_dependencies) ? manifest.action_dependencies as Array<Record<string, unknown>> : [];
    const dependency = dependencies.find((item) => item.dependency_id === dependencyId);
    if (!dependency || dependency.package_id !== target.package_id || dependency.action_id !== target.action_id) throw new AppError(403, 'action_dependency_denied', '目标 Action 未由调用方 manifest 声明');
    const targetRelease = await this.prisma.pluginRelease.findUnique({ where: { id: target.release_id }, select: { packageId: true, version: true, sha256: true, status: true } });
    if (!targetRelease || targetRelease.status !== 'PUBLISHED' || targetRelease.packageId !== target.package_id || targetRelease.sha256 !== target.sha256) throw new AppError(409, 'action_contract_mismatch', '依赖目标精确发行版身份无效');
    if (!satisfiesActionVersionRange(targetRelease.version, String(dependency.release_version_range || '')) || !satisfiesActionVersionRange(target.action_contract_version, String(dependency.action_contract_version_range || ''))) throw new AppError(409, 'action_contract_mismatch', '依赖目标版本不满足调用方声明范围');
  }
  private async load(releaseId: string) { const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId }, select: { id: true, packageId: true, sha256: true, status: true, actionSurfaceManifest: true } }); if (!release || release.status !== 'PUBLISHED') throw notFound('插件发行版不存在或已撤回'); return release; }
  private actions(value: unknown): ActionProjection[] { return Array.isArray(value) ? value.filter((item): item is ActionProjection => Boolean(item && typeof item === 'object' && typeof (item as ActionProjection).action_id === 'string')) : []; }
}
