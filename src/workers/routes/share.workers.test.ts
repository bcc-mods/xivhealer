import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import { signAccessToken } from '@/workers/jwt'

const JWT_SECRET = 'test-secret'
const AUTHOR = { id: 'share-author', name: 'Author' }

async function publishOne(id: string): Promise<string> {
  const jwt = await signAccessToken(AUTHOR.id, AUTHOR.name, JWT_SECRET)
  const res = await SELF.fetch('https://app/api/timelines', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: 'T' }),
  })
  if (res.status !== 201) throw new Error(`publish failed ${res.status}`)
  return id
}

const authHeader = async (userId: string, name: string) => ({
  Authorization: `Bearer ${await signAccessToken(userId, name, JWT_SECRET)}`,
})

describe('GET/PATCH /api/timelines/:id/share', () => {
  it('作者读到开关与空列表', async () => {
    const id = await publishOne('share-get-00000000001')
    const res = await SELF.fetch(`https://app/api/timelines/${id}/share`, {
      headers: await authHeader(AUTHOR.id, AUTHOR.name),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      allowEditRequests: boolean
      editors: unknown[]
      applicants: unknown[]
    }
    expect(body.allowEditRequests).toBe(false)
    expect(body.editors).toEqual([])
    expect(body.applicants).toEqual([])
  })

  it('非作者读 share 返回 403', async () => {
    const id = await publishOne('share-get-00000000002')
    const res = await SELF.fetch(`https://app/api/timelines/${id}/share`, {
      headers: await authHeader('intruder', 'X'),
    })
    expect(res.status).toBe(403)
  })

  it('作者 PATCH 开关后 GET 反映新值', async () => {
    const id = await publishOne('share-patch-0000000001')
    const patch = await SELF.fetch(`https://app/api/timelines/${id}/share`, {
      method: 'PATCH',
      headers: {
        ...(await authHeader(AUTHOR.id, AUTHOR.name)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ allowEditRequests: true }),
    })
    expect(patch.status).toBe(200)
    const res = await SELF.fetch(`https://app/api/timelines/${id}/share`, {
      headers: await authHeader(AUTHOR.id, AUTHOR.name),
    })
    const body = (await res.json()) as { allowEditRequests: boolean }
    expect(body.allowEditRequests).toBe(true)
  })

  it('非作者 PATCH 开关返回 403', async () => {
    const id = await publishOne('share-patch-0000000002')
    const res = await SELF.fetch(`https://app/api/timelines/${id}/share`, {
      method: 'PATCH',
      headers: { ...(await authHeader('intruder', 'X')), 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowEditRequests: true }),
    })
    expect(res.status).toBe(403)
  })
})
