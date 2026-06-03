import { describe, it, expect } from 'vitest'
import { computeMarqueeSelection } from './marqueeHitTest'
import type { MarqueeObject } from './marqueeHitTest'

const objs: MarqueeObject[] = [
  { id: 'd1', kind: 'damage', x0: 100, x1: 140, y0: 0, y1: 40 },
  { id: 'c1', kind: 'cast', x0: 200, x1: 230, y0: 120, y1: 150 },
  { id: 'a1', kind: 'annotation', x0: 300, x1: 320, y0: 120, y1: 150 },
]

describe('computeMarqueeSelection', () => {
  it('相交即选中（碰到就选）', () => {
    const r = computeMarqueeSelection(objs, { x0: 130, y0: 10, x1: 210, y1: 130 }, false)
    expect(r.eventIds).toEqual(['d1'])
    expect(r.castEventIds).toEqual(['c1'])
    expect(r.annotationIds).toEqual([])
  })

  it('无限高度：忽略 y，只比时间(x)范围', () => {
    const r = computeMarqueeSelection(objs, { x0: 90, y0: 999, x1: 320, y1: 1000 }, true)
    expect(r.eventIds).toEqual(['d1'])
    expect(r.castEventIds).toEqual(['c1'])
    expect(r.annotationIds).toEqual(['a1'])
  })

  it('选框归一化（起点可在终点右下）', () => {
    const r = computeMarqueeSelection(objs, { x0: 210, y0: 130, x1: 130, y1: 10 }, false)
    expect(r.eventIds).toEqual(['d1'])
    expect(r.castEventIds).toEqual(['c1'])
  })
})
