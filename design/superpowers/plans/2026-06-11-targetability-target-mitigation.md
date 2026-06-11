# 基于可选中性的目标减无效判定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导入 FFLogs 战斗时，把"伤害来源在该伤害时刻不可选中（无敌/转场）"也判为目标减无效，结果落进既有 `targetMitigationDisabled` 字段。

**Architecture:** Worker 用 `filterExpression` 服务端只抓 `targetabilityupdate` 事件并入 `events` 回前端；前端导入期由这些事件按 `targetID` 重建"可选中切换点"，在 `parseDamageEvents` 里与既有"非-boss"规则做 OR 叠加。计算引擎 / UI / 持久化全部复用既有 `targetMitigationDisabled` / `tmd`，零改动。

**Tech Stack:** TypeScript、Vitest、FFLogs v2 GraphQL（Cloudflare Worker）、pnpm。

**设计依据:** `design/superpowers/specs/2026-06-11-targetability-target-mitigation-design.md`（含已用真实报告 `7YmcBTgfyX2dPA4z` fight 6 确认的字段形态与实测区间附录）。

**实证已确认的 raw 事件形态:**

```json
{
  "timestamp": 4934125,
  "type": "targetabilityupdate",
  "sourceID": 11,
  "targetID": 11,
  "abilityGameID": 0,
  "fight": 6,
  "targetable": 0
}
```

- `targetable`: `0`=变不可选中、`1`=恢复可选中（数值）。
- `sourceID === targetID`（自身状态变化），取 `targetID`。
- 多实例小怪带 `*Instance`；boss 本体单实例。按 `targetID` 跟踪、忽略 instance。

---

## File Structure

| 文件                                 | 职责            | 改动                                                                                                                    |
| ------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/types/fflogs.ts`                | FFLogs 事件类型 | 给 `FFLogsEvent` 加 `targetable?: number`                                                                               |
| `src/workers/fflogsClientV2.ts`      | Worker 抓取     | hoist `EVENT_FETCH_SPECS` 到模块级 + 加 `targetabilityupdate` 条目 + query 加 `filterExpression` 变量                   |
| `src/workers/fflogsClientV2.test.ts` | Worker 测试     | 断言抓取矩阵含 targetabilityupdate 条目                                                                                 |
| `src/utils/fflogsImporter.ts`        | 前端导入解析    | 新增 `buildTargetabilityIntervals` / `isTargetableAt`；`parseDamageEvents` 加第 8 参 + OR 判定；`parseFightImport` 接线 |
| `src/utils/fflogsImporter.test.ts`   | 导入测试        | interval/查询/判定单测                                                                                                  |

**约定:** 提交信息禁止含 "claude" 字样（`.husky/commit-msg` 会拒绝）；用中文 `feat:`/`test:` 前缀，与项目历史一致。每个 Task 末尾提交一次。

---

## Task 1: Worker 抓取 targetabilityupdate 事件

**Files:**

- Modify: `src/types/fflogs.ts`（`FFLogsEvent` 接口，约 `:1`–`:50` 区段内）
- Modify: `src/workers/fflogsClientV2.ts`（模块级新增 + `getEvents` 约 `:443`–`:545`）
- Test: `src/workers/fflogsClientV2.test.ts`

- [ ] **Step 1: 给 `FFLogsEvent` 加 `targetable` 字段**

在 `src/types/fflogs.ts` 的 `FFLogsEvent` 接口里，`targetInstance?: number` 字段附近追加：

```ts
  /** 可选中状态（targetabilityupdate 事件）：1=可选中，0=不可选中 */
  targetable?: number
```

- [ ] **Step 2: 写 Worker 失败测试**

在 `src/workers/fflogsClientV2.test.ts` 顶部 import 后追加（与现有 `import { mapV2ReportToReport } ...` 同风格，从同模块导入）：

```ts
import { EVENT_FETCH_SPECS } from './fflogsClientV2'

