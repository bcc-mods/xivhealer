// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { runClientMigration } from './migration'
import { IndexedDBDocStore } from './storage/IndexedDBDocStore'

const STORAGE_KEY = 'healerbook_timelines'

function seedLegacyTimeline(id: string, name: string, isShared: boolean) {
  const meta = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  meta.push({
    id,
    name,
    encounterId: '1',
    createdAt: 1,
    updatedAt: 1,
    ...(isShared && { isShared: true }),
  })
  localStorage.setItem(STORAGE_KEY, JSON.stringify(meta))
  localStorage.setItem(
    `${STORAGE_KEY}_${id}`,
    JSON.stringify({
      id,
      name,
      isShared,
      encounter: { id: 1, name: 'E', displayName: 'E', zone: '', damageEvents: [] },
      composition: { players: [] },
      damageEvents: [],
      castEvents: [],
      annotations: [],
      createdAt: 1,
      updatedAt: 1,
    })
  )
}

beforeEach(() => {
  localStorage.clear()
  // Reset fake-indexeddb to a fresh IDBFactory so each test gets an isolated DB.
  // @ts-expect-error fake-indexeddb: reassign global to get a clean slate
  // eslint-disable-next-line no-global-assign
  indexedDB = new IDBFactory()
})

describe('runClientMigration', () => {
  it('migrates a pure-local timeline to a Y.Doc with kind=local meta', async () => {
    seedLegacyTimeline('local-1', '本地轴', false)
    await runClientMigration()

    const store = new IndexedDBDocStore()
    await store.open()
    expect(await store.loadDoc('local-1')).not.toBeNull()
    const meta = await store.getMeta('local-1')
    expect(meta?.kind).toBe('local')
  })

  it('does NOT store a local Y.Doc for a formerly-shared timeline', async () => {
    seedLegacyTimeline('shared-1', '云端轴', true)
    await runClientMigration()

    const store = new IndexedDBDocStore()
    await store.open()
    expect(await store.loadDoc('shared-1')).toBeNull()
    const meta = await store.getMeta('shared-1')
    expect(meta?.kind).toBe('published')
  })

  it('clears legacy localStorage keys after migration', async () => {
    seedLegacyTimeline('x', 'X', false)
    await runClientMigration()
    expect(localStorage.getItem(`${STORAGE_KEY}_x`)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('does nothing when there is no legacy localStorage data', async () => {
    await runClientMigration()
    const store = new IndexedDBDocStore()
    await store.open()
    expect(await store.getAllMeta()).toEqual([])
  })

  it('is idempotent — a second run after the legacy index is cleared is a no-op', async () => {
    seedLegacyTimeline('y', 'Y', false)
    await runClientMigration()
    // 迁移已删除旧索引键;再次运行应直接跳过,不报错、不影响已迁移数据
    await runClientMigration()
    const store = new IndexedDBDocStore()
    await store.open()
    expect(await store.getMeta('y')).not.toBeNull()
  })
})
