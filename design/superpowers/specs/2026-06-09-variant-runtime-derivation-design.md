# 变体运行时派生(去持久化)+ 存量清理 设计

> 状态:设计已确认,待写实现 plan
> 日期:2026-06-09

## 1. 背景与根因

### 现象

一个协作时间轴文档(`OdOsCAHG5r7OQAmuGV2Ys`,作者 redlate)在 DO 端反复触发 `SQLITE_TOOBIG`(单 BLOB/行 2MB 上限)。诊断发现:

- 文档 ~1.8MB,但**活内容近乎为零**(150 个 cast,真实数据约 12KB);
- 19 万个 Yjs struct,**99% 是删除墓碑**;
- 墓碑几乎全部集中在 **6 个 cast** 上:它们的 `actionId` 字段各被改写约 **3.3 万次**(playerId=6 学者,在 `37013 意气轩昂之策 ↔ 37016 降临之章` 之间反复横跳)。

### 根因

`37013`/`37016` 是同一技能的两个**变身形态**,由「炽天附体 / Seraphism」buff 是否在场互斥决定(`placement: not(whileStatus(SERAPHISM))` vs `whileStatus(SERAPHISM)`)。

`EditorPage.tsx:272-297` 有一个 `useEffect`,依赖**异步 stale-while-revalidate 的计算结果** `calculationResults.statusTimelineByPlayer`,自动把"当前不合法"的 cast 的 `actionId` 重映射到合法变体并**持久化写入** Yjs doc。

- worker 内的减伤计算本身是确定性纯函数;
- 但不同客户端在不同时机拿到不同的 stale `statusTimelineByPlayer`,对同一簇 cast 推导出**相反**的变体(一端 37013、一端 37016),各自 `updateCastEvent` 写入;
- CRDT 忠实合并两端对立的写入 → 无限往返对冲,每次一个墓碑。

通过 `inspect-ydoc.cjs actionedits` 已坐实:client `17922637` 持续写 37013、client `2930038177` 持续写 37016,针对 player=6 的同一簇 cast(t≈301/322)。

**本质:把"确定性派生量(变体)"做成了"持久化数据 + 后台 effect 维护",且维护发生在各端时序不同的异步状态上。**

### Yjs GC 的局限(已上线的缓解)

已上线 `squash` 时对 merged doc 做 GC 重编码(commit `95ae3db`):GC 能清掉墓碑的 **content**,但**清不掉 struct 头本身**(每个 ~9.5 字节 × 19 万 ≈ 1.8MB)。所以 GC 只是把 2.37MB 压到 1.67MB,治标不治本。真正根治需要:① 不再产生墓碑(本设计阶段 1);② 清掉存量 struct(阶段 2 rebuild)。

## 2. 目标

1. **结构性消除变体对冲**:不再有任何代码持久化写入"具体变体 actionId"——没有写,就没有 CRDT 冲突。
2. **变体始终自动反映规划的 buff 状态**(产品语义 A:自动跟随),由 simulate 因果推导,两端一致。
3. **清掉存量墓碑**:让已膨胀文档体积回落到活内容量级。
4. 不引入新的存储格式/版本号;旧数据自动兼容。

## 3. 设计

### ① 数据模型:actionId 只存逻辑技能(父 id)

- `castEvent.actionId` 语义改为 **trackGroup 父 id(逻辑技能)**,子变体永不持久化。
- **读取归一**(单点收口):新增 `normalizeActionId(id): number`,查 action 注册表返回 `trackGroup ?? id`。在以下入口统一归一:
  - `parseFromAny` / `projectTimeline`(所有 doc → 内存的入口)
  - `fflogsImporter` 解析(导入即归一)
- **写入只写父 id**:`addCastAt`、`handleCastEventDragEnd`、`TimelineTable.handleCellToggle`、`executeAction`、粘贴校验,统一写父 id;拖拽只改 `timestamp`。
- **序列化不变**:V2(`timelineFormat.ts`)/ clipboard 仍存 `actionId` 数字,只是值变成父 id;**不升版本号**,归一在读取层兜底旧值(旧文档存的 37016 读入即归一为 37013)。

### ② 变体推导:simulate 单点权威

- 新增纯函数 `resolveVariant(parentAction, playerId, t, statusAt) → MitigationAction`:
  - 取 trackGroup members,沿用 `canPlaceCastEvent` / `pickUniqueMember`「恰好一个合法成员」语义;
  - **0 个或 ≥2 个合法时返回父 action 本身**(歧义/非法,交给现有红框提示)。
- `mitigationCalculator.processCast`:按时间顺序处理 cast 时,**它之前的 buff 状态已累积好**;若该 cast 的父 id 有 ≥2 个 members,用此刻状态推导具体变体 → 执行该变体的 executor → 记录 `castId → resolvedActionId`。
  - 因果性保证无循环、无 stale:变体只依赖「之前别的 cast 产生的 buff」,而非自身。
- 计算输出新增 `resolvedVariantByCastId: Map<string, number>`,挂到 DamageCalculation context。

### ③ 消费者改读映射

