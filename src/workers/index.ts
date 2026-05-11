/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Worker 入口文件
 *
 * 导出 Cloudflare Workers 需要的入口函数：
 * - fetch: HTTP 请求处理
 * - scheduled: Cron 定时任务（按 event.cron 分发，见 handleScheduled）
 */

import { handleFetch, handleScheduled, type Env } from './fflogs-proxy'

export type { Env }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env)
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleScheduled(event, env, ctx)
  },
}
