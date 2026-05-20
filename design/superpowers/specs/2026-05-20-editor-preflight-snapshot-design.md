# 编辑器首屏 Snapshot 兜底渲染 — 设计

> 日期：2026-05-20
> 状态：已评审，待写实现 plan

## 1. 背景

editor / author 角色首次访问已发布的协同时间轴时，本地 IndexedDB 无缓存，`SyncEngine.create` 用空 Y.Doc 启动；`openTimeline` 在 SyncEngine 实例化完毕（不等 WS）就 resolve；`EditorPage` 切到 `mode='ready'`，于是渲染了一个内容为空的编辑器外壳。慢网下要再等一个 WS 往返（AUTH → AUTH_OK → LOAD → LOAD_REPLY 应用完毕）才能看到真实内容。中间这段空窗就是"没有数据"的体感。

[2026-05-19 共享时间轴体验修复设计 §4.2](./2026-05-19-shared-timeline-experience-design.md) 的能力集模型已经保证 `connectionStatus !== 'connected'` 时 editor 必为只读——这一段空窗本来就是"只读期"，只是没数据可显示。

viewer 模式不存在此问题：[2026-05-16 协同同步设计 §7.3](./2026-05-16-timeline-collaborative-sync-design.md) 让 viewer 直接拿 REST KV snapshot 渲染，无需连 WS。

本设计延续 viewer 的思路，让 editor / author 在 WS 未连上之前也用 KV snapshot 做**临时只读渲染**，把 1 RTT 的空窗变成 1 RTT 的"内容渐进刷新"。

## 2. 关键不变量

| #   | 不变量                               | 理由                                                                                                                                                                              |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | snapshot 永不进入 Y.Doc              | 2026-05-16 §9.3：本地 `buildYDoc` 出的新 `(clientID, clock)` 与服务端权威 doc merge 时 CRDT 取并集，导致内容翻倍。snapshot 只能作为 React 层渲染数据，**绝不**作为 Y.Doc 的种子。 |
| 2   | WS `connected` 之前编辑器必为只读    | 2026-05-19 §4.2 的 `offline` cause 已保证（editor 角色 + 非 connected → 全锁）。本设计不引入新 cause、不破坏现有锁模型。                                                          |
| 3   | 本地 IndexedDB 缓存优先级 > snapshot | IndexedDB 反映"上次同步状态"，可能比 KV snapshot 更新（KV 滞后 squash debounce ~10s）。缓存命中时根本不需要 snapshot。                                                            |

## 3. 总体数据流

### 3.1 缓存命中（重访）

```
EditorPage.openTimeline(id, { role, snapshot })
  → SyncEngine.create(docId)
      store.loadDoc 命中 → applyUpdate(persisted) → engine.hadPersistedData = true
  → timelineStore 立即调用 onLoadedHandler()
      set({ yDocProjection: projectTimeline(doc), yDocReady: true, snapshot: null })
  → connectRemote()
      WS 异步起；LOAD_REPLY 到达后 onLoaded 因 yDocReady 已 true 而幂等短路

首屏渲染：yDocProjection（与现状一致）
```

### 3.2 缓存 miss（首访）

```
fetchSharedTimeline(id) → 拿到 snapshot（KV 命中）
EditorPage.openTimeline(id, { role, snapshot })
  → timelineStore set({ snapshot, yDocProjection: null, yDocReady: false })
  → SyncEngine.create(docId)
      store.loadDoc null → engine.hadPersistedData = false
  → connectRemote()

首屏渲染：snapshot（selector fallback）
此时 connectionStatus = 'connecting' → offline cause 全锁

  ... WS AUTH → AUTH_OK → LOAD → LOAD_REPLY ...

LOAD_REPLY 处理：
  applyUpdate(missing) → onLoaded 回调
  → timelineStore set({ yDocReady: true, snapshot: null }) + 手动 reproject()
  → yDocProjection 写入

切换渲染：yDocProjection
此时 connectionStatus = 'connected' → offline cause 释放 → 可编辑
```

### 3.3 viewer 路径

