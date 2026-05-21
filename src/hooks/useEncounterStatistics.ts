/**
 * 副本统计数据 Hook
 */

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getEncounterStatistics } from '@/api/statistics'
import { useTimelineStore } from '@/store/timelineStore'

export function useEncounterStatistics(encounterId: number | undefined) {
  const setStatistics = useTimelineStore(state => state.setStatistics)

  const query = useQuery({
    queryKey: ['encounterStatistics', encounterId],
    queryFn: () => getEncounterStatistics(encounterId!),
    // encounterId 为 0 表示"其他"（无特定副本），不发统计请求
    enabled: encounterId != null && encounterId > 0,
    staleTime: 1000 * 60 * 60 * 12, // 12 小时
  })

  useEffect(() => {
    setStatistics(query.data ?? null)
  }, [query.data, setStatistics])

  return query
}
