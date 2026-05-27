# 不支持副本导入时自动提取数值设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 FFLogs 导入未收录（无聚合统计）的副本时，自动从本场战斗事件提取盾/治疗/暴击治疗/血量，填入 `timeline.statData`，让减伤计算有接近真实的基准。

**Architecture:** 把 `top100Sync` 中已有的三个原始提取器（shield/heal/maxHP）下沉到 `fflogsImporter` 作单一真源；新增纯函数 `parseStatData` 按阵容 `statDataEntries` 的 key 过滤后取 p50（普通）/p90（暴击）；服务端导入路由检测到该副本 KV 无统计时调用它并把结果挂到 timeline。

**Tech Stack:** TypeScript、Vitest、Cloudflare Workers（Hono）、FFLogs V2 API。

**相关 spec:** `design/superpowers/specs/2026-05-27-fflogs-import-statdata-design.md`

---

## 文件结构

- **`src/utils/fflogsImporter.ts`**（修改）：新增并导出 `extractShieldData / extractHealData / extractMaxHPData`（从 top100Sync 迁入，shield 非变异、maxHP 用 playerMap）+ 新增 `parseStatData`。
- **`src/workers/top100Sync.ts`**（修改）：删除上述三个本地函数，改从 `@/utils/fflogsImporter` import；`extractFightStats` 先建 playerMap 再调 `extractMaxHPData(events, playerMap)`；清理因此空置的 import。
- **`src/workers/routes/fflogs.ts`**（修改）：`GET /import` 构建 timeline 时，KV 无统计则调 `parseStatData`，非空才挂 `statData`。
- **`src/utils/fflogsImporter.test.ts`**（修改）：新增提取器与 `parseStatData` 的单测。

---

## Task 1: 提取器下沉到 fflogsImporter（单一真源 + shield 非变异 + maxHP 用 playerMap）

**Files:**

- Modify: `src/utils/fflogsImporter.ts`
- Modify: `src/workers/top100Sync.ts`
- Test: `src/utils/fflogsImporter.test.ts`

- [ ] **Step 1: 在 `fflogsImporter.test.ts` 写失败测试**

在文件末尾、最后一个顶层 `describe` 之后追加。先确认顶部 import 行（第 7 行）扩展为包含三个提取器：

```ts
import {
  parseCastEvents,
  parseDamageEvents,
  parseSyncEvents,
  extractShieldData,
  extractHealData,
  extractMaxHPData,
} from './fflogsImporter'
```

追加测试块：

```ts
describe('extractShieldData', () => {
  it('应按 statusId（abilityGameID-1000000）聚样，且不变异传入事件', () => {
    const events = [
      { type: 'absorbed', abilityGameID: 1001457, amount: 5000 },
      { type: 'absorbed', abilityGameID: 1001457, amount: 7000 },
      // 泛血印 1002643 应被当作泛输血 1002613 计入，但不写回 event
      { type: 'absorbed', abilityGameID: 1002643, amount: 800 },
    ] as unknown as Parameters<typeof extractShieldData>[0]

    const result = extractShieldData(events)

    expect(result[1457]).toEqual([5000, 7000])
    expect(result[2613]).toEqual([800])
    // 非变异：原始 event 的 abilityGameID 保持 1002643
    expect((events as { abilityGameID: number }[])[2].abilityGameID).toBe(1002643)
  })
})

describe('extractHealData', () => {
  it('应按原始 abilityGameID 聚样并排除 overheal 事件', () => {
    const events = [
      { type: 'heal', abilityGameID: 7388, amount: 3000 },
      { type: 'heal', abilityGameID: 7388, amount: 5000, overheal: 100 }, // 排除
      { type: 'heal', abilityGameID: 1002108, amount: 800 }, // HoT（1e6+status）原样保留
    ] as unknown as Parameters<typeof extractHealData>[0]

    const result = extractHealData(events)

    expect(result[7388]).toEqual([3000])
    expect(result[1002108]).toEqual([800])
  })
})

describe('extractMaxHPData', () => {
  it('应用 playerMap 把 targetResources.maxHitPoints 归到职业', () => {
    const playerMap = new Map([
      [1, { id: 1, name: 'T', type: 'Warrior' }],
      [2, { id: 2, name: 'H', type: 'WhiteMage' }],
    ])
    const events = [
      {
        type: 'heal',
        abilityGameID: 1,
        amount: 1,
        targetID: 1,
        targetResources: { maxHitPoints: 200000 },
      },
      {
        type: 'heal',
        abilityGameID: 1,
        amount: 1,
        targetID: 2,
        targetResources: { maxHitPoints: 120000 },
      },
    ] as unknown as Parameters<typeof extractMaxHPData>[0]

    const result = extractMaxHPData(events, playerMap)

    expect(result.WAR).toEqual([200000])
    expect(result.WHM).toEqual([120000])
  })
})
```