不变。`setViewerSnapshot(timeline)` 写 `snapshot` 字段、不建 engine、永远不到 `yDocReady`。selector `yDocProjection ?? snapshot` 自动走 snapshot 分支。

## 4. 客户端改动

### 4.1 `timelineStore`

把现有 `timeline: Timeline | null` 单字段拆为三个内部源 + 一个 selector：

```ts
{
  engine: SyncEngine | null

  // ── 三个互斥/分层的数据源 ──
  yDocProjection: Timeline | null // Y.Doc 投影; viewer 永远 null
  snapshot: Timeline | null // REST KV 快照; 三角色通用
  yDocReady: boolean // 仅 editor/author 关心

  // selector
  timeline: Timeline | null // = yDocProjection ?? snapshot
}
```

三种角色 × 缓存状态下的字段值：

| 场景                      | snapshot               | yDocProjection           | yDocReady  |
| ------------------------- | ---------------------- | ------------------------ | ---------- |
| viewer                    | REST 值，永久持有      | 永远 null                | 永远 false |
| editor/author + 缓存命中  | REST 值，立即清        | 立即写入（来自本地 doc） | 立即 true  |
| editor/author + 缓存 miss | REST 值，等 LOAD_REPLY | null                     | false      |
| ↑ 同上，LOAD_REPLY 应用完 | 清                     | 写入                     | true       |

action 签名：

```ts
openTimeline(docId, opts: {
  role: 'local' | 'author' | 'editor'
  seedContent?: ...
  snapshot?: Timeline   // 新增,editor/author 首屏兜底
})

setViewerSnapshot(timeline: Timeline)   // 不变
```

`openTimeline` 内部时序：

1. `set({ snapshot: opts.snapshot ?? null, yDocProjection: null, yDocReady: false, sessionRole: opts.role, ... })`
2. `await SyncEngine.create(docId, seedDoc)`
3. 若 `engine.hadPersistedData` → 调用 `onLoadedHandler()`（即立即视作已加载）
4. 若 `opts.role !== 'local'` → `wireRemote(engine)`（注入 `onLoadedHandler` 作 onLoaded）

`onLoadedHandler`（缓存命中和 LOAD_REPLY 两条路径共用）：

```ts
const onLoadedHandler = () => {
  if (get().yDocReady) return // 幂等
  set({ yDocReady: true, snapshot: null })
  reproject() // 主动跑一次,保证 yDocProjection 被写入
}
```

**为什么手动 `reproject()`**：LOAD_REPLY 里 `missing` 若为空（state vector 已同步、doc 空），`Y.applyUpdate` 不触发 'update' 事件，自动 reproject 不会跑。手动调用一次保证 yDocProjection 一定写入（哪怕是空投影）。

`reset()`：清 `yDocProjection / snapshot / yDocReady`（与现有清理逻辑合并）。

### 4.2 `SyncEngine`

新增只读属性：

```ts
readonly hadPersistedData: boolean
```

构造时由 `persisted !== null` 一次性决定，对外只读。

`connectRemote` 签名增加 `onLoaded?: () => void`，原样透传给 `RemoteConnection` 构造函数。其它逻辑不动。

### 4.3 `RemoteConnection`

构造参数新增 `onLoaded?: () => void`：

```ts
constructor(
  url: string,
  doc: Y.Doc,
  awareness: Awareness,
  getAuthToken: () => Promise<string | null>,
  onStatus: (status: ConnectionStatus) => void,
  onEditRequest?: (count: number) => void,
  onRevoked?: () => void,
  onLoaded?: () => void,   // 新增
)
```

`onMessage` 处理 LOAD_REPLY 末尾追加一行 `this.onLoaded?.()`：

```ts
if (msg.type === MSG.LOAD_REPLY) {
  const { missing, stateVector } = decodeLoadReply(msg.payload)
  if (missing.length > 0) Y.applyUpdate(this.doc, missing, REMOTE_ORIGIN)
  const ours = Y.encodeStateAsUpdate(this.doc, stateVector)
  this.ws?.send(encodeMessage(MSG.PUSH, ours))
  this.onLoaded?.() // 新增
  return
}
```

