import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { LocalSyncEngine } from './LocalSyncEngine'
import { buildYDoc, yAddCastEvent, projectTimeline } from './docSchema'
import type { TimelineContent } from './types'

const content: TimelineContent = {
  name: 'eng',
  encounter: { id: 1, name: 'E', displayName: 'E', zone: '', damageEvents: [] },
  composition: { players: [{ id: 1, job: 'PLD' }] },
  damageEvents: [],
  castEvents: [],
  annotations: [],
  createdAt: 0,
}

describe('LocalSyncEngine', () => {
  beforeEach(() => {
    // @ts-expect-error fake-indexeddb: 每个用例独立 DB
    // eslint-disable-next-line no-global-assign
    indexedDB = new IDBFactory()
  })

  it('本地编辑会持久化,重开引擎能读回', async () => {
    const e1 = await LocalSyncEngine.create('t1', buildYDoc(content))
    yAddCastEvent(e1.doc, { id: 'c1', actionId: 1, timestamp: 1, playerId: 1 })
    await e1.flush() // 等持久化完成
    e1.destroy()

    const e2 = await LocalSyncEngine.create('t1')
    expect(projectTimeline(e2.doc).castEvents.map(c => c.id)).toEqual(['c1'])
  })

  it('undo 撤销本地编辑', async () => {
    const e = await LocalSyncEngine.create('t2', buildYDoc(content))
    yAddCastEvent(e.doc, { id: 'c1', actionId: 1, timestamp: 1, playerId: 1 })
    expect(projectTimeline(e.doc).castEvents).toHaveLength(1)
    e.undoManager.undo()
    expect(projectTimeline(e.doc).castEvents).toHaveLength(0)
  })
})
