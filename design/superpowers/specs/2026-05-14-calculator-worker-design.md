# 计算引擎 Web Worker 化设计

- **日期**: 2026-05-14
- **状态**: Draft
- **落地范围**: `MitigationCalculator.simulate()` 整体搬入 Web Worker；UI 消费侧保持同步接口

## 背景

`src/utils/mitigationCalculator.ts:446 simulate()` 是 1200+ 行的纯计算，输入 timeline / partyState / statistics，输出 `damageResults` / `statusTimelineByPlayer` / `castEffectiveEndByCastEventId` / `healSnapshots` / `hpTimeline`。

当前路径：

- `useDamageCalculation`（`src/hooks/useDamageCalculation.ts`）在主线程 `useMemo` 内跑一次主路径 simulate。
- 暴露 `simulateOnRemove(castEvents) => { statusTimelineByPlayer }` 回调供 `PlacementEngine` 在带 `excludeCastEventId` 的查询里**重跑** simulate，用以还原"消费型 cast"被截断的下游 buff 自然时长（见 `src/utils/placement/engine.ts:31-46` 注释）。
- `SkillTracksCanvas.tsx:557` 当前**故意只为 selected / dragging cast 算 shadow**，原因是预算所有可见 cast 的 shadow 会 N×1.5ms 卡顿。

时间轴规模上升后主路径 simulate 单次可达 5~20ms，叠加 React reconcile 让交互（落子、拖拽、撤销重做）感知到掉帧。把 simulate 搬到 Worker 是直接的解。

## 目标

- `simulate` 不再阻塞主线程任何一帧。
- UI 消费侧（PlacementEngine、PropertyPanel、Timeline / TimelineTable 渲染）**保持同步接口**：不引入 Promise / loading 状态散落各处。
- 拖拽 / 选中切换的 shadow 不出现可察觉的延迟（≤1 帧）。
- 不动 `MitigationCalculator` 的算法语义；只动其调用链路。

## 非目标

- 不优化 `simulate` 内部算法 / 性能（worker 化不是为了让 simulate 本身更快）。
- 不改 placement / resource / status 模型语义。
- 不改回放模式（`isReplayMode`）路径——回放路径根本不调 simulate。
- 不动 `EditorPage` 自动重分类 effect 的同步路径（详见 D4）。

## 核心决策

### D1. UI 一律同步消费：calculator 和 PlacementEngine 走统一抽象

**所有派生数据**（主路径 `statusTimelineByPlayer`、各 `excludeId` 的 `removalTimeline`）由 worker **一次返回打包**到 React state，UI 同步读 Map。

不引入"主路径同步、shadow 异步"的混合范式：那会让组件内分散 `useEffect + useState` 缓存层、loading / stale 状态各自处理，抽象割裂。

### D2. `simulateOnRemove` 回调下线，改为预算结果表

`DamageCalculationResult.simulateOnRemove` 字段移除。新增：

```ts
removalTimelinesByExcludeId: Map<string, StatusTimelineByPlayer>
```

`PlacementEngineInput` 的 `simulateOnRemove` 字段重命名为 `removalTimelinesByExcludeId`，类型由回调改为 Map。`engine.ts:62 timelineExcluding(excludeId)` 改为：**优先查表**；未命中则降级为现有"按 `sourceCastEventId === excludeId` 过滤主路径 timeline"的兜底逻辑（与当前 `simulateOnRemove` 缺省时的降级行为一致，单元测试 / 最小用例兜底）。

### D3. `extraExcludeIds` 由上层显式声明

`useDamageCalculation` 新增可选入参：

```ts
useDamageCalculation(timeline, { extraExcludeIds?: string[] })
```

内容取自 UI 状态：

```ts
extraExcludeIds = [selectedCastEventId, draggingId].filter(Boolean)
```

至多 2 个，去重后通常 1 个（拖拽前必先选中）。**不预算"所有可见 cast 集合"**：`SkillTracksCanvas.tsx:557` 已经把 shadow 计算面收敛到这两个 id，原 N×1.5ms 卡顿警告随之失效。

由 `EditorPage` 从 store 把这两个 id 拼好传入。`selectedCastEventId` 已在 `useTimelineStore`（`src/store/timelineStore.ts:29`）；`draggingId` 当前是 `src/components/Timeline/index.tsx:193` 的组件局部 state，本期需要**前置提升到 store**（建议放 `useUIStore`，与 `isDamageTrackCollapsed` 等纯 UI 态同源），让 EditorPage 能读到。

