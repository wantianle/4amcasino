# GG L2 座位单元骨架

## 本轮范围

- 新增 `apps/web/src/widgets/table/TableSeat.tsx`。
- `RoundTable.tsx` 将原本 inline 的 seat anchor wrapper 替换为 `TableSeat`。
- 不修改 `geometry.ts` 的桌面值；本轮只为修复 L1 blocker 调整 `PHONE_FELT.rim` 并加入 `PHONE_RIM_RATIO` 运行时断言。
- 不修改 `TablePage.tsx`、`goldFive.ts`、`collectorSeats()`、服务端或 packages。

## TableSeat 边界

`TableSeat` 是一个保持原 DOM 位置和 CSS 类不变的机械边界：

```text
TableSeat (absolute seat anchor, z-20)
└── table-pod-visual
    ├── hole cards / avatar ring / timer badge
    ├── dark name + stack plaque
    └── action / state / ready / bank pills
```

组件接收 `seat, x, y, tx, ty` 和 `podRef`，因此牌、头像、胶囊、徽章和状态都继续共享同一个 transform anchor。游戏状态、筹码飞行动画和 `collectorSeats()` 仍由 `RoundTable` 计算；这避免 L2 机械拆分顺便改变行为。

## 层级关系

- 弃牌牌背：`table-pod-holo--fan` / `table-pod-fan`，由现有 seat pod CSS 放在头像上缘并与头像重叠。
- 摊牌 / hero：`table-pod-holo--side` 或 `table-hero-cards`，继续使用现有面牌层级，不改变桌面输出。
- 头像：`table-avatar-ring`，位于牌背之上；角色徽章继续挂在头像环上。
- 信息胶囊：`table-pod-card` 内 `table-pod-info`，名字行在筹码行之前。
- 计时：`TurnProgress` 仍在同一 `table-pod-info` 结构中，计时显示和原来相同。
- 国旗：产品代码与 CSS 没有 `table-seat-flag` / `seat-flag` 残留；权威参照文档中的文字仅保留为历史裁决记录。

## L1 blocker 修复

oracle 要求测量 `rim` 而不是画布。手机 rim 现在是 `86% × 85%`：

```text
rim width  = 400 × .86 = 344
rim height = 560 × .85 = 476
ratio      = 476 / 344 = 1.3837209302
```

`PHONE_RIM_RATIO` 在 `geometry.ts` 中运行时断言 `>= 1.38`，测试也独立断言该值。`shadow` 不参与比例判定。

## 证据边界

- 桌面几何常量 `TABLE_CANVAS`、`SEAT_ANCHOR` 和桌面 `FELT` / `BET_RING` 未改。
- `TableSeat` 保留同一个 `absolute z-20` wrapper、相同 x/y/translate、相同 `table-pod-visual` 子树和同一 ref 目标；因此拆分是渲染结构等价重构，而不是布局调整。
- 9 人完整 pod / 文本矩形碰撞仍不能由 `podWorstPx` 代替。必须在真实产品 DOM 中对 320×568 和 390×844 各测一次；当前服务与登录桌仍不可用，本轮不把静态 anchor 或手写 fixture 当作通过证据。
- 本轮没有真实产品截图，因此 L2/L1 仍不是最终视觉验收通过；只完成代码结构和可执行 rim gate。

## 下一步

L3 应把 `TableSeat` 内 hole-card 区域提炼成明确的 `hidden / showdown / hero` mode，并在真实 DOM 中测量牌面与头像安全区、相邻 seat 和公共区的关系。