> 注：`type` 字段用 FFLogs actor type 字符串（如 `Warrior` / `WhiteMage`），`JOB_MAP` 负责映射到 `WAR` / `WHM`。若 `JOB_MAP` 的键有差异，以 `src/data/jobMap.ts` 实际键为准调整测试数据。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run fflogsImporter`
Expected: FAIL —— `extractShieldData`/`extractHealData`/`extractMaxHPData` 未从 `./fflogsImporter` 导出（import 报错）。

- [ ] **Step 3: 在 `fflogsImporter.ts` 实现三个导出函数**

在文件末尾（`parseSyncEvents` 之后）追加。`FFLogsEvent` / `Job` / `JOB_MAP` 已在文件顶部 import，无需新增。

```ts
/**
 * 从事件列表提取盾值原始样本（按 statusId = abilityGameID - 1000000 聚样）。
 *
 * 非变异：FFLogs 把泛输血（1002613）记成泛血印（1002643），此处用局部变量修正，
 * 不写回 event —— events 数组被多个解析器共享。
 */
export function extractShieldData(events: FFLogsEvent[]): Record<number, number[]> {
  const shieldByAbility: Record<number, number[]> = {}
  for (const event of events) {
    if (event.type === 'absorbed' && event.abilityGameID && event.amount) {
      const rawId = event.abilityGameID === 1002643 ? 1002613 : event.abilityGameID
      const statusId = rawId - 1000000
      if (!shieldByAbility[statusId]) shieldByAbility[statusId] = []
      shieldByAbility[statusId].push(event.amount)
    }
  }
  return shieldByAbility
}

/**
 * 从事件列表提取治疗原始样本（按 heal 事件原始 abilityGameID 聚样，排除 overheal）。
 */
export function extractHealData(events: FFLogsEvent[]): Record<number, number[]> {
  const healByAbility: Record<number, number[]> = {}
  for (const event of events) {
    if (event.type === 'heal' && !event.overheal && event.abilityGameID && event.amount) {
      if (!healByAbility[event.abilityGameID]) healByAbility[event.abilityGameID] = []
      healByAbility[event.abilityGameID].push(event.amount)
    }
  }
  return healByAbility
}

/**
 * 从 heal 事件的 targetResources.maxHitPoints 按职业聚样最大 HP。
 */
