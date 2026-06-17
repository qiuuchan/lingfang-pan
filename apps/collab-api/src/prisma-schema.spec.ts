import { describe, expect, it } from 'vitest';
import { renderPrismaSchemaForProvider } from './prisma-schema';

describe('renderPrismaSchemaForProvider', () => {
  it('keeps the PostgreSQL datasource provider unchanged', () => {
    const schema = 'datasource db {\n  provider = "postgresql"\n}\n';

    expect(renderPrismaSchemaForProvider(schema, 'postgresql')).toBe(schema);
  });

  it('renders a MySQL datasource provider from the canonical schema', () => {
    const schema = 'datasource db {\n  provider = "postgresql"\n}\n';

    expect(renderPrismaSchemaForProvider(schema, 'mysql')).toBe('datasource db {\n  provider = "mysql"\n}\n');
  });
});