describe('EVENT_FETCH_SPECS', () => {
  it('包含 targetabilityupdate 抓取条目（服务端 filterExpression 过滤）', () => {
    const spec = EVENT_FETCH_SPECS.find(s => s.filterType === 'targetabilityupdate')
    expect(spec).toBeDefined()
    expect(spec?.dataType).toBe('All')
    expect(spec?.filterExpression).toBe('type="targetabilityupdate"')
  })

  it('既有抓取条目不带 filterExpression（不破坏既有抓取）', () => {
    const casts = EVENT_FETCH_SPECS.find(s => s.dataType === 'Casts' && !s.hostilityType)
    expect(casts?.filterExpression).toBeUndefined()
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test:run src/workers/fflogsClientV2.test.ts`
Expected: FAIL —— `EVENT_FETCH_SPECS` 未导出（导入报错 / undefined）。

- [ ] **Step 4: hoist `FetchSpec` 类型与 `EVENT_FETCH_SPECS` 到模块级并加新条目**

在 `src/workers/fflogsClientV2.ts` 的 `export class FFLogsClientV2 {`（约 `:133`）**之前**，插入模块级声明：

```ts
/** 单条事件抓取参数 */
export type FetchSpec = {
  dataType: string
  hostilityType?: 'Friendlies' | 'Enemies'
  includeResources?: boolean
  /** 单页请求条数，默认 10000 */
  limit?: number
  /** 只取首页、不翻页（用于锚点类小请求） */
  singlePage?: boolean
  /** 仅保留该 type 的事件（其余丢弃，避免与其他 spec 重复） */
  filterType?: string
  /** FFLogs 服务端过滤表达式（如 type="targetabilityupdate"），让服务端只回匹配事件 */
  filterExpression?: string
}

/**
 * 事件抓取矩阵（每条一种类型，自动分页）：
 * - Casts 额外追加一条 Enemies 请求（Boss 技能读条）
 * - DamageTaken / Healing 需 includeResources 拿玩家资源快照
 * - limitbreakupdate：仅首页锚点（零时间）
 * - targetabilityupdate：全程分页，但服务端 filterExpression 过滤后返回量极小；
 *   用于导入期重建敌方可选中区间（目标减无效判定）
 */
export const EVENT_FETCH_SPECS: FetchSpec[] = [
  { dataType: 'Casts' },
  { dataType: 'Casts', hostilityType: 'Enemies' },
  { dataType: 'DamageTaken', includeResources: true },
  { dataType: 'Healing', includeResources: true },
  { dataType: 'CombatantInfo' },
  { dataType: 'Debuffs' },
  { dataType: 'Buffs' },
  { dataType: 'All', limit: 200, singlePage: true, filterType: 'limitbreakupdate' },
  {
    dataType: 'All',
    filterExpression: 'type="targetabilityupdate"',
    filterType: 'targetabilityupdate',
  },
]
```

然后在 `getEvents` 内删除原有的内联 `type FetchSpec = {...}` 与 `const fetchSpecs: FetchSpec[] = [...]`（约 `:449`–`:471`），改为引用模块级常量。原 `Promise.all(fetchSpecs.map(...))`（约 `:539`）改为：

```ts
const results = await Promise.all(EVENT_FETCH_SPECS.map(fetchAllEventsForSpec))
```

- [ ] **Step 5: query 加 `filterExpression` 变量并传入**

修改 `getEvents` 内的 GraphQL query 字符串（约 `:473`）：变量签名加 `$filterExpression: String`，`events(...)` 调用加 `filterExpression: $filterExpression`：

```ts
const query = `
      query GetEvents($code: String!, $startTime: Float, $endTime: Float, $dataType: EventDataType!, $hostilityType: HostilityType, $includeResources: Boolean, $limit: Int, $filterExpression: String) {
        reportData {
          report(code: $code) {
            events(
              startTime: $startTime
              endTime: $endTime
              dataType: $dataType
              hostilityType: $hostilityType
              translate: false
              includeResources: $includeResources
              limit: $limit
              filterExpression: $filterExpression
            ) {
              data
              nextPageTimestamp
            }
          }
        }
      }
    `
```

在 `fetchAllEventsForSpec` 内的 `this.query(query, {...})` 变量对象（约 `:501`–`:508`）追加一行：

```ts
          limit: spec.limit ?? 10000,
          filterExpression: spec.filterExpression ?? null,
```

> 注：FFLogs 把 `filterExpression: null` 视为无过滤，对既有 spec 无影响；本 query 形态已对真实 API 验证可用（实证抓取用的就是同款 `filterExpression`）。

- [ ] **Step 6: 运行测试确认通过 + 类型检查**

Run: `pnpm test:run src/workers/fflogsClientV2.test.ts && pnpm exec tsc --noEmit`
Expected: 测试 PASS；tsc 无报错。

- [ ] **Step 7: 提交**

```bash
git add src/types/fflogs.ts src/workers/fflogsClientV2.ts src/workers/fflogsClientV2.test.ts
git commit -m "feat(import): 抓取 targetabilityupdate 事件并暴露抓取矩阵"
```

---

## Task 2: 可选中区间构建与查询（纯函数）

**Files:**

- Modify: `src/utils/fflogsImporter.ts`（新增两个导出函数 + 一个类型）
- Test: `src/utils/fflogsImporter.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/utils/fflogsImporter.test.ts` 的 import 块（约 `:7`–`:17`）把 `buildTargetabilityIntervals` 与 `isTargetableAt` 加入从 `'./fflogsImporter'` 的命名导入。然后在 `describe('buildBossIds', ...)` 之后追加：

```ts
describe('buildTargetabilityIntervals / isTargetableAt', () => {
  const ev = (timestamp: number, id: number, targetable: number) =>
    ({
      type: 'targetabilityupdate',
      timestamp,
      sourceID: id,
      targetID: id,
      targetable,
    }) as FFLogsEvent

  it('按 targetID 分组并按时间升序', () => {
    const m = buildTargetabilityIntervals([ev(200, 11, 1), ev(100, 11, 0), ev(150, 21, 0)])
    expect(m.get(11)?.map(t => t.timestamp)).toEqual([100, 200])
    expect(m.get(11)?.map(t => t.targetable)).toEqual([false, true])
    expect(m.get(21)?.length).toBe(1)
  })

  it('未跟踪 actor 默认可选中', () => {
    expect(isTargetableAt(buildTargetabilityIntervals([]), 11, 500)).toBe(true)
  })

  it('早于首切换点默认可选中；边界取该点状态', () => {
    const m = buildTargetabilityIntervals([ev(100, 11, 0), ev(200, 11, 1)])
    expect(isTargetableAt(m, 11, 50)).toBe(true) // 早于首点
    expect(isTargetableAt(m, 11, 100)).toBe(false) // 边界=该点状态
    expect(isTargetableAt(m, 11, 150)).toBe(false) // 不可选中区间内
    expect(isTargetableAt(m, 11, 200)).toBe(true) // 恢复
  })

  it('忽略 instance：多实例事件仍按 targetID 归并', () => {
    const m = buildTargetabilityIntervals([
      {
        type: 'targetabilityupdate',
        timestamp: 100,
        sourceID: 31,
        sourceInstance: 1,
        targetID: 31,
        targetInstance: 1,
        targetable: 0,
      } as FFLogsEvent,
      {
        type: 'targetabilityupdate',
        timestamp: 100,
        sourceID: 31,
        sourceInstance: 2,
        targetID: 31,
        targetInstance: 2,
        targetable: 0,
      } as FFLogsEvent,
    ])
    expect(m.get(31)?.length).toBe(2)
  })

  it('非 targetabilityupdate 事件被忽略', () => {
    const m = buildTargetabilityIntervals([
      { type: 'damage', timestamp: 100, targetID: 11 } as FFLogsEvent,
    ])
    expect(m.size).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run src/utils/fflogsImporter.test.ts -t "buildTargetabilityIntervals"`
Expected: FAIL —— 函数未定义。

- [ ] **Step 3: 实现两个函数**

在 `src/utils/fflogsImporter.ts` 的 `resolveFightStartTime`（约 `:76`）附近、`parseComposition` 之前，新增：

```ts
/** 可选中状态切换点 */
export interface TargetabilityToggle {
  /** 报告相对毫秒（与伤害事件 timestamp 同域） */
  timestamp: number
  /** 该时刻起是否可选中 */
  targetable: boolean
}

/**
 * 由 targetabilityupdate 事件重建每个敌方 actor 的可选中状态切换点。
 * 按 targetID 分组（sourceID===targetID，忽略 instance——boss 单实例、多实例的是小怪，
 * 后者本就被非-boss 规则无条件判无效），按 timestamp 升序。
 * 首切换点之前由 isTargetableAt 约定为"默认可选中"。无此类事件的 actor 不入表。
 */
export function buildTargetabilityIntervals(
  events: FFLogsEvent[]
): Map<number, TargetabilityToggle[]> {
  const map = new Map<number, TargetabilityToggle[]>()
  for (const e of events) {
    if (e.type !== 'targetabilityupdate' || e.targetID === undefined) continue
    const list = map.get(e.targetID) ?? []
    list.push({ timestamp: e.timestamp, targetable: e.targetable === 1 })
    map.set(e.targetID, list)
  }
  for (const list of map.values()) list.sort((a, b) => a.timestamp - b.timestamp)
  return map
}

/**
 * 查询 actor 在某时刻（报告相对毫秒）是否可选中。
 * - 未跟踪的 actor（无 targetabilityupdate 事件）→ 默认可选中（向后兼容）。
 * - 早于首切换点 → 默认可选中（boss 开场可选中）。
 * - 否则取最后一个 timestamp <= ts 的切换点状态。
 */
export function isTargetableAt(
  intervals: Map<number, TargetabilityToggle[]>,
  actorId: number,
  timestamp: number
): boolean {
  const list = intervals.get(actorId)
  if (!list || list.length === 0) return true
  let state = true
  for (const toggle of list) {
    if (toggle.timestamp <= timestamp) state = toggle.targetable
    else break
  }
  return state
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:run src/utils/fflogsImporter.test.ts -t "buildTargetabilityIntervals"`
Expected: PASS（5 个用例全过）。

- [ ] **Step 5: 提交**

```bash
git add src/utils/fflogsImporter.ts src/utils/fflogsImporter.test.ts
git commit -m "feat(import): 由 targetabilityupdate 重建敌方可选中区间"
```

---

## Task 3: parseDamageEvents OR 叠加 + parseFightImport 接线

**Files:**

- Modify: `src/utils/fflogsImporter.ts`（`parseDamageEvents` 签名约 `:132`、判定约 `:387`；`parseFightImport` 约 `:882`）
- Test: `src/utils/fflogsImporter.test.ts`

- [ ] **Step 1: 写失败测试**

在 `describe('parseDamageEvents 目标减自动判定', ...)`（约 `:2214`）块内、末尾 `})` 之前追加三个用例（复用该 describe 已有的 `withCalc` / `playerMap` / `abilityMap` / `events`，其中伤害来源 500=boss、700=小怪，分别在 +5000ms / +9000ms 落地）：

```ts
const taEvent = (timestamp: number, id: number, targetable: number) =>
  ({
    type: 'targetabilityupdate',
    timestamp,
    sourceID: id,
    targetID: id,
    targetable,
  }) as FFLogsEvent

it('boss 来源在不可选中时段 → disabled', () => {
  const targetability = buildTargetabilityIntervals([taEvent(fightStartTime + 3000, 500, 0)])
  const result = parseDamageEvents(
    withCalc(events),
    fightStartTime,
    playerMap,
    abilityMap,
    undefined,
    new Set([500]),
    undefined,
    targetability
  )
  const fromBoss = result.find(e => Math.abs(e.time - 5) < 0.6)
  expect(fromBoss?.targetMitigationDisabled).toBe(true)
})

it('boss 来源在可选中时段 → 不标记', () => {
  const targetability = buildTargetabilityIntervals([
    taEvent(fightStartTime + 3000, 500, 0),
    taEvent(fightStartTime + 4000, 500, 1),
  ])
  const result = parseDamageEvents(
    withCalc(events),
    fightStartTime,
    playerMap,
    abilityMap,
    undefined,
    new Set([500]),
    undefined,
    targetability
  )
  const fromBoss = result.find(e => Math.abs(e.time - 5) < 0.6)
  expect(fromBoss?.targetMitigationDisabled).toBeUndefined()
})

it('bossIds 为空 + 来源不可选中 → 仍 disabled（通用规则不依赖 boss 检测）', () => {
  const targetability = buildTargetabilityIntervals([taEvent(fightStartTime + 3000, 500, 0)])
  const result = parseDamageEvents(
    withCalc(events),
    fightStartTime,
    playerMap,
    abilityMap,
    undefined,
    undefined,
    undefined,
    targetability
  )
  const fromBoss = result.find(e => Math.abs(e.time - 5) < 0.6)
  expect(fromBoss?.targetMitigationDisabled).toBe(true)
})
```

确保该测试文件 import 块已含 `buildTargetabilityIntervals`（Task 2 Step 1 已加）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run src/utils/fflogsImporter.test.ts -t "目标减自动判定"`
Expected: FAIL —— 第 8 参未被处理，boss 来源仍 `undefined`（前两个新用例至少有一个失败）。

- [ ] **Step 3: 扩展 `parseDamageEvents` 签名**

在 `src/utils/fflogsImporter.ts` 的 `parseDamageEvents` 参数表（约 `:132`–`:141`），在 `sourceNames` 之后追加第 8 个可选参数：

```ts
  /** sourceID → actor 名映射，编排层用 report.enemies 建好传入；仅用于填 damageSource */
  sourceNames?: Map<number, string>,
  /** actorId → 可选中切换点；来源在伤害时刻不可选中时，目标减判无效 */
  targetability?: Map<number, TargetabilityToggle[]>
): DamageEvent[] {
```

- [ ] **Step 4: 判定改为 OR 叠加**

把 `parseDamageEvents` 内构建 `targetMitigationDisabled` 处（约 `:387`–`:390`）替换为：

```ts
const sourceId = detailSourceIds.get(firstDetail) ?? 0
const sourceIsNonBoss = !!bossIds && bossIds.size > 0 && sourceId !== 0 && !bossIds.has(sourceId)
// 来源已知且在该伤害时刻不可选中（用 raw timestamp，与 targetabilityupdate 同为报告相对毫秒域）
const sourceUntargetable =
  !!targetability &&
  sourceId !== 0 &&
  !isTargetableAt(targetability, sourceId, firstDetail.timestamp)
const targetMitigationDisabled = sourceIsNonBoss || sourceUntargetable ? true : undefined
const damageSource = sourceId !== 0 ? sourceNames?.get(sourceId) : undefined
```

> `firstDetail.timestamp` 是报告相对毫秒（与事件 `id` 用的同一字段），与 targetability 事件 timestamp 同域，直接比较无需换算。

- [ ] **Step 5: 运行测试确认通过 + 回归既有判定用例**

Run: `pnpm test:run src/utils/fflogsImporter.test.ts -t "目标减自动判定"`
Expected: PASS（含新 3 例与原"非 boss 来源标记 disabled" / "未传 bossIds 时全部默认生效"两例回归）。

- [ ] **Step 6: parseFightImport 接线**

在 `src/utils/fflogsImporter.ts` 的 `parseFightImport`（约 `:882`）里，已有 `enemyNames` 构建之后、`parseDamageEvents` 调用之前，新增 `targetability` 构建，并把它作为第 8 参传入：

```ts
const enemyNames = new Map<number, string>()
report.enemies?.forEach(e => enemyNames.set(e.id, e.name))
const targetability = buildTargetabilityIntervals(events)
const damageEvents = parseDamageEvents(
  events,
  fightStartTime,
  playerMap,
  abilityMap,
  composition,
  bossIds,
  enemyNames,
  targetability
)
```

- [ ] **Step 7: 运行该文件全量测试 + 类型检查**

Run: `pnpm test:run src/utils/fflogsImporter.test.ts && pnpm exec tsc --noEmit`
Expected: 全 PASS；tsc 无报错。

- [ ] **Step 8: 提交**

```bash
git add src/utils/fflogsImporter.ts src/utils/fflogsImporter.test.ts
git commit -m "feat(import): 来源不可选中时段判目标减无效"
```

---

## Task 4: 全量验证

**Files:** 无新增改动，仅验证。

- [ ] **Step 1: 全量测试**

Run: `pnpm test:run`
Expected: 全部 PASS（重点确认未回归 `mitigationCalculator` / `timelineFormat` 等）。

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: 无 error。

- [ ] **Step 3: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无报错。

- [ ] **Step 4: 构建兜底**

Run: `pnpm build`
Expected: 构建成功。

- [ ] **Step 5: 若前述步骤有改动则提交**

```bash
git add -A
git commit -m "chore(import): 修正 lint/类型问题"
```

> 若 Step 1–4 全绿无改动，跳过本步。

---

## Self-Review 备忘（已核对）

- **Spec 覆盖:** Worker 抓取（Task 1）、interval 构建（Task 2）、OR 判定 + 接线（Task 3）、全量验证（Task 4）；spec 列出的"不改动部分"（计算/UI/持久化）确实零改动。✅
- **类型一致:** `buildTargetabilityIntervals` 返回 `Map<number, TargetabilityToggle[]>`，`isTargetableAt` 与 `parseDamageEvents` 第 8 参同型；`FFLogsEvent.targetable?: number`，`isTargetableAt` 内以 `=== 1` 归一为布尔。✅
- **无占位符:** 所有步骤含完整代码与确切命令。✅
- **worker 测试策略:** 既有 `fflogsClientV2.test.ts` 无网络 mock，故把抓取矩阵 hoist 为可导出常量做断言（而非引入 fetch mock 基础设施），与现有测试风格一致。
