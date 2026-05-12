/// <reference types="@cloudflare/workers-types" />

import type { Env } from './env'
import { createClient } from './env'
import {
  syncAllTop100,
  processOneSample,
  makeDefaultFetchExtracted,
  defaultLookupEncounterName,
} from './top100Sync'

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  switch (event.cron) {
    case '*/10 * * * *':
      ctx.waitUntil(runSampleTick(env))
      return
    case '0 */12 * * *':
      ctx.waitUntil(runTop100Sync(env))
      return
    default:
      console.error(`[Cron] 未知 cron 表达式: ${event.cron}`)
  }
}

async function runSampleTick(env: Env): Promise<void> {
  console.log('[Sample-tick] 启动')
  const client = createClient(env)
  const ranOnce = await processOneSample({
    db: env.healerbook_timelines,
    kv: env.healerbook,
    fetchExtracted: makeDefaultFetchExtracted(client),
    lookupEncounterName: defaultLookupEncounterName,
  })
  console.log(`[Sample-tick] 结束 (ranOnce=${ranOnce})`)
}

async function runTop100Sync(env: Env): Promise<void> {
  console.log('[TOP100 Sync] 启动')
  const client = createClient(env)
  const result = await syncAllTop100(client, env.healerbook, env.healerbook_timelines)
  console.log(
    `[TOP100 Sync] 结束 (success=${result.success}, failed=${result.failed})` +
      (result.errors.length > 0 ? `, errors=${result.errors.join('; ')}` : '')
  )
}
