# Peer 光标 / 拖动补间平滑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为实时协作中其他 peer 的光标竖线（`cursorTime`）和拖动 ghost（`dragging.time`）加入逐帧指数补间，使其平滑逼近网络推送的目标值，消除「到达即跳变」的卡顿感。

**Architecture:** 新增纯逻辑模块 `peerCursorSmoothing.ts`（帧率无关指数逼近 + 吸附/收敛判定，不依赖 React/rAF，可单测）；新增薄 hook `useSmoothedPeers`（订阅 store peers、驱动单个 rAF 循环、settled 即停）；`PeerOverlayFixed/Main` 改为从 prop 接收平滑后的 peers，`Timeline/index.tsx` 调用 hook 一次并下发。

**Tech Stack:** React 19 + TypeScript、Zustand、React-Konva、Vitest 4。

设计来源：`design/superpowers/specs/2026-05-26-peer-cursor-smoothing-design.md`

---

## File Structure

- **Create** `src/utils/peerCursorSmoothing.ts` — 纯逻辑：`stepValue`、`advancePeerSmoothing`、平滑态类型与配置常量。无 React/rAF 依赖。
- **Create** `src/utils/peerCursorSmoothing.test.ts` — Vitest 单测，同目录。
- **Create** `src/components/Timeline/useSmoothedPeers.ts` — hook，包装纯逻辑 + rAF + store 订阅。
- **Modify** `src/components/Timeline/PeerOverlay.tsx` — 两个 overlay 改为从 prop 接收 `peers`，删除内部 `useTimelineStore(s => s.peers)`。
- **Modify** `src/components/Timeline/index.tsx` — 调用 `useSmoothedPeers()` 一次，把结果传给两个 overlay。

---

## Task 1: 纯逻辑模块 `peerCursorSmoothing.ts`

**Files:**

- Create: `src/utils/peerCursorSmoothing.ts`
- Test: `src/utils/peerCursorSmoothing.test.ts`

数据流：`advancePeerSmoothing(peers, prevState, dtMs, zoomLevel)` 接收当前 store peers、上一帧平滑态、帧间隔、缩放，返回平滑后的 `PeerState[]`、新平滑态、是否仍在动。仅平滑 `cursorTime` 与 `dragging.time` 两个时间标量，其余字段透传。

- [ ] **Step 1: 写失败测试**

