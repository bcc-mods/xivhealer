# 共享时间轴体验修复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复其他用户访问被共享时间轴时的三个体验问题，并重构混乱的只读判定体系。

**Architecture:** 引入四值 `sessionRole`（local/author/editor/viewer）作为权限模型核心；只读判定改为「能力集」模型（能力 × 原因矩阵集中声明，单一派生 hook）；`LocalDocMeta` 用 `kind` 三值表达归属；HomePage 合并为按最近查看排序的统一列表。设计详见 `design/superpowers/specs/2026-05-19-shared-timeline-experience-design.md`。

**Tech Stack:** React 19 + TypeScript、Zustand 5、TanStack Query、Yjs、Vitest 4。**包管理器必须用 pnpm。**

**说明：** 本重构涉及的 `timelineStore` / `RemoteConnection` / `EditorPage` 互相耦合，部分任务跨多个文件，但每个任务结束时 `pnpm exec tsc --noEmit` 与 `pnpm lint` 均应通过。任务按依赖顺序排列。

---

### Task 1: 只读能力集纯逻辑 `editLock`

只读判定的纯函数核心，不依赖任何 store，可完全单元测试。

**Files:**

- Create: `src/hooks/editLock.ts`
- Test: `src/hooks/editLock.test.ts`

- [ ] **Step 1: 写失败测试**

`src/hooks/editLock.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { computeEditLock, type EditLockInput } from './editLock'

const base: EditLockInput = {
  sessionRole: 'local',
  connectionStatus: 'connected',
  isReplayMode: false,
  manualLock: false,
}

describe('computeEditLock', () => {
  it('local 角色、无任何原因：全部可编辑', () => {
    const lock = computeEditLock(base)
    expect(lock.can('content')).toBe(true)
    expect(lock.can('metadata')).toBe(true)
    expect(lock.can('exitReplay')).toBe(true)
    expect(lock.reasonOf('content')).toBeNull()
  })

  it('viewer：全部锁定，原因 viewer', () => {
    const lock = computeEditLock({ ...base, sessionRole: 'viewer' })
    expect(lock.can('content')).toBe(false)
    expect(lock.can('metadata')).toBe(false)
    expect(lock.can('exitReplay')).toBe(false)
    expect(lock.reasonOf('metadata')).toBe('viewer')
  })

  it('回放模式：仅锁内容，标题与解除回放不锁', () => {
    const lock = computeEditLock({ ...base, isReplayMode: true })
    expect(lock.can('content')).toBe(false)
    expect(lock.can('metadata')).toBe(true)
    expect(lock.can('exitReplay')).toBe(true)
    expect(lock.reasonOf('content')).toBe('replay')
  })

  it('editor 未连线：全部锁定，原因 offline', () => {
    const lock = computeEditLock({
      ...base,
      sessionRole: 'editor',
      connectionStatus: 'connecting',
    })
    expect(lock.can('content')).toBe(false)
    expect(lock.reasonOf('content')).toBe('offline')
  })

  it('author 未连线：不锁（作者可离线编辑）', () => {
    const lock = computeEditLock({
      ...base,
      sessionRole: 'author',
      connectionStatus: 'disconnected',
    })
    expect(lock.can('content')).toBe(true)
    expect(lock.can('metadata')).toBe(true)
  })

  it('手动锁定：全部锁定，原因 manual', () => {
    const lock = computeEditLock({ ...base, manualLock: true })
    expect(lock.can('content')).toBe(false)
    expect(lock.can('metadata')).toBe(false)
    expect(lock.reasonOf('content')).toBe('manual')
  })

  it('原因叠加：viewer 优先级高于 replay', () => {
    const lock = computeEditLock({
      ...base,
      sessionRole: 'viewer',
      isReplayMode: true,
    })
    expect(lock.reasonOf('content')).toBe('viewer')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test:run src/hooks/editLock.test.ts`
Expected: FAIL —— `editLock.ts` 不存在 / `computeEditLock` 未定义。

- [ ] **Step 3: 实现 `editLock.ts`**

`src/hooks/editLock.ts`：

```ts
/**
 * 只读能力集模型（设计文档 §4）。
 *
 * 把「能编辑什么」拆成能力（capability），「为什么不能编辑」拆成原因（cause）。
 * 每个原因声明它撤销哪些能力；生效锁 = 所有激活原因撤销能力的并集。
 * 本文件是纯逻辑，不依赖任何 store，便于单测；hook 封装见 useEditLock.ts。
 */

/** 全部可编辑操作；新增可编辑面在此追加一项 */
export type EditCapability = 'content' | 'metadata' | 'exitReplay'

export type EditLockCauseId = 'viewer' | 'offline' | 'replay' | 'manual'

interface CauseSpec {
  id: EditLockCauseId
  /** 文案展示时谁是主因，数字大者优先 */
  priority: number
  /** 'all' = 冻结全部能力；或显式列出冻结的能力 */
  revokes: 'all' | EditCapability[]
}

const CAUSES: CauseSpec[] = [
  { id: 'viewer', priority: 4, revokes: 'all' },
  { id: 'offline', priority: 3, revokes: 'all' },
  { id: 'replay', priority: 2, revokes: ['content'] },
  { id: 'manual', priority: 1, revokes: 'all' },
]

export interface EditLockInput {
  sessionRole: 'local' | 'author' | 'editor' | 'viewer'
  connectionStatus: 'disconnected' | 'connecting' | 'connected'
  isReplayMode: boolean
  manualLock: boolean
}

export interface EditLock {
  /** 该能力当前是否可用 */
  can: (cap: EditCapability) => boolean
  /** 该能力被锁的主因（按 priority）；可用时为 null */
  reasonOf: (cap: EditCapability) => EditLockCauseId | null
}

function isCauseActive(id: EditLockCauseId, input: EditLockInput): boolean {
  switch (id) {
    case 'viewer':
      return input.sessionRole === 'viewer'
    case 'offline':
      return input.sessionRole === 'editor' && input.connectionStatus !== 'connected'
    case 'replay':
      return input.isReplayMode
    case 'manual':
      return input.manualLock
  }
}

export function computeEditLock(input: EditLockInput): EditLock {
  const active = CAUSES.filter(c => isCauseActive(c.id, input))
  const revokers = (cap: EditCapability) =>
    active.filter(c => c.revokes === 'all' || c.revokes.includes(cap))
  return {
    can: cap => revokers(cap).length === 0,
    reasonOf: cap => {
      const rs = revokers(cap)
      if (rs.length === 0) return null
      return rs.reduce((a, b) => (b.priority > a.priority ? b : a)).id
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test:run src/hooks/editLock.test.ts`
Expected: PASS（7 个用例全通过）。

