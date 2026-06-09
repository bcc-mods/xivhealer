# 变体运行时派生(阶段 1)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把减伤技能的"变身/变体"从「持久化 actionId + 后台 effect 维护」改为「持久化逻辑技能(父 id)+ simulate 运行时推导」,从根上消除多端对冲与墓碑累积。

**Architecture:** `castEvent.actionId` 只存 trackGroup 父 id;读取入口统一归一;`mitigationCalculator.simulate` 按时间顺序处理 cast 时,用「截至该时刻已 active 的 buff」推导具体变体、执行对应 executor,并输出 `castId → resolvedActionId` 映射;渲染/导出读该映射,自身不推导;删除 `EditorPage` 的自动重映射 effect 及各写入点的变体持久化。

**Tech Stack:** React 19 + TS 5.9,Vitest 4(`*.test.ts` 同目录),Zustand,Yjs,pnpm。测试命令 `pnpm test:run <pattern>`;类型 `pnpm exec tsc --noEmit`;lint `pnpm lint`。

参考设计:`design/superpowers/specs/2026-06-09-variant-runtime-derivation-design.md`

---

## 关键既有事实(实现前必读)

- `CastEvent`(`src/types/timeline.ts:235-244`):`{ id, actionId, timestamp, playerId }`。
- `effectiveTrackGroup(action)`(`src/types/mitigation.ts:146`):返回 `action.trackGroup ?? action.id`。子变体的 `trackGroup` 指向父 id。
- placement combinator(`src/utils/placement/combinators.ts`):`whileStatus(id)` / `not(rule)` / `anyOf(...)`,只读 `ctx.statusTimelineByPlayer`(`Map<playerId, Map<statusId, StatusInterval[]>>`),`whileStatus` 过滤 `si.sourcePlayerId === ctx.playerId`。
- `PlacementContext`(`src/utils/placement/types.ts:30-39`):`{ action, playerId, castEvent?, castEvents, actions, statusTimelineByPlayer }`。
- `StatusInterval`(`src/types/status.ts:264-271`):`{ from, to, stacks, sourcePlayerId, sourceCastEventId }`。
- `MitigationStatus`(`src/types/status.ts:60+`):有 `statusId`、`sourcePlayerId?`、`stack?`;`PartyState.statuses` 是统一列表(`src/types/partyState.ts:59`)。
- simulate 主循环(`src/utils/mitigationCalculator.ts:784-807` 的 `processCast`):处理 cast 时 `currentState`(PartyState)即「截至该时刻的状态」;return 在 `955-961`,含 `statusTimelineByPlayer`、`castEffectiveEndByCastEventId`。
- 透出层:`DamageCalculationResult`(`src/hooks/useDamageCalculation.ts:23`)有 `castEffectiveEndByCastEventId: Map<string, number>`;`DamageCalculationContext.ts` 提供 hooks。`resolvedVariantByCastId: Map<string, number>` 与之同构,**照搬其所有出现处**新增平行字段。

---

## Task 1: `normalizeActionId` 归一工具

**Files:**

- Create: `src/utils/normalizeActionId.ts`
- Test: `src/utils/normalizeActionId.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/utils/normalizeActionId.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeActionId } from './normalizeActionId'

describe('normalizeActionId', () => {
  it('子变体 id 归一为父 trackGroup id', () => {
    // 37016 降临之章 trackGroup:37013 意气轩昂之策
    expect(normalizeActionId(37016)).toBe(37013)
  })
  it('父 id 原样返回', () => {
    expect(normalizeActionId(37013)).toBe(37013)
  })
  it('未知 id 原样返回(不在注册表)', () => {
    expect(normalizeActionId(999999)).toBe(999999)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run normalizeActionId`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
// src/utils/normalizeActionId.ts
import { MITIGATION_DATA } from '@/data/mitigationActions'
import { effectiveTrackGroup } from '@/types/mitigation'

const PARENT_BY_ID = new Map<number, number>(
  MITIGATION_DATA.actions.map(a => [a.id, effectiveTrackGroup(a)])
)

