# Statistics Pipeline 重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 D1 持久队列 + 短间隔 cron 单场处理，取代现有 "queue + 临时 KV + 锁" 的统计聚合流水线，让样本池、统计结果、encounter template 平滑增量更新。

**Architecture:**

- **syncEncounter**（沿用 12h cron 的 `sync-encounter` 队列分支）：仅写 `top100:encounter:{id}` + `INSERT OR IGNORE` 排行榜每条 (encounterId, reportCode, fightID, durationMs) 进 D1 `samples_queue` 表。不再随机抽 10 场也不再推 `extract-statistics` 队列。
- **新短间隔 cron `*/10 * * * *` `sample-tick`**：分层（按 encounter `MAX(sampled_at)` 升序，NULL 优先）原子选一条未采样行 → 拉单场 events → reservoir 增量合并到 `statistics-samples:encounter:{id}` → 重算 percentile 并累加 `abilityFightCount` / `totalFightsSampled` 写 `statistics:encounter:{id}` → 若本场 `durationMs > old.templateSourceDurationMs` 则用本场骨架 + 最新 p50Map 覆盖 `encounter-template:{id}`。
- 四个最终 KV key（`top100:` / `statistics-samples:` / `statistics:` / `encounter-template:`）一律去 TTL；`STATISTICS_EXTRACT_QUEUE` + 临时 KV (`stats-task:` / `fight-stats:` / `fight-completed:` / `stats-lock:`) 全部下线。

**Tech Stack:** Cloudflare Workers, D1 (SQLite), KV, Vitest 4, TypeScript 5.9

---

## Background — 关键决策回放

| #   | 决策                                                                             |
| --- | -------------------------------------------------------------------------------- |
| 1   | 四个最终 KV key 一律去 TTL                                                       |
| 2   | 分层度量：按 `MAX(sampled_at) NULLS FIRST` 选 encounter，再随机一条未采样        |
| 3   | 每 tick 处理 1 场（cron 间隔 10min 远 > 单 tick 耗时）                           |
| 4   | `abilityFightCount` 直接累加到 `statistics:`（不进 reservoir，独立持久计数）     |
| 5   | template 覆盖：严格 `>`，相等不覆盖（避免抖动）                                  |
| 6   | KV 写次数不卡                                                                    |
| 7   | D1 加列：`id`(自增 PK) / `duration_ms` / `created_at` / `updated_at`；清理暂不做 |
| 8   | 旧 queue / 临时 KV / 锁全部下线                                                  |

`updated_at` 由应用层每次 UPDATE 显式 `SET`，不用 trigger。`created_at` / `updated_at` 默认值用 `(unixepoch('subsec') * 1000)`。

---

## File Structure

**新增文件**

| 路径                                       | 责任                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `migrations/0003_create_samples_queue.sql` | D1 表 + 索引 DDL                                                                                |
| `src/workers/samplesQueue.ts`              | D1 helper：`enqueueRankings(db, encounterId, entries)` / `pickNextSample(db)` 两个函数 + 行类型 |
| `src/workers/samplesQueue.test.ts`         | helper 单测（基于 in-memory D1 mock）                                                           |

**修改文件**

| 路径                             | 改动摘要                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/mitigation.ts`        | `EncounterStatistics` 加 `abilityFightCount` / `totalFightsSampled` 字段                                                                                                                                                                  |
| `src/workers/top100Sync.ts`      | 大改：拆 `extractFightStats` 纯函数；重写 `buildEncounterTemplate` 单场版；新增 `processOneSample`；改造 `syncEncounter`；删 `aggregateStatistics` / `extractFightStatistics`(写入侧) / `updateStatisticsTaskProgress` / 临时 KV key 函数 |
| `src/workers/top100Sync.test.ts` | 重写：删旧 aggregate 测试，加 `extractFightStats` / 单场 `buildEncounterTemplate` / `processOneSample` 测试                                                                                                                               |
| `src/workers/fflogs-proxy.ts`    | `Env` 删 `STATISTICS_EXTRACT_QUEUE`；`handleScheduled` 按 `event.cron` 分支；`handleQueue` 删 `extract-statistics` 分支；`handleQueue` 类型不再含统计字段                                                                                 |
| `wrangler.toml`                  | 加 cron `*/10 * * * *`；删 `statistics-extract-queue` producer/consumer 绑定（dev + production）                                                                                                                                          |

读 `EncounterStatistics` 的前端代码本仓库不动（缺字段时 default 由消费侧决定），但本 plan 在 Task 11 留一个 search-and-default 任务。

---

## D1 Schema (Task 1 详细文件)

```sql
-- migrations/0003_create_samples_queue.sql
CREATE TABLE samples_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id  INTEGER NOT NULL,
  report_code   TEXT    NOT NULL,
  fight_id      INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  sampled       INTEGER NOT NULL DEFAULT 0,
  sampled_at    INTEGER,                                                  -- ms, NULL = 未采样
  created_at    INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),    -- app 在 UPDATE 时显式覆盖
  UNIQUE (report_code, fight_id)
);

CREATE INDEX idx_samples_queue_pick
  ON samples_queue (encounter_id, sampled, sampled_at);
```

注：`UNIQUE(report_code, fight_id)` 同时给 `INSERT OR IGNORE` 撑腰（同一份 ranking entry 反复 sync 不会重复入队）。`(encounter_id, sampled, sampled_at)` 索引覆盖分层挑选 SQL 的两次 `GROUP BY`/`ORDER BY` 路径。

---

## 核心 SQL（Task 2 实现引用）

**入队**（批量）：

```sql
INSERT OR IGNORE INTO samples_queue (encounter_id, report_code, fight_id, duration_ms)
VALUES (?, ?, ?, ?);
```

**分层挑一条 + 原子标记**：

```sql
UPDATE samples_queue
SET sampled = 1, sampled_at = ?, updated_at = ?
WHERE id = (
  SELECT s.id
  FROM samples_queue s
  JOIN (
    SELECT encounter_id
    FROM samples_queue
    WHERE EXISTS (
      SELECT 1 FROM samples_queue x
      WHERE x.encounter_id = samples_queue.encounter_id AND x.sampled = 0
    )
    GROUP BY encounter_id
    ORDER BY (MAX(sampled_at) IS NULL) DESC, MAX(sampled_at) ASC
    LIMIT 1
  ) e ON e.encounter_id = s.encounter_id
  WHERE s.sampled = 0
  ORDER BY RANDOM()
  LIMIT 1
)
RETURNING id, encounter_id, report_code, fight_id, duration_ms;
```

> SQLite 子查询里 `MAX(sampled_at) IS NULL` 比 `NULLS FIRST`（SQLite 不支持该语法）更稳。`DESC` 把 NULL 排在最前 → 从未被采样过的 encounter 优先被选中。

`pickNextSample` 返回 `null` 当无任何未采样行；返回行后调用方负责执行后续提取。

---

## 类型 diff（Task 3）

```ts
// src/types/mitigation.ts —— EncounterStatistics 新增 2 个字段
export interface EncounterStatistics {
  // ...所有现有字段保留...
  /**
   * 敌方每个 abilityId 在已采样的 fight 中"出现过的场数"
   * （单场内同 ability 多次出现只计 1 次）
   * 累计型，不进 reservoir。
   */
  abilityFightCount: Record<number, number>
  /** 累计已采样的 fight 总场数（abilityFightCount 的分母） */
  totalFightsSampled: number
}
```

读取侧（前端）需把缺失字段 default 为 `{}` / `0`（Task 11）。

---

## Tasks

---

### Task 1: 新增 D1 migration `samples_queue`

**Files:**

- Create: `migrations/0003_create_samples_queue.sql`

- [ ] **Step 1: 写 migration 文件**

文件内容：

```sql
CREATE TABLE samples_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id  INTEGER NOT NULL,
  report_code   TEXT    NOT NULL,
  fight_id      INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  sampled       INTEGER NOT NULL DEFAULT 0,
  sampled_at    INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  UNIQUE (report_code, fight_id)
);

CREATE INDEX idx_samples_queue_pick
  ON samples_queue (encounter_id, sampled, sampled_at);
```

- [ ] **Step 2: 在本地 D1 上 dry-run 应用**

Run: `pnpm exec wrangler d1 execute healerbook_timelines --local --file=migrations/0003_create_samples_queue.sql`
Expected: stdout 含 `🌀 Executing on local database` + `✅ Successfully executed ... commands`，无报错。

- [ ] **Step 3: 验证表结构**

Run: `pnpm exec wrangler d1 execute healerbook_timelines --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name='samples_queue';"`
Expected: 输出含 `samples_queue` 一行。

Run: `pnpm exec wrangler d1 execute healerbook_timelines --local --command="PRAGMA table_info(samples_queue);"`
Expected: 9 列，列名与 SQL 一致；`created_at` / `updated_at` 的 `dflt_value` 含 `unixepoch`。

- [ ] **Step 4: Commit**

```bash
git add migrations/0003_create_samples_queue.sql
git commit -m "feat(d1): 新增 samples_queue 表用于持久化采样队列"
```

> **生产部署提醒**（写入 plan 末尾的 deployment checklist，不在本任务执行）：发布 Worker **之前**必须 `pnpm exec wrangler d1 execute healerbook_timelines --remote --file=migrations/0003_create_samples_queue.sql`，否则新代码起来会立即崩。

