# 临时减伤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在伤害详情面板「预估减伤效果」下方新增「临时减伤」section，编辑模式下可为单个伤害事件临时附加盾/百分比减伤，参与该事件的减伤计算并随时间轴持久化。

**Architecture:** 临时减伤作为 `DamageEvent.tempMitigations` 数组挂在事件上；计算在 `MitigationCalculator.runSingleBranch` 内统一折入（百分比乘进 multiplier、盾从 finalDamage 减），复用已有 `candidateDamage` 字段供减伤构成色块切分，不新增计算语义字段；UI 抽成独立组件 `TempMitigationSection`；持久化经现有 Yjs 通用存储 + V2 格式新增 `tm` 字段。

**Tech Stack:** React 19 + TypeScript、Zustand、Vitest 4、shadcn/ui（Dialog/Input/Select）、nanoid、Yjs。

设计文档：`design/superpowers/specs/2026-05-31-temp-mitigation-design.md`

---

### Task 1: 数据模型

**Files:**

- Modify: `src/types/timeline.ts`（在 `DamageEvent` 定义附近）

- [ ] **Step 1: 新增类型与字段**

在 `src/types/timeline.ts` 中，`DamageEvent` 接口**之前**新增类型定义：

```ts
/**
 * 临时减伤类型
 */
export type TempMitigationType = 'percent' | 'shield'

/**
 * 临时减伤（仅对所挂伤害事件生效，不进 PartyState、不作为 buff）
 */
export interface TempMitigation {
  /** 列表项 id（nanoid），用于 React key 与删除定位 */
  id: string
  /** 减伤名称（用户填写） */
  name: string
  /** 减伤类型 */
  type: TempMitigationType
  /**
   * 减伤效果：
   * - type='percent'：百分比数值，范围 0–100（如 20 表示 20%）
   * - type='shield'：盾量（吸收的绝对伤害值，整数 ≥ 0）
   */
  value: number
}
```

在 `DamageEvent` 接口内（`snapshotTime?` 字段之后）新增：

```ts
  /** 临时减伤列表（仅对本事件生效）；存量事件无此字段 */
  tempMitigations?: TempMitigation[]
```

- [ ] **Step 2: 类型检查通过**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误（纯类型新增，不破坏既有代码）。

- [ ] **Step 3: Commit**

```bash
git add src/types/timeline.ts
git commit -m "feat(timeline): add TempMitigation type and DamageEvent.tempMitigations"
```

---

### Task 2: 计算器 — 临时百分比减伤

**Files:**

- Modify: `src/utils/mitigationCalculator.ts`（`runSingleBranch` Phase 1 区域）
- Test: `src/utils/mitigationCalculator.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/utils/mitigationCalculator.test.ts` 末尾的 `describe('MitigationCalculator', () => { ... })` 内部新增一个 describe 块（紧邻其它 describe）：

```ts
describe('临时减伤', () => {
  it('临时百分比减伤乘算折入最终伤害', () => {
    const event: DamageEvent = {
      ...makeEvent(100000, 10, 'magical', 'aoe'),
      tempMitigations: [{ id: 'tm1', name: '临时20%', type: 'percent', value: 20 }],
    }
    const result = calculator.calculate(event, basePartyState)
    expect(result.finalDamage).toBe(80000)
    expect(result.candidateDamage).toBe(80000)
    // 临时减伤不进 appliedStatuses（有独立 section 展示）
    expect(result.appliedStatuses).toHaveLength(0)
  })

  it('临时百分比与真实百分比减伤叠乘', () => {
    const partyState: PartyState = {
      ...basePartyState,
      players: [{ id: 1, job: 'WHM', maxHP: 100000 }],
      statuses: [
        {
          instanceId: 'temperance',
          statusId: 1873,
          startTime: 0,
          endTime: 25,
          sourcePlayerId: 2,
        },
      ],
    }
    const event: DamageEvent = {
      ...makeEvent(100000, 10, 'magical', 'aoe'),
      tempMitigations: [{ id: 'tm1', name: '临时20%', type: 'percent', value: 20 }],
    }
    // 真实 10%（节制）× 临时 20% = 100000 * 0.9 * 0.8 = 72000
    const result = calculator.calculate(event, partyState)
    expect(result.finalDamage).toBe(72000)
    expect(result.appliedStatuses).toHaveLength(1) // 只有真实状态进 appliedStatuses
  })

  it('临时百分比 value 被 clamp 到 0–100', () => {
    const event: DamageEvent = {
      ...makeEvent(100000, 10, 'magical', 'aoe'),
      tempMitigations: [{ id: 'tm1', name: '超界', type: 'percent', value: 150 }],
    }
    const result = calculator.calculate(event, basePartyState)
    // clamp 到 100% → 全免
    expect(result.finalDamage).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run mitigationCalculator -t "临时百分比"`
