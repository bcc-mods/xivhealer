import { describe, it, expect } from 'vitest'
import { createPlacementEngine } from './engine'
import { MITIGATION_DATA } from '@/data/mitigationActions'
import { createMitigationCalculator } from '@/utils/mitigationCalculator'
import type { CastEvent, DamageEvent } from '@/types/timeline'
import type { PartyState } from '@/types/partyState'

const actions = new Map(MITIGATION_DATA.actions.map(a => [a.id, a]))
const initialState: PartyState = { statuses: [], timestamp: 0 } as PartyState

function makeEngine(castEvents: CastEvent[]) {
  const calc = createMitigationCalculator()
  const damageEvents: DamageEvent[] = [
    {
      id: 'd-end',
      name: 'd-end',
      time: 600,
      damage: 100000,
      type: 'aoe',
      damageType: 'physical',
    } as DamageEvent,
  ]
  const full = calc.simulate({ castEvents, damageEvents, initialState })
  // 预算每个 cast 的"假装它不存在"的 status timeline，等价于原 simulateOnRemove
  // 回调按需重跑的结果。worker 路径在生产环境会一次性返回这张表。
  const removalTimelinesByExcludeId = new Map<
    string,
    ReturnType<typeof calc.simulate>['statusTimelineByPlayer']
  >()
  for (const ce of castEvents) {
    const result = calc.simulate({
      castEvents: castEvents.filter(e => e.id !== ce.id),
      damageEvents,
      initialState,
      skipHpPipeline: true,
    })
    removalTimelinesByExcludeId.set(ce.id, result.statusTimelineByPlayer)
  }
  return createPlacementEngine({
    castEvents,
    actions,
    statusTimelineByPlayer: full.statusTimelineByPlayer,
    removalTimelinesByExcludeId,
  })
}

describe('placement 集成', () => {
  it('炽天附体期间双击产出 37016，非 buff 期产出 37013', () => {
    const SERAPHISM_CAST = {
      id: 's',
      actionId: 37014,
      playerId: 1,
      timestamp: 10,
    } as unknown as CastEvent
    const engine = makeEngine([SERAPHISM_CAST])

    expect(engine.pickUniqueMember(37013, 1, 20)?.id).toBe(37016)
    expect(engine.pickUniqueMember(37013, 1, 45)?.id).toBe(37013) // buff 10+30=40 后失效
  })

  it('炽天附体期间把 37013 cast 放进 buff 窗口内 → 自动跟随为 37016，不标红（placement_lost）', () => {
    // 变体运行时派生后，cast 只存 trackGroup 父 id（37013）。父 id 自身的 placement
    // 在炽天附体期内非法，但组内存在合法变体（37016 降临之章）→ 整组合法 → 不该红框。
    const SERAPHISM_CAST = {
      id: 's',
      actionId: 37014,
      playerId: 1,
      timestamp: 10,
    } as unknown as CastEvent
    const INTUITION = {
      id: 'intu',
      actionId: 37013,
      playerId: 1,
      timestamp: 20,
    } as unknown as CastEvent
    const engine = makeEngine([SERAPHISM_CAST, INTUITION])

    // 组内任一变体在 t 合法即整组合法：buff 期内 37016 合法 → 不标 placement_lost。
    const invalid = engine.findInvalidCastEvents()
    expect(invalid.some(r => r.castEvent.id === 'intu')).toBe(false)
    // 且该时刻解析出的变体确为降临之章。
    expect(engine.pickUniqueMember(37013, 1, 20)?.id).toBe(37016)
  })

  it('拖拽 37014 预览移除 buff：cast 自动跟随回 37013，仍合法不红框', () => {
    // 变体运行时派生 + 自动跟随语义：cast 存父 id，buff 消失时自动解析回非 buff 形态
    // （37013），该形态在此刻合法 → 不红框。旧"持久化具体变体"模型下会因 37016 失去
    // buff 触发而红框，现已不再适用。
    const SERAPHISM_CAST = {
      id: 's',
      actionId: 37014,
      playerId: 1,
      timestamp: 10,
    } as unknown as CastEvent
    // 旧数据可能仍存子变体 id 37016；读取层会归一为父 id，这里直接构造以覆盖兜底。
    const ACCESSION_CAST = {
      id: 'a',
      actionId: 37016,
      playerId: 1,
      timestamp: 20,
    } as unknown as CastEvent
    const engine = makeEngine([SERAPHISM_CAST, ACCESSION_CAST])

    // 默认（不拖拽）：buff 在 → 组内合法 → 不红框
    expect(engine.findInvalidCastEvents().some(r => r.castEvent.id === 'a')).toBe(false)
    // 预览"删除 37014"：buff 消失，但组内 37013 在该时刻合法（自动跟随）→ 仍不红框
    expect(engine.findInvalidCastEvents('s').some(r => r.castEvent.id === 'a')).toBe(false)
    // 该时刻解析出的变体回到非 buff 形态 37013
    expect(engine.pickUniqueMember(37013, 1, 20, 's')?.id).toBe(37013)
  })
})
