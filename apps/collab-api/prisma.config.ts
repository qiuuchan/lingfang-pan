import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { resolveDatabaseProvider } from './src/database.config';
import { schemaPathForProvider } from './src/prisma-schema';

export default defineConfig({
  schema: schemaPathForProvider(resolveDatabaseProvider(process.env)),
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
