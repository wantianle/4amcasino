# GG L4a：公共区、底池与空牌面

## 本轮实现

- preflop 的第一行只在 `first.length > 0` 时渲染；没有已发公共牌时不再生成
  `.table-slot`。额外 run 仍只在 `run.length > 0` 时渲染，因此 legacy 的空
  extra run 不会生成可见空行。
- `RoundTable` 新增 `centerPreflop` 位置语义。它把无牌时的中心列锚点设为
  `43%`，而不是依赖空牌占位撑高度。`centerRaised` 的 multi-run `48%` 路径和
  默认桌面 `50%` 路径保持不变。
- 手机的既有 `ChipStack` 复用到 pot pill；桌面仍通过 `.table-pot-chips {
  display: none }` 只显示文字胶囊。金额仍由 `prefs.stackUnit` 决定：BB 模式
  使用 `bbValue(pot, room.bb)` 并显示 `BB`，否则显示筹码金额。

## L4a gate 定义（交给统一脚本接入）

1. **空牌面**：在 `.table-center-col` 内，已发牌节点按
   `[data-table-board-run] .table-dealt-card` 计数；preflop 必须为 `0`，且
   `.table-slot` 的 `getClientRects()` 可见矩形数量必须为 `0`。flop/turn/river
   分别为 `3/4/5`。阈值来自 L0/L1a 判据，不把隐藏 source deck 计入。
2. **pot 分端结构**：`[data-table-pot]` 必须存在且 `getBoundingClientRect()`
   宽高均大于 0（测完整单元，不测数字 span）。pot>0 时手机必须有一个可见
   `.table-pot-chips`，并且金额 `.table-pot-val` 恰有一个可见节点；桌面必须
   恰有一个可见 `.table-pot-val` 且 `.table-pot-chips` 可见矩形为 0。金额文本
   按 BB/筹码两种 prefs 与 `bbValue(pot, bb)` 比对。
3. **pot 位置**：从 `.table-rail-top`（rim）和 `[data-table-pot]` 读取完整
   bounding box。按 L1a 定义 `pot.centerY < rim.centerY - 0.05 * rim.height`；
   在无牌、flop、turn、river、multi-run 每个场景单独判定。目标存在但节点缺失
   或矩形不可见时必须 FAIL，不得输出 null 通过。
4. **per-run 牌数/顺序**：按 `[data-table-board-run]` 分组，run `i` 必须对应
   fixture `boards[i]`；每组按 DOM 顺序读取 `.table-dealt-card` 内的牌值，逐张
   与 `boards[i][j]` 比较。额外空 legacy run 不创建该 selector 的行。禁止把
   所有组相加后用 15 张或只检查 3 个标签代替。

## 当前证据

本轮运行了真实 Vite 产品页 + 系统 Chrome + Playwright 的既有 probe。它确认
9 个 seat、手机 rim ratio `1.3837`、碰撞 lane 的 `podPairPx² = 0`（9p
场景），并通过 typecheck/test/build；既有 probe 尚未接入上述四个 L4a gate，
所以本文件不把 pot y、完整 pot 结构或 per-run 顺序宣称为已测通过。

## 并发改动清单

- `TablePage.tsx`：新增手机 ChipStack、隐藏 preflop/legacy 空 run、传递
  `centerPreflop`、标记 pot 与 run wrapper。
- `RoundTable.tsx`：仅新增 `centerPreflop` prop，并在中心列 top 选择中增加
  `43%` preflop 分支；未改 ribbon、座位、bet 或 geometry 数值。
- `table-center.css`：手机显示共享 chip stack，桌面隐藏它；未改颜色材质。
- 未改 `table-overlap.mjs`、`table-geometry-gate.mjs`、`geometry.ts`、server、
  packages 或 shared。

## 待 oracle 裁决

1. pot y gate 的参照盒是否固定使用 `rim`（本实现采用），还是使用 `inset`；
   两者会在手机产生不同的设计像素余量。
2. pot 的“恰有一个金额”是否允许 sr-only 的 POT label（本实现允许 label，
   只把 `.table-pot-val` 作为金额节点）。
3. per-run 牌顺序 gate 是否按 CardId 原始值比较，还是允许牌面组件的本地显示
   字符串作为等价值。
