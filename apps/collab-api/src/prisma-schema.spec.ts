import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { renderPrismaSchemaForProvider } from './prisma-schema';

describe('renderPrismaSchemaForProvider', () => {
  it('keeps the PostgreSQL datasource provider unchanged', () => {
    const schema =
      'datasource db {\n  provider = "postgresql"\n}\n\nmodel Role {\n  permissions String[] @default([])\n}\n';

    expect(renderPrismaSchemaForProvider(schema, 'postgresql')).toBe(schema);
  });

  it('renders MySQL string lists as JSON arrays while preserving relation lists', () => {
    const schema = [
      'datasource db {',
      '  provider = "postgresql"',
      '}',
      '',
      'model Role {',
      '  permissions String[] @default([])',
      '  users       User[]',
      '}',
      '',
    ].join('\n');

    expect(renderPrismaSchemaForProvider(schema, 'mysql')).toBe(
      [
        'datasource db {',
        '  provider = "mysql"',
        '}',
        '',
        'model Role {',
        '  permissions Json @default("[]")',
        '  users       User[]',
        '}',
        '',
      ].join('\n')
    );
  });

  it('renders plugin README storage as MySQL LONGTEXT', () => {
    const schema =
      'datasource db {\n  provider = "postgresql"\n}\nmodel PluginRelease {\n  readmeMarkdown String @default("") @db.Text\n}\n';
    expect(renderPrismaSchemaForProvider(schema, 'mysql')).toContain(
      'readmeMarkdown String @default(dbgenerated("(\'\')")) @db.LongText'
    );
  });

  it('bounds MySQL action identity fields so composite runtime indexes fit InnoDB', () => {
    const schema = [
      'datasource db {',
      '  provider = "postgresql"',
      '}',
      'model CloudActionDeployment {',
      '  actionId String',
      '  actionContractVersion String',
      '  actionSurfaceSha256 String',
      '  deploymentKey String',
      '}',
    ].join('\n');
    const rendered = renderPrismaSchemaForProvider(schema, 'mysql');
    expect(rendered).toContain('actionId String @db.VarChar(64)');
    expect(rendered).toContain('actionContractVersion String @db.VarChar(64)');
    expect(rendered).toContain('actionSurfaceSha256 String @db.Char(64)');
    expect(rendered).toContain('deploymentKey String @db.VarChar(256)');
  });

  it('renders the final PostgreSQL/MySQL schemas without external relay key models', async () => {
    const canonical = await readFile('prisma/schema.prisma', 'utf8');
    for (const provider of ['postgresql', 'mysql'] as const) {
      const rendered = renderPrismaSchemaForProvider(canonical, provider);
      expect(rendered).not.toContain('model PlatformApiKey');
      expect(rendered).not.toContain('enum ApiKeyStatus');
      expect(rendered).not.toContain('apiKeyId');
      expect(rendered).toContain('teamContextVersion');
      expect(rendered).toContain('clientSource');
    }
  });

  it('preserves the cloud automation ledger in both provider schemas', async () => {
    const canonical = await readFile('prisma/schema.prisma', 'utf8');
    for (const provider of ['postgresql', 'mysql'] as const) {
      const rendered = renderPrismaSchemaForProvider(canonical, provider);
      expect(rendered).toContain('model CloudActionDeployment');
      expect(rendered).toContain('model CloudActionRouting');
      expect(rendered).toContain('model WorkflowRunCloudBinding');
      expect(rendered).toContain('model AutomationSchedule');
      expect(rendered).toContain('model AutomationOutbox');
      expect(rendered).toContain('model CloudUsageEvent');
      expect(rendered).toContain('@@unique([scheduleId, scheduleGeneration, occurrenceKey])');
      expect(rendered).toContain('cloudDeploymentId     String?');
      expect(rendered).toContain('transportJobId     String?');
    }
  });

  it('keeps the cloud automation PostgreSQL migration additive', async () => {
    const migration = await readFile(
      'prisma/migrations/20260716191000_cloud_automation/migration.sql',
      'utf8'
    );
    expect(migration).toContain('CREATE TABLE "CloudActionDeployment"');
    expect(migration).toContain('CREATE TABLE "AutomationSchedule"');
    expect(migration).toContain('CREATE TABLE "AutomationOutbox"');
    expect(migration).toContain('CREATE TABLE "CloudUsageEvent"');
    expect(migration).toContain('ALTER TABLE "ActionInvocation"');
    expect(migration).toContain('ADD COLUMN "cloudDeploymentId" TEXT');
    expect(migration).toContain('ALTER TABLE "WorkflowRun"');
    expect(migration).toContain('ADD COLUMN "occurrenceKey" TEXT');
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|TYPE|INDEX)\b/i);
    expect(migration).not.toMatch(/\bRENAME\b/i);
  });

  it('preserves the marketplace commerce foundation in both provider schemas', async () => {
    const canonical = await readFile('prisma/schema.prisma', 'utf8');
    for (const provider of ['postgresql', 'mysql'] as const) {
      const rendered = renderPrismaSchemaForProvider(canonical, provider);
      expect(rendered).toContain('model MarketplaceCommerceState');
      expect(rendered).toContain('model MarketplacePlatformAccount');
      expect(rendered).toContain('model MarketplacePurchaseIdempotency');
      expect(rendered).toContain('model MarketplaceRefundRequest');
      expect(rendered).toContain('model MarketplaceDiscount');
      expect(rendered).toContain('model MarketplaceCampaign');
      expect(rendered).toContain(
        'settlementVersion MarketplaceSettlementVersion @default(LEGACY_V1)'
      );
      expect(rendered).toContain('priceVersion String @default("legacy-v1")');
      expect(rendered).toContain('marketplaceEntryKind MarketplaceLedgerEntryKind?');
    }
  });

  it('keeps the marketplace commerce migration additive and initializes dark LEGACY state', async () => {
    const migration = await readFile(
      'prisma/migrations/20260716200000_marketplace_commerce_foundation/migration.sql',
      'utf8'
    );
    expect(migration).toContain('CREATE TABLE "MarketplaceCommerceState"');
    expect(migration).toContain('CREATE TABLE "MarketplacePlatformAccount"');
    expect(migration).toContain('CREATE TABLE "MarketplaceDiscount"');
    expect(migration).toContain("VALUES ('singleton', 'LEGACY', 0");
    expect(migration).toContain("'marketplace-clearing', 'MARKETPLACE_CLEARING'");
    expect(migration).toContain('"platformAmountCents" + "sellerAmountCents" = "priceCents"');
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|TYPE|INDEX)\b/i);
    expect(migration).not.toMatch(/\bRENAME\b/i);
  });
});
