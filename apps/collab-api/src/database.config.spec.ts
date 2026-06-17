import { describe, expect, it } from 'vitest';
import { resolveDatabaseConfig } from './database.config';

describe('resolveDatabaseConfig', () => {
  it('defaults to PostgreSQL when DATABASE_PROVIDER is empty', () => {
    const config = resolveDatabaseConfig({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/lingfang',
    });

    expect(config.provider).toBe('postgresql');
    expect(config.url).toBe('postgresql://user:pass@localhost:5432/lingfang');
  });

  it('accepts explicit MySQL provider with a mysql URL', () => {
    const config = resolveDatabaseConfig({
      DATABASE_PROVIDER: 'mysql',
      DATABASE_URL: 'mysql://user:pass@localhost:3306/lingfang',
    });

    expect(config.provider).toBe('mysql');
    expect(config.url).toBe('mysql://user:pass@localhost:3306/lingfang');
  });

  it('rejects provider and URL scheme mismatches', () => {
    expect(() =>
      resolveDatabaseConfig({
        DATABASE_PROVIDER: 'mysql',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/lingfang',
      }),
    ).toThrow('DATABASE_PROVIDER=mysql requires DATABASE_URL to start with mysql://');
  });
});
