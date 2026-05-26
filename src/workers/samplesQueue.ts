/// <reference types="@cloudflare/workers-types" />

/**
 * D1 samples_queue 表的访问层。
 *
 * 表 DDL 见 migrations/0003_create_samples_queue.sql。
 */

import * as v from 'valibot'

export interface SampleQueueRow {
  id: number
  encounter_id: number
  report_code: string
  fight_id: number
  duration_ms: number
  sampled: number
  /** 整数秒（unix epoch），未采样时为 null */
  sampled_at: number | null
  /** 整数秒（unix epoch） */
  created_at: number
  /** 整数秒（unix epoch），应用层 UPDATE 时显式覆盖 */
  updated_at: number
}

export interface RankingEntryInput {
  reportCode: string
  fightID: number
  durationMs: number
}

export const ENQUEUE_SAMPLES_MAX_REPORTS = 20

/**
 * POST /api/samples-queue/enqueue 请求体 schema
 *
 * 调用方只提供 encounterId + 一批 reportCode；Worker 自行去 FFLogs 拉每个 report，
 * 从中挑 boss === encounterId 且 duration 最长的 fight 入队。
 */
export const EnqueueSamplesRequestSchema = v.object({
  encounterId: v.pipe(v.number(), v.integer()),
  reportCodes: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1))),
    v.minLength(1),
    v.maxLength(ENQUEUE_SAMPLES_MAX_REPORTS)
  ),
})

export function validateEnqueueSamplesRequest(
  input: unknown
): v.SafeParseResult<typeof EnqueueSamplesRequestSchema> {
  return v.safeParse(EnqueueSamplesRequestSchema, input)
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
 * 当前固定只采样 encounterId=SAMPLE_ENCOUNTER_ID 的未采样行：从该 encounter 内按 id DESC
 * 挑最新入队的一条，标记为 sampled=1 并返回行内容。该 encounter 无未采样行时返回 null。
 *
 * 采样策略会随新版本副本发布频繁调整，因此旧的"随机挑 encounter"策略以注释形式保留备查。
 *
 * 非原子：拆成两条独立 SQL；并发下极端情况可能两个调用拿到同一行，结果是 sampled_at 被覆盖、
 * 双方拿到同一行。cron 单实例触发，实际并发概率近 0。
 */
export const SAMPLE_ENCOUNTER_ID = 1085

export async function pickNextSample(db: D1Database): Promise<SampleQueueRow | null> {
  // 旧策略：在仍有未采样行的 encounter 中随机挑一个。
  // 选 encounter 用 `WHERE sampled=0` + DISTINCT 触发 idx_samples_queue_pick 的 skip-scan，
  // 比 GROUP BY HAVING MIN(sampled)=0 的全索引扫描快约 50×（实测 25 万行 21ms→0.4ms）。
  // const encounter = await db
  //   .prepare(
  //     `SELECT DISTINCT encounter_id FROM samples_queue
  //      WHERE sampled = 0
  //      ORDER BY RANDOM()
  //      LIMIT 1`
  //   )
  //   .first<{ encounter_id: number }>()
  // if (!encounter) return null
  // const encounterId = encounter.encounter_id
  const encounterId = SAMPLE_ENCOUNTER_ID

  const picked = await db
    .prepare(
      `SELECT id FROM samples_queue
       WHERE sampled = 0 AND encounter_id = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .bind(encounterId)
    .first<{ id: number }>()
  if (!picked) return null

  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare(
      `UPDATE samples_queue
       SET sampled = 1, sampled_at = ?, updated_at = ?
       WHERE id = ?
       RETURNING id, encounter_id, report_code, fight_id, duration_ms, sampled, sampled_at, created_at, updated_at`
    )
    .bind(now, now, picked.id)
    .first<SampleQueueRow>()

  return result ?? null
}
