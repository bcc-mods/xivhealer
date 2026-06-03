/** 框选相交判定 —— 纯函数，坐标统一为画布容器屏幕坐标 */
export interface MarqueeBox {
  x0: number
  y0: number
  x1: number
  y1: number
}
export interface MarqueeObject {
  id: string
  kind: 'damage' | 'cast' | 'annotation'
  x0: number
  x1: number
  y0: number
  y1: number
}
export interface MarqueeSelection {
  eventIds: string[]
  castEventIds: string[]
  annotationIds: string[]
}

/**
 * @param infiniteHeight 标尺区拖动时为 true：忽略 y，只按时间(x)范围相交
 */
export function computeMarqueeSelection(
  objs: MarqueeObject[],
  box: MarqueeBox,
  infiniteHeight: boolean
): MarqueeSelection {
  const bx0 = Math.min(box.x0, box.x1)
  const bx1 = Math.max(box.x0, box.x1)
  const by0 = Math.min(box.y0, box.y1)
  const by1 = Math.max(box.y0, box.y1)
  const out: MarqueeSelection = { eventIds: [], castEventIds: [], annotationIds: [] }
  for (const o of objs) {
    const xHit = o.x1 >= bx0 && o.x0 <= bx1
    const yHit = infiniteHeight || (o.y1 >= by0 && o.y0 <= by1)
    if (xHit && yHit) {
      if (o.kind === 'damage') out.eventIds.push(o.id)
      else if (o.kind === 'cast') out.castEventIds.push(o.id)
      else out.annotationIds.push(o.id)
    }
  }
  return out
}