- [ ] **Step 5: 提交**

```bash
git add src/hooks/editLock.ts src/hooks/editLock.test.ts
git commit -m "feat(editor): add capability-set edit-lock pure logic"
```

---

### Task 2: `uiStore` 的 `isReadOnly` 改名为 `manualLock`

消除「手动锁定 / viewer / revoked」共用一个布尔的语义复用。纯机械改名，语义暂不变。

**Files:**

- Modify: `src/store/uiStore.ts`
- Modify: `src/hooks/useEditorReadOnly.ts`
- Modify: `src/components/EditorToolbar.tsx`
- Modify: `src/pages/EditorPage.tsx`
- Modify: `src/components/CreateTimelineDialog.tsx`

- [ ] **Step 1: 改 `uiStore.ts`**

把 `isReadOnly` 字段改名为 `manualLock`、`toggleReadOnly` 改名为 `toggleManualLock`，并从 `persist` 的 `partialize` 中移除（会话级状态，持久化无意义）。

接口内：`isReadOnly: boolean` → `manualLock: boolean`（注释改为 `/** 用户手动锁定编辑 */`）；`toggleReadOnly: () => void` → `toggleManualLock: () => void`（注释 `/** 切换手动锁定 */`）。

初值：`isReadOnly: false` → `manualLock: false`。

action 实现：

```ts
      toggleManualLock: () =>
        set(state => ({
          manualLock: !state.manualLock,
        })),
```

`partialize` 改为同时排除 `theme`、`draggingId`、`manualLock`：

```ts
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      partialize: ({ theme, draggingId, manualLock, ...rest }) => rest,
```

- [ ] **Step 2: 改 `useEditorReadOnly.ts`**

```ts
import { useTimelineStore } from '@/store/timelineStore'
import { useUIStore } from '@/store/uiStore'

export function useEditorReadOnly(): boolean {
  const timeline = useTimelineStore(state => state.timeline)
  const manualLock = useUIStore(state => state.manualLock)
  const isReplayMode = timeline?.isReplayMode || false
  return isReplayMode || manualLock
}
```

- [ ] **Step 3: 改 `EditorToolbar.tsx`**

第 95-103 行 `useUIStore()` 解构里 `toggleReadOnly` → `toggleManualLock`；第 263 行 `onClick={toggleReadOnly}` → `onClick={toggleManualLock}`。

- [ ] **Step 4: 改 `EditorPage.tsx`**

把全部 4 处 `useUIStore.setState({ isReadOnly: ... })` 中的 `isReadOnly` 改为 `manualLock`（第 91、172、190、198 行）。

- [ ] **Step 5: 改 `CreateTimelineDialog.tsx`**

第 88 行 `useUIStore.setState({ isReadOnly: false })` → `useUIStore.setState({ manualLock: false })`。

- [ ] **Step 6: 验证**

Run: `pnpm exec tsc --noEmit`
Expected: 无报错（确认没有遗漏的 `isReadOnly` / `toggleReadOnly` 引用）。

- [ ] **Step 7: 提交**

```bash
git add src/store/uiStore.ts src/hooks/useEditorReadOnly.ts src/components/EditorToolbar.tsx src/pages/EditorPage.tsx src/components/CreateTimelineDialog.tsx
git commit -m "refactor(editor): rename uiStore.isReadOnly to manualLock"
```

---

### Task 3: `RemoteConnection` 撤权改为事件回调，移除 `revoked` 连接态

`revoked` 不再是 `ConnectionStatus` 的值；`4001` 触发一次性回调。

**Files:**

- Modify: `src/collab/RemoteConnection.ts`
- Modify: `src/collab/SyncEngine.ts`
- Modify: `src/pages/EditorPage.tsx`

- [ ] **Step 1: 改 `RemoteConnection.ts`**

类型收窄（第 12 行）：

```ts
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'
```

构造函数新增一个可选回调 `onRevoked`。在字段区（第 28 行附近）加：

```ts
  /** 编辑权限被撤销（WS 4001）时触发一次 */
  private readonly onRevoked: (() => void) | undefined
```

构造函数签名追加参数并赋值：

```ts
  constructor(
    url: string,
    doc: Y.Doc,
    awareness: Awareness,
    getAuthToken: () => Promise<string | null>,
    onStatus: (status: ConnectionStatus) => void,
    onEditRequest?: (count: number) => void,
    onRevoked?: () => void
  ) {
    this.url = url
    this.doc = doc
    this.awareness = awareness
    this.getAuthToken = getAuthToken
    this.onStatus = onStatus
    this.onEditRequest = onEditRequest
    this.onRevoked = onRevoked
  }
```

`setStatus`（第 83-89 行）移除 `revoked` 终态特判，恢复为普通实现：

```ts
  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return
    this.status = next
    this.onStatus(next)
  }
```

`onClose`（第 181-185 行）的 `4001` 分支：不再 `setStatus('revoked')`，改为触发回调 + 普通终态：

```ts
// 服务端以 4001 撤销编辑权限：终态、不重连，触发 onRevoked 让上层降级
if (code === 4001) {
  this.closed = true
  this.setStatus('disconnected')
  this.onRevoked?.()
  return
}
```

- [ ] **Step 2: 改 `SyncEngine.ts`**

`connectRemote`（第 67-82 行）追加 `onRevoked` 参数并透传：

