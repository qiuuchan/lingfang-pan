export type DatabaseProvider = 'postgresql' | 'mysql';

export interface DatabaseConfig {
  readonly provider: DatabaseProvider;
  readonly url: string;
}

const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = 'postgresql';

export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const provider = parseDatabaseProvider(env.DATABASE_PROVIDER);
  const url = requireDatabaseUrl(env.DATABASE_URL);
  assertUrlMatchesProvider(provider, url);
  return { provider, url };
}

export function resolveDatabaseProvider(env: NodeJS.ProcessEnv = process.env): DatabaseProvider {
  return parseDatabaseProvider(env.DATABASE_PROVIDER);
}

export function parseDatabaseProvider(raw: string | undefined): DatabaseProvider {
  if (!raw || raw.trim().length === 0) return DEFAULT_DATABASE_PROVIDER;
  const value = raw.trim().toLowerCase();
  if (value === 'postgresql' || value === 'postgres') return 'postgresql';
  if (value === 'mysql') return 'mysql';
  throw new Error('DATABASE_PROVIDER must be postgresql or mysql');
}

function requireDatabaseUrl(raw: string | undefined): string {
  const url = raw?.trim();
  if (!url) throw new Error('DATABASE_URL is required');
  return url;
}

function assertUrlMatchesProvider(provider: DatabaseProvider, url: string): void {
  if (provider === 'postgresql' && !/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error('DATABASE_PROVIDER=postgresql requires DATABASE_URL to start with postgresql:// or postgres://');
  }
  if (provider === 'mysql' && !/^mysql:\/\//i.test(url)) {
    throw new Error('DATABASE_PROVIDER=mysql requires DATABASE_URL to start with mysql://');
  }
}
