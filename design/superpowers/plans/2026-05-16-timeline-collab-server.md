# 时间轴协同编辑 — 计划 A:服务端 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现协同编辑的服务端 —— 每条时间轴一个 Cloudflare Durable Object,内置 SQLite 双表存储,经 WebSocket 做 Yjs 增量同步,带鉴权、squash、KV 公开读缓存,以及把旧 D1 时间轴一次性迁入 DO 的脚本。

**Architecture:** `TimelineDoc`(Durable Object,`idFromName(timelineId)` 定位)既是实时同步房间又是服务端存储。客户端经 WebSocket 连上,首消息 `auth` 鉴权,之后用 Yjs 二进制 update 增量同步(`load-doc` / `push` / `broadcast`)。DO 在 SQLite 双表(`snapshot` + `updates`)持久化,alarm 触发 squash。Worker 路由层负责 WS 升级转发、发布端点、公开 HTTP 读(经 KV 缓存)。

**Tech Stack:** Cloudflare Durable Objects(SQLite-backed)、WebSocket Hibernation API、D1、KV、Yjs、Hono、`@cloudflare/vitest-pool-workers`。

**前置文档:** 主 spec `2026-05-16-timeline-collaborative-sync-design.md` §6–9;增量 spec `2026-05-16-timeline-collab-server-and-editor-integration-design.md` §3、§11(组 1–3)。

---

## 平台 API 核验须知

Cloudflare Durable Objects(SQLite 存储后端)、WebSocket Hibernation、`alarm()`、`@cloudflare/vitest-pool-workers` 均为平台专有 API。本计划按当前已知签名书写;**实现每个 task 时,subagent 应先用 context7 或 WebSearch 核对当前 Cloudflare Workers 文档**(`DurableObject` 基类、`ctx.storage.sql`、`ctx.acceptWebSocket`、`ws.serializeAttachment`、`ctx.getWebSockets`、`ctx.storage.setAlarm`、`cloudflare:test` 的 `runInDurableObject`),发现签名差异以官方文档为准、并在 task 报告里说明。

## 约定

- 包管理器 **pnpm**。提交信息禁止出现 "claude";不加 Co-Authored-By。
- 服务端代码在 `src/workers/`。客户端不在本计划范围(计划 B)。
- Worker 单元测试沿用 node 环境(`*.test.ts`);**需要 DO/WS/D1/KV 运行时的测试用新后缀 `*.workers.test.ts`**,跑在 `@cloudflare/vitest-pool-workers` 里(见 Task 1)。
- DO 类保持极薄:协议编解码、SQLite 操作、squash 逻辑抽成纯/半纯模块,优先在 node 测。

---

## 文件结构

| 文件                                          | 职责                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `wrangler.toml`                               | 改:DO 绑定 `TIMELINE_DOC`、`[[migrations]] new_sqlite_classes`、KV 绑定 `healerbook_snapshots` |
| `src/workers/env.ts`                          | 改:`Env` 增 `TIMELINE_DOC`、`healerbook_snapshots`、确保 `JWT_SECRET` 可用                     |
| `vitest.workers.config.ts`                    | 新:`@cloudflare/vitest-pool-workers` 配置,只收 `*.workers.test.ts`                             |
| `migrations/0004_create_timeline_editors.sql` | 新:`timeline_editors` 白名单表                                                                 |
| `src/workers/collab/syncProtocol.ts`          | 新:WS 消息线编解码(纯)                                                                         |
| `src/workers/collab/doSqlStore.ts`            | 新:DO SQLite 双表操作(append / merge / count / squash)                                         |
| `src/workers/durable/TimelineDoc.ts`          | 新:`TimelineDoc` DO 类 —— WS 生命周期、消息分发、alarm、RPC                                    |
| `src/workers/index.ts`                        | 改:`export { TimelineDoc }`                                                                    |
| `src/workers/routes/timelines.ts`             | 改:`GET /:id`(经 KV/DO)、`POST /`(发布)、`DELETE /:id`、`GET /:id/connect`(WS 升级)            |
| `src/workers/routes/internalMigrate.ts`       | 新:`POST /api/internal/migrate` 一次性迁移端点                                                 |

---

## Task 1: 平台配置与测试基建

**Files:**

- Modify: `wrangler.toml`
- Modify: `src/workers/env.ts`
- Modify: `vitest.config.ts`
- Create: `vitest.workers.config.ts`
- Modify: `package.json`

- [ ] **Step 1: 安装依赖**

Run: `pnpm add -D @cloudflare/vitest-pool-workers`
Expected: `package.json` devDependencies 出现 `@cloudflare/vitest-pool-workers`。

- [ ] **Step 2: `wrangler.toml` 增 DO / KV / migration**

在 `wrangler.toml` 顶层(`[[d1_databases]]` 之后)加:

```toml
[[durable_objects.bindings]]
name = "TIMELINE_DOC"
class_name = "TimelineDoc"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TimelineDoc"]

[[kv_namespaces]]
binding = "healerbook_snapshots"
id = "PLACEHOLDER_DEV_KV_ID"
```

并在 `[env.development]` 与 `[env.production]` 各自的段落里**同样**加 `[[env.<name>.durable_objects.bindings]]`(同上 name/class_name)和 `[[env.<name>.kv_namespaces]]`(binding `healerbook_snapshots`)。

> KV namespace id:`PLACEHOLDER_DEV_KV_ID` / 生产 id 需用 `pnpm exec wrangler kv namespace create healerbook_snapshots`(及 `--env production`)真实创建后填入。实现时若无法创建真实 KV,保留占位并在 task 报告里明确标注「需运维补 KV id」——本地 `vitest-pool-workers` 用 miniflare 模拟 KV,不依赖真实 id。`[[migrations]]` 只需声明一次(顶层);各 env 段不重复 migrations。

- [ ] **Step 3: `env.ts` 增类型**

`src/workers/env.ts` 的 `Env` interface 增加:

```typescript
TIMELINE_DOC: DurableObjectNamespace
healerbook_snapshots: KVNamespace
```

(`JWT_SECRET?: string` 已存在,无需改。)

- [ ] **Step 4: 主 vitest 配置排除 workers 测试**

`vitest.config.ts` 的 `test.exclude` 数组加一项 `'**/*.workers.test.ts'`。

- [ ] **Step 5: 新建 workers 测试配置**

Create `vitest.workers.config.ts`:

```typescript
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'
import path from 'path'

export default defineWorkersConfig({
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(__dirname, './src') }],
  },
  test: {
    include: ['**/*.workers.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat_v2'],
        },
      },
    },
  },
})
```

