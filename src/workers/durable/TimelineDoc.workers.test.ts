import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { signAccessToken } from '@/workers/jwt'
import { encodeMessage, MSG } from '@/workers/collab/syncProtocol'

describe('TimelineDoc WebSocket 接入', () => {
  it('/connect 返回 101 并升级为 WebSocket', async () => {
    const id = env.TIMELINE_DOC.idFromName('t-conn-1')
    const stub = env.TIMELINE_DOC.get(id)
    const res = await stub.fetch('https://do/connect', {
      headers: { Upgrade: 'websocket', 'X-Timeline-Id': 't-conn-1' },
    })
    expect(res.status).toBe(101)
    expect(res.webSocket).toBeTruthy()
  })

  it('非 /connect 路径返回 400', async () => {
    const id = env.TIMELINE_DOC.idFromName('t-conn-2')
    const stub = env.TIMELINE_DOC.get(id)
    const res = await stub.fetch('https://do/other')
    expect(res.status).toBe(400)
  })

  async function connect(name: string) {
    const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName(name))
    const res = await stub.fetch('https://do/connect', {
      headers: { Upgrade: 'websocket', 'X-Timeline-Id': name },
    })
    const ws = res.webSocket!
    ws.accept()
    return ws
  }

  it('编辑者发 AUTH 后收到 AUTH_OK', async () => {
    const docName = 't-auth-ok'
    await env.healerbook_timelines
      .prepare('INSERT INTO timeline_editors (timeline_id, user_id, created_at) VALUES (?,?,?)')
      .bind(docName, 'user-1', Date.now())
      .run()
    const jwt = await signAccessToken('user-1', 'U1', 'test-secret')
    const ws = await connect(docName)
    const got = new Promise<MessageEvent>(resolve => {
      ws.addEventListener('message', e => resolve(e as MessageEvent), { once: true })
    })
    ws.send(encodeMessage(MSG.AUTH, new TextEncoder().encode(jwt)))
    const msg = await got
    const frame = new Uint8Array(msg.data as ArrayBuffer)
    expect(frame[0]).toBe(MSG.AUTH_OK)
  })

  it('非编辑者发 AUTH 被关闭', async () => {
    const jwt = await signAccessToken('stranger', 'S', 'test-secret')
    const ws = await connect('t-auth-deny')
    const closed = new Promise<CloseEvent>(resolve => {
      ws.addEventListener('close', e => resolve(e as CloseEvent), { once: true })
    })
    ws.send(encodeMessage(MSG.AUTH, new TextEncoder().encode(jwt)))
    const ev = await closed
    expect(ev.code).toBeGreaterThanOrEqual(1000)
  })

  it('未鉴权先发非 AUTH 消息被关闭', async () => {
    const ws = await connect('t-auth-order')
    const closed = new Promise<CloseEvent>(resolve => {
      ws.addEventListener('close', e => resolve(e as CloseEvent), { once: true })
    })
    ws.send(encodeMessage(MSG.PUSH, new Uint8Array([1])))
    await closed
    expect(true).toBe(true)
  })
})
