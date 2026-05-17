# 时间轴共享与编辑权限管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把共享 popover 改造为按角色分化的权限管理面板:查看者可创建副本 / 申请编辑权限,作者可开关申请、管理编辑者与申请者名单,撤销编辑权限对在线用户立即生效。

**Architecture:** 后端用 D1 新表 `timeline_edit_requests` 存待处理申请、`timelines.allow_edit_requests` 列存申请开关;7 个 HTTP 端点(1 改 6 新)管理权限;移除编辑者时 Worker 调 Durable Object RPC `kickUser` 用自定义 close code `4001` 主动断开该用户的协同 WS。前端 `SharePopover` 重写为 7 态面板,呈现态由纯函数 `deriveShareView` 推导。

**Tech Stack:** TypeScript、Hono、Cloudflare D1 / Durable Objects、Yjs、React 19、Vitest(常规 + `@cloudflare/vitest-pool-workers`)。

**设计依据:** `design/superpowers/specs/2026-05-18-timeline-share-permissions-design.md`

---

## 约束与门禁

> - 类型检查务必用 `pnpm tsc -b --noEmit`(build 模式)。`pnpm exec tsc --noEmit` 对根 solution tsconfig 是 no-op。
> - husky `pre-commit` 对全工程跑 `tsc -b` + 对 staged 文件跑 prettier / eslint。每次 commit 前改动须能过 `tsc -b`。
> - 提交信息 / 作者**禁止包含 "claude"**(大小写不敏感),`.husky/commit-msg` 会拒绝。不加 `Co-Authored-By`。
> - `git add` 只显式列出本计划涉及的文件路径,**不要 `git add -A`**。
> - 常规测试 `pnpm test:run <pattern>`;Workers 测试 `pnpm test:workers`(真实 D1 / DO)。
> - migration 文件由 `vitest.workers.config.ts` 经 `readD1Migrations` 自动注入测试库,新增 `0005` 后所有 `*.workers.test.ts` 会自动应用。

## 文件结构

| 文件                                       | 责任                       | 改动                                                                        |
| ------------------------------------------ | -------------------------- | --------------------------------------------------------------------------- |
| `migrations/0005_create_edit_requests.sql` | D1 schema                  | 新建:开关列 + `timeline_editors.user_name` 列 + `timeline_edit_requests` 表 |
| `src/workers/routes/timelines.ts`          | 时间轴公开读 / 发布 / 删除 | `GET /:id` 增 3 字段;`docStub` 改 `export`                                  |
| `src/workers/routes/share.ts`              | 共享权限管理端点           | 新建:6 个端点                                                               |
| `src/workers/routes/share.workers.test.ts` | 上者的 Workers 测试        | 新建                                                                        |
| `src/workers/index.ts`                     | 路由装配 + CORS            | 挂载 `shareRoutes`;CORS `allowMethods` 加 `PATCH`                           |
| `src/workers/durable/TimelineDoc.ts`       | 协同 Durable Object        | 新增 RPC `kickUser`                                                         |
| `src/collab/RemoteConnection.ts`           | 远端协同连接               | `ConnectionStatus` 增 `'revoked'`;`onClose` 识别 `4001`                     |
| `src/api/timelineShareApi.ts`              | 共享 API 客户端            | 扩展 `SharedTimelineResponse`;新增 6 个函数                                 |
| `src/components/shareView.ts`              | popover 呈现态推导(纯函数) | 新建                                                                        |
| `src/components/shareView.test.ts`         | 上者单测                   | 新建                                                                        |
| `src/components/SharePopoverAuthor.tsx`    | 作者面板(开关 + 两个列表)  | 新建                                                                        |
| `src/components/SharePopover.tsx`          | 共享 popover 主组件        | 重写                                                                        |
| `src/components/EditorToolbar.tsx`         | 编辑器工具栏               | 恒渲染 `SharePopover`,删除独立创建副本按钮                                  |
| `src/pages/EditorPage.tsx`                 | 编辑 / 查看页              | 取并下传角色字段;响应 `'revoked'`                                           |

---

## Task 1: D1 migration —— 申请开关、编辑者用户名、申请表

**Files:**

- Create: `migrations/0005_create_edit_requests.sql`

- [ ] **Step 1: 写 migration 文件**

`migrations/0005_create_edit_requests.sql`:

```sql
-- 申请开关:每条时间轴是否允许他人申请编辑权限
ALTER TABLE timelines ADD COLUMN allow_edit_requests INTEGER NOT NULL DEFAULT 0;

-- 编辑者列表需展示用户名(原表无此列)
ALTER TABLE timeline_editors ADD COLUMN user_name TEXT NOT NULL DEFAULT '';

-- 待处理的编辑权限申请。只存 pending 状态:通过/拒绝即删行。
CREATE TABLE IF NOT EXISTS timeline_edit_requests (
  timeline_id TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  user_name   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (timeline_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_timeline_edit_requests_timeline
  ON timeline_edit_requests (timeline_id);
```

- [ ] **Step 2: 跑 Workers 测试,确认 migration 干净应用**

Run: `pnpm test:workers`
Expected: 全绿。`applyD1Migrations` 会把 `0005` 一并应用;若 SQL 有语法错,所有 `*.workers.test.ts` 会在 `beforeAll` 失败。

- [ ] **Step 3: 提交**

```bash
git add migrations/0005_create_edit_requests.sql
git commit -m "feat(share): add D1 schema for edit requests and share settings"
```

---

## Task 2: `GET /api/timelines/:id` 增加角色字段

**Files:**

- Modify: `src/workers/routes/timelines.ts`
- Test: `src/workers/routes/timelines.workers.test.ts`

### 背景

现有 `GET /:id` 返回 `{ role, authorName, snapshot? }`。需新增 `isAuthor`、`allowEditRequests`、`hasPendingRequest`。带鉴权的响应改为 `private, no-cache`(含用户相关字段),匿名维持 `public, max-age=60`。

- [ ] **Step 1: 写失败测试**

在 `src/workers/routes/timelines.workers.test.ts` 的 `describe('GET /api/timelines/:id role', ...)` 块末尾追加:

```ts
it('GET /:id 返回 isAuthor/allowEditRequests/hasPendingRequest', async () => {
  const id = await publishOne('share-fields-0000000001', 'T')
  await env.healerbook_snapshots.put(`tl-snapshot:${id}`, JSON.stringify({ x: 1 }))

  // 匿名:全 false
  const anon = (await (await SELF.fetch(`https://app/api/timelines/${id}`)).json()) as {
    isAuthor: boolean
    allowEditRequests: boolean
    hasPendingRequest: boolean
  }
  expect(anon.isAuthor).toBe(false)
  expect(anon.allowEditRequests).toBe(false)
  expect(anon.hasPendingRequest).toBe(false)

  // 作者:isAuthor true
  const author = (await (
    await SELF.fetch(`https://app/api/timelines/${id}`, {
      headers: { Authorization: `Bearer ${await authorJwt()}` },
    })
  ).json()) as { isAuthor: boolean }
  expect(author.isAuthor).toBe(true)

  // 非编辑者且有待处理申请:hasPendingRequest true
  await env.healerbook_timelines
    .prepare(
      'INSERT INTO timeline_edit_requests (timeline_id, user_id, user_name, created_at) VALUES (?,?,?,?)'
    )
    .bind(id, 'viewer-1', 'Viewer', Date.now())
    .run()
  const viewerJwt = await signAccessToken('viewer-1', 'Viewer', JWT_SECRET)
  const viewer = (await (
    await SELF.fetch(`https://app/api/timelines/${id}`, {
      headers: { Authorization: `Bearer ${viewerJwt}` },
    })
  ).json()) as { role: string; hasPendingRequest: boolean }
  expect(viewer.role).toBe('viewer')
  expect(viewer.hasPendingRequest).toBe(true)
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `pnpm test:workers timelines`
Expected: FAIL —— 响应缺 `isAuthor` 等字段(`undefined`)。

