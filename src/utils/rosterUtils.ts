import { JOB_MAP } from '../data/jobMap'
import { sortJobsByOrder } from '../data/jobs'
import type { Job } from '../types/timeline'

// 将 allCharacters 的 spec 列表转为按标准职业顺序排列的职业代码列表
export function buildComposition(specs: string[]): string[] {
  const jobs = specs.map(spec => JOB_MAP[spec] ?? spec) as Job[]
  return sortJobsByOrder(jobs)
}
