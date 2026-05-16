/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { DoSqlStore } from '../collab/doSqlStore'
import { decodeMessage, encodeMessage, MSG } from '../collab/syncProtocol'
import { verifyToken } from '../jwt'

/** 挂在每个 WebSocket 上的鉴权状态(扛 hibernation) */
interface SocketAttachment {
  authed: boolean
  userId?: string
}

export class TimelineDoc extends DurableObject<Env> {
  private readonly store: DoSqlStore
  private cachedDocId: string | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new DoSqlStore(ctx.storage.sql)
    this.store.init()
  }

  /** 仅处理 /connect 的 WebSocket 升级 */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/connect') {
      return new Response('not found', { status: 400 })
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 400 })
    }
    const timelineId = request.headers.get('X-Timeline-Id')
    if (!timelineId) {
      return new Response('missing timeline id', { status: 400 })
    }
    this.cachedDocId = timelineId
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ authed: false } satisfies SocketAttachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    if (typeof raw === 'string') {
      ws.close(1003, 'binary only')
      return
    }
    const att = (ws.deserializeAttachment() ?? { authed: false }) as SocketAttachment
    let msg
    try {
      msg = decodeMessage(new Uint8Array(raw))
    } catch {
      ws.close(1002, 'bad frame')
      return
    }
    await this.dispatch(ws, att, msg.type, msg.payload)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    void ws
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    void ws
  }

  private async dispatch(
    ws: WebSocket,
    att: SocketAttachment,
    type: number,
    payload: Uint8Array
  ): Promise<void> {
    if (!att.authed) {
      if (type !== MSG.AUTH) {
        ws.close(1008, 'auth required')
        return
      }
      await this.handleAuth(ws, payload)
      return
    }
    // 已鉴权 —— LOAD / PUSH / AWARENESS 在 Task A7 实现
    void type
    void payload
  }

  private async handleAuth(ws: WebSocket, payload: Uint8Array): Promise<void> {
    const secret = this.env.JWT_SECRET
    if (!secret) {
      ws.close(1011, 'server misconfigured')
      return
    }
    const jwt = new TextDecoder().decode(payload)
    const result = await verifyToken(jwt, secret)
    if (!result.ok || !result.payload.sub) {
      ws.close(1008, 'invalid token')
      return
    }
    const userId = result.payload.sub
    const row = await this.env.healerbook_timelines
      .prepare('SELECT 1 FROM timeline_editors WHERE timeline_id = ? AND user_id = ?')
      .bind(this.docId(), userId)
      .first()
    if (!row) {
      ws.close(1008, 'not an editor')
      return
    }
    ws.serializeAttachment({ authed: true, userId } satisfies SocketAttachment)
    ws.send(encodeMessage(MSG.AUTH_OK, new Uint8Array()))
  }

  /** 该 DO 对应的 timelineId —— 由 Worker 在转发 /connect 时经 header 注入 */
  private docId(): string {
    return this.cachedDocId ?? ''
  }
}
