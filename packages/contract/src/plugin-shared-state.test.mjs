import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SharedNamespaceDeclaration,
  SharedNamespaceLifecycleResult,
  SharedNamespaceReactivate,
  SharedSchemaMigration,
  SharedWrite,
  SharedChangeEvent,
  SharedPresenceMember,
  SharedRealtimeInvalidation,
  normalizeSharedKey,
  serializeSharedJson,
  SHARED_VALUE_MAX_BYTES,
} from './plugin-shared-state.ts';

test('shared namespace declarations bind active and readable schema versions', () => {
  const declaration = {
    name: 'project.assets', active_schema_version: 2,
    read_purpose: '读取团队资产索引', write_purpose: '更新团队资产索引',
    schemas: [
      { schema_version: 1, schema: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
      { schema_version: 2, schema: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
    ],
  };
  assert.equal(SharedNamespaceDeclaration.parse(declaration).active_schema_version, 2);
  assert.throws(() => SharedNamespaceDeclaration.parse({ ...declaration, active_schema_version: 3 }));
  assert.throws(() => SharedNamespaceDeclaration.parse({ ...declaration, schemas: [declaration.schemas[0], declaration.schemas[0]] }));
});

test('shared writes require schema version and support decimal CAS revisions', () => {
  assert.equal(SharedWrite.safeParse({ value: { ok: true }, schema_version: 2 }).success, true);
  assert.equal(SharedWrite.safeParse({ value: null, schema_version: 1, expected_revision: '0007' }).success, true);
  assert.equal(SharedWrite.safeParse({ value: null, schema_version: 0 }).success, false);
  assert.equal(SharedWrite.safeParse({ value: null, schema_version: 1, expected_revision: 'r7' }).success, false);
});

test('namespace lifecycle and explicit migrations have generation-safe contracts', () => {
  assert.equal(SharedNamespaceReactivate.parse({ active_schema_version: 3 }).active_schema_version, 3);
  assert.equal(SharedSchemaMigration.safeParse({ value: { version: 2 }, source_schema_version: 1, target_schema_version: 2, expected_revision: '19' }).success, true);
  assert.equal(SharedSchemaMigration.safeParse({ value: {}, source_schema_version: 2, target_schema_version: 2, expected_revision: '19' }).success, false);
  const lifecycle = SharedNamespaceLifecycleResult.parse({
    namespace_id: 'namespace-1', namespace_generation: 4, active_schema_version: 3,
    next_value_revision: '20', next_change_cursor: '21', used_bytes: 0, deleted_at: null,
  });
  assert.equal(lifecycle.namespace_generation, 4);
});

test('keys are normalized and reject path/control/reserved semantics', () => {
  assert.equal(normalizeSharedKey('e\u0301'), 'é');
  assert.throws(() => normalizeSharedKey('a/b'), /shared_key_invalid/);
  assert.throws(() => normalizeSharedKey('__token'), /shared_key_invalid/);
  assert.throws(() => normalizeSharedKey('bad\u0000'), /shared_key_invalid/);
});

test('JSON quota is measured as UTF-8 bytes', () => {
  const encoded = serializeSharedJson({ value: '🙂' });
  assert.equal(encoded.bytes, new TextEncoder().encode(encoded.json).byteLength);
  assert.throws(() => serializeSharedJson('x'.repeat(SHARED_VALUE_MAX_BYTES)), /shared_value_too_large/);
});

test('change event uses namespace cursor independent from value revision', () => {
  const change = SharedChangeEvent.parse({ namespace_id: 'n', namespace_generation: 2, cursor: '10', key: 'x', revision: '99', schema_version: 1, event_kind: 'DELETE', created_at: new Date().toISOString() });
  assert.equal(change.cursor, '10');
  assert.equal(change.revision, '99');
});

test('realtime invalidation contains no value or writer metadata', () => {
  const event = SharedRealtimeInvalidation.parse({
    cursor: '42',
    key: 'scene',
    revision: '99',
  });
  assert.deepEqual(Object.keys(event).sort(), ['cursor', 'key', 'revision']);
  assert.throws(() => SharedRealtimeInvalidation.parse({ ...event, value: { secret: true } }));
});

test('presence projection exposes context but no connection or token', () => {
  const member = SharedPresenceMember.parse({
    user_id: 'user-1',
    display_name: 'Lin',
    context: { package_id: 'package-1', workflow_release_id: null },
    last_seen: new Date().toISOString(),
  });
  assert.equal(member.context.package_id, 'package-1');
  assert.throws(() => SharedPresenceMember.parse({ ...member, connection_id: 'socket-1' }));
});
