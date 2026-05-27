# 表格视图斜纹「不可放置」阴影 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把时间轴的斜纹「不可放置」阴影按相同逻辑搬到表格视图，仅编辑模式显示，与 CD 显示并列。

**Architecture:** 新增纯函数 `computeShadowCellsByEvent` 把每个技能列的 shadow 区间离散映射到伤害事件单元格；分支逻辑（cd<=3 / placement）封装在 `index.tsx` 的 `shadowIntervalsForTrack` 回调里；`TableDataRow` 用「绿>蓝>斜纹」渲染优先级画灰色斜纹层。

**Tech Stack:** React 19 + TypeScript，Vitest 4，pnpm。斜纹用 CSS `repeating-linear-gradient`。

设计文档：`design/superpowers/specs/2026-05-27-table-cd-display-design.md`（「追加：斜纹阴影」一节）

---

## 背景速览（实施者必读）

- 这是 CD 显示之后的第二阶段。表格已有：绿底（`computeLitCellsByEvent`）、蓝底 CD（`computeCdCellsByEvent`）、cast 图标。
- 阴影是**逐轨**（per trackGroup）计算，不是逐 cast。数据源是 `engine`（`PlacementEngine`，已在 `index.tsx` 构造）的两个方法：
  - `computeTrackShadow(groupId, playerId, excludeCastEventId?): Interval[]` —— 完整不可放区
  - `computePlacementShadow(groupId, playerId, excludeCastEventId?): Interval[]` —— 仅 placement 非法区
  - `Interval` = `{ from: number; to: number }`（`src/utils/placement/types.ts`）
- Canvas 分支（`SkillTracksCanvas.tsx:255-268`）：`cooldown<=3 && !placement`→不画；`cooldown<=3`→placement shadow；否则→track shadow。`groupId = effectiveTrackGroup(parent)`（`src/types/mitigation.ts`）。
- `SkillTrack`（`src/utils/skillTracks.ts`）有 `playerId`、`actionId`；列 key 是 `cellKey(track.playerId, track.actionId)`，`track.actionId` 即 trackGroup id。
- 渲染优先级「绿>蓝>斜纹」：斜纹只在非绿非蓝格出现，等价于 Canvas 的 `subtractIntervals(rawShadow, 绿+蓝条)`，但无需区间运算。
- 仅编辑模式显示（Canvas `!isReadOnly`）。表格用已有的 `isReadOnly`（`useEditorReadOnly()`）。

---

## File Structure

| 文件                                            | 责任                 | 改动                                                 |
| ----------------------------------------------- | -------------------- | ---------------------------------------------------- |
| `src/utils/castWindow.ts`                       | 单元格命中纯函数集合 | 新增 `computeShadowCellsByEvent`                     |
| `src/utils/castWindow.test.ts`                  | 纯函数单测           | 新增 `computeShadowCellsByEvent` 用例                |
| `src/components/TimelineTable/TableDataRow.tsx` | 渲染单行             | 新增 `shadowCells` prop + 斜纹层                     |
| `src/components/TimelineTable/index.tsx`        | 数据接线             | 新增 useMemo + `shadowIntervalsForTrack` 回调 + 传参 |

---

## Task 1: `computeShadowCellsByEvent` 纯函数（TDD）

**Files:**

- Modify: `src/utils/castWindow.ts`（文件末尾、`computeCdCellsByEvent` 之后新增；需 import `Interval` 与 `SkillTrack` 类型）
- Test: `src/utils/castWindow.test.ts`（新增 describe 块）

- [ ] **Step 1: 写失败测试**

把 `src/utils/castWindow.test.ts` 顶部 import 改为同时引入新函数：

```ts
import {
  computeLitCellsByEvent,
  computeCdCellsByEvent,
  computeShadowCellsByEvent,
  cellKey,
} from './castWindow'
```

在文件末尾、`describe('cellKey', ...)` 之前新增（`damage` / `cast` / `action` 工厂已存在；新增一个轻量 `track` 工厂）：

