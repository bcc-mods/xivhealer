/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import { vValidator } from '@hono/valibot-validator'
import * as v from 'valibot'
import type { AppEnv } from '../env'
import { requireAuth } from '../middleware/requireAuth'

const app = new Hono<AppEnv>()

/**
 * 校验调用者是该时间轴作者;是则返回作者行（含 allow_edit_requests），否则 null。
 * 时间轴不存在或调用者非作者都返回 null;调用方统一回 403——
 * 作为作者专用端点的统一守卫,不区分两者。
 */
async function findAuthor(
  env: AppEnv['Bindings'],
  timelineId: string,
  userId: string
): Promise<{ author_id: string; allow_edit_requests: number } | null> {
  const row = await env.healerbook_timelines
    .prepare('SELECT author_id, allow_edit_requests FROM timelines WHERE id = ?')
    .bind(timelineId)
    .first<{ author_id: string; allow_edit_requests: number }>()
  if (!row || row.author_id !== userId) return null
  return row
}

// 作者读:申请开关 + 编辑者列表 + 申请者列表
app.get('/:id/share', requireAuth, async c => {
  const auth = c.get('auth')!
  const id = c.req.param('id')
  const author = await findAuthor(c.env, id, auth.userId)
  if (!author) return c.json({ error: 'Forbidden' }, 403)

  const editors = await c.env.healerbook_timelines
    .prepare(
      'SELECT user_id, user_name FROM timeline_editors WHERE timeline_id = ? AND user_id != ? ORDER BY created_at'
    )
    .bind(id, author.author_id)
    .all<{ user_id: string; user_name: string }>()

  const applicants = await c.env.healerbook_timelines
    .prepare(
      'SELECT user_id, user_name, created_at FROM timeline_edit_requests WHERE timeline_id = ? ORDER BY created_at'
    )
    .bind(id)
    .all<{ user_id: string; user_name: string; created_at: number }>()

  return c.json({
    allowEditRequests: author.allow_edit_requests === 1,
    editors: editors.results.map(r => ({ userId: r.user_id, userName: r.user_name })),
    applicants: applicants.results.map(r => ({
      userId: r.user_id,
      userName: r.user_name,
      createdAt: r.created_at,
    })),
  })
})

const ShareSettingsSchema = v.object({ allowEditRequests: v.boolean() })

// 作者写:申请开关
app.patch('/:id/share', requireAuth, vValidator('json', ShareSettingsSchema), async c => {
  const auth = c.get('auth')!
  const id = c.req.param('id')
  const author = await findAuthor(c.env, id, auth.userId)
  if (!author) return c.json({ error: 'Forbidden' }, 403)
  const { allowEditRequests } = c.req.valid('json')
  await c.env.healerbook_timelines
    .prepare('UPDATE timelines SET allow_edit_requests = ? WHERE id = ?')
    .bind(allowEditRequests ? 1 : 0, id)
    .run()
  return c.json({ allowEditRequests })
})

export { app as shareRoutes }
