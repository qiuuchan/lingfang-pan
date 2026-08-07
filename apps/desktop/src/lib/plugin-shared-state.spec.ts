import { beforeEach, describe, expect, it, vi } from 'vitest';

const { api, apiDownload } = vi.hoisted(() => ({ api: vi.fn(), apiDownload: vi.fn() }));

vi.mock('./api', () => ({ api, apiDownload }));

import {
  deleteSharedNamespace,
  exportSharedNamespace,
  listSharedNamespaces,
  migrateSharedNamespaceValue,
  reactivateSharedNamespace,
} from './plugin-shared-state';

describe('desktop shared-state admin client', () => {
  beforeEach(() => {
    api.mockReset();
    apiDownload.mockReset();
  });

  it('uses the session-authenticated admin metadata endpoint without runtime principal fields', async () => {
    api.mockResolvedValue({ namespaces: [] });
    await listSharedNamespaces();
    expect(api).toHaveBeenCalledWith('/api/teams/current/plugin-shared/namespaces');
    expect(api.mock.calls[0]).not.toContainEqual(
      expect.objectContaining({ token: expect.anything(), invocation_id: expect.anything() })
    );
  });

  it('routes lifecycle, export and CAS migration through exact namespace ids', async () => {
    api.mockResolvedValue({ namespace_id: 'ns/one' });
    apiDownload.mockResolvedValue(new Blob(['{}\n']));

    await exportSharedNamespace('ns/one');
    await deleteSharedNamespace('ns/one');
    await reactivateSharedNamespace('ns/one', 3);
    await migrateSharedNamespaceValue('ns/one', 'project key', {
      value: { version: 3 },
      source_schema_version: 2,
      target_schema_version: 3,
      expected_revision: '42',
    });

    expect(apiDownload).toHaveBeenCalledWith(
      '/api/teams/current/plugin-shared/namespaces/ns%2Fone/export'
    );
    expect(api).toHaveBeenCalledWith('/api/teams/current/plugin-shared/namespaces/ns%2Fone', {
      method: 'DELETE',
    });
    expect(api).toHaveBeenCalledWith(
      '/api/teams/current/plugin-shared/namespaces/ns%2Fone/reactivate',
      {
        method: 'PUT',
        body: { active_schema_version: 3 },
      }
    );
    expect(api).toHaveBeenCalledWith(
      '/api/teams/current/plugin-shared/namespaces/ns%2Fone/values/project%20key/migrate',
      {
        method: 'PUT',
        body: {
          value: { version: 3 },
          source_schema_version: 2,
          target_schema_version: 3,
          expected_revision: '42',
        },
      }
    );
  });
});
