import { describe, it, expect } from 'vitest'
import { extractBossCasts, attachCastWindows } from './castWindowImport'
import type { DamageEvent } from '@/types/timeline'
import type { FFLogsEvent } from '@/types/fflogs'

const FS = 1000 // fightStartTime ms
const players = new Map([[24, { id: 24, name: 'P', type: 'WAR' }]])

function bc(
  type: 'begincast' | 'cast',
  src: number,
  id: number,
  tsMs: number,
  duration?: number
): FFLogsEvent {
  return {
    type,
    sourceID: src,
    targetID: src,
    abilityGameID: id,
    timestamp: tsMs,
    ...(duration ? { duration } : {}),
  }
}
function dmg(name: string, abilityId: number, tdMs: number): DamageEvent {
  return {
    id: name,
    name,
    time: (tdMs - FS) / 1000,
    damage: 1,
    type: 'aoe',
    damageType: 'magical',
    playerDamageDetails: [
      {
        timestamp: tdMs,
        playerId: 24,
        job: 'WAR',
        abilityId,
        unmitigatedDamage: 1,
        finalDamage: 1,
        statuses: [],
      },
    ],
  }
}

describe('extractBossCasts', () => {
  it('排除玩家施法，只留 boss begincast/cast', () => {
    const events = [bc('cast', 24, 999, 2000), bc('begincast', 50, 47877, 2100, 4700)]
    const out = extractBossCasts(events, players)
    expect(out).toHaveLength(1)
    expect(out[0].abilityGameID).toBe(47877)
  })
})

describe('attachCastWindows', () => {
  it('正常成对 → 写 castStartTime/castEndTime（秒）', () => {
    const boss = [bc('begincast', 50, 47877, 1500, 4700), bc('cast', 50, 47877, 6500)]
    const evs = [dmg('hit', 47877, 6600)]
    attachCastWindows(evs, boss, FS)
    expect(evs[0].castStartTime).toBe(0.5)
    expect(evs[0].castEndTime).toBe(5.5)
  })

  it('中断（仅 begincast 无 cast）→ 不写', () => {
    const boss = [bc('begincast', 50, 50718, 1500, 9700)]
    const evs = [dmg('hit', 50718, 12000)]
    attachCastWindows(evs, boss, FS)
    expect(evs[0].castStartTime).toBeUndefined()
    expect(evs[0].castEndTime).toBeUndefined()
  })

  it('瞬发（仅 cast 无 begincast）→ 不写', () => {
    const boss = [bc('cast', 50, 30000, 5000)]
    const evs = [dmg('hit', 30000, 5100)]
    attachCastWindows(evs, boss, FS)
    expect(evs[0].castStartTime).toBeUndefined()
  })

  it('中断悬挂 begincast 被之后瞬发 cast 误消费 → duration 校验丢弃', () => {
    // begincast@2s duration=9700，cast 出现在 +30s，远超 9700*1.5+1000 → 不配对
    const boss = [bc('begincast', 50, 70000, 2000, 9700), bc('cast', 50, 70000, 32000)]
    const evs = [dmg('hit', 70000, 32100)]
    attachCastWindows(evs, boss, FS)
    expect(evs[0].castStartTime).toBeUndefined()
  })

  it('多 boss 同技能并发 → 按 sourceID 分流，各自成对', () => {
    const boss = [
      bc('begincast', 50, 80000, 1000, 3000),
      bc('begincast', 51, 80000, 1200, 3000),
      bc('cast', 50, 80000, 4000),
      bc('cast', 51, 80000, 4200),
    ]
    const e1 = dmg('a', 80000, 4100) // 命中 source50 那对 [1000,4000]
    const e2 = dmg('b', 80000, 4300) // 命中 source51 那对 [1200,4200]
    attachCastWindows([e1, e2], boss, FS)
    expect(e1.castStartTime).toBe(0)
    expect(e1.castEndTime).toBe(3.0) // (4000-1000)/1000
    expect(e2.castStartTime).toBe(0.2)
    expect(e2.castEndTime).toBe(3.2) // (4200-1000)/1000
  })

  it('伤害技能 id ≠ 读条 id → 查不到，不写', () => {
    const boss = [bc('begincast', 50, 11111, 1000, 2000), bc('cast', 50, 11111, 3000)]
    const evs = [dmg('hit', 22222, 3100)]
    attachCastWindows(evs, boss, FS)
    expect(evs[0].castStartTime).toBeUndefined()
  })

  it('手动事件（无 playerDamageDetails）→ 跳过', () => {
    const boss = [bc('begincast', 50, 33333, 1000, 2000), bc('cast', 50, 33333, 3000)]
    const manual: DamageEvent = {
      id: 'm',
      name: 'M',
      time: 2,
      damage: 1,
      type: 'aoe',
      damageType: 'magical',
    }
    attachCastWindows([manual], boss, FS)
    expect(manual.castStartTime).toBeUndefined()
  })
})

