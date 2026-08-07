import { describe, expect, it } from 'vitest';
import { resolvePrismaInvocation } from './prisma-cli';

describe('resolvePrismaInvocation', () => {
  it('uses migration deploy for PostgreSQL', () => {
    expect(resolvePrismaInvocation('deploy', 'postgresql', 'prisma/schema.prisma').args).toEqual([
      'migrate',
      'deploy',
      '--schema',
      'prisma/schema.prisma',
    ]);
  });

  it('uses db push for MySQL deploy because PostgreSQL SQL migrations are not portable', () => {
    expect(
      resolvePrismaInvocation('deploy', 'mysql', 'prisma/.generated/mysql/schema.prisma').args
    ).toEqual(['db', 'push', '--schema', 'prisma/.generated/mysql/schema.prisma']);
  });

  it('only adds MySQL accept-data-loss after explicit one-shot opt-in', () => {
    expect(
      resolvePrismaInvocation('deploy', 'mysql', 'prisma/.generated/mysql/schema.prisma', {
        acceptDataLoss: true,
      }).args
    ).toEqual([
      'db',
      'push',
      '--schema',
      'prisma/.generated/mysql/schema.prisma',
      '--accept-data-loss',
    ]);
  });
});