```ts
  connectRemote(
    getAuthToken: () => Promise<string | null>,
    onStatus: (status: ConnectionStatus) => void,
    onEditRequest?: (count: number) => void,
    onRevoked?: () => void
  ): void {
    if (this.remote) return
    this.remote = new RemoteConnection(
      buildWsUrl(this.docId),
      this.doc,
      this.awareness,
      getAuthToken,
      onStatus,
      onEditRequest,
      onRevoked
    )
    this.remote.connect()
  }
```

- [ ] **Step 3: 改 `EditorPage.tsx` —— 移除 `revoked` 引用**

删除第 196-201 行整段「编辑权限被作者撤销」的 `useEffect`（撤权处理改由 store 在 Task 4 接管）。
把第 426 行 `forceReadOnly={isViewMode || connectionStatus === 'revoked'}` 改为 `forceReadOnly={isViewMode}`。
若 `connectionStatus` 变量在文件中已无其它引用，删除第 76 行的 `const connectionStatus = useTimelineStore(s => s.connectionStatus)`（用 `pnpm exec tsc --noEmit` 的未使用变量报错确认）。

- [ ] **Step 4: 验证**

Run: `pnpm exec tsc --noEmit`
Expected: 无报错（确认全代码库再无 `'revoked'` 比较）。

- [ ] **Step 5: 提交**

```bash
git add src/collab/RemoteConnection.ts src/collab/SyncEngine.ts src/pages/EditorPage.tsx
git commit -m "refactor(collab): replace revoked connection state with onRevoked event"
```

---

### Task 4: `timelineStore` 引入 `sessionRole`，`openTimeline` 改 `role` 参数

**Files:**

- Modify: `src/store/timelineStore.ts`
- Modify: `src/pages/EditorPage.tsx`

- [ ] **Step 1: `timelineStore.ts` —— 类型与初值**

`TimelineState` 接口内，在 `isPublished` 字段后新增：

```ts
/** 当前会话角色（设计文档 §3.2） */
sessionRole: 'local' | 'author' | 'editor' | 'viewer'
```

`openTimeline` 签名改为：

```ts
openTimeline: (
  docId: string,
  opts: { role: 'local' | 'author' | 'editor'; seedContent?: TimelineContent }
) => Promise<void>
```

`initialUiState` 内新增 `sessionRole: 'local' as const`（放在 `isPublished: false` 后）。

- [ ] **Step 2: `timelineStore.ts` —— `openTimeline` 实现**

把 `openTimeline` 内对 `opts?.published` / `opts?.seedContent` 的读取改为 `opts.role` / `opts.seedContent`。
切换时间轴的 `set({ ... })` 块里：`isPublished: !!opts?.published` 改为

```ts
        isPublished: opts.role !== 'local',
        sessionRole: opts.role,
```

末尾「editor 模式挂 remote」判断 `if (opts?.published)` 改为 `if (opts.role !== 'local')`。
打开时重置手动锁：在该 `set({ ... })` 块执行后加一行 `useUIStore.getState().manualLock` 复位 —— 即在 `openTimeline` 开头 import 后加 `useUIStore.setState({ manualLock: false })`（紧跟在切换时间轴的 `set` 之后）。文件顶部补 `import { useUIStore } from '@/store/uiStore'`。

- [ ] **Step 3: `timelineStore.ts` —— `wireRemote` 接入 `onRevoked`**

`wireRemote` 内 `engine.connectRemote(...)` 调用追加第 4 个参数：

```ts
engine.connectRemote(
  () => useAuthStore.getState().getValidToken(),
  status => set({ connectionStatus: status }),
  count => set({ pendingRequestCount: count }),
  () => {
    // 编辑权限被撤销：降级为 viewer，由 viewer cause 接管只读
    set({ sessionRole: 'viewer' })
    toast.error('你的编辑权限已被移除')
  }
)
```

文件顶部补 `import { toast } from 'sonner'`。

- [ ] **Step 4: `timelineStore.ts` —— `setViewerSnapshot` / `attachRemote` / `reset`**

`setViewerSnapshot` 的 `set({ ... })` 块加 `sessionRole: 'viewer'`，并加一行 `useUIStore.setState({ manualLock: false })`。
`attachRemote` 内 `set({ isPublished: true })` 改为 `set({ isPublished: true, sessionRole: 'author' })`（原地发布者即作者）。
`reset` 通过 `...initialUiState` 已自动复位 `sessionRole`，无需额外改动。

- [ ] **Step 5: `EditorPage.tsx` —— 更新 `openTimeline` 调用点（最小改动）**

- 第 148 行 `await openTimeline(id)` → `await openTimeline(id, { role: 'local' })`
- 第 125 行 `await openTimeline(id, { published: true })` → `await openTimeline(id, { role: 'editor' })`
- 第 164 行 `await openTimeline(id, { published: true })` → `await openTimeline(id, { role: 'editor' })`

（author/editor 的精确区分在 Task 7 对账重写时处理；此处先统一 `editor` 保证编译通过。）

- [ ] **Step 6: 验证**

Run: `pnpm exec tsc --noEmit`
Expected: 无报错。

- [ ] **Step 7: 提交**

```bash
git add src/store/timelineStore.ts src/pages/EditorPage.tsx
git commit -m "feat(collab): add sessionRole and role-based openTimeline"
```

---

### Task 5: `useEditLock` hook + 重写 `useEditorReadOnly`

把 Task 1 的纯逻辑接到 store 上。

**Files:**

- Create: `src/hooks/useEditLock.ts`
- Modify: `src/hooks/useEditorReadOnly.ts`

- [ ] **Step 1: 创建 `useEditLock.ts`**

```ts
/** 只读能力集 hook —— 把 store 状态喂给 editLock 纯逻辑 */
import { useTimelineStore } from '@/store/timelineStore'
import { useUIStore } from '@/store/uiStore'
import { computeEditLock, type EditLock } from './editLock'

export function useEditLock(): EditLock {
  const sessionRole = useTimelineStore(s => s.sessionRole)
  const connectionStatus = useTimelineStore(s => s.connectionStatus)
  const isReplayMode = useTimelineStore(s => s.timeline?.isReplayMode ?? false)
  const manualLock = useUIStore(s => s.manualLock)
  return computeEditLock({ sessionRole, connectionStatus, isReplayMode, manualLock })
}

export type { EditCapability, EditLockCauseId } from './editLock'
```