**触发语义**：每次 LOAD_REPLY 都触发；幂等性放在 store 端做。RemoteConnection 不维护"是否首次"这类应用层状态，只关心传输协议。

重连后的第二次 LOAD_REPLY 也会触发，store 端 `if (get().yDocReady) return` 短路。

### 4.4 `EditorPage`

`fetchSharedTimeline` 的响应类型 `SharedTimelineResponse` 已经声明了 `snapshot?: Timeline`（2026-05-16 §7.3、2026-05-18 §2 已存在）；当前 editor 分支拿到不用，本设计开始用。

editor / author 分支调用 `openTimeline` 时透传 snapshot：

```ts
await openTimeline(id, {
  role: decision.kind, // 'author' | 'editor' | 'local'
  snapshot: serverRes?.snapshot, // 可为 undefined
})
```

`mode` 状态机不变（`loading | ready | not_found | network_error`）。`mode='ready'` 的语义从"Y.Doc 内容就绪"放宽为"页面外壳可渲染"——`timeline ? <Canvas/> : <Loading/>`（`src/pages/EditorPage.tsx:429`）现有判定继续生效：

- snapshot 存在 → `timeline` 非 null → 立即渲染
- snapshot 缺失（KV miss） → `timeline` null → 内联 "加载中..." 文案直到 LOAD_REPLY

### 4.5 `EditLock`

不动。`offline` cause（2026-05-19 §4.2）在 snapshot 兜底渲染期自动激活：`sessionRole === 'editor' && connectionStatus !== 'connected'`，`connecting` 满足 `!== 'connected'`。

## 5. 服务端改动

### 5.1 `GET /api/timelines/:id`

`src/workers/routes/timelines.ts`：现 viewer 分支独占的 KV 查询代码上提，editor / author / viewer 共用同一段查询。响应类型 `SharedTimelineResponse` 的 `snapshot?: Timeline` 字段对三种角色都会被填充。

实现上是把 `snapshot` 字段填充移到 role 判定之前 / 之外，三种角色走同一段查询逻辑。

### 5.2 KV miss 回填路径

现有逻辑保留：KV miss → 唤醒 DO 调 `getSnapshotJson()` → 回填 KV → 返回。`getSnapshotJson()` 在 `store.isEmpty()` 时返回 null（2026-05-16 §6.1），响应 `snapshot` 字段为 undefined。

### 5.3 缓存头

不变。editor / author 路径仍 `private, no-cache`（2026-05-18 §2 已规定）。viewer 路径仍 `public, max-age=60`。`snapshot` 字段对应的内容并不增加缓存语义的复杂度。

### 5.4 不动的部分

- WebSocket 升级路径 `GET /:id/connect`
- KV 写入侧（DO `writeSnapshotCache`）
- 4001 / 1008 close code 语义
- `kickUser` RPC、`timeline_editors` 表

## 6. 边界 case

| 场景                                    | 行为                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| editor 首访 + KV 命中                   | snapshot 立即渲染、1 RTT 后切 yDocProjection                                                            |
| editor 首访 + KV miss（新发布 / DO 空） | snapshot undefined → 内联 loading → LOAD_REPLY 后切 yDocProjection。无信息损失（DO 空表示时间轴本就空） |
| editor 重访（本地缓存命中）             | `SyncEngine.create` 命中 → 立即 yDocProjection；onLoaded 幂等短路                                       |
| WS 始终未连上（重试中）                 | snapshot 持续兜底渲染，offline cause 全锁；连上后自动切                                                 |
| WS LOAD_REPLY 前撤权（极小窗口）        | sessionRole 降级 viewer，selector 自然走 snapshot；视觉无空白                                           |
| `fetchSharedTimeline` 失败              | 同 2026-05-19 §5 现有逻辑：404 → not_found，网络错误 → network_error 或离线进入                         |
| viewer 路径                             | 完全不变                                                                                                |

