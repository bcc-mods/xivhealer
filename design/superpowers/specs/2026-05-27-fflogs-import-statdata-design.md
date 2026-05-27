# 不支持副本导入时自动提取数值设置

> 从 FFLogs 战斗记录提取盾/治疗/暴击/血量，填入未收录副本的 `statData`

**日期**: 2026-05-27
**状态**: 设计完成，待实现
**相关**: [timeline-statdata-design](./2026-04-07-timeline-statdata-design.md)、[top100sync-median-sampling-design](./2026-03-18-top100sync-median-sampling-design.md)

## 1. 背景与问题

「数值设置」面板（`StatDataDialog`）让用户配置减伤技能的盾量/治疗量/暴击值及安全血量。这些值的读取优先级为：

```
用户覆盖值 (Timeline.statData) > 副本统计 (statistics) > 硬编码默认值 (10000 / 100000)
```

`statistics`（`EncounterStatistics`）由 `top100Sync` 定时任务从 TOP100 战斗聚合而来，只覆盖 `raidEncounters.ts` 静态表内的副本。**对未收录（暂不支持）的副本**，前端 `getEncounterStatistics` 返回 `null`，所有 placeholder 回落到硬编码默认值（盾/治疗 `10000`、血量 `100000`）——这与真实数值差距巨大，导致减伤计算严重失真。

但每一次从 FFLogs 导入的战斗记录本身就携带了该队伍的真实盾/治疗/血量事件。本设计在**导入不支持副本时**，直接从这场战斗的事件里提取这些数值，填入 `timeline.statData`，让未收录副本也能得到接近真实的计算基准。

## 2. 范围

**做**：

- 导入路由检测到该副本无聚合统计时，从本场事件提取 `shield / critShield / heal / critHeal / referenceMaxHP / tankReferenceMaxHP`，写入 `timeline.statData`。
- 把 `top100Sync` 中已有的三个原始提取器下沉为 `fflogsImporter` 的单一真源，消除重复逻辑。

**不做**：

- 不动已支持（有统计）的副本——其 `statData` 行为保持现状（留空，走 statistics placeholder）。
- 不做"已支持副本里逐技能补缺失项"的回填（范围决定：仅完全不支持时整体填充）。
- 不接 dev-only 的 `?client_import=1`（`handleClientSubmit`）路径——生产导入只走服务端路由，该路径绕过生产链路且检测信号不同（API vs KV），接入只会引入分叉。`parseStatData` 作为共享纯函数仍放 importer，未来若需接入仅几行。

## 3. 关键事实（已查证）

### 3.1 statData 的 key 语义与 FFLogs 事件对齐

`StatDataEntry.key`（见 `src/types/statData.ts`）：

- **shield / critShield**：key = `statusId`。FFLogs `absorbed` 事件的 `abilityGameID = 1000000 + statusId`，提取时减 `1000000`。
  - 例：摆脱盾 `{ type: 'shield', key: 1362 }` ↔ absorbed `abilityGameID = 1001362`。
- **heal / critHeal**：key = `heal` 事件携带的**原始 `abilityGameID`**，**不做偏移**。
  - 直接治疗：技能自身 id（如 摆脱 HoT 之外的直疗 `{ type: 'heal', key: 7388 }`）或治疗 ability id（如 PLD `{ type: 'heal', key: 3540 }`）。
  - HoT tick：FFLogs 以 `1000000 + statusId` 上报（如 `{ type: 'heal', key: 1002108 }`、`1003904`、`1001219`）。

因此 heal 必须按**原始 abilityGameID** 聚样，shield 才减偏移。

### 3.2 「不支持」的判定信号

`statistics` 持久化在 KV，键名 `statistics:encounter:{encounterId}`（`getStatisticsKVKey`）。导入路由可访问 `c.env.healerbook`（KVNamespace）。**KV 中该键缺失即视为不支持**（决定：用聚合统计是否存在判定，能覆盖"已在静态表但尚未同步统计"的副本）。`encounterID === 0`（"其他"）天然无统计 → 走提取。

### 3.3 statData 序列化往返

`Timeline.statData` 经 `serializeForServer`（`out.sd = statData`）与 `parseFromAny`（`base.statData = v2.sd`）正常往返；导入路由回传 `serializeForServer(timeline)`，前端 `parseFromAny` 还原后由 `createLocalTimeline({ statData })` 落盘。链路通畅。

### 3.4 统计口径

沿用 `top100Sync` 的 statistics 口径，**完全一致**：普通值 p50（`calculatePercentile`），暴击值 p90。血量按职业取 p50 后，非坦职业取最小写 `referenceMaxHP`、坦克职业取最小写 `tankReferenceMaxHP`（与 `getNonTankMinHP/getTankMinHP` 同口径）。

> **已知局限**：单场样本数远少于 aggregate。盾值样本来自 `absorbed`，部分消耗时 `absorbed < 真实盾值`，p50 会偏低；暴击 p90 在 <10 条样本下近似 max。此为方法学固有近似，与已支持副本口径一致，可比性优先。

## 4. 架构与组件

### 4.1 提取器下沉（去重，单一真源）

把 `src/workers/top100Sync.ts` 中的 `extractShieldData / extractHealData / extractMaxHPData` 迁移到 `src/utils/fflogsImporter.ts` 并导出，`top100Sync` 改为 import。调整点：

