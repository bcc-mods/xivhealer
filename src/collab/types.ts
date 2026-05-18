import type { Timeline, Composition } from '@/types/timeline'

/**
 * 进 Y.Doc 的协同内容 —— Timeline 去掉外部寻址 / 本地元数据 / 派生字段。
 * 见设计文档 §4、§10。
 */
export type TimelineContent = Omit<
  Timeline,
  | 'id'
  | 'isShared'
  | 'everPublished'
  | 'hasLocalChanges'
  | 'serverVersion'
  | 'statusEvents'
  | 'updatedAt'
>

/**
 * 本地时间轴元数据 —— 不进 Y.Doc,由 IndexedDB `meta` 表管理。
 * 支撑 HomePage 本地列表与 EditorPage 三模式判定。
 */
export interface LocalDocMeta {
  /** 时间轴 id(外部寻址键,也是 IndexedDB 主键) */
  docId: string
  /** 时间轴名称 */
  name: string
  /** 副本 id(0 表示未知) */
  encounterId: number
  /** 创建时间(Unix 秒) */
  createdAt: number
  /** 最近修改时间(Unix 秒) */
  updatedAt: number
  /** 阵容(用于列表卡片职业图标);无则 null */
  composition: Composition | null
  /** FFLogs 来源(用于导入去重索引);无则 undefined */
  fflogsSource?: Timeline['fflogsSource']
  /** 时间轴归属状态：local=本地未发布 / published=我发布的 / visited=我访问过的他人时间轴 */
  kind: 'local' | 'published' | 'visited'
  /** 最近一次打开时间（Unix 秒）—— HomePage 列表排序键 */
  lastViewedAt: number
}
