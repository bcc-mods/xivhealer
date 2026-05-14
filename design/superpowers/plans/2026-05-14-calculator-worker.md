# 计算引擎 Web Worker 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `MitigationCalculator.simulate()` 搬入 Web Worker，UI 消费侧保持同步接口、零 loading 闪烁。

**Architecture:** Worker 一次调用算齐主路径 + extraExcludeIds 的派生 timeline，打包返回；`PlacementEngine` 接受预算好的 `removalTimelinesByExcludeId` Map 同步查表，原 `simulateOnRemove` 回调下线；hook `useState + useEffect` 异步驱动 + stale-while-revalidate。

**Tech Stack:** Vite 7 (`?worker` import)、TypeScript 5.9、React 19、Vitest 4、Zustand 5。

**Spec:** `design/superpowers/specs/2026-05-14-calculator-worker-design.md`

---

## File Structure

**新增：**

- `src/web-workers/calculator/types.ts` — Worker 通信协议类型
- `src/web-workers/calculator/index.ts` — Worker entry：消息分派 + 版本缓存
- `src/web-workers/calculator/client.ts` — 主线程 client：lazy spawn + 请求 id 匹配
- `src/web-workers/calculator/client.test.ts` — client 单元测试

**修改（前置）：**

- `src/store/uiStore.ts` — 加 `draggingId` + `setDraggingId`，从 persist 排除
- `src/components/Timeline/index.tsx` — 删 local `draggingId` state，改读 store
- `src/components/Timeline/SkillTracksCanvas.tsx` — 删 `draggingId`/`setDraggingId` props，改读 store

**修改（核心切换）：**

- `src/contexts/DamageCalculationContext.ts` — 删 `simulateOnRemove`，加 `removalTimelinesByExcludeId` + `isPending`；删 `useDamageCalculationSimulate` hook
- `src/hooks/useDamageCalculation.ts` — `useMemo` → `useState + useEffect` 异步；加 `extraExcludeIds` 入参；回放分支保持同步
- `src/utils/placement/types.ts` — `PlacementEngineInput.simulateOnRemove` → `removalTimelinesByExcludeId: Map<string, StatusTimelineByPlayer>`
- `src/utils/placement/engine.ts` — `timelineExcluding` 改查表；`findInvalidCastEvents` 内 `simulateOnRemove` inline 调用同步改查表
- `src/components/Timeline/index.tsx` — engine 构造传新字段；删 `useDamageCalculationSimulate` 调用
- `src/components/TimelineTable/index.tsx` — 同上
- `src/components/PropertyPanel.tsx` — `useDamageCalculation(timeline)` → `useDamageCalculationResults()`
- `src/pages/EditorPage.tsx` — `useDamageCalculation` 加 `extraExcludeIds` 入参

**测试适配：**

- `src/utils/placement/engine.test.ts` — mock 字段重命名
- `src/utils/placement/integration.test.ts` — mock 字段重命名
- `src/hooks/useDamageCalculation.test.ts` — 注入 mock client

---

## Task 1: 把 draggingId 提升到 uiStore

**Files:**

- Modify: `src/store/uiStore.ts`
- Modify: `src/components/Timeline/index.tsx:193-202`
- Modify: `src/components/Timeline/SkillTracksCanvas.tsx:28-31, 84-85, 607, 1391-1392`

**Rationale:** `draggingId` 当前是 Timeline 组件 local state，但 `EditorPage` 需要把它拼进 `extraExcludeIds` 传给 `useDamageCalculation`。需要先提到 store 让上层能读。

- [ ] **Step 1: 在 `uiStore.ts` 加 `draggingId` 字段和 action**

修改 `src/store/uiStore.ts`：

在 `UIState` interface 内加：

```ts
/** 当前正在拖拽的 castEvent.id；非拖拽态为 null。
 *  ephemeral 状态，从 persist 排除。 */
draggingId: string | null
```

在 actions 区域加：

```ts
  /** 设置当前拖拽的 castEvent.id；停止拖拽传 null */
  setDraggingId: (id: string | null) => void
```

在 `create<UIState>()(persist(set => ({ ... })))` 的初始值里加：

```ts
      draggingId: null,
```

在 actions 实现里加：

```ts
      setDraggingId: id => set({ draggingId: id }),
```

修改 `partialize` 把 `draggingId` 也排除：

```ts
      partialize: ({ theme, draggingId, ...rest }) => rest,
```

`eslint-disable-next-line @typescript-eslint/no-unused-vars` 注释保留在 partialize 上方。

- [ ] **Step 2: 跑 tsc 确认 uiStore 编译通过**

Run: `pnpm exec tsc --noEmit`
Expected: PASS（如果 Timeline 还引用 local draggingId 可能 fail——这是预期，Step 3-4 修）

- [ ] **Step 3: 修 `Timeline/index.tsx`：删 local state，改用 store**

定位 `src/components/Timeline/index.tsx:193`：

```ts
const [draggingId, setDraggingId] = useState<string | null>(null)
```

替换为：

```ts
const draggingId = useUIStore(s => s.draggingId)
const setDraggingId = useUIStore(s => s.setDraggingId)
```

定位 L199-202（drop 后清空 draggingId 的 effect）：

```ts
useEffect(() => {
  if (draggingId) setDraggingId(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [timeline?.castEvents])
```

逻辑保持不变（store action 用法与 setState 一致）。

确保文件顶部 `useUIStore` 已 import（搜索文件内 `useUIStore` 现有引用，已用到则不动）。

- [ ] **Step 4: 修 `SkillTracksCanvas.tsx`：删 props，改读 store**

定位 `src/components/Timeline/SkillTracksCanvas.tsx:28-31`：

```ts
  draggingId?: string | null
  setDraggingId?: (id: string | null) => void
```

从 props interface 删除。

定位 L84-85：

```ts
  draggingId,
  setDraggingId,
```

从 destructure 删除。

在组件函数体顶部加：

```ts
const draggingId = useUIStore(s => s.draggingId)
const setDraggingId = useUIStore(s => s.setDraggingId)
```

import `useUIStore`（如果还没 import）：

```ts
import { useUIStore } from '@/store/uiStore'
```

定位 L607 `onDragStart={() => setDraggingId?.(castEvent.id)}`：把 `?.` 去掉（store action 总是存在）：

```ts
              onDragStart={() => setDraggingId(castEvent.id)}
```

