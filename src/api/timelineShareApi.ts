/**
 * 时间轴共享 API 客户端
 */

import { HTTPError } from 'ky'
import { apiClient } from './apiClient'
import type { Timeline, Composition } from '@/types/timeline'

export interface PublishResult {
  id: string
  publishedAt: number
}

/** GET /api/timelines/:id 的角色化响应 */
export interface SharedTimelineResponse {
  role: 'editor' | 'viewer'
  authorName: string
  /** viewer 角色携带;editor 角色为 undefined(编辑端连 WS 取全量) */
  snapshot?: Timeline
}

/**
 * 发布:把一条本地时间轴注册为云端时间轴。
 * 服务端可能清洗 id(敏感词),返回(可能变更过的)id。
 */
export async function publishTimeline(id: string, name: string): Promise<PublishResult> {
  try {
    return await apiClient.post('timelines', { json: { id, name } }).json<PublishResult>()
  } catch (err) {
    if (err instanceof HTTPError) throw new Error(err.message)
    throw err
  }
}

export interface MyTimelineItem {
  id: string
  name: string
  publishedAt: number
  updatedAt: number
  composition: Composition | null
}

/** 获取当前登录用户的已发布时间轴列表 */
export async function fetchMyTimelines(): Promise<MyTimelineItem[]> {
  try {
    return await apiClient.get('my/timelines').json<MyTimelineItem[]>()
  } catch (err) {
    if (err instanceof HTTPError && err.response.status === 401) return []
    throw err
  }
}

/** 删除已发布的时间轴(仅作者) */
export async function deleteSharedTimeline(id: string): Promise<void> {
  try {
    await apiClient.delete(`timelines/${id}`)
  } catch (err) {
    if (err instanceof HTTPError) throw new Error(err.message)
    throw err
  }
}

interface RawSharedResponse {
  role: 'editor' | 'viewer'
  authorName: string
  snapshot?: Timeline
}

/**
 * 获取共享时间轴的角色与(viewer 的)snapshot。
 * 已登录时 Worker 据 Authorization 头判定 editor / viewer。
 */
export async function fetchSharedTimeline(id: string): Promise<SharedTimelineResponse> {
  try {
    const raw = await apiClient.get(`timelines/${id}`).json<RawSharedResponse>()
    const result: SharedTimelineResponse = { role: raw.role, authorName: raw.authorName }
    if (raw.snapshot) {
      result.snapshot = {
        ...raw.snapshot,
        id,
        statusEvents: [],
        annotations: raw.snapshot.annotations ?? [],
      }
    }
    return result
  } catch (err) {
    if (err instanceof HTTPError && err.response.status === 404) {
      throw new Error('NOT_FOUND')
    }
    if (err instanceof HTTPError) {
      throw new Error(`HTTP ${err.response.status}`)
    }
    throw err
  }
}
