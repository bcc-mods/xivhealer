import { describe, it, expect } from 'vitest'
import type { Timeline } from '@/types/timeline'
import { extractImportableFromTimeline } from './importAdapter'

const baseTimeline = (overrides: Partial<Timeline> = {}): Timeline => ({
  id: 't1',
  name: 'fake',
  encounter: { id: 1077, name: 'M3S', displayName: 'M3S', zone: '', damageEvents: [] },
  composition: { players: [] },
  damageEvents: [],
  castEvents: [],
  statusEvents: [],
  annotations: [],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe('extractImportableFromTimeline', () => {
  it('提取三个事件数组 + encounter + 拼接 sourceLabel', () => {
    const t = baseTimeline({
      damageEvents: [
        { id: 'd1', name: 'X', time: 1, damage: 100, type: 'aoe', damageType: 'magical' },
      ],
      castEvents: [{ id: 'c1', actionId: 7382, timestamp: 2, playerId: 1 }],
      syncEvents: [
        { time: 1, type: 'cast', actionId: 100, actionName: 'A', window: [2, 2], syncOnce: false },
      ],
      fflogsSource: { reportCode: 'ABC123', fightId: 5 },
    })

    const out = extractImportableFromTimeline(t)

    expect(out.damageEvents).toHaveLength(1)
    expect(out.castEvents).toHaveLength(1)
    expect(out.syncEvents).toHaveLength(1)
    expect(out.encounter?.id).toBe(1077)
    expect(out.sourceLabel).toContain('ABC123')
    expect(out.sourceLabel).toContain('#5')
    expect(out.sourceLabel).toContain('M3S')
  })

  it('syncEvents 缺失时返回空数组', () => {
    const t = baseTimeline()
    expect(extractImportableFromTimeline(t).syncEvents).toEqual([])
  })

  it('fflogsSource 缺失时 sourceLabel 仅含 encounter 名', () => {
    const t = baseTimeline()
    expect(extractImportableFromTimeline(t).sourceLabel).toBe('M3S')
  })
})
