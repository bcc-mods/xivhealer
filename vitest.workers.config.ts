import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@\/resources/,
        replacement: path.resolve(__dirname, './3rdparty/ff14-overlay-vue/src/resources'),
      },
      {
        find: '@ff14-overlay',
        replacement: path.resolve(__dirname, './3rdparty/ff14-overlay-vue/src'),
      },
      {
        find: '@',
        replacement: path.resolve(__dirname, './src'),
      },
    ],
  },
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(__dirname, 'migrations')
      const migrations = await readD1Migrations(migrationsPath)
      return {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat_v2'],
          bindings: {
            JWT_SECRET: 'test-secret',
            SYNC_AUTH_TOKEN: 'test-sync-token',
            TEST_MIGRATIONS: migrations,
          },
        },
      }
    }),
  ],
  test: {
    include: ['**/*.workers.test.ts'],
    setupFiles: ['./src/workers/durable/applyMigrations.workers.setup.ts'],
  },
})
