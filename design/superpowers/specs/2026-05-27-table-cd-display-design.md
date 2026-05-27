# 表格视图补充冷却（CD）显示

> 对应 issue #4。让表格视图与时间轴视图在 CD 信息上对齐：同一语义、同一数据来源。

## 背景

表格视图（`src/components/TimelineTable/`）当前每个技能列只显示两类信息：

- **绿底**：duration 覆盖区间（`computeLitCellsByEvent`）
- **cast 起点图标**（`computeCastMarkerCells`）

而时间轴视图（Canvas）在绿条之后还画一段**蓝色 CD 条**，表示「这次 cast 把资源池打空、直到恢复的时段」。两种视图信息不一致，排轴细调时表格难以判断技能是否还在冷却，只能靠点击确认。

## 目标

在表格视图为每个技能列补充 CD 显示，**复用时间轴的同一数据来源与同一语义**，所有编辑模式（local / author / view）一律展示。

## 数据来源（与时间轴同源）

时间轴蓝条右端的唯一可信源是 `PlacementEngine.cdBarEndFor(castEventId)`：

- `null` → 此 cast 不画 CD（无消费者，或资源池未被打空）
- `Infinity` → CD 延伸到时间轴末尾
- 数值 → CD 区间右端的秒数

`PlacementEngine` 已在 `TimelineTable/index.tsx` 中构造（用于单元格放置 / 变体选择），直接复用其 `cdBarEndFor`，无需新建引擎或新数据通路。

每个 cast 的 CD 区间定义为 `[greenEnd, rawEnd)`：

- `greenEnd = cast.timestamp + action.duration` —— 与表格现有绿格判定（`computeLitCellsByEvent`）**同一基准**，保证表格内绿 / 蓝衔接无缝、不重叠。
- `rawEnd = cdBarEndFor(ce.id)`（`Infinity` 表示延伸到时间轴末）。

> **关于 greenEnd 基准的说明**：Canvas 的 `greenEnd` 取 simulate 的 `castEffectiveEnd`（buff 实际存活区间），而表格绿格历来用 `action.duration`。这是表格**既有**的选择。本设计让蓝条起点对齐表格自己的绿格末端，不引入新的不一致；不去改表格绿格的基准（超出本 issue 范围）。

## 离散映射

表格是「行 = 伤害事件、列 = 技能轨道」的离散网格，没有连续时间轴。现有 `computeLitCellsByEvent` 已把连续覆盖区间映射成「某伤害事件时刻落在某 cast 窗口内 → 该格亮起」。CD 显示照搬此套路。

新增 `computeCdCellsByEvent` 于 `src/utils/castWindow.ts`，与 `computeLitCellsByEvent` 并列：

```
computeCdCellsByEvent(
  damageEvents,
  castEvents,
  actionsById,
  cdBarEndFor: (castEventId: string) => number | null
): Map<string, Set<string>>   // Map<damageEventId, Set<cellKey>>
```

逻辑：

1. 遍历每个 `castEvent`：
   - `rawEnd = cdBarEndFor(ce.id)`；`null` → 跳过。
   - `action = actionsById.get(ce.actionId)`；缺失 → 跳过。
   - `greenEnd = ce.timestamp + action.duration`。
   - `cdEnd = rawEnd === Infinity ? Infinity : rawEnd`。
2. 对每个满足 `greenEnd <= event.time < cdEnd` 的伤害事件，按 `castCellKey(ce, actionsById)`（按 `trackGroup` 归类，与绿格 / marker 完全一致，变体如 37016 归到 parent 37013 列）加入该事件的 cell 集合。
3. 返回 `Map<damageEventId, Set<cellKey>>`。

`Infinity` 天然无需 maxTime 钳制：`event.time < Infinity` 恒真，所有后续行都计入 CD。

## 渲染（`TableDataRow.tsx`）

新增 prop `cdCells: Set<string>`。在每个技能格内，绿底层旁追加一层蓝底层，**绿优先于蓝**（同格若既绿又蓝，只显绿——与时间轴「绿条压蓝条」一致；理论上二者区间不相交，此优先级仅作防御）：

```tsx
{
  isLit && <div className="absolute inset-0 bg-emerald-500/30" />
}
{
  !isLit && cdCells.has(key) && <div className="absolute inset-0 bg-blue-500/15" />
}
```