---

### Task 2: D1 helper 模块 `samplesQueue.ts`

**Files:**

- Create: `src/workers/samplesQueue.ts`
- Create: `src/workers/samplesQueue.test.ts`

- [ ] **Step 1: 写测试 — `enqueueRankings` 与 `pickNextSample`**

文件 `src/workers/samplesQueue.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { enqueueRankings, pickNextSample, type SampleQueueRow } from './samplesQueue'

/**
 * 内存 D1 mock：模拟本模块用到的两条 SQL：
 *   INSERT OR IGNORE INTO samples_queue (encounter_id, report_code, fight_id, duration_ms) VALUES (?,?,?,?)
 *   UPDATE samples_queue SET sampled = 1, sampled_at = ?, updated_at = ? WHERE id = (...) RETURNING ...
 */
function makeMockD1(initialRows: SampleQueueRow[] = []): D1Database {
  let nextId = initialRows.reduce((m, r) => Math.max(m, r.id), 0) + 1
  const rows: SampleQueueRow[] = [...initialRows]

  function pickAtomic(now: number): SampleQueueRow | null {
    // 1) 找未采样行存在的 encounter，按 MAX(sampled_at) NULLS FIRST 升序
    const encounterMap = new Map<number, number | null>() // encounterId → max(sampled_at) 在所有该 encounter 行中
    for (const r of rows) {
      const cur = encounterMap.get(r.encounter_id)
      if (cur === undefined) encounterMap.set(r.encounter_id, r.sampled_at)
      else if (r.sampled_at !== null && (cur === null || r.sampled_at > cur)) {
        encounterMap.set(r.encounter_id, r.sampled_at)
      }
    }
    const encountersWithUnsampled = [...encounterMap.entries()].filter(([eid]) =>
      rows.some(r => r.encounter_id === eid && r.sampled === 0)
    )
    if (encountersWithUnsampled.length === 0) return null
    encountersWithUnsampled.sort((a, b) => {
      // NULL 排最前
      if (a[1] === null && b[1] !== null) return -1
      if (a[1] !== null && b[1] === null) return 1
      return (a[1] ?? 0) - (b[1] ?? 0)
    })
    const targetEncounter = encountersWithUnsampled[0][0]

    // 2) 该 encounter 内随机一条未采样行
    const candidates = rows.filter(r => r.encounter_id === targetEncounter && r.sampled === 0)
    const chosen = candidates[Math.floor(Math.random() * candidates.length)]

    // 3) 标记
    chosen.sampled = 1
    chosen.sampled_at = now
    chosen.updated_at = now
    return { ...chosen }
  }

  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.startsWith('INSERT OR IGNORE INTO samples_queue')) {
            const [encounter_id, report_code, fight_id, duration_ms] = args as [
              number,
              string,
              number,
              number,
            ]
            const dup = rows.some(r => r.report_code === report_code && r.fight_id === fight_id)
            if (dup) return { meta: { changes: 0 } }
            const now = Date.now()
            rows.push({
              id: nextId++,
              encounter_id,
              report_code,
              fight_id,
              duration_ms,
              sampled: 0,
              sampled_at: null,
              created_at: now,
              updated_at: now,
            })
            return { meta: { changes: 1 } }
          }
          throw new Error(`Unhandled run() SQL in mock: ${sql}`)
        },
        first: async <T>(): Promise<T | null> => {
          if (sql.startsWith('UPDATE samples_queue') && sql.includes('RETURNING')) {
            const [sampled_at] = args as [number, number]
            const result = pickAtomic(sampled_at)
            return (result as unknown as T) ?? null
          }
          throw new Error(`Unhandled first() SQL in mock: ${sql}`)
        },
      }),
    }),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const out: unknown[] = []
      for (const s of statements) out.push(await s.run())
      return out
    },
  } as unknown as D1Database
}

describe('enqueueRankings', () => {
  it('全新 entries 全部入队', async () => {
    const db = makeMockD1()
    const result = await enqueueRankings(db, 1001, [
      { reportCode: 'AAA', fightID: 1, durationMs: 100_000 },
      { reportCode: 'BBB', fightID: 2, durationMs: 200_000 },
    ])
    expect(result.inserted).toBe(2)
  })

  it('重复 (reportCode, fightID) 跳过', async () => {
    const db = makeMockD1()
    await enqueueRankings(db, 1001, [{ reportCode: 'AAA', fightID: 1, durationMs: 100_000 }])
    const result = await enqueueRankings(db, 1001, [
      { reportCode: 'AAA', fightID: 1, durationMs: 100_000 },
      { reportCode: 'CCC', fightID: 3, durationMs: 50_000 },
    ])
    expect(result.inserted).toBe(1)
  })

  it('空 entries 直接返回 inserted=0', async () => {
    const db = makeMockD1()
    const result = await enqueueRankings(db, 1001, [])
    expect(result.inserted).toBe(0)
  })
})

describe('pickNextSample', () => {
  it('无未采样行返回 null', async () => {
    const db = makeMockD1()
    const row = await pickNextSample(db)
    expect(row).toBeNull()
  })

  it('返回未采样行并标记 sampled=1', async () => {
    const db = makeMockD1()
    await enqueueRankings(db, 1001, [{ reportCode: 'AAA', fightID: 1, durationMs: 100_000 }])
    const row = await pickNextSample(db)
    expect(row).not.toBeNull()
    expect(row!.report_code).toBe('AAA')
    expect(row!.sampled).toBe(1)
    // 再次取应当为 null（唯一一行已被标记）
    const second = await pickNextSample(db)
    expect(second).toBeNull()
  })

  it('优先返回 MAX(sampled_at) 最旧的 encounter', async () => {
    const db = makeMockD1()
    // encounter 1001：已有一条采样过、时间较新
    await enqueueRankings(db, 1001, [
      { reportCode: 'OLD', fightID: 1, durationMs: 100_000 },
      { reportCode: 'NEW', fightID: 2, durationMs: 100_000 },
    ])
    await pickNextSample(db) // OLD 或 NEW 之一被标记，sampled_at = now
    // encounter 1002：从未采样过 → MAX(sampled_at)=NULL，应优先
    await enqueueRankings(db, 1002, [{ reportCode: 'NEVER', fightID: 1, durationMs: 100_000 }])
    const row = await pickNextSample(db)
    expect(row!.encounter_id).toBe(1002)
  })
})
```

- [ ] **Step 2: 跑测试，确认全部 fail**

Run: `pnpm test:run src/workers/samplesQueue.test.ts`
Expected: FAIL，报错 `Cannot find module './samplesQueue'`。

- [ ] **Step 3: 写实现**

文件 `src/workers/samplesQueue.ts`：

```ts
/// <reference types="@cloudflare/workers-types" />

/**
 * D1 samples_queue 表的访问层。
 *
 * 表 DDL 见 migrations/0003_create_samples_queue.sql。
 */

export interface SampleQueueRow {
  id: number
  encounter_id: number
  report_code: string
  fight_id: number
  duration_ms: number
  sampled: number
  sampled_at: number | null
  created_at: number
  updated_at: number
}

export interface RankingEntryInput {
  reportCode: string
  fightID: number
  durationMs: number
}

/**
 * 批量入队。底层 INSERT OR IGNORE，重复 (reportCode, fightID) 自动跳过。
 * 返回真实写入条数（基于 D1 batch 各语句的 meta.changes 之和）。
 */
export async function enqueueRankings(
  db: D1Database,
  encounterId: number,
  entries: RankingEntryInput[]
): Promise<{ inserted: number }> {
  if (entries.length === 0) return { inserted: 0 }

  const stmts = entries.map(e =>
    db
      .prepare(
        'INSERT OR IGNORE INTO samples_queue (encounter_id, report_code, fight_id, duration_ms) VALUES (?, ?, ?, ?)'
      )
      .bind(encounterId, e.reportCode, e.fightID, e.durationMs)
  )

  const results = (await db.batch(stmts)) as Array<{ meta?: { changes?: number } }>
  const inserted = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0)
  return { inserted }
}

/**
 * 原子地选出"最久未采样的 encounter"中一条随机未采样行，标记为 sampled=1，并返回行内容。
 * 没有任何未采样行时返回 null。
 *
 * 排序：encounter 内 MAX(sampled_at) NULLS FIRST 升序（从未采样过的 encounter 最优先）。
 */
export async function pickNextSample(db: D1Database): Promise<SampleQueueRow | null> {
  const now = Date.now()
  const result = await db
    .prepare(
      `UPDATE samples_queue
       SET sampled = 1, sampled_at = ?, updated_at = ?
       WHERE id = (
         SELECT s.id
         FROM samples_queue s
         JOIN (
           SELECT encounter_id
           FROM samples_queue
           WHERE EXISTS (
             SELECT 1 FROM samples_queue x
             WHERE x.encounter_id = samples_queue.encounter_id AND x.sampled = 0
           )
           GROUP BY encounter_id
           ORDER BY (MAX(sampled_at) IS NULL) DESC, MAX(sampled_at) ASC
           LIMIT 1
         ) e ON e.encounter_id = s.encounter_id
         WHERE s.sampled = 0
         ORDER BY RANDOM()
         LIMIT 1
       )
       RETURNING id, encounter_id, report_code, fight_id, duration_ms, sampled, sampled_at, created_at, updated_at`
    )
    .bind(now, now)
    .first<SampleQueueRow>()

  return result ?? null
}
```

