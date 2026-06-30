# 伤害事件读条时间基准与卡片化渲染 设计

> 分支 `feat/damage-casting` · 2026-06-30

## 1. 目标

给伤害事件（`DamageEvent`）引入两个新的时间基准 —— **读条开始时间** 与 **读条结束时间** —— 现有的 `time` 字段语义保持为**伤害判定时间**。并据此改造时间轴视图中伤害事件的渲染：

- 伤害事件渲染为一张**宽度从读条开始到读条结束**的卡片；
- **伤害判定时间**用一个**菱形**画在卡片下沿；
- **无读条**的事件：卡片左缘 = 判定时间（即维持现状渲染）；
- 卡片有**最小宽度**，且**伤害判定时间始终落在卡片内部**。

## 2. 数据模型

`src/types/timeline.ts` 的 `DamageEvent` 新增两个可选字段（秒，与 `time`/`snapshotTime` 同口径）：

```ts
castStartTime?: number  // 读条开始时间（秒）
castEndTime?: number    // 读条结束时间（秒）
```

**both-or-neither 不变式**：两字段始终成对存在或成对缺失。导入 / 手动添加 / 拖动三条写入路径都必须维持这一点。消费侧统一判定：

```ts
const hasCast = ev.castStartTime != null && ev.castEndTime != null
```

存量数据这两字段为 `undefined` → 自动按"无读条"处理，向后兼容。

## 3. 序列化与持久化

| 层         | 文件                                                  | 改动                                                                                                  |
| ---------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| V2 短键    | `src/types/timelineV2.ts` `V2DamageEvent`             | 新增 `cs`（castStartTime）、`ce`（castEndTime）                                                       |
| 序列化     | `src/utils/timelineFormat.ts`                         | `toV2DamageEvent` / `fromV2DamageEvent` / `migrateV1DamageEvent` 各加成对透传（可选，缺省 undefined） |
| 服务端校验 | `src/workers/timelineSchema.ts` `V2DamageEventSchema` | 加 `cs: v.optional(v.number())`、`ce: v.optional(v.number())`，否则云端校验丢字段                     |
| Yjs 协同   | `src/collab/docSchema.ts`                             | **无需改动**：`entryToYMap` / `projectCollection` 已通用处理任意字段                                  |

## 4. FFLogs 导入：读条窗口匹配

### 4.1 实测依据（report `YXaZBnjR1HJvG6Nq` fight 16）

- 正常完成的读条 = `begincast` + `cast` **成对**：
  - `47877`：begincast @711.59s（`duration=4700`）→ cast @716.59s（含 `packetID`）。
  - `cast` 时间（716.59s）比 `begincast+duration`（716.29s）略晚，含服务端延迟 → **读条结束取 `cast` 事件时间更准**。
- 被中断的读条 = **只有 `begincast`，没有 `cast`**：
  - `50718`：begincast @728.23s（`duration=9700`），无对应 cast。
  - **没有任何独立的 `interrupt` 事件**；"中断"与"还没读完"在事件流中无法区分，都表现为"有 begincast 无 cast"。
- `duration` 字段**只在 `begincast` 上**，`cast` 上没有。

### 4.2 取数与去重盘点

`parseDamageEvents`（`src/utils/fflogsImporter.ts:219`）已直接接收完整 `events`，且其后处理流水线（`:504-515`）是"对小数组 `damageEvents` 链式跑 `refine*` 函数"的成熟范式。`events` 在整个 `parseFightImport` 中已被扫 6+ 趟。

**不做全局单趟合并重构**（顺序依赖：`fightStartTime` 须先行、`absorbed` 须在 detail 建好后匹配；合并会产生上帝循环、破坏各 `parse*`/`refine*` 的独立可测性；导入是一次性异步操作，省遍历属过早优化）。

`parseCastEvents`（`:700`）只处理**玩家减伤技能的 cast**，与 boss 读条不重叠，保持不动。boss 读条仅与 `parseSyncEvents`（`:749`）重叠。

### 4.3 新增两个隔离函数

**`extractBossCasts(events, playerMap): FFLogsEvent[]`** —— 一趟，产出按时间升序的 boss/NPC `begincast`/`cast`（`sourceID` 命中 `playerMap` 的玩家施法排除）。

**`attachCastWindows(damageEvents, bossCasts, fightStartTime)`** —— 挂到 `parseDamageEvents` 后处理流水线末尾，与 `refine*` 同构。

