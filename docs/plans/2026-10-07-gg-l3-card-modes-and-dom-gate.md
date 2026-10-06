# GG L3：牌面 mode 与真实 DOM gate

## 牌面 mode

`apps/web/src/widgets/table/TableSeat.tsx` 新增 `SeatHandMode`：

```ts
type SeatHandMode = 'hidden' | 'showdown' | 'hero';
```

`seatHandMode()` 将原本散落在 `RoundTable` 的条件收敛为单一判定：

- hero 座位 → `hero`
- 非 hero 且有 revealed / private peek → `showdown`
- 其余座位 → `hidden`

座位 wrapper 现在输出 `data-seat-hand-mode`，但保留原有 `table-pod-holo`、`table-pod-holo--fan`、`table-pod-holo--side`、`table-hero-cards`、`table-pod-card` 等 CSS class 和 DOM 子树顺序。没有改 anchor、pod wrapper 或样式。

## 可复用测量脚本

位置：

```text
apps/web/test/browser/table-geometry-gate.mjs
```

它复用 `table-overlap.mjs` 的真实 Vite 产品页、Playwright、synthetic `room_state` transport 和 DOM bounding-box 测量，然后固定跑：

```text
320×568
390×844
```

用法：

```sh
npm run dev -w @4am/web -- --host 127.0.0.1 --port 5173
BASE_URL=http://127.0.0.1:5173 \
  node apps/web/test/browser/table-geometry-gate.mjs
```

输出每个 scenario / viewport 的：

- pod 数量、缩放 k、text coverage、board coverage
- pod pair intersection
- avatar pair intersection
- text rectangle intersection
- rim ratio
- hidden/showdown/hero mode 数量
- fan 与 avatar 交集比例
- showdown 中央头像安全区交集面积
- hero / board 交集面积
- 每项 gate 的 `true/false`

脚本对未知/缺失 DOM 不做乐观通过；当前部分牌背、pot、D 和下注连线指标仍需结合具体状态补充，不能把 null 当通过。

## 当前真实 DOM 结果（synthetic room_state）

本轮实际通过 Vite + Chrome + Playwright 跑了真实产品页面，非手写 fixture。关键摘要：

| viewport | scenario     | pods |    k | textCov | boardCov | podPairPx |
| -------- | ------------ | ---: | ---: | ------: | -------: | --------: |
| 320×568  | 9p-myturn    |    9 | 0.55 |  0.4692 |        — |        70 |
| 390×844  | 9p-myturn    |    9 | 0.55 |  0.7546 |        — |        70 |
| 320×568  | 9p-showdown  |    9 | 0.55 |  0.8086 |   0.8300 |       213 |
| 390×844  | 9p-showdown  |    9 | 0.90 |  0.9363 |   0.8377 |       571 |
| 320×568  | 9p-multirun3 |    9 | 0.55 |  0.7133 |   0.7289 |       213 |
| 390×844  | 9p-multirun3 |    9 | 0.90 |  0.8698 |   0.7609 |       571 |

结论：9 个 pod 都真实存在，`k` 没有低于 `0.55`，但两个 viewport 均存在 pod/text/board 覆盖，不能验收通过。尤其 320×568 的 `clusterVsPodsPx` 在 9p 状态为 `7845px²`（myturn）或 `2048px²`（showdown）；390×844 的 9p showdown `podPairPx=571px²`。这证明 L2 遗留 blocker 是真实 DOM 问题，不是静态坐标假象。

本轮没有改 `geometry.ts` 数值；不能为了让 gate 变绿越界调几何。应由 oracle 决定是继续加密 phone pod / 允许某些 pill 跨 pod，还是重新分配手机中心区预算。

## 桌面 diff

本轮未能形成有效的“拆分前后”像素 diff：当前 baseline 脚本能生成 synthetic 截图，但仓库没有保留 `7e3c699` 对应的截图 artifact，且历史截图路径不在项目树中。代码级等价证据是桌面 `TABLE_CANVAS` / `SEAT_ANCHOR` / `FELT` / `BET_RING` 未变，`TableSeat` 保持原 wrapper/class/transform；最终像素 diff 仍应在可复现服务条件下补跑。

## 诚实清单

- 已真实测：Vite 产品页 DOM、9p pod 数量、k floor、text/board coverage、pod pair、hero-board 关系、mode 数量。
- synthetic：room_state、牌局和 transport；不是数据库真人登录状态。
- 尚未可靠测通：牌背有效头像交集、摊牌中央 60% 安全区、pot y gate、下注线垂距、D 碰撞，因为现有 fixture 场景/选择器对这些状态没有稳定非空对象；脚本输出 null/空数组，不宣称通过。
- 未完成：320×568 与 390×844 的真实真人账号截图；当前是 synthetic 真实 DOM。服务健康并不等于已取得真人房间状态。

## 需要 oracle 裁决

1. 320×568 的 `clusterVsPodsPx` 和低 text coverage 是否允许以“控制区独立于桌面 pod”解释，还是必须做到所有 pod/pill 像素零交叠？
2. 9p showdown 的 `boardCov < 0.9` 是要求调整牌桌几何，还是允许将多 run / outcome 叠层从公共牌 coverage gate 中排除？
3. 继续 L4 前是否必须先开一个独立 phone-collision 修复 lane；本轮不自行改 `geometry.ts`。