- 渲染:`SkillTracksCanvas`、`CastEventIcon`、`castWindow` 的变体图标/悬浮窗,显示按 `resolvedVariantByCastId[castId] ?? actionId`。
- 导出:`soumaExporter` 变体名按映射。
- 计算/资源(`mitigationCalculator`、`resource/compute`):已在 simulate 内用推导变体,天然一致。
- 归轨/分组/过滤(已走 `trackGroup ?? id`):无需改。

### ④ 删除对冲源

- **删除 `EditorPage.tsx:272-297` 的自动重映射 effect**。
- `addCastAt` / `handleCastEventDragEnd` / `TimelineTable.handleCellToggle` 移除 `pickUniqueMember` 写变体逻辑(改写父 id;变体交给 simulate 推导)。
- `engine.pickUniqueMember` / `canPlaceCastEvent` 保留供 `resolveVariant` 复用;不再有"写回 doc"的调用方。

### ⑤ 存量清理:rebuild compaction(独立阶段)

- DO 端逻辑:`projectTimeline` 取活内容 → `buildYDoc` 构造**全新 Y.Doc**(actionId 已归一为父 id)→ 替换 snapshot、清空 updates → 用 4001-类 close code 踢掉所有在线连接,强制重连重新 LOAD 新状态。
- 全新 doc 的 client/clock 从零开始,墓碑与旧 client 碎片全部消失,体积回落到活内容量级。
- **触发**:先做成**手动 internal route**(对指定 timelineId 跑一次,先救卡死文档);自动阈值触发(struct 数/字节超限)留待后续(YAGNI)。

## 4. 影响面清单(关键文件)

**必须改 — 写入点(去变体写入)**

- `src/pages/EditorPage.tsx:272-297` — 删除 effect
- `src/components/Timeline/index.tsx` — `addCastAt`(~930)、`handleCastEventDragEnd`(~1104)
- `src/components/TimelineTable/index.tsx` — `handleCellToggle`(~139-190)
- `src/utils/timelineClipboard.ts` — 粘贴校验(~110)

**必须改 — 归一**

- `src/utils/timelineFormat.ts`(`parseFromAny`)、`src/collab/docSchema.ts`(`projectTimeline`)
- `src/utils/fflogsImporter.ts`(~625,导入归一;改对应测试)

**必须改 — 推导与消费**

- `src/utils/mitigationCalculator.ts`(~784-806,processCast 推导变体 + 输出映射)
- `src/utils/resource/compute.ts`(~75,用推导变体)
- 新增 `resolveVariant`(放 `src/utils/placement/` 或 calculator 邻近)
- `src/contexts/DamageCalculation*` / `src/hooks/useDamageCalculation.ts`(透出 `resolvedVariantByCastId`)
- 渲染:`SkillTracksCanvas.tsx`、`CastEventIcon.tsx`、`castWindow.ts`
- 导出:`soumaExporter.ts`

**新增 — 工具**

- `normalizeActionId(id)`(基于 action 注册表)

**阶段 2 — DO**

- `src/workers/collab/doSqlStore.ts` / `src/workers/durable/TimelineDoc.ts`(rebuild 入口)
- internal route(手动触发,沿用 `internalDiag.ts` 风格)

**无需改(已走 trackGroup)**

- 归轨:`SkillTracksCanvas.tsx:561-564`、`Timeline/index.tsx:1558-1559`、`castWindow.ts:22-23`
- 过滤/分组:`useFilteredTimelineView.ts`、`skillTracks.ts`、`mitigationStore.ts`

## 5. 测试

- `resolveVariant` 纯函数:6 个 trackGroup × buff 在/不在/歧义 fallback。
- simulate 输出 `resolvedVariantByCastId` 正确(炽天附体在→37016、不在→37013)。
- 归一:`parseFromAny` / import 把子变体 id 归父 id(改 `fflogsImporter` 那条"保留 37016"的测试为"归一为父 id")。
- 回归:删 effect 后无变体写入(断言多次 simulate 不产生 doc update);双端模拟不再产生 actionId update。
- 计算数值不回归:37013/37016 的盾值/治疗量在对应 buff 状态下与改前一致。
- 阶段 2:rebuild 后体积骤降、活内容(projectTimeline)前后一致、updates 清空。

## 6. 实现阶段与风险

- **阶段 1(治本止血)**:① ② ③ ④ —— 去持久化、消除对冲。可独立交付。
- **阶段 2(清存量)**:⑤ rebuild compaction(手动 route)。独立交付,先救卡死文档。

**风险/打磨**

- 拖拽时变体图标即时反馈:现在靠计算异步回来后刷新,可能有一帧延迟。若手感不可接受,渲染层用 context 现有 `statusTimelineByPlayer` 做一次本地快速推导兜底(打磨项,后续)。
- 歧义/非法(0 或 ≥2 合法):fallback 回父 id + 现有红框提示,不自动写。
- 渲染 stale:计算未回来时按父 id 显示,回来后刷新;不写 doc,无害。

## 7. 附:诊断工具

`scripts/inspect-ydoc.cjs`(已沉淀)——`overview` / `update` / `cast` / `actionedits` 四个子命令,用于 Yjs 文档体积、墓碑、抖动定位与 actionId 修改溯源。