接线（`parseFightImport`）：`extractBossCasts` 抽一次，传入 `parseDamageEvents`（新增末位可选参数）；`parseSyncEvents` 保持不动。净增遍历 = 1 趟。

### 4.4 配对算法（按 `(sourceID, abilityGameID)` 分流）

```ts
function buildCastPairs(bossCasts): Map<number /*abilityGameID*/, { startMs; endMs }[]> {
  const pairs = new Map()
  const pending = new Map() // key: `${sourceID}:${abilityGameID}` → {startMs, durationMs}
  for (const ev of bossCasts) {
    // 时间升序
    const id = ev.abilityGameID
    const pk = `${ev.sourceID ?? 0}:${id}`
    if (ev.type === 'begincast') {
      pending.set(pk, { startMs: ev.timestamp, durationMs: ev.duration ?? 0 }) // 新读条覆盖被打断的旧 pending
    } else {
      // 'cast'
      const begin = pending.get(pk)
      if (begin === undefined) continue // 瞬发（无 pending）→ 不配对
      pending.delete(pk)
      // duration 合理性校验：堵死"中断悬挂 begincast 被之后瞬发 cast 误消费"的脏窗口
      if (begin.durationMs && ev.timestamp - begin.startMs > begin.durationMs * 1.5 + 1000) continue
      if (!pairs.has(id)) pairs.set(id, [])
      pairs.get(id).push({ startMs: begin.startMs, endMs: ev.timestamp })
    }
  }
  for (const arr of pairs.values()) arr.sort((a, b) => a.endMs - b.endMs)
  return pairs
}
```

**多 boss 同技能**：按 `(sourceID, abilityGameID)` 分流，双子 boss 同时读同一条 X 会正确产出两对，无丢失无跨 boss 错配。
**中断**：无 cast 的 begincast 永远悬挂、不产对 → 不挂窗口。
**中断+瞬发误配**：duration 合理性校验丢弃。

### 4.5 查询回填

```ts
function attachCastWindows(damageEvents, bossCasts, fightStartTime) {
  const pairs = buildCastPairs(bossCasts)
  const toSec = ms => Math.round((ms - fightStartTime) / 10) / 100 // 与 :445 同口径
  for (const ev of damageEvents) {
    const details = ev.playerDamageDetails
    if (!details?.length) continue // 手动事件无 details → 跳过，保持 undefined
    let td = Infinity,
      abilityId = 0
    for (const d of details)
      if (d.timestamp < td) {
        td = d.timestamp
        abilityId = d.abilityId ?? 0
      }
    const list = pairs.get(abilityId)
    if (!list) continue
    let hit = null
    for (let k = list.length - 1; k >= 0; k--)
      if (list[k].endMs <= td) {
        hit = list[k]
        break
      }
    if (!hit) continue
    ev.castStartTime = toSec(hit.startMs) // both-or-neither：成对写
    ev.castEndTime = toSec(hit.endMs)
  }
}
```

- 技能 id 与判定毫秒从事件自身 `playerDamageDetails` 取（与聚合 `relativeTime` 基准一致）。
- 伤害技能 id ≠ 读条技能 id（DOT/延迟）→ 查不到 → 无读条（符合既定决策）。
- 查询只按 `abilityGameID` + 时间，不需要把 boss `sourceID` 泄漏进 `DamageEvent`：两次伤害若拆成两个 event，各取 `endMs ≤ td` 最近一对天然命中本方；若聚合成一个 event，多 boss 窗口几乎重合，取最近一对视觉等价。

## 5. 渲染

### 5.1 坐标系（关键决定）

**Group 原点保持 = 判定时间**（`x = event.time * zoomLevel` 不变），靠 **Rect 局部 x 变负**向左延伸。这样判定虚线（`DamageEventTrack:131`）、拖拽链（`handleEventDragEnd` 直接 `x/zoom`）、视口裁剪等所有"用 `event.time*zoom`"的逻辑无需改语义。

```
hasCast   = castStartTime != null && castEndTime != null
rawLeft   = hasCast ? min(castStartTime, time) : time
rawRight  = hasCast ? max(castEndTime,   time) : time
leftLocal = (rawLeft - time) * zoomLevel            // ≤ 0
width     = max((rawRight - rawLeft) * zoomLevel, MIN_CARD_WIDTH)
Rect:  x = leftLocal, width = width
菱形:  局部 x = 0（= 判定时间，group 原点）
```