- [ ] **Step 2: 重写 `useEditorReadOnly.ts`**

```ts
/** 内容编辑是否只读 —— useEditLock 的便捷别名，内容类组件沿用 */
import { useEditLock } from './useEditLock'

export function useEditorReadOnly(): boolean {
  return !useEditLock().can('content')
}
```

- [ ] **Step 3: 验证**

Run: `pnpm exec tsc --noEmit && pnpm test:run src/hooks/editLock.test.ts`
Expected: 无类型报错；editLock 测试仍 PASS。

- [ ] **Step 4: 提交**

```bash
git add src/hooks/useEditLock.ts src/hooks/useEditorReadOnly.ts
git commit -m "feat(editor): wire useEditLock hook to stores"
```

---

### Task 6: `LocalDocMeta` 改用 `kind` + `lastViewedAt`

**Files:**

- Modify: `src/collab/types.ts`
- Modify: `src/collab/createLocalTimeline.ts`
- Modify: `src/store/timelineStore.ts`
- Modify: `src/pages/EditorPage.tsx`

- [ ] **Step 1: 改 `types.ts` 的 `LocalDocMeta`**

把 `published: boolean` 字段替换为：

```ts
/** 时间轴归属状态：local=本地未发布 / published=我发布的 / visited=我访问过的他人时间轴 */
kind: 'local' | 'published' | 'visited'
/** 最近一次打开时间（Unix 秒）—— HomePage 列表排序键 */
lastViewedAt: number
```

- [ ] **Step 2: 改 `createLocalTimeline.ts`**

构造 `meta` 处：`published: false` 改为 `kind: 'local'`，并新增 `lastViewedAt: now`：

```ts
const meta: LocalDocMeta = {
  docId,
  name: content.name,
  encounterId: content.encounter?.id ?? 0,
  createdAt: content.createdAt ?? now,
  updatedAt: now,
  composition: content.composition ?? null,
  kind: 'local',
  lastViewedAt: now,
}
```

- [ ] **Step 3: 改 `timelineStore.ts` 的 `scheduleMetaWrite`**

把 `scheduleMetaWrite` 闭包（第 196-215 行）整体替换为下面的实现 —— 由 `sessionRole` 推导 `kind`、写入 `lastViewedAt`：

```ts
const scheduleMetaWrite = () => {
  if (metaTimer) clearTimeout(metaTimer)
  metaTimer = setTimeout(() => {
    metaTimer = null
    const { engine, timeline, sessionRole } = get()
    if (!engine || !timeline) return
    const kind: LocalDocMeta['kind'] =
      sessionRole === 'local' ? 'local' : sessionRole === 'author' ? 'published' : 'visited'
    const meta: LocalDocMeta = {
      docId: engine.docId,
      name: timeline.name,
      encounterId: timeline.encounter?.id ?? 0,
      createdAt: timeline.createdAt,
      updatedAt: timeline.updatedAt,
      composition: timeline.composition ?? null,
      kind,
      lastViewedAt: Math.floor(Date.now() / 1000),
    }
    if (timeline.fflogsSource) meta.fflogsSource = timeline.fflogsSource
    void engine.saveMeta(meta)
  }, 1000)
}
```

> 注：`isPublished` store 字段保留不动（`SharePopover` 仍用）。

- [ ] **Step 4: 改 `EditorPage.tsx` 的 `meta.published` 引用**

第 100 行 `if (meta.published)` → `if (meta.kind !== 'local')`。
第 119 行 `store.putMeta({ ...movedMeta, published: false })` → `store.putMeta({ ...movedMeta, kind: 'local' })`。
第 147 行 `} else {`（对应 `meta.published` 为 false 分支）逻辑不变 —— 即 `meta.kind === 'local'` 时 `openTimeline(id, { role: 'local' })`。
（完整对账逻辑在 Task 7 重写，此处仅保证编译通过。）

- [ ] **Step 5: 验证**

Run: `pnpm exec tsc --noEmit`
Expected: 无报错。

- [ ] **Step 6: 提交**

```bash
git add src/collab/types.ts src/collab/createLocalTimeline.ts src/store/timelineStore.ts src/pages/EditorPage.tsx
git commit -m "feat(collab): replace LocalDocMeta.published with kind and lastViewedAt"
```

---

### Task 7: EditorPage 对账逻辑重写

**Files:**

- Create: `src/pages/editorOpenDecision.ts`
- Test: `src/pages/editorOpenDecision.test.ts`
- Modify: `src/pages/EditorPage.tsx`
- Modify: `src/components/EditableTitle.tsx`

- [ ] **Step 1: 写对账决策纯函数的失败测试**

`src/pages/editorOpenDecision.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { decideOpen } from './editorOpenDecision'

describe('decideOpen', () => {
  it('本地时间轴：直接本地打开，不查服务端', () => {
    expect(decideOpen('local', null)).toEqual({ kind: 'local' })
  })

  it('服务端确认是作者：author', () => {
    expect(decideOpen('published', { type: 'ok', isAuthor: true, role: 'editor' })).toEqual({
      kind: 'author',
    })
  })

  it('服务端确认是协作编辑者：editor', () => {
    expect(decideOpen('visited', { type: 'ok', isAuthor: false, role: 'editor' })).toEqual({
      kind: 'editor',
    })
  })

  it('服务端返回 viewer 角色：viewer', () => {
    expect(decideOpen('visited', { type: 'ok', isAuthor: false, role: 'viewer' })).toEqual({
      kind: 'viewer',
    })
  })

  it('我发布的时间轴被取消发布（404）：回退本地', () => {
    expect(decideOpen('published', { type: 'notfound' })).toEqual({ kind: 'rekey-local' })
  })

  it('访问过的时间轴被作者删除（404）：not-found', () => {
    expect(decideOpen('visited', { type: 'notfound' })).toEqual({ kind: 'not-found' })
  })

  it('首次链接进入、404：not-found', () => {
    expect(decideOpen(null, { type: 'notfound' })).toEqual({ kind: 'not-found' })
  })

  it('我发布的、网络错误：作者可离线编辑', () => {
    expect(decideOpen('published', { type: 'neterror', hasLocalDoc: true })).toEqual({
      kind: 'author',
    })
  })

  it('访问过的、网络错误、有本地缓存：以 editor 离线打开（offline cause 兜底只读）', () => {
    expect(decideOpen('visited', { type: 'neterror', hasLocalDoc: true })).toEqual({
      kind: 'editor',
    })
  })

  it('访问过的、网络错误、无本地缓存：network-error', () => {
    expect(decideOpen('visited', { type: 'neterror', hasLocalDoc: false })).toEqual({
      kind: 'network-error',
    })
  })

  it('首次链接进入、网络错误：network-error', () => {
    expect(decideOpen(null, { type: 'neterror', hasLocalDoc: false })).toEqual({
      kind: 'network-error',
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test:run src/pages/editorOpenDecision.test.ts`
Expected: FAIL —— `editorOpenDecision.ts` 不存在。

