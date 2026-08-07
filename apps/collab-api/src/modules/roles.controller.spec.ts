import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS_KEY } from './auth.decorators';
import { AdminRolesController } from './roles.controller';

describe('AdminRolesController permissions registry guard', () => {
  it('requires platform.role.manage before exposing platform permission codes', () => {
    const permissions = Reflect.getMetadata(
      PERMISSIONS_KEY,
      AdminRolesController.prototype.listPermissions
    );
    expect(permissions).toEqual(['platform.role.manage']);
  });
});