这是显式的 UI 状态→hook 入参泄露，但口子浅（两个顶层 store 字段），换取 UI 侧零 useEffect 缓存层。

### D4. `EditorPage` 自动重分类 effect 不入 worker

`EditorPage.tsx:113-140` 的自动重分类 effect 当前构造 PlacementEngine 时**不传 `simulateOnRemove`**（`engine.ts:60-78` 走 sourceCastEventId 过滤兜底）：

```ts
// EditorPage.tsx:115-116 原注释
// 自动重分类不调 findInvalidCastEvents（不需要拖拽预览语义）→
// 不传 simulateOnRemove，所有 canPlaceCastEvent / pickUniqueMember
// 直接共享主路径 statusTimelineByPlayer。
```

迁移后这段保持原状：构造 engine 时不传 `removalTimelinesByExcludeId`，所有查询直接共享主路径 timeline，**完全同步**。原因：

1. 这条路径在 effect 里遍历**所有** castEvent.id 调 `canPlaceCastEvent / pickUniqueMember`，如果走 worker 是 N 次 postMessage 往返，比同步降级慢得多。
2. 它的语义本来就不要求消费型 cast 的精确还原（降级过滤已够用）。

### D5. Stale-while-revalidate

新 simulate 在飞行时，hook 内 React state 继续暴露上一次的完整 `DamageCalculationResult`（含旧 `removalTimelinesByExcludeId`）。新结果到达后 `setState` 一次性替换。

- 不显示 loading spinner；可选暴露 `isPending: boolean` 供个别 UI（例如 PropertyPanel 数值区）做淡化态。
- 用户感知最坏路径：mutation 触发新 simulate → 在 worker 跑完之前，UI 上 shadow / 计算结果与新 timeline 不一致一帧。worker simulate 通常 <16ms（一帧内），不可见。

### D6. Worker 内增量缓存

Worker 内按 `(version, excludeId)` 缓存 `SimulateOutput`：

- 主线程每次 `simulate(input, extraExcludeIds)` 调用单调 +1 一个 `version`，随消息发给 worker。
- Worker 收到新 `version` → 清空所有缓存；先跑主路径（无 excludeId）；再依次跑 `extraExcludeIds` 中每个 id 对应的过滤 simulate。
- 同一 `version` 内 `extraExcludeIds` 变化（例：用户选中切换、拖拽起停而 timeline 未变）→ 主路径命中缓存，只跑新增 id 的 simulate。
- `version` 从主线程角度看可以简单理解为"timeline / partyState / statistics 任一变就 +1"（hook deps 变化时自然递增）。

## 架构

```
主线程                                Worker
─────                                 ──────
useDamageCalculation(timeline, {      onmessage:
  extraExcludeIds                       ├─ version 比上次大 → 清缓存
})                                      ├─ simulate(input)                      [cache by version]
  ↓ useEffect                           └─ for id in extraExcludeIds:
CalculatorWorkerClient                       simulate({...input,
  .simulate(input, extraIds)                            castEvents.filter(e=>e.id!==id),
  → Promise<Bundle>                                     skipHpPipeline: true})  [cache by (version,id)]
  ↓                                     ↓
[useState] result（stale 期间是旧值）  postMessage({
  ↓                                       requestId,
DamageCalculationContext                  ok: true,
  ↓                                       bundle: {
PlacementEngine                              main: SimulateOutput,
  ├─ statusTimelineByPlayer                  removalTimelinesByExcludeId: Map
  └─ removalTimelinesByExcludeId           }
       ← 同步 Map.get(id)                 })
```

## 关键类型变化

### `useDamageCalculation` 签名

```ts
export function useDamageCalculation(
  timeline: Timeline | null,
  options?: { extraExcludeIds?: string[] }
): DamageCalculationResult
```

### `DamageCalculationResult`

```ts
interface DamageCalculationResult {
  // 既有：
  results: Map<string, CalculationResult>
  statusTimelineByPlayer: StatusTimelineByPlayer
  castEffectiveEndByCastEventId: Map<string, number>
  healSnapshots: HealSnapshot[]
  hpTimeline: HpTimelinePoint[]
  // 新：
  removalTimelinesByExcludeId: Map<string, StatusTimelineByPlayer>
  // 新（可选 UI 提示）：
  isPending: boolean
  // 删除：simulateOnRemove
}
```

### `PlacementEngineInput`

```ts
interface PlacementEngineInput {
  castEvents: CastEvent[]
  actions: Map<number, MitigationAction>
  statusTimelineByPlayer: StatusTimelineByPlayer
  // 替换 simulateOnRemove：
  removalTimelinesByExcludeId?: Map<string, StatusTimelineByPlayer>
}
```