创建 `src/utils/peerCursorSmoothing.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { stepValue, advancePeerSmoothing, type SmoothStateMap } from './peerCursorSmoothing'
import type { PeerState } from '@/collab/awarenessTypes'

// 构造 peer 的辅助函数
function makePeer(over: Partial<PeerState> = {}): PeerState {
  return {
    clientId: 1,
    user: { id: 'u1', name: 'Alice', color: '#f00' },
    selection: { eventId: null, castEventId: null },
    cursorTime: null,
    dragging: null,
    ...over,
  }
}

describe('stepValue（帧率无关指数逼近）', () => {
  it('单调逼近目标且不超调', () => {
    const tau = 80
    let cur = 0
    const target = 10
    let prev = cur
    for (let i = 0; i < 50; i++) {
      cur = stepValue(cur, target, 16, tau)
      expect(cur).toBeGreaterThanOrEqual(prev) // 单调
      expect(cur).toBeLessThanOrEqual(target) // 不超调
      prev = cur
    }
    expect(cur).toBeCloseTo(target, 1)
  })

  it('帧率无关：一帧 dt=32 与两帧 dt=16 累积结果一致', () => {
    const tau = 80
    const oneStep = stepValue(0, 10, 32, tau)
    const twoStep = stepValue(stepValue(0, 10, 16, tau), 10, 16, tau)
    expect(oneStep).toBeCloseTo(twoStep, 6)
  })
})

describe('advancePeerSmoothing', () => {
  const ZOOM = 50 // px/秒
  const empty: SmoothStateMap = new Map()

  it('cursorTime 从 null→有值：首帧直接吸附到目标', () => {
    const peers = [makePeer({ cursorTime: 4 })]
    const { smoothed } = advancePeerSmoothing(peers, empty, 16, ZOOM)
    expect(smoothed[0].cursorTime).toBe(4)
  })

  it('cursorTime 小幅移动：介于旧值与目标之间', () => {
    const prev: SmoothStateMap = new Map([[1, { cursorTime: 4, dragging: null }]])
    const peers = [makePeer({ cursorTime: 5 })]
    const { smoothed, animating } = advancePeerSmoothing(peers, prev, 16, ZOOM)
    expect(smoothed[0].cursorTime!).toBeGreaterThan(4)
    expect(smoothed[0].cursorTime!).toBeLessThan(5)
    expect(animating).toBe(true)
  })

  it('cursorTime 从有值→null：显示态清除', () => {
    const prev: SmoothStateMap = new Map([[1, { cursorTime: 4, dragging: null }]])
    const peers = [makePeer({ cursorTime: null })]
    const { smoothed } = advancePeerSmoothing(peers, prev, 16, ZOOM)
    expect(smoothed[0].cursorTime).toBeNull()
  })

  it('超大跳变（像素距离超阈值）：直接吸附', () => {
    const prev: SmoothStateMap = new Map([[1, { cursorTime: 0, dragging: null }]])
    // 100 秒 × 50 px = 5000px，远超阈值
    const peers = [makePeer({ cursorTime: 100 })]
    const { smoothed } = advancePeerSmoothing(peers, prev, 16, ZOOM)
    expect(smoothed[0].cursorTime).toBe(100)
  })

  it('收敛：差值小于 epsilon 时吸附到目标且不再 animating', () => {
    // 显示值与目标仅差 0.001 秒 × 50px = 0.05px < epsilon
    const prev: SmoothStateMap = new Map([[1, { cursorTime: 4.999, dragging: null }]])
    const peers = [makePeer({ cursorTime: 5 })]
    const { smoothed, animating } = advancePeerSmoothing(peers, prev, 16, ZOOM)
    expect(smoothed[0].cursorTime).toBe(5)
    expect(animating).toBe(false)
  })

  it('dragging 从 null→有值：吸附到起始位置', () => {
    const peers = [makePeer({ dragging: { id: 'd1', kind: 'damage', time: 8, playerId: null } })]
    const { smoothed } = advancePeerSmoothing(peers, empty, 16, ZOOM)
    expect(smoothed[0].dragging!.time).toBe(8)
  })

  it('dragging.id 切换：吸附到新对象起始位置而非滑入', () => {
    const prev: SmoothStateMap = new Map([
      [1, { cursorTime: null, dragging: { id: 'd1', time: 2 } }],
    ])
    const peers = [makePeer({ dragging: { id: 'd2', kind: 'cast', time: 9, playerId: 3 } })]
    const { smoothed } = advancePeerSmoothing(peers, prev, 16, ZOOM)
    expect(smoothed[0].dragging!.time).toBe(9)
    expect(smoothed[0].dragging!.id).toBe('d2')
    expect(smoothed[0].dragging!.kind).toBe('cast')
    expect(smoothed[0].dragging!.playerId).toBe(3)
  })

  it('dragging 同 id 平移：time 介于旧值与目标之间', () => {
    const prev: SmoothStateMap = new Map([
      [1, { cursorTime: null, dragging: { id: 'd1', time: 2 } }],
    ])
    const peers = [makePeer({ dragging: { id: 'd1', kind: 'damage', time: 3, playerId: null } })]
    const { smoothed, animating } = advancePeerSmoothing(peers, prev, 16, ZOOM)
    expect(smoothed[0].dragging!.time).toBeGreaterThan(2)
    expect(smoothed[0].dragging!.time).toBeLessThan(3)
    expect(animating).toBe(true)
  })

  it('新平滑态只保留当前 peers 的 clientId', () => {
    const prev: SmoothStateMap = new Map([
      [1, { cursorTime: 4, dragging: null }],
      [99, { cursorTime: 7, dragging: null }], // 已离开的 peer
    ])
    const peers = [makePeer({ clientId: 1, cursorTime: 4 })]
    const { state } = advancePeerSmoothing(peers, prev, 16, ZOOM)
    expect(state.has(1)).toBe(true)
    expect(state.has(99)).toBe(false)
  })

  it('其余字段（user / selection / clientId）原样透传', () => {
    const peers = [makePeer({ cursorTime: 4, selection: { eventId: 'e1', castEventId: null } })]
    const { smoothed } = advancePeerSmoothing(peers, empty, 16, ZOOM)
    expect(smoothed[0].clientId).toBe(1)
    expect(smoothed[0].user.name).toBe('Alice')
    expect(smoothed[0].selection.eventId).toBe('e1')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run peerCursorSmoothing`
Expected: FAIL —— 模块/导出不存在（`Cannot find module './peerCursorSmoothing'` 或 `stepValue is not a function`）。

- [ ] **Step 3: 实现 `peerCursorSmoothing.ts`**

创建 `src/utils/peerCursorSmoothing.ts`：

