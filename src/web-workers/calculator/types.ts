/**
 * Calculator Worker 通信协议
 */

import type { SimulateInput, SimulateOutput } from '@/utils/mitigationCalculator'
import type { StatusInterval } from '@/types/status'

export type StatusTimelineByPlayer = Map<number, Map<number, StatusInterval[]>>

export interface SimulateRequest {
  requestId: string
  /** 主线程单调递增，用于 worker 决定缓存失效。 */
  version: number
  input: SimulateInput
  /** 额外按 excludeId 派生的 timeline 集合（去重）。 */
  extraExcludeIds: string[]
}

export interface SimulateBundle {
  /** 完整主路径 simulate 输出（含 hpTimeline、healSnapshots 等） */
  main: SimulateOutput
  /** 每个 excludeId 对应的 statusTimelineByPlayer */
  removalTimelinesByExcludeId: Map<string, StatusTimelineByPlayer>
}

export type SimulateResponse =
  | { requestId: string; ok: true; bundle: SimulateBundle }
  | { requestId: string; ok: false; error: { message: string; stack?: string } }
