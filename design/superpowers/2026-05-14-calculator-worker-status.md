# Calculator Web Worker 化 — 状态恢复文档

- **日期**：2026-05-14
- **分支**：`feat/web-worker`（off `main`）
- **总进度**：6 个 task 中 5 个完成；Task 6（手动烟测）等待用户在浏览器实测

## 关键文档

| 文档             | 路径（相对 worktree 根）                                          |
| ---------------- | ----------------------------------------------------------------- |
| 设计 spec        | `design/superpowers/specs/2026-05-14-calculator-worker-design.md` |
| 实施 plan        | `design/superpowers/plans/2026-05-14-calculator-worker.md`        |
| 状态恢复（本文） | `design/superpowers/2026-05-14-calculator-worker-status.md`       |

## 任务清单

| #   | Task                            | 状态          | 关键 commit                        |
| --- | ------------------------------- | ------------- | ---------------------------------- |
| 1   | `draggingId` 提升到 `uiStore`   | ✅            | `90d53e0`                          |
| 2   | Worker 通信协议 + 主线程 client | ✅            | `f8f87ab` + `f50467e`(fix)         |
| 3   | Worker entry（版本缓存）        | ✅            | `b4bf544` + `4618909`(fix)         |
| 4   | PlacementEngine 接口改造        | ✅            | `2561aca`（与 Task 5 共享 commit） |
| 5   | hook / context / UI 大切换      | ✅            | `2561aca` + `785914c`(fix)         |
| 6   | **手动烟测（浏览器）**          | ⏸ in_progress | —                                  |

## Commit 链（自 `main` 分叉以来）

```
785914c refactor(workers): 清理 pending stale entry + 去除冗余 useMemo
d5a0f1d docs(policy): 允许 subagent-driven 自动 task 内自主 commit plan-declared step
2561aca refactor(calculator): simulate 搬入 Web Worker，UI 同步消费保持不变
4618909 refactor(workers): version > lastVersion 严格单调；err 非 Error 防御
b4bf544 feat(workers): calculator worker entry 含版本缓存
f50467e refactor(workers): onMessage 先 stale 检查再删除
f8f87ab feat(workers): calculator worker 通信协议与主线程 client
90d53e0 refactor(timeline): draggingId 提升到 uiStore
2d09be5 docs(workers): calculator Web Worker 化 spec + 实施计划
```

远端：已 push 到 `origin/feat/web-worker`（upstream 已设）。

## 当前验证状态

- `pnpm test:run`：**708 passed**（47 files）
- `pnpm exec tsc --noEmit`：clean
- `pnpm lint`：clean
- `pnpm build`：成功；calculator worker 独立 chunk（约 62 kB）

## 已落地的代码

**新增（4 文件）：**

- `src/web-workers/calculator/types.ts` — 协议类型
- `src/web-workers/calculator/client.ts` — 主线程 `CalculatorWorkerClient`：lazy spawn / 版本号 / 请求 id 匹配 / 过期 drop / 崩溃恢复
- `src/web-workers/calculator/client.test.ts` — 9 个单元测试
- `src/web-workers/calculator/index.ts` — Worker entry：消息分派 + `(version, excludeId)` 缓存

**修改：**

- `src/store/uiStore.ts` — 新增 `draggingId` / `setDraggingId`（从 persist 排除）
- `src/components/Timeline/index.tsx`、`SkillTracksCanvas.tsx` — `draggingId` 改读 store
- `src/contexts/DamageCalculationContext.ts` — 删 `useDamageCalculationSimulate`；新增 `useRemovalTimelinesByExcludeId` / `useDamageCalculationPending`
- `src/hooks/useDamageCalculation.ts` — `useMemo` → `useState + useEffect` 异步；接 `CalculatorWorkerClient` 单例；新增 `extraExcludeIds` 入参；回放分支保持同步
- `src/hooks/useDamageCalculation.test.ts` — `FakeWorker` 注入 + `flushWorker` helper
- `src/utils/placement/engine.ts` — `simulateOnRemove` callback → `removalTimelinesByExcludeId` Map 查表；`findInvalidCastEvents` inline 调用同步改查表
- `src/utils/placement/engine.test.ts`、`integration.test.ts` — mock 改 Map
- `src/components/Timeline/index.tsx`、`TimelineTable/index.tsx` — engine 构造字段切换；删 `useDamageCalculationSimulate`
- `src/components/PropertyPanel.tsx` — `useDamageCalculation(timeline)` → `useDamageCalculationResults()`（顺手修，避免双倍 simulate）
- `src/pages/EditorPage.tsx` — 拼 `extraExcludeIds = [selectedCastEventId, draggingId].filter(Boolean)` 传入 `useDamageCalculation`
- `CLAUDE.md` — 新增「subagent-driven 自动 task 例外」条款

