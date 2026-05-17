# 时间轴共享与编辑权限管理 — 设计

> 日期：2026-05-18
> 状态：已批准，待写实现 plan

## 背景

当前 `SharePopover` 只有「未登录 / 已登录未发布 / 已发布」三态，已发布态对所有人只显示分享链接，不区分 viewer / editor / author。viewer 模式下工具栏甚至不渲染 `SharePopover`，而是单独一个「在本地创建副本」按钮。

本设计把共享 popover 改造为**按角色分化的权限管理面板**：查看者能创建副本、申请编辑权限；作者能开关申请、管理编辑者与申请者名单。

## 目标

- 共享入口按钮对所有人可见，图标 / 文案随角色变化。
- 新增「允许申请编辑权限」开关（下称申请开关），仅作者可见可控。
- 查看者可申请编辑权限；作者可通过 / 拒绝申请、移除已有编辑者。
- 撤销编辑权限对在线用户**立即生效**。

## 关键决策

| #   | 决策                                                                          | 理由                                                                                               |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | **撤销编辑权限立即生效**：移除编辑者时 Worker 通知 DO 主动断开该用户的协同 WS | 被撤销者应即刻失去编辑能力                                                                         |
| 2   | **通过申请为刷新生效**：被通过者刷新页面后进入协同编辑                        | viewer 未连协同 WS（只持静态快照），无实时通道可推送；为「通过也实时」单独给 viewer 加 WS/轮询不值 |
| 3   | **被撤销者页面**：立即变只读 + toast 提示；完整 viewer 体验在刷新后生效       | 不在原页面强行重建 viewer 模式，降低复杂度                                                         |
| 4   | **申请开关关闭时，已有的待处理申请保留**：作者仍可处理，用户无法再发起新申请  | 关开关不应丢弃已提交的申请                                                                         |
| 5   | 未登录用户的 popover 含登录引导                                               | 已是白名单编辑者的人登录后可直接编辑                                                               |

## 一、数据模型

新增 migration `migrations/0005_create_edit_requests.sql`：

```sql
-- 申请开关:每条时间轴是否允许他人申请编辑权限
ALTER TABLE timelines ADD COLUMN allow_edit_requests INTEGER NOT NULL DEFAULT 0;

-- 编辑者列表需展示用户名(原表无 user_name 列)
ALTER TABLE timeline_editors ADD COLUMN user_name TEXT NOT NULL DEFAULT '';

-- 待处理的编辑权限申请。只存 pending:无 status 列。
CREATE TABLE IF NOT EXISTS timeline_edit_requests (
  timeline_id TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  user_name   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (timeline_id, user_id)
);
```

`timeline_edit_requests` 生命周期：

- **发起申请** → 插入一行（`INSERT OR IGNORE`，已存在则幂等）。
- **通过** → 删该行 + 写入 `timeline_editors`（带 `user_name`）。
- **拒绝** → 删该行。行没了，该用户后续可再次申请。
- **pending** = 行存在。

`timeline_editors` 旧行（发布时自动插入的作者行）`user_name` 为空字符串，但编辑者列表渲染时排除作者本人，故不受影响；新编辑者行（通过申请产生）携带真实用户名。

## 二、API 端点

新建路由模块 `src/workers/routes/share.ts`，与 `timelines.ts` 同挂 `/api/timelines`，避免后者继续膨胀。

| 方法 / 路径                               | 权限           | 作用                                                          |
| ----------------------------------------- | -------------- | ------------------------------------------------------------- |
| `GET /:id`（**改 `timelines.ts`**）       | 公开           | 响应新增 `isAuthor`、`allowEditRequests`、`hasPendingRequest` |
| `GET /:id/share`                          | 仅作者         | 返回 `{ allowEditRequests, editors, applicants }`             |
| `PATCH /:id/share`                        | 仅作者         | body `{ allowEditRequests: boolean }`，设申请开关             |
| `POST /:id/edit-requests`                 | 登录且非编辑者 | 发起申请                                                      |
| `POST /:id/edit-requests/:userId/approve` | 仅作者         | 通过：删 request 行 + 写 `timeline_editors`                   |
| `POST /:id/edit-requests/:userId/reject`  | 仅作者         | 拒绝：删 request 行                                           |
| `DELETE /:id/editors/:userId`             | 仅作者         | 移除编辑者：删 `timeline_editors` 行 + 调 DO `kickUser`       |

### `GET /:id`（修改）

现有响应 `{ role, authorName, snapshot? }` 增加：

- `isAuthor: boolean` —— 当前请求用户是否为作者（`timelines.author_id` 匹配）。
- `allowEditRequests: boolean` —— 时间轴级开关状态。
- `hasPendingRequest: boolean` —— 当前登录用户是否有待处理申请；未登录恒 `false`。

缓存头：带鉴权的请求（editor 或登录的 viewer，响应含用户相关字段）返回 `private, no-cache`；匿名请求维持 `public, max-age=60`。`allowEditRequests` 为时间轴全局值，可被缓存；`isAuthor` 在 viewer 分支恒 `false`（viewer 永不是作者），仅在已是 `private` 的 editor 分支才变化——故匿名响应仍可安全公开缓存。