- [ ] **Step 3: 实现 `editorOpenDecision.ts`**

```ts
/**
 * EditorPage 打开时间轴的对账决策纯函数（设计文档 §5）。
 * 输入：本地 meta 的 kind（null = 无 meta）、服务端结果；输出：打开动作。
 */

export type MetaKind = 'local' | 'published' | 'visited'

export type ServerOutcome =
  | { type: 'ok'; isAuthor: boolean; role: 'editor' | 'viewer' }
  | { type: 'notfound' }
  | { type: 'neterror'; hasLocalDoc: boolean }

export type OpenDecision =
  | { kind: 'local' } // openTimeline role=local
  | { kind: 'author' } // openTimeline role=author
  | { kind: 'editor' } // openTimeline role=editor
  | { kind: 'viewer' } // setViewerSnapshot
  | { kind: 'rekey-local' } // 我发布的被取消发布 → 换 id 转本地
  | { kind: 'not-found' }
  | { kind: 'network-error' }

/**
 * @param metaKind 本地 meta 的 kind；null 表示本地无 meta（首次经链接进入）
 * @param server   服务端结果；metaKind==='local' 时传 null（不查服务端）
 */
export function decideOpen(metaKind: MetaKind | null, server: ServerOutcome | null): OpenDecision {
  if (metaKind === 'local') return { kind: 'local' }
  if (!server) return { kind: 'network-error' }

  if (server.type === 'ok') {
    if (server.isAuthor) return { kind: 'author' }
    return server.role === 'editor' ? { kind: 'editor' } : { kind: 'viewer' }
  }

  if (server.type === 'notfound') {
    return metaKind === 'published' ? { kind: 'rekey-local' } : { kind: 'not-found' }
  }

  // neterror
  if (metaKind === 'published') return { kind: 'author' }
  if (metaKind === 'visited') {
    return server.hasLocalDoc ? { kind: 'editor' } : { kind: 'network-error' }
  }
  return { kind: 'network-error' }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test:run src/pages/editorOpenDecision.test.ts`
Expected: PASS（11 个用例全通过）。

- [ ] **Step 5: 重写 `EditorPage.tsx` 的模式推导 effect**

把 `PageMode` 类型（第 44 行）改为：

```ts
type PageMode = 'loading' | 'ready' | 'not_found' | 'network_error'
```

替换第 83-185 行整个「模式推导 + 加载」`useEffect` 为下面的实现（依赖 `decideOpen`、`fetchSharedTimeline`、`IndexedDBDocStore`、`generateId`）：

```ts
useEffect(() => {
  if (!id) {
    setMode('not_found') // eslint-disable-line react-hooks/set-state-in-effect
    return
  }
  let ignore = false
  setMode('loading')
  setAuthorName('')
  ;(async () => {
    try {
      const store = new IndexedDBDocStore()
      await store.open()
      const meta = await store.getMeta(id)
      if (ignore) return

      // 查服务端（本地纯 local 时跳过）
      let server: ServerOutcome | null = null
      let serverRes: Awaited<ReturnType<typeof fetchSharedTimeline>> | null = null
      if (!meta || meta.kind !== 'local') {
        try {
          serverRes = await fetchSharedTimeline(id)
          server = { type: 'ok', isAuthor: serverRes.isAuthor, role: serverRes.role }
        } catch (err) {
          if (err instanceof Error && err.message === 'NOT_FOUND') {
            server = { type: 'notfound' }
          } else {
            const localDoc = await store.loadDoc(id)
            server = { type: 'neterror', hasLocalDoc: localDoc !== null }
          }
        }
        if (ignore) return
      }

      const decision = decideOpen(meta ? meta.kind : null, server)

      if (decision.kind === 'rekey-local') {
        const localId = generateId()
        await store.rekey(id, localId)
        const moved = await store.getMeta(localId)
        if (moved) await store.putMeta({ ...moved, kind: 'local' })
        if (ignore) return
        toast.info('该时间轴已被作者取消发布，已转为本地时间轴')
        navigate(`/timeline/${localId}`, { replace: true })
        return
      }
      if (decision.kind === 'not-found') {
        if (meta) await store.deleteDoc(id)
        if (!ignore) setMode('not_found')
        return
      }
      if (decision.kind === 'network-error') {
        if (!ignore) setMode('network_error')
        return
      }
      if (decision.kind === 'viewer') {
        setViewerSnapshot(serverRes!.snapshot!)
        await store.putMeta(buildVisitedMeta(id, serverRes!.snapshot!))
        if (ignore) return
        setAuthorName(serverRes!.authorName)
        setShareRole({
          role: 'viewer',
          isAuthor: false,
          allowEditRequests: serverRes!.allowEditRequests,
          hasPendingRequest: serverRes!.hasPendingRequest,
        })
        setMode('ready')
        track('timeline-view-shared', { timelineId: id })
        return
      }

      // local / author / editor → openTimeline
      await openTimeline(id, { role: decision.kind })
      if (ignore) return
      if (serverRes) {
        useTimelineStore.setState({ pendingRequestCount: serverRes.pendingRequestCount })
        setAuthorName(serverRes.authorName)
        setShareRole({
          role: serverRes.role,
          isAuthor: serverRes.isAuthor,
          allowEditRequests: serverRes.allowEditRequests,
          hasPendingRequest: serverRes.hasPendingRequest,
        })
      }
      setMode('ready')
    } catch (err) {
      if (ignore) return
      setMode(err instanceof Error && err.message === 'NOT_FOUND' ? 'not_found' : 'network_error')
    }
  })()

  return () => {
    ignore = true
  }
}, [id, openTimeline, setViewerSnapshot, navigate])
```

