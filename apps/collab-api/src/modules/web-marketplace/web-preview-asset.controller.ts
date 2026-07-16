import { Controller, Get, Headers, Inject, Param, Query, Res } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { AppError, Public } from '../../common';
import { WebPreviewAssetService } from './web-preview-asset.service';

@Controller('internal/plugin-preview')
export class WebPreviewAssetController {
  constructor(@Inject(WebPreviewAssetService) private readonly assets: WebPreviewAssetService) {}

  @Public()
  @Get('sessions/:sessionId/asset')
  async asset(
    @Param('sessionId') sessionId: string,
    @Query('path') path: string | undefined,
    @Headers('x-lingfang-preview-service-key') serviceKey: string | undefined,
    @Res() response: Response,
  ) {
    assertPreviewServiceKey(serviceKey);
    if (!z.string().uuid().safeParse(sessionId).success) throw new AppError(400, 'web_preview_session_invalid', '预览会话参数无效');
    if (path !== undefined && (!path || path.length > 512 || path.includes('\\') || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..'))) {
      throw new AppError(400, 'web_preview_asset_path_invalid', '预览资源路径无效');
    }
    const asset = await this.assets.read(sessionId, path);
    response.setHeader('content-type', asset.contentType);
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-lingfang-preview-entry', asset.isEntry ? '1' : '0');
    response.setHeader('x-lingfang-preview-entry-path', encodeURIComponent(asset.entryPath));
    response.setHeader('x-lingfang-preview-release-id', asset.releaseId);
    response.setHeader('x-lingfang-preview-release-sha256', asset.releaseSha256);
    response.send(asset.body);
  }
}

export function assertPreviewServiceKey(supplied: string | undefined, expected = process.env.PLUGIN_PREVIEW_SERVICE_KEY): void {
  if (!expected || expected.length < 32) {
    throw new AppError(503, 'web_preview_service_unconfigured', '预览资源服务密钥未配置');
  }
  const actual = supplied || '';
  const valid = actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  if (!valid) throw new AppError(403, 'web_preview_service_forbidden', '预览资源服务鉴权失败');
}
