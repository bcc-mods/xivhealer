# 共享时间轴体验修复设计

> 日期：2026-05-19
> 状态：已评审，待实现

## 1. 背景与问题

其他用户访问被共享的时间轴时，存在三个互相关联的体验问题：

1. **被授予编辑权限的协作时间轴会出现在自己的「本地时间轴」列表中** —— 与用户自己创建的本地时间轴混为一谈。
2. **编辑权限被取消后，时间轴仍留在本地列表中**；会话内被强制只读，但**刷新页面后又能正常编辑**，同时分享按钮显示「只能查看」—— 模式与角色矛盾。
3. **重新取得编辑权限后，无权限期间所做的本地更改会被同步到远程时间轴**。

### 1.1 根因

- `LocalDocMeta` 只有 `published` 一个布尔，**无法区分「我自己的时间轴」与「别人分享给我协作的时间轴」**（现象 1）。
- `EditorPage` 的「已发布对账」分支**只判断 404（取消发布），完全不检查服务端返回的角色**。权限被取消后服务端返回 `role: 'viewer'`（HTTP 200），代码仍走 `setMode('editor')`，编辑器可编辑；而 `setShareRole` 又用了 `viewer` 角色，导致 mode 与按钮矛盾（现象 2）。
- 现象 2 让用户在被取消权限后仍能编辑，这些改动进入本地 Y.Doc；重连时 Yjs `LOAD_REPLY` 处理会 `Y.encodeStateAsUpdate` 一次性推送全量差异，泄漏到远程（现象 3）。

此外排查中发现只读体系本身混乱，需一并重构（见 §4）。

### 1.2 已确认的事实（实现约束）

- `ConnectionStatus` 原为 `disconnected | connecting | connected | revoked`。
- WS 关闭码 `1008`（"not an editor"）→ 终态、不重连；`4001`（会话中被踢）→ 原 `revoked` 终态；其它断开 → 指数退避重连。
- WS 服务端 `handleAuth` 已校验 `timeline_editors`，被撤权用户重连会被 `1008` 拒绝。
- `onLocalUpdate` 仅在 `connected` 时推送；离线改动在重连 `LOAD_REPLY` 时一次性补推 —— 这是现象 3 的泄漏通道。
- 协作功能尚未上线生产，**不需要数据迁移**。

## 2. 设计原则

「别人分享给我协作的时间轴」是一个**远程资源**，不是我的本地时间轴。其本地 IndexedDB Y.Doc 只是在线协同时的工作副本 / 上次同步的镜像，权限始终以服务端为准。协作时间轴离线时只读，因此本地副本永不产生离线分叉 —— 从根上消除现象 3。

## 3. 数据模型

### 3.1 `LocalDocMeta`

去掉 `published` 布尔，改用三值 `kind`，新增 `lastViewedAt`：

```ts
interface LocalDocMeta {
  docId: string
  name: string
  encounterId: number
  createdAt: number
  updatedAt: number
  composition: Composition | null
  fflogsSource?: Timeline['fflogsSource']
  /** 时间轴归属状态 */
  kind: 'local' | 'published' | 'visited'
  /** 最近一次打开时间（Unix 秒）—— HomePage 列表排序键 */
  lastViewedAt: number
}
```

- `local` —— 本地未发布时间轴（我创建的）。
- `published` —— 已发布、我是作者。
- `visited` —— 我访问过的、别人的已发布时间轴（无论我是 editor 还是 viewer，不区分）。

viewer 角色打开的时间轴**也写一条 `kind:'visited'` 的轻量 meta（stub）**，不含 Y.Doc snapshot / updates，仅用于进入 HomePage 列表。

### 3.2 `timelineStore`

- 新增 `sessionRole: 'local' | 'author' | 'editor' | 'viewer'`，取代原 `sessionKind` 与旁路布尔 `isShared`。由 `openTimeline({ role })` / `setViewerSnapshot` 设置，`reset` 时复位。
- `openTimeline` 的 `opts` 由 `{ published?, seedContent? }` 改为 `{ role: 'local'|'author'|'editor', seedContent? }`。
- `connectionStatus` 收窄为 `disconnected | connecting | connected`（移除 `revoked`）。

### 3.3 `uiStore`

- `isReadOnly` 改名 `manualLock`，`toggleReadOnly` → `toggleManualLock`。
- 从 `persist` 的 `partialize` 中移除（它本是会话级状态，持久化无意义）。
- `openTimeline` / `setViewerSnapshot` 时重置为 `false`。

## 4. 只读体系重构（能力集模型）

### 4.1 现状问题

只读判定散落四处且语义复用：

