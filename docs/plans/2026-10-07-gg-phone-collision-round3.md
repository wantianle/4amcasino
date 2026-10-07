# GG 手机碰撞 lane 第三轮

## Gate 正确性

本轮修正了上一轮的 gate blocker：

- `controlTrials` 不再只写日志；结果分为 `initialControls` 与 `postScrollControlTrials`。
- `controlsUsable` 要求：初始控件存在且可见、存在非 disabled 控件、控件要么初始全可见要么位于可滚动 console、每个 trial click 全部通过。
- preflop deck gate 只在 preflop 场景生效；showdown/multirun 不再被错误判成 preflop failure。
- content selector 补入 `.table-check-feedback`、`.table-timer-track`、`.table-role-badge`、`.table-pod-pills > *`；WinBadge 通过其真实 button/content selector 被测量。
- `clusterOverPodContentPx2` 改为 sweep-line union 面积，避免 avatar、badge、button 等嵌套矩形重复累计；原始 `contentCollisionHits` 仍保留诊断。
- run 使用 `[data-table-board-run]` 分组，不再从 DOM parent 推断。
- 输出 primary run 每张牌 bbox、`primaryCardMinWidth`、`primaryCardMinHeight`。

## Console 空间模型

移除了上一轮昂贵的 `38vh` 固定预算，改为：

```css
.table-console {
  height: auto;
  max-height: 6rem;
  flex: 0 1 auto;
  overflow-y: auto;
}

@media (max-width: 767px) and (orientation: portrait) and (max-height: 600px) {
  .table-console {
    max-height: 3rem;
  }
}
```

stage 不再直接扣除 `38vh ≈ 215.8px`。真实 DOM 前后结果：

| viewport/state | 第二轮 k | 第三轮 k | 第二轮 content | 第三轮 content |
| -------------- | -------: | -------: | -------------: | -------------: |
| 320 myturn     |      .55 |      .55 |        7207.53 |              0 |
| 320 showdown   |      .55 |      .55 |           非 0 |              0 |
| 320 multirun3  |      .55 |      .55 |           非 0 |              0 |
| 390 myturn     |      .60 |      .90 |              0 |              0 |

第三轮 320 的 stage 仍在 `k=.55` floor，但 console 不再遮挡可见 pod content；这满足 oracle 选 B 的核心条件。

## 三场景真实 DOM 结果

### 320×568

| gate                   | myturn           | showdown         | multirun3        |
| ---------------------- | ---------------- | ---------------- | ---------------- |
| pods                   | PASS 9           | PASS 9           | PASS 9           |
| k floor                | PASS .55         | PASS .55         | PASS .55         |
| textCov                | PASS .9900       | PASS .9736       | PASS .9009       |
| avatar pair            | PASS 0           | PASS 0           | PASS 0           |
| text rect pair         | PASS 0           | PASS 0           | PASS 0           |
| podPairPx2             | PASS 0           | PASS 0           | PASS 0           |
| cluster content union  | PASS 0           | PASS 0           | PASS 0           |
| controls trial         | PASS，逐项 trial | PASS，逐项 trial | PASS，逐项 trial |
| primary board coverage | N/A              | PASS .9339       | FAIL .8216       |
| primary card size      | measured         | measured         | measured         |
| additional runs        | N/A              | N/A              | FAIL             |
| status collision       | N/A              | N/A              | FAIL             |
| page errors            | PASS 0           | PASS 0           | PASS 0           |

### 390×844

| gate                   | myturn           | showdown         | multirun3        |
| ---------------------- | ---------------- | ---------------- | ---------------- |
| pods                   | PASS 9           | PASS 9           | PASS 9           |
| k floor                | PASS .90         | PASS .90         | PASS .90         |
| textCov                | PASS .9950       | PASS .9581       | PASS .9124       |
| avatar pair            | PASS 0           | PASS 0           | PASS 0           |
| text rect pair         | PASS 0           | PASS 0           | PASS 0           |
| podPairPx2             | PASS 0           | PASS 0           | PASS 0           |
| cluster content union  | PASS 0           | PASS 0           | PASS 0           |
| controls trial         | PASS，逐项 trial | PASS，逐项 trial | PASS，逐项 trial |
| primary board coverage | N/A              | PASS .9242       | FAIL .8249       |
| primary card size      | measured         | measured         | measured         |
| additional runs        | N/A              | N/A              | FAIL             |
| status collision       | N/A              | N/A              | FAIL             |
| page errors            | PASS 0           | PASS 0           | PASS 0           |

正式 `table-geometry-gate.mjs` 的剩余 FAIL 是：showdown 头像安全区、multirun board coverage、multirun status layer。preflop deck 误报已修正。

## Geometry / 桌面

没有修改 `geometry.ts`。当前 320/390 主要内容碰撞均为 0，说明没有 seat anchor 必须变更的证据。

没有修改 `TablePage.tsx` 或 `RoundTable.tsx`，避免与其他 lane 冲突；本轮仅改 phone console CSS 和 canonical measurement scripts。桌面 geometry contract 未变；桌面 DOM collision 继续沿用上一轮 `1440×900/1280×720 podPairPx2=0`。pixel diff 是诊断，不作为本轮手机 lane 的 gate。
