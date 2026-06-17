import { describe, expect, it } from 'vitest';
import { createPrismaAdapter, parseMySqlConnectionOptions } from './prisma.adapter';

describe('parseMySqlConnectionOptions', () => {
  it('maps DATABASE_URL into MariaDB pool options', () => {
    expect(parseMySqlConnectionOptions('mysql://user:p%40ss@db.example.cn:3307/lingfang')).toEqual({
      host: 'db.example.cn',
      port: 3307,
      user: 'user',
      password: 'p@ss',
      database: 'lingfang',
    });
  });
});

describe('createPrismaAdapter', () => {
  it('creates a MariaDB adapter when DATABASE_PROVIDER=mysql', () => {
    const calls: unknown[] = [];
    class FakeMariaDbAdapter {
      constructor(options: unknown) {
        calls.push(options);
      }
    }

    const adapter = createPrismaAdapter(
      {
        DATABASE_PROVIDER: 'mysql',
        DATABASE_URL: 'mysql://lingfang:secret@localhost:3306/lingfang_collab',
      },
      { loadMariaDbAdapter: () => FakeMariaDbAdapter },
    );

    expect(adapter).toBeInstanceOf(FakeMariaDbAdapter);
    expect(calls).toEqual([
      {
        host: 'localhost',
        port: 3306,
        user: 'lingfang',
        password: 'secret',
        database: 'lingfang_collab',
      },
    ]);
  });
});