> 核对 `defineWorkersConfig` / `poolOptions.workers` 当前字段名(见「平台 API 核验须知」)。

- [ ] **Step 6: `package.json` 加脚本**

`package.json` 的 `scripts` 加:

```json
"test:workers": "vitest run --config vitest.workers.config.ts"
```

- [ ] **Step 7: 验证基建**

Run: `pnpm exec tsc --noEmit`
Expected: 0 error(此时还没有 `TimelineDoc` 类,但 `wrangler.toml` 不参与 tsc;`env.ts` 的新字段类型合法)。
Run: `pnpm test:run`
Expected: 既有 733 测试仍全绿(新排除项不影响)。

- [ ] **Step 8: 提交**

```bash
git add wrangler.toml src/workers/env.ts vitest.config.ts vitest.workers.config.ts package.json pnpm-lock.yaml
git commit -m "chore(collab): durable object / kv bindings and workers test config"
```

---

## Task 2: D1 `timeline_editors` 白名单表

**Files:**

- Create: `migrations/0004_create_timeline_editors.sql`

- [ ] **Step 1: 写 migration SQL**

Create `migrations/0004_create_timeline_editors.sql`:

```sql
-- 编辑者白名单:(timeline_id, user_id) 决定谁能经 WebSocket 编辑某条时间轴。
-- 本期手工填充 + 发布时自动插入作者(见路由 POST /api/timelines)。
CREATE TABLE IF NOT EXISTS timeline_editors (
  timeline_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (timeline_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_timeline_editors_user ON timeline_editors (user_id);
```

- [ ] **Step 2: 应用到本地 D1**

Run: `pnpm exec wrangler d1 migrations apply healerbook_timelines --local`
Expected: 报告 `0004_create_timeline_editors.sql` 已应用。

> 若 wrangler 提示需指定 env / 远端,实现时按项目既有 migration(`0001`–`0003`)的应用方式操作;远端生产 D1 的迁移由运维执行,task 报告标注。

- [ ] **Step 3: 提交**

```bash
git add migrations/0004_create_timeline_editors.sql
git commit -m "feat(collab): D1 timeline_editors whitelist table"
```

---

## Task 3: 同步协议线编解码(纯模块)

WebSocket 上传的是带 1 字节类型前缀的二进制帧。本 task 实现纯编解码,node 可测。

**Files:**

- Create: `src/workers/collab/syncProtocol.ts`
- Test: `src/workers/collab/syncProtocol.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/workers/collab/syncProtocol.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { MSG, encodeMessage, decodeMessage, encodeLoadReply, decodeLoadReply } from './syncProtocol'

describe('syncProtocol', () => {
  it('encodeMessage / decodeMessage round-trip', () => {
    const payload = new Uint8Array([9, 8, 7])
    const frame = encodeMessage(MSG.PUSH, payload)
    const decoded = decodeMessage(frame)
    expect(decoded.type).toBe(MSG.PUSH)
    expect([...decoded.payload]).toEqual([9, 8, 7])
  })

  it('空 payload 也能 round-trip', () => {
    const decoded = decodeMessage(encodeMessage(MSG.AUTH_OK, new Uint8Array()))
    expect(decoded.type).toBe(MSG.AUTH_OK)
    expect(decoded.payload.length).toBe(0)
  })

  it('encodeLoadReply / decodeLoadReply 拆分两段', () => {
    const missing = new Uint8Array([1, 2, 3, 4, 5])
    const sv = new Uint8Array([6, 7])
    const { missing: m, stateVector: s } = decodeLoadReply(encodeLoadReply(missing, sv))
    expect([...m]).toEqual([1, 2, 3, 4, 5])
    expect([...s]).toEqual([6, 7])
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm test:run src/workers/collab/syncProtocol.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

Create `src/workers/collab/syncProtocol.ts`:

```typescript
/**
 * WebSocket 同步协议线格式。
 * 每帧:[1 字节 type][payload]。payload 语义随 type 而定。
 */
export const MSG = {
  AUTH: 0, // client→DO   payload = UTF-8 JWT
  AUTH_OK: 1, // DO→client   payload = 空
  LOAD: 2, // client→DO   payload = 客户端 state vector
  LOAD_REPLY: 3, // DO→client   payload = encodeLoadReply(missing, serverStateVector)
  PUSH: 4, // client→DO   payload = Yjs update
  BROADCAST: 5, // DO→client   payload = Yjs update
  AWARENESS: 6, // 双向        payload = awareness update
} as const

export type MsgType = (typeof MSG)[keyof typeof MSG]

export interface DecodedMessage {
  type: number
  payload: Uint8Array
}

export function encodeMessage(type: MsgType, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + payload.length)
  frame[0] = type
  frame.set(payload, 1)
  return frame
}

export function decodeMessage(frame: Uint8Array): DecodedMessage {
  if (frame.length === 0) throw new Error('empty frame')
  return { type: frame[0], payload: frame.subarray(1) }
}

/** LOAD_REPLY payload:[4 字节 BE missing 长度][missing][serverStateVector] */
export function encodeLoadReply(missing: Uint8Array, stateVector: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + missing.length + stateVector.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, missing.length, false)
  out.set(missing, 4)
  out.set(stateVector, 4 + missing.length)
  return out
}

