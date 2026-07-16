import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MarketplaceSettlementCutoverService } from './modules/marketplace-settlement-cutover.service';

function readLimit(argv: string[]) {
  const value = argv.find((item) => item.startsWith('--limit='))?.slice('--limit='.length);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000) throw new Error('--limit 必须是 1..100000 的整数');
  return parsed;
}

export async function runMarketplaceSettlementBackfill(argv = process.argv.slice(2)) {
  process.env.MARKETPLACE_SETTLEMENT_AUTORUN = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const service = app.get(MarketplaceSettlementCutoverService);
    const apply = argv.includes('--apply');
    const report = await service.backfillLegacy({ dryRun: !apply, limit: readLimit(argv) });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (apply) {
      const reconciliation = await service.reconcile({ preCutover: true });
      process.stdout.write(`${JSON.stringify(reconciliation)}\n`);
      if (!reconciliation.ok) process.exitCode = 2;
    }
    return report;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void runMarketplaceSettlementBackfill().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