- [ ] **Step 4: 跑测试，确认全部 pass**

Run: `pnpm test:run src/workers/samplesQueue.test.ts`
Expected: 6 个测试全 PASS。

- [ ] **Step 5: 类型检查 + lint**

Run: `pnpm exec tsc --noEmit && pnpm lint src/workers/samplesQueue.ts src/workers/samplesQueue.test.ts`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/workers/samplesQueue.ts src/workers/samplesQueue.test.ts
git commit -m "feat(workers): 新增 samples_queue D1 访问层 enqueueRankings/pickNextSample"
```

---

### Task 3: 扩展 `EncounterStatistics` 类型

**Files:**

- Modify: `src/types/mitigation.ts:32-51`

- [ ] **Step 1: 加字段**

把 `EncounterStatistics` 接口改为：

```ts
export interface EncounterStatistics {
  encounterId: number
  encounterName: string
  /** 每个伤害技能的中位伤害值 */
  damageByAbility: Record<number, number>
  /** 每个职业的平均最大生命值 */
  maxHPByJob: Record<Job, number>
  /** 每个盾值技能的中位盾值（按 actionId 索引） */
  shieldByAbility: Record<number, number>
  /** 每个盾值技能的暴击盾值（p90） */
  critShieldByAbility: Record<number, number>
  /** 每个治疗技能的中位治疗量 */
  healByAbility: Record<number, number>
  /** 每个治疗技能的暴击治疗量（p90） */
  critHealByAbility: Record<number, number>
  /** 采样的样本总条数（damage 各桶长度之和） */
  sampleSize: number
  /**
   * 敌方每个 abilityId 在已采样的 fight 中"出现过的场数"
   * （单场内同 ability 多次出现只计 1 次）
   * 累计型计数，不参与 reservoir。前端可用 `value / totalFightsSampled` 做出现频率过滤。
   */
  abilityFightCount: Record<number, number>
  /** 累计已采样的 fight 总场数（abilityFightCount 的分母） */
  totalFightsSampled: number
  /** ISO 8601 时间戳 */
  updatedAt: string
}
```

- [ ] **Step 2: 类型检查（会有大量 ts 报错暴露所有需要构造该 interface 的位置）**

Run: `pnpm exec tsc --noEmit`
Expected: `top100Sync.ts` 中构造 `EncounterStatistics` 字面量的位置报错 "missing properties abilityFightCount, totalFightsSampled"。这是预期的——下一个 task 修复。

不要在本任务里 commit，留到 Task 6 末尾一起提交（避免中间状态破坏构建）。

> **如果你正在用 subagent-driven-development**：把 Task 3 与 Task 6 视为同一 commit boundary 内的子步骤；逐个 task 仍按顺序执行 + review，但 commit 推迟到 Task 6 的 Step N。

---

### Task 4: 抽 `extractFightStats` 纯函数

把现有 `extractFightStatistics` 中"提取数据"的部分剥成不写 KV 的纯函数，让 `processOneSample` 可以复用而不写临时 KV。

**Files:**

- Modify: `src/workers/top100Sync.ts:402-481`（`extractFightStatistics` 函数体）

- [ ] **Step 1: 在 `top100Sync.ts` 顶部 (`FightStatistics` 类型附近) 新增导出 helper**

在 `FightStatistics` 接口下方添加：

```ts
/**
 * 单场 fight 提取后的纯数据（不含 reportCode/fightID/encounterId 三件套）
 */
export interface ExtractedFightData {
  damageByAbility: Record<number, number[]>
  maxHPByJob: Record<Job, number[]>
  shieldByAbility: Record<number, number[]>
  healByAbility: Record<number, number[]>
  durationMs: number
  damageEvents: StoredDamageEvent[]
}

/**
 * 从单场 fight 的 report + events 提取四类原始样本 + slim damage events。
 * 不做任何 KV 写入，纯函数易于测试与复用。
 */
