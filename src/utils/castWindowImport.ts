/**
 * FFLogs 导入：从 boss begincast/cast 配对推导伤害事件读条窗口
 */

import type { DamageEvent } from '@/types/timeline'
import type { FFLogsEvent } from '@/types/fflogs'

type PlayerMap = Map<number, { id: number; name: string; type: string }>

/** 提取 boss/NPC 的 begincast/cast（排除玩家施法），保持原事件顺序（FFLogs 已时间升序）。 */
export function extractBossCasts(events: FFLogsEvent[], playerMap: PlayerMap): FFLogsEvent[] {
  const out: FFLogsEvent[] = []
  for (const ev of events) {
    if (ev.type !== 'begincast' && ev.type !== 'cast') continue
    if (!ev.abilityGameID) continue
    if (ev.sourceID != null && playerMap.has(ev.sourceID)) continue
    out.push(ev)
  }
  return out
}

interface CastPair {
  startMs: number
  endMs: number
}

/** 按 (sourceID, abilityGameID) 分流配对 begincast→cast；含 duration 合理性校验。 */
function buildCastPairs(bossCasts: FFLogsEvent[]): Map<number, CastPair[]> {
  const pairs = new Map<number, CastPair[]>()
  const pending = new Map<string, { startMs: number; durationMs: number }>()
  for (const ev of bossCasts) {
    const id = ev.abilityGameID!
    const pk = `${ev.sourceID ?? 0}:${id}`
    if (ev.type === 'begincast') {
      pending.set(pk, { startMs: ev.timestamp, durationMs: ev.duration ?? 0 })
    } else {
      const begin = pending.get(pk)
      if (begin === undefined) continue // 瞬发：无 pending
      pending.delete(pk)
      // 中断悬挂的 begincast 被之后瞬发 cast 误消费时，窗口会远超预期读条时长 → 丢弃
      if (begin.durationMs && ev.timestamp - begin.startMs > begin.durationMs * 1.5 + 1000) continue
      let arr = pairs.get(id)
      if (!arr) pairs.set(id, (arr = []))
      arr.push({ startMs: begin.startMs, endMs: ev.timestamp })
    }
  }
  for (const arr of pairs.values()) arr.sort((a, b) => a.endMs - b.endMs)
  return pairs
}

/** 给每个伤害事件回填读条窗口（原地，成对写入）。 */
export function attachCastWindows(
  damageEvents: DamageEvent[],
  bossCasts: FFLogsEvent[],
  fightStartTime: number
): void {
  const pairs = buildCastPairs(bossCasts)
  const toSec = (ms: number) => Math.round((ms - fightStartTime) / 10) / 100
  for (const ev of damageEvents) {
    const details = ev.playerDamageDetails
    if (!details || details.length === 0) continue
    let td = Infinity
    let abilityId = 0
    for (const d of details) {
      if (d.timestamp < td) {
        td = d.timestamp
        abilityId = d.abilityId ?? 0
      }
    }
    const list = pairs.get(abilityId)
    if (!list) continue
    let hit: CastPair | null = null
    for (let k = list.length - 1; k >= 0; k--) {
      if (list[k].endMs <= td) {
        hit = list[k]
        break
      }
    }
    if (!hit) continue
    ev.castStartTime = toSec(hit.startMs)
    ev.castEndTime = toSec(hit.endMs)
  }
}
