import { describe, expect, it, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { AppError } from '../../common';
import { WebCloudTrialController } from './web-cloud-trial.controller';
import { WebMarketplaceController } from './web-marketplace.controller';
import { WebPreviewSessionController } from './web-preview-session.controller';

describe('WebMarketplaceController', () => {
  it('keeps controller paths relative to the global /api prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WebMarketplaceController)).toBe('web/plugins');
    expect(Reflect.getMetadata(PATH_METADATA, WebCloudTrialController)).toBe('web/plugin-actions');
    expect(Reflect.getMetadata(PATH_METADATA, WebPreviewSessionController)).toBe('web/plugin-preview');
  });
  it('decodes query strings before calling the catalog service', async () => {
    const marketplace = { catalog: vi.fn().mockResolvedValue({ items: [], total: 0, page: 2, page_size: 12 }), detail: vi.fn() };
    const controller = new WebMarketplaceController(marketplace as never);
    await controller.catalog({ q: '图片', page: '2', page_size: '12', price: 'FREE' });
    expect(marketplace.catalog).toHaveBeenCalledWith(expect.objectContaining({ q: '图片', page: 2, page_size: 12, price: 'FREE' }));
  });

  it('rejects unknown filters and malformed package ids at the public boundary', () => {
    const marketplace = { catalog: vi.fn(), detail: vi.fn() };
    const controller = new WebMarketplaceController(marketplace as never);
    expect(() => controller.catalog({ unsupported: 'secret' })).toThrowError(AppError);
    expect(() => controller.detail('../private')).toThrowError(AppError);
    expect(marketplace.catalog).not.toHaveBeenCalled();
    expect(marketplace.detail).not.toHaveBeenCalled();
  });

  it('rejects malformed Cloud Trial route identities before calling the service', () => {
    const trials = { start: vi.fn(), get: vi.fn(), cancel: vi.fn() };
    const controller = new WebCloudTrialController(trials as never);
    const request = { user: { id: 'user-1' } } as never;
    expect(() => controller.start(request, '../private', 'image.generate', {})).toThrowError(AppError);
    expect(() => controller.get(request, 'not-an-id')).toThrowError(AppError);
    expect(() => controller.cancel(request, 'not-an-id')).toThrowError(AppError);
    expect(trials.start).not.toHaveBeenCalled();
    expect(trials.get).not.toHaveBeenCalled();
    expect(trials.cancel).not.toHaveBeenCalled();
  });
});