L248-249 / L557 现有 `draggingId ?? undefined` 和 `draggingId === castEvent.id` 表达式保留——store 字段类型仍是 `string | null`，行为不变。

- [ ] **Step 5: 修 `Timeline/index.tsx`：删传给 SkillTracksCanvas 的 props**

定位 `src/components/Timeline/index.tsx:1391-1392`：

```ts
draggingId = { draggingId }
setDraggingId = { setDraggingId }
```

删除这两行。

- [ ] **Step 6: 跑 tsc**

Run: `pnpm exec tsc --noEmit`
Expected: PASS（没有 prop 不匹配等错误）

- [ ] **Step 7: 跑全套测试**

Run: `pnpm test:run`
Expected: 所有测试通过（本任务不涉及测试改动，仅 state 提升）

- [ ] **Step 8: Commit**

```bash
git add src/store/uiStore.ts src/components/Timeline/index.tsx src/components/Timeline/SkillTracksCanvas.tsx
git commit -m "refactor(timeline): draggingId 提升到 uiStore"
```

---

## Task 2: 建 worker 通信类型 + 主线程 client

**Files:**

- Create: `src/web-workers/calculator/types.ts`
- Create: `src/web-workers/calculator/client.ts`
- Create: `src/web-workers/calculator/client.test.ts`

这一组文件在 `src/web-workers/` 下，与主代码无耦合；建好后跑独立单元测试通过。

- [ ] **Step 1: 写 `types.ts`**

Create `src/web-workers/calculator/types.ts`：

```ts
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
```

- [ ] **Step 2: 写 `client.ts`**

Create `src/web-workers/calculator/client.ts`：

```ts
import { nanoid } from 'nanoid'
import type { SimulateInput } from '@/utils/mitigationCalculator'
import type { SimulateBundle, SimulateRequest, SimulateResponse } from './types'

type Pending = {
  resolve: (bundle: SimulateBundle) => void
  reject: (err: Error) => void
}

/**
 * Worker 工厂——单独抽出来便于测试时注入 fake。
 * 默认生产路径用 vite `?worker` import。
 */
export type WorkerFactory = () => Worker

export class CalculatorWorkerClient {
  private worker: Worker | null = null
  private versionCounter = 0
  private pending = new Map<string, Pending>()
  private currentRequestId: string | null = null

  constructor(private workerFactory: WorkerFactory) {}

  /**
   * 发起一次 simulate；返回 Promise，过期请求 silent drop（promise 永不 resolve）。
   * 调用方应自管 cancelled flag 防御 stale resolve。
   */
  simulate(input: SimulateInput, extraExcludeIds: string[]): Promise<SimulateBundle> {
    this.ensureWorker()
    const requestId = nanoid()
    const version = ++this.versionCounter
    this.currentRequestId = requestId
    const promise = new Promise<SimulateBundle>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
    })
    const req: SimulateRequest = { requestId, version, input, extraExcludeIds }
    this.worker!.postMessage(req)
    return promise
  }

  /** 测试用：观察 internal state。 */
  get pendingCount(): number {
    return this.pending.size
  }

  private ensureWorker() {
    if (this.worker) return
    this.worker = this.workerFactory()
    this.worker.onmessage = this.onMessage
    this.worker.onerror = this.onError
  }

  private onMessage = (e: MessageEvent<SimulateResponse>) => {
    const entry = this.pending.get(e.data.requestId)
    if (!entry) return
    this.pending.delete(e.data.requestId)
    if (e.data.requestId !== this.currentRequestId) return
    if (e.data.ok) {
      entry.resolve(e.data.bundle)
    } else {
      entry.reject(new Error(e.data.error.message))
    }
  }

  private onError = (e: ErrorEvent) => {
    // Worker 进程崩溃：reject 所有 pending，关闭并丢弃，下次 simulate 重新 spawn
    for (const entry of this.pending.values()) {
      entry.reject(new Error(`calculator worker crashed: ${e.message}`))
    }
    this.pending.clear()
    this.currentRequestId = null
    this.worker?.terminate()
    this.worker = null
  }
}
```

- [ ] **Step 3: 写测试 — 先写失败用例**