export function decodeLoadReply(payload: Uint8Array): {
  missing: Uint8Array
  stateVector: Uint8Array
} {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const missingLen = view.getUint32(0, false)
  return {
    missing: payload.subarray(4, 4 + missingLen),
    stateVector: payload.subarray(4 + missingLen),
  }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm test:run src/workers/collab/syncProtocol.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/workers/collab/syncProtocol.ts src/workers/collab/syncProtocol.test.ts
git commit -m "feat(collab): websocket sync protocol codec"
```

---

## Task 4: DO SQLite 双表存储模块

DO 内的 `snapshot` / `updates` 双表操作。封装成一个类,接收 DO 的 `SqlStorage`,使逻辑可在 `vitest-pool-workers` 里通过一个 DO 测。

**Files:**

- Create: `src/workers/collab/doSqlStore.ts`
- Test: `src/workers/collab/doSqlStore.workers.test.ts`

- [ ] **Step 1: 写失败测试(workers pool)**

Create `src/workers/collab/doSqlStore.workers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import * as Y from 'yjs'
import { DoSqlStore } from './doSqlStore'

// 借用 TimelineDoc 的 DO 上下文拿一个真实 SqlStorage。
function freshUpdate(key: string, val: number): Uint8Array {
  const d = new Y.Doc()
  d.getMap('m').set(key, val)
  return Y.encodeStateAsUpdate(d)
}

describe('DoSqlStore', () => {
  it('append 后 getMergedDoc 能读回', async () => {
    const id = env.TIMELINE_DOC.idFromName('t-sqlstore-1')
    const stub = env.TIMELINE_DOC.get(id)
    await runInDurableObject(stub, async (_instance, ctx) => {
      const store = new DoSqlStore(ctx.storage.sql)
      store.init()
      store.appendUpdate(freshUpdate('a', 1))
      const merged = store.getMergedDoc()
      const d = new Y.Doc()
      Y.applyUpdate(d, merged)
      expect(d.getMap('m').get('a')).toBe(1)
      expect(store.countUpdates()).toBe(1)
    })
  })

  it('squash 后 updates 清空、内容保留', async () => {
    const id = env.TIMELINE_DOC.idFromName('t-sqlstore-2')
    const stub = env.TIMELINE_DOC.get(id)
    await runInDurableObject(stub, async (_instance, ctx) => {
      const store = new DoSqlStore(ctx.storage.sql)
      store.init()
      for (let i = 0; i < 4; i++) store.appendUpdate(freshUpdate('k' + i, i))
      store.squash()
      expect(store.countUpdates()).toBe(0)
      const d = new Y.Doc()
      Y.applyUpdate(d, store.getMergedDoc())
      expect(d.getMap('m').get('k3')).toBe(3)
    })
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm test:workers src/workers/collab/doSqlStore.workers.test.ts`
Expected: FAIL —— `DoSqlStore` 不存在(且 `TimelineDoc` 尚未定义,测试可能因绑定缺类报错;若 pool 因 `TimelineDoc` 未导出而无法启动,本 task 与 Task 5 顺序可对调,或先在 `index.ts` 放一个最小 `TimelineDoc` 占位类后再回来 —— 实现时按实际报错决定,在报告里说明)。

- [ ] **Step 3: 实现**

Create `src/workers/collab/doSqlStore.ts`:

```typescript
/// <reference types="@cloudflare/workers-types" />
import { mergeUpdates } from 'yjs'

/** BLOB 列读出来是 ArrayBuffer;统一转 Uint8Array */
function toU8(v: ArrayBuffer | Uint8Array): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array(v)
}

/**
 * DO 内 SQLite 双表:
 *   snapshot(id=1, bin, updated_at)  —— 全量 checkpoint
 *   updates(seq AUTOINCREMENT, bin, created_at) —— 增量日志
 */
export class DoSqlStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY, bin BLOB, updated_at INTEGER)'
    )
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, bin BLOB, created_at INTEGER)'
    )
  }

  appendUpdate(bin: Uint8Array): void {
    this.sql.exec('INSERT INTO updates (bin, created_at) VALUES (?, ?)', bin, Date.now())
  }

  countUpdates(): number {
    const row = this.sql.exec('SELECT COUNT(*) AS n FROM updates').one()
    return Number(row.n)
  }

  /** snapshot + 所有 updates(按 seq 升序)合并 */
  getMergedDoc(): Uint8Array {
    const parts: Uint8Array[] = []
    const snap = this.sql.exec('SELECT bin FROM snapshot WHERE id = 1').toArray()
    if (snap.length > 0) parts.push(toU8(snap[0].bin as ArrayBuffer))
    for (const row of this.sql.exec('SELECT bin FROM updates ORDER BY seq').toArray()) {
      parts.push(toU8(row.bin as ArrayBuffer))
    }
    return mergeUpdates(parts)
  }

  /** 是否已有任何数据(snapshot 或 updates) */
  isEmpty(): boolean {
    const snap = this.sql.exec('SELECT COUNT(*) AS n FROM snapshot').one()
    return Number(snap.n) === 0 && this.countUpdates() === 0
  }

  /** 合并出新 snapshot、清空 updates */
  squash(): void {
    const merged = this.getMergedDoc()
    this.sql.exec(
      'INSERT INTO snapshot (id, bin, updated_at) VALUES (1, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET bin = excluded.bin, updated_at = excluded.updated_at',
      merged,
      Date.now()
    )
    this.sql.exec('DELETE FROM updates')
  }

  /** 直接写入一个全量 snapshot(迁移 seed 用),要求当前为空 */
  seedSnapshot(bin: Uint8Array): void {
    this.sql.exec(
      'INSERT INTO snapshot (id, bin, updated_at) VALUES (1, ?, ?) ' + 'ON CONFLICT(id) DO NOTHING',
      bin,
      Date.now()
    )
  }
}
```

> 核对 `SqlStorage.exec` 的返回 cursor API(`.one()` / `.toArray()` / BLOB 绑定与读取类型)是否与当前 Workers 文档一致。

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm test:workers src/workers/collab/doSqlStore.workers.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/workers/collab/doSqlStore.ts src/workers/collab/doSqlStore.workers.test.ts
git commit -m "feat(collab): durable object sqlite snapshot/updates store"
```

---

## Task 5: `TimelineDoc` DO 类骨架 + WebSocket 接入

DO 类:接受 `/connect` 的 WS 升级、用 Hibernation API 管理连接、把消息分发给(后续 task 实现的)处理器。本 task 只做骨架 + 连接 + 消息分发壳,鉴权/同步逻辑在 Task 6–7。

**Files:**

- Create: `src/workers/durable/TimelineDoc.ts`
- Modify: `src/workers/index.ts`
- Test: `src/workers/durable/TimelineDoc.workers.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/workers/durable/TimelineDoc.workers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

describe('TimelineDoc WebSocket 接入', () => {
  it('/connect 返回 101 并升级为 WebSocket', async () => {
    const id = env.TIMELINE_DOC.idFromName('t-conn-1')
    const stub = env.TIMELINE_DOC.get(id)
    const res = await stub.fetch('https://do/connect', {
      headers: { Upgrade: 'websocket' },
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
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm test:workers src/workers/durable/TimelineDoc.workers.test.ts`
Expected: FAIL —— `TimelineDoc` 未定义 / 未导出。

- [ ] **Step 3: 实现 DO 骨架**

Create `src/workers/durable/TimelineDoc.ts`:

```typescript
/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { DoSqlStore } from '../collab/doSqlStore'
import { decodeMessage } from '../collab/syncProtocol'

/** 挂在每个 WebSocket 上的鉴权状态(扛 hibernation) */
interface SocketAttachment {
  authed: boolean
  userId?: string
}

export class TimelineDoc extends DurableObject<Env> {
  private readonly store: DoSqlStore

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
    // Hibernation 下连接由运行时管理;此处无显式资源需释放。
    void ws
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    void ws
  }

  /** 消息分发 —— 鉴权/同步处理在 Task 6–7 填充 */
  private async dispatch(
    ws: WebSocket,
    att: SocketAttachment,
    type: number,
    payload: Uint8Array
  ): Promise<void> {
    // Task 6–7 实现:AUTH / LOAD / PUSH / AWARENESS
    void att
    void type
    void payload
    ws.close(1011, 'not implemented')
  }
}
```