Expected: FAIL（`finalDamage` 仍为 100000，临时减伤未生效）。

- [ ] **Step 3: 实现 — Phase 1 折入临时百分比**

在 `src/utils/mitigationCalculator.ts` 的 `runSingleBranch` 中，找到 Phase 1 循环结束后、`const candidateDamage = Math.round(originalDamage * multiplier)` **之前**，插入：

```ts
// 临时百分比减伤（仅本事件）：乘算折入 multiplier，不进 appliedStatuses（有独立 section 展示）
for (const tm of event.tempMitigations ?? []) {
  if (tm.type === 'percent') {
    const pct = Math.min(100, Math.max(0, tm.value))
    multiplier *= 1 - pct / 100
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:run mitigationCalculator -t "临时"`
Expected: PASS（三个临时百分比相关用例全过）。

- [ ] **Step 5: Commit**

```bash
git add src/utils/mitigationCalculator.ts src/utils/mitigationCalculator.test.ts
git commit -m "feat(calculator): apply temp percent mitigation in runSingleBranch"
```

---

### Task 3: 计算器 — 临时盾减伤

**Files:**

- Modify: `src/utils/mitigationCalculator.ts`（`runSingleBranch` Phase 3 之后）
- Test: `src/utils/mitigationCalculator.test.ts`

- [ ] **Step 1: 写失败测试**

在 Task 2 新增的 `describe('临时减伤', ...)` 内追加：

```ts
    it('临时盾在百分比减伤后减算', () => {
      const event: DamageEvent = {
        ...makeEvent(100000, 10, 'magical', 'aoe'),
        tempMitigations: [{ id: 'tm1', name: '临时盾', type: 'shield', value: 30000 }],
      }
      const result = calculator.calculate(event, basePartyState)
      expect(result.finalDamage).toBe(70000)
      // candidateDamage 是盾前伤害，不含临时盾
      expect(result.candidateDamage).toBe(100000)
      expect(result.appliedStatuses).toHaveLength(0)
    })

    it('临时百分比 + 临时盾组合：先乘后减', () => {
      const event: DamageEvent = {
        ...makeEvent(100000, 10, 'magical', 'aoe'),
        tempMitigations: [
          { id: 'tm1', name: '临时20%', type: 'percent', value: 20 },
          { id: 'tm2', name: '临时盾', type: 'shield', value: 30000 },
        ],
      }
      // candidateDamage = 100000*0.8 = 80000；finalDamage = 80000-30000 = 50000
      const result = calculator.calculate(event, basePartyState)
      expect(result.candidateDamage).toBe(80000)
      expect(result.finalDamage).toBe(50000)
      // candidateDamage - finalDamage = 30000 = 临时盾吸收量（供色块归类）
      expect(result.candidateDamage! - result.finalDamage).toBe(30000)
    })

    it('临时盾超过剩余伤害时 finalDamage 夹 0 不为负', () => {
      const event: DamageEvent = {
        ...makeEvent(20000, 10, 'magical', 'aoe'),
        tempMitigations: [{ id: 'tm1', name: '大盾', type: 'shield', value: 50000 }],
      }
      const result = calculator.calculate(event, basePartyState)
      expect(result.finalDamage).toBe(0)
    })
  })
```

> 注意：上面闭合了 `describe('临时减伤')` 的 `})`，确保 Task 2 中该 describe 的结尾 `})` 被本 Step 的内容替换/合并——实现时把 Task 2 的三个用例与这里三个用例放进**同一个** `describe('临时减伤', () => { ... })`，只保留一个结尾 `})`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run mitigationCalculator -t "临时盾"`
Expected: FAIL（盾未减，finalDamage 仍为 candidateDamage）。

- [ ] **Step 3: 实现 — Phase 3 之后减临时盾**

在 `src/utils/mitigationCalculator.ts` 的 `runSingleBranch` 中找到这一行（Phase 3 阶段 A 之后）：

```ts
const damage = playerDamage
```

替换为：

```ts
let damage = playerDamage