在 `EditorPage` 函数体外（文件内、组件上方）新增辅助函数，把 viewer snapshot 投影成 stub meta：

```ts
function buildVisitedMeta(id: string, snapshot: Timeline): LocalDocMeta {
  return {
    docId: id,
    name: snapshot.name,
    encounterId: snapshot.encounter?.id ?? 0,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt ?? Math.floor(Date.now() / 1000),
    composition: snapshot.composition ?? null,
    kind: 'visited',
    lastViewedAt: Math.floor(Date.now() / 1000),
  }
}
```

文件顶部补充 import：

```ts
import { decideOpen, type ServerOutcome } from './editorOpenDecision'
import type { LocalDocMeta } from '@/collab/types'
import type { Timeline } from '@/types/timeline'
```

- [ ] **Step 6: `EditableTitle` 加 `readOnly` prop，更新 `EditorPage` 渲染与头部**

先给 `EditableTitle.tsx` 加 `readOnly` prop：props 接口加 `readOnly?: boolean`，签名解构加 `readOnly = false`；非编辑态 return（第 112-127 行）的铅笔按钮包一层 `{!readOnly && ( … )}`：

```tsx
return (
  <div className="flex items-center gap-2 h-7 group">
    <h1 className={className}>{value}</h1>
    {!readOnly && (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setIsEditing(true)}
            className="p-1 opacity-0 group-hover:opacity-100 hover:bg-accent rounded-md transition-all"
          >
            <Pencil className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>编辑标题</TooltipContent>
      </Tooltip>
    )}
  </div>
)
```

再更新 `EditorPage.tsx`：

`mode === 'loading'` → 渲染 `<FullScreenLoader />`（不变）。
`mode === 'not_found'` / `mode === 'network_error'` 分支不变。
删除 `const isViewMode = mode === 'viewer'`，改为基于角色：

```ts
const sessionRole = useTimelineStore(s => s.sessionRole)
const editLock = useEditLock()
const isViewMode = sessionRole === 'viewer'
```

头部第 385-413 行：删除 `isViewMode ? (<h1>…</h1>) : (<EditableTitle…>)` 的分叉，统一渲染：

```tsx
<div>
  <div className="flex items-center gap-2">
    <EditableTitle
      value={timeline?.name || '时间轴编辑器'}
      onChange={updateTimelineName}
      className="text-lg font-bold"
      readOnly={!editLock.can('metadata')}
    />
    {isViewMode && authorName && (
      <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
        By {authorName}
      </span>
    )}
  </div>
  <EditableDescription
    value={timeline?.description || ''}
    onChange={updateTimelineDescription}
    readOnly={!editLock.can('metadata')}
  />
</div>
```

`<EditorToolbar>` 的 `forceReadOnly={isViewMode}` 一行删除（prop 在 Task 8 移除）。

- [ ] **Step 7: 验证**

Run: `pnpm exec tsc --noEmit && pnpm test:run src/pages/editorOpenDecision.test.ts`
Expected: 无类型报错；决策测试 PASS。

- [ ] **Step 8: 提交**

```bash
git add src/pages/editorOpenDecision.ts src/pages/editorOpenDecision.test.ts src/pages/EditorPage.tsx src/components/EditableTitle.tsx
git commit -m "feat(editor): rewrite timeline open reconciliation by role and kind"
```

---

### Task 8: `EditorToolbar` 接入 `useEditLock`

**Files:**

- Modify: `src/components/EditorToolbar.tsx`

- [ ] **Step 1: `EditorToolbar.tsx` 移除 `forceReadOnly`，改用 `useEditLock`**

`EditorToolbarProps` 删除 `forceReadOnly?: boolean`；函数签名解构删除 `forceReadOnly`。
顶部 import 加 `import { useEditLock } from '@/hooks/useEditLock'`。
组件内（第 116 行 `useEditorReadOnly()` 旁）加：

```ts
const editLock = useEditLock()
const contentReason = editLock.reasonOf('content')
/** 系统强制只读（非用户手动锁）时，锁按钮不可由用户切换 */
const lockForced = contentReason !== null && contentReason !== 'manual'
```

第 229 行回放 popover 触发按钮 `disabled={forceReadOnly}` → `disabled={!editLock.can('exitReplay')}`。
第 264 行锁切换按钮 `disabled={forceReadOnly}` → `disabled={lockForced}`。
锁按钮的 tooltip 文案（第 269-271 行 `TooltipContent`）按 `lockForced` 区分：

```tsx
<TooltipContent side="bottom">
  {lockForced
    ? contentReason === 'viewer'
      ? '只读 · 仅查看'
      : contentReason === 'offline'
        ? '只读 · 连接中断'
        : '只读'
    : isReadOnly
      ? '切换为编辑模式'
      : '切换为只读模式'}
</TooltipContent>
```

- [ ] **Step 2: 验证**

Run: `pnpm exec tsc --noEmit && pnpm lint`
Expected: 无报错。

- [ ] **Step 3: 提交**

```bash
git add src/components/EditorToolbar.tsx
git commit -m "feat(editor): drive toolbar read-only from useEditLock"
```

---

### Task 9: `TimelineCard` 显示 `kind` 图标与垃圾桶变体

**Files:**

- Modify: `src/components/TimelineCard.tsx`
- Modify: `src/pages/HomePage.tsx`

- [ ] **Step 1: 改 `TimelineCard.tsx`**