- [ ] **Step 4: 导出 DO 类**

`src/workers/index.ts`:在文件顶部 import 区加 `import { TimelineDoc } from './durable/TimelineDoc'`,并在末尾的导出区加 `export { TimelineDoc }`(`wrangler.toml` 的 `class_name = "TimelineDoc"` 要求它从 worker 入口导出)。

- [ ] **Step 5: 运行测试,确认通过**

Run: `pnpm test:workers src/workers/durable/TimelineDoc.workers.test.ts`
Expected: PASS(101 升级、400 兜底)。

- [ ] **Step 6: 类型检查 + 提交**

Run: `pnpm exec tsc --noEmit` → 0 error。

```bash
git add src/workers/durable/TimelineDoc.ts src/workers/index.ts src/workers/durable/TimelineDoc.workers.test.ts
git commit -m "feat(collab): TimelineDoc durable object websocket skeleton"
```

---

## Task 6: WebSocket 鉴权(首消息 `auth`)

连上后第一条必须是 `AUTH { jwt }`。DO 验签 + 查 D1 `timeline_editors` 定角色;非编辑者关闭连接。

**Files:**

- Modify: `src/workers/durable/TimelineDoc.ts`
- Test: `src/workers/durable/TimelineDoc.workers.test.ts`

- [ ] **Step 1: 写失败测试(追加)**

在 `TimelineDoc.workers.test.ts` 追加。测试需要:① 一个有效 JWT(用 `src/workers/jwt.ts` 的 `signAccessToken`,`env.JWT_SECRET` 由 `vitest.workers.config.ts` 的 miniflare `bindings` 提供 —— 在该配置的 `miniflare` 段加 `bindings: { JWT_SECRET: 'test-secret' }`,本 step 先补这个配置);② 预先往 D1 插一行 `timeline_editors`。

```typescript
import { signAccessToken } from '@/workers/jwt'
import { encodeMessage, MSG } from '@/workers/collab/syncProtocol'

async function connect(name: string) {
  const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName(name))
  const res = await stub.fetch('https://do/connect', { headers: { Upgrade: 'websocket' } })
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
    ws.addEventListener('message', e => resolve(e), { once: true })
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
    ws.addEventListener('close', e => resolve(e), { once: true })
  })
  ws.send(encodeMessage(MSG.AUTH, new TextEncoder().encode(jwt)))
  const ev = await closed
  expect(ev.code).toBeGreaterThanOrEqual(1000)
})

it('未鉴权先发非 AUTH 消息被关闭', async () => {
  const ws = await connect('t-auth-order')
  const closed = new Promise<CloseEvent>(resolve => {
    ws.addEventListener('close', e => resolve(e), { once: true })
  })
  ws.send(encodeMessage(MSG.PUSH, new Uint8Array([1])))
  await closed
  expect(true).toBe(true)
})
```

并在 `vitest.workers.config.ts` 的 `miniflare` 段补:`bindings: { JWT_SECRET: 'test-secret', SYNC_AUTH_TOKEN: 'test-sync-token' }`。

> 测试用 `ws.accept()` + `addEventListener` 是「客户端侧 WebSocket」用法;`runInDurableObject` 非必需,这里直接 `stub.fetch` 拿到 `res.webSocket`。核对 `vitest-pool-workers` 下 WebSocket 客户端测试的当前推荐写法。

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm test:workers src/workers/durable/TimelineDoc.workers.test.ts`
Expected: FAIL —— `dispatch` 当前对所有消息 `close(1011)`。

- [ ] **Step 3: 实现鉴权**

在 `TimelineDoc.ts`:import 增 `import { verifyToken } from '../jwt'` 和 `import { encodeMessage, MSG } from '../collab/syncProtocol'`。把 `dispatch` 改为:

```typescript
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
  // 已鉴权 —— LOAD / PUSH / AWARENESS 在 Task 7 实现
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

/** 该 DO 对应的 timelineId —— 由 Worker 在转发 /connect 时经 header 注入(见 Task 10) */
private docId(): string {
  return this.cachedDocId ?? ''
}
private cachedDocId: string | undefined
```

DO 自身不知道自己的「name」。`docId` 需由 Worker 转发 `/connect` 时通过 header 传入。修改 `fetch`:在 `url.pathname === '/connect'` 分支里,从 `request.headers.get('X-Timeline-Id')` 读取并 `this.cachedDocId = ...`(Worker 在 Task 10 注入此 header)。若缺失则 `return new Response('missing timeline id', { status: 400 })`。

> `timeline_editors` 的查询用 `this.env.healerbook_timelines`(D1,已在 `Env`)。鉴权超时(连上若干秒未发 AUTH 即关)本期用 best-effort:`fetch` 升级后 `this.cachedDocId` 设定时,可不做硬超时 —— 未鉴权连接发任何非 AUTH 消息即被关;纯空闲连接由 hibernation 低成本挂着。是否加 `setTimeout` 关闭由实现者决定,加了在报告里说明。

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm test:workers src/workers/durable/TimelineDoc.workers.test.ts`
Expected: PASS(AUTH_OK / 非编辑者关闭 / 乱序关闭)。

- [ ] **Step 5: 提交**

```bash
git add src/workers/durable/TimelineDoc.ts src/workers/durable/TimelineDoc.workers.test.ts vitest.workers.config.ts
git commit -m "feat(collab): websocket first-message auth and editor role check"
```

---

## Task 7: 同步处理 —— `load-doc` / `push` / `broadcast` / `awareness`

**Files:**

- Modify: `src/workers/durable/TimelineDoc.ts`
- Test: `src/workers/durable/TimelineDoc.workers.test.ts`

- [ ] **Step 1: 写失败测试(追加)**

追加(沿用前面的 `connect` 辅助 + 插白名单 + `signAccessToken`)。一个完整流程测试:鉴权 → `LOAD`(空 state vector)→ 收到 `LOAD_REPLY` → `PUSH` 一个 update → 另一个连接收到 `BROADCAST`。