snapshot 投影 → Y.Doc 投影切换瞬间的视觉差异（多/少 cast event、damage 数值不同）**不做过渡动画 / 不做 diff 高亮**。理由：编辑者首屏阶段就是只读，看到内容更新跟"别人正在协同编辑"是同一种体验；加过渡反而误导用户。

## 7. 测试

### 7.1 `timelineStore`（纯逻辑）

- selector 三种数据源优先级：6 种组合 × 期望返回值
- 缓存命中路径：fake `SyncEngine.create` 返回 `hadPersistedData = true` 的 engine → 验证 snapshot 立即被清、yDocReady=true、yDocProjection 立即就位
- 缓存 miss 路径：fake `hadPersistedData = false` → 验证 snapshot 保持、yDocProjection null、yDocReady false
- `onLoadedHandler` 幂等：连续触发 2 次只生效 1 次
- 撤权时 yDocProjection 已就绪：sessionRole 变 viewer 后 selector 仍走 yDocProjection
- 撤权时仍在 snapshot 兜底渲染期：sessionRole 变 viewer 后 selector 走 snapshot

### 7.2 `RemoteConnection`

- LOAD_REPLY 到达 → `onLoaded` 触发 1 次
- LOAD_REPLY missing=空 → `onLoaded` 仍触发
- 1008 / 4001 / 鉴权超时 → `onLoaded` 不触发
- 重连后第二次 LOAD_REPLY → `onLoaded` 再次触发（store 端幂等吃掉，不在此测）

### 7.3 Worker 路由

- `GET /:id` editor 角色 KV 命中：响应含 `snapshot`
- `GET /:id` editor 角色 KV miss：响应 `snapshot` 为 undefined，不报错
- `GET /:id` viewer 角色：行为无回归
- `Cache-Control`：editor 路径仍 `private, no-cache`

### 7.4 集成 / 手测

- 弱网（模拟 RTT 500ms+）首次访问 editor 时间轴：无"空编辑器"瞬间
- 缓存命中重访：行为无回归
- 撤权流程：toast、按钮文案切换、画布内容继续显示

### 7.5 不需要测

- editLock 模型（2026-05-19 已覆盖，不动）
- 撤权 RPC 路径（2026-05-18 已覆盖，不动）
- 协议帧格式（2026-05-16 已覆盖，不动）
- IndexedDBDocStore 持久化（2026-05-16 已覆盖，不动）

## 8. 影响面

| 文件                              | 改动                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/workers/routes/timelines.ts` | `GET /:id`：KV snapshot 查询三角色共用                                                                              |
| `src/collab/RemoteConnection.ts`  | 构造参数 `onLoaded`；LOAD_REPLY 末尾触发                                                                            |
| `src/collab/SyncEngine.ts`        | `hadPersistedData` 只读属性；`connectRemote` 透传 `onLoaded`                                                        |
| `src/store/timelineStore.ts`      | 拆 `timeline` 为 `yDocProjection / snapshot / yDocReady`；selector；`onLoadedHandler`；`openTimeline` 接收 snapshot |
| `src/pages/EditorPage.tsx`        | `openTimeline` 调用透传 `snapshot`                                                                                  |
| 对应的 `*.test.ts`                | 新增上述覆盖                                                                                                        |

**不触碰**：editLock 模型、awareness、同步协议帧格式、IndexedDBDocStore、4001 撤权 RPC 链路、HomePage、伤害计算。

## 9. 不做（YAGNI）

- snapshot → yDocProjection 切换的视觉过渡动画（§6 末段）
- ETag / If-Modified-Since 条件请求（§5.3）
- snapshot 之外的额外加载态文案
- editor 离线缓存的主动清理（2026-05-19 §6 已规定不做）
- 让 snapshot 直接作为 Y.Doc 的 seed（违反不变量 1）

## 10. 未来扩展点

- 若用户反馈切换突兀，`EditorPage` 可加 200ms opacity 过渡，无架构改动
- 若需完全离线访问 KV snapshot（PWA / 断网兜底），可在 Service Worker 层缓存 `GET /api/timelines/:id` 响应