Create `src/web-workers/calculator/client.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { CalculatorWorkerClient } from './client'
import type { SimulateRequest, SimulateResponse } from './types'

class FakeWorker implements Partial<Worker> {
  onmessage: ((e: MessageEvent<SimulateResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  postedMessages: SimulateRequest[] = []
  postMessage(msg: SimulateRequest) {
    this.postedMessages.push(msg)
  }
  terminate() {}
  /** 测试辅助：模拟 worker 回包 */
  emit(resp: SimulateResponse) {
    this.onmessage?.(new MessageEvent('message', { data: resp }))
  }
  emitError(message: string) {
    this.onerror?.(new ErrorEvent('error', { message }))
  }
}

function makeClient() {
  const fake = new FakeWorker()
  const client = new CalculatorWorkerClient(() => fake as unknown as Worker)
  return { fake, client }
}

const MINIMAL_INPUT = {
  castEvents: [],
  damageEvents: [],
  initialState: { players: [], statuses: [] },
} as never

const MINIMAL_BUNDLE = {
  main: {
    damageResults: new Map(),
    statusTimelineByPlayer: new Map(),
    castEffectiveEndByCastEventId: new Map(),
    healSnapshots: [],
    hpTimeline: [],
  },
  removalTimelinesByExcludeId: new Map(),
} as never

describe('CalculatorWorkerClient', () => {
  it('lazy spawns worker on first simulate', () => {
    const factory = vi.fn(() => new FakeWorker() as unknown as Worker)
    const client = new CalculatorWorkerClient(factory)
    expect(factory).not.toHaveBeenCalled()
    client.simulate(MINIMAL_INPUT, [])
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('reuses worker across calls', () => {
    const factory = vi.fn(() => new FakeWorker() as unknown as Worker)
    const client = new CalculatorWorkerClient(factory)
    client.simulate(MINIMAL_INPUT, [])
    client.simulate(MINIMAL_INPUT, [])
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('matches response to request by requestId', async () => {
    const { fake, client } = makeClient()
    const p = client.simulate(MINIMAL_INPUT, [])
    const requestId = fake.postedMessages[0].requestId
    fake.emit({ requestId, ok: true, bundle: MINIMAL_BUNDLE })
    await expect(p).resolves.toBe(MINIMAL_BUNDLE)
  })

  it('drops stale response (older requestId after newer one issued)', async () => {
    const { fake, client } = makeClient()
    const p1 = client.simulate(MINIMAL_INPUT, [])
    const id1 = fake.postedMessages[0].requestId
    const p2 = client.simulate(MINIMAL_INPUT, [])
    const id2 = fake.postedMessages[1].requestId
    // 旧请求先回包 → 应被 drop（promise 永不 resolve）
    fake.emit({ requestId: id1, ok: true, bundle: MINIMAL_BUNDLE })
    // 新请求回包 → 应 resolve
    fake.emit({ requestId: id2, ok: true, bundle: MINIMAL_BUNDLE })
    await expect(p2).resolves.toBe(MINIMAL_BUNDLE)
    // p1 应仍未 resolve/reject
    let p1Settled = false
    p1.then(
      () => (p1Settled = true),
      () => (p1Settled = true)
    )
    await new Promise(r => setTimeout(r, 0))
    expect(p1Settled).toBe(false)
  })

  it('rejects on error response', async () => {
    const { fake, client } = makeClient()
    const p = client.simulate(MINIMAL_INPUT, [])
    const requestId = fake.postedMessages[0].requestId
    fake.emit({
      requestId,
      ok: false,
      error: { message: 'boom', stack: 'fake-stack' },
    })
    await expect(p).rejects.toThrow('boom')
  })

  it('rejects all pending and recreates worker on crash', async () => {
    const fake1 = new FakeWorker()
    const fake2 = new FakeWorker()
    const factory = vi
      .fn<[], Worker>()
      .mockReturnValueOnce(fake1 as unknown as Worker)
      .mockReturnValueOnce(fake2 as unknown as Worker)
    const client = new CalculatorWorkerClient(factory)
    const p = client.simulate(MINIMAL_INPUT, [])
    fake1.emitError('segfault')
    await expect(p).rejects.toThrow(/segfault/)
    expect(client.pendingCount).toBe(0)
    // 再次 simulate 应重新 spawn
    client.simulate(MINIMAL_INPUT, [])
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('sends extraExcludeIds in request payload', () => {
    const { fake, client } = makeClient()
    client.simulate(MINIMAL_INPUT, ['a', 'b'])
    expect(fake.postedMessages[0].extraExcludeIds).toEqual(['a', 'b'])
  })

  it('monotonic version per call', () => {
    const { fake, client } = makeClient()
    client.simulate(MINIMAL_INPUT, [])
    client.simulate(MINIMAL_INPUT, [])
    client.simulate(MINIMAL_INPUT, [])
    const versions = fake.postedMessages.map(m => m.version)
    expect(versions).toEqual([1, 2, 3])
  })
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test:run src/web-workers/calculator/client.test.ts`
Expected: 8 passed (lazy spawn, reuse, match, drop stale, reject error, crash recover, extraExcludeIds, version)

如果有 fail，根据失败信息修 client 实现，再跑直到通过。

- [ ] **Step 5: 跑 tsc + lint**

Run: `pnpm exec tsc --noEmit && pnpm lint src/web-workers/calculator/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web-workers/calculator/types.ts src/web-workers/calculator/client.ts src/web-workers/calculator/client.test.ts
git commit -m "feat(workers): calculator worker 通信协议与主线程 client"
```

---

## Task 3: 实现 worker entry

**Files:**

- Create: `src/web-workers/calculator/index.ts`

Worker 内消息分派 + 版本缓存。无独立测试（worker 在 jsdom 下不易跑；通过手动烟测 + client 集成验证）。

- [ ] **Step 1: 写 worker entry**

Create `src/web-workers/calculator/index.ts`：

```ts
/// <reference lib="webworker" />

import { MitigationCalculator } from '@/utils/mitigationCalculator'
import type { SimulateOutput } from '@/utils/mitigationCalculator'
import type {
  SimulateBundle,
  SimulateRequest,
  SimulateResponse,
  StatusTimelineByPlayer,
} from './types'

/**
 * 按 (version, excludeId) 缓存 simulate 输出。
 * 版本号由主线程单调递增——任意 input 变化都视为新 version，
 * worker 收到比 lastVersion 大的请求时清空缓存。
 * 同一 version 内 extraExcludeIds 切换命中缓存（主路径只跑一次）。
 */
let lastVersion = -1
const cache: {
  main: SimulateOutput | null
  byExcludeId: Map<string, SimulateOutput>
} = {
  main: null,
  byExcludeId: new Map(),
}

self.onmessage = (e: MessageEvent<SimulateRequest>) => {
  const { requestId, version, input, extraExcludeIds } = e.data

  if (version !== lastVersion) {
    cache.main = null
    cache.byExcludeId.clear()
    lastVersion = version
  }

  try {
    const calculator = new MitigationCalculator()

    if (!cache.main) {
      cache.main = calculator.simulate(input)
    }

    const removalTimelinesByExcludeId: Map<string, StatusTimelineByPlayer> = new Map()
    for (const id of extraExcludeIds) {
      let out = cache.byExcludeId.get(id)
      if (!out) {
        out = calculator.simulate({
          ...input,
          castEvents: input.castEvents.filter(ev => ev.id !== id),
          skipHpPipeline: true,
        })
        cache.byExcludeId.set(id, out)
      }
      removalTimelinesByExcludeId.set(id, out.statusTimelineByPlayer)
    }

    const bundle: SimulateBundle = {
      main: cache.main,
      removalTimelinesByExcludeId,
    }
    const resp: SimulateResponse = { requestId, ok: true, bundle }
    self.postMessage(resp)
  } catch (err) {
    const error = err as Error
    const resp: SimulateResponse = {
      requestId,
      ok: false,
      error: { message: error.message, stack: error.stack },
    }
    self.postMessage(resp)
  }
}
```

- [ ] **Step 2: 跑 tsc 确认 worker 类型通过**

Run: `pnpm exec tsc --noEmit`
Expected: PASS

如有 `self` 类型错误，确保 `tsconfig.json` 的 `lib` 包含 `WebWorker` 或文件顶部的 `/// <reference lib="webworker" />` 生效。

- [ ] **Step 3: 跑全套 test 确认未破坏**

