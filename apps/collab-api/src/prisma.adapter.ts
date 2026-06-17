import { PrismaPg } from '@prisma/adapter-pg';
import { createRequire } from 'node:module';
import type { PrismaClientOptions } from '@prisma/client/runtime/client';
import { resolveDatabaseConfig } from './database.config';

type PrismaAdapter = NonNullable<PrismaClientOptions['adapter']>;
type MariaDbAdapterConstructor = new (options: MySqlConnectionOptions) => PrismaAdapter;

export interface PrismaAdapterLoaders {
  readonly loadMariaDbAdapter?: () => MariaDbAdapterConstructor;
}

export interface MySqlConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

const requireFromHere = createRequire(__filename);
const MYSQL_DEFAULT_PORT = 3306;

export function createPrismaAdapter(
  env: NodeJS.ProcessEnv = process.env,
  loaders: PrismaAdapterLoaders = {},
): PrismaAdapter {
  const config = resolveDatabaseConfig(env);
  if (config.provider === 'postgresql') {
    return new PrismaPg({ connectionString: config.url });
  }
  const Adapter = loaders.loadMariaDbAdapter?.() ?? loadMariaDbAdapter();
  return new Adapter(parseMySqlConnectionOptions(config.url));
}

export function parseMySqlConnectionOptions(databaseUrl: string): MySqlConnectionOptions {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL for MySQL must include a database name');
  return {
    host: url.hostname,
    port: Number(url.port || MYSQL_DEFAULT_PORT),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

function loadMariaDbAdapter(): MariaDbAdapterConstructor {
  try {
    const module = requireFromHere('@prisma/adapter-mariadb') as Record<string, unknown>;
    const Adapter = module.PrismaMariaDb ?? module.PrismaMariaDB ?? module.PrismaMariadb;
    if (typeof Adapter === 'function') return Adapter as MariaDbAdapterConstructor;
    throw new Error('@prisma/adapter-mariadb does not export PrismaMariaDb');
  } catch (error) {
    if (isMissingMariaDbAdapter(error)) {
      throw new Error('DATABASE_PROVIDER=mysql requires @prisma/adapter-mariadb to be installed');
    }
    throw error;
  }
}

function isMissingMariaDbAdapter(error: unknown): boolean {
  return isNodeError(error) && error.code === 'MODULE_NOT_FOUND';
}

function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error;
}