export function extractMaxHPData(
  events: FFLogsEvent[],
  playerMap: Map<number, { id: number; name: string; type: string }>
): Record<Job, number[]> {
  const maxHPByJob: Partial<Record<Job, number[]>> = {}
  for (const event of events) {
    if (event.type !== 'heal') continue
    const targetResources = (event as FFLogsEvent & { targetResources?: { maxHitPoints?: number } })
      .targetResources
    const maxHP = targetResources?.maxHitPoints
    const targetID = event.targetID
    if (!maxHP || maxHP <= 0 || !targetID) continue
    const player = playerMap.get(targetID)
    if (!player?.type) continue
    const job = JOB_MAP[player.type.replace(/\s/g, '')]
    if (!job) continue
    if (!maxHPByJob[job]) maxHPByJob[job] = []
    maxHPByJob[job]!.push(maxHP)
  }
  return maxHPByJob as Record<Job, number[]>
}
```

- [ ] **Step 4: 改 `top100Sync.ts` 删本地函数、改用 import**

(a) 修改 import 段。`top100Sync.ts` 第 18 行原为：

```ts
import { parseDamageEvents, parseComposition } from '@/utils/fflogsImporter'
```

改为：

```ts
import {
  parseDamageEvents,
  parseComposition,
  extractShieldData,
  extractHealData,
  extractMaxHPData,
} from '@/utils/fflogsImporter'
```

(b) 删除 `top100Sync.ts` 中本地的 `extractHealData`（约 200-213 行）、`extractShieldData`（约 241-258 行）、`extractMaxHPData`（约 264-291 行）三个函数定义。**保留** `extractDamageData`（仅 top100 用）。

(c) `extractFightStats`（约 70-101 行）调整调用顺序：先建 `playerMap`，再传给 `extractMaxHPData`。把函数体开头改为：

```ts
export function extractFightStats(
  report: FFLogsV1Report,
  fight: FFLogsV1Report['fights'][number],
  events: FFLogsEvent[]
): ExtractedFightData {
  const playerMap = new Map<number, { id: number; name: string; type: string }>()
  for (const actor of report.friendlies ?? []) {
    playerMap.set(actor.id, { id: actor.id, name: actor.name, type: actor.type })
  }
  const abilityMap = new Map<number, FFLogsAbility>()
  for (const ability of report.abilities ?? []) {
    abilityMap.set(ability.gameID, ability)
  }

  const damageByAbility = extractDamageData(events)
  const shieldByAbility = extractShieldData(events)
  const maxHPByJob = extractMaxHPData(events, playerMap)
  const healByAbility = extractHealData(events)

  const composition = parseComposition(report as unknown as FFLogsReport, fight.id)
  const fullDamageEvents = parseDamageEvents(
    events,
    fight.start_time,
    playerMap,
    abilityMap,
    composition
  )
  const damageEvents = slimDamageEvents(fullDamageEvents)
  const durationMs = fight.end_time - fight.start_time

  return { damageByAbility, shieldByAbility, maxHPByJob, healByAbility, durationMs, damageEvents }
}
```

(d) 若 `JOB_MAP`（第 16 行 `import { JOB_MAP } from '@/data/jobMap'`）在删函数后不再被引用，删掉该 import（由 tsc/lint 在 Step 5 确认）。`FFLogsAbility` / `FFLogsV1Report` / `FFLogsReport` 仍被引用，保留。

- [ ] **Step 5: 运行测试 + 类型检查确认通过**

Run: `pnpm test:run fflogsImporter && pnpm test:run top100Sync && pnpm exec tsc --noEmit`
Expected: 全部 PASS；tsc 无报错（若 `JOB_MAP` 变成未用 import，tsc/lint 会报 `'JOB_MAP' is declared but its value is never read`，按 Step 4(d) 删除）。

- [ ] **Step 6: 提交**

```bash
git add src/utils/fflogsImporter.ts src/utils/fflogsImporter.test.ts src/workers/top100Sync.ts
git commit -F .git/COMMIT_EDITMSG_STATDATA
```

提交信息（写入 `.git/COMMIT_EDITMSG_STATDATA` 后用 `-F`，避免 here-string 把 `@` 拼进 message）：

```
refactor(fflogs): hoist shield/heal/maxHP extractors into importer

