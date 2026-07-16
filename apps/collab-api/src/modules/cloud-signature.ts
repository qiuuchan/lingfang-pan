import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CLOUD_SIGNATURE_VERSION = '1' as const;
export const CLOUD_SIGNATURE_HEADER = 'x-lingfang-signature';
export const CLOUD_RESPONSE_SIGNATURE_HEADER = 'x-lingfang-response-signature';

export type CloudSignatureTarget = {
  packageId: string;
  releaseId: string;
  sha256: string;
  actionId: string;
  actionContractVersion: string;
  actionSurfaceSha256: string;
};

export type CloudRequestSignatureInput = {
  method: string;
  canonicalPath: string;
  timestamp: number;
  nonce: string;
  invocationId: string;
  effectIdempotencyKey?: string;
  target: CloudSignatureTarget;
  deploymentId: string;
  body: Buffer;
};

export type CloudResponseSignatureInput = {
  statusCode: number;
  timestamp: number;
  nonce: string;
  invocationId: string;
  deploymentId: string;
  body: Buffer;
};

export function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalCloudRequest(input: CloudRequestSignatureInput): string {
  return [
    'lingfang-cloud-request-v1',
    input.method.toUpperCase(),
    input.canonicalPath,
    String(input.timestamp),
    input.nonce,
    input.invocationId,
    input.effectIdempotencyKey ?? '',
    input.target.packageId,
    input.target.releaseId,
    input.target.sha256,
    input.target.actionId,
    input.target.actionContractVersion,
    input.target.actionSurfaceSha256,
    input.deploymentId,
    sha256Hex(input.body),
  ].join('\n');
}

export function canonicalCloudResponse(input: CloudResponseSignatureInput): string {
  return [
    'lingfang-cloud-response-v1',
    String(input.statusCode),
    String(input.timestamp),
    input.nonce,
    input.invocationId,
    input.deploymentId,
    sha256Hex(input.body),
  ].join('\n');
}

function signCanonical(canonical: string, secret: string | Buffer): string {
  return `v1=${createHmac('sha256', secret).update(canonical).digest('base64url')}`;
}

function verifyCanonical(canonical: string, signature: string, secret: string | Buffer): boolean {
  if (!/^v1=[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const expected = Buffer.from(signCanonical(canonical, secret).slice(3), 'base64url');
  const actual = Buffer.from(signature.slice(3), 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function signCloudRequest(input: CloudRequestSignatureInput, secret: string | Buffer): string {
  return signCanonical(canonicalCloudRequest(input), secret);
}

export function verifyCloudRequestSignature(input: CloudRequestSignatureInput, signature: string, secret: string | Buffer): boolean {
  return verifyCanonical(canonicalCloudRequest(input), signature, secret);
}

export function signCloudResponse(input: CloudResponseSignatureInput, secret: string | Buffer): string {
  return signCanonical(canonicalCloudResponse(input), secret);
}

export function verifyCloudResponseSignature(input: CloudResponseSignatureInput, signature: string, secret: string | Buffer): boolean {
  return verifyCanonical(canonicalCloudResponse(input), signature, secret);
}

export function cloudRequestHeaders(input: CloudRequestSignatureInput, secret: string | Buffer): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-lingfang-signature-version': CLOUD_SIGNATURE_VERSION,
    'x-lingfang-timestamp': String(input.timestamp),
    'x-lingfang-nonce': input.nonce,
    'x-lingfang-invocation-id': input.invocationId,
    ...(input.effectIdempotencyKey ? { 'x-lingfang-effect-idempotency-key': input.effectIdempotencyKey } : {}),
    'x-lingfang-package-id': input.target.packageId,
    'x-lingfang-release-id': input.target.releaseId,
    'x-lingfang-release-sha256': input.target.sha256,
    'x-lingfang-action-id': input.target.actionId,
    'x-lingfang-contract-version': input.target.actionContractVersion,
    'x-lingfang-action-surface-sha256': input.target.actionSurfaceSha256,
    'x-lingfang-deployment-id': input.deploymentId,
    [CLOUD_SIGNATURE_HEADER]: signCloudRequest(input, secret),
  };
}
