# 临时减伤设计

> 在伤害详情面板的「预估减伤效果」下方新增「临时减伤」功能：编辑模式下，用户可为单个伤害事件
> 临时附加一项减伤（盾或百分比），仅对该事件生效，并参与该事件的减伤计算。

## 背景与目标

「预估减伤效果」展示一个伤害事件经真实减伤技能（Executor 产出的 status）后的最终伤害与减伤构成。
但规划时常需要快速试算一个"假设的额外减伤"——比如外团补一个盾、或评估再叠一层百分比减伤后能否压住致死线，
而不想真的去时间轴上摆一个技能。临时减伤即为此：一个挂在**单个伤害事件**上的轻量减伤项，参与该事件的
计算，但不作为 buff 进入 PartyState、不影响其它事件的减伤判定。

目标：

- 编辑模式下，在「预估减伤效果」section 下方新增「临时减伤」section。
- 标题行右侧有添加按钮；点击弹出对话框表单，填写名称、类型（盾 / 百分比）、减伤效果。
- section 内列出已添加的临时减伤：名称、减伤量、删除按钮。
- 伤害事件的最终伤害、HP 条、减伤构成条都反映临时减伤的效果。
- 临时减伤仅对所挂事件生效（不进 PartyState，不作为 buff 渗透到其它事件的减伤计算）。
- 持久化：保存到本地、随分享 / 导出（V2 格式）与协作（Yjs）同步。

非目标：

- 临时减伤**不**出现在「生效状态」图标行（百分比 / 盾 的 status 图标区）——它们有独立 section 展示。
- 临时减伤**不**产生 buff、不参与 HP 模拟里的治疗 / status 生命周期；它只是该事件减伤管线里的一次性调整。

## 数据模型

`src/types/timeline.ts` 新增：

```ts
export type TempMitigationType = 'percent' | 'shield'

export interface TempMitigation {
  /** 列表项 id（nanoid），用于 React key 与删除定位 */
  id: string
  /** 减伤名称（用户填写） */
  name: string
  /** 减伤类型 */
  type: TempMitigationType
  /**
   * 减伤效果：
   * - type='percent'：百分比数值，范围 0–100（如 20 表示 20%），内部换算倍率 (1 - value/100)
   * - type='shield'：盾量（吸收的绝对伤害值，整数 ≥ 0）
   */
  value: number
}
```

`DamageEvent` 增加可选字段：

```ts
export interface DamageEvent {
  // ...既有字段
  /** 临时减伤列表（仅对本事件生效）；存量事件无此字段 */
  tempMitigations?: TempMitigation[]
}
```

## 计算集成（`src/utils/mitigationCalculator.ts`）

临时减伤在 `runSingleBranch` 内统一处理。由于 `runSingleBranch` 对所有事件类型（aoe / partial /
死刑 / 普攻）与多坦每个分支都会调用，临时减伤天然对全部路径生效。

读取 `event.tempMitigations ?? []`，按 type 分两类：

1. **百分比**（在 Phase 1 之后、`candidateDamage` 计算之前折入倍率）：

   ```
   multiplier *= ∏ (1 - clamp(value, 0, 100) / 100)
   candidateDamage = round(originalDamage * multiplier)   // 已含临时百分比
   ```

   临时百分比**不** push 进 `appliedStatuses`（不进图标行）。

2. **盾**（在 Phase 3 真实盾扣完、得到 `damage` 之后、partial_final_aoe 阶段 B 之前/之后均可，
   只从最终 `damage` 扣，不动任何真实 status 的 `remainingBarrier`）：

   ```
   tempShieldTotal    = Σ max(0, value)
   tempShieldAbsorbed = min(damage, tempShieldTotal)
   damage            -= tempShieldAbsorbed
   ```

   临时盾**不**进 `appliedStatuses`、**不**进 `consumedShields`（不触发 onConsume）、**不**改 PartyState。

整体减伤顺序：百分比（真实 + 临时，乘算）→ 真实盾（减算）→ 临时盾（减算）。

`finalDamage = max(0, round(damage))` 因此包含全部临时减伤。`applyDamageToHp` 用这个 `finalDamage`
与 `candidateDamage` 扣 HP 池，故 HP 模拟与后续事件的剩余血量自动顺延（与"顺延影响后续"决策一致）。

### 不新增上报字段——复用 `candidateDamage`