```ts
/**
 * Peer 光标 / 拖动补间的纯逻辑：帧率无关指数逼近 + 吸附 / 收敛判定。
 * 不依赖 React / requestAnimationFrame，便于单测；由 useSmoothedPeers 驱动。
 *
 * 只平滑两个时间标量：peer.cursorTime 与 peer.dragging.time；其余字段原样透传。
 */
import type { PeerState } from '@/collab/awarenessTypes'

/** 时间常数（ms）：越小越跟手，越大越顺滑 */
export const SMOOTH_TAU_MS = 80
/** 收敛阈值（像素）：显示值与目标差小于此值即吸附并判定 settled */
export const SETTLE_EPSILON_PX = 0.5
/** 超大跳变阈值（像素）：超过则直接吸附，避免长时间滑行 */
export const SNAP_THRESHOLD_PX = 400

/** 单个 peer 的平滑显示态（按 clientId 索引）。null 表示当前无该元素。 */
export interface PeerSmoothState {
  cursorTime: number | null
  dragging: { id: string; time: number } | null
}

export type SmoothStateMap = Map<number, PeerSmoothState>

export interface AdvanceConfig {
  tauMs?: number
  settleEpsilonPx?: number
  snapThresholdPx?: number
}

export interface AdvanceResult {
  /** 平滑后的 peers（形状同 PeerState[]，仅时间标量被替换） */
  smoothed: PeerState[]
  /** 新的平滑态，作为下一帧的 prev */
  state: SmoothStateMap
  /** 是否仍有 peer 未收敛（用于决定是否继续 rAF） */
  animating: boolean
}

/** 帧率无关指数逼近：cur 向 target 逼近，dt/tau 单位需一致（此处均为 ms）。 */
export function stepValue(cur: number, target: number, dtMs: number, tauMs: number): number {
  const factor = 1 - Math.exp(-dtMs / tauMs)
  return cur + (target - cur) * factor
}

/**
 * 推进一帧：给定当前 store peers、上一帧平滑态、帧间隔与缩放，
 * 产出平滑后的 peers、新平滑态、是否仍在动。
 */
export function advancePeerSmoothing(
  peers: PeerState[],
  prev: SmoothStateMap,
  dtMs: number,
  zoomLevel: number,
  config: AdvanceConfig = {}
): AdvanceResult {
  const tau = config.tauMs ?? SMOOTH_TAU_MS
  const epsilonPx = config.settleEpsilonPx ?? SETTLE_EPSILON_PX
  const snapPx = config.snapThresholdPx ?? SNAP_THRESHOLD_PX

  const nextState: SmoothStateMap = new Map()
  const smoothed: PeerState[] = []
  let animating = false

  for (const peer of peers) {
    const prevState = prev.get(peer.clientId)

    // ── cursorTime ──
    let displayedCursor: number | null = null
    const targetCursor = peer.cursorTime
    if (targetCursor != null) {
      const prevCursor = prevState?.cursorTime ?? null
      if (prevCursor == null) {
        // null → 有值：吸附
        displayedCursor = targetCursor
      } else if (Math.abs(targetCursor - prevCursor) * zoomLevel > snapPx) {
        // 超大跳变：吸附
        displayedCursor = targetCursor
      } else {
        const next = stepValue(prevCursor, targetCursor, dtMs, tau)
        if (Math.abs(targetCursor - next) * zoomLevel < epsilonPx) {
          displayedCursor = targetCursor // 收敛吸附
        } else {
          displayedCursor = next
          animating = true
        }
      }
    }

    // ── dragging.time ──
    let displayedDragging: { id: string; time: number } | null = null
    const targetDrag = peer.dragging
    if (targetDrag != null) {
      const prevDrag = prevState?.dragging ?? null
      let displayedTime: number
      if (prevDrag == null || prevDrag.id !== targetDrag.id) {
        // null → 有值，或换了拖动对象：吸附
        displayedTime = targetDrag.time
      } else if (Math.abs(targetDrag.time - prevDrag.time) * zoomLevel > snapPx) {
        displayedTime = targetDrag.time
      } else {
        const next = stepValue(prevDrag.time, targetDrag.time, dtMs, tau)
        if (Math.abs(targetDrag.time - next) * zoomLevel < epsilonPx) {
          displayedTime = targetDrag.time
        } else {
          displayedTime = next
          animating = true
        }
      }
      displayedDragging = { id: targetDrag.id, time: displayedTime }
    }

    nextState.set(peer.clientId, {
      cursorTime: displayedCursor,
      dragging: displayedDragging,
    })

    smoothed.push({
      ...peer,
      cursorTime: displayedCursor,
      dragging:
        peer.dragging && displayedDragging
          ? { ...peer.dragging, time: displayedDragging.time }
          : null,
    })
  }

  return { smoothed, state: nextState, animating }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:run peerCursorSmoothing`
