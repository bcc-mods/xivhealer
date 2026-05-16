import { describe, it, expect } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { signAccessToken } from '@/workers/jwt'

describe('timelines 路由', () => {
  it('POST /api/timelines 发布:建行 + 作者入白名单', async () => {
    const jwt = await signAccessToken('author-1', 'Author', 'test-secret')
    const res = await SELF.fetch('https://app/api/timelines', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'tlPublishTest000000001', name: '发布测试' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    const editor = await env.healerbook_timelines
      .prepare('SELECT 1 FROM timeline_editors WHERE timeline_id = ? AND user_id = ?')
      .bind(body.id, 'author-1')
      .first()
    expect(editor).not.toBeNull()
  })

  it('GET /api/timelines/:id 对不存在的返回 404', async () => {
    const res = await SELF.fetch('https://app/api/timelines/nonexistent000000001')
    expect(res.status).toBe(404)
  })

  it('GET /api/timelines/:id/connect 升级为 WebSocket', async () => {
    const res = await SELF.fetch('https://app/api/timelines/anydoc000000000000001/connect', {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(101)
  })
})
