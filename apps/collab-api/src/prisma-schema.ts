import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseProvider } from './database.config';
import { resolveDatabaseProvider } from './database.config';

const CANONICAL_SCHEMA_PATH = 'prisma/schema.prisma';
const MYSQL_SCHEMA_PATH = 'prisma/.generated/mysql/schema.prisma';
const DATASOURCE_PROVIDER_PATTERN = /(datasource\s+db\s*\{[\s\S]*?provider\s*=\s*")postgresql("[\s\S]*?\})/;
const MYSQL_STRING_LIST_FIELD_PATTERN = /^(\s*[A-Za-z_][A-Za-z0-9_]*\s+)String\[\](\s+@default\(\[\]\))?([^\r\n]*)$/gm;
const MYSQL_LONG_TEXT_FIELD_PATTERN = /^(\s*readmeMarkdown\s+String\s+@default\(""\))\s+@db\.Text$/gm;
const MYSQL_BOUNDED_ACTION_FIELDS: Array<[RegExp, string]> = [
  [/^(\s*actionId\s+String)\s*$/gm, '$1 @db.VarChar(64)'],
  [/^(\s*actionContractVersion\s+String)\s*$/gm, '$1 @db.VarChar(64)'],
  [/^(\s*actionSurfaceSha256\s+String)\s*$/gm, '$1 @db.Char(64)'],
  [/^(\s*deploymentKey\s+String)\s*$/gm, '$1 @db.VarChar(256)'],
];

export function schemaPathForProvider(provider: DatabaseProvider): string {
  if (provider === 'postgresql') return CANONICAL_SCHEMA_PATH;
  return MYSQL_SCHEMA_PATH;
}

export function renderPrismaSchemaForProvider(schema: string, provider: DatabaseProvider): string {
  if (provider === 'postgresql') return schema;
  if (!DATASOURCE_PROVIDER_PATTERN.test(schema)) {
    throw new Error('Canonical Prisma schema must contain datasource db provider = "postgresql"');
  }
  let rendered = schema
    .replace(DATASOURCE_PROVIDER_PATTERN, `$1${provider}$2`)
    // MySQL has no scalar-list columns; JSON preserves the string-array value shape.
    .replace(MYSQL_STRING_LIST_FIELD_PATTERN, (_match, prefix: string, defaultClause = '', suffix: string) => (
      `${prefix}Json${defaultClause.replace('@default([])', '@default("[]")')}${suffix}`
    ))
    // MySQL 8 requires TEXT/BLOB defaults to be expression defaults. A plain
    // @default("") renders DEFAULT '', which MySQL rejects for LONGTEXT.
    .replace(MYSQL_LONG_TEXT_FIELD_PATTERN, (_match, prefix: string) => (
      `${prefix.replace('@default("")', '@default(dbgenerated("(\'\')"))')} @db.LongText`
    ));
  for (const [pattern, replacement] of MYSQL_BOUNDED_ACTION_FIELDS) rendered = rendered.replace(pattern, replacement);
  return rendered;
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