减伤构成色块只需 `candidateDamage`（已有字段）即可正确切分，无需新增 `tempShieldAbsorbed` 之类的字段：

- 百分比减免（真实 + 临时）= `originalDamage − candidateDamage`
- 护盾减免（真实 + 临时）= `candidateDamage − finalDamage`

`candidateDamage` 在折入临时百分比后、扣临时盾之前取值，天然满足上述等式。

`candidateDamage` 已挂在单坦路径的 `CalculationResult` 上，并在 `runSingleBranch` 里逐分支算好。
唯一改动：把它一起带进 `PerTankResult`（当前 `mitigationCalculator.ts:265-273` 的 map 把它丢弃了），
供多坦分支的色块分解使用。

```ts
export interface PerTankResult {
  playerId: number
  finalDamage: number
  mitigationPercentage: number
  appliedStatuses: MitigationStatus[]
  referenceMaxHP: number
  /** 盾前伤害（含临时百分比、不含临时盾）；供减伤构成色块切分盾/百分比 */
  candidateDamage: number
}
```

## 减伤构成色块（`src/components/PropertyPanel.tsx`）

`renderMitigationBar` 的**非 partial** 路径改用 `candidateDamage` 切分盾 / 百分比，替代当前基于
`appliedStatuses[].remainingBarrier`（"挂载时盾量"）的算法：

```
total      = originalDamage
overkill   = 既有逻辑（hpSnap.overkill 或 max(0, finalDamage - maxHP)）
pctMit     = max(0, total - candidateDamage)            // 真实 + 临时百分比
shieldMit  = max(0, candidateDamage - finalDamage)      // 真实 + 临时盾
effective  = finalDamage - overkill
```

四段仍满足 `total = effective + overkill + shieldMit + pctMit`。

连带影响（已与用户确认接受）：盾**溢出覆盖**（盾量远大于实际伤害）时，旧算法把"挂载时盾量"当吸收量，
`pctMit` 被 `max(0, …)` 夹 0；新算法用"实际吸收量"（candidateDamage − finalDamage），数值更准，
与旧显示在该边界下略有差异——视作顺带修正。

partial 路径（`isPartialAoe && hpSnap`）本就由 `candidateDamage` 驱动段 delta 链（`preShieldDealt =
max(0, candidateDamage − segCandidateMaxBefore)`），临时减伤经 `candidateDamage` / `finalDamage`
自动 ride along，**不改**该分支。

`BranchViewData` 增加 `candidateDamage: number`，三处构造 BranchViewData 的地方（单坦/多坦平铺/多坦选中）
分别从 `result.candidateDamage` 或 `perVictim[i].candidateDamage` 取值传入。

## UI：临时减伤 section（新组件 `src/components/TempMitigationSection.tsx`）

`PropertyPanel.tsx` 已 800+ 行，临时减伤的 section + 对话框抽成独立组件，保持职责单一。

- **挂载位置**：PropertyPanel 中「预估减伤效果」块（`!timeline.isReplayMode && result`）内容**下方**，
  紧跟其后渲染 `<TempMitigationSection event={event} />`。
- **可见性**：仅编辑模式。组件内部用 `useEditorReadOnly()`，`isReadOnly` 时整段不渲染
  （回放模式因外层 `!timeline.isReplayMode` 已排除）。
- **结构**：
  - 标题行：`<div className="flex items-center justify-between">`，左侧 `<h3>临时减伤</h3>`，
    右侧添加按钮（lucide `Plus`，沿用 PropertyPanel 删除按钮的 hover 样式风格）。
  - 列表：每项一行——名称、减伤量、删除按钮（lucide `Trash2`）。
    - 减伤量展示：`percent` → `-{value}%`；`shield` → `盾 {value.toLocaleString()}`。
  - 空列表：muted 文案（如"暂无临时减伤"）。
- **添加对话框**：shadcn `Dialog`（`src/components/ui/dialog.tsx`），表单字段：
  - 名称：`Input`（`src/components/ui/input.tsx`），必填。
  - 类型：`Select`（既有 ui/select），选项 `盾` / `百分比`。
  - 减伤效果：`Input type="number"`。label 随类型变化（百分比 → "百分比 (%)"，盾 → "盾量"）。
  - 提交校验：名称非空；value 为有效数字；percent clamp 到 0–100，shield clamp ≥ 0。
    通过后构造 `{ id: nanoid(), name, type, value }`，调用 `onAdd`，关闭并重置表单。
