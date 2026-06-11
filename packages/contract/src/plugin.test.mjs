import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorCode } from './llm.ts';
import { resolveGrant } from './plugin.ts';

test('owner and admin default to allowed when no grant matches', () => {
  assert.equal(resolveGrant([], 'u1', 'owner'), true);
  assert.equal(resolveGrant([], 'u1', 'admin'), true);
});

test('deny grant still overrides owner default allow', () => {
  const grants = [
    { tenant_id: 't1', plugin_id: 'p1', subject_kind: 'role', subject_id: 'owner', effect: 'deny' },
  ];

  assert.equal(resolveGrant(grants, 'u1', 'owner'), false);
});

test('error code contract includes backend stable codes', () => {
  for (const code of ['bad_request', 'forbidden', 'payment_required', 'insufficient_balance', 'upstream_llm_error', 'internal']) {
    assert.equal(ErrorCode.safeParse(code).success, true, code);
  }
});