/** 把(可能是子变体的)actionId 归一为 trackGroup 父 id;未知 id 原样返回。 */
export function normalizeActionId(actionId: number): number {
  return PARENT_BY_ID.get(actionId) ?? actionId
}
```

> 注:`MITIGATION_DATA` 的实际导出名/路径以 `src/data/mitigationActions.ts` 为准(搜 `export const MITIGATION_DATA`);若 actions 不在 `.actions` 字段,按实际结构取。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:run normalizeActionId`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/normalizeActionId.ts src/utils/normalizeActionId.test.ts
git commit -m "feat(variant): add normalizeActionId helper for trackGroup parent id"
```

---

## Task 2: `resolveVariant` 纯函数(变体推导)

**Files:**

- Create: `src/utils/placement/resolveVariant.ts`
- Test: `src/utils/placement/resolveVariant.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/utils/placement/resolveVariant.test.ts
import { describe, it, expect } from 'vitest'
import { resolveVariant } from './resolveVariant'
import { MITIGATION_DATA } from '@/data/mitigationActions'
import type { MitigationStatus } from '@/types/status'

const byId = new Map(MITIGATION_DATA.actions.map(a => [a.id, a]))
const parent = byId.get(37013)! // 意气轩昂之策(无 Seraphism 合法)
const members = MITIGATION_DATA.actions.filter(a => (a.trackGroup ?? a.id) === 37013)
const SERAPHISM = 3885 // 炽天附体 buff id(见 mitigationActions.ts SERAPHISM_BUFF_ID)

function status(statusId: number, playerId: number): MitigationStatus {
  return { instanceId: 'x', statusId, startTime: 0, endTime: 999, sourcePlayerId: playerId }
}

