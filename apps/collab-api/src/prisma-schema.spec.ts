import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
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
    ].join('\n'));
  });

  it('renders the final PostgreSQL/MySQL schemas without external relay key models', async () => {
    const canonical = await readFile('prisma/schema.prisma', 'utf8');
    for (const provider of ['postgresql', 'mysql'] as const) {
      const rendered = renderPrismaSchemaForProvider(canonical, provider);
      expect(rendered).not.toContain('model PlatformApiKey');
      expect(rendered).not.toContain('enum ApiKeyStatus');
      expect(rendered).not.toContain('apiKeyId');
      expect(rendered).toContain('teamContextVersion');
      expect(rendered).toContain('clientSource');
    }
  });
});