### `PlacementEngine` 接口

**完全不变**——所有方法保持同步签名（`getValidIntervals` / `computeTrackShadow` / ... 全部）。所有 UI 调用点零改动。

`engine.ts:62 timelineExcluding(excludeId)` 内部：

```ts
function timelineExcluding(excludeId: string): StatusTimelineByPlayer {
  const cached = removalTimelineCache.get(excludeId)
  if (cached) return cached

  let result: StatusTimelineByPlayer
  const prebuilt = removalTimelinesByExcludeId?.get(excludeId)
  if (prebuilt) {
    result = prebuilt
  } else {
    // 与现行 simulateOnRemove 缺省时一致的兜底降级
    result = filterStatusTimelineBySource(defaultTimeline, excludeId)
  }
  removalTimelineCache.set(excludeId, result)
  return result
}
```

## Worker 通信协议

### 消息格式

```ts
// 主线程 → worker
interface SimulateRequest {
  requestId: string // nanoid，主线程用来匹配响应
  version: number // 主线程单调递增
  input: SimulateInput
  extraExcludeIds: string[]
}

// worker → 主线程
type SimulateResponse =
  | { requestId: string; ok: true; bundle: SimulateBundle }
  | { requestId: string; ok: false; error: { message: string; stack?: string } }

interface SimulateBundle {
  main: SimulateOutput // 完整主路径输出
  removalTimelinesByExcludeId: Map<string, StatusTimelineByPlayer>
}
```

### 主线程 client

```ts
// src/web-workers/calculator/client.ts
class CalculatorWorkerClient {
  private worker: Worker | null = null
  private versionCounter = 0
  private pending = new Map<string, { resolve; reject }>()
  private currentRequestId: string | null = null

  simulate(input: SimulateInput, extraExcludeIds: string[]): Promise<SimulateBundle> {
    this.ensureWorker() // lazy spawn
    const requestId = nanoid()
    const version = ++this.versionCounter
    this.currentRequestId = requestId
    const promise = new Promise<SimulateBundle>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
    })
    this.worker!.postMessage({ requestId, version, input, extraExcludeIds })
    return promise
  }

  private onMessage = (e: MessageEvent<SimulateResponse>) => {
    const entry = this.pending.get(e.data.requestId)
    if (!entry) return // 已被 cleanup 丢弃的过期请求
    this.pending.delete(e.data.requestId)
    if (e.data.requestId !== this.currentRequestId) return // 过期：drop
    if (e.data.ok) entry.resolve(e.data.bundle)
    else entry.reject(new Error(e.data.error.message))
  }
}
```

**过期请求处理**：保留 `currentRequestId`，只 resolve 最新一发的请求；旧请求 silently drop（不 reject，避免 hook 异步路径 race 出 stale 错误）。

### Worker entry 伪代码

```ts
// src/web-workers/calculator/index.ts
let lastVersion = -1
const cache = {
  main: null as SimulateOutput | null,
  byExcludeId: new Map<string, SimulateOutput>(),
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
    if (!cache.main) cache.main = calculator.simulate(input)
    const removalTimelinesByExcludeId = new Map<string, StatusTimelineByPlayer>()
    for (const id of extraExcludeIds) {
      let out = cache.byExcludeId.get(id)
      if (!out) {
        out = calculator.simulate({
          ...input,
          castEvents: input.castEvents.filter(e => e.id !== id),
          skipHpPipeline: true,
        })
        cache.byExcludeId.set(id, out)
      }
      removalTimelinesByExcludeId.set(id, out.statusTimelineByPlayer)
    }
    self.postMessage({
      requestId,
      ok: true,
      bundle: { main: cache.main, removalTimelinesByExcludeId },
    })
  } catch (err) {
    self.postMessage({
      requestId,
      ok: false,
      error: { message: err.message, stack: err.stack },
    })
  }
}
```

## Hook 实现要点

```ts
export function useDamageCalculation(
  timeline: Timeline | null,
  { extraExcludeIds = [] }: { extraExcludeIds?: string[] } = {}
): DamageCalculationResult {
  const partyState = useTimelineStore(s => s.partyState)
  const statistics = useTimelineStore(s => s.statistics)
  const [state, setState] = useState<DamageCalculationResult>(EMPTY_RESULT)

  // 排序+去重，稳定字符串化作 deps key
  const extraExcludeIdsKey = useMemo(
    () => Array.from(new Set(extraExcludeIds)).sort().join(','),
    [extraExcludeIds]
  )

  useEffect(() => {
    // 回放模式：同步路径（保持现行实现）
    if (timeline?.isReplayMode) {
      setState(computeReplayResult(timeline))
      return
    }
    if (!timeline || !partyState) {
      setState(buildEmpty(timeline))
      return
    }
    let cancelled = false
    setState(s => ({ ...s, isPending: true }))
    workerClient
      .simulate(
        buildSimulateInput(timeline, partyState, statistics),
        extraExcludeIdsKey.split(',').filter(Boolean)
      )
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
```