`TimelineCardItem` 接口加 `kind: 'local' | 'published' | 'visited'`。
顶部 import 改为：`import { Trash2, HardDrive, Globe } from 'lucide-react'`。
标题区（第 38-52 行）：在标题左侧按 `kind` 渲染图标，垃圾桶 tooltip 文案随 `kind` 变化。替换为：

```tsx
<div className="flex items-start justify-between mb-2">
  <div className="flex items-center gap-1.5 min-w-0">
    {timeline.kind === 'local' && (
      <HardDrive className="w-4 h-4 shrink-0 text-muted-foreground" aria-label="本地" />
    )}
    {timeline.kind === 'published' && (
      <Globe className="w-4 h-4 shrink-0 text-muted-foreground" aria-label="已发布" />
    )}
    <h3 className="font-medium group-hover:text-primary line-clamp-1" title={timeline.name}>
      {timeline.name}
    </h3>
  </div>
  {onDelete && (
    <button
      onClick={onDelete}
      title={
        timeline.kind === 'local'
          ? '删除'
          : timeline.kind === 'published'
            ? '取消发布并删除'
            : '从列表移除'
      }
      className="p-1 shrink-0 hover:bg-destructive/10 hover:text-destructive rounded transition-colors"
    >
      <Trash2 className="w-4 h-4" />
    </button>
  )}
</div>
```

- [ ] **Step 2: 旧 `HomePage.tsx` 调用点补 `kind`（过渡兼容）**

`HomePage.tsx` 现有两处 `<TimelineCard>`，给其 `timeline={{...}}` 对象补 `kind` 字段（Task 10 会整体重写本文件，此步仅为保持类型通过、避免红 commit）：

- 「本地时间轴」区（约第 175-182 行）：加 `kind: meta.kind,`
- 「已发布」区（约第 208-215 行）：加 `kind: 'published' as const,`

- [ ] **Step 3: 验证**

Run: `pnpm exec tsc --noEmit`
Expected: 无报错。

- [ ] **Step 4: 提交**

```bash
git add src/components/TimelineCard.tsx src/pages/HomePage.tsx
git commit -m "feat(home): show kind icon and delete variant on timeline card"
```

---

### Task 10: HomePage 统一时间轴列表

**Files:**

- Create: `src/pages/homeTimelineList.ts`
- Test: `src/pages/homeTimelineList.test.ts`
- Modify: `src/pages/HomePage.tsx`

- [ ] **Step 1: 写合并纯函数的失败测试**

`src/pages/homeTimelineList.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mergeTimelineList } from './homeTimelineList'
import type { LocalDocMeta } from '@/collab/types'
import type { MyTimelineItem } from '@/api/timelineShareApi'

function meta(
  p: Partial<LocalDocMeta> & Pick<LocalDocMeta, 'docId' | 'kind' | 'lastViewedAt'>
): LocalDocMeta {
  return {
    docId: p.docId,
    name: p.name ?? p.docId,
    encounterId: p.encounterId ?? 0,
    createdAt: p.createdAt ?? 0,
    updatedAt: p.updatedAt ?? 0,
    composition: p.composition ?? null,
    kind: p.kind,
    lastViewedAt: p.lastViewedAt,
  }
}

describe('mergeTimelineList', () => {
  it('按 lastViewedAt 倒序排列本地条目', () => {
    const list = mergeTimelineList(
      [
        meta({ docId: 'a', kind: 'local', lastViewedAt: 100 }),
        meta({ docId: 'b', kind: 'local', lastViewedAt: 300 }),
        meta({ docId: 'c', kind: 'visited', lastViewedAt: 200 }),
      ],
      []
    )
    expect(list.map(x => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('服务端独有条目并入，按其 updatedAt 排序', () => {
    const server: MyTimelineItem[] = [
      { id: 's', name: 'S', publishedAt: 0, updatedAt: 250, composition: null },
    ]
    const list = mergeTimelineList([meta({ docId: 'a', kind: 'local', lastViewedAt: 100 })], server)
    expect(list.map(x => x.id)).toEqual(['s', 'a'])
    expect(list.find(x => x.id === 's')!.kind).toBe('published')
  })

  it('本地与服务端同 id：本地条目优先，不重复', () => {
    const server: MyTimelineItem[] = [
      { id: 'a', name: 'A-server', publishedAt: 0, updatedAt: 999, composition: null },
    ]
    const list = mergeTimelineList(
      [meta({ docId: 'a', name: 'A-local', kind: 'published', lastViewedAt: 100 })],
      server
    )
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('A-local')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test:run src/pages/homeTimelineList.test.ts`
Expected: FAIL —— `homeTimelineList.ts` 不存在。

- [ ] **Step 3: 实现 `homeTimelineList.ts`**

```ts
/** HomePage 统一列表：本地 meta 与服务端「我发布的」按 id 合并去重、按最近查看排序 */
import type { LocalDocMeta } from '@/collab/types'
import type { MyTimelineItem } from '@/api/timelineShareApi'
import type { Composition } from '@/types/timeline'

export interface HomeTimelineItem {
  id: string
  name: string
  kind: 'local' | 'published' | 'visited'
  encounterId: number
  createdAt: number
  updatedAt: number
  composition: Composition | null
  /** 排序键：本地用 lastViewedAt，服务端独有条目用其 updatedAt */
  sortAt: number
}

export function mergeTimelineList(
  metas: LocalDocMeta[],
  serverItems: MyTimelineItem[]
): HomeTimelineItem[] {
  const items: HomeTimelineItem[] = metas.map(m => ({
    id: m.docId,
    name: m.name,
    kind: m.kind,
    encounterId: m.encounterId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    composition: m.composition,
    sortAt: m.lastViewedAt,
  }))
  const localIds = new Set(items.map(x => x.id))
  for (const s of serverItems) {
    if (localIds.has(s.id)) continue
    items.push({
      id: s.id,
      name: s.name,
      kind: 'published',
      encounterId: 0,
      createdAt: s.publishedAt,
      updatedAt: s.updatedAt,
      composition: s.composition,
      sortAt: s.updatedAt,
    })
  }
  return items.sort((a, b) => b.sortAt - a.sortAt)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test:run src/pages/homeTimelineList.test.ts`
