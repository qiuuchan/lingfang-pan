import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../common';

const ENV_KEY = 'CLOUD_ENDPOINT_SECRET_ENCRYPTION_KEY';
const CIPHER_VERSION = 'v1';
const AAD_PREFIX = 'lingfang:cloud-endpoint-secret:v1:';

function unavailable(): AppError {
  return new AppError(503, 'cloud_endpoint_secret_unavailable', 'Cloud endpoint 密钥服务不可用');
}

function parseMasterKey(value: string | undefined): Buffer {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw unavailable();
  let key: Buffer;
  if (/^[a-fA-F0-9]{64}$/.test(normalized)) key = Buffer.from(normalized, 'hex');
  else if (/^[A-Za-z0-9_-]{43}=?$/.test(normalized) || /^[A-Za-z0-9+/]{43}=$/.test(normalized)) {
    key = Buffer.from(normalized, normalized.includes('+') || normalized.includes('/') || normalized.endsWith('=') ? 'base64' : 'base64url');
  } else throw unavailable();
  if (key.length !== 32) throw unavailable();
  return key;
}

@Injectable()
export class CloudEndpointSecretCipher {
  private keyOverride?: Buffer;

  static forTest(key: Buffer): CloudEndpointSecretCipher {
    if (key.length !== 32) throw new Error('Cloud endpoint test key must contain 32 bytes');
    const cipher = new CloudEndpointSecretCipher();
    cipher.keyOverride = Buffer.from(key);
    return cipher;
  }

  encrypt(plaintext: string, deploymentId: string): { ciphertext: string; version: number } {
    const key = this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${AAD_PREFIX}${deploymentId}`, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext: [CIPHER_VERSION, iv.toString('base64url'), encrypted.toString('base64url'), tag.toString('base64url')].join('.'), version: 1 };
  }

  decrypt(ciphertext: string, deploymentId: string): string {
    try {
      const [version, ivEncoded, encryptedEncoded, tagEncoded, extra] = ciphertext.split('.');
      if (version !== CIPHER_VERSION || !ivEncoded || !encryptedEncoded || !tagEncoded || extra !== undefined) throw unavailable();
      const iv = Buffer.from(ivEncoded, 'base64url');
      const encrypted = Buffer.from(encryptedEncoded, 'base64url');
      const tag = Buffer.from(tagEncoded, 'base64url');
      if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) throw unavailable();
      const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
      decipher.setAAD(Buffer.from(`${AAD_PREFIX}${deploymentId}`, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }

  private key(): Buffer {
    return this.keyOverride ? Buffer.from(this.keyOverride) : parseMasterKey(process.env[ENV_KEY]);
  }
}