下沉 top100Sync 的三个原始提取器到 fflogsImporter 作单一真源；
shield 提取改为非变异，maxHP 改用 playerMap，为 parseStatData 复用做准备。
```

---

## Task 2: 新增纯函数 `parseStatData`

**Files:**

- Modify: `src/utils/fflogsImporter.ts`
- Test: `src/utils/fflogsImporter.test.ts`

- [ ] **Step 1: 写失败测试**

在 `fflogsImporter.test.ts` 顶部 import 段加入 `parseStatData`：

```ts
import {
  parseCastEvents,
  parseDamageEvents,
  parseSyncEvents,
  extractShieldData,
  extractHealData,
  extractMaxHPData,
  parseStatData,
} from './fflogsImporter'
import type { Composition } from '@/types/timeline'
```

追加测试块：

```ts
describe('parseStatData', () => {
  const playerMap = new Map([
    [1, { id: 1, name: 'T', type: 'Warrior' }],
    [2, { id: 2, name: 'H', type: 'WhiteMage' }],
  ])
  const composition: Composition = {
    players: [
      { id: 1, job: 'WAR' },
      { id: 2, job: 'WHM' },
    ],
  }

  it('提取盾/治疗/血量，过滤非 statData 技能，按 p50/p90 取值', () => {
    const events = [
      // WAR 摆脱盾 statusId 1457
      { type: 'absorbed', abilityGameID: 1001457, amount: 5000 },
      // WAR 摆脱直疗 actionId 7388（含一条 overheal，应排除）
      { type: 'heal', abilityGameID: 7388, amount: 3000 },
      { type: 'heal', abilityGameID: 7388, amount: 9000, overheal: 50 },
      // WAR 摆脱 HoT key 1002108
      { type: 'heal', abilityGameID: 1002108, amount: 800 },
      // 非 statData 技能：普通 GCD 治疗 + 携带 maxHitPoints，应被过滤出 healByAbility
      {
        type: 'heal',
        abilityGameID: 99999,
        amount: 1,
        targetID: 1,
        targetResources: { maxHitPoints: 200000 },
      },
      {
        type: 'heal',
        abilityGameID: 99999,
        amount: 1,
        targetID: 2,
        targetResources: { maxHitPoints: 120000 },
      },
    ] as unknown as Parameters<typeof parseStatData>[0]

    const result = parseStatData(events, playerMap, composition)

    expect(result).toBeDefined()
    expect(result!.shieldByAbility).toEqual({ 1457: 5000 })
    expect(result!.critShieldByAbility).toEqual({})
    expect(result!.healByAbility).toEqual({ 7388: 3000, 1002108: 800 })
    expect(result!.critHealByAbility).toEqual({}) // 7388/1002108 非 critHeal entry key
    expect(result!.referenceMaxHP).toBe(120000) // 非坦（WHM）最小
    expect(result!.tankReferenceMaxHP).toBe(200000) // 坦克（WAR）最小
  })

  it('无任何匹配样本时返回 undefined', () => {
    const events = [
      { type: 'damage', abilityGameID: 12345, amount: 1, unmitigatedAmount: 1 },
    ] as unknown as Parameters<typeof parseStatData>[0]
    expect(parseStatData(events, playerMap, composition)).toBeUndefined()
  })
})
```

> 注：`99999` 故意不是任何技能的 statData key，用来验证"非声明技能被过滤"。`7388` / `1457` / `1002108` 取自 `mitigationActions.ts` 中 WAR「摆脱」的 `statDataEntries`，实现前请确认这些 key 未变（若已变，同步更新测试与断言）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:run fflogsImporter`
Expected: FAIL —— `parseStatData` 未导出。

- [ ] **Step 3: 实现 `parseStatData`**

在 `fflogsImporter.ts` 顶部 import 段补充类型：

```ts
import type { TimelineStatData } from '@/types/statData'
```

（`MITIGATION_DATA`、`calculatePercentile`、`getTankJobs`、`Composition` 已在文件中 import。）在文件末尾追加：

