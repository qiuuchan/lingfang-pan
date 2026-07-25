import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AdminController } from './admin.controller';
import { MarketplaceController } from './marketplace.controller';
import { PluginsController } from './plugins.controller';
import { WalletController } from './wallet.controller';

type Controller = Record<string, unknown>;

function routeMethods(controller: Controller, prefix?: string): string[] {
  const prototype = Object.getPrototypeOf(controller) as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).filter((name) => {
    if (name === 'constructor' || typeof prototype[name] !== 'function') return false;
    const path = Reflect.getMetadata(PATH_METADATA, prototype[name] as object) as string | string[] | undefined;
    if (path === undefined) return false;
    if (!prefix) return true;
    const paths = Array.isArray(path) ? path : [path];
    return paths.some((candidate) => candidate === prefix || candidate.startsWith(`${prefix}/`));
  });
}

function expectClientUpgrade(controller: Controller, methodNames: string[]): void {
  for (const methodName of methodNames) {
    const method = controller[methodName] as (...args: unknown[]) => unknown;
    expect(() => method.call(controller, {}, 'resource-id', {}), methodName).toThrowError(
      expect.objectContaining({ status: 410, code: 'legacy_plugin_api_retired' }),
    );
  }
}

describe('legacy plugin protocol cutover', () => {
  it('disables every PluginsController route', () => {
    const controller = new PluginsController() as unknown as Controller;
    const methods = routeMethods(controller);
    expect(methods).toHaveLength(10);
    expectClientUpgrade(controller, methods);
  });

  it('disables every MarketplaceController route', () => {
    const controller = new MarketplaceController() as unknown as Controller;
    const methods = routeMethods(controller);
    expect(methods).toHaveLength(4);
    expectClientUpgrade(controller, methods);
  });

  it('disables every legacy admin/plugins route while leaving other admin routes untouched', () => {
    const controller = new AdminController({} as never, {} as never, {} as never) as unknown as Controller;
    const methods = routeMethods(controller, 'plugins');
    expect(methods).toHaveLength(9);
    expectClientUpgrade(controller, methods);
  });

  it('disables the legacy wallet plugin purchase route', () => {
    const controller = new WalletController() as unknown as Controller;
    const methods = routeMethods(controller);
    expect(methods).toEqual(['purchase']);
    expectClientUpgrade(controller, methods);
  });
});
