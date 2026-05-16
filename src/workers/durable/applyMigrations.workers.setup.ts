import { beforeAll } from 'vitest'
import { env, applyD1Migrations } from 'cloudflare:test'

beforeAll(async () => {
  // TEST_MIGRATIONS is injected by vitest.workers.config.ts via readD1Migrations
  await applyD1Migrations(
    env.healerbook_timelines,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (env as any).TEST_MIGRATIONS
  )
})