```ts
/**
 * 从单场战斗事件提取 statData（供未收录副本导入时填充）。
 *
 * 仅保留当前阵容 statDataEntries 声明的 key；普通值取 p50、暴击值取 p90，
 * 与 top100Sync 的 statistics 口径一致。四类数值与 HP 全空时返回 undefined。
 */
export function parseStatData(
  events: FFLogsEvent[],
  playerMap: Map<number, { id: number; name: string; type: string }>,
  composition: Composition
): TimelineStatData | undefined {
  // 1. 阵容内 action 的 statDataEntries → 按 type 分桶的合法 key 集合
  const jobs = new Set(composition.players.map(p => p.job))
  const entries = MITIGATION_DATA.actions
    .filter(a => a.statDataEntries && a.jobs.some(j => jobs.has(j)))
    .flatMap(a => a.statDataEntries!)
  const shieldKeys = new Set(entries.filter(e => e.type === 'shield').map(e => e.key))
  const critShieldKeys = new Set(entries.filter(e => e.type === 'critShield').map(e => e.key))
  const healKeys = new Set(entries.filter(e => e.type === 'heal').map(e => e.key))
  const critHealKeys = new Set(entries.filter(e => e.type === 'critHeal').map(e => e.key))

  // 2. 原始样本
  const rawShield = extractShieldData(events)
  const rawHeal = extractHealData(events)
  const rawMaxHP = extractMaxHPData(events, playerMap)

  // 3. 逐 key p50/p90，仅保留合法 key
  const shieldByAbility: Record<number, number> = {}
  const critShieldByAbility: Record<number, number> = {}
  const healByAbility: Record<number, number> = {}
  const critHealByAbility: Record<number, number> = {}

  for (const [k, samples] of Object.entries(rawShield)) {
    if (!samples.length) continue
    const key = Number(k)
    if (shieldKeys.has(key)) shieldByAbility[key] = calculatePercentile(samples, 50)
    if (critShieldKeys.has(key)) critShieldByAbility[key] = calculatePercentile(samples, 90)
  }
  for (const [k, samples] of Object.entries(rawHeal)) {
    if (!samples.length) continue
    const key = Number(k)
    if (healKeys.has(key)) healByAbility[key] = calculatePercentile(samples, 50)
    if (critHealKeys.has(key)) critHealByAbility[key] = calculatePercentile(samples, 90)
  }

  // 4. 血量：每职业 p50 → 非坦/坦克分别取 min
  const tankJobs = new Set<string>(getTankJobs())
  const nonTankHPs: number[] = []
  const tankHPs: number[] = []
  for (const [job, samples] of Object.entries(rawMaxHP)) {
    if (!samples.length) continue
    const hp = calculatePercentile(samples, 50)
    if (hp <= 0) continue
    if (tankJobs.has(job)) tankHPs.push(hp)
    else nonTankHPs.push(hp)
  }
  const referenceMaxHP = nonTankHPs.length ? Math.min(...nonTankHPs) : undefined
  const tankReferenceMaxHP = tankHPs.length ? Math.min(...tankHPs) : undefined

  // 5. 全空 → undefined（调用方不赋值，sd 不落盘，行为同现状）
  const hasAny =
    Object.keys(shieldByAbility).length > 0 ||
    Object.keys(critShieldByAbility).length > 0 ||
    Object.keys(healByAbility).length > 0 ||
    Object.keys(critHealByAbility).length > 0 ||
    referenceMaxHP !== undefined ||
    tankReferenceMaxHP !== undefined
  if (!hasAny) return undefined

  return {
    ...(referenceMaxHP !== undefined ? { referenceMaxHP } : {}),
    ...(tankReferenceMaxHP !== undefined ? { tankReferenceMaxHP } : {}),
    shieldByAbility,
    critShieldByAbility,
    healByAbility,
    critHealByAbility,
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:run fflogsImporter && pnpm exec tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

提交信息写入 `.git/COMMIT_EDITMSG_STATDATA` 后：

```bash
git add src/utils/fflogsImporter.ts src/utils/fflogsImporter.test.ts
git commit -F .git/COMMIT_EDITMSG_STATDATA
```

提交信息：

```
feat(fflogs): add parseStatData to derive statData from a single fight