```typescript
import * as Y from 'yjs'
import { decodeMessage, decodeLoadReply } from '@/workers/collab/syncProtocol'

async function authConnect(docName: string, userId: string) {
  await env.healerbook_timelines
    .prepare(
      'INSERT OR IGNORE INTO timeline_editors (timeline_id, user_id, created_at) VALUES (?,?,?)'
    )
    .bind(docName, userId, Date.now())
    .run()
  const jwt = await signAccessToken(userId, userId, 'test-secret')
  const ws = await connect(docName)
  const ok = new Promise<void>(resolve => {
    ws.addEventListener('message', function h(e) {
      if (new Uint8Array(e.data as ArrayBuffer)[0] === MSG.AUTH_OK) {
        ws.removeEventListener('message', h)
        resolve()
      }
    })
  })
  ws.send(encodeMessage(MSG.AUTH, new TextEncoder().encode(jwt)))
  await ok
  return ws
}

it('LOAD 返回 LOAD_REPLY;PUSH 广播给其他连接', async () => {
  const docName = 't-sync-1'
  const wsA = await authConnect(docName, 'ua')
  const wsB = await authConnect(docName, 'ub')

  // A push 一个 update
  const doc = new Y.Doc()
  doc.getMap('m').set('x', 42)
  const update = Y.encodeStateAsUpdate(doc)

  const broadcastToB = new Promise<Uint8Array>(resolve => {
    wsB.addEventListener('message', e => {
      const f = decodeMessage(new Uint8Array(e.data as ArrayBuffer))
      if (f.type === MSG.BROADCAST) resolve(f.payload)
    })
  })
  wsA.send(encodeMessage(MSG.PUSH, update))
  const broadcasted = await broadcastToB
  const check = new Y.Doc()
  Y.applyUpdate(check, broadcasted)
  expect(check.getMap('m').get('x')).toBe(42)

  // 新连接 LOAD 拿到已 push 的内容
  const wsC = await authConnect(docName, 'uc')
  const loadReply = new Promise<Uint8Array>(resolve => {
    wsC.addEventListener('message', e => {
      const f = decodeMessage(new Uint8Array(e.data as ArrayBuffer))
      if (f.type === MSG.LOAD_REPLY) resolve(f.payload)
    })
  })
  wsC.send(encodeMessage(MSG.LOAD, Y.encodeStateVector(new Y.Doc())))
  const { missing } = decodeLoadReply(await loadReply)
  const loaded = new Y.Doc()
  Y.applyUpdate(loaded, missing)
  expect(loaded.getMap('m').get('x')).toBe(42)
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm test:workers src/workers/durable/TimelineDoc.workers.test.ts`
Expected: FAIL —— 已鉴权分支当前对 LOAD/PUSH 无响应。

- [ ] **Step 3: 实现同步处理**

`TimelineDoc.ts`:import 增 `import { encodeLoadReply } from '../collab/syncProtocol'` 与 `import { encodeStateVectorFromUpdate, diffUpdate } from 'yjs'`。把 `dispatch` 已鉴权分支改为:

```typescript
// 已鉴权
if (type === MSG.LOAD) {
  const full = this.store.getMergedDoc()
  const missing = payload.length > 0 ? diffUpdate(full, payload) : full
  const sv = encodeStateVectorFromUpdate(full)
  ws.send(encodeMessage(MSG.LOAD_REPLY, encodeLoadReply(missing, sv)))
  return
}
if (type === MSG.PUSH) {
  this.store.appendUpdate(payload) // 先落库
  this.broadcast(ws, encodeMessage(MSG.BROADCAST, payload)) // 再广播给其他连接
  this.scheduleSquash() // Task 8
  return
}
if (type === MSG.AWARENESS) {
  this.broadcast(ws, encodeMessage(MSG.AWARENESS, payload)) // 仅转发,不落库
  return
}
```

加 `broadcast` 方法:

```typescript
/** 把 frame 发给除 sender 外的所有已鉴权连接 */
private broadcast(sender: WebSocket, frame: Uint8Array): void {
  for (const ws of this.ctx.getWebSockets()) {
    if (ws === sender) continue
    const att = (ws.deserializeAttachment() ?? { authed: false }) as SocketAttachment
    if (!att.authed) continue
    try {
      ws.send(frame)
    } catch {
      // 发送失败的连接忽略,由运行时清理
    }
  }
}
```

`scheduleSquash` 先放一个空方法占位(Task 8 实现):

```typescript
private scheduleSquash(): void {
  // Task 8 实现
}
```

> `getMergedDoc()` 对空 DO 返回 `mergeUpdates([])`(空 update);`diffUpdate(空, sv)` 行为正常。`appendUpdate` 在 `broadcast` 前 —— append-then-broadcast 顺序(主 spec §6.3)。

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm test:workers src/workers/durable/TimelineDoc.workers.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/workers/durable/TimelineDoc.ts src/workers/durable/TimelineDoc.workers.test.ts
git commit -m "feat(collab): load-doc / push / broadcast / awareness handlers"
```

---

## Task 8: Squash(alarm 触发)

每次 push 后按 updates 条数调度 squash:soft 50 → 10s 后 trailing debounce;hard 200 → 立即。

**Files:**

- Modify: `src/workers/durable/TimelineDoc.ts`
- Test: `src/workers/durable/TimelineDoc.workers.test.ts`

- [ ] **Step 1: 写失败测试(追加)**

```typescript
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'

it('alarm 触发 squash 后 updates 清空', async () => {
  const docName = 't-squash-1'
  const ws = await authConnect(docName, 'us')
  // push 一条
  const doc = new Y.Doc()
  doc.getMap('m').set('v', 1)
  ws.send(encodeMessage(MSG.PUSH, Y.encodeStateAsUpdate(doc)))
  // 给广播/落库一点时间
  await new Promise(r => setTimeout(r, 50))

  const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName(docName))
  // 直接触发一次 squash(强制 alarm)
  await runInDurableObject(stub, async (instance: any, ctx) => {
    await ctx.storage.setAlarm(Date.now())
  })
  await runDurableObjectAlarm(stub)
  await runInDurableObject(stub, async (_i, ctx) => {
    const n = ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM updates').one().n
    expect(Number(n)).toBe(0)
  })
})
```

> `runDurableObjectAlarm` / `runInDurableObject` 是 `cloudflare:test` 提供的;核对当前签名。本测试验证 `alarm()` 执行 squash 这一行为本身。

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm test:workers src/workers/durable/TimelineDoc.workers.test.ts`
Expected: FAIL —— DO 还没有 `alarm()` 方法 / `scheduleSquash` 是空的。

- [ ] **Step 3: 实现 squash 调度**

`TimelineDoc.ts`:加常量与方法,并把 Task 7 占位的 `scheduleSquash` 替换:

```typescript
private static readonly SQUASH_SOFT = 50
private static readonly SQUASH_HARD = 200
private static readonly SQUASH_DEBOUNCE_MS = 10_000

/** 每次 push 后调用:按 updates 条数调度 squash */
private async scheduleSquash(): Promise<void> {
  const count = this.store.countUpdates()
  if (count >= TimelineDoc.SQUASH_HARD) {
    await this.ctx.storage.setAlarm(Date.now())
  } else if (count >= TimelineDoc.SQUASH_SOFT) {
    await this.ctx.storage.setAlarm(Date.now() + TimelineDoc.SQUASH_DEBOUNCE_MS)
  }
}

/** alarm 到点:执行 squash */
override async alarm(): Promise<void> {
  if (this.store.countUpdates() > 1) {
    this.store.squash()
  }
}
```

并把 Task 7 里 `this.scheduleSquash()` 的调用改为 `await this.scheduleSquash()`(`dispatch` 已是 async)。

> `setAlarm` 覆盖前值 → 天然 trailing debounce。`alarm()` 跨 hibernation 存活。squash 同步 SQLite、单 invocation 原子。

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm test:workers src/workers/durable/TimelineDoc.workers.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/workers/durable/TimelineDoc.ts src/workers/durable/TimelineDoc.workers.test.ts
git commit -m "feat(collab): alarm-driven squash with trailing debounce"
```

---

## Task 9: DO RPC —— `seed` / `getSnapshotJson` + squash 时写 KV

迁移脚本要往 DO 灌初始数据;公开 HTTP 读要从 DO 取投影 JSON。两者都是 Worker→DO 的 RPC 方法(不开 DO 的公开 HTTP 路由)。squash 后把投影 JSON 写 KV 缓存。

**Files:**

- Modify: `src/workers/durable/TimelineDoc.ts`
- Test: `src/workers/durable/TimelineDoc.workers.test.ts`

- [ ] **Step 1: 写失败测试(追加)**

```typescript
it('seed 灌入初始数据,getSnapshotJson 投影回 Timeline', async () => {
  const docName = 't-rpc-1'
  const seedDoc = new Y.Doc()
  seedDoc.getMap('meta').set('name', 'SeededTL')
  const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName(docName))
  await stub.seed(Y.encodeStateAsUpdate(seedDoc))
  const json = await stub.getSnapshotJson()
  expect(json).not.toBeNull()
  expect(json!.name).toBe('SeededTL')
})

it('seed 幂等:第二次 seed 不覆盖', async () => {
  const docName = 't-rpc-2'
  const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName(docName))
  const d1 = new Y.Doc()
  d1.getMap('meta').set('name', 'First')
  await stub.seed(Y.encodeStateAsUpdate(d1))
  const d2 = new Y.Doc()
  d2.getMap('meta').set('name', 'Second')
  await stub.seed(Y.encodeStateAsUpdate(d2))
  const json = await stub.getSnapshotJson()
  expect(json!.name).toBe('First')
})
```

> `getSnapshotJson` 把 DO 的合并 Y.Doc 投影成 `Timeline`。投影用客户端共享的 `projectTimeline`(`src/collab/docSchema.ts`)—— 它是纯函数、不依赖浏览器 API,Worker 可直接 import。

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm test:workers src/workers/durable/TimelineDoc.workers.test.ts`
Expected: FAIL —— `seed` / `getSnapshotJson` 未定义。

- [ ] **Step 3: 实现 RPC + KV 写入**

`TimelineDoc.ts`:import 增 `import * as Y from 'yjs'`、`import { projectTimeline } from '@/collab/docSchema'`、`import type { Timeline } from '@/types/timeline'`。加公开方法(`DurableObject` 子类的 public 方法即 RPC):

```typescript
/** 迁移脚本用:灌入初始全量 snapshot,幂等(已有数据则跳过) */
async seed(bin: Uint8Array): Promise<void> {
  if (!this.store.isEmpty()) return
  this.store.seedSnapshot(bin)
}

/** 公开读用:把当前合并状态投影成 Timeline JSON;空文档返回 null */
async getSnapshotJson(): Promise<Timeline | null> {
  if (this.store.isEmpty()) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, this.store.getMergedDoc())
  return projectTimeline(doc)
}
```

并把 `alarm()` 改为 squash 后写 KV:

```typescript
override async alarm(): Promise<void> {
  if (this.store.countUpdates() > 1) {
    this.store.squash()
  }
  await this.writeSnapshotCache()
}

/** squash 后把投影 JSON 写入 KV 公开读缓存 */
private async writeSnapshotCache(): Promise<void> {
  if (!this.cachedDocId) return
  const json = await this.getSnapshotJson()
  if (json) {
    await this.env.healerbook_snapshots.put(`tl-snapshot:${this.cachedDocId}`, JSON.stringify(json))
  }
}
```

> `projectTimeline` 当前签名 `projectTimeline(doc, prev?)` —— 这里只传 `doc`。`@/collab/docSchema` 经 `vitest.workers.config.ts` 的 `@` alias 解析;确保 `docSchema.ts` 及其依赖(`yjs`、`@/types/timeline`、`@/collab/constants`)在 workers 运行时可用(纯 TS,无浏览器 API,应无问题 —— 若 miniflare 报错,在报告里说明)。

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm test:workers src/workers/durable/TimelineDoc.workers.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/workers/durable/TimelineDoc.ts src/workers/durable/TimelineDoc.workers.test.ts
git commit -m "feat(collab): DO seed / getSnapshotJson RPC and KV snapshot cache"
```

---

## Task 10: Worker 路由 —— 发布 / 公开读 / WS 升级转发

改造 `src/workers/routes/timelines.ts`:`POST /`(发布:清洗 id、建 D1 行、作者入白名单)、`GET /:id`(先读 KV,未命中经 DO RPC)、`GET /:id/connect`(WS 升级转发给 DO,注入 `X-Timeline-Id`)、`DELETE /:id`。旧的 `PUT /:id`(整块 JSON + 版本锁)删除。

**Files:**

- Modify: `src/workers/routes/timelines.ts`
- Test: `src/workers/routes/timelines.workers.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/workers/routes/timelines.workers.test.ts`:

```typescript
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
```

> `SELF` 是 `cloudflare:test` 提供的「整个 Worker」fetcher。需要 `vitest.workers.config.ts` 的 `poolOptions.workers` 指向 worker 入口(`wrangler.toml` 的 `main`)—— Task 1 已 `configPath` 指向 `wrangler.toml`,`SELF` 即整个 app。

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm test:workers src/workers/routes/timelines.workers.test.ts`
Expected: FAIL —— 路由仍是旧实现。