- `uiStore.isReadOnly` 一个布尔被「手动锁定 / viewer / revoked」三种语义共用。
- `EditorPage` 每次挂载 `setState({isReadOnly:false})` 把它冲掉，persist 实为死状态。
- `EditorToolbar.forceReadOnly`（`isViewMode || revoked`）是另算的第四处。
- 只读原因可叠加、且冻结范围不同（回放模式冻结内容但不冻结标题/描述），单布尔无法表达。

### 4.2 模型

把「能编辑什么」拆成**能力（capability）**，把「为什么不能编辑」拆成**原因（cause）**，每个原因声明它撤销哪些能力，生效锁 = 所有激活原因撤销能力的并集。

```ts
/** 全部可编辑操作；新增可编辑面在此追加一项 */
type EditCapability = 'content' | 'metadata' | 'exitReplay'

type CauseId = 'viewer' | 'offline' | 'replay' | 'manual'

interface CauseSpec {
  id: CauseId
  priority: number // 文案展示时谁是主因，数字大者优先
  revokes: 'all' | EditCapability[]
}

const CAUSES: CauseSpec[] = [
  { id: 'viewer', priority: 4, revokes: 'all' },
  { id: 'offline', priority: 3, revokes: 'all' },
  { id: 'replay', priority: 2, revokes: ['content'] },
  { id: 'manual', priority: 1, revokes: 'all' },
]
```

能力含义：

- `content` —— 增删改 cast / damage / annotation 事件、阵容、statData 等一切实质内容。
- `metadata` —— 标题、描述。
- `exitReplay` —— 解除回放模式。

原因激活谓词（从 store 派生，无独立存储字段）：

| cause     | 激活条件                                                       |
| --------- | -------------------------------------------------------------- |
| `viewer`  | `sessionRole === 'viewer'`                                     |
| `offline` | `sessionRole === 'editor' && connectionStatus !== 'connected'` |
| `replay`  | `timeline.isReplayMode`                                        |
| `manual`  | `uiStore.manualLock`                                           |

要点：

- `replay` 只撤销 `content` —— 作者 / 协作编辑者在回放模式下仍可改标题、描述，仍可解除回放。
- `offline` 仅对 `sessionRole === 'editor'`（协作编辑者）生效；`author` 不受影响，作者可离线编辑自己的已发布时间轴。
- `offline` 在 `connecting`（重连中 / 首次握手）也激活 —— 协作时间轴未连线即只读，握手期/抖动期短暂只读可接受。

### 4.3 hook

```ts
interface EditLock {
  can: (cap: EditCapability) => boolean
  reasonOf: (cap: EditCapability) => CauseId | null // 该能力被锁的主因
}
function useEditLock(): EditLock
```

`useEditorReadOnly()` 保留为 `() => !useEditLock().can('content')` 的别名 —— 现有十余个内容消费组件（Timeline / PropertyPanel / TimelineTable / CompositionPopover / StatDataDialog 等）**签名不变、零改动**。

### 4.4 消费端改动

- `EditableTitle`（补 `readOnly` prop）/ `EditableDescription` 用 `can('metadata')`。
- `EditorPage` 头部不再按 `isViewMode` 切 `<h1>` / `<EditableTitle>`，统一渲染并传 `readOnly={!can('metadata')}`（「By 作者」徽标的展示与只读无关，单独判断）。
- `EditorToolbar` 删除 `forceReadOnly` prop，改用 `useEditLock()`：`reasonOf('content') ∈ {null,'manual'}` 时显示可点的锁按钮；为系统原因时显示**不可点的状态标识**（如「只读 · 仅查看 / · 连接中断 / · 回放模式」）。回放 popover 的「解除回放」按 `can('exitReplay')`。
- `EditorPage` 删除所有 `useUIStore.setState({ isReadOnly })` 调用。

## 5. EditorPage 模式推导与对账

`EditorPage` 的 `mode` 仅保留页面级状态 `loading | ready | not_found | network_error`；内容访问角色由 `timelineStore.sessionRole` 表达。

打开 `/timeline/:id` 时：

1. `meta = store.getMeta(id)`。
2. **`meta` 存在**：
   - `kind === 'local'` → `openTimeline(id, { role: 'local' })`。
   - `kind === 'published' | 'visited'` → 调 `fetchSharedTimeline(id)`：
     - **成功**：按响应分流并刷新 meta（`kind` 与 `lastViewedAt`）：
       - `isAuthor` → `openTimeline(id, { role: 'author' })`，`kind = 'published'`。
       - `role === 'editor'` → `openTimeline(id, { role: 'editor' })`，`kind = 'visited'`。
       - `role === 'viewer'` → `setViewerSnapshot(snapshot)`，`kind = 'visited'`。
     - **404**：
       - `kind === 'published'`（作者取消发布）→ `rekey` 换全新本地 id、`kind = 'local'`（沿用现有逻辑）。
       - `kind === 'visited'`（作者删除了时间轴）→ `not_found`，`deleteDoc` 删除本地 meta。
     - **网络错误**：
       - `kind === 'published'` → `openTimeline(id, { role: 'author' })`，作者离线可编辑。
       - `kind === 'visited'` → 有本地 Y.Doc 则 `openTimeline(id, { role: 'editor' })`（由 `offline` cause 兜底为只读，连上 / 刷新后自我纠正）；无本地 Y.Doc（纯 viewer 访问过）则 `network_error`。