Expected: PASS —— 全部用例通过。

- [ ] **Step 5: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/utils/peerCursorSmoothing.ts src/utils/peerCursorSmoothing.test.ts
git commit -m "feat(collab): add pure peer cursor smoothing logic"
```

---

## Task 2: hook `useSmoothedPeers`

**Files:**

- Create: `src/components/Timeline/useSmoothedPeers.ts`

职责：订阅 `store.peers`，驱动单个 rAF 循环逐帧调用 `advancePeerSmoothing`，仅在 `animating` 时持续调度（settled 即停，idle 不再触发重渲染），返回平滑后的 `PeerState[]`。卸载时取消 rAF。

> 本任务无单测（依赖 rAF / React 运行时）；正确性由 Task 1 的纯逻辑测试 + Task 4 的手动验证覆盖。

- [ ] **Step 1: 实现 hook**

创建 `src/components/Timeline/useSmoothedPeers.ts`：

```ts
import { useEffect, useRef, useState } from 'react'
import { useTimelineStore } from '@/store/timelineStore'
import type { PeerState } from '@/collab/awarenessTypes'
import { advancePeerSmoothing, type SmoothStateMap } from '@/utils/peerCursorSmoothing'

/**
 * 返回平滑后的 peers：cursorTime / dragging.time 经帧率无关指数逼近。
 * 单个 rAF 循环，所有 peer 收敛后自动停止；新数据到达再唤醒。
 *
 * @param zoomLevel 当前缩放（px/秒），用于像素域的吸附 / 收敛判定
 */
export function useSmoothedPeers(zoomLevel: number): PeerState[] {
  const peers = useTimelineStore(s => s.peers)
  const [smoothed, setSmoothed] = useState<PeerState[]>(peers)

  // 平滑态、上一帧时间戳、rAF 句柄、最新输入（避免闭包过期）
  const stateRef = useRef<SmoothStateMap>(new Map())
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  const peersRef = useRef(peers)
  const zoomRef = useRef(zoomLevel)
  peersRef.current = peers
  zoomRef.current = zoomLevel

  useEffect(() => {
    const tick = (ts: number) => {
      const last = lastTsRef.current
      const dtMs = last == null ? 16 : Math.min(ts - last, 100) // 钳制长帧（切后台）
      lastTsRef.current = ts

      const {
        smoothed: next,
        state,
        animating,
      } = advancePeerSmoothing(peersRef.current, stateRef.current, dtMs, zoomRef.current)
      stateRef.current = state
      setSmoothed(next)

      if (animating) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
        lastTsRef.current = null
      }
    }

    // peers 变化即唤醒循环（若已在跑则不重复调度）
    if (rafRef.current == null) {
      lastTsRef.current = null
      rafRef.current = requestAnimationFrame(tick)
    }

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastTsRef.current = null
    }
  }, [peers])

  return smoothed
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add src/components/Timeline/useSmoothedPeers.ts
git commit -m "feat(collab): add useSmoothedPeers raf hook"
```

---

## Task 3: 接线 —— overlay 改用 prop，index.tsx 调用 hook

**Files:**

- Modify: `src/components/Timeline/PeerOverlay.tsx`（两处 `useTimelineStore(s => s.peers)` → prop）
- Modify: `src/components/Timeline/index.tsx`（调用 hook、传 prop、加 import）

- [ ] **Step 1: `PeerOverlayFixed` 改为接收 `peers` prop**

在 `src/components/Timeline/PeerOverlay.tsx`：

`PeerOverlayFixedProps` 接口（约 45-61 行）末尾加一行字段：

```ts
  /** 伤害轨道 annotations，用于 annotation ghost 查找 */
  annotations: Annotation[]
  /** 平滑后的 peers（由 useSmoothedPeers 提供，cursorTime / dragging.time 已补间） */
  peers: PeerState[]