```ts
describe('computeShadowCellsByEvent', () => {
  const track = (playerId: number, actionId: number): SkillTrack =>
    ({ playerId, actionId, job: 'WHM', actionName: `a-${actionId}`, actionIcon: '' }) as SkillTrack

  it('from <= damageTime < to 时标记为 shadow', () => {
    const tracks = [track(1, 100)]
    const intervals = () => [{ from: 10, to: 30 }]
    const result = computeShadowCellsByEvent([damage('d1', 20)], tracks, intervals)
    expect(result.get('d1')?.has(cellKey(1, 100))).toBe(true)
  })

  it('damageTime === from 当刻命中（左闭）', () => {
    const result = computeShadowCellsByEvent([damage('d1', 10)], [track(1, 100)], () => [
      { from: 10, to: 30 },
    ])
    expect(result.get('d1')?.has(cellKey(1, 100))).toBe(true)
  })

  it('damageTime === to 当刻不命中（右开）', () => {
    const result = computeShadowCellsByEvent([damage('d1', 30)], [track(1, 100)], () => [
      { from: 10, to: 30 },
    ])
    expect(result.get('d1')?.has(cellKey(1, 100))).toBe(false)
  })

  it('单轨多区间：任一区间命中即标记', () => {
    const intervals = () => [
      { from: 0, to: 5 },
      { from: 20, to: 25 },
    ]
    const result = computeShadowCellsByEvent(
      [damage('d1', 2), damage('d2', 10), damage('d3', 22)],
      [track(1, 100)],
      intervals
    )
    expect(result.get('d1')?.has(cellKey(1, 100))).toBe(true)
    expect(result.get('d2')?.has(cellKey(1, 100))).toBe(false)
    expect(result.get('d3')?.has(cellKey(1, 100))).toBe(true)
  })

  it('回调返回空区间则该轨不产生 shadow', () => {
    const result = computeShadowCellsByEvent([damage('d1', 20)], [track(1, 100)], () => [])
    expect(result.get('d1')?.size).toBe(0)
  })

  it('不同 track 独立 keying', () => {
    const tracks = [track(1, 100), track(2, 200)]
    // 回调按 track 返回不同区间：track(1,100) 命中 d1，track(2,200) 不命中
    const intervals = (t: SkillTrack) =>
      t.playerId === 1 ? [{ from: 10, to: 30 }] : [{ from: 100, to: 200 }]
    const result = computeShadowCellsByEvent([damage('d1', 20)], tracks, intervals)
    expect(result.get('d1')?.has(cellKey(1, 100))).toBe(true)
    expect(result.get('d1')?.has(cellKey(2, 200))).toBe(false)
  })

  it('每个伤害事件都有一个 Set（可能为空）', () => {
    const result = computeShadowCellsByEvent([damage('d1', 100), damage('d2', 200)], [], () => [])
    expect(result.get('d1')).toEqual(new Set())
    expect(result.get('d2')).toEqual(new Set())
  })
})
```

测试顶部需要 `SkillTrack` 类型。把测试文件顶部的 type import 补上：

```ts
import type { SkillTrack } from './skillTracks'
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run src/utils/castWindow.test.ts`
Expected: FAIL —— `computeShadowCellsByEvent is not a function` / import 报错。

- [ ] **Step 3: 实现函数**

在 `src/utils/castWindow.ts` 顶部 import 区补类型（文件已 import `DamageEvent, CastEvent` from `@/types/timeline`、`MitigationAction` from `@/types/mitigation`，新增两行）：

```ts
import type { Interval } from '@/utils/placement/types'
import type { SkillTrack } from '@/utils/skillTracks'
```

在文件末尾（`computeCdCellsByEvent` 之后）新增：