3. **`meta` 不存在**（首次经链接进入）→ 调 `fetchSharedTimeline(id)`：
   - `isAuthor` → `role: 'author'`，建 `kind:'published'` meta。
   - `editor` → `role: 'editor'`，建 `kind:'visited'` meta。
   - `viewer` → `setViewerSnapshot`，建 `kind:'visited'` 的 stub meta（name / encounterId / composition 取自 snapshot，不写 Y.Doc）。
   - 404 → `not_found`；网络错误 → `network_error`。

每次成功打开都更新对应 meta 的 `lastViewedAt`。

## 6. 撤权处理

WS 关闭码 `4001` 不再映射为 `ConnectionStatus` 的值。`RemoteConnection` 收到 `4001`：终态关闭（同 `1008`），并额外触发一个「被撤权」回调。`timelineStore` 接到回调后：

- 将 `sessionRole` 降级为 `'viewer'`。
- 弹一次性 toast「你的编辑权限已被移除」。

此后由 `viewer` cause 接管只读，工具栏状态标识显示「仅查看」。内存中已同步的 Y.Doc 继续只读渲染，无需切服务端 snapshot、无需清缓存、无需特殊列表处理 —— 该时间轴只是一条 `kind:'visited'` 记录，行为变只读即可。本地缓存的最终清理交由 HomePage 垃圾桶（用户主动）或下次对账。

## 7. HomePage 统一列表

取消「本地 / 已发布 / 协作」分区，所有时间轴混合为单一列表。

- **数据源**：本地 `getAllMeta()` 与服务端 `fetchMyTimelines()`（仅「我发布的」）按 `docId` / `id` 合并去重。
- **排序**：按 `lastViewedAt` 倒序；服务端独有（其它设备发布、本机未打开过）的条目以服务端 `updatedAt` 参与排序。
- **SWR 缓存**：`fetchMyTimelines` 用 React Query `useQuery`（stale-while-revalidate）。本地 meta 作为持久基线即时渲染（冷启动 / 刷新也不空白），服务端数据后台 revalidate 后静默合并，列表不闪动。无需引入 `persistQueryClient`。
- **图标与垃圾桶行为按 `kind`**：

| `kind`      | 图标            | 垃圾桶行为                                               |
| ----------- | --------------- | -------------------------------------------------------- |
| `local`     | hard-drive      | 删除本地（`deleteDoc`）                                  |
| `published` | 地球仪（globe） | 取消发布（服务端 `DELETE /api/timelines/:id`）+ 删除本地 |
| `visited`   | 无              | 仅删除本地记录（`deleteDoc`）                            |

`Top100Section`（TOP100 参考方案）维持在列表下方。

## 8. 移除 / 不再需要

- `ConnectionStatus` 的 `revoked` 取值，以及 `revoked` 作为 cause。
- `timelineStore` 的 `sessionKind`、旁路布尔 `isShared`。
- `uiStore.isReadOnly` 的多语义复用（改名 `manualLock` 后单一语义）。
- `EditorToolbar.forceReadOnly` prop。
- 曾规划的 `GET /api/my/shared`（协作列表）接口、HomePage「协作分区」、孤儿 meta 主动清理 —— 统一列表后这些概念均消失。

## 9. 测试要点

- `useEditLock` —— 各 cause 单独与叠加组合下 `can` / `reasonOf` 的结果（重点：回放模式下 `content` 锁、`metadata` 不锁；协作编辑者离线 `offline` 全锁；作者离线不锁）。
- `EditorPage` 对账 —— `isAuthor` / `role` × `kind` ×（成功 / 404 / 网络错误）矩阵 → 正确的 `sessionRole` 与 meta 更新。
- `4001` 撤权 —— `RemoteConnection` 终态 + 回调；`sessionRole` 降级为 `viewer`。
- `HomePage` —— 本地与服务端列表按 id 合并去重、按 `lastViewedAt` 排序、三种 `kind` 的图标与垃圾桶行为。
- 现象 3 回归 —— 协作编辑者离线期间不可编辑（`offline` cause），重连后无离线分叉推送。