## 核心设计要点

| 决策                                             | 实现位置                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| UI 同步消费（calculator + PlacementEngine 统一） | `engine.ts:timelineExcluding`（同步查表）+ `useDamageCalculation` useMemo 包装 stale-while-revalidate |
| `simulateOnRemove` 回调下线 → 预算结果表         | `engine.ts: removalTimelinesByExcludeId?: Map`；worker 端 `index.ts` 一次返回打包                     |
| `extraExcludeIds` 上层声明                       | `EditorPage.tsx`：`[selectedCastEventId, draggingId].filter(Boolean)`                                 |
| EditorPage 自动重分类 **不入 worker**            | `EditorPage.tsx:113-140`，engine 不传 `removalTimelinesByExcludeId` → 走 sourceCastEventId 过滤降级   |
| Stale-while-revalidate                           | `useDamageCalculation.ts`：`cancelled` flag + `setState` 在 `.then` 内                                |
| Worker 内 `(version, excludeId)` 缓存            | `src/web-workers/calculator/index.ts`：`lastVersion` + `cache.byExcludeId`                            |

## 已知技术债（本期不修）

**tsconfig DOM vs WebWorker lib 冲突**（Task 3 code reviewer 提出）：

- `src/web-workers/calculator/index.ts` 在 `tsconfig.app.json` 的 `DOM` lib 下编译，`self` 类型实际是 `Window` 而非 `DedicatedWorkerGlobalScope`。
- 运行时无影响（Vite 构建成 worker chunk），类型层不精确。
- 修复路径：新增 `tsconfig.worker.json` 单独 lib，Vite worker 配置指向。

## 下一步：Task 6 烟测（待用户在浏览器实测）

| #         | 步骤                                                             | 期望                                                            |
| --------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| 1         | `pnpm dev`，浏览器开 `/timeline/<id>`                            | 主路径渲染正常（cast 图标 / damage event / PropertyPanel 数值） |
| 2         | DevTools Performance 录 mutation 操作                            | 主线程**不再**出现 5-20ms `simulate` 长任务；移到 worker 线程   |
| 3         | 选中 cast → 拖动                                                 | shadow 实时跟随，无延迟一帧                                     |
| 4         | 切换选中 cast                                                    | shadow 立即切换（worker 内缓存命中，零 worker 调用）            |
| 5         | **消费型 cast 回归**：AST 7439 t=0；buff 内 8324 t=15；拖动 8324 | buff 区间内任何位置不亮红框                                     |
| 6         | **自动重分类**：骑士斯卡曼舞步轨道（37013/37016/37014）添加 cast | 自动选合法 variant（同步降级路径，应与原有一致）                |
| 7（可选） | DevTools 强制 close worker                                       | 下次 simulate 重新 spawn，UI 短暂保留 stale 数据后恢复          |

哪条不符合预期记录具体现象供主 agent debug。

## 工作流约定（已固化到 CLAUDE.md）

- `superpowers:subagent-driven-development` 流程内：subagent 可按 plan 内 commit step 自主 commit（commit `d5a0f1d`）。
- 人工 task 阶段：任何 git 操作仍需用户最新消息明确授权。
- 破坏性操作（`reset --hard` / `push --force` / `branch -D` / `stash drop` / `git push`）**任何时候**都需显式授权。

## 已知遗留状态

- 一份 `lint-staged automatic backup` stash（含 pre-existing `useChangelogToast.tsx` 改动，与本 plan 无关）—— `git stash list` 可见；处置由用户决定。

## 接续工作的方式

1. `git log --oneline ^main HEAD` 对照上面 commit 链
2. 读 spec + plan 两份
3. 推进 Task 6（手动烟测）
4. 烟测通过后调用 `superpowers:finishing-a-development-branch` 处理 PR / merge / cleanup