配色与时间轴对齐：绿 `#10b981`(emerald-500)、蓝 `#3b82f6`(blue-500)。蓝底透明度（`/15`）取得比绿底（`/30`）更淡，弱化为次要信息，确保 marker 图标与底色叠加后仍可读。marker `<img>` 的 z 序在底色 `div` 之上，不受影响。

## 接线（`TimelineTable/index.tsx`）

新增 `cdCellsByEvent` useMemo：

```ts
const cdCellsByEvent = useMemo(() => {
  if (!timeline || !engine) return new Map<string, Set<string>>()
  return computeCdCellsByEvent(
    filteredDamageEvents,
    filteredCastEvents,
    actionsById,
    engine.cdBarEndFor
  )
}, [timeline, engine, filteredDamageEvents, filteredCastEvents, actionsById])
```

向 `TableDataRow` 传 `cdCells={cdCellsByEvent.get(row.id) ?? new Set()}`。

不区分编辑模式，所有模式（local / author / view）一律显示，达成信息对齐。

## 测试

在 `src/utils/castWindow.test.ts` 补 `computeCdCellsByEvent` 用例：

- **基本区间映射**：`greenEnd <= t < rawEnd` 的伤害事件被标记，区间外不标。
- **`null` 不画**：`cdBarEndFor` 返回 `null` 时该 cast 不产生任何 CD 格。
- **`Infinity` 延伸到末尾**：所有 `t >= greenEnd` 的后续行都计入。
- **绿 / 蓝衔接边界**：`t === greenEnd` 当刻归蓝（不归绿），`t === rawEnd` 当刻不归蓝（左闭右开）。
- **trackGroup 变体归列**：变体 cast（挂在 parent 轨道）的 CD 归到 parent 列的 cellKey。

## 影响范围

| 文件                                            | 改动                                 |
| ----------------------------------------------- | ------------------------------------ |
| `src/utils/castWindow.ts`                       | 新增 `computeCdCellsByEvent`         |
| `src/utils/castWindow.test.ts`                  | 新增上述用例                         |
| `src/components/TimelineTable/TableDataRow.tsx` | 新增 `cdCells` prop + 蓝底渲染       |
| `src/components/TimelineTable/index.tsx`        | 新增 `cdCellsByEvent` useMemo + 传参 |

无新依赖、不改 Canvas、不改资源模型、不改 `cdBarEndFor` 本身。

## 非目标（YAGNI）

- 不在表格显示 CD 剩余秒数文本（时间轴蓝条末端有文本，但表格离散网格无合适落点；本 issue 只要求「能看出是否在冷却」）。
- 不统一表格绿格与 Canvas 绿条的 `greenEnd` 基准（`duration` vs `castEffectiveEnd`），属既有差异、超出范围。
- 不为 CD 格添加交互（点击行为维持现状：CD 格视作空白格，沿用 `handleCellToggle` 的放置 / 拒绝逻辑）。

---

# 追加：斜纹「不可放置」阴影（第二阶段）

> 把时间轴的斜纹「不可放置」阴影按相同逻辑搬到表格，与 CD 显示并列。

## 背景

时间轴除蓝色 CD 条外，编辑模式下还画一层**灰色斜纹阴影**，标记「此处不能放置该技能」的区间（CD 冲突前向窗口 + placement 非法区）。表格视图缺这层信息，排轴时同样难判断某格能否落子。

## 目标

为表格每个技能列补充斜纹阴影，**复用时间轴同一数据来源与同一逻辑**，与 Canvas 行为对齐：仅编辑模式显示；斜纹只在非绿非蓝格出现。

## 数据来源（逐轨，与时间轴同源）

阴影是**逐轨**（per trackGroup）计算，不是逐 cast。对每个技能列 `track`（`playerId` + `trackGroup`），照搬 Canvas 的分支（见 `SkillTracksCanvas.tsx:255-268`）：

- `parent.cooldown <= 3 && !parent.placement` → 不画（纯 CD 冲突窗口对 GCD 级技能是噪音）
- `parent.cooldown <= 3`（有 placement）→ `engine.computePlacementShadow(groupId, playerId)`（只画 placement 非法区）
- 否则 → `engine.computeTrackShadow(groupId, playerId)`（完整阴影，含前向 CD 提示）