- [ ] **Step 3: 改造路由**

把 `src/workers/routes/timelines.ts` 改为(保留 `requireAuth` / `tryReadAuth` / `generateCleanId` 等既有引用):

```typescript
/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import { vValidator } from '@hono/valibot-validator'
import type { AppEnv } from '../env'
import { requireAuth } from '../middleware/requireAuth'
import { CreateTimelineRequestSchema } from '../timelineSchema'
import * as sensitiveWordFilter from '../sensitiveWordFilter'

const app = new Hono<AppEnv>()

/** 取该 timeline 的 DO stub */
function docStub(env: AppEnv['Bindings'], id: string) {
  return env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName(id))
}

// 发布:把一条本地时间轴注册为云端时间轴
app.post('/', requireAuth, vValidator('json', CreateTimelineRequestSchema), async c => {
  const auth = c.get('auth')!
  const { timeline } = c.req.valid('json')
  const id = timeline.id // 前端生成的 id;服务端校验,不换发
  if (typeof id !== 'string' || id.length < 1 || id.length > 64) {
    return c.json({ error: 'invalid_id' }, 400)
  }
  if (await sensitiveWordFilter.containsBannedSubstring(id, c.env)) {
    return c.json({ error: 'id_rejected' }, 409)
  }
  const now = Math.floor(Date.now() / 1000)
  const existing = await c.env.healerbook_timelines
    .prepare('SELECT 1 FROM timelines WHERE id = ?')
    .bind(id)
    .first()
  if (existing) return c.json({ error: 'id_taken' }, 409)

  await c.env.healerbook_timelines.batch([
    c.env.healerbook_timelines
      .prepare(
        'INSERT INTO timelines (id, name, author_id, author_name, published_at, updated_at, version, content) VALUES (?,?,?,?,?,?,?,?)'
      )
      .bind(id, timeline.n ?? '', auth.userId, auth.username, now, now, 1, '{}'),
    c.env.healerbook_timelines
      .prepare(
        'INSERT OR IGNORE INTO timeline_editors (timeline_id, user_id, created_at) VALUES (?,?,?)'
      )
      .bind(id, auth.userId, Date.now()),
  ])
  return c.json({ id, publishedAt: now }, 201)
})

// 公开读:先 KV,未命中经 DO RPC
app.get('/:id', async c => {
  const id = c.req.param('id')
  const cached = await c.env.healerbook_snapshots.get(`tl-snapshot:${id}`)
  if (cached) {
    return c.json(JSON.parse(cached), 200, { 'Cache-Control': 'public, max-age=60' })
  }
  const row = await c.env.healerbook_timelines
    .prepare('SELECT id FROM timelines WHERE id = ?')
    .bind(id)
    .first()
  if (!row) return c.json({ error: 'Not found' }, 404)
  const json = await docStub(c.env, id).getSnapshotJson()
  if (!json) return c.json({ error: 'Not found' }, 404)
  return c.json(json, 200, { 'Cache-Control': 'public, max-age=60' })
})

// WebSocket 升级:转发给 DO,注入 X-Timeline-Id(DO 自身不知道 name)
app.get('/:id/connect', async c => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'expected websocket' }, 400)
  }
  const id = c.req.param('id')
  const fwd = new Request('https://do/connect', c.req.raw)
  fwd.headers.set('X-Timeline-Id', id)
  return docStub(c.env, id).fetch(fwd)
})

// 删除:删 D1 行 + KV + 通知 DO 清空(viewer 白名单清理略,后续加固)
app.delete('/:id', requireAuth, async c => {
  const auth = c.get('auth')!
  const id = c.req.param('id')
  const result = await c.env.healerbook_timelines
    .prepare('DELETE FROM timelines WHERE id = ? AND author_id = ?')
    .bind(id, auth.userId)
    .run()
  if (result.meta.changes === 0) return c.json({ error: 'Not found or forbidden' }, 404)
  await c.env.healerbook_snapshots.delete(`tl-snapshot:${id}`)
  await c.env.healerbook_timelines
    .prepare('DELETE FROM timeline_editors WHERE timeline_id = ?')
    .bind(id)
    .run()
  return c.body(null, 204)
})

export { app as timelinesRoutes }
```

> 注意:① `X-Timeline-Id` 是 Worker→DO 内部 header,客户端无法直达 DO 故可信;但 Worker 应先**剥掉**客户端自带的同名 header 再 set —— `new Request(..., c.req.raw)` 复制了原 headers,`.set` 会覆盖,足够。② `new Request('https://do/connect', c.req.raw)` 携带 `Upgrade` header;若运行时不允许这样复制 WS 升级请求,改为构造一个新 Request 显式带 `Upgrade: websocket`、并把 `X-Timeline-Id` 加上 —— 按实际报错调整,报告说明。③ 旧 `PUT /:id` 删除。`generateCleanId`/`ID_GEN_MAX_ATTEMPTS`/`rowToSharedTimeline` 等不再用的本地符号一并删除。

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm test:workers src/workers/routes/timelines.workers.test.ts`
Expected: PASS。
Run: `pnpm exec tsc --noEmit`
Expected: 0 error。(若 `routes/my.ts` 或别处引用了被删的 `PUT`/符号,一并修。)

- [ ] **Step 5: 提交**

```bash
git add src/workers/routes/timelines.ts src/workers/routes/timelines.workers.test.ts
git commit -m "feat(collab): publish endpoint, public read via KV/DO, websocket upgrade route"
```

---

## Task 11: 服务端一次性迁移端点

把旧 D1 `timelines` 表里的存量时间轴(`content` JSON)逐条转成 Y.Doc 灌入对应 DO。

**Files:**

- Create: `src/workers/routes/internalMigrate.ts`
- Modify: `src/workers/index.ts`
- Test: `src/workers/routes/internalMigrate.workers.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/workers/routes/internalMigrate.workers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { env, SELF } from 'cloudflare:test'