**重点**：

- `extraExcludeIds` 的字符串化做 deps：数组身份每次 render 都新，内容才是真依赖。
- `cancelled` 标志位 + client 内 `currentRequestId` 双层防御，确保过期数据不会进 state。
- 错误路径不重置 result（保留上次成功的结果，UI 不会突然空白）。

## 改造影响面

| 文件                                            | 改动类型 | 说明                                                                                                                                      |
| ----------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/mitigationCalculator.ts`             | 无       | 已验证无浏览器全局依赖（grep 过 `window` / `document` / `localStorage`）。可直接被 worker import                                          |
| `src/web-workers/calculator/index.ts`           | 新增     | Worker entry：消息分派、缓存                                                                                                              |
| `src/web-workers/calculator/client.ts`          | 新增     | 主线程 client：lazy spawn、版本号、请求 id 匹配、过期丢弃                                                                                 |
| `src/web-workers/calculator/client.test.ts`     | 新增     | client 单元测试：请求匹配、过期 drop、错误传递                                                                                            |
| `src/hooks/useDamageCalculation.ts`             | 重写     | `useMemo` → `useState + useEffect`；新增 `extraExcludeIds` 入参；回放分支保持同步                                                         |
| `src/hooks/useDamageCalculation.test.ts`        | 适配     | 注入 mock client；测试同步回放路径 + worker 路径回包流程                                                                                  |
| `src/contexts/DamageCalculationContext.ts`      | 接口调整 | 删 `simulateOnRemove`；加 `removalTimelinesByExcludeId` 和 `isPending`；删除 `useDamageCalculationSimulate` hook                          |
| `src/utils/placement/types.ts`                  | 接口调整 | `PlacementEngineInput.simulateOnRemove` → `removalTimelinesByExcludeId`                                                                   |
| `src/utils/placement/engine.ts`                 | 内部改写 | `timelineExcluding` 改查表；删 `simulateOnRemove` 调用分支                                                                                |
| `src/utils/placement/engine.test.ts`            | 适配     | mock `simulateOnRemove` 的测试改 mock `removalTimelinesByExcludeId` Map                                                                   |
| `src/utils/placement/integration.test.ts`       | 适配     | 同上                                                                                                                                      |
| `src/store/uiStore.ts`                          | 增量     | 新增 `draggingId: string \| null` + `setDraggingId` action（前置依赖）                                                                    |
| `src/pages/EditorPage.tsx`                      | 增量     | 从 store 拼 `extraExcludeIds` 传入 `useDamageCalculation`；自动重分类 effect 保持原样                                                     |
| `src/components/Timeline/index.tsx`             | 增量     | 删 `useDamageCalculationSimulate` 用法；engine 构造时传 `removalTimelinesByExcludeId`；`draggingId` local state → store；保留所有同步调用 |
| `src/components/Timeline/SkillTracksCanvas.tsx` | 微调     | 删 `draggingId` / `setDraggingId` 两个 prop；改从 store 读                                                                                |
| `src/components/TimelineTable/index.tsx`        | 增量     | 同上                                                                                                                                      |
| `src/components/PropertyPanel.tsx`              | 增量     | `useDamageCalculation(timeline)` → `useDamageCalculationResults()`（避免双倍 simulate）                                                   |

UI 渲染热路径文件（`SkillTracksCanvas.tsx`、`DamageEventCard.tsx` 等）**零改动**——所有数据通过 context 同步消费，接口签名不变。

**附带修复**：`src/components/PropertyPanel.tsx:60` 当前直接调用 `useDamageCalculation(timeline)` 拿 `results`。本期改为通过 `useDamageCalculationResults()` 从 context 读取——避免本 hook 模式下两个 `useDamageCalculation` 实例（EditorPage + PropertyPanel）触发双倍 simulate。该修复独立于 worker 化，但顺手做。

## 测试策略

**单元测试**：

- `mitigationCalculator.test.ts`：**不动**。simulate 本身没改。
- `placement/engine.test.ts` & `integration.test.ts`：mock 输入字段名变更（`simulateOnRemove` callback → `removalTimelinesByExcludeId` Map），机械适配。
- `useDamageCalculation.test.ts`：通过依赖注入传 mock worker client（hook 模块导出一个可替换的默认 client；测试时替换为同步 fake）。覆盖：
  - 回放模式：纯同步路径，不调 client。
  - 编辑模式：deps 变化触发 client.simulate；resolve 后 setState 正确包含 main + removalTimelines。
  - 快速连续 mutation：旧请求 cancelled 不污染 state。
  - 错误路径：reject 时保留上次 result + log。
- `web-workers/calculator/client.test.ts`（新）：
  - postMessage 携带正确 requestId / version / input。
  - 收到匹配 response → resolve；不匹配 → 不 leak。
  - 过期请求 onMessage 不 resolve。
  - error response → reject 并带 stack。

**集成 / 烟测**：

- 本 spec 落地后手动跑一遍 `EditorPage`：拖拽 cast 看 shadow 是否同步变化；选中切换看蓝色 CD 条 / placement 阴影一致；查看 PropertyPanel 数值是否随 mutation 即时更新。
- 重点对照场景：占星 7439 + 8324 那个消费型 cast 例子（`engine.ts:36-42` 注释回归用例），拖拽 8324 在 buff 内移动应仍然合法。

## 启动时机

- Worker **lazy spawn**：`workerClient.simulate()` 首次调用时 `new Worker(...)`。
- 模块级 singleton：整个 app 一个 worker 实例，所有 `useDamageCalculation` 调用方共享。
- 回放模式从未触发 spawn（其 useEffect 分支直接同步 return）。

## 错误处理

- Worker 内 `simulate` throw → 通过 `postMessage` 转 `{ok: false, error}`，主线程 client reject，hook 内 `.catch` 保留旧 state + `console.error`。
- Worker 进程异常崩溃（`worker.onerror` / `worker.onmessageerror`）：log + 关闭 + 清空 pending（全部 reject "worker crashed"）+ 下次 simulate 时重新 spawn。UI 继续消费 stale 数据。
- 不为 worker 启动失败做 fallback 到主线程同步路径——失败说明环境异常，让错误暴露更好（避免 silent degradation）。

## Vite 配置

```ts
import CalculatorWorker from './web-workers/calculator/index.ts?worker'
// new CalculatorWorker() 直接用
```

Vite 7 原生支持 `?worker` import 后缀，worker bundle 自动 code-split、相对路径解析正确。无需额外 plugin。

## 风险与缓解

| 风险                                                                 | 缓解                                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Worker bundle 重复包含 `MITIGATION_DATA` / `statusRegistry` 等大常量 | 接受。Worker 隔离的固有代价。未来如发现 bundle 过大可评估抽离到独立 chunk + worker 与主线程都从 chunk 加载，但本期不做           |
| `SimulateInput` 内某些字段非 structured-clonable（函数 / Symbol）    | 落地时 sanity check：第一次 simulate 调用前 `JSON.stringify` 探测；如有问题做一次输入扁平化转换。**`partyState` 当前看是纯数据** |
| Worker 缓存按 version 失效不当 → UI 拿到陈旧数据                     | 测试覆盖 mutation→simulate→cache miss；version 单调递增由主线程保证；worker 接收到比 lastVersion 大就清缓存                      |
| 拖拽时 worker 跑得比一帧慢 → shadow 闪一帧                           | 大多数情况下 worker simulate <16ms。缓存命中路径（同 version 内 draggingId 切换）零延迟。极端时间轴若超出 16ms，作为后续优化项   |
| Worker 首次 spawn 开销（~50ms 加载 + parse）                         | 安排在 timeline 首次加载触发 useEffect 时；用户本就在等数据，多 50ms 不可感                                                      |
| 测试环境（jsdom + vitest）无原生 Worker                              | hook 通过依赖注入接 mock client；client 测试用 `Worker` mock 或 vitest 的 `vi.mock`                                              |

## Out of Scope（明确不做）

- 不做 transferable buffer 优化（structured clone 当前足够）。
- 不做 SharedArrayBuffer / Atomics 等高级共享内存方案。
- 不做主路径 simulate 算法层面的优化。
- 不改 EditorPage 自动重分类的实现路径。
- 不为 worker 启动失败做主线程 fallback。

## 后续可能（不在本期）

- 如果用户实测拖拽期间 simulate 超 16ms 频繁出现：考虑预算"邻近 cast"几个 excludeId 提前热缓存。
- 监控 worker bundle 大小：若发现 worker 启动延迟显著影响首屏，评估抽离公共 chunk。
