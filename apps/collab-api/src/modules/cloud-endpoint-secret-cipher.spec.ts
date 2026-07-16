import { describe, expect, it } from 'vitest';
import { CloudEndpointSecretCipher } from './cloud-endpoint-secret-cipher';

describe('CloudEndpointSecretCipher', () => {
  it('round-trips a secret without storing plaintext', () => {
    const cipher = CloudEndpointSecretCipher.forTest(Buffer.alloc(32, 7));
    const encrypted = cipher.encrypt('endpoint-secret', 'deployment-1');
    expect(encrypted.ciphertext).not.toContain('endpoint-secret');
    expect(encrypted.version).toBe(1);
    expect(cipher.decrypt(encrypted.ciphertext, 'deployment-1')).toBe('endpoint-secret');
  });

  it('binds ciphertext to its immutable deployment id', () => {
    const cipher = CloudEndpointSecretCipher.forTest(Buffer.alloc(32, 7));
    const encrypted = cipher.encrypt('endpoint-secret', 'deployment-1');
    expect(() => cipher.decrypt(encrypted.ciphertext, 'deployment-2')).toThrow();
  });

  it('rejects tampered ciphertext and a different master key', () => {
    const first = CloudEndpointSecretCipher.forTest(Buffer.alloc(32, 7));
    const second = CloudEndpointSecretCipher.forTest(Buffer.alloc(32, 8));
    const encrypted = first.encrypt('endpoint-secret', 'deployment-1');
    expect(() => second.decrypt(encrypted.ciphertext, 'deployment-1')).toThrow();
    expect(() => first.decrypt(`${encrypted.ciphertext}x`, 'deployment-1')).toThrow();
  });
});
