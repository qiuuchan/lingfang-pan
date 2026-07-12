import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseProvider } from './database.config';
import { resolveDatabaseProvider } from './database.config';

const CANONICAL_SCHEMA_PATH = 'prisma/schema.prisma';
const MYSQL_SCHEMA_PATH = 'prisma/.generated/mysql/schema.prisma';
const DATASOURCE_PROVIDER_PATTERN = /(datasource\s+db\s*\{[\s\S]*?provider\s*=\s*")postgresql("[\s\S]*?\})/;
const MYSQL_STRING_LIST_FIELD_PATTERN = /^(\s*[A-Za-z_][A-Za-z0-9_]*\s+)String\[\](\s+@default\(\[\]\))?([^\r\n]*)$/gm;

export function schemaPathForProvider(provider: DatabaseProvider): string {
  if (provider === 'postgresql') return CANONICAL_SCHEMA_PATH;
  return MYSQL_SCHEMA_PATH;
}

export function renderPrismaSchemaForProvider(schema: string, provider: DatabaseProvider): string {
  if (provider === 'postgresql') return schema;
  if (!DATASOURCE_PROVIDER_PATTERN.test(schema)) {
    throw new Error('Canonical Prisma schema must contain datasource db provider = "postgresql"');
  }
  return schema
    .replace(DATASOURCE_PROVIDER_PATTERN, `$1${provider}$2`)
    // MySQL has no scalar-list columns; JSON preserves the string-array value shape.
    .replace(MYSQL_STRING_LIST_FIELD_PATTERN, (_match, prefix: string, defaultClause = '', suffix: string) => (
      `${prefix}Json${defaultClause.replace('@default([])', '@default("[]")')}${suffix}`
    ));
}

export async function ensurePrismaSchemaForEnv(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const provider = resolveDatabaseProvider(env);
  const schemaPath = schemaPathForProvider(provider);
  if (provider === 'postgresql') return schemaPath;
  await writeGeneratedSchema(schemaPath, provider);
  return schemaPath;
}

async function writeGeneratedSchema(schemaPath: string, provider: DatabaseProvider): Promise<void> {
  const canonical = await readFile(CANONICAL_SCHEMA_PATH, 'utf8');
  const rendered = renderPrismaSchemaForProvider(canonical, provider);
  await mkdir(dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, rendered);
}