Expected: PASS（3 个用例全通过）。

- [ ] **Step 5: 重写 `HomePage.tsx` 的列表区**

把第 167-229 行的「本地时间轴」与「已发布」两个 `<section>` 替换为单一列表 `<section>`：

```tsx
{
  /* 统一时间轴列表 */
}
{
  timelineList.length > 0 && (
    <section className="mb-12">
      <h2 className="text-xl font-semibold mb-4">我的时间轴</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {timelineList.map(item => (
          <TimelineCard
            key={item.id}
            timeline={{
              id: item.id,
              name: item.name,
              kind: item.kind,
              encounterId: String(item.encounterId),
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              composition: item.composition,
            }}
            onClick={() => {
              track('timeline-open', { source: item.kind })
              navigate(`/timeline/${item.id}`)
            }}
            onDelete={e => {
              e.stopPropagation()
              handleDeleteRequest(item)
            }}
          />
        ))}
      </div>
    </section>
  )
}
```

`timelineList` 由本地 meta 与 `myTimelines` 合并而来。把第 45-62 行替换为：

```tsx
const [metas, setMetas] = useState<LocalDocMeta[]>([])

const loadMetas = useCallback(async () => {
  const store = new IndexedDBDocStore()
  await store.open()
  setMetas(await store.getAllMeta())
}, [])

useEffect(() => {
  void loadMetas() // eslint-disable-line react-hooks/set-state-in-effect
}, [loadMetas])

const { data: myTimelines } = useQuery({
  queryKey: ['myTimelines'],
  queryFn: fetchMyTimelines,
  enabled: isLoggedIn,
})

const timelineList = useMemo(
  () => mergeTimelineList(metas, myTimelines ?? []),
  [metas, myTimelines]
)
```

顶部 import 补：`useMemo`（来自 react）、`import { mergeTimelineList, type HomeTimelineItem } from './homeTimelineList'`。
`CreateTimelineDialog` / `ImportFFLogsDialog` 的 `onCreated` / `onImported` 回调由 `loadTimelines` 改为 `loadMetas`。

- [ ] **Step 6: 重写 HomePage 的删除处理（按 kind 分流）**

删除原 `deleteConfirmOpen` / `deletePublishedConfirmOpen` 两套状态与两个 `<ConfirmDialog>`，统一为一套。新增状态与处理：

```tsx
const [pendingDelete, setPendingDelete] = useState<HomeTimelineItem | null>(null)

const handleDeleteRequest = (item: HomeTimelineItem) => setPendingDelete(item)

const handleDeleteConfirm = async () => {
  const item = pendingDelete
  if (!item) return
  try {
    if (item.kind === 'published') {
      await deleteSharedTimeline(item.id)
      await queryClient.invalidateQueries({ queryKey: ['myTimelines'] })
    }
    // 三种 kind 都要删本地记录（published 取消发布后亦删本地缓存）
    const store = new IndexedDBDocStore()
    await store.open()
    await store.deleteDoc(item.id)
    await loadMetas()
    toast.success(
      item.kind === 'published'
        ? '已取消发布'
        : item.kind === 'visited'
          ? '已从列表移除'
          : '时间轴已删除'
    )
  } catch (err) {
    toast.error(`操作失败：${err instanceof Error ? err.message : '未知错误'}`)
  }
  setPendingDelete(null)
}
```

对应的单个 `<ConfirmDialog>`：

```tsx
<ConfirmDialog
  open={pendingDelete !== null}
  onOpenChange={open => !open && setPendingDelete(null)}
  title={
    pendingDelete?.kind === 'published'
      ? '取消发布'
      : pendingDelete?.kind === 'visited'
        ? '从列表移除'
        : '删除时间轴'
  }
  description={
    pendingDelete?.kind === 'published'
      ? '取消发布后，获得链接的人将无法再访问该时间轴。确定要取消发布吗？'
      : pendingDelete?.kind === 'visited'
        ? '仅从你的本地列表移除该时间轴的记录，不影响原时间轴。'
        : '确定要删除这个时间轴吗？'
  }
  variant="destructive"
  onConfirm={handleDeleteConfirm}
/>
```

确认 `queryClient` 已有（第 33 行 `useQueryClient()`），`deleteSharedTimeline` 已在 import（第 19 行）。

- [ ] **Step 7: 验证**

Run: `pnpm exec tsc --noEmit && pnpm lint && pnpm test:run src/pages/homeTimelineList.test.ts`
Expected: 无类型 / lint 报错；合并测试 PASS。

- [ ] **Step 8: 提交**

```bash
git add src/pages/homeTimelineList.ts src/pages/homeTimelineList.test.ts src/pages/HomePage.tsx
git commit -m "feat(home): merge timelines into one recency-sorted list"
```

---

### Task 11: 全量回归与收尾

**Files:** 无新增改动，仅验证。

- [ ] **Step 1: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无报错。

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: 无报错。

- [ ] **Step 3: 全量测试**

Run: `pnpm test:run`
Expected: 全部 PASS，含新增的 `editLock` / `editorOpenDecision` / `homeTimelineList` 测试。

- [ ] **Step 4: 构建**

Run: `pnpm build`
Expected: 构建成功。

- [ ] **Step 5: 手动验证清单（开发服务器）**

确认以下场景（通常用户已启动 `pnpm dev`）：

- 协作编辑者打开他人时间轴 → 首页显示为「我访问过的」（无图标），不混入本地。
- 作者撤销某人编辑权限 → 该用户编辑器立即只读、toast 提示；刷新后为 viewer 只读、按钮显示「只读 · 仅查看」。
- 协作编辑者断网 → 编辑器只读；作者断网 → 仍可编辑。
- 回放模式 → 内容只读、标题/描述仍可改。
- 发布一条本地时间轴 → 首页只出现一次（地球仪图标），不再「本地 + 已发布」重复。

- [ ] **Step 6: 提交（如手动验证触发了修复）**

若 Step 1-5 全绿且无需修复，本任务无提交。若发现并修复了问题：

```bash
git add -A
git commit -m "fix(collab): address regression found in shared timeline QA"
```