export function extractFightStats(
  report: FFLogsV1Report,
  fight: FFLogsV1Report['fights'][number],
  events: FFLogsEvent[]
): ExtractedFightData {
  const damageByAbility = extractDamageData(events)
  const shieldByAbility = extractShieldData(events)
  const maxHPByJob = extractMaxHPData(events, report)
  const healByAbility = extractHealData(events)

  const playerMap = new Map<number, { id: number; name: string; type: string }>()
  for (const actor of report.friendlies ?? []) {
    playerMap.set(actor.id, { id: actor.id, name: actor.name, type: actor.type })
  }
  const abilityMap = new Map<number, FFLogsAbility>()
  for (const ability of report.abilities ?? []) {
    abilityMap.set(ability.gameID, ability)
  }

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

> 把此前的本地 `playerMap` / `abilityMap` / `parseComposition` / `parseDamageEvents` / `slimDamageEvents` 调用从原来的 `extractFightStatistics` 函数体里剪掉、放到这个新函数里。原 `extractFightStatistics` 函数 **暂时保留不动**（Task 8 才会删），它会先重构成调用 `extractFightStats` 然后写临时 KV 的薄封装。

- [ ] **Step 2: 把原 `extractFightStatistics` 函数改成调用 `extractFightStats`**

```ts
export async function extractFightStatistics(
  encounterId: number,
  reportCode: string,
  fightID: number,
  client: FFLogsClientV2,
  kv: KVNamespace
): Promise<void> {
  console.log(`[Statistics] 提取战斗数据: ${reportCode}/${fightID}`)
  try {
    const report = await client.getReport({ reportCode })
    const fight = report.fights.find(f => f.id === fightID)
    if (!fight) throw new Error(`Fight ${fightID} not found`)

    const eventsResponse = await client.getEvents({
      reportCode,
      start: fight.start_time,
      end: fight.end_time,
    })

    const extracted = extractFightStats(report, fight, eventsResponse.events)

    const battleStats: FightStatistics = {
      encounterId,
      reportCode,
      fightID,
      ...extracted,
    }

    await kv.put(
      getFightStatisticsKVKey(encounterId, reportCode, fightID),
      JSON.stringify(battleStats),
      { expirationTtl: 2 * 60 * 60 }
    )
    await updateStatisticsTaskProgress(encounterId, reportCode, fightID, kv)
    console.log(`[Statistics] 完成战斗数据提取: ${reportCode}/${fightID}`)
  } catch (err) {
    console.error(`[Statistics] 提取失败 (${reportCode}/${fightID}):`, err)
    throw err
  }
}
```

- [ ] **Step 3: 在 `top100Sync.test.ts` 给 `extractFightStats` 加 1 个 smoke 测试**

在文件末尾加：

```ts
describe('extractFightStats', () => {
  it('damage / heal / shield / maxHP 全提取，slim events 含 abilityId', () => {
    const fight = { id: 5, start_time: 1000, end_time: 121000 } as FFLogsV1Report['fights'][number]
    const report = {
      fights: [fight],
      friendlies: [{ id: 7, name: 'Healer', type: 'WhiteMage' }],
      abilities: [{ gameID: 50, name: 'Hit', type: 16 }],
      enemies: [],
      enemyPets: [],
      friendlyPets: [],
      lang: 'en',
      title: 't',
      owner: 'o',
      start: 0,
      end: 1,
      zone: 0,
    } as unknown as FFLogsV1Report

    const events = [
      // 一次 boss damage
      {
        type: 'damage',
        timestamp: 1500,
        abilityGameID: 9999,
        unmitigatedAmount: 50000,
        sourceID: 99,
        targetID: 7,
      },
      // 一次 heal（带 maxHitPoints → maxHPByJob 提取）
      {
        type: 'heal',
        timestamp: 1700,
        abilityGameID: 50,
        amount: 1000,
        sourceID: 7,
        targetID: 7,
        targetResources: { maxHitPoints: 80000 },
      },
      // 一次 absorbed → shieldByAbility，statusId = 1002613-1000000
      {
        type: 'absorbed',
        timestamp: 1800,
        abilityGameID: 1002613,
        amount: 3000,
        sourceID: 7,
        targetID: 7,
      },
    ] as unknown as FFLogsEvent[]

    const out = extractFightStats(report, fight, events)
    expect(out.durationMs).toBe(120000)
    expect(out.damageByAbility[9999]).toEqual([50000])
    expect(out.healByAbility[50]).toEqual([1000])
    expect(out.shieldByAbility[2613]).toEqual([3000])
    expect(Object.values(out.maxHPByJob).flat()).toContain(80000)
    // damageEvents 是 slim 形态，含 abilityId
    if (out.damageEvents.length > 0) {
      expect(typeof out.damageEvents[0].abilityId).toBe('number')
    }
  })
})
```

import 行加 `extractFightStats`。需要 import `FFLogsV1Report` / `FFLogsEvent` 已在文件可见或从 `@/types/fflogs` 引。

- [ ] **Step 4: 跑测试**

Run: `pnpm test:run src/workers/top100Sync.test.ts -t "extractFightStats"`
Expected: PASS。

- [ ] **Step 5: 不要 commit**（与 Task 3 同一个 commit boundary，统一在 Task 6 末尾提交）

---

### Task 5: 重写 `buildEncounterTemplate` 为单场版

**Files:**

- Modify: `src/workers/top100Sync.ts:86-141`（旧 `BuildEncounterTemplateInput` + `buildEncounterTemplate`）
- Modify: `src/workers/top100Sync.test.ts:140-296`（旧 `describe('buildEncounterTemplate')` + 旧 `describe('aggregateStatistics — encounter template 覆盖策略 A')`）

**思路**：旧版多场候选 + threshold 过滤完全废弃。新版仅做：单场 events + p50Map + 旧 template → 是否产出新 template。

- [ ] **Step 1: 改写测试 — 删旧 describe，加新 describe**

把原 `describe('buildEncounterTemplate', ...)` 整块删除，替换为：

```ts
describe('buildEncounterTemplate (single-fight)', () => {
  function makeSlim(abilityId: number, time: number, damage = 1000): StoredDamageEvent {
    return { name: `a-${abilityId}`, time, damage, type: 'aoe', damageType: 'magical', abilityId }
  }

  it('无旧模板 → 用本场骨架产出新模板', () => {
    const events = [makeSlim(1, 1, 100), makeSlim(2, 2, 200)]
    const result = buildEncounterTemplate({
      fightDurationMs: 120_000,
      fightEvents: events,
      p50Map: { 1: 555, 2: 666 },
      oldTemplate: null,
    })
    expect(result).not.toBeNull()
    expect(result!.templateSourceDurationMs).toBe(120_000)
    expect(result!.events).toHaveLength(2)
    const byId = Object.fromEntries(result!.events.map(e => [e.abilityId!, e.damage]))
    expect(byId[1]).toBe(555)
    expect(byId[2]).toBe(666)
  })

  it('本场更长 → 覆盖', () => {
    const oldTemplate = {
      encounterId: 1,
      events: [],
      templateSourceDurationMs: 100_000,
      updatedAt: 'x',
    }
    const result = buildEncounterTemplate({
      fightDurationMs: 100_001,
      fightEvents: [makeSlim(1, 1)],
      p50Map: {},
      oldTemplate,
    })
    expect(result).not.toBeNull()
    expect(result!.templateSourceDurationMs).toBe(100_001)
  })

  it('本场等长 → 不覆盖（严格 >）', () => {
    const oldTemplate = {
      encounterId: 1,
      events: [],
      templateSourceDurationMs: 100_000,
      updatedAt: 'x',
    }
    const result = buildEncounterTemplate({
      fightDurationMs: 100_000,
      fightEvents: [makeSlim(1, 1)],
      p50Map: {},
      oldTemplate,
    })
    expect(result).toBeNull()
  })

  it('本场更短 → 不覆盖', () => {
    const oldTemplate = {
      encounterId: 1,
      events: [],
      templateSourceDurationMs: 100_000,
      updatedAt: 'x',
    }
    const result = buildEncounterTemplate({
      fightDurationMs: 50_000,
      fightEvents: [makeSlim(1, 1)],
      p50Map: {},
      oldTemplate,
    })
    expect(result).toBeNull()
  })

  it('damage 字段用 p50Map 覆盖，无 p50 时 fallback 到原值', () => {
    const result = buildEncounterTemplate({
      fightDurationMs: 100,
      fightEvents: [makeSlim(1, 1, 9999), makeSlim(2, 2, 8888)],
      p50Map: { 1: 500 },
      oldTemplate: null,
    })
    const byId = Object.fromEntries(result!.events.map(e => [e.abilityId!, e.damage]))
    expect(byId[1]).toBe(500)
    expect(byId[2]).toBe(8888)
  })

  it('每个事件带不同的 nanoid id', () => {
    const result = buildEncounterTemplate({
      fightDurationMs: 100,
      fightEvents: [makeSlim(1, 1), makeSlim(2, 2), makeSlim(3, 3)],
      p50Map: {},
      oldTemplate: null,
    })
    const ids = result!.events.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/\S+/)
  })

  it('空 events → 空 template（仍写）', () => {
    const result = buildEncounterTemplate({
      fightDurationMs: 100,
      fightEvents: [],
      p50Map: {},
      oldTemplate: null,
    })
    expect(result).not.toBeNull()
    expect(result!.events).toHaveLength(0)
  })
})
```

也把整个 `describe('aggregateStatistics — encounter template 覆盖策略 A', ...)` 块删除（被 Task 6 的 `processOneSample` 测试取代）。

- [ ] **Step 2: 改写实现**

把 `top100Sync.ts:86-141` 的 `BuildEncounterTemplateInput` + `buildEncounterTemplate` 整块替换为：

```ts
interface BuildEncounterTemplateInput {
  /** 本场 fight 的时长（毫秒） */
  fightDurationMs: number
  /** 本场 fight 的 slim damage events */
  fightEvents: StoredDamageEvent[]
  /** abilityId → p50 伤害（来自最新 statistics 的 calculatePercentiles 输出） */
  p50Map: Record<number, number>
  /** 旧 template（KV 中的当前值），null 表示不存在 */
  oldTemplate: EncounterTemplate | null
}

/**
 * 单场版 encounter template 构建。
 *
 * 行为：
 * - 仅当 `fightDurationMs > oldTemplate.templateSourceDurationMs`（或旧 template 不存在）时返回新 template
 * - 不做 abilityId 出现场数过滤；前端可用 `EncounterStatistics.abilityFightCount` 自行过滤
 * - 每个保留事件的 `damage` 用 `p50Map[abilityId]` 覆盖；无 p50 时保留原 damage
 * - 每个事件重新 generateId
 *
 * 返回 null 表示"无需写入"（不是错误）。
 */
export function buildEncounterTemplate(input: BuildEncounterTemplateInput): {
  events: EncounterTemplateEvent[]
  templateSourceDurationMs: number
} | null {
  const { fightDurationMs, fightEvents, p50Map, oldTemplate } = input

  if (oldTemplate && fightDurationMs <= oldTemplate.templateSourceDurationMs) {
    return null
  }

  const events: EncounterTemplateEvent[] = fightEvents.map(e => ({
    id: generateId(),
    name: e.name,
    time: e.time,
    damage: p50Map[e.abilityId ?? 0] ?? e.damage,
    type: e.type,
    damageType: e.damageType,
    packetId: e.packetId,
    snapshotTime: e.snapshotTime,
    abilityId: e.abilityId,
  }))

  return { events, templateSourceDurationMs: fightDurationMs }
}
```

- [ ] **Step 3: 跑测试，仅 buildEncounterTemplate 相关用例**

Run: `pnpm test:run src/workers/top100Sync.test.ts -t "buildEncounterTemplate"`
Expected: 7 个新用例全 PASS。

- [ ] **Step 4: 检查类型**

Run: `pnpm exec tsc --noEmit`
Expected: 仍有 `EncounterStatistics` 缺字段相关错误（来自 `aggregateStatistics`），但 `buildEncounterTemplate` 旧调用方现在不存在。**aggregateStatistics 中的旧 `buildEncounterTemplate` 调用还会编译失败** —— 这是预期，Task 6 删 aggregateStatistics 时会一起解决。

- [ ] **Step 5: 不 commit**（同上 commit boundary）

---

### Task 6: 新增 `processOneSample` 主流程 + commit Tasks 3-6

**Files:**

- Modify: `src/workers/top100Sync.ts`（新增 `processOneSample`；改 `aggregateStatistics` 末尾的 statistics 字面量）
- Modify: `src/workers/top100Sync.test.ts`（新增 processOneSample describes）

- [ ] **Step 1: 写测试 — `processOneSample` 各分支**

在测试文件末尾加：

```ts
describe('processOneSample', () => {
  const encounterId = 1234
  const encounterName = 'Test Encounter'

  function setupEnv(
    overrides: {
      queueRow?: SampleQueueRow | null
      extracted?: ExtractedFightData
    } = {}
  ) {
    const kv = createMockKV()
    const db = {
      _picked: overrides.queueRow ?? null,
    } as unknown as D1Database
    // pickNextSample 通过模块 mock，避免真的拼 SQL
    return { kv, db, extracted: overrides.extracted }
  }

  it('队列空 → 直接返回 false，KV 无变更', async () => {
    const kv = createMockKV()
    const db = makeMockD1Empty()
    const ranOnce = await processOneSample({
      db,
      kv,
      // 强制注入：当 db 没行时 fetcher 不应被调用
      fetchExtracted: async () => {
        throw new Error('should not be called')
      },
      lookupEncounterName: () => encounterName,
    })
    expect(ranOnce).toBe(false)
    expect(kv._store.size).toBe(0)
  })

  it('首次采样：写 samples / statistics / template，且累加 abilityFightCount', async () => {
    const kv = createMockKV()
    const db = makeMockD1WithRow({
      id: 1,
      encounter_id: encounterId,
      report_code: 'A',
      fight_id: 1,
      duration_ms: 120_000,
      sampled: 0,
      sampled_at: null,
      created_at: 0,
      updated_at: 0,
    })
    const extracted: ExtractedFightData = {
      damageByAbility: { 9999: [50_000, 60_000], 8888: [10_000] },
      shieldByAbility: { 2613: [3000] },
      maxHPByJob: { WHM: [80_000] } as Record<Job, number[]>,
      healByAbility: { 50: [1000, 1500] },
      durationMs: 120_000,
      damageEvents: [
        {
          name: 'a-9999',
          time: 1,
          damage: 55_000,
          type: 'aoe',
          damageType: 'magical',
          abilityId: 9999,
        },
        {
          name: 'a-9999',
          time: 5,
          damage: 55_000,
          type: 'aoe',
          damageType: 'magical',
          abilityId: 9999,
        }, // 同 ability 同场，去重后仍只 +1
        {
          name: 'a-8888',
          time: 7,
          damage: 10_000,
          type: 'aoe',
          damageType: 'magical',
          abilityId: 8888,
        },
      ],
    }

    const ranOnce = await processOneSample({
      db,
      kv,
      fetchExtracted: async () => extracted,
      lookupEncounterName: () => encounterName,
    })
    expect(ranOnce).toBe(true)

    const samples = (await kv.get(getSamplesKVKey(encounterId), 'json')) as EncounterSamples
    expect(samples.damageByAbility[9999]).toEqual([50_000, 60_000])
    expect(samples.healByAbility[50]).toEqual([1000, 1500])

    const stats = (await kv.get(getStatisticsKVKey(encounterId), 'json')) as EncounterStatistics
    expect(stats.totalFightsSampled).toBe(1)
    // ability 9999 出现过（不论几次）→ count = 1
    expect(stats.abilityFightCount[9999]).toBe(1)
    expect(stats.abilityFightCount[8888]).toBe(1)
    // p50 算出来非 0
    expect(stats.damageByAbility[9999]).toBeGreaterThan(0)

    const tpl = (await kv.get(getEncounterTemplateKVKey(encounterId), 'json')) as EncounterTemplate
    expect(tpl.templateSourceDurationMs).toBe(120_000)
    expect(tpl.events.length).toBeGreaterThan(0)
  })

  it('第二次采样：abilityFightCount/totalFightsSampled 累加，旧字段不丢', async () => {
    const kv = createMockKV()
    // 预置：第一次跑后的 statistics
    await kv.put(
      getStatisticsKVKey(encounterId),
      JSON.stringify({
        encounterId,
        encounterName,
        damageByAbility: { 9999: 50000 },
        maxHPByJob: {},
        shieldByAbility: {},
        critShieldByAbility: {},
        healByAbility: {},
        critHealByAbility: {},
        sampleSize: 2,
        abilityFightCount: { 9999: 1, 8888: 1 },
        totalFightsSampled: 1,
        updatedAt: 'old',
      } satisfies EncounterStatistics)
    )
    await kv.put(
      getSamplesKVKey(encounterId),
      JSON.stringify({
        encounterId,
        damageByAbility: { 9999: [50_000, 60_000], 8888: [10_000] },
        shieldByAbility: {},
        maxHPByJob: {},
        healByAbility: {},
        updatedAt: 'old',
      })
    )

    const db = makeMockD1WithRow({
      id: 2,
      encounter_id: encounterId,
      report_code: 'B',
      fight_id: 1,
      duration_ms: 100_000,
      sampled: 0,
      sampled_at: null,
      created_at: 0,
      updated_at: 0,
    })
    const extracted: ExtractedFightData = {
      damageByAbility: { 9999: [70_000], 7777: [20_000] }, // 8888 本场没出现
      shieldByAbility: {},
      maxHPByJob: {} as Record<Job, number[]>,
      healByAbility: {},
      durationMs: 100_000,
      damageEvents: [
        {
          name: 'a-9999',
          time: 1,
          damage: 70_000,
          type: 'aoe',
          damageType: 'magical',
          abilityId: 9999,
        },
        {
          name: 'a-7777',
          time: 2,
          damage: 20_000,
          type: 'aoe',
          damageType: 'magical',
          abilityId: 7777,
        },
      ],
    }

    await processOneSample({
      db,
      kv,
      fetchExtracted: async () => extracted,
      lookupEncounterName: () => encounterName,
    })

    const stats = (await kv.get(getStatisticsKVKey(encounterId), 'json')) as EncounterStatistics
    expect(stats.totalFightsSampled).toBe(2)
    expect(stats.abilityFightCount[9999]).toBe(2) // 两场都出现
    expect(stats.abilityFightCount[8888]).toBe(1) // 只第一场
    expect(stats.abilityFightCount[7777]).toBe(1) // 只第二场
  })

  it('本场更短 → template 不更新', async () => {
    const kv = createMockKV()
    await kv.put(
      getEncounterTemplateKVKey(encounterId),
      JSON.stringify({
        encounterId,
        events: [],
        templateSourceDurationMs: 999_000,
        updatedAt: 'old',
      } satisfies EncounterTemplate)
    )

    const db = makeMockD1WithRow({
      id: 3,
      encounter_id: encounterId,
      report_code: 'C',
      fight_id: 1,
      duration_ms: 100_000,
      sampled: 0,
      sampled_at: null,
      created_at: 0,
      updated_at: 0,
    })

    await processOneSample({
      db,
      kv,
      fetchExtracted: async () => ({
        damageByAbility: {},
        shieldByAbility: {},
        maxHPByJob: {} as Record<Job, number[]>,
        healByAbility: {},
        durationMs: 100_000,
        damageEvents: [],
      }),
      lookupEncounterName: () => encounterName,
    })
    const tpl = (await kv.get(getEncounterTemplateKVKey(encounterId), 'json')) as EncounterTemplate
    expect(tpl.templateSourceDurationMs).toBe(999_000) // 旧值未变
  })
})

// 测试用 D1 mock helper
function makeMockD1Empty(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => null }),
    }),
  } as unknown as D1Database
}
function makeMockD1WithRow(row: SampleQueueRow): D1Database {
  let consumed = false
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          if (consumed) return null
          consumed = true
          return row
        },
      }),
    }),
  } as unknown as D1Database
}
```

文件顶部的 import 行加：

```ts
import {
  // ...existing
  processOneSample,
  type ExtractedFightData,
} from './top100Sync'
import type { SampleQueueRow } from './samplesQueue'
import type { EncounterSamples } from './top100Sync' // 已在文件中导出
import type { EncounterStatistics } from '@/types/mitigation'
import type { Job } from '@/data/jobs'
```

- [ ] **Step 2: 跑测试，确认 processOneSample 相关全 fail**

Run: `pnpm test:run src/workers/top100Sync.test.ts -t "processOneSample"`
Expected: FAIL，报 `processOneSample is not exported`。

- [ ] **Step 3: 写 `processOneSample` 实现**

在 `top100Sync.ts` 的 `aggregateStatistics` **下方** 新增（aggregateStatistics 暂时还在；Task 8 才删）：

```ts
import { pickNextSample, type SampleQueueRow } from './samplesQueue'
import { ALL_ENCOUNTERS } from '@/data/raidEncounters'

interface ProcessOneSampleDeps {
  db: D1Database
  kv: KVNamespace
  /** 默认实现拉 fflogs report+events 并跑 extractFightStats；测试可注入纯函数 */
  fetchExtracted: (row: SampleQueueRow) => Promise<ExtractedFightData>
  /** encounterId → 显示名（默认查 ALL_ENCOUNTERS） */
  lookupEncounterName: (encounterId: number) => string
}

/** 真实环境用的默认 fetcher 工厂 */
export function makeDefaultFetchExtracted(client: FFLogsClientV2) {
  return async (row: SampleQueueRow): Promise<ExtractedFightData> => {
    const report = await client.getReport({ reportCode: row.report_code })
    const fight = report.fights.find(f => f.id === row.fight_id)
    if (!fight) throw new Error(`Fight ${row.fight_id} not found in ${row.report_code}`)
    const eventsResponse = await client.getEvents({
      reportCode: row.report_code,
      start: fight.start_time,
      end: fight.end_time,
    })
    return extractFightStats(report, fight, eventsResponse.events)
  }
}

export function defaultLookupEncounterName(encounterId: number): string {
  return ALL_ENCOUNTERS.find(e => e.id === encounterId)?.name ?? `encounter-${encounterId}`
}

/**
 * 单 cron tick 处理一条采样。
 *
 * 返回 true = 处理了一条；false = 队列空。
 */
export async function processOneSample(deps: ProcessOneSampleDeps): Promise<boolean> {
  const { db, kv, fetchExtracted, lookupEncounterName } = deps

  const row = await pickNextSample(db)
  if (!row) {
    console.log('[Sample-tick] 队列空，跳过')
    return false
  }

  const encounterId = row.encounter_id
  const encounterName = lookupEncounterName(encounterId)
  console.log(
    `[Sample-tick] 处理 encounter=${encounterId} report=${row.report_code} fight=${row.fight_id}`
  )

  // 1. 拉单场提取
  const extracted = await fetchExtracted(row)

  // 2. 读旧 samples → reservoir merge → 写新 samples（无 TTL）
  const oldSamplesRaw = await kv.get(getSamplesKVKey(encounterId), 'json')
  const oldSamples = (oldSamplesRaw as EncounterSamples | null) ?? {
    encounterId,
    damageByAbility: {},
    maxHPByJob: {} as Record<Job, number[]>,
    shieldByAbility: {},
    healByAbility: {},
    updatedAt: '',
  }

  const mergedDamage = mergeRecord(oldSamples.damageByAbility, extracted.damageByAbility)
  const mergedShield = mergeRecord(oldSamples.shieldByAbility, extracted.shieldByAbility)
  const mergedHeal = mergeRecord(oldSamples.healByAbility ?? {}, extracted.healByAbility)
  const mergedMaxHP = mergeRecordStr(
    oldSamples.maxHPByJob as unknown as Record<string, number[]>,
    extracted.maxHPByJob as unknown as Record<string, number[]>
  )

  const newSamples: EncounterSamples = {
    encounterId,
    damageByAbility: mergedDamage,
    maxHPByJob: mergedMaxHP as unknown as Record<Job, number[]>,
    shieldByAbility: mergedShield,
    healByAbility: mergedHeal,
    updatedAt: new Date().toISOString(),
  }
  await kv.put(getSamplesKVKey(encounterId), JSON.stringify(newSamples))

  // 3. 读旧 statistics（取 abilityFightCount / totalFightsSampled） → 累加 → 重算 percentile → 写
  const oldStatsRaw = await kv.get(getStatisticsKVKey(encounterId), 'json')
  const oldStats = oldStatsRaw as EncounterStatistics | null
  const oldAbilityFightCount = oldStats?.abilityFightCount ?? {}
  const oldTotalFights = oldStats?.totalFightsSampled ?? 0

  // 本场出现过的 distinct abilityId（去重）
  const distinctAbilityIds = new Set<number>(
    Object.keys(extracted.damageByAbility).map(k => Number(k))
  )
  const abilityFightCount: Record<number, number> = { ...oldAbilityFightCount }
  for (const id of distinctAbilityIds) {
    abilityFightCount[id] = (abilityFightCount[id] ?? 0) + 1
  }

  const statistics: EncounterStatistics = {
    encounterId,
    encounterName,
    damageByAbility: calculatePercentiles(mergedDamage),
    maxHPByJob: calculatePercentiles(mergedMaxHP as unknown as Record<Job, number[]>),
    shieldByAbility: calculatePercentiles(mergedShield),
    healByAbility: calculatePercentiles(mergedHeal),
    critHealByAbility: calculatePercentiles(mergedHeal, 90),
    critShieldByAbility: calculatePercentiles(mergedShield, 90),
    sampleSize: Object.values(mergedDamage).reduce((sum, arr) => sum + arr.length, 0),
    abilityFightCount,
    totalFightsSampled: oldTotalFights + 1,
    updatedAt: new Date().toISOString(),
  }
  await kv.put(getStatisticsKVKey(encounterId), JSON.stringify(statistics))

  // 4. template：仅当本场更长才覆盖
  const oldTemplateRaw = await kv.get(getEncounterTemplateKVKey(encounterId), 'json')
  const oldTemplate = oldTemplateRaw as EncounterTemplate | null
  const built = buildEncounterTemplate({
    fightDurationMs: extracted.durationMs,
    fightEvents: extracted.damageEvents,
    p50Map: statistics.damageByAbility,
    oldTemplate,
  })
  if (built) {
    const newTemplate: EncounterTemplate = {
      encounterId,
      events: built.events,
      templateSourceDurationMs: built.templateSourceDurationMs,
      updatedAt: new Date().toISOString(),
    }
    await kv.put(getEncounterTemplateKVKey(encounterId), JSON.stringify(newTemplate))
    console.log(
      `[Sample-tick] template 更新: encounter=${encounterId}, duration=${built.templateSourceDurationMs}ms, events=${built.events.length}`
    )
  }

  return true
}

/** 工具：reservoir merge `Record<number, number[]>` */
function mergeRecord(
  base: Record<number, number[]>,
  incoming: Record<number, number[]>
): Record<number, number[]> {
  const out: Record<number, number[]> = { ...base }
  for (const [id, values] of Object.entries(incoming)) {
    const key = Number(id)
    out[key] = mergeWithReservoirSampling(out[key] ?? [], values)
  }
  return out
}
function mergeRecordStr(
  base: Record<string, number[]>,
  incoming: Record<string, number[]>
): Record<string, number[]> {
  const out: Record<string, number[]> = { ...base }
  for (const [key, values] of Object.entries(incoming)) {
    out[key] = mergeWithReservoirSampling(out[key] ?? [], values)
  }
  return out
}
```

> 顶部 import 已经包含 `FFLogsClientV2`，新增 `import { pickNextSample, type SampleQueueRow } from './samplesQueue'` 和 `import { ALL_ENCOUNTERS } from '@/data/raidEncounters'` 即可。

- [ ] **Step 4: 同时把 `aggregateStatistics` 写 statistics 字面量补 `abilityFightCount: {}` / `totalFightsSampled: 0`**

`aggregateStatistics` 仍存在（Task 8 才删），但因为 `EncounterStatistics` 加了字段，旧字面量编译会失败。临时给它加：

```ts
const statistics: EncounterStatistics = {
  // ...existing fields
  abilityFightCount: {}, // 旧 batch 流程不再追踪，留 {} 不破坏类型
  totalFightsSampled: task.totalFights,
  updatedAt: new Date().toISOString(),
}
```

> 这是过渡。Task 8 会把整个 `aggregateStatistics` 删掉。

- [ ] **Step 5: 跑全量测试**

Run: `pnpm test:run src/workers/`
Expected: 所有现存 + 新增测试 PASS。注意旧的 `aggregateStatistics` 测试已经在 Task 5 删除。

- [ ] **Step 6: 类型 + lint**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 全 PASS。

- [ ] **Step 7: Commit Tasks 3-6 一起**

```bash
git add src/types/mitigation.ts src/workers/top100Sync.ts src/workers/top100Sync.test.ts
git commit -m "feat(workers): 新增 processOneSample + 单场版 buildEncounterTemplate + abilityFightCount 累加"
```

---

### Task 7: 改造 `syncEncounter` —— 写 D1 队列，不再推 statistics queue

**Files:**

- Modify: `src/workers/top100Sync.ts:332-397`（`syncEncounter` 整个函数体）
- Modify: `src/workers/top100Sync.ts`（顶部 import 加 D1）

- [ ] **Step 1: 写测试 — `syncEncounter` 新行为**

在 `top100Sync.test.ts` 末尾加：

```ts
describe('syncEncounter (new behavior)', () => {
  it('写 top100 KV（无 TTL）+ 入队所有 entries 到 D1', async () => {
    const kv = createMockKV()
    const inserted: Array<{
      encounterId: number
      reportCode: string
      fightID: number
      durationMs: number
    }> = []
    const db = {
      batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
        // 不真正执行；用 binds 反推（mock 简化：测试改用 enqueueRankings 直接路径）
        return stmts.map(() => ({ meta: { changes: 1 } }))
      },
      prepare: () => ({
        bind: (encounterId: number, reportCode: string, fightID: number, durationMs: number) => {
          inserted.push({ encounterId, reportCode, fightID, durationMs })
          return { run: async () => ({ meta: { changes: 1 } }) }
        },
      }),
    } as unknown as D1Database

    const fakeClient = {
      getEncounterRankings: async () => ({
        encounterName: 'TestE',
        entries: [
          { reportCode: 'R1', fightID: 1, duration: 100_000 } as unknown as RankingEntry,
          { reportCode: 'R2', fightID: 1, duration: 200_000 } as unknown as RankingEntry,
        ],
      }),
    } as unknown as FFLogsClientV2

    const encounter = { id: 1234, name: 'TestE', shortName: 'TE' } as RaidEncounter

    await syncEncounter(encounter, fakeClient, kv, db)

    // top100 已写
    const top100 = (await kv.get(getTop100KVKey(1234), 'json')) as Top100Data
    expect(top100.entries).toHaveLength(2)

    // D1 入队全部 entries
    expect(inserted).toHaveLength(2)
    expect(inserted[0].reportCode).toBe('R1')
    expect(inserted[0].durationMs).toBe(100_000)
  })
})
```

import 行需加：`import type { RankingEntry } from './fflogsClientV2'`、`import type { RaidEncounter } from '@/data/raidEncounters'`、`import { syncEncounter, type Top100Data } from './top100Sync'`。

- [ ] **Step 2: 跑测试，预期 fail（签名不匹配 D1 参数）**

Run: `pnpm test:run src/workers/top100Sync.test.ts -t "syncEncounter \\(new"`
Expected: FAIL（参数数量不对，或行为不符）。

- [ ] **Step 3: 改写 `syncEncounter`**

把 `top100Sync.ts:332-397` 的 `syncEncounter` 完整替换为：

```ts
/**
 * 为单个遭遇战同步 TOP100 数据：
 * 1. 拉 rankings → 写 top100:encounter:{id}（无 TTL）
 * 2. 把所有 entries (reportCode, fightID, durationMs) 入 D1 samples_queue（INSERT OR IGNORE）
 *
 * 不再随机抽 10 场也不推 statistics queue。统计任务由短间隔 cron 通过 D1 队列驱动。
 */
export async function syncEncounter(
  encounter: RaidEncounter,
  client: FFLogsClientV2,
  kv: KVNamespace,
  db: D1Database
): Promise<void> {
  console.log(`[TOP100] 同步遭遇战: ${encounter.shortName} (id=${encounter.id})`)

  const result = await client.getEncounterRankings({ encounterId: encounter.id })

  const encounterName = result.encounterName || encounter.name
  const now = new Date().toISOString()

  const top100Data: Top100Data = {
    encounterId: encounter.id,
    encounterName,
    entries: result.entries,
    updatedAt: now,
  }
  await kv.put(getTop100KVKey(encounter.id), JSON.stringify(top100Data))

  // 入队所有 entries
  if (result.entries.length > 0) {
    const enqueueInputs = result.entries.map(e => ({
      reportCode: e.reportCode,
      fightID: e.fightID,
      // RankingEntry 的 duration 字段语义见 fflogsClientV2.ts；通常已是毫秒
      durationMs:
        typeof (e as unknown as { duration?: number }).duration === 'number'
          ? (e as unknown as { duration: number }).duration
          : 0,
    }))
    const { inserted } = await enqueueRankings(db, encounter.id, enqueueInputs)
    console.log(`[TOP100] ${encounter.shortName}: 入队 ${inserted}/${enqueueInputs.length} 条`)
  }

  console.log(`[TOP100] ${encounter.shortName}: 已同步 ${result.entries.length} 条记录`)
}
```

> 顶部 import 加 `import { enqueueRankings } from './samplesQueue'`。
> 同时 `syncAllTop100` 函数签名也要 +`db: D1Database`，并把内部 `syncEncounter(encounter, client, kv)` 改为 `syncEncounter(encounter, client, kv, db)`。

- [ ] **Step 4: 检查 RankingEntry 是否有 duration 字段**

Run: `Grep "duration" src/workers/fflogsClientV2.ts` 看有没有 `duration` 字段。

如果没有，回退方案：在 `syncEncounter` 里 `durationMs: 0`，并加 TODO 注释说明 duration 可在 sample-tick 时从 fight 中拿到（实际不影响 sample 选取，仅供未来 dashboard 用）。

如果有，按现有字段名取。

- [ ] **Step 5: 跑测试**

Run: `pnpm test:run src/workers/top100Sync.test.ts -t "syncEncounter \\(new"`
Expected: PASS。

- [ ] **Step 6: 类型 + lint**

Run: `pnpm exec tsc --noEmit && pnpm lint src/workers/top100Sync.ts src/workers/top100Sync.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/workers/top100Sync.ts src/workers/top100Sync.test.ts
git commit -m "feat(workers): syncEncounter 改为入队 D1，不再推 statistics queue"
```

---

### Task 8: 删除遗留聚合代码 + cron 路由 + queue 修剪

**Files:**

- Modify: `src/workers/top100Sync.ts`（删 `aggregateStatistics`、`updateStatisticsTaskProgress`、`extractFightStatistics`、`getFightStatisticsKVKey`、`getStatisticsTaskKVKey`、`StatisticsTask` interface、`FightStatistics` interface（除 `ExtractedFightData` 复用部分））
- Modify: `src/workers/top100Sync.test.ts`（删剩余 fight-stats / aggregateStatistics 残留 import）
- Modify: `src/workers/fflogs-proxy.ts`（`Env` 删 `STATISTICS_EXTRACT_QUEUE`；`handleScheduled` 按 `event.cron` 分支；`handleQueue` 删 `extract-statistics` 分支与 `body.reportCode/fightID` 字段）

- [ ] **Step 1: 删 `top100Sync.ts` 中的旧函数与类型**

要删除的（连带 export 与 jsdoc）：

- `aggregateStatistics`（约 538-713 行）
- `updateStatisticsTaskProgress`（约 487-533 行）
- `extractFightStatistics`（约 402-481 行，已经是薄壳，被 `processOneSample` 取代）
- `getFightStatisticsKVKey`（约 158-164 行）
- `getStatisticsTaskKVKey`（约 167-169 行）
- `StatisticsTask` interface（约 172-178 行）
- `FightStatistics` interface（约 53-66 行）—— 但 `ExtractedFightData` 是 Task 4 加的新 interface，**保留**

`EncounterTemplateEvent`、`EncounterTemplate`、`getEncounterTemplateKVKey`、`EncounterSamples`、`getSamplesKVKey`、`Top100Data`、`getTop100KVKey`、`getStatisticsKVKey`、`mergeWithReservoirSampling`、`calculatePercentiles`、`slimDamageEvents`、`extractFightStats`、`buildEncounterTemplate`、`processOneSample`、`syncEncounter`、`syncAllTop100`、`handleGetEncounterTemplate`、`makeDefaultFetchExtracted`、`defaultLookupEncounterName` 全部 **保留**。

- [ ] **Step 2: 修测试文件**

把 `src/workers/top100Sync.test.ts` 中：

- import 行删除 `aggregateStatistics` / `getFightStatisticsKVKey` / `FightStatistics` / `StatisticsTask`
- 已经在 Task 5 删除的 `aggregateStatistics — encounter template 覆盖策略 A` describe 确认已不存在
- 任何残留对上述符号的引用一并清理

Run: `pnpm test:run src/workers/top100Sync.test.ts`
Expected: PASS（应该没有残留引用了）。

- [ ] **Step 3: 改 `fflogs-proxy.ts` 的 `Env`**

```ts
export interface Env {
  FFLOGS_CLIENT_ID?: string
  FFLOGS_CLIENT_SECRET?: string
  SYNC_AUTH_TOKEN?: string
  healerbook: KVNamespace
  healerbook_timelines: D1Database
  TOP100_SYNC_QUEUE: Queue
  // STATISTICS_EXTRACT_QUEUE 已删
  FFLOGS_OAUTH_REDIRECT_URI?: string
  JWT_SECRET?: string
  ALLOWED_ORIGIN?: string
  SENSITIVE_WORDS_HMAC_KEY?: string
}
```

- [ ] **Step 4: 改 `QueueMessageBody` 与 `handleQueue`**

```ts
interface QueueMessageBody {
  type: 'sync-encounter'
  encounterId: number
}

export async function handleQueue(batch: MessageBatch, env: Env): Promise<void> {
  const client = createClient(env)

  for (const message of batch.messages) {
    try {
      const body = message.body as QueueMessageBody
      if (body.type === 'sync-encounter') {
        const encounter = ALL_ENCOUNTERS.find(e => e.id === body.encounterId)
        if (!encounter) {
          console.error(`[Queue] 未找到遭遇战: ${body.encounterId}`)
          message.ack()
          continue
        }
        await syncEncounter(encounter, client, env.healerbook, env.healerbook_timelines)
      } else {
        console.error(`[Queue] 未知的消息类型: ${(body as { type: string }).type}`)
      }
      message.ack()
    } catch (err) {
      console.error('[Queue] 处理失败:', err)
      message.retry()
    }
  }
}
```

> import `extractFightStatistics` 也要从顶部删掉。

- [ ] **Step 5: 改 `handleScheduled` —— 按 `event.cron` 分支**

```ts
import {
  processOneSample,
  makeDefaultFetchExtracted,
  defaultLookupEncounterName,
} from './top100Sync'

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  // event.cron 是 wrangler.toml [triggers.crons] 中触发本次的具体表达式
  if (event.cron === '*/10 * * * *') {
    ctx.waitUntil(runSampleTick(env))
    return
  }
  // 默认（含 "0 */12 * * *"）：触发 TOP100 sync
  ctx.waitUntil(enqueueAllEncounters(env))
}

async function runSampleTick(env: Env): Promise<void> {
  console.log('[Sample-tick] 启动')
  const client = createClient(env)
  const ranOnce = await processOneSample({
    db: env.healerbook_timelines,
    kv: env.healerbook,
    fetchExtracted: makeDefaultFetchExtracted(client),
    lookupEncounterName: defaultLookupEncounterName,
  })
  console.log(`[Sample-tick] 结束 (ranOnce=${ranOnce})`)
}
```

- [ ] **Step 6: 跑全量测试**

Run: `pnpm test:run`
Expected: PASS。

- [ ] **Step 7: 类型 + lint + build 烟测**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add src/workers/top100Sync.ts src/workers/top100Sync.test.ts src/workers/fflogs-proxy.ts
git commit -m "refactor(workers): 下线 aggregate/extract-statistics 旧路径，cron 按 event.cron 分发"
```

---

### Task 9: `wrangler.toml` 加新 cron + 删 statistics 队列绑定

**Files:**

- Modify: `wrangler.toml`

- [ ] **Step 1: 改 `[triggers]`**

把：

```toml
[triggers]
crons = ["0 */12 * * *"]
```

改为：

```toml
[triggers]
crons = ["0 */12 * * *", "*/10 * * * *"]
```

`env.production` section 没有独立 `[triggers]` 块（顶层共享），无需改。

- [ ] **Step 2: 删除 `STATISTICS_EXTRACT_QUEUE` 相关 4 块**

把以下 4 个块整段删除：

```toml
[[queues.producers]]
queue = "statistics-extract-queue"
binding = "STATISTICS_EXTRACT_QUEUE"

[[queues.consumers]]
queue = "statistics-extract-queue"
max_batch_size = 1
max_batch_timeout = 30
max_retries = 3

[[env.production.queues.producers]]
queue = "statistics-extract-queue"
binding = "STATISTICS_EXTRACT_QUEUE"

[[env.production.queues.consumers]]
queue = "statistics-extract-queue"
max_batch_size = 1
max_batch_timeout = 30
max_retries = 3
```

- [ ] **Step 3: 本地 dev dry-run**

Run: `pnpm exec wrangler deploy --dry-run --outdir=.dryrun-out`
Expected: 输出 `Total Upload: ...` 一行 + 列出 cron 表达式 `0 */12 * * *` 与 `*/10 * * * *`，无报错。

> 删 `.dryrun-out` 目录：`rm -rf .dryrun-out`（PowerShell：`Remove-Item -Recurse -Force .dryrun-out`）。

- [ ] **Step 4: Commit**

```bash
git add wrangler.toml
git commit -m "chore(wrangler): 加 sample-tick cron + 删 statistics-extract-queue 绑定"
```

---

### Task 10: 前端读端兼容旧 statistics（可选，只在前端有消费时执行）

**Files:**

- Search-and-modify: 任意 `useStatistics` / `EncounterStatistics` 消费点

- [ ] **Step 1: 找消费点**

Run: `Grep "abilityFightCount\\|totalFightsSampled\\|EncounterStatistics" src/ --type ts --type tsx`

如果**没有**任何前端消费点（只有 worker 写入），跳过本任务。

如果有消费点，按以下原则改：

- 任何 `stats.abilityFightCount[id]` 的读取处，写成 `stats.abilityFightCount?.[id] ?? 0`
- 任何 `stats.totalFightsSampled` 的读取处，写成 `stats.totalFightsSampled ?? 0`

> 旧线上 KV 数据可能尚未被 sample-tick 重写过，缺这两个字段属于过渡态。一旦每个 encounter 都被 sample-tick 跑过一次，字段就齐了。

- [ ] **Step 2: 跑测试 + lint + tsc**

Run: `pnpm test:run && pnpm exec tsc --noEmit && pnpm lint`
Expected: PASS。

- [ ] **Step 3: Commit（仅当有改动）**

```bash
git add src/...
git commit -m "feat: 前端读 statistics 时容忍 abilityFightCount/totalFightsSampled 缺失"
```

---

### Task 11: 集成验收 + 部署 checklist

**Files:** 无

- [ ] **Step 1: 全量验收**

Run（按顺序）：

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test:run
pnpm build
```

Expected: 4 个命令全 PASS。`pnpm build` 输出 `dist/` 大小正常。

- [ ] **Step 2: 写部署 checklist 到 plan 末尾（人手执行用）**

把下面这段贴到本 plan 文件 `## Deployment Checklist` 一节（如不存在则新增）：

````markdown
## Deployment Checklist

部署顺序很关键 —— D1 表必须先于 Worker 上线。

1. **应用 D1 migration（生产）**
   ```bash
   pnpm exec wrangler d1 execute healerbook_timelines --remote \
     --file=migrations/0003_create_samples_queue.sql
   ```
````

验证：

```bash
pnpm exec wrangler d1 execute healerbook_timelines --remote \
  --command="SELECT COUNT(*) FROM samples_queue;"
```

预期返回 0 行。

2. **删除生产 statistics-extract-queue（如已无 in-flight 消息）**
   - Cloudflare dashboard → Workers & Pages → Queues
   - 确认 `statistics-extract-queue` 的 messages backlog 为 0
   - 删除该队列。如果暂时不删，wrangler.toml 删了绑定也不影响（队列变成 orphan）

3. **部署 Worker**

   ```bash
   pnpm workers:deploy
   ```

4. **触发首次 TOP100 sync 把 D1 队列填满**

   等待下一次 `0 */12 * * *` 自动触发，或人手 POST `/api/top100/sync`（需要 `SYNC_AUTH_TOKEN`）。
   验证 D1：

   ```bash
   pnpm exec wrangler d1 execute healerbook_timelines --remote \
     --command="SELECT encounter_id, COUNT(*) FROM samples_queue GROUP BY encounter_id;"
   ```

5. **观察 sample-tick 进度**
   - 等待 10min，看日志 `[Sample-tick]`
   - 验证统计已更新：
     ```bash
     curl https://xivhealer.com/api/statistics/<encounterId>
     ```
     响应中应含 `totalFightsSampled` 与 `abilityFightCount` 两个新字段。

6. **（可选）清理旧临时 KV**
   `stats-task:*` / `fight-stats:*` / `fight-completed:*` / `stats-lock:*` 都有 2h TTL，无需手动清理 —— 部署后 2h 内自然过期。

````

- [ ] **Step 3: Commit plan 更新**

```bash
git add design/superpowers/plans/2026-05-11-statistics-improve.md
git commit -m "docs(plan): 加 statistics-improve 部署 checklist"
````

---

## Self-Review

- ✅ **Spec coverage**：8 个决策点全部映射到 task —— 去 TTL（Tasks 7/8 中各 KV 写入处）、分层抽取（Task 2 的 SQL）、单 fight/tick（Task 6）、abilityFightCount 不进 reservoir（Task 6）、template 严格 `>`（Task 5）、KV 写次数（不限制，无 task）、D1 加列（Task 1）、旧设施下线（Tasks 8/9）。
- ✅ **Placeholder scan**：每个 Step 都有 exact 命令或 exact 代码块；无 TODO/TBD。
- ✅ **Type consistency**：`processOneSample` 用的 `pickNextSample` / `enqueueRankings` / `extractFightStats` / `buildEncounterTemplate` 签名与各自定义处一致；`SampleQueueRow` / `ExtractedFightData` / `EncounterStatistics` 字段在所有引用处一致。
- ⚠️ **唯一 spec 灰区**：`RankingEntry.duration` 是否真有该字段未在 plan 中验证 —— Task 7 Step 4 显式 `Grep` 一次并降级到 `durationMs: 0`，避免落地时卡壳。

---

## 备注

- 不要给提交信息加 `Co-Authored-By: Claude ...`（`.husky/commit-msg` 会拒）。
- 每个 Task 的 commit 都跑过 lint-staged（pre-commit hook 自动），但 **没跑全量测试**；任务级别的 `pnpm test:run` 由 plan 显式执行。
- 本 plan 不动 `top100Sync.bench.ts` 与 `sensitiveWord*` 相关代码。

---

## Deployment Checklist

部署顺序很关键 —— D1 表必须先于 Worker 上线。

1. **应用 D1 migration（生产）**

   ```bash
   pnpm exec wrangler d1 execute healerbook_timelines --remote \
     --file=migrations/0003_create_samples_queue.sql
   ```

   验证：

   ```bash
   pnpm exec wrangler d1 execute healerbook_timelines --remote \
     --command="SELECT COUNT(*) FROM samples_queue;"
   ```

   预期返回 0 行。

2. **删除生产 statistics-extract-queue（如已无 in-flight 消息）**
   - Cloudflare dashboard → Workers & Pages → Queues
   - 确认 `statistics-extract-queue` 的 messages backlog 为 0
   - 删除该队列。如果暂时不删，wrangler.toml 删了绑定也不影响（队列变成 orphan）

3. **部署 Worker**

   ```bash
   pnpm workers:deploy
   ```

4. **触发首次 TOP100 sync 把 D1 队列填满**

   等待下一次 `0 */12 * * *` 自动触发，或人手 POST `/api/top100/sync`（需要 `SYNC_AUTH_TOKEN`）。
   验证 D1：

   ```bash
   pnpm exec wrangler d1 execute healerbook_timelines --remote \
     --command="SELECT encounter_id, COUNT(*) FROM samples_queue GROUP BY encounter_id;"
   ```

5. **观察 sample-tick 进度**
   - 等待 10min，看日志 `[Sample-tick]`
   - 验证统计已更新：
     ```bash
     curl https://xivhealer.com/api/statistics/<encounterId>
     ```
     响应中应含 `totalFightsSampled` 与 `abilityFightCount` 两个新字段。

6. **（可选）清理旧临时 KV**
   `stats-task:*` / `fight-stats:*` / `fight-completed:*` / `stats-lock:*` 都有 2h TTL，无需手动清理 —— 部署后 2h 内自然过期。

---

## Execution Log

实际执行落地的 commit（按时间顺序）：

| Task         | Commit    | 说明                                                                                          |
| ------------ | --------- | --------------------------------------------------------------------------------------------- |
| 1            | `ba53a77` | feat(d1): 新增 samples_queue 表用于持久化采样队列                                             |
| 2            | `61f9d3c` | feat(workers): 新增 samples_queue D1 访问层 enqueueRankings/pickNextSample                    |
| 2 (followup) | `5c1a389` | test(workers): pickNextSample 加非 null vs 非 null MAX(sampled_at) 排序覆盖                   |
| 3-6          | `62e8072` | feat(workers): 新增 processOneSample + 单场版 buildEncounterTemplate + abilityFightCount 累加 |
| 6 (followup) | `0c86b63` | refactor(workers): 合并 mergeRecord 泛型 + 注释 extractDamageData 的隐式 source 过滤          |
| 7            | `45f0095` | feat(workers): syncEncounter 改为入队 D1，不再推 statistics queue                             |
| 8            | `3dc4ee3` | refactor(workers): 下线 aggregate/extract-statistics 旧路径，cron 按 event.cron 分发          |
| 9            | `67fd87e` | chore(wrangler): 加 sample-tick cron + 删 statistics-extract-queue 绑定                       |
| 10           | `10be239` | test(stats): 补齐 mockStatistics 的 abilityFightCount/totalFightsSampled 字段                 |

集成验收（Task 11 Step 1）通过：tsc / lint 0 错误，`pnpm test:run` 686/686，`pnpm build` 成功。
