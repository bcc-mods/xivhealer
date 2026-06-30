import type { DamageEvent } from '@/types/timeline'
import { MIN_CARD_WIDTH } from './constants'

export interface DamageCardGeometry {
  /** Rect 相对 group 原点（=判定时间 time）的局部 x，px，≤0 表示向左延伸 */
  leftLocal: number
  /** 卡片像素宽（已应用最小宽度） */
  width: number
  /** 占用区间左端（秒），供泳道/裁剪复用 */
  rawLeftSec: number
  /** 占用区间右端（秒） */
  rawRightSec: number
}

export function computeDamageCardGeometry(
  event: DamageEvent,
  zoomLevel: number
): DamageCardGeometry {
  const { time, castStartTime, castEndTime } = event
  const hasCast = castStartTime != null && castEndTime != null
  const rawLeftSec = hasCast ? Math.min(castStartTime, time) : time
  const rawRightSec = hasCast ? Math.max(castEndTime, time) : time
  const leftLocal = (rawLeftSec - time) * zoomLevel
  const width = Math.max((rawRightSec - rawLeftSec) * zoomLevel, MIN_CARD_WIDTH)
  return { leftLocal, width, rawLeftSec, rawRightSec }
}