describe('resolveVariant', () => {
  it('无 Seraphism → 意气轩昂之策(37013)', () => {
    expect(resolveVariant(parent, members, 6, 100, []).id).toBe(37013)
  })
  it('Seraphism 在场 → 降临之章(37016)', () => {
    expect(resolveVariant(parent, members, 6, 100, [status(SERAPHISM, 6)]).id).toBe(37016)
  })
  it('Seraphism 属于别的玩家 → 仍是 37013(只看自己的 buff)', () => {
    expect(resolveVariant(parent, members, 6, 100, [status(SERAPHISM, 7)]).id).toBe(37013)
  })
  it('单成员组直接返回父', () => {
    const solo = byId.get(37014)! // 炽天附体,无同组变体
    expect(resolveVariant(solo, [solo], 6, 100, []).id).toBe(37014)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test:run resolveVariant`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
// src/utils/placement/resolveVariant.ts
import type { MitigationAction } from '@/types/mitigation'
import type { MitigationStatus, StatusInterval } from '@/types/status'
import type { PlacementContext } from './types'

/**
 * 按「截至 t 时刻、该玩家自身 active 的 buff」推导 trackGroup 内应使用的变体。
 *
 * 复用各 action 的 placement 规则(whileStatus / not 等),把当前 active statuses
 * 表达成一个覆盖全轴的「点 timeline」喂给 placement.validIntervals 判定。
 * 恰好一个合法成员时返回它;0 或 ≥2 个(歧义/非法)时 fallback 回父 action。
 * 因果性:变体只依赖之前别的 cast 产生的 buff,故 simulate 顺序处理时无循环。
 */
export function resolveVariant(
  parent: MitigationAction,
  members: MitigationAction[],
  playerId: number,
  t: number,
  activeStatuses: MitigationStatus[]
): MitigationAction {
  if (members.length < 2) return parent

  // 点 timeline:玩家自己施放的每个 active status → 一条覆盖全轴的区间
  const byStatus = new Map<number, StatusInterval[]>()
  for (const s of activeStatuses) {
    if (s.sourcePlayerId !== playerId) continue
    const arr = byStatus.get(s.statusId) ?? []
    arr.push({
      from: Number.NEGATIVE_INFINITY,
      to: Number.POSITIVE_INFINITY,
      stacks: s.stack ?? 1,
      sourcePlayerId: playerId,
      sourceCastEventId: '',
    })
    byStatus.set(s.statusId, arr)
  }
  const statusTimelineByPlayer = new Map([[playerId, byStatus]])

  const legal = members.filter(m => {
    if (!m.placement) return true
    const ctx: PlacementContext = {
      action: m,
      playerId,
      castEvents: [],
      actions: new Map(),
      statusTimelineByPlayer,
    }
    return m.placement.validIntervals(ctx).some(i => i.from <= t && t <= i.to)
  })
  return legal.length === 1 ? legal[0] : parent
}
```

> 注:`PlacementContext` 的 `actions`/`castEvents` 在纯 status 条件(whileStatus/not/anyOf)下不被读取,传空安全。若 tsc 报 `PlacementContext` 还有其它必填字段,按 `src/utils/placement/types.ts:30-39` 补齐空值。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test:run resolveVariant`
Expected: PASS(4 个用例)

- [ ] **Step 5: 提交**

```bash
git add src/utils/placement/resolveVariant.ts src/utils/placement/resolveVariant.test.ts
git commit -m "feat(variant): add resolveVariant pure derivation from active buffs"
```

---

## Task 3: simulate 集成 — processCast 推导变体 + 输出映射

**Files:**

- Modify: `src/utils/mitigationCalculator.ts`(`processCast` ~784-807;simulate 内新增 map;return ~955-961)
- Test: `src/utils/mitigationCalculator.test.ts`(新增用例)

- [ ] **Step 1: 写失败测试**

在 `src/utils/mitigationCalculator.test.ts` 末尾(`describe` 内)新增。先按现有测试的 simulate 调用样式构造:一个 playerId=6 的炽天附体(37014)cast 在 t=10(产生 Seraphism),一个**父 id 37013** 的 cast 在 t=20(Seraphism 期内,应推导成 37016),一个父 id 37013 的 cast 在 t=100(Seraphism 已过,应保持 37013)。

```ts
it('simulate 输出 resolvedVariantByCastId:Seraphism 期内 37013→37016', () => {
  // 按本文件现有 simulate 调用方式构造 input(参考同文件其它用例);
  // castEvents(playerId=6):
  //   { id:'c-buff', actionId:37014, timestamp:10, playerId:6 }   // 炽天附体
  //   { id:'c-in',   actionId:37013, timestamp:20, playerId:6 }   // 父 id,Seraphism 期内
  //   { id:'c-out',  actionId:37013, timestamp:100, playerId:6 }  // 父 id,Seraphism 期外
  // 至少一个 damage event 触发主循环推进到 t>100。
  const result = /* simulate(...) — 按现有用例签名 */ undefined as any
  expect(result.resolvedVariantByCastId.get('c-in')).toBe(37016)
  expect(result.resolvedVariantByCastId.get('c-out')).toBe(37013)
  expect(result.resolvedVariantByCastId.get('c-buff')).toBe(37014)
})
```

> 实现者:先读本文件已有 simulate 测试用例(搜 `simulate(`),复制其 input 构造样板填入上面三个 cast + 一个 damage event,使测试可运行。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test:run mitigationCalculator`
Expected: FAIL(`resolvedVariantByCastId` 为 undefined)

- [ ] **Step 3: 实现 — 在 simulate 内声明 map**

在 simulate 内、`processCast` 定义之前(`src/utils/mitigationCalculator.ts:783` 附近)加:

```ts
const resolvedVariantByCastId = new Map<string, number>()
// 预建 trackGroup 成员表:父 id → members
const variantMembers = new Map<number, MitigationAction[]>()
for (const a of MITIGATION_DATA.actions) {
  const gid = a.trackGroup ?? a.id
  const arr = variantMembers.get(gid) ?? []
  arr.push(a)
  variantMembers.set(gid, arr)
}
```

(顶部确保 `import { resolveVariant } from './placement/resolveVariant'` 与 `import type { MitigationAction } from '@/types/mitigation'` 已存在。)

- [ ] **Step 4: 实现 — processCast 内用推导变体**

把 `processCast`(784-807)中的 action 解析与 executor 调用改为先推导变体:

```ts
const processCast = (castEvent: CastEvent, advanceTarget: number) => {
  const parent = MITIGATION_DATA.actions.find(a => a.id === castEvent.actionId)
  if (!parent) return
  const prevState = currentState
  currentState = advanceToTime(currentState, lastAdvanceTime, advanceTarget)
  captureTransition(prevState, currentState, advanceTarget)
  lastAdvanceTime = advanceTarget

  // 用「截至此刻 active 的 buff」推导具体变体(单成员组返回父本身)
  const members = variantMembers.get(parent.id) ?? [parent]
  const action = resolveVariant(
    parent,
    members,
    castEvent.playerId,
    castEvent.timestamp,
    currentState.statuses
  )
  resolvedVariantByCastId.set(castEvent.id, action.id)

  if (!action.executor) return
  const before = currentState
  currentState = { ...currentState, timestamp: castEvent.timestamp }
  const ctx: ActionExecutionContext = {
    actionId: action.id,
    useTime: castEvent.timestamp,
    partyState: currentState,
    sourcePlayerId: castEvent.playerId,
    statistics,
    castEventId: castEvent.id,
    recordHeal,
  }
  currentState = action.executor(ctx)
  currentState = recomputeAndTrack(currentState, castEvent.timestamp)
  captureTransition(before, currentState, castEvent.timestamp, castEvent.id, castEvent.playerId)
}
```

(注意:`castEvent.actionId` 现在是父 id;`parent` 即父 action;`action` 是推导出的变体;`ctx.actionId` 用 `action.id`。)

- [ ] **Step 5: 实现 — return 带出映射**

simulate return(`955-961`)新增字段:

```ts
return {
  damageResults,
  statusTimelineByPlayer,
  castEffectiveEndByCastEventId,
  resolvedVariantByCastId,
  healSnapshots,
  hpTimeline,
}
```

同步更新该 simulate 函数的返回类型(搜其声明的返回 interface/type,把 `resolvedVariantByCastId: Map<string, number>` 加进去)。

- [ ] **Step 6: 运行确认通过**

Run: `pnpm test:run mitigationCalculator`
Expected: PASS(含新用例;其余原用例不回归)

- [ ] **Step 7: 提交**

```bash
git add src/utils/mitigationCalculator.ts src/utils/mitigationCalculator.test.ts
git commit -m "feat(variant): derive cast variant inside simulate, output resolvedVariantByCastId"
```

---

## Task 4: 透出层 — DamageCalculationResult + context hook

**Files:**

- Modify: `src/hooks/useDamageCalculation.ts`(类型 ~23;empty ~37;组装 ~124-125;realign ~157-166)
- Modify: `src/contexts/DamageCalculationContext.ts`(emptyContext + 新 hook)
- Test: `src/hooks/useDamageCalculation.test.ts`(若已有结构测试则补;否则跳过,靠 tsc + 下游 task 覆盖)

- [ ] **Step 1: 类型新增字段**

`src/hooks/useDamageCalculation.ts:23` 的 `DamageCalculationResult` 接口,在 `castEffectiveEndByCastEventId` 下加:

```ts
resolvedVariantByCastId: Map<string, number>
```

- [ ] **Step 2: empty 默认值**

同文件 `~37` 的空对象与 `DamageCalculationContext.ts` 的 `emptyContext` 各加:

```ts
  resolvedVariantByCastId: new Map(),
```

- [ ] **Step 3: 组装透传**

`useDamageCalculation.ts:124-125` 旁(与 `castEffectiveEndByCastEventId: bundle.main.castEffectiveEndByCastEventId` 平行)加:

```ts
            resolvedVariantByCastId: bundle.main.resolvedVariantByCastId,
```

`~157-166` 的 realign 块:`resolvedVariantByCastId` 按 castId 索引、与 timestamp 无关,**无需 realign**——确保 `return { ...result, castEffectiveEndByCastEventId: realigned }` 处 spread 保留了它(用 `...result` 已自动保留;若该处显式重建对象,记得带上)。

- [ ] **Step 4: 新增 hook**

`src/contexts/DamageCalculationContext.ts` 末尾加:

```ts
export function useResolvedVariantByCastId(): Map<string, number> {
  return useContext(DamageCalculationContext).resolvedVariantByCastId
}
```

- [ ] **Step 5: 验证类型**

Run: `pnpm exec tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 6: 提交**

```bash
git add src/hooks/useDamageCalculation.ts src/contexts/DamageCalculationContext.ts
git commit -m "feat(variant): expose resolvedVariantByCastId through damage calc context"
```

---

## Task 5: 读取归一 — projectTimeline / parseFromAny / 导入

**Files:**

- Modify: `src/collab/docSchema.ts`(`projectTimeline` ~278)
- Modify: `src/utils/timelineFormat.ts`(`parseFromAny`/V2 反序列化 cast 处 ~294,317)
- Modify: `src/utils/fflogsImporter.ts`(~625)
- Test: `src/collab/docSchema.test.ts` 或 `src/utils/timelineFormat.test.ts`(新增归一断言);`src/utils/fflogsImporter.test.ts`(改"保留 37016"用例)

- [ ] **Step 1: 写失败测试(timelineFormat 归一)**

在 `src/utils/timelineFormat.test.ts` 新增:

```ts
it('parseFromAny 把子变体 actionId 归一为父 id', () => {
  // 构造一个含 castEvent.actionId=37016 的 V2/V1 原始对象(按本文件现有测试样板),
  // parse 后该 cast 的 actionId 应为 37013。
  const parsed = /* parseFromAny(rawWith37016) */ undefined as any
  const cast = parsed.castEvents.find((c: any) => c.timestamp === /* 对应时刻 */ 0)
  expect(cast.actionId).toBe(37013)
})
```

> 实现者:复制本文件已有 parse 用例的原始对象样板,把某个 cast 的 actionId 设成 37016。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test:run timelineFormat`
Expected: FAIL(actionId 仍是 37016)

- [ ] **Step 3: 实现归一**

在三处 cast 进入内存的出口加 `normalizeActionId`:

- `src/utils/timelineFormat.ts:294`(`actionId: ce.a[i]` → `actionId: normalizeActionId(ce.a[i])`)和 `:317`(`actionId: e.a` → `actionId: normalizeActionId(e.a)`);文件顶部 `import { normalizeActionId } from './normalizeActionId'`。
- `src/collab/docSchema.ts` `projectTimeline` 的 castEvents 投影(~278-284):投影出的每个 cast 的 `actionId` 包一层 `normalizeActionId(...)`;顶部 import。
- `src/utils/fflogsImporter.ts:625`(`actionId: abilityGameID` → `actionId: normalizeActionId(abilityGameID)`);顶部 import。

- [ ] **Step 4: 改 fflogsImporter 那条"保留 37016"测试**

`src/utils/fflogsImporter.test.ts:278` 附近,把断言从"保留 37016 原始 abilityGameID"改为"归一为父 id 37013":

```ts
expect(castEvent.actionId).toBe(37013) // 归一为 trackGroup 父 id(变体运行时推导)
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test:run timelineFormat fflogsImporter docSchema`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/utils/timelineFormat.ts src/collab/docSchema.ts src/utils/fflogsImporter.ts src/utils/timelineFormat.test.ts src/utils/fflogsImporter.test.ts
git commit -m "feat(variant): normalize actionId to parent id at all read entries"
```

---

## Task 6: 写入点改写父 id(addCastAt / TimelineTable / 拖拽)

**Files:**

- Modify: `src/components/Timeline/index.tsx`(`addCastAt` ~929-955;`handleCastEventDragEnd` ~1104-1144)
- Modify: `src/components/TimelineTable/index.tsx`(`handleCellToggle` ~162-190)

> 设计要点:**保留** `pickUniqueMember` 的「该时刻是否有合法变体」校验(无则 toast 拒绝),但 `addCastEvent`/`updateCastEvent` 写入的 `actionId` 改为**父 id**(`groupId`),拖拽**不再写 actionId**。

- [ ] **Step 1: addCastAt 写父 id**

`src/components/Timeline/index.tsx` 的 `addCastAt`(~937-953):保留 `engine.pickUniqueMember` 的存在性校验,把最终 `addCastEvent` 的 `actionId` 由 `resolvedActionId` 改为 `groupId`:

```ts
const addCastAt = (actionId: number, playerId: number, time: number) => {
  if (!timeline) return
  const parent = actionMap.get(actionId)
  const groupId = parent ? (parent.trackGroup ?? parent.id) : actionId
  if (engine && parent) {
    const member = engine.pickUniqueMember(groupId, playerId, time)
    if (!member) {
      const unmetMsg = engine.getResourceUnmetMessageAt(parent, playerId, time)
      toast.error('无法添加技能', { description: unmetMsg ?? '此时刻不满足发动条件' })
      return
    }
  }
  addCastEvent({ id: generateObjectId(), actionId: groupId, timestamp: time, playerId })
}
```

- [ ] **Step 2: TimelineTable 写父 id**

`src/components/TimelineTable/index.tsx` `handleCellToggle`(~162-188):同理,校验保留,`addCastEvent` 的 `actionId` 改为 `groupId`:

```ts
if (engine) {
  const member = engine.pickUniqueMember(groupId, track.playerId, event.time)
  if (!member) {
    const unmetMsg = engine.getResourceUnmetMessageAt(parent, track.playerId, event.time)
    toast.error('无法添加技能', { description: unmetMsg ?? '此时刻不满足发动条件' })
    return
  }
}
addCastEvent({
  id: generateObjectId(),
  actionId: groupId,
  timestamp: event.time - CAST_ANCHOR_LEAD,
  playerId: track.playerId,
})
```

(`groupId` 在该函数上文已计算 `const groupId = parent.trackGroup ?? parent.id`,确认其在作用域内;若没有则按 `parent` 计算。)

- [ ] **Step 3: 拖拽不写 actionId**

`src/components/Timeline/index.tsx` `handleCastEventDragEnd`(~1117-1140):移除变体重选,只写 timestamp。保留对"新位置可放置性"的校验(无合法变体则不阻塞拖拽,沿用红框提示——即可直接简化为只更新时间):

```ts
// 变体由 simulate 运行时推导,拖拽只改时间;新位置若无合法变体由红框提示
if (totalSelected > 1 && s.selectedCastEventIds.includes(castEventId)) {
  const orig = timeline?.castEvents.find(c => c.id === castEventId)?.timestamp ?? newTime
  s.bulkMoveSelection(newTime - orig)
} else {
  updateCastEvent(castEventId, { timestamp: newTime })
}
```

(删除 `currentAction`/`nextActionId`/`pickUniqueMember` 那段 1117-1131;`existing` 若仅用于此可一并清理,保留 `if (!existing) return` 守卫。)

- [ ] **Step 4: 类型 + lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 无新增错误(未用变量已清理)

- [ ] **Step 5: 提交**

```bash
git add src/components/Timeline/index.tsx src/components/TimelineTable/index.tsx
git commit -m "feat(variant): write parent id at cast creation/drag, drop variant persistence"
```

---

## Task 7: 删除 EditorPage 自动重映射 effect(对冲源)

**Files:**

- Modify: `src/pages/EditorPage.tsx`(删除 ~272-297 的 useEffect)

- [ ] **Step 1: 删除 effect**

删除 `src/pages/EditorPage.tsx:272-297` 整个 `useEffect(() => { ... createPlacementEngine ... updateCastEvent(ce.id, { actionId: member.id }) ... }, [...])`。

清理因此不再使用的 import(若 `createPlacementEngine`/`mitigationActions` 仅此处用,删除其 import;tsc/lint 会指出)。

- [ ] **Step 2: 类型 + lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 无未使用变量/未用 import 报错

- [ ] **Step 3: 提交**

```bash
git add src/pages/EditorPage.tsx
git commit -m "fix(variant): remove auto-remap effect that caused multi-client actionId thrash"
```

---

## Task 8: 消费点改读 resolvedVariantByCastId(渲染图标 + 导出)

**Files:**

- Modify: `src/components/Timeline/SkillTracksCanvas.tsx`(~569 图标/duration 用变体)
- Modify: `src/components/Timeline/CastEventIcon.tsx`(~243,303-305 displayAction)
- Modify: `src/utils/castWindow.ts`(~99 变体图标 map)
- Modify: `src/utils/soumaExporter.ts`(~67-69 变体名)

> 统一改法:凡是「为了显示/导出**具体变体**而用 `castEvent.actionId` 查 action」的地方,改为先取 `resolvedVariantByCastId.get(castEvent.id) ?? castEvent.actionId` 作为变体 id 再查。**归轨/分组(用 `trackGroup ?? id`)不动。**

- [ ] **Step 1: 渲染层接入映射**

渲染组件通过 `useResolvedVariantByCastId()`(Task 4 新增 hook)拿到 `Map<string, number>`,在渲染每个 cast 的图标/悬浮窗/duration 时:

```ts
const resolvedVariant = useResolvedVariantByCastId()
// ...
const variantId = resolvedVariant.get(castEvent.id) ?? castEvent.actionId
const displayAction = actions.find(a => a.id === variantId) // 替换原先按 castEvent.actionId 查
```

按上面四个文件各自的现状(explorer 标注的行号)把「按 `actionId` 查变体 action 用于显示」替换为按 `variantId` 查。`castWindow.ts` 的 `map.set(key, castEvent.actionId)`(~99)改为存 `variantId`。`soumaExporter.ts`(~67-69)把变体名从父 action 名改为按 `variantId` 取(soumaExporter 非 React,需由调用方把 `resolvedVariantByCastId` 作为参数传入——在其签名加一个 `resolvedVariantByCastId: Map<string, number>` 参数,调用处从 context 传)。

- [ ] **Step 2: 验证(手动 + 类型)**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 无错误。
手动:`pnpm dev` 打开一个含炽天附体 + 父 id 37013 cast 的时间轴,Seraphism 期内该 cast 图标显示为降临之章(37016),期外为意气轩昂之策(37013)。

- [ ] **Step 3: 提交**

```bash
git add src/components/Timeline/SkillTracksCanvas.tsx src/components/Timeline/CastEventIcon.tsx src/utils/castWindow.ts src/utils/soumaExporter.ts
git commit -m "feat(variant): render/export resolved variant via resolvedVariantByCastId"
```

---

## Task 9: 全量验证

- [ ] **Step 1: 全量测试**

Run: `pnpm test:run`
Expected: 全绿(特别确认 mitigationCalculator / timelineFormat / fflogsImporter / resolveVariant / normalizeActionId)

- [ ] **Step 2: 类型 + lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 0 error

- [ ] **Step 3: 构建**

Run: `pnpm build`
Expected: 成功

- [ ] **Step 4: 回归确认(无变体写入)**

手动:`pnpm dev`,打开一个 player=6 含多个炽天附体期内/外的 37013/37016 cast 的时间轴,编辑一阵子;确认不再产生 actionId 单字段 update(可用 `scripts/inspect-ydoc.cjs` 对导出的 snapshot 跑 `cast` 子命令,actionId 写入次数应≈cast 数,无横跳)。

- [ ] **Step 5: 提交(若有收尾改动)**

```bash
git add -A && git commit -m "test(variant): full verification for runtime variant derivation"
```

---

## 自检覆盖对照(spec → task)

- spec ① 数据模型/归一 → Task 1, 5, 6
- spec ② simulate 单点推导 → Task 2, 3
- spec ③ 消费者读映射 → Task 4(透出), 8
- spec ④ 删对冲源 → Task 6, 7
- spec ⑥ 测试 → 各 task 内 TDD + Task 9

> 阶段 2(rebuild compaction 清存量)单独出 plan,不在本计划内。

## 风险与备注

- **拖拽即时反馈**:拖完到计算回来前,图标按父 id(或上一帧映射)显示,可能一帧延迟;若手感不可接受,在渲染层用 context 现有 `statusTimelineByPlayer` 做一次本地快速推导兜底(打磨项,本计划不含)。
- **resolveVariant 与 engine.pickUniqueMember 的差异**:resolveVariant 只判 placement(status 条件),不判 resource;变体互斥本就由 status 决定,符合预期。engine 的 `pickUniqueMember` 仍保留供写入点的可放置性校验复用。
- **存量**:旧文档里持久化的子变体 id 由 Task 5 的读取归一自动兼容;真正清掉历史墓碑需阶段 2 rebuild。
