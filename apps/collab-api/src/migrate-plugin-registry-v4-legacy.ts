import { resolveDatabaseProvider, type DatabaseProvider } from './database.config';
import type { PrismaService } from './prisma.service';

export type LegacyPurchase = {
  id: string;
  buyerTeamId: string;
  packageId: string | null;
  releaseId: string | null;
  sellerTeamId: string | null;
  priceCents: number;
  status: string;
  createdAt: Date;
};

export type LegacyInstallation = {
  id: string;
  teamId: string;
  installedById: string | null;
  version: string;
  status: 'ENABLED' | 'DISABLED';
  installedAt: Date;
};

export type LegacyReview = {
  id: string;
  reviewerId: string | null;
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';
  reason: string;
  createdAt: Date;
};

export type LegacyRating = {
  id: string;
  userId: string;
  teamId: string;
  score: number;
  comment: string;
  createdAt: Date;
};

export type LegacyGrant = { id: string; packageId: string | null };

export type LegacyPlugin = {
  id: string;
  name: string;
  description: string;
  version: string;
  entry: string;
  runtimeType: string;
  visibility: string;
  teamId: string | null;
  authorUserId: string | null;
  files: unknown;
  manifest: unknown;
  capabilities: unknown;
  reviewStatus: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewReason: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  marketplace: boolean;
  priceCents: number;
  installCount: number;
  ratingCount: number;
  ratingSum: number;
  createdAt: Date;
  purchases: LegacyPurchase[];
  installations: LegacyInstallation[];
  reviews: LegacyReview[];
  ratings: LegacyRating[];
  pluginGrants: LegacyGrant[];
};

type LegacyPluginRow = Omit<LegacyPlugin, 'purchases' | 'installations' | 'reviews' | 'ratings' | 'pluginGrants'>;
type Linked<Row> = Row & { pluginId: string };
type LegacyTable = 'Plugin' | 'Purchase' | 'PluginInstallation' | 'PluginReview' | 'PluginRating' | 'PluginGrant';
type RawQueryClient = Pick<PrismaService, '$queryRawUnsafe'>;

function quotedTable(table: LegacyTable, provider: DatabaseProvider): string {
  return provider === 'mysql' ? `\`${table}\`` : `"${table}"`;
}

async function readTable<Row>(prisma: RawQueryClient, table: LegacyTable, provider: DatabaseProvider): Promise<Row[]> {
  try {
    return await prisma.$queryRawUnsafe<Row[]>(`SELECT * FROM ${quotedTable(table, provider)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read legacy ${table} table; run the backfill before the retirement migration: ${message}`);
  }
}

function attach<Row>(
  plugins: Map<string, LegacyPlugin>,
  rows: Array<Linked<Row>>,
  field: 'purchases' | 'installations' | 'reviews' | 'ratings' | 'pluginGrants',
): void {
  for (const row of rows) {
    const plugin = plugins.get(row.pluginId);
    if (!plugin) throw new Error(`legacy ${field} row references missing Plugin ${row.pluginId}`);
    plugin[field].push(row as never);
  }
}

export async function loadLegacyPlugins(
  prisma: RawQueryClient,
  provider: DatabaseProvider = resolveDatabaseProvider(),
): Promise<LegacyPlugin[]> {
  const [pluginRows, purchases, installations, reviews, ratings, grants] = await Promise.all([
    readTable<LegacyPluginRow>(prisma, 'Plugin', provider),
    readTable<Linked<LegacyPurchase>>(prisma, 'Purchase', provider).then((rows) => rows.filter((row) => row.pluginId)),
    readTable<Linked<LegacyInstallation>>(prisma, 'PluginInstallation', provider),
    readTable<Linked<LegacyReview>>(prisma, 'PluginReview', provider),
    readTable<Linked<LegacyRating>>(prisma, 'PluginRating', provider),
    readTable<Linked<LegacyGrant>>(prisma, 'PluginGrant', provider).then((rows) => rows.filter((row) => row.pluginId)),
  ]);
  const plugins = new Map(pluginRows.map((row) => [row.id, {
    ...row,
    purchases: [],
    installations: [],
    reviews: [],
    ratings: [],
    pluginGrants: [],
  }]));
  attach(plugins, purchases, 'purchases');
  attach(plugins, installations, 'installations');
  attach(plugins, reviews, 'reviews');
  attach(plugins, ratings, 'ratings');
  attach(plugins, grants, 'pluginGrants');
  return [...plugins.values()].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
}