判定菱形在局部 0，而 `leftLocal ≤ 0 ≤ rawRight 对应局部 ≤ leftLocal+width` → **判定点必落卡片内**，最小宽度约束自动成立。无读条时 `leftLocal=0`、`width=MIN` → 与现状像素级一致。

### 5.2 卡片内文字（`DamageEventCard.tsx`）

现有写死的 `150` 改为相对**实际矩形左右缘**定位：

- 技能名起点 `x = leftLocal + nameXOffset`，名字区域宽随 `width` 收缩；
- 伤害数值右对齐到 `x = leftLocal + width - damageTextWidth`；
- 死亡/警示 emoji 起点 `+ leftLocal`。

文字随矩形左右缘贴合，无论向左延伸多少。

### 5.3 菱形（判定标记）

- 形状：`<RegularPolygon sides={4}>`（或等价 `<Line closed>`），约 10px 对角，骑在卡片下沿（中心落 `cardBottom`）。
- 颜色：**统一红** `#ef4444` 实心（与判定虚线同色系、不透明），描边 `colors.cardBg` 增对比。
- **始终可见**（判定指示），单选可拖时描边转蓝 `#3b82f6` 提示可拖。

### 5.4 最小宽度

`MIN_CARD_WIDTH = 150`，抽成 `src/components/Timeline/constants.ts` 具名常量，统一 card / track / lane 三处现有 `150` 魔数。保持 150 → 无读条事件零回归、文字可读性不降。

## 6. 交互

### 6.1 拖卡片本体（整体平移）

`handleEventDragEnd`（`index.tsx:1061`）与 `bulkMoveSelection`：从只写 `{time}` 改为 `time` / `castStartTime` / `castEndTime` 同步 `+delta`。`snapshotTime` **维持现状不随拖动平移**（既有行为，不扩范围）。

### 6.2 拖菱形（仅移判定时间）

- 菱形设为独立 `draggable`，`dragBoundFunc` 锁 y（贴卡片下沿）只放开 x。
- **仅在单选该事件时可拖**（`isSelected && 选中总数==1 && !isReadOnly`）；**多选状态下菱形不可选中、不可操作**。多选整体平移走 6.1。
- 拖动读 `group.x() + 菱形局部x` 反算新判定时间，落点 `updateDamageEvent({ time })`；commit 后 group 原点重定位、菱形局部 x 归 0。判定点超出读条窗口时 5.1 几何自动把卡片撑大。
- `onDragMove` 复用 `reportDamageDrag`（kind `'damage'`）上报，使判定虚线实时跟随。

## 7. 视口裁剪与泳道

- **视口裁剪**（`DamageEventTrack:194`）：改用 `leftLocal`（=`min(castStart,time)*zoom`）与实际 `width` 判可见，避免长读条卡片在边缘被误裁。
- **泳道重叠**（`index.tsx:390,408`）：`CARD_WIDTH_SECONDS` 固定值改为每事件实际占用区间 `[rawLeft, rawLeft + max(naturalSec, MIN/zoom)]`；贪心排序键从 `time` 改为 `rawLeft`。

## 8. 手动添加（`AddEventDialog`）

新增「读条开始时间(秒)」+「读条时长(秒)」两个可选输入。**both-or-neither**：仅当开始有值且时长 > 0 时写 `castStartTime = 开始`、`castEndTime = 开始 + 时长`；否则不写（无读条）。

## 9. 测试

- `src/utils/fflogsImporter.test.ts`：`buildCastPairs` / `attachCastWindows` 配对与边界 —— 正常成对、瞬发（仅 cast）、中断（仅 begincast）、中断+瞬发误配（duration 校验）、多 boss 同技能、伤害 id≠读条 id、手动事件无 details。
- `src/utils/timelineFormat` 序列化与 V1→V2 迁移：`cs`/`ce` 成对透传、缺省兼容。
- `src/workers/timelineSchema.test.ts`：`cs`/`ce` 通过校验。
- `src/workers/fflogsImportHandler.test.ts`：服务端导入路径回归。

## 10. 不做 / 范围外

- 不重构导入的多趟 events 扫描（见 4.2）。
- 不改 `snapshotTime` 的拖动行为。
- 不把 boss `sourceID` 引入 `DamageEvent` 模型。
- `scripts/fetch-events.ts` 引用已删除的 `findFirstDamageTimestamp`（现状 `pnpm tsx` 会报错）—— 记录为独立待修项，本 feature 不处理。
