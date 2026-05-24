import { defineConfig } from 'prisma/config';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  experimental: {
    adapter: true,
  },
  adapter: async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    return new PrismaPg({ connectionString: url });
  },
});
