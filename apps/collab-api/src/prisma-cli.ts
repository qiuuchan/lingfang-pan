import { spawnSync } from 'node:child_process';
import type { DatabaseProvider } from './database.config';
import { resolveDatabaseConfig, resolveDatabaseProvider } from './database.config';
import { ensurePrismaSchemaForEnv } from './prisma-schema';

export type PrismaCliCommand = 'generate' | 'deploy' | 'migrate' | 'validate';

export interface PrismaInvocation {
  readonly args: readonly string[];
}

export function resolvePrismaInvocation(
  command: PrismaCliCommand,
  provider: DatabaseProvider,
  schemaPath: string,
): PrismaInvocation {
  if (command === 'generate') return { args: ['generate', '--schema', schemaPath] };
  if (command === 'validate') return { args: ['validate', '--schema', schemaPath] };
  if (command === 'migrate') return { args: migrationArgs(provider, schemaPath) };
  return { args: deployArgs(provider, schemaPath) };
}

function migrationArgs(provider: DatabaseProvider, schemaPath: string): string[] {
  if (provider === 'mysql') return ['db', 'push', '--schema', schemaPath];
  return ['migrate', 'dev', '--schema', schemaPath];
}

function deployArgs(provider: DatabaseProvider, schemaPath: string): string[] {
  if (provider === 'mysql') return ['db', 'push', '--schema', schemaPath];
  return ['migrate', 'deploy', '--schema', schemaPath];
}

function parseCommand(raw: string | undefined): PrismaCliCommand {
  if (raw === 'generate' || raw === 'deploy' || raw === 'migrate' || raw === 'validate') return raw;
  throw new Error('Usage: tsx src/prisma-cli.ts <generate|deploy|migrate|validate>');
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const provider = command === 'generate' || command === 'validate'
    ? resolveDatabaseProvider(process.env)
    : resolveDatabaseConfig(process.env).provider;
  const schemaPath = await ensurePrismaSchemaForEnv(process.env);
  const invocation = resolvePrismaInvocation(command, provider, schemaPath);
  const result = spawnSync('prisma', invocation.args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