### `GET /:id/share`（作者）

响应：

```ts
{
  allowEditRequests: boolean
  editors: {
    userId: string
    userName: string
  }
  ;[] // 排除作者本人
  applicants: {
    userId: string
    userName: string
    createdAt: number
  }
  ;[]
}
```

popover 由作者打开时拉取（非页面加载时）。非作者调用 → 403。

### `POST /:id/edit-requests`（申请）

- 需登录。`user_name` 取 `auth.username`。
- 申请开关关闭 → 403。
- 调用者已是编辑者 → 409（无需申请）。
- 时间轴不存在 → 404。
- 成功 → `INSERT OR IGNORE` 后返回 201。

### `POST /:id/edit-requests/:userId/approve` / `reject`（作者）

两个对称的动作端点。`approve`：在一个语句序列内删 `timeline_edit_requests` 行、`INSERT OR IGNORE` 入 `timeline_editors`（含 `user_name`）。`reject`：仅删 `timeline_edit_requests` 行。request 行不存在（已被处理）→ 404。

### `DELETE /:id/editors/:userId`（作者）

- 守卫：`userId === timelines.author_id` → 400（不可移除作者本人）。
- 删 `timeline_editors` 中 `(timeline_id, userId)` 行。
- 删除后调用 `docStub(env, id).kickUser(userId)`，无论该用户当前是否在线（离线则 DO 内无匹配 socket，no-op）。

## 三、撤销实时生效（协同层）

### DO 新增 RPC

`TimelineDoc.kickUser(userId: string): Promise<void>` —— 遍历 `this.ctx.getWebSockets()`，对 `SocketAttachment.userId === userId` 的已鉴权连接执行 `ws.close(4001, 'editor revoked')`。`SocketAttachment` 已存 `userId`（`handleAuth` 中写入），无需改 attachment 结构。

### close code 选择

用应用自定义 close code **`4001`**（4000–4999 段），而非复用 `1008`。`1008` 仅在 AUTH 握手期出现（invalid token / not an editor / auth required）；`4001` 明确表示「会话进行中被撤销」，客户端可无歧义区分两者。

### 客户端 `RemoteConnection`

`onClose(code)` 分流新增一条：`code === 4001` → 与 `1008` 一样转入终态（置 `closed = true`、不重连，复用加固增量已建的终态逻辑），但状态报告为新增的 `'revoked'`（而非 `'disconnected'`）。

`ConnectionStatus` 类型新增 `'revoked'`：`'disconnected' | 'connecting' | 'connected' | 'revoked'`。

### Store 与页面响应

`timelineStore` 的 `connectionStatus` 收到 `'revoked'` 后，`EditorPage` 据此：

- `useUIStore.setState({ isReadOnly: true })` —— 编辑器即刻只读。
- toast 提示「你的编辑权限已被移除」。
- 共享按钮触发器与 popover 按 viewer 呈现（见下节；`'revoked'` 在 UI 层等同 viewer）。

完整 viewer 体验（静态快照、viewer 头部样式等）在用户刷新后由 `GET /:id` 重新推导。

## 四、前端

### 触发按钮

`EditorToolbar` 现在**恒渲染 `SharePopover`**，删除原先 viewer 模式下的独立「在本地创建副本」按钮。按钮图标 + 文案：

| 角色                           | 图标 + 文案                     |
| ------------------------------ | ------------------------------- |
| 本地未发布                     | `CloudUpload` +「共享」（不变） |
| 已发布·作者                    | `Globe` +「共享」（不变）       |
| 已发布·编辑者（非作者）        | 笔（`Pencil`）+「可编辑」       |
| 未登录 / 无编辑权限 / 已被撤销 | 锁（`Lock`）+「只能查看」       |

### Popover 状态

由纯函数 `deriveShareView(input)` 推导，`input` 含：`isLoggedIn`、`isPublished`、`role`、`isAuthor`、`allowEditRequests`、`hasPendingRequest`、`isRevoked`。`isRevoked` 为真时整体按 viewer 处理。

| 态                     | 条件                                                         | popover 内容                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 本地未发布           | `!isPublished`                                               | 现有发布流程，原样保留                                                                                                                                       |
| 2a 未登录              | 已发布·viewer·`!isLoggedIn`                                  | 文案「你只能查看此时间轴，若要编辑时间轴，请生成副本进行编辑。」+ 登录引导行（「已是该时间轴的编辑者？登录后即可编辑。」）；按钮栏：`登录 FFLogs` `创建副本` |
| 2b 已登录无权限·开关关 | viewer·`isLoggedIn`·`!allowEditRequests`                     | 同上文案；按钮栏：`创建副本`                                                                                                                                 |
| 3 可申请·未申请        | viewer·`isLoggedIn`·`allowEditRequests`·`!hasPendingRequest` | 文案「你只能查看此时间轴，若要编辑时间轴，请向时间轴作者申请编辑权限或生成副本进行编辑。」；按钮栏：`创建副本` `申请编辑权限`                                |
| 4 已申请               | viewer·`isLoggedIn`·`allowEditRequests`·`hasPendingRequest`  | 同态 3 文案；`申请编辑权限` 按钮禁用、文案变「已申请」                                                                                                       |
| 5 编辑者               | editor·`!isAuthor`                                           | 文案「你有权限编辑该文档。」；按钮栏：`创建副本` `复制分享链接`                                                                                              |
| 6 作者                 | `isAuthor`                                                   | `复制分享链接` 按钮；申请开关（`Switch`）；编辑者列表；申请者列表                                                                                            |

