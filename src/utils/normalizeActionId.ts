import { MITIGATION_DATA } from '@/data/mitigationActions'
import { effectiveTrackGroup } from '@/types/mitigation'

const PARENT_BY_ID = new Map<number, number>(
  MITIGATION_DATA.actions.map(a => [a.id, effectiveTrackGroup(a)])
)

/** 把(可能是子变体的)actionId 归一为 trackGroup 父 id;未知 id 原样返回。 */
export function normalizeActionId(actionId: number): number {
  return PARENT_BY_ID.get(actionId) ?? actionId
}