按阵容 statDataEntries 过滤盾/治疗/暴击治疗/血量，p50 普通 / p90 暴击，
全空返回 undefined。供未收录副本导入时填充数值设置。
```

---

## Task 3: 导入路由接入（KV 无统计时填充 statData）

**Files:**

- Modify: `src/workers/routes/fflogs.ts`

- [ ] **Step 1: 扩展 import**

`routes/fflogs.ts` 第 6-13 行的 `@/utils/fflogsImporter` import 末尾加入 `parseStatData`：

```ts
import {
  parseComposition,
  parseDamageEvents,
  parseCastEvents,
  parseSyncEvents,
  findFirstDamageTimestamp,
  convertV1ToReport,
  parseStatData,
} from '@/utils/fflogsImporter'
```

在 `import { getEncounterWithTier } from '@/data/raidEncounters'`（第 14 行）下方新增（与 `routes/statistics.ts` 一致用相对路径）：

```ts
import { getStatisticsKVKey } from '../top100Sync'
```

- [ ] **Step 2: 在构建 timeline 前计算 statData**

在 `routes/fflogs.ts` 的 `const now = Math.floor(Date.now() / 1000)`（约 134 行）**之前**插入：

```ts
// 未收录副本（KV 无聚合统计）→ 从本场事件提取 statData 填充数值设置。
// KV 抖动按"已支持"保守处理，绝不阻断导入。
let statData: ReturnType<typeof parseStatData>
try {
  const statsExist = await c.env.healerbook.get(getStatisticsKVKey(fight.encounterID || 0))
  if (!statsExist) {
    statData = parseStatData(eventsData.events || [], playerMap, composition)
  }
} catch (err) {
  console.error('[FFLogs Import] statData 提取失败，跳过:', err)
}
```

- [ ] **Step 3: 把 statData 挂到 timeline**

在 `const timeline: Timeline = { ... }` 对象里，`fflogsSource: { reportCode, fightId },`（约 154 行）之后、`createdAt: now,` 之前插入一行（与既有 `gameZoneId` 的条件展开写法一致）：

```ts
      ...(statData ? { statData } : {}),
```

- [ ] **Step 4: 类型检查 + lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 无报错。`statData` 类型为 `TimelineStatData | undefined`，`Timeline.statData?` 可选字段，条件展开兼容。

- [ ] **Step 5: 全量测试兜底**

Run: `pnpm test:run`
Expected: 全绿（无回归）。

- [ ] **Step 6: 手动冒烟验证（dev 服务端路径）**

前置：用户已 `pnpm dev`。步骤：

1. 取一个**未收录副本**的 FFLogs 战斗链接（`getEncounterWithTier` 查不到、或 encounterID 为 0 的内容）。
2. 在首页「从 FFLogs 导入」粘贴并导入。
3. 打开导入后的时间轴 → 顶栏「数值设置」。
4. 预期：盾/治疗/暴击治疗、安全血量显示为**从该场提取的真实数值**（非默认 10000 / 100000 占位）；对照该队该场的实际盾/血量量级合理。
5. 反向验证：导入一个**已收录副本**，数值设置仍走 statistics 占位（不被本场覆盖）。

- [ ] **Step 7: 提交**

提交信息写入 `.git/COMMIT_EDITMSG_STATDATA` 后：

```bash
git add src/workers/routes/fflogs.ts
git commit -F .git/COMMIT_EDITMSG_STATDATA
```

提交信息：

```
feat(fflogs): fill statData from fight when encounter has no statistics

服务端导入路由检测 KV 无 statistics:encounter:{id} 时，调用 parseStatData
从本场事件提取数值填入 timeline.statData；KV 失败保守跳过，不阻断导入。
```

---

## Self-Review 记录

**Spec 覆盖：**

- §3.1 key 语义 → Task 1（shield 减偏移 / heal 原始 id）+ Task 2（按 entry.type 分桶过滤）✓
- §3.2 判定信号（KV 缺失 / encounterID 0）→ Task 3 Step 2 ✓
- §3.3 序列化往返 → 已查证（`out.sd` / `base.statData`），无需代码改动 ✓
- §3.4 p50/p90 口径 → Task 2 Step 3 ✓
- §4.1 去重 + 非变异 + maxHP playerMap → Task 1 ✓
- §4.2 parseStatData → Task 2 ✓
- §4.3 路由接入 + KV 失败保守 + 相对 import → Task 3 ✓
- §6 测试 → Task 1/2 单测 + Task 3 全量回归 + 手动冒烟 ✓

**占位符扫描：** 无 TBD/TODO；每个改代码的步骤均含完整代码。

**类型/命名一致性：** `extractShieldData/extractHealData/extractMaxHPData`、`parseStatData`、`getStatisticsKVKey`、`TimelineStatData` 全程一致；`extractMaxHPData(events, playerMap)` 签名在 Task 1（定义）与 Task 2（调用）一致；路由 `statData` 变量类型与 `Timeline.statData` 可选字段一致。

> 注：spec §4.3 示例曾写 `@/workers/top100Sync`，实现以本计划为准用相对路径 `../top100Sync`（与 `routes/statistics.ts` 既有约定一致）。
