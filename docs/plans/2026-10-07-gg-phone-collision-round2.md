# GG 手机碰撞 lane 第二轮

## 脚本口径修复

`table-overlap.mjs` 现在额外输出：

- `clusterOverPodBgPx2`：cluster 与 pod shell 的交集，扣除该 pod 内容后的纯背景外壳面积；允许诊断，不是放行条件。
- `clusterOverPodContentPx2`：cluster 与 avatar/card/text/pill/button 内容的交集；必须为 `0`。
- `semantic.controls`：控件是否存在、可见、可滚动、可点击，以及 Playwright trial click 的结果。
- `runCoverage[]`：primary 与每个 additional board run 分开测量。
- `statusHits` / `statusCollisionPx2`：run chip、summary、banner 等状态层与牌面/座位内容的交集。

`podPairPx2` 仍明确是 card + pill rectangles 的累加面积（px²），不是完整 subtree union。

## CSS/layout 改动

没有改 `geometry.ts`。新增 portrait phone console 的固定可滚动高度：

```css
height: min(38vh, 17rem);
max-height: min(38vh, 17rem);
overflow-y: auto;
flex: 0 0 auto;
```

这让控制区成为独立 scrollport；桌面路径与 geometry 数值完全不受影响。

## 当前 9p 真实 DOM 结果

使用 Vite + Chrome + synthetic room_state 的真实产品 DOM：

| viewport/state | textCov | boardCov | podPairPx² |      cluster shell/content |
| -------------- | ------: | -------: | ---------: | -------------------------: |
| 320 myturn     |   .6046 |        — |          0 |          2146.95 / 7207.53 |
| 390 myturn     |   .9916 |        — |          0 |                      0 / 0 |
| 320 showdown   |   .8838 |    .3103 |          0 | 待 console clip 后仍需复核 |
| 390 showdown   |   .9528 |    .8889 |          0 |                      0 / 0 |
| 320 multirun3  |   .8210 |    .3665 |          0 | 待 console clip 后仍需复核 |
| 390 multirun3  |   .9001 |    .7957 |          0 |                      0 / 0 |

说明：固定 console 高度改变了 stage 可用高度，因此 320/390 的 canvas scale 和 board 覆盖发生变化；这证明当前瓶颈不只是 pod 尺寸，还包括中心区与 console 的 flex 预算。不能把本轮结果宣称为全通过。

牌背诊断保持有效：hidden fan 命中节点，单张 card/avatar 交集约 `302.2px²`、头像占比 `0.7297`，通过有效正面积重叠判据。

## 桌面像素比较

用只读 `7e3c699` worktree 生成旧版截图，用当前 worktree 生成新版截图，统一使用当前 `table-overlap.mjs`、同 locale、同 synthetic room、同 `PIXEL_FIXED=1`、同 viewport：

| viewport | changed pixels |     total |  fraction | diff bbox            |
| -------- | -------------: | --------: | --------: | -------------------- |
| 1440×900 |          6,233 | 1,296,000 | 0.480941% | `(24,14)-(1416,875)` |
| 1280×720 |          5,975 |   921,600 | 0.648329% | `(24,14)-(1256,695)` |

这不是零差异。差异分布覆盖几乎整个页面，不是局限于 phone CSS；当前不能把它归因成手机分支泄漏。由于旧版与当前页面的浏览器 fixture/资源路径和时间线不同，仍需 oracle 决定是否要求保存同 commit 的 screenshot artifact 后再做最终 diff。桌面 DOM probe 的 `podPairPx2` 仍为 `0`，桌面 geometry contract 未变。

## 当前结论

- 已完成：cluster 指标拆分、控件 trial-click 测量、additional run/status 独立数据结构、L2 前后固定条件截图比较。
- 未完成：320 控制区内容碰撞、320 text coverage、multirun primary/additional board coverage、最终 desktop pixel-zero gate。
- 没有 gate 证明必须改 `geometry.ts`；本轮不改 geometry。
- 无服务端、packages、shared、`collectorSeats()` 或 `ResultFlash.tsx` 修改。
