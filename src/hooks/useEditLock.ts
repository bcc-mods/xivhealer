/** 只读能力集 hook —— 把 store 状态喂给 editLock 纯逻辑 */
import { useTimelineStore } from '@/store/timelineStore'
import { useUIStore } from '@/store/uiStore'
import { computeEditLock, type EditLock } from './editLock'

export function useEditLock(): EditLock {
  const sessionRole = useTimelineStore(s => s.sessionRole)
  const connectionStatus = useTimelineStore(s => s.connectionStatus)
  const isReplayMode = useTimelineStore(s => s.timeline?.isReplayMode ?? false)
  const manualLock = useUIStore(s => s.manualLock)
  return computeEditLock({ sessionRole, connectionStatus, isReplayMode, manualLock })
}

export type { EditCapability, EditLockCauseId } from './editLock'