// 临时盾减伤（仅本事件）：真实盾扣完后再扣，不动任何真实 status 的 remainingBarrier，
// 不触发 onConsume、不进 appliedStatuses（有独立 section 展示）。candidateDamage 不变，
// 故 candidateDamage − finalDamage 自然包含临时盾吸收量，供色块归类。
const tempShieldTotal = (event.tempMitigations ?? [])
  .filter(tm => tm.type === 'shield')
  .reduce((sum, tm) => sum + Math.max(0, tm.value), 0)
if (tempShieldTotal > 0) {
  damage = Math.max(0, damage - tempShieldTotal)
}
```

> `partial_final_aoe` 阶段 B 的逻辑使用 `candidateDamage` 与真实 `shieldStatuses`，不读 `damage`，因此不受影响。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:run mitigationCalculator -t "临时"`
Expected: PASS（六个临时减伤用例全过）。

- [ ] **Step 5: Commit**

```bash
git add src/utils/mitigationCalculator.ts src/utils/mitigationCalculator.test.ts
git commit -m "feat(calculator): subtract temp shield after percent and real shields"
```

---

### Task 4: 多坦分支带出 candidateDamage

**Files:**

- Modify: `src/utils/mitigationCalculator.ts`（`PerTankResult` 接口 + 多坦 map）
- Test: `src/utils/mitigationCalculator.test.ts`

- [ ] **Step 1: 写失败测试**

在 `describe('临时减伤', ...)` 内追加（在结尾 `})` 之前）：

```ts
it('多坦分支结果各自带出 candidateDamage', () => {
  const partyState: PartyState = {
    ...basePartyState,
    players: [
      { id: 1, job: 'PLD', maxHP: 100000 },
      { id: 2, job: 'WAR', maxHP: 100000 },
    ],
    statuses: [],
  }
  const event: DamageEvent = {
    ...makeEvent(100000, 10, 'physical', 'tankbuster'),
    tempMitigations: [{ id: 'tm1', name: '临时20%', type: 'percent', value: 20 }],
  }
  const result = calculator.calculate(event, partyState, {
    tankPlayerIds: [1, 2],
    baseReferenceMaxHP: 100000,
  })
  expect(result.perVictim).toBeDefined()
  expect(result.perVictim).toHaveLength(2)
  for (const v of result.perVictim!) {
    expect(v.candidateDamage).toBe(80000)
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run mitigationCalculator -t "多坦分支结果各自带出"`
Expected: FAIL（`v.candidateDamage` 为 `undefined`，类型上也不存在 → 测试报错或断言失败）。

- [ ] **Step 3: 实现 — PerTankResult 加字段并在 map 中带出**

在 `src/utils/mitigationCalculator.ts` 的 `PerTankResult` 接口（含 `referenceMaxHP: number` 的那个）内追加：

```ts
/** 盾前伤害（含临时百分比、不含临时盾）；供减伤构成色块切分盾/百分比 */
candidateDamage: number
```

然后找到多坦路径构造 `perVictim` 的 `.map`（当前结构为）：

```ts
const perVictim: PerTankResult[] = perVictimRaw.map(
  ({ playerId, finalDamage, mitigationPercentage, appliedStatuses, referenceMaxHP }) => ({
    playerId,
    finalDamage,
    mitigationPercentage,
    appliedStatuses,
    referenceMaxHP,
  })
)
```

替换为（把 `candidateDamage` 一并解构带出）：

```ts
const perVictim: PerTankResult[] = perVictimRaw.map(
  ({
    playerId,
    finalDamage,
    mitigationPercentage,
    appliedStatuses,
    referenceMaxHP,
    candidateDamage,
  }) => ({
    playerId,
    finalDamage,
    mitigationPercentage,
    appliedStatuses,
    referenceMaxHP,
    candidateDamage,
  })
)
```