```ts
/**
 * 计算每个伤害事件落在哪些技能列的"斜纹不可放置阴影"区间内。
 *
 * 与时间轴斜纹同源：shadow 区间逐轨（per trackGroup）由 `shadowIntervalsForTrack`
 * 回调给出（调用方封装 cd<=3 / placement 分支 + engine.computeTrackShadow /
 * computePlacementShadow，见 SkillTracksCanvas）。本函数只做区间→单元格映射。
 *
 * 命中规则：from <= damageEvent.time < to（左闭右开，与 computeCdCellsByEvent 一致）。
 * 归列：按 cellKey(track.playerId, track.actionId)（track.actionId 即 trackGroup id）。
 * 绿/蓝/斜纹优先级在 TableDataRow 渲染层处理（绿 > 蓝 > 斜纹），本函数不做区间相减。
 *
 * @returns Map<damageEventId, Set<cellKey>>
 */
export function computeShadowCellsByEvent(
  damageEvents: DamageEvent[],
  skillTracks: SkillTrack[],
  shadowIntervalsForTrack: (track: SkillTrack) => Interval[]
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const event of damageEvents) result.set(event.id, new Set<string>())

  for (const track of skillTracks) {
    const intervals = shadowIntervalsForTrack(track)
    if (intervals.length === 0) continue
    const key = cellKey(track.playerId, track.actionId)
    for (const event of damageEvents) {
      if (intervals.some(iv => iv.from <= event.time && event.time < iv.to)) {
        result.get(event.id)!.add(key)
      }
    }
  }
  return result
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:run src/utils/castWindow.test.ts`
Expected: PASS（新 describe 全绿，原有用例不受影响）。

- [ ] **Step 5: 类型检查 + lint**

Run（PowerShell）: `pnpm exec tsc --noEmit; if ($?) { pnpm lint }`
Expected: 无错误。

- [ ] **Step 6: Commit**

提交规范：信息/作者**禁止**含 "Claude"，**禁止** Co-Authored-By。

```bash
git add src/utils/castWindow.ts src/utils/castWindow.test.ts
git commit -m "feat(table): add computeShadowCellsByEvent for placement-forbidden cells"
```

---

## Task 2: `TableDataRow` 渲染斜纹层 + `index.tsx` 接线（一起做一起 commit）

两处紧耦合（TableDataRow 加必填 prop 会让 index.tsx 编译失败），合并一个任务。

**Files:**

- Modify: `src/components/TimelineTable/TableDataRow.tsx`
- Modify: `src/components/TimelineTable/index.tsx`

### TableDataRow.tsx

- [ ] **Step 1: 接口加 `shadowCells`**

在 `TableDataRowProps` 接口中，`cdCells: Set<string>` 那一行之后新增：

```ts
/** 处于斜纹"不可放置"阴影的单元格（优先级最低：绿 > 蓝 > 斜纹，仅编辑模式非空） */
shadowCells: Set<string>
```

- [ ] **Step 2: 解构参数加 `shadowCells`**

在函数解构参数里，`cdCells,` 之后新增一行：

```ts
  shadowCells,
```

- [ ] **Step 3: 渲染斜纹层**

在技能列 `<td>` 内，找到蓝底那一行：

```tsx
{
  !isLit && cdCells.has(key) && (
    <div className="pointer-events-none absolute inset-0 bg-blue-500/15" />
  )
}
```

在其紧后新增（绿 > 蓝 > 斜纹）：

```tsx
{
  !isLit && !cdCells.has(key) && shadowCells.has(key) && (
    <div className="pointer-events-none absolute inset-0 [background-image:repeating-linear-gradient(45deg,transparent,transparent_5px,rgba(120,120,120,0.22)_5px,rgba(120,120,120,0.22)_7px)] dark:[background-image:repeating-linear-gradient(45deg,transparent,transparent_5px,rgba(160,160,160,0.25)_5px,rgba(160,160,160,0.25)_7px)]" />
  )
}
```

### index.tsx

- [ ] **Step 4: import**

找到（Task 1 之后此 import 应已含 `computeCdCellsByEvent`）：

```ts
import {
  computeCastMarkerCells,
  computeCdCellsByEvent,
  computeLitCellsByEvent,
} from '@/utils/castWindow'
```

改为加入 `computeShadowCellsByEvent`：

```ts
import {
  computeCastMarkerCells,
  computeCdCellsByEvent,
  computeLitCellsByEvent,
  computeShadowCellsByEvent,
} from '@/utils/castWindow'
```

并确认 `effectiveTrackGroup` 已可用——在文件 import 区新增（若尚未导入）：

```ts
import { effectiveTrackGroup } from '@/types/mitigation'
```