describe('attachCastWindows 名称兜底（读条 id ≠ 伤害 id 但同名）', () => {
  it('id 落空但同名 + 提供解析器 → 名称兜底命中', () => {
    const resolve = (id: number) => (id === 11111 ? '灭杀' : undefined)
    const boss = [bc('begincast', 50, 11111, 1000, 2000), bc('cast', 50, 11111, 3000)]
    const evs = [dmg('灭杀', 22222, 3100)] // 伤害 id 22222 与读条 id 11111 不同，但同名
    attachCastWindows(evs, boss, FS, resolve)
    expect(evs[0].castStartTime).toBe(0)
    expect(evs[0].castEndTime).toBe(2.0)
  })

  it('无解析器时不做名称兜底', () => {
    const boss = [bc('begincast', 50, 11111, 1000, 2000), bc('cast', 50, 11111, 3000)]
    const evs = [dmg('灭杀', 22222, 3100)]
    attachCastWindows(evs, boss, FS) // 不传 resolver
    expect(evs[0].castStartTime).toBeUndefined()
  })

  it('占位名（未知技能）不参与名称兜底', () => {
    const resolve = () => '未知技能'
    const boss = [bc('begincast', 50, 11111, 1000, 2000), bc('cast', 50, 11111, 3000)]
    const evs = [dmg('未知技能', 22222, 3100)]
    attachCastWindows(evs, boss, FS, resolve)
    expect(evs[0].castStartTime).toBeUndefined()
  })

  it('名称兜底超出最大回溯窗口（>5s）→ 不命中', () => {
    const resolve = (id: number) => (id === 11111 ? '延迟' : undefined)
    const boss = [bc('begincast', 50, 11111, 1000, 2000), bc('cast', 50, 11111, 3000)]
    const evs = [dmg('延迟', 22222, 3000 + 40000)] // cast 结束 3000ms，td 晚 40s，远超窗口
    attachCastWindows(evs, boss, FS, resolve)
    expect(evs[0].castStartTime).toBeUndefined()
  })

  it('同名单次咏唱 + 多个同名伤害 → 只有第一个兜底命中，配对不复用', () => {
    const resolve = (id: number) => (id === 11111 ? '连击' : undefined)
    const boss = [bc('begincast', 50, 11111, 1000, 2000), bc('cast', 50, 11111, 3000)]
    // 两个伤害 id 都 ≠ 11111 但同名；只有一次咏唱窗口
    const e1 = dmg('连击', 22222, 3100)
    const e2 = dmg('连击', 22222, 3200)
    attachCastWindows([e1, e2], boss, FS, resolve)
    expect(e1.castStartTime).toBe(0)
    expect(e1.castEndTime).toBe(2.0)
    expect(e2.castStartTime).toBeUndefined() // 配对已被 e1 消费，不复用
  })

  it('同名两次咏唱 + 两个同名伤害 → 各自消费一对', () => {
    const resolve = (id: number) => (id === 11111 ? '连击' : undefined)
    const boss = [
      bc('begincast', 50, 11111, 1000, 1000),
      bc('cast', 50, 11111, 2000),
      bc('begincast', 50, 11111, 3000, 1000),
      bc('cast', 50, 11111, 4000),
    ]
    const e1 = dmg('连击', 22222, 2100) // 命中第一对 [1000,2000]
    const e2 = dmg('连击', 22222, 4100) // 命中第二对 [3000,4000]
    attachCastWindows([e1, e2], boss, FS, resolve)
    expect(e1.castEndTime).toBe(1.0)
    expect(e2.castStartTime).toBe(2.0)
    expect(e2.castEndTime).toBe(3.0)
  })

  it('id 精确匹配优先于同名兜底', () => {
    const resolve = (id: number) => (id === 11111 || id === 22222 ? '技' : undefined)
    // 22222：与伤害 id 相同，结束 3000；11111：同名不同 id，结束 3500（更接近 td）
    const boss = [
      bc('begincast', 50, 22222, 1000, 2000),
      bc('cast', 50, 22222, 3000),
      bc('begincast', 50, 11111, 1500, 2000),
      bc('cast', 50, 11111, 3500),
    ]
    const evs = [dmg('技', 22222, 3600)]
    attachCastWindows(evs, boss, FS, resolve)
    // id 命中 22222 那对 [1000,3000]，而非更近的同名 11111 [1500,3500]
    expect(evs[0].castStartTime).toBe(0)
    expect(evs[0].castEndTime).toBe(2.0)
  })
})