Run: `pnpm test:run`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add src/web-workers/calculator/index.ts
git commit -m "feat(workers): calculator worker entry 含版本缓存"
```

---

## Task 4: PlacementEngine 接口改造

**Files:**

- Modify: `src/utils/placement/types.ts:47, 91-110`
- Modify: `src/utils/placement/engine.ts:21-50, 58-81, 245-253`
- Modify: `src/utils/placement/engine.test.ts`
- Modify: `src/utils/placement/integration.test.ts`

`simulateOnRemove` callback 字段 → `removalTimelinesByExcludeId` Map 字段；engine 内部改查表。**完成此 task 后 Timeline / TimelineTable 引用 simulateOnRemove 会编译失败——Task 5 会一起切换。本 task 内仅跑 placement 单元测试**。

- [ ] **Step 1: 修 `types.ts`**

定位 `src/utils/placement/types.ts`：在文件末尾 `StatusTimelineByPlayer` 已导出。

`PlacementEngine` interface（L67-110）**不动**——接口签名保持同步。

- [ ] **Step 2: 修 `engine.ts:21-48` 的 `PlacementEngineInput`**

定位 `src/utils/placement/engine.ts:21`：

```ts
export interface PlacementEngineInput {
  castEvents: CastEvent[]
  actions: Map<number, MitigationAction>
  statusTimelineByPlayer: StatusTimelineByPlayer
  /**
   * ...（长注释）...
   */
  simulateOnRemove?: (castEvents: CastEvent[]) => { statusTimelineByPlayer: StatusTimelineByPlayer }
}
```

替换为：

```ts
export interface PlacementEngineInput {
  castEvents: CastEvent[]
  actions: Map<number, MitigationAction>
  /** 主路径 status timeline。`excludeId` 缺省时所有查询直接共享这一份。 */
  statusTimelineByPlayer: StatusTimelineByPlayer
  /**
   * 预算好的"假装该 cast 不存在"的 status timeline 表。worker 路径下由
   * `useDamageCalculation` 一次性返回。带 excludeId 的查询命中即用；未命中
   * 降级为"按 sourceCastEventId 过滤主路径 timeline"——降级语义与原 simulateOnRemove
   * 缺省时一致：只适合"该 cast 只 attach、不消费 / 不打断"的场景，消费型 cast 的
   * 截断效果不可还原（详见 timelineExcluding 注释）。
   *
   * 不传 = engine 内所有带 excludeId 查询走过滤降级。EditorPage 自动重分类即此路径。
   */
  removalTimelinesByExcludeId?: Map<string, StatusTimelineByPlayer>
}
```

- [ ] **Step 3: 修 `createPlacementEngine` 的解构**

定位 `engine.ts:50-51`：

```ts
export function createPlacementEngine(input: PlacementEngineInput): PlacementEngine {
  const { castEvents, actions, statusTimelineByPlayer: defaultTimeline, simulateOnRemove } = input
```

替换为：

```ts
export function createPlacementEngine(input: PlacementEngineInput): PlacementEngine {
  const {
    castEvents,
    actions,
    statusTimelineByPlayer: defaultTimeline,
    removalTimelinesByExcludeId,
  } = input
```

- [ ] **Step 4: 修 `timelineExcluding` 内部逻辑**

定位 `engine.ts:62-81`：

```ts
function timelineExcluding(excludeId: string): StatusTimelineByPlayer {
  const cached = removalTimelineCache.get(excludeId)
  if (cached) return cached
  let result: StatusTimelineByPlayer
  if (simulateOnRemove) {
    result = simulateOnRemove(castEvents.filter(e => e.id !== excludeId)).statusTimelineByPlayer
  } else {
    result = new Map()
    for (const [pid, byStatus] of defaultTimeline) {
      const newByStatus = new Map<number, StatusInterval[]>()
      for (const [sid, intervals] of byStatus) {
        const filtered = intervals.filter(i => i.sourceCastEventId !== excludeId)
        if (filtered.length > 0) newByStatus.set(sid, filtered)
      }
      if (newByStatus.size > 0) result.set(pid, newByStatus)
    }
  }
  removalTimelineCache.set(excludeId, result)
  return result
}
```

替换为：

```ts
function timelineExcluding(excludeId: string): StatusTimelineByPlayer {
  const cached = removalTimelineCache.get(excludeId)
  if (cached) return cached
  let result: StatusTimelineByPlayer
  const prebuilt = removalTimelinesByExcludeId?.get(excludeId)
  if (prebuilt) {
    result = prebuilt
  } else {
    // 降级：按 sourceCastEventId 过滤主路径 timeline。消费型 cast 的截断效果不可还原；
    // 适合自动重分类等不需要拖拽预览精确语义的场景。
    result = new Map()
    for (const [pid, byStatus] of defaultTimeline) {
      const newByStatus = new Map<number, StatusInterval[]>()
      for (const [sid, intervals] of byStatus) {
        const filtered = intervals.filter(i => i.sourceCastEventId !== excludeId)
        if (filtered.length > 0) newByStatus.set(sid, filtered)
      }
      if (newByStatus.size > 0) result.set(pid, newByStatus)
    }
  }
  removalTimelineCache.set(excludeId, result)
  return result
}
```

- [ ] **Step 5: 修 `findInvalidCastEvents` 内 inline 调用**

定位 `engine.ts:245-253`：

```ts
  function findInvalidCastEvents(removeCastEventId?: string): InvalidCastEvent[] {
    const effectiveEvents = effectiveCastEvents(removeCastEventId)

    // 显式"模拟删除某 cast"语义：placement 必须用重跑后的 timeline，让依赖被删 cast
    // buff 的其他 cast 在预览中真实失效。常规调用（无 removeCastEventId）共享 default。
    const placementTimeline =
      removeCastEventId && simulateOnRemove
        ? simulateOnRemove(effectiveEvents).statusTimelineByPlayer
        : defaultTimeline
```

替换为：

```ts
  function findInvalidCastEvents(removeCastEventId?: string): InvalidCastEvent[] {
    const effectiveEvents = effectiveCastEvents(removeCastEventId)

    // 显式"模拟删除某 cast"语义：placement 必须用预算好的 timeline，让依赖被删 cast
    // buff 的其他 cast 在预览中真实失效。常规调用（无 removeCastEventId）共享 default。
    // 未预算时降级（通过 timelineExcluding 走 sourceCastEventId 过滤）。
    const placementTimeline = removeCastEventId
      ? timelineExcluding(removeCastEventId)
      : defaultTimeline
```

- [ ] **Step 6: 适配 `engine.test.ts`**

定位 `src/utils/placement/engine.test.ts`，搜索所有 `simulateOnRemove:` 出现位置（grep 找到 L314, L392 等）。

每处把：

```ts
      simulateOnRemove: () => ({ statusTimelineByPlayer: removalTimeline }),
```

替换为：

```ts
      removalTimelinesByExcludeId: new Map([['<对应 excludeId>', removalTimeline]]),
```

其中 `<对应 excludeId>` 是测试中实际传给 `findInvalidCastEvents(id)` / `getValidIntervals(_, _, id)` 的 id。具体每个测试根据上下文判断（搜索 `findInvalidCastEvents('xxx')` 找出 id）。

例如 L321 `engine.findInvalidCastEvents('cgrace')`：对应 `removalTimelinesByExcludeId: new Map([['cgrace', removalTimeline]])`。

如果某测试用了多个 excludeId，把所有 (id, timeline) 配对入 Map。

如果原 mock 是 `(events) => {...}` 动态计算 timeline 而非常量，改为先在测试 setup 里预算所有可能的 id → timeline 映射，再传入 Map。

- [ ] **Step 7: 适配 `integration.test.ts`**

定位 `src/utils/placement/integration.test.ts:28-30`：

```ts
    simulateOnRemove: evs =>
      ...计算 timeline...,
```

按 Step 6 同理改为预算 Map。如果原 mock 在每次调用时跑真实 simulate，改成测试 setup 时为每个相关 castEvent.id 预跑一次，结果入 Map。

- [ ] **Step 8: 跑 placement 测试确认通过**

Run: `pnpm test:run src/utils/placement/`
Expected: 全部通过。

如果有 fail，对照 Step 6/7 检查 mock 是否覆盖所有用到的 excludeId。

- [ ] **Step 9: 跑 tsc**

Run: `pnpm exec tsc --noEmit`
Expected: 报错——Timeline/TimelineTable 还在用 `simulateOnRemove: simulateOnRemove ?? undefined`。**这是预期**，Task 5 修。**不 commit，先继续 Task 5。**

---

## Task 5: 改造 hook / context / UI 消费者（一次性大切换）

**Files:**

- Modify: `src/contexts/DamageCalculationContext.ts`
- Modify: `src/hooks/useDamageCalculation.ts`
- Modify: `src/hooks/useDamageCalculation.test.ts`
- Modify: `src/components/Timeline/index.tsx:176-191`
- Modify: `src/components/TimelineTable/index.tsx:55-77`
- Modify: `src/components/PropertyPanel.tsx:9, 60`
- Modify: `src/pages/EditorPage.tsx:106`

**承接 Task 4：本 task 完成后整个项目重新编译通过。所有改动一起 commit。**

- [ ] **Step 1: 改 `DamageCalculationContext.ts`**

替换整个文件内容：

```ts
import { createContext, useContext } from 'react'
import type { CalculationResult } from '@/utils/mitigationCalculator'
import type { DamageCalculationResult, StatusTimelineByPlayer } from '@/hooks/useDamageCalculation'

const emptyContext: DamageCalculationResult = {
  results: new Map(),
  statusTimelineByPlayer: new Map(),
  castEffectiveEndByCastEventId: new Map(),
  healSnapshots: [],
  hpTimeline: [],
  removalTimelinesByExcludeId: new Map(),
  isPending: false,
}

export const DamageCalculationContext = createContext<DamageCalculationResult>(emptyContext)

export function useDamageCalculationResults(): Map<string, CalculationResult> {
  return useContext(DamageCalculationContext).results
}

export function useStatusTimelineByPlayer(): StatusTimelineByPlayer {
  return useContext(DamageCalculationContext).statusTimelineByPlayer
}

export function useCastEffectiveEnd(): Map<string, number> {
  return useContext(DamageCalculationContext).castEffectiveEndByCastEventId
}

export function useRemovalTimelinesByExcludeId(): Map<string, StatusTimelineByPlayer> {
  return useContext(DamageCalculationContext).removalTimelinesByExcludeId
}

export function useHpTimeline(): DamageCalculationResult['hpTimeline'] {
  return useContext(DamageCalculationContext).hpTimeline
}

export function useDamageCalculationPending(): boolean {
  return useContext(DamageCalculationContext).isPending
}
```

`useDamageCalculationSimulate` hook 已删除。

- [ ] **Step 2: 改 `useDamageCalculation.ts`**

替换整个文件内容：

```ts
/**
 * 伤害计算 Hook V2（基于状态，worker 异步）
 *
 * 编辑模式：通过 CalculatorWorkerClient 异步跑 simulate，stale-while-revalidate
 * 回放模式：直接从 PlayerDamageDetail.statuses 同步计算
 */

import { useEffect, useMemo, useState } from 'react'
import type { CalculationResult } from '@/utils/mitigationCalculator'
import type { CastEvent, Timeline } from '@/types/timeline'
import type { StatusInterval } from '@/types/status'
import type { HealSnapshot } from '@/types/healSnapshot'
import type { HpTimelinePoint } from '@/types/hpTimeline'
import { useTimelineStore } from '@/store/timelineStore'
import { calculatePercentile } from '@/utils/stats'
import { resolveStatData } from '@/utils/statDataUtils'
import { getJobRole } from '@/data/jobs'
import { CalculatorWorkerClient } from '@/web-workers/calculator/client'
import CalculatorWorker from '@/web-workers/calculator/index?worker'

export type StatusTimelineByPlayer = Map<number, Map<number, StatusInterval[]>>

export interface DamageCalculationResult {
  results: Map<string, CalculationResult>
  statusTimelineByPlayer: StatusTimelineByPlayer
  castEffectiveEndByCastEventId: Map<string, number>
  healSnapshots: HealSnapshot[]
  hpTimeline: HpTimelinePoint[]
  /** 预算好的"假装某 cast 不存在"的 status timeline 表，供 PlacementEngine 同步查表 */
  removalTimelinesByExcludeId: Map<string, StatusTimelineByPlayer>
  /** worker 路径下首次 simulate 在飞行时为 true；用于 UI 可选淡化态 */
  isPending: boolean
}

const EMPTY_RESULT: DamageCalculationResult = {
  results: new Map(),
  statusTimelineByPlayer: new Map(),
  castEffectiveEndByCastEventId: new Map(),
  healSnapshots: [],
  hpTimeline: [],
  removalTimelinesByExcludeId: new Map(),
  isPending: false,
}

/**
 * Worker client 单例。导出供测试注入替换。
 */
export let workerClient = new CalculatorWorkerClient(() => new CalculatorWorker())

/** 测试用：注入 mock client */
export function __setWorkerClientForTesting(client: CalculatorWorkerClient) {
  workerClient = client
}

export interface UseDamageCalculationOptions {
  /** 额外按 excludeId 派生的 timeline 集合；通常是 [selectedCastEventId, draggingId] */
  extraExcludeIds?: string[]
}

export function useDamageCalculation(
  timeline: Timeline | null,
  options: UseDamageCalculationOptions = {}
): DamageCalculationResult {
  const partyState = useTimelineStore(state => state.partyState)
  const statistics = useTimelineStore(state => state.statistics)
  const { extraExcludeIds = [] } = options

  // 字符串化作 deps key；数组身份每次 render 都新，内容才是真依赖
  const extraExcludeIdsKey = useMemo(
    () => Array.from(new Set(extraExcludeIds)).sort().join(','),
    [extraExcludeIds]
  )

  const [state, setState] = useState<DamageCalculationResult>(EMPTY_RESULT)

  useEffect(() => {
    // 回放模式：同步路径
    if (timeline?.isReplayMode) {
      setState(computeReplayResult(timeline))
      return
    }
    if (!timeline) {
      setState(EMPTY_RESULT)
      return
    }
    if (!partyState) {
      setState(buildEmptyForTimeline(timeline))
      return
    }

    const resolved = resolveStatData(timeline.statData, statistics, timeline.composition)
    const tankPlayerIds = timeline.composition.players
      .filter(p => getJobRole(p.job) === 'tank')
      .map(p => p.id)

    const input = {
      castEvents: timeline.castEvents || [],
      damageEvents: timeline.damageEvents,
      initialState: partyState,
      statistics: resolved,
      tankPlayerIds,
      baseReferenceMaxHPForTank: resolved.tankReferenceMaxHP!,
      baseReferenceMaxHPForAoe: resolved.referenceMaxHP!,
    }

    const ids = extraExcludeIdsKey.split(',').filter(Boolean)
    let cancelled = false
    setState(s => ({ ...s, isPending: true }))

    workerClient
      .simulate(input, ids)
      .then(bundle => {
        if (cancelled) return
        setState({
          results: bundle.main.damageResults,
          statusTimelineByPlayer: bundle.main.statusTimelineByPlayer,
          castEffectiveEndByCastEventId: bundle.main.castEffectiveEndByCastEventId,
          healSnapshots: bundle.main.healSnapshots,
          hpTimeline: bundle.main.hpTimeline,
          removalTimelinesByExcludeId: bundle.removalTimelinesByExcludeId,
          isPending: false,
        })
      })
      .catch(err => {
        if (cancelled) return
        console.error('[calculator-worker] simulate failed', err)
        setState(s => ({ ...s, isPending: false }))
      })

    return () => {
      cancelled = true
    }
  }, [timeline, partyState, statistics, extraExcludeIdsKey])

  return state
}

/** 回放模式同步计算（保持原 useDamageCalculation 内部 isReplayMode 分支语义） */
function computeReplayResult(timeline: Timeline): DamageCalculationResult {
  const results = new Map<string, CalculationResult>()
  for (const event of timeline.damageEvents) {
    if (!event.playerDamageDetails || event.playerDamageDetails.length === 0) continue
    const playerResults: Array<{
      originalDamage: number
      finalDamage: number
      mitigationPercentage: number
    }> = []
    for (const detail of event.playerDamageDetails) {
      if (!detail.statuses || !Array.isArray(detail.statuses)) continue
      const mitigationPercentage =
        detail.unmitigatedDamage > 0
          ? ((detail.unmitigatedDamage - detail.finalDamage) / detail.unmitigatedDamage) * 100
          : 0
      playerResults.push({
        originalDamage: detail.unmitigatedDamage,
        finalDamage: detail.finalDamage,
        mitigationPercentage,
      })
    }
    if (playerResults.length > 0) {
      const medianMitigation = calculatePercentile(playerResults.map(r => r.mitigationPercentage))
      const maxFinalDamage = Math.max(...playerResults.map(r => r.finalDamage))
      const maxDamage = Math.max(...playerResults.map(r => r.originalDamage))
      results.set(event.id, {
        originalDamage: event.damage,
        finalDamage: maxFinalDamage,
        maxDamage,
        mitigationPercentage: medianMitigation,
        appliedStatuses: [],
      })
    }
  }
  return { ...EMPTY_RESULT, results }
}

function buildEmptyForTimeline(timeline: Timeline): DamageCalculationResult {
  const results = new Map<string, CalculationResult>()
  for (const event of timeline.damageEvents) {
    results.set(event.id, {
      originalDamage: event.damage,
      finalDamage: event.damage,
      maxDamage: event.damage,
      mitigationPercentage: 0,
      appliedStatuses: [],
    })
  }
  return { ...EMPTY_RESULT, results }
}
```

注意：导入 `CalculatorWorker from '@/web-workers/calculator/index?worker'` 是 Vite 7 原生支持的 worker import 语法。tsconfig 需识别 `?worker` 后缀类型——通常项目 `vite-env.d.ts` 已包含 `/// <reference types="vite/client" />` 即支持。

- [ ] **Step 3: 改 `Timeline/index.tsx`**

定位 `src/components/Timeline/index.tsx:176-191`：

```ts
const calculationResults = useDamageCalculationResults()
const simulateOnRemove = useDamageCalculationSimulate()
const statusTimelineByPlayer = useStatusTimelineByPlayer()
const hpTimeline = useHpTimeline()

const actionMap = useMemo(() => new Map(actions.map(a => [a.id, a])), [actions])

const engine: PlacementEngine | null = useMemo(() => {
  if (!timeline) return null
  return createPlacementEngine({
    castEvents: timeline.castEvents,
    actions: actionMap,
    statusTimelineByPlayer,
    simulateOnRemove: simulateOnRemove ?? undefined,
  })
}, [timeline, actionMap, statusTimelineByPlayer, simulateOnRemove])
```

替换为：

```ts
const calculationResults = useDamageCalculationResults()
const removalTimelinesByExcludeId = useRemovalTimelinesByExcludeId()
const statusTimelineByPlayer = useStatusTimelineByPlayer()
const hpTimeline = useHpTimeline()

const actionMap = useMemo(() => new Map(actions.map(a => [a.id, a])), [actions])

const engine: PlacementEngine | null = useMemo(() => {
  if (!timeline) return null
  return createPlacementEngine({
    castEvents: timeline.castEvents,
    actions: actionMap,
    statusTimelineByPlayer,
    removalTimelinesByExcludeId,
  })
}, [timeline, actionMap, statusTimelineByPlayer, removalTimelinesByExcludeId])
```

同时修改文件顶部 import：

```ts
import {
  useDamageCalculationResults,
  useDamageCalculationSimulate,
  useStatusTimelineByPlayer,
  useHpTimeline,
} from '@/contexts/DamageCalculationContext'
```

替换为：

```ts
import {
  useDamageCalculationResults,
  useRemovalTimelinesByExcludeId,
  useStatusTimelineByPlayer,
  useHpTimeline,
} from '@/contexts/DamageCalculationContext'
```

- [ ] **Step 4: 改 `TimelineTable/index.tsx`**

定位 `src/components/TimelineTable/index.tsx:55-77`：

```ts
  const calculationResults = useDamageCalculationResults()
  const simulateOnRemove = useDamageCalculationSimulate()
  const statusTimelineByPlayer = useStatusTimelineByPlayer()
  ...

  const engine: PlacementEngine | null = useMemo(() => {
    if (!timeline) return null
    return createPlacementEngine({
      castEvents: timeline.castEvents,
      actions: actionsById,
      statusTimelineByPlayer,
      simulateOnRemove: simulateOnRemove ?? undefined,
    })
  }, [timeline, actionsById, statusTimelineByPlayer, simulateOnRemove])
```

替换为：

```ts
  const calculationResults = useDamageCalculationResults()
  const removalTimelinesByExcludeId = useRemovalTimelinesByExcludeId()
  const statusTimelineByPlayer = useStatusTimelineByPlayer()
  ...

  const engine: PlacementEngine | null = useMemo(() => {
    if (!timeline) return null
    return createPlacementEngine({
      castEvents: timeline.castEvents,
      actions: actionsById,
      statusTimelineByPlayer,
      removalTimelinesByExcludeId,
    })
  }, [timeline, actionsById, statusTimelineByPlayer, removalTimelinesByExcludeId])
```

同步修文件顶部 import：把 `useDamageCalculationSimulate` 改为 `useRemovalTimelinesByExcludeId`。

- [ ] **Step 5: 改 `PropertyPanel.tsx`**

定位 `src/components/PropertyPanel.tsx:9`：

```ts
import { useDamageCalculation } from '@/hooks/useDamageCalculation'
```

替换为：

```ts
import { useDamageCalculationResults } from '@/contexts/DamageCalculationContext'
```

定位 L60：

```ts
const { results: eventResults } = useDamageCalculation(timeline)
```

替换为：

```ts
const eventResults = useDamageCalculationResults()
```

注意：原变量名 `eventResults` 保持不变，所有下游 `eventResults.get(...)` 调用零改动。

- [ ] **Step 6: 改 `EditorPage.tsx`**

定位 `src/pages/EditorPage.tsx:106`：

```ts
const calculationResults = useDamageCalculation(timeline)
```

替换为：

```ts
const selectedCastEventId = useTimelineStore(s => s.selectedCastEventId)
const draggingId = useUIStore(s => s.draggingId)
const extraExcludeIds = useMemo(
  () => [selectedCastEventId, draggingId].filter((id): id is string => !!id),
  [selectedCastEventId, draggingId]
)
const calculationResults = useDamageCalculation(timeline, { extraExcludeIds })
```

确保文件顶部 import 包含：

```ts
import { useUIStore } from '@/store/uiStore'
```

（若已 import 则不动）

- [ ] **Step 7: 适配 `useDamageCalculation.test.ts`**

打开 `src/hooks/useDamageCalculation.test.ts`，按下列结构改写（保留原有断言逻辑，只换 mock 路径）：

文件顶部增加 mock client 注入：

```ts
import { __setWorkerClientForTesting } from './useDamageCalculation'
import { CalculatorWorkerClient } from '@/web-workers/calculator/client'
import type { SimulateBundle } from '@/web-workers/calculator/types'

class FakeWorker implements Partial<Worker> {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  postedMessages: unknown[] = []
  postMessage(msg: unknown) {
    this.postedMessages.push(msg)
    // 简单 echo：每次 postMessage 后立即在下一个 microtask emit 成功响应
    Promise.resolve().then(() => {
      const { requestId } = msg as { requestId: string }
      this.onmessage?.(
        new MessageEvent('message', {
          data: { requestId, ok: true, bundle: makeBundle() },
        })
      )
    })
  }
  terminate() {}
}

function makeBundle(): SimulateBundle {
  return {
    main: {
      damageResults: new Map(),
      statusTimelineByPlayer: new Map(),
      castEffectiveEndByCastEventId: new Map(),
      healSnapshots: [],
      hpTimeline: [],
    },
    removalTimelinesByExcludeId: new Map(),
  }
}

beforeEach(() => {
  __setWorkerClientForTesting(
    new CalculatorWorkerClient(() => new FakeWorker() as unknown as Worker)
  )
})
```

对于回放模式的现有测试断言保持不变（不走 worker 路径）。

对于编辑模式断言，需要在 `result` 读取前 `await` 一次 microtask（hook 内 setState 在 promise resolve 后）：

```ts
await act(async () => {
  // 触发 useEffect / promise resolve
  await new Promise(r => setTimeout(r, 0))
})
expect(result.current.results.size).toBe(...)
```

具体多少处需改要看文件现状：原文件 365 行，主要测试是回放路径 + 一些主路径。回放路径不动；主路径（如有）按上面 act + await pattern 调整。如果某测试调用 `simulateOnRemove`，把这个测试改为读 `result.current.removalTimelinesByExcludeId` 即可（不再有 simulateOnRemove 字段）。

- [ ] **Step 8: 跑 tsc**

Run: `pnpm exec tsc --noEmit`
Expected: PASS

如有 import 错误（如某文件忘改 `useDamageCalculationSimulate` 引用），按报错指引修。

- [ ] **Step 9: 跑全套测试**

Run: `pnpm test:run`
Expected: 全部通过。

- [ ] **Step 10: 跑 lint**

Run: `pnpm lint`
Expected: PASS

- [ ] **Step 11: 跑构建确认 worker bundle 生成**

Run: `pnpm build`
Expected: 构建成功；输出里能看到 worker chunk（类似 `assets/calculator-worker-<hash>.js`）。

- [ ] **Step 12: Commit**

```bash
git add src/contexts/DamageCalculationContext.ts \
        src/hooks/useDamageCalculation.ts \
        src/hooks/useDamageCalculation.test.ts \
        src/utils/placement/types.ts \
        src/utils/placement/engine.ts \
        src/utils/placement/engine.test.ts \
        src/utils/placement/integration.test.ts \
        src/components/Timeline/index.tsx \
        src/components/TimelineTable/index.tsx \
        src/components/PropertyPanel.tsx \
        src/pages/EditorPage.tsx
git commit -m "refactor(calculator): simulate 搬入 Web Worker，UI 同步消费保持不变"
```

---

## Task 6: 手动烟测

**Files:** 无代码改动；浏览器 + dev server 实测

- [ ] **Step 1: 启动 dev server**

Run: `pnpm dev`（用户通常已启动；若已启动跳过）
等待编译完成；浏览器开 `http://localhost:5173`。

- [ ] **Step 2: 打开一个本地时间轴或导入 FFLogs**

进入 `/timeline/<id>`，确认主路径渲染正常（cast 图标、damage event、PropertyPanel 数值显示）。

观察浏览器 DevTools Performance 面板：录制一段时间轴 mutation 操作（添加/拖动 cast）。主线程应**不再有 5~20ms 的 simulate 长任务**；改为 worker 线程上的任务。

- [ ] **Step 3: 测拖拽手感**

- 选中一个 cast → 拖动 → 观察 shadow 阴影是否随拖动实时更新（不卡顿、无延迟一帧）。
- 拖动后落子 → 数值与 shadow 应在 ≤1 帧内更新。

- [ ] **Step 4: 测选中切换**

- 单击不同 cast 切换选中 → shadow 立即跟着切换（用 worker 内 (version, excludeId) 缓存预测：同 version 切换命中缓存，零 worker 调用）。

- [ ] **Step 5: 测消费型 cast 回归用例**

构造一个 AST 占星场景：

- 加 7439 cast（炽天召唤），t=0；buff `1224` 持续 30s。
- 在 buff 期内加 8324 cast（星体爆轰），t=15。
- 拖动 8324 在 [0, 15] 区间内移动 → shadow 应允许整个 buff 区间合法。

验证：拖动 8324 到 t=10、t=20、t=5 都不亮红框（buff 自然时长在 worker 里被还原）。

- [ ] **Step 6: 测自动重分类（EditorPage:113-140 路径）**

- 切到一个有 trackGroup 多成员的轨道（如骑士斯卡曼舞步：意气 37013 / 降临 37016 / 圣盾 37014）。
- 添加同 trackGroup 的 cast，看是否自动选合法 variant。
- 这条路径走同步降级（不传 `removalTimelinesByExcludeId`），应与原有行为一致。

- [ ] **Step 7: 测 worker 崩溃恢复（可选，开发者工具）**

DevTools → Sources → 找到 worker 实例 → 强制 throw 一次（或 close 它）。
预期：下次 simulate 重新 spawn，UI 短暂保留 stale 数据后恢复。

如果第 3-6 步任一项有 regression，回去找对应改动文件 debug。

---

## Self-Review

**Spec 覆盖检查：**

- ✅ D1（UI 同步消费）→ Task 4 + Task 5（engine 接口同步、context Map 化）
- ✅ D2（simulateOnRemove 下线 → removalTimelinesByExcludeId Map）→ Task 4 + Task 5
- ✅ D3（extraExcludeIds 上层声明）→ Task 1（draggingId 提 store）+ Task 5 Step 6（EditorPage 拼接）
- ✅ D4（EditorPage 自动重分类不入 worker）→ engine.ts 内降级路径保留；EditorPage:113-140 不动
- ✅ D5（stale-while-revalidate）→ Task 5 Step 2（cancelled flag + setState 时序）
- ✅ D6（Worker 内增量缓存）→ Task 3（按 version + excludeId 双缓存）
- ✅ Worker 协议 → Task 2 types.ts + Task 2 client + Task 3 worker entry
- ✅ Hook 异步化 → Task 5 Step 2
- ✅ PropertyPanel 顺手修 → Task 5 Step 5
- ✅ 错误处理 → Task 2 client.onError + Task 3 try/catch
- ✅ 启动时机（lazy）→ Task 2 ensureWorker
- ✅ Vite `?worker` → Task 5 Step 2 import 语法 + Step 11 构建确认

**Placeholder 扫描：** 无 TBD / TODO；每个 step 都有可直接粘贴的代码或具体修改指令。

**类型一致性：** `removalTimelinesByExcludeId` / `extraExcludeIds` / `SimulateBundle` / `SimulateRequest` / `SimulateResponse` 在所有任务里命名一致。`PlacementEngine` 接口完全未动（spec D1 承诺）。

**依赖关系：** Task 1 独立可单独 commit。Task 2 / 3 互相独立、与主代码无耦合。Task 4 + Task 5 必须连续做：Task 4 完成后项目编译断（仅 placement 测试可独立绿），Task 5 一次性恢复。建议 Task 4 + Task 5 由同一个 subagent 连贯执行。

---

## Execution Handoff

**Plan complete and saved to `design/superpowers/plans/2026-05-14-calculator-worker.md`.**

两种执行路径：

**1. Subagent-Driven（推荐）** —— 每个 task 派 fresh subagent，主 agent 在 task 间 review。适合本 plan 因为 Task 4+5 是关联大改，subagent 可在隔离上下文里集中处理。

**2. Inline Execution** —— 当前 session 内顺序执行，checkpoint 处 review。Token 占用大但反馈链短。

**注意：CLAUDE.md 明确不允许未授权 git 操作；每个 task 的 commit step 需用户明确放行（或预先授权）。**
