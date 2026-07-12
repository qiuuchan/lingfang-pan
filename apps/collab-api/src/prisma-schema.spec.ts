import { describe, expect, it } from 'vitest';
import { renderPrismaSchemaForProvider } from './prisma-schema';

describe('renderPrismaSchemaForProvider', () => {
  it('keeps the PostgreSQL datasource provider unchanged', () => {
    const schema = 'datasource db {\n  provider = "postgresql"\n}\n\nmodel Role {\n  permissions String[] @default([])\n}\n';

    expect(renderPrismaSchemaForProvider(schema, 'postgresql')).toBe(schema);
  });

  it('renders MySQL string lists as JSON arrays while preserving relation lists', () => {
    const schema = [
      'datasource db {',
      '  provider = "postgresql"',
      '}',
      '',
      'model Role {',
      '  permissions String[] @default([])',
      '  users       User[]',
      '}',
      '',
      'model PlatformApiKey {',
      '  scopes String[] @default([]) // capability allowlist',
      '}',
      '',
    ].join('\n');

    expect(renderPrismaSchemaForProvider(schema, 'mysql')).toBe([
      'datasource db {',
      '  provider = "mysql"',
      '}',
      '',
      'model Role {',
      '  permissions Json @default("[]")',
      '  users       User[]',
      '}',
      '',
      'model PlatformApiKey {',
      '  scopes Json @default("[]") // capability allowlist',
      '}',
      '',
    ].join('\n'));
  });
});
