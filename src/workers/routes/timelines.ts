/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono'
import { vValidator } from '@hono/valibot-validator'
import type { AppEnv } from '../env'
import { requireAuth } from '../middleware/requireAuth'
import { tryReadAuth } from '../middleware/tryReadAuth'
import { CreateTimelineRequestSchema, UpdateTimelineRequestSchema } from '../timelineSchema'
import { generateId } from '@/utils/id'
import * as sensitiveWordFilter from '../sensitiveWordFilter'

const ID_GEN_MAX_ATTEMPTS = 32

interface DbRow {
  id: string
  name: string
  author_id: string
  author_name: string
  published_at: number
  updated_at: number
  version: number
  content: string
}

interface SharedTimeline {
  id: string
  name: string
  authorId: string
  authorName: string
  publishedAt: number
  updatedAt: number
  version: number
  [key: string]: unknown
}

async function generateCleanId(env: AppEnv['Bindings']): Promise<string | null> {
  for (let i = 0; i < ID_GEN_MAX_ATTEMPTS; i++) {
    const id = generateId()
    if (!(await sensitiveWordFilter.containsBannedSubstring(id, env))) return id
  }
  return null
}

function rowToSharedTimeline(row: DbRow): SharedTimeline {
  const content = JSON.parse(row.content) as Record<string, unknown>
  return {
    ...content,
    n: row.name,
    id: row.id,
    name: row.name,
    authorId: row.author_id,
    authorName: row.author_name,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

const app = new Hono<AppEnv>()

app.post('/', requireAuth, vValidator('json', CreateTimelineRequestSchema), async c => {
  const auth = c.get('auth')!
  const { timeline } = c.req.valid('json')
  const now = Math.floor(Date.now() / 1000)
  const newId = await generateCleanId(c.env)
  if (!newId) return c.json({ error: 'id_generation_failed' }, 500)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { n: _n, ...rest } = timeline
  const content = JSON.stringify(rest)

  await c.env.healerbook_timelines
    .prepare(
      'INSERT INTO timelines (id, name, author_id, author_name, published_at, updated_at, version, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(newId, timeline.n, auth.userId, auth.username, now, now, 1, content)
    .run()

  return c.json({ id: newId, publishedAt: now, version: 1 }, 201)
})

app.put('/:id', requireAuth, vValidator('json', UpdateTimelineRequestSchema), async c => {
  const auth = c.get('auth')!
  const id = c.req.param('id')

  const row = await c.env.healerbook_timelines
    .prepare('SELECT * FROM timelines WHERE id = ?')
    .bind(id)
    .first<DbRow>()

  if (!row) return c.json({ error: 'Not found' }, 404)
  if (row.author_id !== auth.userId) return c.json({ error: 'Forbidden' }, 403)

  const { timeline, expectedVersion } = c.req.valid('json')
  const now = Math.floor(Date.now() / 1000)
  const newName = timeline.n ?? row.name
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { n: _n, ...rest } = timeline
  const content = JSON.stringify(rest)

  const dbResult =
    expectedVersion !== undefined
      ? await c.env.healerbook_timelines
          .prepare(
            'UPDATE timelines SET name=?, author_name=?, updated_at=?, version=version+1, content=? WHERE id=? AND version=?'
          )
          .bind(newName, auth.username, now, content, id, expectedVersion)
          .run()
      : await c.env.healerbook_timelines
          .prepare(
            'UPDATE timelines SET name=?, author_name=?, updated_at=?, version=version+1, content=? WHERE id=?'
          )
          .bind(newName, auth.username, now, content, id)
          .run()

  if (dbResult.meta.changes === 0) {
    return c.json(
      { error: 'conflict', serverVersion: row.version, serverUpdatedAt: row.updated_at },
      409
    )
  }

  return c.json({ id, updatedAt: now, version: row.version + 1 })
})

app.get('/:id', async c => {
  const id = c.req.param('id')
  const row = await c.env.healerbook_timelines
    .prepare('SELECT * FROM timelines WHERE id = ?')
    .bind(id)
    .first<DbRow>()

  if (!row) return c.json({ error: 'Not found' }, 404)
  const data = rowToSharedTimeline(row)

  const auth = await tryReadAuth(c)
  const isAuthor = !!auth && auth.userId === data.authorId

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { authorId: _aid, authorName: _an, publishedAt: _pa, version: _v, ...timeline } = data

  return c.json({
    timeline,
    authorName: data.authorName,
    publishedAt: data.publishedAt,
    version: data.version,
    isAuthor,
  })
})

app.delete('/:id', requireAuth, async c => {
  const auth = c.get('auth')!
  const id = c.req.param('id')

  const result = await c.env.healerbook_timelines
    .prepare('DELETE FROM timelines WHERE id = ? AND author_id = ?')
    .bind(id, auth.userId)
    .run()

  if (result.meta.changes === 0) {
    return c.json({ error: 'Not found or forbidden' }, 404)
  }
  return c.body(null, 204)
})

export { app as timelinesRoutes }