- [ ] **Step 5: 新增 `shadowCellsByEvent` useMemo**

在 `cdCellsByEvent` 的 useMemo 块之后新增。回调封装 Canvas 分支逻辑：

```ts
const shadowCellsByEvent = useMemo(() => {
  if (!timeline || !engine || isReadOnly) return new Map<string, Set<string>>()
  const eng = engine
  const shadowIntervalsForTrack = (track: SkillTrack) => {
    const parent = actionsById.get(track.actionId)
    if (!parent) return []
    // cd<=3 且无 placement：纯 CD 冲突窗口对 GCD 级技能是噪音，不画
    if (parent.cooldown <= 3 && !parent.placement) return []
    const groupId = effectiveTrackGroup(parent)
    // cd<=3 有 placement：只画 placement 非法区；否则完整 track 阴影（含前向 CD 提示）
    return parent.cooldown <= 3
      ? eng.computePlacementShadow(groupId, track.playerId)
      : eng.computeTrackShadow(groupId, track.playerId)
  }
  return computeShadowCellsByEvent(filteredDamageEvents, skillTracks, shadowIntervalsForTrack)
}, [timeline, engine, isReadOnly, filteredDamageEvents, skillTracks, actionsById])
```

> `SkillTrack` 类型在文件顶部应已 `import type { SkillTrack } from '@/utils/skillTracks'`（已存在，因 `handleCellToggle` 用了 `track: SkillTrack`）。`const eng = engine` 是为在闭包内让 TS 确认非 null。

- [ ] **Step 6: 给 `<TableDataRow>` 传 `shadowCells`**

找到这一行（Task 1 阶段已加的 cdCells 传参）：

```tsx
                  cdCells={cdCellsByEvent.get(row.id) ?? new Set()}
```

紧后新增：

```tsx
                  shadowCells={shadowCellsByEvent.get(row.id) ?? new Set()}
```

- [ ] **Step 7: 类型检查 + lint**

Run（PowerShell）: `pnpm exec tsc --noEmit; if ($?) { pnpm lint }`
Expected: 无错误。

- [ ] **Step 8: 构建兜底 + 全量测试**

Run（PowerShell）: `pnpm build; if ($?) { pnpm test:run }`
Expected: 构建成功；全量测试通过。

- [ ] **Step 9: Commit**

```bash
git add src/components/TimelineTable/TableDataRow.tsx src/components/TimelineTable/index.tsx
git commit -m "feat(table): render diagonal-stripe placement-forbidden shadow in edit mode"
```

---

## Task 3: 手动验证（人工检查点）

无代码改动。完成后由用户确认：

- [ ] **Step 1:** 编辑模式（local/author）下打开表格视图，找一个长 CD 减伤列，确认其「绿/蓝之外的不可放置区」出现灰色斜纹；绿格、蓝格上不叠斜纹（绿 > 蓝 > 斜纹）。
- [ ] **Step 2:** 对照时间轴同一技能的斜纹阴影区间，确认表格斜纹覆盖的行与之一致。
- [ ] **Step 3:** GCD 级（cooldown<=3 且无 placement）技能列确认**不画**斜纹。
- [ ] **Step 4:** view（只读）模式确认**不显示**斜纹。

---

## Self-Review 记录

- **Spec 覆盖**：逐轨数据源 + 分支(Task 2 回调)、离散映射(Task 1)、绿>蓝>斜纹优先级(Task 2)、斜纹样式(Task 2)、仅编辑模式门控(Task 2 useMemo guard)、6 类测试(Task 1)、手动验证(Task 3) —— 全覆盖。非目标（不做 subtractIntervals、不支持拖拽态、不改 Canvas）均未引入。
- **占位符**：无 TBD/TODO，代码步骤均含完整代码。
- **类型一致**：`computeShadowCellsByEvent(damageEvents, skillTracks, shadowIntervalsForTrack)` 在 Task 1 定义、Task 2 调用一致；prop `shadowCells: Set<string>` Task 2 定义与传入一致；回调返回 `Interval[]`，`engine.computeTrackShadow/computePlacementShadow` 返回 `Interval[]`，一致。