`groupId = effectiveTrackGroup(parent)`（`src/types/mitigation.ts`）。表格无拖拽，`excludeCastEventId` 传 `undefined`。`engine`（`PlacementEngine`）表格已构造，提供 `computeTrackShadow` / `computePlacementShadow`，返回 `Interval[]`（`{ from, to }`，`src/utils/placement/types.ts`）。

## 离散映射

`src/utils/castWindow.ts` 新增 `computeShadowCellsByEvent`，与 lit/cd 并列，但驱动源是 `skillTracks`（`SkillTrack[]`）而非 castEvents：

```
computeShadowCellsByEvent(
  damageEvents: DamageEvent[],
  skillTracks: SkillTrack[],
  shadowIntervalsForTrack: (track: SkillTrack) => Interval[]
): Map<string, Set<string>>   // Map<damageEventId, Set<cellKey>>
```

逻辑：先为每个伤害事件预置空 Set；对每个 track 取 `intervals = shadowIntervalsForTrack(track)`，命中 `from <= event.time < to`（左闭右开，与 cd 一致）的事件按 `cellKey(track.playerId, track.actionId)` 加入。

**分支逻辑（cd<=3 / placement）放在 `index.tsx` 构造 `shadowIntervalsForTrack` 回调里**（封装 engine 调用 + `effectiveTrackGroup`），纯函数只做区间→单元格映射，便于单测且不耦合 engine。

> `track.actionId` 即列的 trackGroup id，与 lit/cd 渲染时 `cellKey(track.playerId, track.actionId)` 同 key，无需再过 `effectiveTrackGroup`。

## 绿/蓝/斜纹优先级

不在函数内做区间相减；沿用现有「绿压蓝」同款渲染优先级，在 `TableDataRow` 内三层互斥：

```tsx
{isLit && <绿底 bg-emerald-500/30>}
{!isLit && cdCells.has(key) && <蓝底 bg-blue-500/15>}
{!isLit && !cdCells.has(key) && shadowCells.has(key) && <斜纹>}
```

即 **绿 > 蓝 > 斜纹**，斜纹只在非绿非蓝格出现——等价于 Canvas「从 raw shadow 减掉绿+蓝可见条」（`subtractIntervals`）的视觉结果，但更简单，无需区间运算。

## 斜纹样式

`<td>` 内一层 `pointer-events-none absolute inset-0`，用 `repeating-linear-gradient(45deg, ...)` 画灰色斜纹，周期 7px（5px 透明 + 2px 线），配色对齐 Canvas `cooldownStripe`：

- 亮色：`rgba(120, 120, 120, 0.22)`
- 暗色（`dark:`）：`rgba(160, 160, 160, 0.25)`

## 接线 + 门控

`index.tsx` 新增 `shadowCellsByEvent` useMemo：仅当 `!isReadOnly && engine && timeline` 才计算，否则返回空 Map（仅编辑模式显示，与 Canvas `!isReadOnly` 对齐）。依赖数组 `[timeline, engine, isReadOnly, filteredDamageEvents, skillTracks, actionsById]`。`isReadOnly` 来自已有的 `useEditorReadOnly()`。向 `TableDataRow` 传 `shadowCells={shadowCellsByEvent.get(row.id) ?? new Set()}`。

## 测试

`src/utils/castWindow.test.ts` 补 `computeShadowCellsByEvent` 用例：基本区间映射、`[from, to)` 边界（左闭右开）、单轨多区间、空区间（回调返回 `[]`）、逐轨 keying（不同 track 独立）、每事件都有 Set（可能为空）。

## 影响范围（第二阶段）

| 文件                                            | 改动                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `src/utils/castWindow.ts`                       | 新增 `computeShadowCellsByEvent`                                          |
| `src/utils/castWindow.test.ts`                  | 新增上述用例                                                              |
| `src/components/TimelineTable/TableDataRow.tsx` | 新增 `shadowCells` prop + 斜纹层                                          |
| `src/components/TimelineTable/index.tsx`        | 新增 `shadowCellsByEvent` useMemo + `shadowIntervalsForTrack` 回调 + 传参 |

复用 Canvas 同款 `effectiveTrackGroup` 与分支逻辑，不改 Canvas、不改 engine、不改资源模型。

## 非目标（第二阶段）

- 不在表格做 `subtractIntervals` 区间相减（用渲染优先级替代）。
- 不支持拖拽态的 shadow 重算（表格无拖拽，`excludeCastEventId` 恒 `undefined`）。
- 不改 Canvas 既有阴影逻辑。