- **数据写入**：组件内用 `useTimelineStore` 取 `updateDamageEvent`。
  - 添加：`updateDamageEvent(event.id, { tempMitigations: [...(event.tempMitigations ?? []), item] })`
  - 删除：`updateDamageEvent(event.id, { tempMitigations: (event.tempMitigations ?? []).filter(t => t.id !== id) })`

`nanoid` 已是项目依赖（见 `src/executors/utils.ts` 等）。

## 持久化

### Yjs 协作文档（`src/collab/docSchema.ts`）

`tempMitigations` 是普通 JS 数组，经现有通用 `entryToYMap` / `yUpdateDamageEvent` 以 JSON 值存入
Y.Map；`ymapToObject`（`Object.fromEntries(ymap.entries())`）原样 round-trip。无需新增专门 mutator。

注意：嵌套数组以不可变 JSON 快照存储（last-write-wins，非逐项 CRDT 合并）——对"单事件的简单减伤列表"
这是可接受语义。`projectCollection` 的 `shallowEqual` 按引用比较该数组，可能让带 `tempMitigations` 的
damage event 在每次投影时获得新对象身份，属可接受的渲染开销。

### V2 分享 / 导出格式（`src/utils/timelineFormat.ts` + `src/types/timelineV2.ts`）

`V2DamageEvent` 新增可选字段 `tm?`（沿用 n/t/d/ty/dt/st/pdd 的短键风格）：

```ts
// timelineV2.ts
interface V2TempMitigation {
  id: string
  n: string
  ty: 0 | 1
  v: number
} // ty: 0=percent,1=shield
interface V2DamageEvent {
  // ...既有
  tm?: V2TempMitigation[]
}
```

- `toV2DamageEvent`：`if (e.tempMitigations?.length) out.tm = e.tempMitigations.map(...)`
- `fromV2DamageEvent`：`if (e.tm?.length) out.tempMitigations = e.tm.map(...)`
- V1 迁移（`migrateV1DamageEvent`）：V1 无临时减伤，跳过。

（type 用数字编码与现有 ty/dt 风格一致；如实现时觉得 2 个枚举值直接存字符串更省心，可在 plan 阶段定，
但默认走数字编码以对齐既有约定。）

## 测试

- `src/utils/mitigationCalculator.test.ts`：
  - 临时百分比乘算正确（与真实百分比叠乘）。
  - 临时盾减算正确（真实盾扣完后再扣，clamp 不为负）。
  - 临时百分比 + 临时盾组合；`candidateDamage` 等式（original−candidate=百分比，candidate−final=盾）成立。
  - 多坦分支各自带出 `candidateDamage`。
  - 空 / 边界值（value=0、percent>100 被 clamp、shield 超过剩余伤害只吸收剩余）。
  - 临时减伤不渗透：下一事件不因临时减伤改变其自身减伤判定（仅经 HP 顺延体现）。
- `src/utils/timelineFormat.test.ts`：含 `tempMitigations` 的事件 V2 序列化→反序列化 round-trip。
- `src/collab/docSchema.test.ts`（如适用）：Yjs add/update/project round-trip 保留 `tempMitigations`。
- 组件层：`TempMitigationSection` 的添加 / 删除 / 校验（若项目有同类组件测试惯例则补，否则以上述
  数据 + 计算测试为主）。

## 涉及文件清单

| 文件                                       | 改动                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/timeline.ts`                    | 新增 `TempMitigation` / `TempMitigationType`；`DamageEvent.tempMitigations?`                                                    |
| `src/utils/mitigationCalculator.ts`        | `runSingleBranch` 折入临时减伤；`PerTankResult` 带出 `candidateDamage`                                                          |
| `src/components/PropertyPanel.tsx`         | 渲染 `TempMitigationSection`；`renderMitigationBar` 非 partial 改用 candidateDamage 切分；`BranchViewData` 加 `candidateDamage` |
| `src/components/TempMitigationSection.tsx` | 新建：section + 添加对话框 + 增删逻辑                                                                                           |
| `src/types/timelineV2.ts`                  | `V2DamageEvent.tm?` + `V2TempMitigation`                                                                                        |
| `src/utils/timelineFormat.ts`              | `toV2DamageEvent` / `fromV2DamageEvent` 编解码 `tm`                                                                             |
| 对应 `*.test.ts`                           | 计算 / 序列化 / 协作 round-trip 测试                                                                                            |
