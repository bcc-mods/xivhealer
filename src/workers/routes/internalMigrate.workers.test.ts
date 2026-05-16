import { describe, it, expect } from 'vitest'
import { env, SELF } from 'cloudflare:test'

describe('POST /api/internal/migrate', () => {
  it('无 SYNC_AUTH_TOKEN 拒绝', async () => {
    const res = await SELF.fetch('https://app/api/internal/migrate', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('把旧 D1 时间轴灌入 DO', async () => {
    const now = Math.floor(Date.now() / 1000)
    const content = JSON.stringify({
      v: 2,
      n: 'OldTL',
      e: 1,
      c: [],
      de: [],
      ce: { a: [], t: [], p: [] },
      ca: 0,
      ua: 0,
    })
    await env.healerbook_timelines
      .prepare(
        'INSERT INTO timelines (id, name, author_id, author_name, published_at, updated_at, version, content) VALUES (?,?,?,?,?,?,?,?)'
      )
      .bind('oldMigrateDoc00000001', 'OldTL', 'auth-x', 'AuthX', now, now, 1, content)
      .run()

    const res = await SELF.fetch('https://app/api/internal/migrate', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-sync-token' },
    })
    expect(res.status).toBe(200)

    const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName('oldMigrateDoc00000001'))
    const json = await stub.getSnapshotJson()
    expect(json).not.toBeNull()
    expect(json!.name).toBe('OldTL')
  })
})