按钮栏统一置于 popover 底部、右对齐。

### 作者 popover（态 6）的两个列表

- **编辑者列表**：每行 = 用户名 + 垃圾桶图标按钮。点击 → `DELETE /:id/editors/:userId` → 成功后从列表移除该行。空列表显示占位文案。
- **申请者列表**：每行 = 用户名 + ✓ / ✗ 两个按钮。✓ → `approve` 端点，成功后该行从申请者列表移除、加入编辑者列表；✗ → `reject` 端点，成功后该行移除。空列表显示占位文案。
- 申请开关 `Switch` → `PATCH /:id/share`。

列表数据在作者打开 popover 时经 `GET /:id/share` 拉取（带 loading 态）。

### 创建副本

复用 `EditorPage` 已有的 `handleCreateCopy`（从当前 `timeline` 投影建本地副本，任意模式可用）。原先经 `onCreateCopy` prop 传给工具栏的链路改为传入 `SharePopover`。

### API 客户端

`src/api/timelineShareApi.ts` 新增：`fetchShareState(id)`、`setAllowEditRequests(id, value)`、`requestEditPermission(id)`、`approveEditRequest(id, userId)`、`rejectEditRequest(id, userId)`、`removeEditor(id, userId)`。`fetchSharedTimeline` 的返回类型扩展 `isAuthor` / `allowEditRequests` / `hasPendingRequest`。

### `EditorPage`

`fetchSharedTimeline` 返回的新字段（`isAuthor`、`allowEditRequests`、`hasPendingRequest`）保存为页面状态并下传 `EditorToolbar` → `SharePopover`。本地已知的已发布时间轴分支（`meta.published`，当前不调 `fetchSharedTimeline`）也需取得角色信息：在该分支补一次轻量 `GET /:id` 以拿 `isAuthor` 等字段。

## 五、影响面

| 文件                                       | 改动                                                        |
| ------------------------------------------ | ----------------------------------------------------------- |
| `migrations/0005_create_edit_requests.sql` | 新增：开关列、editors.user_name 列、edit_requests 表        |
| `src/workers/routes/share.ts`              | 新增：6 个共享管理端点                                      |
| `src/workers/routes/timelines.ts`          | `GET /:id` 增 3 字段；挂载 share 路由                       |
| `src/workers/durable/TimelineDoc.ts`       | 新增 RPC `kickUser`                                         |
| `src/workers/index.ts` / 路由装配          | 挂载 `share.ts`                                             |
| `src/collab/RemoteConnection.ts`           | `onClose` 识别 `4001`；`ConnectionStatus` 增 `'revoked'`    |
| `src/collab/SyncEngine.ts`                 | `ConnectionStatus` 类型透传（如有显式引用）                 |
| `src/store/timelineStore.ts`               | `connectionStatus` 透传 `'revoked'`                         |
| `src/api/timelineShareApi.ts`              | 新增 6 个 API 函数；扩展 `fetchSharedTimeline` 返回类型     |
| `src/components/SharePopover.tsx`          | 重写：6 态 + `deriveShareView` 纯函数 + 两个列表            |
| `src/components/EditorToolbar.tsx`         | 恒渲染 `SharePopover`；删除独立创建副本按钮；触发按钮角色化 |
| `src/pages/EditorPage.tsx`                 | 取并下传角色字段；响应 `'revoked'` 状态                     |

**不触碰**：同步协议帧格式（`syncProtocol.ts`）、awareness、伤害计算。

## 六、验证

- **Worker（真实 D1，`*.workers.test.ts`）**：7 个端点的正常流程与权限守卫——非作者访问作者端点 403；申请开关关时 `POST edit-requests` 403；已是编辑者申请 409；通过 / 拒绝后 `timeline_edit_requests` 与 `timeline_editors` 状态正确；不可移除作者本人；`GET /:id` 新字段取值正确。
- **DO（`TimelineDoc.workers.test.ts`）**：`kickUser` 只关 `userId` 匹配的 socket、用 close code `4001`、不误伤其他连接；目标用户离线时 no-op。
- **`RemoteConnection.test.ts`**：服务端以 `4001` 关闭 → 转入终态、不重连、状态报告 `'revoked'`。
- **`deriveShareView` 纯函数**：6 态（含 2a / 2b 拆分）映射全覆盖。
- 收尾门禁：`pnpm tsc -b --noEmit`、`pnpm lint`、`pnpm test:run`、`pnpm test:workers`、`pnpm build` 全绿。