> `perVictimRaw` 的元素已经包含 `candidateDamage`（见其上方 `.map` 中的 `candidateDamage: branch.candidateDamage`），此处仅把它透出到 `PerTankResult`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:run mitigationCalculator`
Expected: PASS（全部计算器测试，含新增临时减伤用例）。

- [ ] **Step 5: Commit**

```bash
git add src/utils/mitigationCalculator.ts src/utils/mitigationCalculator.test.ts
git commit -m "feat(calculator): expose candidateDamage on PerTankResult"
```

---

### Task 5: V2 持久化（分享 / 导出格式）

**Files:**

- Modify: `src/types/timelineV2.ts`（`V2DamageEvent` + 新增 `V2TempMitigation`）
- Modify: `src/utils/timelineFormat.ts`（枚举映射 + `toV2DamageEvent` / `fromV2DamageEvent`）
- Test: `src/utils/timelineFormat.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/utils/timelineFormat.test.ts` 的 `describe('toV2 / hydrateFromV2 (editor mode)', ...)` 内新增：

```ts
it('临时减伤 tempMitigations round-trip', () => {
  const tl = makeEditorTimeline()
  tl.damageEvents[1].tempMitigations = [
    { id: 'tmA', name: '外团盾', type: 'shield', value: 30000 },
    { id: 'tmB', name: '额外20%', type: 'percent', value: 20 },
  ]
  const restored = hydrateFromV2(toV2(tl))
  const ev = restored.damageEvents.find(e => e.name === '分摊')!
  expect(ev.tempMitigations).toEqual([
    { id: 'tmA', name: '外团盾', type: 'shield', value: 30000 },
    { id: 'tmB', name: '额外20%', type: 'percent', value: 20 },
  ])
})