describe('POST /api/internal/migrate', () => {
  it('无 SYNC_AUTH_TOKEN 拒绝', async () => {
    const res = await SELF.fetch('https://app/api/internal/migrate', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('把旧 D1 时间轴灌入 DO', async () => {
    const now = Math.floor(Date.now() / 1000)
    const content = JSON.stringify({
      v: 2,
      n: 'OldTL',
      e: 1,
      c: [],
      de: [],
      ce: { a: [], t: [], p: [] },
      ca: 0,
      ua: 0,
    })
    await env.healerbook_timelines
      .prepare(
        'INSERT INTO timelines (id, name, author_id, author_name, published_at, updated_at, version, content) VALUES (?,?,?,?,?,?,?,?)'
      )
      .bind('oldMigrateDoc00000001', 'OldTL', 'auth-x', 'AuthX', now, now, 1, content)
      .run()

    const res = await SELF.fetch('https://app/api/internal/migrate', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-sync-token' },
    })
    expect(res.status).toBe(200)

    const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName('oldMigrateDoc00000001'))
    const json = await stub.getSnapshotJson()
    expect(json).not.toBeNull()
    expect(json!.name).toBe('OldTL')
  })
})
```

> `SYNC_AUTH_TOKEN` 由 `vitest.workers.config.ts` miniflare `bindings` 提供(Task 6 已加 `test-sync-token`)。

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm test:workers src/workers/routes/internalMigrate.workers.test.ts`
Expected: FAIL —— 路由不存在(404)。

- [ ] **Step 3: 实现迁移端点**

Create `src/workers/routes/internalMigrate.ts`:

```typescript
/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { buildYDoc } from '@/collab/docSchema'
import { parseFromAny } from '@/utils/timelineFormat'
import { encodeStateAsUpdate } from 'yjs'

const app = new Hono<AppEnv>()

interface TimelineRow {
  id: string
  author_id: string
  content: string
}

/** 把旧 D1 timelines.content → Y.Doc → 灌入对应 DO。幂等(DO.seed 幂等)。 */
app.post('/migrate', async c => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '')
  if (!c.env.SYNC_AUTH_TOKEN || token !== c.env.SYNC_AUTH_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const rows = await c.env.healerbook_timelines
    .prepare('SELECT id, author_id, content FROM timelines')
    .all<TimelineRow>()

  let migrated = 0
  let skipped = 0
  for (const row of rows.results) {
    try {
      const raw = JSON.parse(row.content) as Record<string, unknown>
      const timeline = parseFromAny(raw, { id: row.id })
      /* eslint-disable @typescript-eslint/no-unused-vars */
      const {
        id,
        isShared,
        everPublished,
        hasLocalChanges,
        serverVersion,
        statusEvents,
        updatedAt,
        ...content
      } = timeline
      /* eslint-enable @typescript-eslint/no-unused-vars */
      const bin = encodeStateAsUpdate(buildYDoc(content))
      const stub = c.env.TIMELINE_DOC.get(c.env.TIMELINE_DOC.idFromName(row.id))
      await stub.seed(bin)
      // 作者入白名单(发布过的时间轴的作者应能继续编辑)
      await c.env.healerbook_timelines
        .prepare(
          'INSERT OR IGNORE INTO timeline_editors (timeline_id, user_id, created_at) VALUES (?,?,?)'
        )
        .bind(row.id, row.author_id, Date.now())
        .run()
      migrated++
    } catch (err) {
      console.error('[migrate] skip', row.id, err)
      skipped++
    }
  }
  return c.json({ migrated, skipped })
})

export { app as internalMigrateRoutes }
```

> `parseFromAny`(`src/utils/timelineFormat.ts`)解析 V1/V2/任意旧格式为 `Timeline`;它是纯函数,Worker 可 import。若它意外依赖浏览器 API 导致 miniflare 报错,在报告里说明并改为只接受 V2(`hydrateFromV2`)。`toContent` 的字段剥离与计划 B 的 `migration.ts` 一致(与主 spec §10 的 `TimelineContent` 对齐)。

- [ ] **Step 4: 挂载路由**

`src/workers/index.ts`:import 加 `import { internalMigrateRoutes } from './routes/internalMigrate'`;在路由区加 `app.route('/api/internal', internalMigrateRoutes)`。

- [ ] **Step 5: 运行测试,确认通过**

Run: `pnpm test:workers src/workers/routes/internalMigrate.workers.test.ts`
Expected: PASS。

- [ ] **Step 6: 全量验证 + 提交**

Run: `pnpm exec tsc --noEmit && pnpm lint && pnpm test:run && pnpm test:workers`
Expected: 全 0 error / 全绿。

```bash
git add src/workers/routes/internalMigrate.ts src/workers/index.ts src/workers/routes/internalMigrate.workers.test.ts
git commit -m "feat(collab): server one-time D1-to-DO migration endpoint"
```

---

## 计划 A 完成验收

- [ ] `pnpm test:run`(node 测)全绿。
- [ ] `pnpm test:workers`(DO/WS/D1/KV 集成测)全绿。
- [ ] `pnpm exec tsc --noEmit` 0 error。`pnpm lint` 0 error。`pnpm build` 成功。
- [ ] 手动核对:`wrangler.toml` 的 DO/KV/migration 配置完整;`migrations/0004` 已应用;`SYNC_AUTH_TOKEN`/`JWT_SECRET` 在生产由运维配置。

产出:一个可用的协同同步服务端 —— DO 房间 + SQLite 双表 + WS 同步协议 + 鉴权 + squash + KV 缓存 + 发布端点 + 一次性迁移。客户端尚未接入(计划 B)。

---

## 自审记录

- **Spec 覆盖**:覆盖增量 spec §3(服务端要点)、§9.1(服务端迁移)、§11 组 1–3。Task 1 配置;Task 2 D1 表;Task 3 协议;Task 4 SQLite 双表;Task 5–9 DO(骨架/鉴权/同步/squash/RPC+KV);Task 10 Worker 路由(发布/公开读/WS 升级);Task 11 迁移端点。
- **未覆盖(属计划 B/C,符合预期)**:客户端 SyncEngine remote、EditorPage、发布 UI、awareness 客户端、客户端迁移修正。
- **占位符扫描**:无 TBD/TODO。`scheduleSquash` 在 Task 7 是有意空占位、Task 8 填充,已注明。`PLACEHOLDER_DEV_KV_ID`(Task 1)是真实需运维创建的 KV id,已注明本地测试不依赖它。
- **类型一致性**:`MSG` / `encodeMessage` / `decodeMessage` / `encodeLoadReply`(Task 3)在 Task 5–7 一致使用;`DoSqlStore` 方法名(`init`/`appendUpdate`/`countUpdates`/`getMergedDoc`/`isEmpty`/`squash`/`seedSnapshot`,Task 4)在 Task 5/8/9 一致;`SocketAttachment`(Task 5)在 Task 6–7 一致;`docStub`(Task 10)。
- **平台 API 风险**:Cloudflare DO/WS/alarm/`cloudflare:test` 的精确签名在「平台 API 核验须知」要求实现时核对 —— 这是平台代码的固有不确定性,非占位符。