```

`PeerOverlayFixed` 解构参数（约 63-72 行）加入 `peers`：

```ts
export function PeerOverlayFixed({
  zoomLevel,
  damageEvents,
  damageEventRowMap,
  yOffset,
  rowHeight,
  fixedAreaHeight,
  damageTrackHeight,
  annotations,
  peers,
}: PeerOverlayFixedProps) {
```

删除函数体内这一行（约 73 行）：

```ts
const peers = useTimelineStore(s => s.peers)
```

- [ ] **Step 2: `PeerOverlayMain` 同样改为接收 `peers` prop**

`PeerOverlayMainProps` 接口末尾加字段：

```ts
  /** 平滑后的 peers（由 useSmoothedPeers 提供，cursorTime / dragging.time 已补间） */
  peers: PeerState[]
```

`PeerOverlayMain` 解构参数加入 `peers`（紧随现有 `annotations` 之后，与传参顺序对应）。

删除函数体内这一行（约 271 行）：

```ts
const peers = useTimelineStore(s => s.peers)
```

- [ ] **Step 3: 导入 PeerState 类型，移除不再使用的 store 导入（按需）**

在 `PeerOverlay.tsx` 顶部 import 区，确保引入 `PeerState` 类型：

```ts
import type { PeerState } from '@/collab/awarenessTypes'
```

若 `useTimelineStore` 在文件内已无其他使用，删除其 import（`import { useTimelineStore } from '@/store/timelineStore'`）；若仍被使用则保留。用搜索确认：`grep -n "useTimelineStore" src/components/Timeline/PeerOverlay.tsx`。

- [ ] **Step 4: `index.tsx` 引入 hook 并调用一次**

在 `src/components/Timeline/index.tsx` 第 57 行（`import { PeerOverlayFixed, PeerOverlayMain } from './PeerOverlay'`）下方加：

```ts
import { useSmoothedPeers } from './useSmoothedPeers'
```

在组件函数体内、`zoomLevel` 已可用之后、`return` 之前的 hooks 区域，加入：

```ts
// 协作者光标 / 拖动 ghost 的补间平滑（按当前缩放做像素域吸附判定）
const smoothedPeers = useSmoothedPeers(zoomLevel)
```

- [ ] **Step 5: 两处 overlay 传入 `peers={smoothedPeers}`**

`PeerOverlayFixed`（约 1447-1456 行）加 prop：

```tsx
<PeerOverlayFixed
  zoomLevel={zoomLevel}
  damageEvents={filteredDamageEvents}
  damageEventRowMap={damageEventRowMap}
  yOffset={timeRulerHeight}
  rowHeight={LANE_ROW_HEIGHT}
  fixedAreaHeight={fixedAreaHeight}
  damageTrackHeight={eventTrackHeight}
  annotations={damageTrackAnnotations}
  peers={smoothedPeers}
/>
```

`PeerOverlayMain`（约 1543-1551 行）加 prop：

```tsx
<PeerOverlayMain
  zoomLevel={zoomLevel}
  castEvents={timeline.castEvents}
  skillTracks={skillTracks}
  actionMap={actionMap}
  trackHeight={skillTrackHeight}
  skillTracksHeight={skillTracksHeight}
  annotations={skillTrackAnnotations}
  peers={smoothedPeers}
/>
```

- [ ] **Step 6: 类型检查 + lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 均无错误。

- [ ] **Step 7: 提交**

```bash
git add src/components/Timeline/PeerOverlay.tsx src/components/Timeline/index.tsx
git commit -m "feat(collab): wire smoothed peers into timeline overlays"
```

---

## Task 4: 收尾验证

**Files:** 无新增改动；仅运行验证命令。

- [ ] **Step 1: 全量测试**

Run: `pnpm test:run`
Expected: 全部 PASS（含新增 `peerCursorSmoothing` 用例，且未带坏既有模块）。

- [ ] **Step 2: 构建兜底**

Run: `pnpm build`
Expected: 构建成功。

- [ ] **Step 3: 手动验证（双客户端）**

两个浏览器窗口打开同一已发布时间轴（一个 author、一个 view 或两个协作者），在 A 窗口快速移动鼠标 / 拖动技能，在 B 窗口观察：

- peer 光标竖线与拖动 ghost 平滑移动，无明显跳变。
- 不出现「从 0 飞入」、不残留已消失的光标、换拖动对象不滑入。
- A 静止后 B 端无持续重渲染（可借 DevTools Performance / React Profiler 确认 rAF 已停止）。

> 手动验证不通过时，回到对应任务排查，勿跳过。

---

## Self-Review 备注

- **Spec 覆盖**：cursorTime + dragging.time 平滑（Task 1）；单 rAF 循环 + settled 即停（Task 2）；overlay 共享同一份平滑数据（Task 3）；帧率无关、null↔值/换 id/超大跳变/收敛 边界（Task 1 测试全覆盖）；测试 + 构建 + 手动验证（Task 4）。
- **类型一致**：`SmoothStateMap` / `PeerSmoothState` / `AdvanceResult` / `stepValue` / `advancePeerSmoothing` 命名在 Task 1 定义后，Task 2 引用一致。
- **Git 注意**：提交信息不得含 "Claude" 字样、不加 Co-Authored-By（`.husky/commit-msg` 会拒绝）；非 subagent-driven 自动流程下，每次 commit 需用户显式授权。