- [ ] **Step 3: 改写 `GET /:id` 处理函数**

把 `src/workers/routes/timelines.ts` 中 `app.get('/:id', ...)` 整段(约 59–93 行)替换为:

```ts
// 公开读:返回 { role, authorName, isAuthor, allowEditRequests, hasPendingRequest, snapshot? }
app.get('/:id', async c => {
  const id = c.req.param('id')

  const row = await c.env.healerbook_timelines
    .prepare('SELECT author_id, author_name, allow_edit_requests FROM timelines WHERE id = ?')
    .bind(id)
    .first<{ author_id: string; author_name: string; allow_edit_requests: number }>()
  if (!row) return c.json({ error: 'Not found' }, 404)

  const allowEditRequests = row.allow_edit_requests === 1
  const user = await tryReadAuth(c)
  let role: 'editor' | 'viewer' = 'viewer'
  let isAuthor = false
  let hasPendingRequest = false
  if (user) {
    isAuthor = user.userId === row.author_id
    const editorRow = await c.env.healerbook_timelines
      .prepare('SELECT 1 FROM timeline_editors WHERE timeline_id = ? AND user_id = ?')
      .bind(id, user.userId)
      .first()
    if (editorRow) role = 'editor'
    if (role === 'viewer') {
      const reqRow = await c.env.healerbook_timelines
        .prepare('SELECT 1 FROM timeline_edit_requests WHERE timeline_id = ? AND user_id = ?')
        .bind(id, user.userId)
        .first()
      hasPendingRequest = reqRow != null
    }
  }

  const base = { role, authorName: row.author_name, isAuthor, allowEditRequests, hasPendingRequest }

  if (role === 'editor') {
    return c.json(base, 200, { 'Cache-Control': 'private, no-cache' })
  }

  // viewer:需要 snapshot(KV 优先,未命中经 DO RPC)
  const cached = await c.env.healerbook_snapshots.get(`tl-snapshot:${id}`)
  const snapshot = cached
    ? (JSON.parse(cached) as object)
    : await docStub(c.env, id).getSnapshotJson()
  if (!snapshot) return c.json({ error: 'Not found' }, 404)
  // 登录用户的响应含 hasPendingRequest(用户相关),不可公开缓存
  const cacheControl = user ? 'private, no-cache' : 'public, max-age=60'
  return c.json({ ...base, snapshot }, 200, { 'Cache-Control': cacheControl })
})
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `pnpm test:workers timelines`
Expected: PASS,含新增用例及原有 role 用例。

- [ ] **Step 5: 校验并提交**

Run: `pnpm tsc -b --noEmit` → 0 error;`pnpm lint` → 0 error

```bash
git add src/workers/routes/timelines.ts src/workers/routes/timelines.workers.test.ts
git commit -m "feat(share): expose role fields on GET timeline endpoint"
```

---

## Task 3: `share.ts` —— 作者读 / 申请开关端点

**Files:**

- Create: `src/workers/routes/share.ts`
- Create: `src/workers/routes/share.workers.test.ts`
- Modify: `src/workers/index.ts`

- [ ] **Step 1: 写失败测试**

`src/workers/routes/share.workers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { env, SELF } from 'cloudflare:test'
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
    expect(body.editors).toEqual([]) // 作者本人被排除
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
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `pnpm test:workers share`
Expected: FAIL —— `share.ts` 不存在 / 路由未挂载,`/share` 命中 404。

- [ ] **Step 3: 创建 `share.ts`**

`src/workers/routes/share.ts`:

```ts
/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono'
import { vValidator } from '@hono/valibot-validator'
import * as v from 'valibot'
import type { AppEnv } from '../env'
import { requireAuth } from '../middleware/requireAuth'

const app = new Hono<AppEnv>()

/** 校验调用者是该时间轴作者;是则返回作者行,否则 null */
async function findAuthor(
  env: AppEnv['Bindings'],
  timelineId: string,
  userId: string
): Promise<{ author_id: string } | null> {
  const row = await env.healerbook_timelines
    .prepare('SELECT author_id FROM timelines WHERE id = ?')
    .bind(timelineId)
    .first<{ author_id: string }>()
  if (!row || row.author_id !== userId) return null
  return row
}

// 作者读:申请开关 + 编辑者列表 + 申请者列表
app.get('/:id/share', requireAuth, async c => {
  const auth = c.get('auth')!
  const id = c.req.param('id')
  const author = await findAuthor(c.env, id, auth.userId)
  if (!author) return c.json({ error: 'Forbidden' }, 403)

  const tl = await c.env.healerbook_timelines
    .prepare('SELECT allow_edit_requests FROM timelines WHERE id = ?')
    .bind(id)
    .first<{ allow_edit_requests: number }>()

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
    allowEditRequests: (tl?.allow_edit_requests ?? 0) === 1,
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
```

- [ ] **Step 4: 挂载路由 + 放行 PATCH**

在 `src/workers/index.ts`:

import 区加 `import { shareRoutes } from './routes/share'`。

CORS `allowMethods` 加 `PATCH`:

```ts
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
```

在 `app.route('/api/timelines', timelinesRoutes)` 之后加一行(两个 sub-router 同挂 `/api/timelines`,Hono 按各自 path pattern 分发,`/:id` 与 `/:id/share` 不冲突):

```ts
app.route('/api/timelines', shareRoutes)
```

- [ ] **Step 5: 跑测试,确认通过**

Run: `pnpm test:workers share`
Expected: PASS。

- [ ] **Step 6: 校验并提交**

Run: `pnpm tsc -b --noEmit` → 0 error;`pnpm lint` → 0 error

```bash
git add src/workers/routes/share.ts src/workers/routes/share.workers.test.ts src/workers/index.ts
git commit -m "feat(share): add author share-settings endpoints"
```

---

## Task 4: 申请生命周期端点 —— 发起 / 通过 / 拒绝

**Files:**

- Modify: `src/workers/routes/share.ts`
- Test: `src/workers/routes/share.workers.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/workers/routes/share.workers.test.ts` 末尾追加:

```ts
describe('编辑权限申请生命周期', () => {
  it('开关开时可发起申请,写入 timeline_edit_requests', async () => {
    const id = await publishOne('share-req-00000000001')
    await SELF.fetch(`https://app/api/timelines/${id}/share`, {
      method: 'PATCH',
      headers: {
        ...(await authHeader(AUTHOR.id, AUTHOR.name)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ allowEditRequests: true }),
    })
    const res = await SELF.fetch(`https://app/api/timelines/${id}/edit-requests`, {
      method: 'POST',
      headers: await authHeader('applicant-1', 'Applicant'),
    })
    expect(res.status).toBe(201)
    const row = await env.healerbook_timelines
      .prepare('SELECT user_name FROM timeline_edit_requests WHERE timeline_id = ? AND user_id = ?')
      .bind(id, 'applicant-1')
      .first<{ user_name: string }>()
    expect(row?.user_name).toBe('Applicant')
  })

  it('开关关时发起申请返回 403', async () => {
    const id = await publishOne('share-req-00000000002')
    const res = await SELF.fetch(`https://app/api/timelines/${id}/edit-requests`, {
      method: 'POST',
      headers: await authHeader('applicant-2', 'A'),
    })
    expect(res.status).toBe(403)
  })

  it('已是编辑者发起申请返回 409', async () => {
    const id = await publishOne('share-req-00000000003')
    const res = await SELF.fetch(`https://app/api/timelines/${id}/edit-requests`, {
      method: 'POST',
      headers: await authHeader(AUTHOR.id, AUTHOR.name), // 作者本身在 editors 表
    })
    expect(res.status).toBe(409)
  })

  it('作者通过申请:删 request 行 + 写 editors 行', async () => {
    const id = await publishOne('share-req-00000000004')
    await env.healerbook_timelines
      .prepare(
        'INSERT INTO timeline_edit_requests (timeline_id, user_id, user_name, created_at) VALUES (?,?,?,?)'
      )
      .bind(id, 'app-4', 'App4', Date.now())
      .run()
    const res = await SELF.fetch(`https://app/api/timelines/${id}/edit-requests/app-4/approve`, {
      method: 'POST',
      headers: await authHeader(AUTHOR.id, AUTHOR.name),
    })
    expect(res.status).toBe(200)
    const req = await env.healerbook_timelines
      .prepare('SELECT 1 FROM timeline_edit_requests WHERE timeline_id = ? AND user_id = ?')
      .bind(id, 'app-4')
      .first()
    expect(req).toBeNull()
    const editor = await env.healerbook_timelines
      .prepare('SELECT user_name FROM timeline_editors WHERE timeline_id = ? AND user_id = ?')
      .bind(id, 'app-4')
      .first<{ user_name: string }>()
    expect(editor?.user_name).toBe('App4')
  })

  it('作者拒绝申请:删 request 行,不写 editors', async () => {
    const id = await publishOne('share-req-00000000005')
    await env.healerbook_timelines
      .prepare(
        'INSERT INTO timeline_edit_requests (timeline_id, user_id, user_name, created_at) VALUES (?,?,?,?)'
      )
      .bind(id, 'app-5', 'App5', Date.now())
      .run()
    const res = await SELF.fetch(`https://app/api/timelines/${id}/edit-requests/app-5/reject`, {
      method: 'POST',
      headers: await authHeader(AUTHOR.id, AUTHOR.name),
    })
    expect(res.status).toBe(200)
    const req = await env.healerbook_timelines
      .prepare('SELECT 1 FROM timeline_edit_requests WHERE timeline_id = ? AND user_id = ?')
      .bind(id, 'app-5')
      .first()
    expect(req).toBeNull()
    const editor = await env.healerbook_timelines
      .prepare('SELECT 1 FROM timeline_editors WHERE timeline_id = ? AND user_id = ?')
      .bind(id, 'app-5')
      .first()
    expect(editor).toBeNull()
  })

  it('非作者 approve/reject 返回 403', async () => {
    const id = await publishOne('share-req-00000000006')
    const res = await SELF.fetch(`https://app/api/timelines/${id}/edit-requests/whoever/approve`, {
      method: 'POST',
      headers: await authHeader('intruder', 'X'),
    })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `pnpm test:workers share`
Expected: FAIL —— 端点未实现,命中 404。

- [ ] **Step 3: 在 `share.ts` 增加 3 个端点**

在 `src/workers/routes/share.ts` 的 `export { app as shareRoutes }` 之前插入:

```ts
// 用户发起编辑权限申请
app.post('/:id/edit-requests', requireAuth, async c => {
  const auth = c.get('auth')!
  const id = c.req.param('id')

  const tl = await c.env.healerbook_timelines
    .prepare('SELECT allow_edit_requests FROM timelines WHERE id = ?')
    .bind(id)
    .first<{ allow_edit_requests: number }>()
  if (!tl) return c.json({ error: 'Not found' }, 404)
  if (tl.allow_edit_requests !== 1) return c.json({ error: 'requests_disabled' }, 403)

  const editor = await c.env.healerbook_timelines
    .prepare('SELECT 1 FROM timeline_editors WHERE timeline_id = ? AND user_id = ?')
    .bind(id, auth.userId)
    .first()
  if (editor) return c.json({ error: 'already_editor' }, 409)

  await c.env.healerbook_timelines
    .prepare(
      'INSERT OR IGNORE INTO timeline_edit_requests (timeline_id, user_id, user_name, created_at) VALUES (?,?,?,?)'
    )
    .bind(id, auth.userId, auth.username, Date.now())
    .run()
  return c.json({ ok: true }, 201)
})

// 作者通过申请:删 request 行 + 写 editors 行
app.post('/:id/edit-requests/:userId/approve', requireAuth, async c => {
  const auth = c.get('auth')!
  const id = c.req.param('id')
  const targetUserId = c.req.param('userId')
  const author = await findAuthor(c.env, id, auth.userId)
  if (!author) return c.json({ error: 'Forbidden' }, 403)

  const reqRow = await c.env.healerbook_timelines
    .prepare('SELECT user_name FROM timeline_edit_requests WHERE timeline_id = ? AND user_id = ?')
    .bind(id, targetUserId)
    .first<{ user_name: string }>()
  if (!reqRow) return c.json({ error: 'Not found' }, 404)

  await c.env.healerbook_timelines.batch([
    c.env.healerbook_timelines
      .prepare('DELETE FROM timeline_edit_requests WHERE timeline_id = ? AND user_id = ?')
      .bind(id, targetUserId),
    c.env.healerbook_timelines
      .prepare(
        'INSERT OR IGNORE INTO timeline_editors (timeline_id, user_id, user_name, created_at) VALUES (?,?,?,?)'
      )
      .bind(id, targetUserId, reqRow.user_name, Date.now()),
  ])
  return c.json({ ok: true })
})

// 作者拒绝申请:删 request 行
app.post('/:id/edit-requests/:userId/reject', requireAuth, async c => {
  const auth = c.get('auth')!
  const id = c.req.param('id')
  const targetUserId = c.req.param('userId')
  const author = await findAuthor(c.env, id, auth.userId)
  if (!author) return c.json({ error: 'Forbidden' }, 403)

  const result = await c.env.healerbook_timelines
    .prepare('DELETE FROM timeline_edit_requests WHERE timeline_id = ? AND user_id = ?')
    .bind(id, targetUserId)
    .run()
  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `pnpm test:workers share`
Expected: PASS。

- [ ] **Step 5: 校验并提交**

Run: `pnpm tsc -b --noEmit` → 0 error;`pnpm lint` → 0 error

```bash
git add src/workers/routes/share.ts src/workers/routes/share.workers.test.ts
git commit -m "feat(share): add edit-request lifecycle endpoints"
```

---

## Task 5: Durable Object RPC `kickUser`

**Files:**

- Modify: `src/workers/durable/TimelineDoc.ts`
- Test: `src/workers/durable/TimelineDoc.workers.test.ts`

### 背景

移除编辑者后需断开该用户当前的协同 WS。新增 RPC `kickUser`,用应用自定义 close code `4001`(区别于握手期的 `1008`)。`SocketAttachment` 已存 `userId`。

- [ ] **Step 1: 写失败测试**

在 `src/workers/durable/TimelineDoc.workers.test.ts` 的 `it('LOAD 返回 LOAD_REPLY;PUSH 广播给其他连接', ...)` 之前插入:

```ts
it('kickUser 用 4001 关闭目标用户连接,不影响他人', async () => {
  const docName = 't-kick-1'
  const wsA = await authConnect(docName, 'kick-a')
  const wsB = await authConnect(docName, 'kick-b')
  const closedA = new Promise<CloseEvent>(resolve => {
    wsA.addEventListener('close', e => resolve(e as CloseEvent), { once: true })
  })
  const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName(docName))
  await runInDurableObject(stub, async instance => {
    await instance.kickUser('kick-a')
  })
  const ev = await closedA
  expect(ev.code).toBe(4001)
  expect(wsB.readyState).toBe(WebSocket.OPEN)
})

it('kickUser 对不在线用户为 no-op', async () => {
  const docName = 't-kick-2'
  const wsA = await authConnect(docName, 'kick-online')
  const stub = env.TIMELINE_DOC.get(env.TIMELINE_DOC.idFromName(docName))
  await runInDurableObject(stub, async instance => {
    await instance.kickUser('nobody-here')
  })
  expect(wsA.readyState).toBe(WebSocket.OPEN)
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `pnpm test:workers TimelineDoc`
Expected: FAIL —— `instance.kickUser` 不是函数。

- [ ] **Step 3: 在 `TimelineDoc.ts` 增加 `kickUser` RPC**

在 `src/workers/durable/TimelineDoc.ts` 的 `seed(...)` 方法之前(约 186 行)插入:

```ts
  /**
   * Worker 在移除编辑者后调用:断开该用户的所有连接。
   * 用应用自定义 close code 4001(区别于握手期的 1008),客户端据此切只读。
   */
  async kickUser(userId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const att = (ws.deserializeAttachment() ?? { authed: false }) as SocketAttachment
      if (att.authed && att.userId === userId) {
        try {
          ws.close(4001, 'editor revoked')
        } catch {
          // 已关闭的连接忽略
        }
      }
    }
  }
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `pnpm test:workers TimelineDoc`
Expected: PASS。

- [ ] **Step 5: 校验并提交**

Run: `pnpm tsc -b --noEmit` → 0 error;`pnpm lint` → 0 error

```bash
git add src/workers/durable/TimelineDoc.ts src/workers/durable/TimelineDoc.workers.test.ts
git commit -m "feat(share): add kickUser RPC to disconnect revoked editors"
```

---

## Task 6: `DELETE /api/timelines/:id/editors/:userId` —— 移除编辑者

**Files:**

- Modify: `src/workers/routes/timelines.ts`（`docStub` 改 export）
- Modify: `src/workers/routes/share.ts`
- Test: `src/workers/routes/share.workers.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/workers/routes/share.workers.test.ts` 末尾追加:

```ts
describe('DELETE /api/timelines/:id/editors/:userId', () => {
  it('作者移除编辑者:删 timeline_editors 行', async () => {
    const id = await publishOne('share-rm-000000000001')
    await env.healerbook_timelines
      .prepare(
        'INSERT INTO timeline_editors (timeline_id, user_id, user_name, created_at) VALUES (?,?,?,?)'
      )
      .bind(id, 'editor-x', 'EditorX', Date.now())
      .run()
    const res = await SELF.fetch(`https://app/api/timelines/${id}/editors/editor-x`, {
      method: 'DELETE',
      headers: await authHeader(AUTHOR.id, AUTHOR.name),
    })
    expect(res.status).toBe(200)
    const row = await env.healerbook_timelines
      .prepare('SELECT 1 FROM timeline_editors WHERE timeline_id = ? AND user_id = ?')
      .bind(id, 'editor-x')
      .first()
    expect(row).toBeNull()
  })

  it('不可移除作者本人,返回 400', async () => {
    const id = await publishOne('share-rm-000000000002')
    const res = await SELF.fetch(`https://app/api/timelines/${id}/editors/${AUTHOR.id}`, {
      method: 'DELETE',
      headers: await authHeader(AUTHOR.id, AUTHOR.name),
    })
    expect(res.status).toBe(400)
  })

  it('非作者移除编辑者返回 403', async () => {
    const id = await publishOne('share-rm-000000000003')
    const res = await SELF.fetch(`https://app/api/timelines/${id}/editors/whoever`, {
      method: 'DELETE',
      headers: await authHeader('intruder', 'X'),
    })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `pnpm test:workers share`
Expected: FAIL —— 端点未实现。

- [ ] **Step 3: `timelines.ts` 把 `docStub` 改为 export**

在 `src/workers/routes/timelines.ts` 中,把 `function docStub(` 改为 `export function docStub(`(仅加 `export` 关键字,函数体不变)。

- [ ] **Step 4: 在 `share.ts` 增加 DELETE 端点**

`src/workers/routes/share.ts` 顶部 import 区加:

```ts
import { docStub } from './timelines'
```

在 `export { app as shareRoutes }` 之前插入:

```ts
// 作者移除编辑者:删 timeline_editors 行 + 调 DO 断开该用户连接
app.delete('/:id/editors/:userId', requireAuth, async c => {
  const auth = c.get('auth')!
  const id = c.req.param('id')
  const targetUserId = c.req.param('userId')
  const author = await findAuthor(c.env, id, auth.userId)
  if (!author) return c.json({ error: 'Forbidden' }, 403)
  if (targetUserId === author.author_id) {
    return c.json({ error: 'cannot_remove_author' }, 400)
  }
  await c.env.healerbook_timelines
    .prepare('DELETE FROM timeline_editors WHERE timeline_id = ? AND user_id = ?')
    .bind(id, targetUserId)
    .run()
  await docStub(c.env, id).kickUser(targetUserId)
  return c.json({ ok: true })
})
```

- [ ] **Step 5: 跑测试,确认通过**

Run: `pnpm test:workers share`
Expected: PASS。

- [ ] **Step 6: 校验并提交**

Run: `pnpm tsc -b --noEmit` → 0 error;`pnpm lint` → 0 error

```bash
git add src/workers/routes/timelines.ts src/workers/routes/share.ts src/workers/routes/share.workers.test.ts
git commit -m "feat(share): add remove-editor endpoint with live disconnect"
```

---

## Task 7: 客户端识别 `4001` 撤销关闭

**Files:**

- Modify: `src/collab/RemoteConnection.ts`
- Test: `src/collab/RemoteConnection.test.ts`

### 背景

`RemoteConnection` 现把 close code `1008` 视为终态(不重连)。新增:`4001` 同样终态,但状态报告为新增的 `'revoked'`。

- [ ] **Step 1: 写失败测试**

在 `src/collab/RemoteConnection.test.ts` 的 `describe('RemoteConnection auth hardening', ...)` 块内,末尾(最后一个 `it` 之后、块结束 `})` 之前)追加:

```ts
it('treats a server close with code 4001 as terminal and reports revoked', async () => {
  const doc = new Y.Doc()
  const statuses: string[] = []
  const conn = new RemoteConnection(
    'ws://x/connect',
    doc,
    new Awareness(doc),
    () => Promise.resolve('j'),
    s => statuses.push(s)
  )
  conn.connect()
  await lastSocket().fireOpen()
  lastSocket().fireClose(4001)
  expect(statuses[statuses.length - 1]).toBe('revoked')
  expect(FakeWebSocket.instances.length).toBe(1) // 不重连
  conn.destroy()
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `pnpm test:run RemoteConnection`
Expected: FAIL —— `4001` 当前走重连分支,末状态非 `'revoked'`。

- [ ] **Step 3: 改 `RemoteConnection.ts`**

把 `ConnectionStatus` 类型(第 6 行)改为:

```ts
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'revoked'
```

在 `onClose` 方法中,`if (code === 1008) { ... }` 整段之后插入:

```ts
// 服务端以 4001 撤销编辑权限:终态,且状态报告 'revoked' 以便上层切只读
if (code === 4001) {
  this.closed = true
  this.setStatus('revoked')
  return
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `pnpm test:run RemoteConnection`
Expected: PASS,含原有用例无回归。

- [ ] **Step 5: 校验并提交**

Run: `pnpm tsc -b --noEmit` → 0 error;`pnpm lint` → 0 error

```bash
git add src/collab/RemoteConnection.ts src/collab/RemoteConnection.test.ts
git commit -m "feat(share): recognize 4001 revoke close on the client"
```

---

## Task 8: 共享 API 客户端

**Files:**

- Modify: `src/api/timelineShareApi.ts`

### 背景

`SharedTimelineResponse` 需带新字段;新增 6 个共享管理 API 函数。本文件为薄 HTTP 封装,行为已被 Task 2–6 的 Worker 集成测试覆盖,无需单测;由 `tsc -b` 保证类型正确。

- [ ] **Step 1: 扩展 `SharedTimelineResponse` 与 `fetchSharedTimeline`**

把 `src/api/timelineShareApi.ts` 中 `SharedTimelineResponse` 接口、`RawSharedResponse` 接口、`fetchSharedTimeline` 函数替换为:

```ts
/** GET /api/timelines/:id 的角色化响应 */
export interface SharedTimelineResponse {
  role: 'editor' | 'viewer'
  authorName: string
  isAuthor: boolean
  allowEditRequests: boolean
  hasPendingRequest: boolean
  /** viewer 角色携带;editor 角色为 undefined(编辑端连 WS 取全量) */
  snapshot?: Timeline
}
```

```ts
interface RawSharedResponse {
  role: 'editor' | 'viewer'
  authorName: string
  isAuthor: boolean
  allowEditRequests: boolean
  hasPendingRequest: boolean
  snapshot?: Timeline
}

/**
 * 获取共享时间轴的角色与(viewer 的)snapshot。
 * 已登录时 Worker 据 Authorization 头判定 editor / viewer。
 */
export async function fetchSharedTimeline(id: string): Promise<SharedTimelineResponse> {
  try {
    const raw = await apiClient.get(`timelines/${id}`).json<RawSharedResponse>()
    const result: SharedTimelineResponse = {
      role: raw.role,
      authorName: raw.authorName,
      isAuthor: raw.isAuthor,
      allowEditRequests: raw.allowEditRequests,
      hasPendingRequest: raw.hasPendingRequest,
    }
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
```

- [ ] **Step 2: 追加 6 个共享管理函数**

在 `src/api/timelineShareApi.ts` 文件末尾追加:

```ts
/** 作者面板数据:申请开关 + 编辑者列表 + 申请者列表 */
export interface ShareState {
  allowEditRequests: boolean
  editors: { userId: string; userName: string }[]
  applicants: { userId: string; userName: string; createdAt: number }[]
}

/** 作者读共享管理面板数据 */
export async function fetchShareState(id: string): Promise<ShareState> {
  try {
    return await apiClient.get(`timelines/${id}/share`).json<ShareState>()
  } catch (err) {
    if (err instanceof HTTPError) throw new Error(err.message)
    throw err
  }
}

/** 作者设置申请开关 */
export async function setAllowEditRequests(id: string, value: boolean): Promise<void> {
  try {
    await apiClient.patch(`timelines/${id}/share`, { json: { allowEditRequests: value } })
  } catch (err) {
    if (err instanceof HTTPError) throw new Error(err.message)
    throw err
  }
}

/** 用户发起编辑权限申请 */
export async function requestEditPermission(id: string): Promise<void> {
  try {
    await apiClient.post(`timelines/${id}/edit-requests`)
  } catch (err) {
    if (err instanceof HTTPError) throw new Error(err.message)
    throw err
  }
}

/** 作者通过申请 */
export async function approveEditRequest(id: string, userId: string): Promise<void> {
  try {
    await apiClient.post(`timelines/${id}/edit-requests/${userId}/approve`)
  } catch (err) {
    if (err instanceof HTTPError) throw new Error(err.message)
    throw err
  }
}

/** 作者拒绝申请 */
export async function rejectEditRequest(id: string, userId: string): Promise<void> {
  try {
    await apiClient.post(`timelines/${id}/edit-requests/${userId}/reject`)
  } catch (err) {
    if (err instanceof HTTPError) throw new Error(err.message)
    throw err
  }
}

/** 作者移除编辑者 */
export async function removeEditor(id: string, userId: string): Promise<void> {
  try {
    await apiClient.delete(`timelines/${id}/editors/${userId}`)
  } catch (err) {
    if (err instanceof HTTPError) throw new Error(err.message)
    throw err
  }
}
```

- [ ] **Step 3: 校验**

Run: `pnpm tsc -b --noEmit` → 0 error
Run: `pnpm lint` → 0 error / 0 warning

- [ ] **Step 4: 提交**

```bash
git add src/api/timelineShareApi.ts
git commit -m "feat(share): add share-management API client functions"
```

---

## Task 9: `deriveShareView` 纯函数

**Files:**

- Create: `src/components/shareView.ts`
- Create: `src/components/shareView.test.ts`

### 背景

popover 呈现态与触发按钮样式由纯函数从角色 / 登录态 / 开关推导,与 React 解耦、独立可测。

- [ ] **Step 1: 写失败测试**

`src/components/shareView.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { deriveShareView, deriveShareTrigger, type ShareViewInput } from './shareView'

const base: ShareViewInput = {
  isPublished: true,
  isLoggedIn: true,
  role: 'viewer',
  isAuthor: false,
  allowEditRequests: false,
  hasPendingRequest: false,
  isRevoked: false,
}

describe('deriveShareView', () => {
  it('未发布 → publish', () => {
    expect(deriveShareView({ ...base, isPublished: false }).kind).toBe('publish')
  })
  it('作者 → author', () => {
    expect(deriveShareView({ ...base, isAuthor: true }).kind).toBe('author')
  })
  it('编辑者(非作者) → editor', () => {
    expect(deriveShareView({ ...base, role: 'editor' }).kind).toBe('editor')
  })
  it('viewer 未登录 → viewer-anon', () => {
    expect(deriveShareView({ ...base, isLoggedIn: false }).kind).toBe('viewer-anon')
  })
  it('viewer 已登录 + 开关关 → viewer-no-request', () => {
    expect(deriveShareView({ ...base, allowEditRequests: false }).kind).toBe('viewer-no-request')
  })
  it('viewer 已登录 + 开关开 + 未申请 → viewer-can-request', () => {
    expect(deriveShareView({ ...base, allowEditRequests: true }).kind).toBe('viewer-can-request')
  })
  it('viewer 已登录 + 开关开 + 已申请 → viewer-requested', () => {
    expect(
      deriveShareView({ ...base, allowEditRequests: true, hasPendingRequest: true }).kind
    ).toBe('viewer-requested')
  })
  it('被撤销:即使 role=editor 也按 viewer 处理', () => {
    expect(deriveShareView({ ...base, role: 'editor', isRevoked: true }).kind).toBe(
      'viewer-no-request'
    )
  })
  it('被撤销:即使 isAuthor 也按 viewer 处理', () => {
    expect(deriveShareView({ ...base, isAuthor: true, isRevoked: true }).kind).not.toBe('author')
  })
})

describe('deriveShareTrigger', () => {
  it('未发布 → publish', () => {
    expect(deriveShareTrigger({ ...base, isPublished: false })).toBe('publish')
  })
  it('作者 → author', () => {
    expect(deriveShareTrigger({ ...base, isAuthor: true })).toBe('author')
  })
  it('编辑者 → editor', () => {
    expect(deriveShareTrigger({ ...base, role: 'editor' })).toBe('editor')
  })
  it('viewer → viewer', () => {
    expect(deriveShareTrigger(base)).toBe('viewer')
  })
  it('被撤销的编辑者 → viewer', () => {
    expect(deriveShareTrigger({ ...base, role: 'editor', isRevoked: true })).toBe('viewer')
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `pnpm test:run shareView`
Expected: FAIL —— `./shareView` 不存在。

- [ ] **Step 3: 实现 `shareView.ts`**

`src/components/shareView.ts`:

```ts
/**
 * 共享 popover 的呈现态推导(纯函数,与 React 解耦)。
 * 7 个 popover 态见 design/superpowers/specs/2026-05-18-timeline-share-permissions-design.md。
 */

export type ShareView =
  | { kind: 'publish' } // 态1:本地未发布
  | { kind: 'viewer-anon' } // 态2a:未登录
  | { kind: 'viewer-no-request' } // 态2b:已登录无权限,开关关
  | { kind: 'viewer-can-request' } // 态3:可申请,未申请
  | { kind: 'viewer-requested' } // 态4:已申请
  | { kind: 'editor' } // 态5:编辑者(非作者)
  | { kind: 'author' } // 态6:作者

/** 触发按钮样式 */
export type ShareTrigger = 'publish' | 'author' | 'editor' | 'viewer'

export interface ShareViewInput {
  /** 是否已发布到云端(false 即本地草稿) */
  isPublished: boolean
  isLoggedIn: boolean
  role: 'editor' | 'viewer'
  isAuthor: boolean
  allowEditRequests: boolean
  hasPendingRequest: boolean
  /** 会话中被撤销编辑权限:UI 上等同 viewer */
  isRevoked: boolean
}

export function deriveShareView(input: ShareViewInput): ShareView {
  if (!input.isPublished) return { kind: 'publish' }
  const role = input.isRevoked ? 'viewer' : input.role
  const isAuthor = input.isRevoked ? false : input.isAuthor
  if (isAuthor) return { kind: 'author' }
  if (role === 'editor') return { kind: 'editor' }
  if (!input.isLoggedIn) return { kind: 'viewer-anon' }
  if (!input.allowEditRequests) return { kind: 'viewer-no-request' }
  return input.hasPendingRequest ? { kind: 'viewer-requested' } : { kind: 'viewer-can-request' }
}

export function deriveShareTrigger(input: ShareViewInput): ShareTrigger {
  if (!input.isPublished) return 'publish'
  if (input.isRevoked) return 'viewer'
  if (input.isAuthor) return 'author'
  if (input.role === 'editor') return 'editor'
  return 'viewer'
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `pnpm test:run shareView`
Expected: PASS。

- [ ] **Step 5: 校验并提交**

Run: `pnpm tsc -b --noEmit` → 0 error;`pnpm lint` → 0 error

```bash
git add src/components/shareView.ts src/components/shareView.test.ts
git commit -m "feat(share): add deriveShareView pure helper"
```

---

## Task 10: 作者面板组件 `SharePopoverAuthor`

**Files:**

- Create: `src/components/SharePopoverAuthor.tsx`

### 背景

作者 popover(态6)的内容:复制分享链接 + 申请开关 + 编辑者列表 + 申请者列表。该组件挂载时经 `fetchShareState` 拉取列表数据;暂无消费者,作为独立新文件提交(`tsc -b` 保证类型正确,行为靠 Task 8 的 Worker 测试与手测覆盖)。

- [ ] **Step 1: 创建组件**

`src/components/SharePopoverAuthor.tsx`:

```tsx
/**
 * 作者共享面板:复制链接 + 申请开关 + 编辑者列表 + 申请者列表。
 */

import { useEffect, useState } from 'react'
import { Copy, Check, Loader2, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  fetchShareState,
  setAllowEditRequests,
  approveEditRequest,
  rejectEditRequest,
  removeEditor,
  type ShareState,
} from '@/api/timelineShareApi'

interface SharePopoverAuthorProps {
  timelineId: string
  shareUrl: string
}

export default function SharePopoverAuthor({ timelineId, shareUrl }: SharePopoverAuthorProps) {
  const [state, setState] = useState<ShareState | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [busyUserId, setBusyUserId] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    setLoading(true)
    fetchShareState(timelineId)
      .then(s => {
        if (!ignore) setState(s)
      })
      .catch(() => {
        if (!ignore) toast.error('加载共享设置失败')
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [timelineId])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('复制失败,请手动复制链接')
    }
  }

  const handleToggle = async (next: boolean) => {
    if (!state) return
    const prev = state.allowEditRequests
    setState({ ...state, allowEditRequests: next })
    try {
      await setAllowEditRequests(timelineId, next)
    } catch {
      setState({ ...state, allowEditRequests: prev })
      toast.error('设置失败')
    }
  }

  const handleApprove = async (userId: string, userName: string) => {
    if (!state) return
    setBusyUserId(userId)
    try {
      await approveEditRequest(timelineId, userId)
      setState({
        allowEditRequests: state.allowEditRequests,
        editors: [...state.editors, { userId, userName }],
        applicants: state.applicants.filter(a => a.userId !== userId),
      })
    } catch {
      toast.error('操作失败')
    } finally {
      setBusyUserId(null)
    }
  }

  const handleReject = async (userId: string) => {
    if (!state) return
    setBusyUserId(userId)
    try {
      await rejectEditRequest(timelineId, userId)
      setState({ ...state, applicants: state.applicants.filter(a => a.userId !== userId) })
    } catch {
      toast.error('操作失败')
    } finally {
      setBusyUserId(null)
    }
  }

  const handleRemoveEditor = async (userId: string) => {
    if (!state) return
    setBusyUserId(userId)
    try {
      await removeEditor(timelineId, userId)
      setState({ ...state, editors: state.editors.filter(e => e.userId !== userId) })
    } catch {
      toast.error('移除失败')
    } finally {
      setBusyUserId(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={shareUrl}
          className="flex-1 px-2 py-1 text-xs border rounded bg-muted font-mono truncate"
        />
        <Button variant="outline" size="sm" onClick={handleCopy}>
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>

      {loading || !state ? (
        <div className="flex justify-center py-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-sm">允许申请编辑权限</span>
            <Switch checked={state.allowEditRequests} onCheckedChange={handleToggle} />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">编辑者</p>
            {state.editors.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无其他编辑者</p>
            ) : (
              state.editors.map(e => (
                <div key={e.userId} className="flex items-center justify-between">
                  <span className="text-sm truncate">{e.userName}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    disabled={busyUserId === e.userId}
                    onClick={() => handleRemoveEditor(e.userId)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))
            )}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">申请编辑权限</p>
            {state.applicants.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无申请</p>
            ) : (
              state.applicants.map(a => (
                <div key={a.userId} className="flex items-center justify-between">
                  <span className="text-sm truncate">{a.userName}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-green-600 hover:text-green-700"
                      disabled={busyUserId === a.userId}
                      onClick={() => handleApprove(a.userId, a.userName)}
                    >
                      <Check className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      disabled={busyUserId === a.userId}
                      onClick={() => handleReject(a.userId)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 校验**

Run: `pnpm tsc -b --noEmit` → 0 error
Run: `pnpm lint` → 0 error / 0 warning

- [ ] **Step 3: 提交**

```bash
git add src/components/SharePopoverAuthor.tsx
git commit -m "feat(share): add author share panel component"
```

---

## Task 11: `SharePopover` 重写 + 工具栏 / 编辑页接线

**Files:**

- Modify: `src/components/SharePopover.tsx`（重写）
- Modify: `src/components/EditorToolbar.tsx`
- Modify: `src/pages/EditorPage.tsx`

### 背景

`SharePopover` 重写为 7 态面板;`EditorToolbar` 恒渲染 `SharePopover` 并删除独立创建副本按钮;`EditorPage` 取角色字段下传、响应 `'revoked'`。三者类型互相耦合,须同一 commit。组件层无单测(可测逻辑已在 Task 9 抽出),由 `tsc -b` / `lint` / `build` 把关。

- [ ] **Step 1: 重写 `SharePopover.tsx`**

把 `src/components/SharePopover.tsx` 整个文件替换为:

```tsx
/**
 * 共享 Popover —— 7 态权限管理面板。
 * 呈现态由 deriveShareView 推导,见 shareView.ts。
 */

import { useState } from 'react'
import { Copy, Check, Loader2, Globe, Upload, CloudUpload, Lock, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useAuth } from '@/hooks/useAuth'
import { useAuthStore } from '@/store/authStore'
import { useTimelineStore } from '@/store/timelineStore'
import type { Timeline } from '@/types/timeline'
import { publishTimeline, requestEditPermission } from '@/api/timelineShareApi'
import { IndexedDBDocStore } from '@/collab/storage/IndexedDBDocStore'
import { track } from '@/utils/analytics'
import { deriveShareView, deriveShareTrigger } from './shareView'
import SharePopoverAuthor from './SharePopoverAuthor'

interface SharePopoverProps {
  timeline: Timeline
  /** 是否已发布到云端 */
  isPublished: boolean
  viewMode: 'timeline' | 'table'
  /** 发布成功(参数为服务端最终 id) */
  onPublished: (newId: string) => void
  /** 在本地创建副本 */
  onCreateCopy: () => void
  /** 角色信息(来自 EditorPage 的 GET /:id;本地未发布时为占位值) */
  role: 'editor' | 'viewer'
  isAuthor: boolean
  allowEditRequests: boolean
  hasPendingRequest: boolean
}

const SHARE_BASE_URL = window.location.origin

/** popover 按钮栏:置底右对齐 */
function ShareButtonBar({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-2 pt-1">{children}</div>
}

export default function SharePopover({
  timeline,
  isPublished,
  viewMode,
  onPublished,
  onCreateCopy,
  role,
  isAuthor,
  allowEditRequests,
  hasPendingRequest,
}: SharePopoverProps) {
  const { isLoggedIn, login } = useAuth()
  const accessToken = useAuthStore(s => s.accessToken)
  const isRevoked = useTimelineStore(s => s.connectionStatus === 'revoked')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [requested, setRequested] = useState(false)

  const view = deriveShareView({
    isPublished,
    isLoggedIn,
    role,
    isAuthor,
    allowEditRequests,
    hasPendingRequest,
    isRevoked,
  })
  const trigger = deriveShareTrigger({
    isPublished,
    isLoggedIn,
    role,
    isAuthor,
    allowEditRequests,
    hasPendingRequest,
    isRevoked,
  })

  const shareUrl =
    isPublished && !isRevoked
      ? `${SHARE_BASE_URL}/timeline/${timeline.id}${viewMode === 'table' ? '?view=table' : ''}`
      : ''
  const pendingRequest = hasPendingRequest || requested

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('复制失败,请手动复制链接')
    }
  }

  const handlePublish = async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const engine = useTimelineStore.getState().engine
      if (!engine) throw new Error('引擎未就绪')
      await engine.flush()
      const { id: newId } = await publishTimeline(timeline.id, timeline.name)
      const store = new IndexedDBDocStore()
      await store.open()
      if (newId !== timeline.id) {
        await store.rekey(timeline.id, newId)
      }
      const meta = await store.getMeta(newId)
      if (meta) await store.putMeta({ ...meta, published: true })
      await useTimelineStore.getState().applyPublishResult(newId)
      track('timeline-publish', { encounterId: timeline.encounter?.id })
      onPublished(newId)
      toast.success('发布成功')
    } catch (err) {
      toast.error(`发布失败:${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setLoading(false)
    }
  }

  const handleRequest = async () => {
    setRequesting(true)
    try {
      await requestEditPermission(timeline.id)
      setRequested(true)
      toast.success('已提交申请,等待作者通过')
    } catch (err) {
      toast.error(`申请失败:${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setRequesting(false)
    }
  }

  const triggerIcon =
    trigger === 'publish' ? (
      <CloudUpload className="w-4 h-4" />
    ) : trigger === 'author' ? (
      <Globe className="w-4 h-4" />
    ) : trigger === 'editor' ? (
      <Pencil className="w-4 h-4" />
    ) : (
      <Lock className="w-4 h-4" />
    )
  const triggerLabel = trigger === 'editor' ? '可编辑' : trigger === 'viewer' ? '只能查看' : '共享'

  const copyButton = (
    <Button variant="outline" size="sm" onClick={handleCopy}>
      {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
      复制分享链接
    </Button>
  )
  const createCopyButton = (
    <Button variant="outline" size="sm" onClick={onCreateCopy}>
      创建副本
    </Button>
  )

  return (
    <>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认发布时间轴</AlertDialogTitle>
            <AlertDialogDescription>
              发布后,互联网上获得链接的人都能够访问该时间轴。被加入编辑者名单的人可以协同编辑。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handlePublish}>确认发布</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1 font-normal whitespace-nowrap"
          >
            {triggerIcon}
            <span className="hidden lg:inline">{triggerLabel}</span>
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-80" align="end">
          <div className="space-y-3">
            <h4 className="font-medium text-sm">共享时间轴</h4>

            {view.kind === 'publish' && (
              <div className="space-y-3">
                {isLoggedIn ? (
                  <Button
                    variant="default"
                    className="w-full"
                    onClick={() => setConfirmOpen(true)}
                    disabled={loading}
                  >
                    {loading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4" />
                    )}
                    发布
                  </Button>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">登录后可发布并共享时间轴。</p>
                    <Button className="w-full" onClick={login}>
                      登录 FFLogs
                    </Button>
                  </>
                )}
              </div>
            )}

            {view.kind === 'viewer-anon' && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  你只能查看此时间轴,若要编辑时间轴,请生成副本进行编辑。
                </p>
                <p className="text-xs text-muted-foreground">
                  已是该时间轴的编辑者?登录后即可编辑。
                </p>
                <ShareButtonBar>
                  <Button variant="outline" size="sm" onClick={login}>
                    登录 FFLogs
                  </Button>
                  {createCopyButton}
                </ShareButtonBar>
              </div>
            )}

            {view.kind === 'viewer-no-request' && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  你只能查看此时间轴,若要编辑时间轴,请生成副本进行编辑。
                </p>
                <ShareButtonBar>{createCopyButton}</ShareButtonBar>
              </div>
            )}

            {(view.kind === 'viewer-can-request' || view.kind === 'viewer-requested') && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  你只能查看此时间轴,若要编辑时间轴,请向时间轴作者申请编辑权限或生成副本进行编辑。
                </p>
                <ShareButtonBar>
                  {createCopyButton}
                  <Button
                    variant="default"
                    size="sm"
                    disabled={pendingRequest || requesting}
                    onClick={handleRequest}
                  >
                    {requesting && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                    {pendingRequest ? '已申请' : '申请编辑权限'}
                  </Button>
                </ShareButtonBar>
              </div>
            )}

            {view.kind === 'editor' && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">你有权限编辑该文档。</p>
                <ShareButtonBar>
                  {createCopyButton}
                  {copyButton}
                </ShareButtonBar>
              </div>
            )}

            {view.kind === 'author' && (
              <SharePopoverAuthor timelineId={timeline.id} shareUrl={shareUrl} />
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}
```

- [ ] **Step 2: 改 `EditorToolbar.tsx`**

在 `src/components/EditorToolbar.tsx`,把 `EditorToolbarProps` 接口改为:

```ts
interface ShareRole {
  role: 'editor' | 'viewer'
  isAuthor: boolean
  allowEditRequests: boolean
  hasPendingRequest: boolean
}

interface EditorToolbarProps {
  onCreateCopy: () => void
  onPublished?: (newId: string) => void
  forceReadOnly?: boolean
  viewMode: 'timeline' | 'table'
  onViewModeChange: (mode: 'timeline' | 'table') => void
  shareRole: ShareRole
}
```

把函数签名的解构改为:

```ts
export default function EditorToolbar({
  onCreateCopy,
  onPublished,
  forceReadOnly,
  viewMode,
  onViewModeChange,
  shareRole,
}: EditorToolbarProps) {
```

把「共享按钮 或 在本地创建副本」整块(原 `{timeline && ( <> ... </> )}`,约 353–375 行)替换为:

```tsx
{
  /* 共享 */
}
{
  timeline && (
    <>
      <div className="w-px h-6 bg-border mx-1" />
      <SharePopover
        timeline={timeline}
        isPublished={isPublished}
        viewMode={viewMode}
        onPublished={newId => onPublished?.(newId)}
        onCreateCopy={onCreateCopy}
        role={shareRole.role}
        isAuthor={shareRole.isAuthor}
        allowEditRequests={shareRole.allowEditRequests}
        hasPendingRequest={shareRole.hasPendingRequest}
      />
    </>
  )
}
```

`Copy` 图标在 `EditorToolbar` 中仅用于已删除的独立创建副本按钮,现已无引用——从 `EditorToolbar.tsx` 顶部 `lucide-react` import 列表中删除 `Copy`。

- [ ] **Step 3: 改 `EditorPage.tsx`**

在 `src/pages/EditorPage.tsx`:

(a) `import { toast } from 'sonner'` 已存在;新增对 share role 的状态。在 `const [authorName, setAuthorName] = useState<string>('')` 之后加:

```ts
const [shareRole, setShareRole] = useState<{
  role: 'editor' | 'viewer'
  isAuthor: boolean
  allowEditRequests: boolean
  hasPendingRequest: boolean
}>({ role: 'viewer', isAuthor: false, allowEditRequests: false, hasPendingRequest: false })
const connectionStatus = useTimelineStore(s => s.connectionStatus)
```

(b) 在模式推导 effect 内,本地已发布分支(`if (meta.published) { ... }`)改为:

```ts
if (meta.published) {
  await openTimeline(id, { published: true })
  if (!ignore) setMode('editor')
  // 取角色信息(用于共享 popover);失败默认作者
  fetchSharedTimeline(id)
    .then(res => {
      if (ignore) return
      setShareRole({
        role: res.role,
        isAuthor: res.isAuthor,
        allowEditRequests: res.allowEditRequests,
        hasPendingRequest: res.hasPendingRequest,
      })
    })
    .catch(() => {
      if (!ignore)
        setShareRole({
          role: 'editor',
          isAuthor: true,
          allowEditRequests: false,
          hasPendingRequest: false,
        })
    })
  return
}
```

(c) 在无本地 meta 的 `fetchSharedTimeline` 分支,`setAuthorName(res.authorName)` 之后加:

```ts
setShareRole({
  role: res.role,
  isAuthor: res.isAuthor,
  allowEditRequests: res.allowEditRequests,
  hasPendingRequest: res.hasPendingRequest,
})
```

(d) 在「卸载 / 切 id 时重置 store」effect 之后,新增一个 effect 响应撤销:

```ts
// 编辑权限被作者撤销:服务端断开 WS,RemoteConnection 报告 'revoked'
useEffect(() => {
  if (connectionStatus === 'revoked') {
    useUIStore.setState({ isReadOnly: true })
    toast.error('你的编辑权限已被移除')
  }
}, [connectionStatus])
```

(e) `handleCreateCopy` 现为所有模式共用(editor 也可创建副本),无需改动其实现。

(f) `<EditorToolbar>` 的渲染改为:

```tsx
<EditorToolbar
  onCreateCopy={handleCreateCopy}
  onPublished={handlePublished}
  forceReadOnly={isViewMode || connectionStatus === 'revoked'}
  viewMode={viewMode}
  onViewModeChange={handleViewModeChange}
  shareRole={shareRole}
/>
```

- [ ] **Step 4: 校验**

Run: `pnpm tsc -b --noEmit` → 0 error
Run: `pnpm lint` → 0 error / 0 warning
Run: `pnpm test:run` → 全量 PASS(无回归)
Run: `pnpm build` → 成功

- [ ] **Step 5: 提交**

```bash
git add src/components/SharePopover.tsx src/components/EditorToolbar.tsx src/pages/EditorPage.tsx
git commit -m "feat(share): role-based share popover with permission management"
```

---

## 收尾验证

全部任务完成后,跑完整门禁:

- [ ] `pnpm tsc -b --noEmit` —— 0 error
- [ ] `pnpm lint` —— 0 error / 0 warning
- [ ] `pnpm test:run` —— 全量 PASS
- [ ] `pnpm test:workers` —— 全量 PASS
- [ ] `pnpm build` —— 成功

## Self-Review 记录

- **Spec 覆盖**:数据模型→Task 1;`GET /:id` 字段→Task 2;`GET/PATCH /share`→Task 3;申请发起/通过/拒绝→Task 4;`kickUser`→Task 5;移除编辑者→Task 6;`RemoteConnection` 4001/`revoked`→Task 7;API 客户端→Task 8;`deriveShareView`→Task 9;作者面板→Task 10;触发按钮 + 6 态 popover + 工具栏/编辑页接线→Task 11。spec 七态全部覆盖(态1 publish、2a viewer-anon、2b viewer-no-request、3 viewer-can-request、4 viewer-requested、5 editor、6 author)。
- **类型一致**:`ShareState` / `ShareViewInput` / `ShareRole` 字段名(`allowEditRequests`、`hasPendingRequest`、`isAuthor`、`role`)跨 Task 2/8/9/10/11 一致;close code `4001` 跨 Task 5/7 一致;`ConnectionStatus` 的 `'revoked'` 跨 Task 7/11 一致。
- **占位符**:无 TBD / TODO;每个改代码的步骤均给出完整代码。
