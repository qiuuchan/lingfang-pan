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
  options: { acceptDataLoss?: boolean } = {}
): PrismaInvocation {
  if (command === 'generate') return { args: ['generate', '--schema', schemaPath] };
  if (command === 'validate') return { args: ['validate', '--schema', schemaPath] };
  if (command === 'migrate')
    return { args: migrationArgs(provider, schemaPath, options.acceptDataLoss === true) };
  return { args: deployArgs(provider, schemaPath, options.acceptDataLoss === true) };
}

function migrationArgs(
  provider: DatabaseProvider,
  schemaPath: string,
  acceptDataLoss: boolean
): string[] {
  if (provider === 'mysql') return mysqlPushArgs(schemaPath, acceptDataLoss);
  return ['migrate', 'dev', '--schema', schemaPath];
}

function deployArgs(
  provider: DatabaseProvider,
  schemaPath: string,
  acceptDataLoss: boolean
): string[] {
  if (provider === 'mysql') return mysqlPushArgs(schemaPath, acceptDataLoss);
  return ['migrate', 'deploy', '--schema', schemaPath];
}

function mysqlPushArgs(schemaPath: string, acceptDataLoss: boolean): string[] {
  const args = ['db', 'push', '--schema', schemaPath];
  if (acceptDataLoss) args.push('--accept-data-loss');
  return args;
}

function parseCommand(raw: string | undefined): PrismaCliCommand {
  if (raw === 'generate' || raw === 'deploy' || raw === 'migrate' || raw === 'validate') return raw;
  throw new Error('Usage: tsx src/prisma-cli.ts <generate|deploy|migrate|validate>');
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const provider =
    command === 'generate' || command === 'validate'
      ? resolveDatabaseProvider(process.env)
      : resolveDatabaseConfig(process.env).provider;
  const schemaPath = await ensurePrismaSchemaForEnv(process.env);
  const invocation = resolvePrismaInvocation(command, provider, schemaPath, {
    // Destructive MySQL schema changes require an explicit one-shot operator opt-in.
    acceptDataLoss: process.env.PRISMA_MYSQL_ACCEPT_DATA_LOSS_ONCE === '1',
  });
  const result = spawnSync('prisma', invocation.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
