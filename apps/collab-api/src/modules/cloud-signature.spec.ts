import { describe, expect, it } from 'vitest';
import {
  canonicalCloudRequest,
  signCloudRequest,
  signCloudResponse,
  verifyCloudRequestSignature,
  verifyCloudResponseSignature,
} from './cloud-signature';

const request = {
  method: 'POST',
  canonicalPath: '/v1/actions/invoke',
  timestamp: 1_721_111_111,
  nonce: 'nonce-1',
  invocationId: 'invocation-1',
  effectIdempotencyKey: 'effect-1',
  target: {
    packageId: 'package-1',
    releaseId: 'release-1',
    sha256: 'a'.repeat(64),
    actionId: 'image.generate',
    actionContractVersion: '1.0.0',
    actionSurfaceSha256: 'b'.repeat(64),
  },
  deploymentId: 'deployment-1',
  body: Buffer.from('{"prompt":"cat"}'),
};

describe('cloud endpoint signatures', () => {
  it('binds every exact target field and request body', () => {
    const canonical = canonicalCloudRequest(request);
    for (const value of [
      'package-1',
      'release-1',
      'image.generate',
      '1.0.0',
      'deployment-1',
      'a'.repeat(64),
      'b'.repeat(64),
    ]) {
      expect(canonical).toContain(value);
    }
    const signature = signCloudRequest(request, 'secret');
    expect(verifyCloudRequestSignature(request, signature, 'secret')).toBe(true);
    expect(
      verifyCloudRequestSignature({ ...request, body: Buffer.from('{}') }, signature, 'secret')
    ).toBe(false);
    expect(
      verifyCloudRequestSignature({ ...request, deploymentId: 'deployment-2' }, signature, 'secret')
    ).toBe(false);
  });

  it('rejects malformed and wrong-secret signatures', () => {
    const signature = signCloudRequest(request, 'secret');
    expect(verifyCloudRequestSignature(request, signature, 'wrong')).toBe(false);
    expect(verifyCloudRequestSignature(request, 'v1=bad', 'secret')).toBe(false);
  });

  it('signs response status, nonce, invocation, deployment and body', () => {
    const response = {
      statusCode: 200,
      timestamp: request.timestamp,
      nonce: request.nonce,
      invocationId: request.invocationId,
      deploymentId: request.deploymentId,
      body: Buffer.from('{"ok":true}'),
    };
    const signature = signCloudResponse(response, 'secret');
    expect(verifyCloudResponseSignature(response, signature, 'secret')).toBe(true);
    expect(
      verifyCloudResponseSignature({ ...response, statusCode: 500 }, signature, 'secret')
    ).toBe(false);
  });
});