- **shield 提取器改为非变异**：现版本就地改写 `event.abilityGameID`（1002643→1002613）是对共享 events 数组的副作用；导入路由里 `parseStatData` 与其它解析共用同一数组，必须用局部变量做修正，不写回 event。
- **`extractMaxHPData` 改用 `playerMap` + `JOB_MAP`**（替代 `report.friendlies`）：`top100Sync.extractFightStats` 已构建 `playerMap`，调用处直接传入。保留 `actor.type` 去空格后再查 `JOB_MAP` 的既有行为。

迁移后三个函数返回 `Record<number, number[]>` / `Record<Job, number[]>`（原始样本数组），语义不变。

### 4.2 新增纯函数 `parseStatData`

`src/utils/fflogsImporter.ts`：

```ts
export function parseStatData(
  events: FFLogsEvent[],
  playerMap: Map<number, { id: number; name: string; type: string }>,
  composition: Composition
): TimelineStatData | undefined
```

流程：

1. 用阵容内所有 action 的 `statDataEntries` 构建合法 key 集合（按 type 分桶）：
   - `shieldKeys` / `critShieldKeys`：statusId 集合
   - `healKeys` / `critHealKeys`：原始 abilityGameID 集合
   - （沿用 `cleanupStatData` 的 key 收集思路：`MITIGATION_DATA.actions.filter(a => a.statDataEntries && a.jobs.some(j => jobs.has(j)))`）
2. 调下沉后的提取器得到原始样本：`shieldByAbility`（已减偏移）、`healByAbility`（原始 id）、`maxHPByJob`。
3. 逐 key 计算并**仅保留合法 key**：
   - `shieldByAbility[k] = p50`，`critShieldByAbility[k] = p90`（k ∈ shieldKeys）
   - `healByAbility[k] = p50`，`critHealByAbility[k] = p90`（k ∈ healKeys）
   - 无样本的 key 不写（保持 fallback）。
4. 血量：每职业 p50 → `referenceMaxHP = min(非坦)`、`tankReferenceMaxHP = min(坦克)`；无样本则该字段不写。
5. **空结果处理**：若四个 map 全空且两个 HP 字段均未取到，返回 `undefined`（调用方不赋值，`sd` 不落盘，行为同现状）；否则返回填充后的 `TimelineStatData`。

`parseStatData` 为纯计算、无 IO。

### 4.3 导入路由接入

`src/workers/routes/fflogs.ts` 的 `GET /import`，在构建 `timeline` 后、`return` 前：

```ts
let statData: TimelineStatData | undefined
try {
  const statsExist = await c.env.healerbook.get(getStatisticsKVKey(fight.encounterID || 0))
  if (!statsExist) {
    statData = parseStatData(eventsData.events || [], playerMap, composition)
  }
} catch (err) {
  console.error('[FFLogs Import] statData 提取失败，跳过:', err)
}
// 仅非空才挂上
const timeline: Timeline = { ...(statData ? { statData } : {}) /* 其余字段 */ }
```

- KV 读取失败 → 捕获并跳过提取（保守按已支持处理），**绝不阻断导入**。
- `getStatisticsKVKey` 从 `@/workers/top100Sync` import（无循环依赖：`top100Sync` 不引 `routes/fflogs`）。

## 5. 数据流

```
GET /import
  → getEvents → events
  → parseComposition / parseDamageEvents / parseCastEvents / parseSyncEvents（不变）
  → KV.get(statistics:encounter:{id})
        命中  → 不动 statData（已支持，走现状 placeholder）
        缺失  → parseStatData(events, playerMap, composition)
                  ├ 提取器（共享）→ 原始样本
                  ├ 按阵容 statDataEntries key 过滤 + p50/p90
                  └ 血量 min
              → 非空则 timeline.statData = 结果
  → serializeForServer(timeline)（sd 字段）
前端 parseFromAny → createLocalTimeline({ statData }) → 落盘
编辑器打开 → resolveStatData(statData, statistics=null, comp) → statData 值生效
```

## 6. 测试

- **`fflogsImporter.test.ts` 新增 `parseStatData` 单测**（合成 `FFLogsEvent[]` + `playerMap` + `composition`）：
  - shield 减偏移、heal 原始 id 聚样正确
  - p50 / p90 取值正确（构造已知分布断言）
  - **非阵容 statDataEntries 的 heal/shield 被过滤**（如普通 GCD 治疗 id 不应写入）
  - 血量：非坦/坦克分别取 min
  - 空场景返回 `undefined`
- **`top100Sync` 回归**：提取器迁移后，现有 `top100Sync.test.ts` 全绿；确认 shield 非变异改造未改变聚合结果。
- 收尾：`pnpm test:run`、`pnpm exec tsc --noEmit`、`pnpm lint`。

## 7. 风险与权衡

| 项                        | 处理                                                    |
| ------------------------- | ------------------------------------------------------- |
| 单场样本少、噪声大        | 接受；口径与已支持副本一致，可比性优先（§3.4 局限已记） |
| 盾部分消耗导致 p50 偏低   | 接受；aggregate 同样存在，属固有近似                    |
| 共享 events 被提取器变异  | shield 提取器改非变异（§4.1）                           |
| KV 读取抖动               | try/catch 跳过，不阻断导入（§4.3）                      |
| heal key 误纳入非减伤技能 | 按阵容 `statDataEntries` key 严格过滤（§4.2 step 3）    |
