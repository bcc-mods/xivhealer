import { describe, it, expect } from 'vitest'
import {
  enqueueRankings,
  pickNextSample,
  validateEnqueueSamplesRequest,
  ENQUEUE_SAMPLES_MAX_REPORTS,
  type SampleQueueRow,
} from './samplesQueue'

/**
 * 内存 D1 mock：模拟本模块用到的 SQL：
 *   INSERT OR IGNORE INTO samples_queue ...                                  (enqueue)
 *   SELECT DISTINCT encounter_id FROM samples_queue WHERE sampled = 0 ...   (pick step 1)
 *   SELECT id FROM samples_queue WHERE sampled = 0 AND encounter_id = ? ORDER BY id DESC ... (pick step 2)
 *   UPDATE samples_queue SET sampled = 1, ... WHERE id = ? RETURNING ...    (pick step 3)
 */
function makeMockD1(initialRows: SampleQueueRow[] = []): D1Database {
  let nextId = initialRows.reduce((m, r) => Math.max(m, r.id), 0) + 1
  // 深拷贝避免后续 markSampled 改对象时污染调用方传入的 seed
  const rows: SampleQueueRow[] = initialRows.map(r => ({ ...r }))

  function pickRandomEncounterWithUnsampled(): number | null {
    const encounters = [...new Set(rows.filter(r => r.sampled === 0).map(r => r.encounter_id))]
    if (encounters.length === 0) return null
    return encounters[Math.floor(Math.random() * encounters.length)]
  }

  function pickLatestUnsampledId(encounterId: number): number | null {
    const candidates = rows.filter(r => r.encounter_id === encounterId && r.sampled === 0)
    if (candidates.length === 0) return null
    return candidates.reduce((max, r) => (r.id > max ? r.id : max), candidates[0].id)
  }

  function markSampled(id: number, now: number): SampleQueueRow | null {
    const row = rows.find(r => r.id === id)
    if (!row) return null
    row.sampled = 1
    row.sampled_at = now
    row.updated_at = now
    return { ...row }
  }

  return {
    prepare: (sql: string) => ({
      first: async <T>(): Promise<T | null> => {
        if (sql.includes('SELECT DISTINCT encounter_id') && sql.includes('sampled = 0')) {
          const encounterId = pickRandomEncounterWithUnsampled()
          if (encounterId === null) return null
          return { encounter_id: encounterId } as unknown as T
        }
        throw new Error(`Unhandled prepare().first() SQL in mock: ${sql}`)
      },
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
            const now = Math.floor(Date.now() / 1000)
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
          if (
            sql.startsWith('SELECT id FROM samples_queue') &&
            sql.includes('encounter_id = ?') &&
            sql.includes('sampled = 0') &&
            sql.includes('ORDER BY id DESC')
          ) {
            const [encounterId] = args as [number]
            const id = pickLatestUnsampledId(encounterId)
            if (id === null) return null
            return { id } as unknown as T
          }
          if (sql.startsWith('UPDATE samples_queue') && sql.includes('RETURNING')) {
            const [sampled_at, , id] = args as [number, number, number]
            const result = markSampled(id, sampled_at)
            return (result as unknown as T) ?? null
          }
          throw new Error(`Unhandled bind().first() SQL in mock: ${sql}`)
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
    const second = await pickNextSample(db)
    expect(second).toBeNull()
  })

  it('多个 encounter 都有未采样行时，挑中的一定来自这些 encounter', async () => {
    const db = makeMockD1()
    await enqueueRankings(db, 1001, [{ reportCode: 'A', fightID: 1, durationMs: 100_000 }])
    await enqueueRankings(db, 1002, [{ reportCode: 'B', fightID: 1, durationMs: 100_000 }])
    const row = await pickNextSample(db)
    expect(row).not.toBeNull()
    expect([1001, 1002]).toContain(row!.encounter_id)
  })

  it('encounter 内有多条未采样行时，按 id DESC 优先挑最新入队的', async () => {
    const db = makeMockD1()
    await enqueueRankings(db, 1001, [
      { reportCode: 'OLD', fightID: 1, durationMs: 100_000 },
      { reportCode: 'MID', fightID: 2, durationMs: 100_000 },
      { reportCode: 'NEW', fightID: 3, durationMs: 100_000 },
    ])
    const row = await pickNextSample(db)
    expect(row!.report_code).toBe('NEW')
  })

  it('已全部采样过的 encounter 不会被选中', async () => {
    const seed: SampleQueueRow[] = [
      {
        id: 1,
        encounter_id: 1001,
        report_code: 'A1',
        fight_id: 1,
        duration_ms: 100_000,
        sampled: 1,
        sampled_at: 1000,
        created_at: 1000,
        updated_at: 1000,
      },
      {
        id: 2,
        encounter_id: 1002,
        report_code: 'B1',
        fight_id: 1,
        duration_ms: 100_000,
        sampled: 0,
        sampled_at: null,
        created_at: 2000,
        updated_at: 2000,
      },
    ]
    for (let i = 0; i < 20; i++) {
      const row = await pickNextSample(makeMockD1(seed))
      expect(row!.encounter_id).toBe(1002)
    }
  })
})

describe('validateEnqueueSamplesRequest', () => {
  it('合法 encounterId + reportCodes 通过', () => {
    const r = validateEnqueueSamplesRequest({
      encounterId: 101,
      reportCodes: ['AAA', 'BBB'],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output.encounterId).toBe(101)
      expect(r.output.reportCodes).toEqual(['AAA', 'BBB'])
    }
  })

  it('reportCodes 为空数组报错', () => {
    const r = validateEnqueueSamplesRequest({ encounterId: 101, reportCodes: [] })
    expect(r.success).toBe(false)
  })

  it(`reportCodes 超过 ${ENQUEUE_SAMPLES_MAX_REPORTS} 条报错`, () => {
    const codes = Array.from({ length: ENQUEUE_SAMPLES_MAX_REPORTS + 1 }, (_, i) => `C${i}`)
    const r = validateEnqueueSamplesRequest({ encounterId: 101, reportCodes: codes })
    expect(r.success).toBe(false)
  })

  it('encounterId 非整数报错', () => {
    const r = validateEnqueueSamplesRequest({ encounterId: 1.5, reportCodes: ['A'] })
    expect(r.success).toBe(false)
  })

  it('缺失字段报错', () => {
    expect(validateEnqueueSamplesRequest({ reportCodes: ['A'] }).success).toBe(false)
    expect(validateEnqueueSamplesRequest({ encounterId: 101 }).success).toBe(false)
  })
})
