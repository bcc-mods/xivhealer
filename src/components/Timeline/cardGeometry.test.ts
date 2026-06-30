import { describe, it, expect } from 'vitest'
import { computeDamageCardGeometry } from './cardGeometry'
import { MIN_CARD_WIDTH } from './constants'
import type { DamageEvent } from '@/types/timeline'

const base: DamageEvent = {
  id: 'x',
  name: 'A',
  time: 10,
  damage: 1,
  type: 'aoe',
  damageType: 'magical',
}
const Z = 50 // 像素/秒

describe('computeDamageCardGeometry', () => {
  it('无读条 → 左缘=判定时间，宽=最小宽', () => {
    const g = computeDamageCardGeometry(base, Z)
    expect(g.leftLocal).toBe(0)
    expect(g.width).toBe(MIN_CARD_WIDTH)
    expect(g.rawLeftSec).toBe(10)
    expect(g.rawRightSec).toBe(10)
  })

  it('读条窗口宽于最小宽 → 按窗口宽，左缘负向延伸', () => {
    const ev = { ...base, castStartTime: 4, castEndTime: 10 } // 6s*50=300px
    const g = computeDamageCardGeometry(ev, Z)
    expect(g.leftLocal).toBe((4 - 10) * Z) // -300
    expect(g.width).toBe(300)
    expect(g.rawLeftSec).toBe(4)
    expect(g.rawRightSec).toBe(10)
  })

  it('读条窗口窄于最小宽 → 撑到最小宽，左缘仍在窗口左', () => {
    const ev = { ...base, castStartTime: 9.5, castEndTime: 10 } // 0.5s*50=25px < 150
    const g = computeDamageCardGeometry(ev, Z)
    expect(g.leftLocal).toBe((9.5 - 10) * Z) // -25
    expect(g.width).toBe(MIN_CARD_WIDTH)
  })

  it('判定时间晚于读条结束 → 区间含判定点，卡片撑大', () => {
    const ev = { ...base, castStartTime: 4, castEndTime: 8, time: 10 }
    const g = computeDamageCardGeometry(ev, Z)
    expect(g.rawLeftSec).toBe(4)
    expect(g.rawRightSec).toBe(10) // max(castEnd=8, time=10)
    expect(g.leftLocal).toBe((4 - 10) * Z)
    expect(g.width).toBe((10 - 4) * Z) // 300
  })

  it('判定点恒在卡片内：local 0 落于 [leftLocal, leftLocal+width]', () => {
    const ev = { ...base, castStartTime: 9.9, castEndTime: 9.95 }
    const g = computeDamageCardGeometry(ev, Z)
    expect(0).toBeGreaterThanOrEqual(g.leftLocal)
    expect(0).toBeLessThanOrEqual(g.leftLocal + g.width)
  })
})
