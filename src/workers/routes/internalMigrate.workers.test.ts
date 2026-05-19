import { describe, it, expect } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import * as Y from 'yjs'

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

  // 真实旧数据:content 是 V1 内存格式,显示名只在 timelines.name 列里,
  // 从未写进 content。迁移须把列里的 name 补回 Y.Doc,否则 viewer 标题为空。
  it('content 缺 name 时从 timelines.name 列补全', async () => {
    const now = Math.floor(Date.now() / 1000)
    const content = JSON.stringify({
      description: '说明文字',
      encounter: { id: 1, name: 'E', displayName: 'E', zone: '', damageEvents: [] },
      composition: { players: [] },
      damageEvents: [],
      castEvents: [],
      annotations: [],
      createdAt: 0,
      updatedAt: 0,
    })
    await env.healerbook_timelines
      .prepare(
        'INSERT INTO timelines (id, name, author_id, author_name, published_at, updated_at, version, content) VALUES (?,?,?,?,?,?,?,?)'
      )
      .bind('migrateNoNameDoc0001', '真实标题', 'auth-y', 'AuthY', now, now, 1, content)
      .run()

    const res = await SELF.fetch('https://app/api/internal/migrate', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-sync-token' },
    })
    expect(res.status).toBe(200)

    const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName('migrateNoNameDoc0001'))
    const json = await stub.getSnapshotJson()
    expect(json).not.toBeNull()
    expect(json!.name).toBe('真实标题')
    expect(json!.description).toBe('说明文字')
  })

  // 修复路径:旧版迁移已把 DO seed 成缺 name 的坏数据,seed 幂等不会覆盖。
  // 重跑 migrate 须经 ensureMetaName 回填,否则生产存量数据修不好。
  it('对已迁移但缺 name 的 DO,重跑 migrate 回填 name', async () => {
    const now = Math.floor(Date.now() / 1000)
    const id = 'migrateRepairDoc0001'
    const content = JSON.stringify({
      encounter: { id: 1, name: 'E', displayName: 'E', zone: '', damageEvents: [] },
      composition: { players: [] },
      damageEvents: [],
      castEvents: [],
      annotations: [],
      createdAt: 0,
      updatedAt: 0,
    })
    await env.healerbook_timelines
      .prepare(
        'INSERT INTO timelines (id, name, author_id, author_name, published_at, updated_at, version, content) VALUES (?,?,?,?,?,?,?,?)'
      )
      .bind(id, '回填标题', 'auth-z', 'AuthZ', now, now, 1, content)
      .run()

    // 预先把 DO seed 成缺 name 的坏数据(模拟旧版迁移)
    const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName(id))
    const badDoc = new Y.Doc()
    badDoc.getMap('meta').set('createdAt', 0)
    await stub.seed(Y.encodeStateAsUpdate(badDoc))
    expect((await stub.getSnapshotJson())!.name).toBe('')

    const res = await SELF.fetch('https://app/api/internal/migrate', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-sync-token' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { repaired: number }).toMatchObject({ repaired: 1 })

    expect((await stub.getSnapshotJson())!.name).toBe('回填标题')
  })
})