it('无 tempMitigations 时不产出 tm 字段', () => {
  const tl = makeEditorTimeline()
  const v2 = toV2(tl)
  expect(v2.de.every(d => d.tm === undefined)).toBe(true)
  const restored = hydrateFromV2(v2)
  expect(restored.damageEvents.every(e => e.tempMitigations === undefined)).toBe(true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run timelineFormat -t "临时减伤"`
Expected: FAIL（`ev.tempMitigations` 为 `undefined`）。

- [ ] **Step 3: 实现 — V2 类型**

在 `src/types/timelineV2.ts` 的 `V2DamageEvent` 接口**之前**新增：

```ts
/** V2 临时减伤；ty: 0=percent, 1=shield */
export interface V2TempMitigation {
  id: string
  n: string
  ty: 0 | 1
  v: number
}
```

在 `V2DamageEvent` 接口内（`pdd?` 字段之后）新增：

```ts
  /** tempMitigations（临时减伤） */
  tm?: V2TempMitigation[]
```

- [ ] **Step 4: 实现 — 编解码**

在 `src/utils/timelineFormat.ts` 顶部 import 块中：

1. 把 `TempMitigationType`、`TempMitigation` 加入从 `@/types/timeline` 的 type import：

```ts
import type {
  Annotation,
  CastEvent,
  Composition,
  DamageEvent,
  DamageEventType,
  DamageType,
  Job,
  PlayerDamageDetail,
  StatusSnapshot,
  SyncEvent,
  TempMitigation,
  TempMitigationType,
  Timeline,
} from '@/types/timeline'
```

2. 把 `V2TempMitigation` 加入从 `@/types/timelineV2` 的 type import：

```ts
import type {
  V2Annotation,
  V2CastEvents,
  V2DamageEvent,
  V2PlayerDamageDetail,
  V2StatusSnapshot,
  V2SyncEvent,
  V2TempMitigation,
  V2Timeline,
} from '@/types/timelineV2'
```

在「枚举映射」区域（`DAMAGE_TYPE_TO_NUM` 附近）新增：

```ts
const TEMP_MIT_TYPE_TO_NUM: Record<TempMitigationType, 0 | 1> = {
  percent: 0,
  shield: 1,
}
const NUM_TO_TEMP_MIT_TYPE: readonly TempMitigationType[] = ['percent', 'shield']
```

在 `toV2DamageEvent` 内、`if (e.snapshotTime !== undefined) out.st = e.snapshotTime` 之后新增：

```ts
if (e.tempMitigations && e.tempMitigations.length > 0) {
  out.tm = e.tempMitigations.map(
    (t): V2TempMitigation => ({
      id: t.id,
      n: t.name,
      ty: TEMP_MIT_TYPE_TO_NUM[t.type],
      v: t.value,
    })
  )
}
```

在 `fromV2DamageEvent` 内、`if (e.st !== undefined) out.snapshotTime = e.st` 之后新增：

```ts
if (e.tm && e.tm.length > 0) {
  out.tempMitigations = e.tm.map(
    (t): TempMitigation => ({
      id: t.id,
      name: t.n,
      type: NUM_TO_TEMP_MIT_TYPE[t.ty] ?? 'percent',
      value: t.v,
    })
  )
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test:run timelineFormat`
Expected: PASS（含新增两个用例 + 既有 round-trip 用例不回归）。

- [ ] **Step 6: Commit**

```bash
git add src/types/timelineV2.ts src/utils/timelineFormat.ts src/utils/timelineFormat.test.ts
git commit -m "feat(format): persist tempMitigations in V2 serialization"
```

---

### Task 6: 协作文档（Yjs）round-trip 验证

**Files:**

- Test: `src/collab/docSchema.test.ts`

> Yjs 通用 `entryToYMap` / `yUpdateDamageEvent` / `ymapToObject` 已能透明存取数组，无需改实现；本 Task 仅加测试锁定该行为，防止未来回归。

- [ ] **Step 1: 写测试**

打开 `src/collab/docSchema.test.ts`，参照文件中既有 damage event 的 add/update/project 用例风格（查找 `yAddDamageEvent` 或 `buildYDoc` 的现有用例作为模板），新增一个用例验证 `tempMitigations` round-trip。模板（按文件现有 import 与投影 helper 调整函数名/调用方式）：

```ts
it('damage event 的 tempMitigations 经 update 后投影保留', () => {
  const doc = buildYDoc(makeContent()) // 用文件内既有的内容构造 helper
  const evId = /* 取文件内既有用例使用的 damage event id */ 'e0'
  yUpdateDamageEvent(doc, evId, {
    tempMitigations: [{ id: 'tm1', name: '临时盾', type: 'shield', value: 30000 }],
  })
  const projected = projectTimelineContent(doc) // 用文件内既有的投影函数
  const ev = projected.damageEvents.find(e => e.id === evId)!
  expect(ev.tempMitigations).toEqual([{ id: 'tm1', name: '临时盾', type: 'shield', value: 30000 }])
})
```

> 实现者注意：`buildYDoc` / `projectTimelineContent` / 内容构造 helper 的确切名称以 `src/collab/docSchema.test.ts` 文件现有用例为准，照搬同文件的调用方式即可。若文件已有等价断言则跳过本 Task。

- [ ] **Step 2: 运行测试确认通过**

Run: `pnpm test:run docSchema`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/collab/docSchema.test.ts
git commit -m "test(collab): cover tempMitigations round-trip in Yjs doc"
```

---

### Task 7: 减伤构成色块改用 candidateDamage 切分

**Files:**

- Modify: `src/components/PropertyPanel.tsx`（`BranchViewData` 接口、`renderMitigationBar` 非 partial 分支、三处 BranchViewData 构造）

> 此 Task 改的是 render 逻辑（无独立单测），靠 Task 2–4 已保证的 `candidateDamage` 正确性 + 类型检查 + 构建 + dev 目检验证。

- [ ] **Step 1: BranchViewData 加 candidateDamage**

在 `src/components/PropertyPanel.tsx` 的 `interface BranchViewData` 内新增：

```ts
  candidateDamage?: number
```

- [ ] **Step 2: renderMitigationBar 非 partial 分支改用 candidateDamage**

在 `renderMitigationBar` 中找到非 partial 的 `else` 分支：

```ts
    } else {
      // 事件级原始口径（与改造前一致）
      finalDamageScaled = branch.finalDamage
      shieldAbsorb = shieldAvailable
      pctMitigation = Math.max(0, total - finalDamageScaled - shieldAbsorb)
      overkill = hpSnap?.overkill ?? (maxHP > 0 ? Math.max(0, finalDamageScaled - maxHP) : 0)
    }
```

替换为：

```ts
    } else {
      // 事件级口径：用 candidateDamage（盾前伤害）切分盾 / 百分比，使真实盾与临时盾都正确归类。
      // candidate − final = 全部盾吸收量；total − candidate = 全部百分比减免量。
      finalDamageScaled = branch.finalDamage
      overkill = hpSnap?.overkill ?? (maxHP > 0 ? Math.max(0, finalDamageScaled - maxHP) : 0)
      const candidate = branch.candidateDamage ?? finalDamageScaled
      shieldAbsorb = Math.max(0, candidate - finalDamageScaled)
      pctMitigation = Math.max(0, total - candidate)
    }
```

然后删除该函数内**仅** partial-else 旧逻辑用到、现已无引用的 `shieldAvailable` 声明（即 `const shieldAvailable = (branch.appliedStatuses || []).reduce(...)` 那段，连同其上方注释）。

> 删除后用 Step 5 的 `pnpm lint` 确认没有「未使用变量」报错；若 `shieldAvailable` 在 partial 分支也被引用则保留（以实际代码为准——当前仅 else 分支用到）。

- [ ] **Step 3: 三处 BranchViewData 构造带入 candidateDamage**

在 `PropertyPanel.tsx` 中找到三处构造 `BranchViewData` 的位置，分别补 `candidateDamage`：

1. 多坦 `renderTankCard` 内（含 `referenceMaxHP: v.referenceMaxHP`）：

```ts
const branch: BranchViewData = {
  finalDamage: v.finalDamage,
  mitigationPercentage: v.mitigationPercentage,
  appliedStatuses: v.appliedStatuses,
  referenceMaxHP: v.referenceMaxHP,
  candidateDamage: v.candidateDamage,
}
```

2. 多坦 `selectedBranch`（含 `referenceMaxHP: selected.referenceMaxHP`）：

```ts
const selectedBranch: BranchViewData = {
  finalDamage: selected.finalDamage,
  mitigationPercentage: selected.mitigationPercentage,
  appliedStatuses: selected.appliedStatuses,
  referenceMaxHP: selected.referenceMaxHP,
  candidateDamage: selected.candidateDamage,
}
```

3. 单坦 / AOE / 无坦的 `renderBranchContent` 内联对象（含 `result.referenceMaxHP`）：

```ts
                renderBranchContent(
                  {
                    finalDamage: result.finalDamage,
                    mitigationPercentage: result.mitigationPercentage,
                    appliedStatuses: result.appliedStatuses,
                    referenceMaxHP: result.referenceMaxHP,
                    candidateDamage: result.candidateDamage,
                  },
                  event.damageType || 'physical',
                  result.originalDamage
                )}
```

- [ ] **Step 4: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: 无错误（特别确认无 `shieldAvailable` 未使用告警）。

- [ ] **Step 6: Commit**

```bash
git add src/components/PropertyPanel.tsx
git commit -m "feat(panel): split mitigation bar by candidateDamage to categorize shields"
```

---

### Task 8: 临时减伤 section 组件

**Files:**

- Create: `src/components/TempMitigationSection.tsx`
- Modify: `src/components/PropertyPanel.tsx`（import + 挂载）

- [ ] **Step 1: 创建组件**

新建 `src/components/TempMitigationSection.tsx`：

```tsx
/**
 * 临时减伤 section（仅编辑模式）
 * 在伤害事件属性面板「预估减伤效果」下方，允许为单个事件临时附加盾/百分比减伤。
 */

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { nanoid } from 'nanoid'
import { useTimelineStore } from '@/store/timelineStore'
import { useEditorReadOnly } from '@/hooks/useEditorReadOnly'
import type { DamageEvent, TempMitigation, TempMitigationType } from '@/types/timeline'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface TempMitigationSectionProps {
  event: DamageEvent
}

export default function TempMitigationSection({ event }: TempMitigationSectionProps) {
  const updateDamageEvent = useTimelineStore(s => s.updateDamageEvent)
  const isReadOnly = useEditorReadOnly()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<TempMitigationType>('percent')
  const [value, setValue] = useState('')

  if (isReadOnly) return null

  const items = event.tempMitigations ?? []

  const resetForm = () => {
    setName('')
    setType('percent')
    setValue('')
  }

  const handleAdd = () => {
    const trimmed = name.trim()
    const num = Number(value)
    if (!trimmed || !Number.isFinite(num)) return
    const clamped =
      type === 'percent' ? Math.min(100, Math.max(0, num)) : Math.max(0, Math.round(num))
    const item: TempMitigation = { id: nanoid(), name: trimmed, type, value: clamped }
    updateDamageEvent(event.id, { tempMitigations: [...items, item] })
    resetForm()
    setDialogOpen(false)
  }

  const handleDelete = (id: string) => {
    updateDamageEvent(event.id, {
      tempMitigations: items.filter(t => t.id !== id),
    })
  }

  const formatAmount = (t: TempMitigation) =>
    t.type === 'percent' ? `-${t.value}%` : `盾 ${t.value.toLocaleString()}`

  return (
    <div className="pt-3 border-t space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">临时减伤</h3>
        <button
          onClick={() => setDialogOpen(true)}
          className="p-1 hover:bg-accent rounded transition-colors"
          aria-label="添加临时减伤"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无临时减伤</p>
      ) : (
        <div className="space-y-1">
          {items.map(t => (
            <div key={t.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate">{t.name}</span>
              <span className="tabular-nums text-green-500 font-medium">{formatAmount(t)}</span>
              <button
                onClick={() => handleDelete(t.id)}
                className="p-1 hover:bg-destructive/10 hover:text-destructive rounded transition-colors"
                aria-label="删除"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>添加临时减伤</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">名称</label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="临时减伤名称"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">减伤类型</label>
              <Select value={type} onValueChange={v => setType(v as TempMitigationType)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">百分比</SelectItem>
                  <SelectItem value="shield">盾</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                {type === 'percent' ? '减伤效果（百分比 %）' : '减伤效果（盾量）'}
              </label>
              <Input
                type="number"
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder={type === 'percent' ? '如 20' : '如 30000'}
              />
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={handleAdd}
              className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              添加
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

- [ ] **Step 2: 挂载到 PropertyPanel**

在 `src/components/PropertyPanel.tsx` 顶部 import 区新增（紧邻 `import PlayerDamageDetails from './PlayerDamageDetails'`）：

```ts
import TempMitigationSection from './TempMitigationSection'
```

在「预估减伤效果」整块（`{!timeline.isReplayMode && result && ( ... )}`）的**闭合 `)}` 之后**、Player Damage Details 块之前，新增：

```tsx
{
  /* 临时减伤（仅编辑模式；组件内部对 isReadOnly 返回 null） */
}
{
  !timeline.isReplayMode && result && <TempMitigationSection event={event} />
}
```

- [ ] **Step 3: 类型检查 + Lint**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。

Run: `pnpm lint`
Expected: 无错误。

- [ ] **Step 4: 构建**

Run: `pnpm build`
Expected: 构建成功。

- [ ] **Step 5: Commit**

```bash
git add src/components/TempMitigationSection.tsx src/components/PropertyPanel.tsx
git commit -m "feat(panel): add temp mitigation section with add/delete dialog"
```

---

### Task 9: 全量验证

**Files:** 无（验证 Task）

- [ ] **Step 1: 全量测试**

Run: `pnpm test:run`
Expected: 全部通过。

- [ ] **Step 2: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: 无错误。

- [ ] **Step 4: 构建**

Run: `pnpm build`
Expected: 成功。

- [ ] **Step 5: dev 目检（人工）**

启动 `pnpm dev`（若用户尚未启动），在编辑模式下：

1. 选中一个伤害事件 → 「预估减伤效果」下方出现「临时减伤」section，标题右侧有 `+`。
2. 点 `+` → 对话框，填名称/类型/数值 → 添加 → 列表出现该项，减伤量显示正确（百分比 `-X%` / 盾 `盾 X`）。
3. 最终伤害、HP 条、减伤构成条随之变化；临时盾在「护盾减免」黄色块、临时百分比在「百分比减免」蓝色块。
4. 删除按钮可移除该项，计算回退。
5. 刷新页面后该临时减伤仍在（本地持久化生效）。

---

## Self-Review 记录

- **Spec 覆盖**：数据模型(Task1)、计算-百分比(Task2)、计算-盾(Task3)、多坦 candidateDamage(Task4)、V2 持久化(Task5)、Yjs round-trip(Task6)、色块切分(Task7)、UI section+对话框(Task8)、全量验证(Task9)。spec 各节均有对应 Task。
- **占位符**：无 TBD / TODO；逻辑步骤均含完整代码。Task6/部分 helper 名以目标测试文件现有用例为准（已注明照搬方式），非占位。
- **类型一致性**：`TempMitigation`/`TempMitigationType` 全程一致；`candidateDamage` 在 `CalculationResult`（既有）、`PerTankResult`（Task4 新增）、`BranchViewData`（Task7 新增）命名一致；V2 字段 `tm` / `V2TempMitigation` 一致。
