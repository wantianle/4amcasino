# GG 手机碰撞修复 lane

## 修复内容

### 测量脚本先修

`table-geometry-gate.mjs` 现在把以下情况全部判为失败，而不是乐观通过：

- `boardCov === null`
- `clusterVisible === null`
- fan 匹配为空
- showdown 安全区匹配为空
- 非适用状态不会伪造通过；适用状态必须有对应 DOM

`preflopDeck` 改为检查：

- preflop room_state 场景必须有 deck source 节点
- 节点必须不可见
- 生命周期必须是 `present-hidden-source`

同时将 `podPairPx` 统一改名为 `podPairPx2`，单位明确为 px²。它的口径是：每个 pod 的 `.table-pod-card` 与 `.table-pod-pills` 矩形两两求交并累加；它不是完整 subtree union，可能重复计数，因此另行输出 avatar/text/fan 诊断。

牌背测量输出现在包括每个匹配节点的：

- card bbox
- avatar bbox
- overlap px²
- overlap / avatar area ratio

本轮诊断确认不是 selector 空匹配：hidden mode 命中了 16 个 card wrapper；此前牌背 bbox 位于头像上方约 30px，没有交集。修正 dense phone holo top 后，交集稳定为 `302.2px²`，占头像面积约 `72.97%`，通过有效重叠阈值。

### CSS/layout 修复

只改 phone 分支，桌面默认值不动：

- phone pod 宽度：`78px → 68px`
- phone pod 上下 padding：`10/6px → 8/4px`
- phone name/money/caption/micro/pill 字号收敛到 `12/11/10/9/9px`
- phone fan：`48/18/40px → 44/16/36px`
- dense fan：`46/18/40px → 42/15/36px`
- phone face-up / fan holo 外扩收回
- dense fan top 调整到 `12px`，以满足牌背与头像有效重叠

这些改动没有修改 `geometry.ts`，也没有改 `PHONE_CANVAS`、`K_FLOOR`、`SEAT_ANCHOR_PHONE` 或 `BET_RING_PHONE`。

## 真实 DOM 前后对照

使用 Vite + Chrome + Playwright，synthetic `room_state` 进入真实产品页面测量。

### CSS 修复前

| viewport / state | textCov | boardCov | podPairPx² |
| ---------------- | ------: | -------: | ---------: |
| 320 myturn       |   .4692 |        — |         70 |
| 390 myturn       |   .7546 |        — |         70 |
| 320 showdown     |   .8086 |    .8300 |        213 |
| 390 showdown     |   .9363 |    .8377 |        571 |
| 320 multirun3    |   .7133 |    .7289 |        213 |
| 390 multirun3    |   .8698 |    .7609 |        571 |

### CSS 修复后

| viewport / state | textCov | boardCov | podPairPx² |           fan/avatar |
| ---------------- | ------: | -------: | ---------: | -------------------: |
| 320 myturn       |   .5662 |        — |          0 |               0.7297 |
| 390 myturn       |   .8674 |        — |          0 |               0.7297 |
| 320 showdown     |   .8447 |    .9339 |          0 | n/a（无 hidden fan） |
| 390 showdown     |   .9581 |    .9242 |          0 | n/a（无 hidden fan） |
| 320 multirun3    |   .7720 |    .8216 |          0 | n/a（无 hidden fan） |
| 390 multirun3    |   .9124 |    .8249 |          0 | n/a（无 hidden fan） |

这说明 CSS 修复消除了主要 card/pill pod 碰撞，并让 primary showdown board 达到 `>=.90`；但 multirun 的 additional run / 状态层和 320 控制区仍未通过，不能宣称 lane 已收口。

## 14 条 gate 结果

### 320×568

| gate                  | myturn                                 | showdown                         | multirun3                              |
| --------------------- | -------------------------------------- | -------------------------------- | -------------------------------------- |
| 9 pods                | PASS (9)                               | PASS (9)                         | PASS (9)                               |
| k floor               | PASS (.55)                             | PASS (.55)                       | PASS (.55)                             |
| text coverage         | FAIL (.5662)                           | FAIL (.8447，若阈值 .85)         | FAIL (.7720)                           |
| text rect pair        | PASS (0)                               | PASS (0)                         | PASS (0)                               |
| avatar pair           | PASS (0)                               | PASS (0)                         | PASS (0)                               |
| hero/primary board    | N/A / 0                                | PASS (0)                         | PASS (0)                               |
| pod content pair      | PASS (0px²)                            | PASS (0px²)                      | PASS (0px²)                            |
| cluster content       | FAIL (6210px²；仍覆盖内容/控制区)      | FAIL (1549px²)                   | FAIL (1549px²)                         |
| controls usable       | FAIL（当前 DOM 仍有覆盖）              | FAIL（同上）                     | FAIL（同上）                           |
| primary board         | N/A                                    | PASS (.9339)                     | FAIL（.8216）                          |
| additional run/status | N/A                                    | N/A                              | FAIL（.8216，未拆独立 run layer gate） |
| fan/avatar            | PASS (.7297）                          | N/A（无 hidden fan，明确不适用） | N/A                                    |
| preflop deck          | PASS（source 节点 present but hidden） | N/A                              | N/A                                    |
| page errors           | PASS（0）                              | PASS（0）                        | PASS（0）                              |

### 390×844

| gate                  | myturn                                 | showdown     | multirun3                           |
| --------------------- | -------------------------------------- | ------------ | ----------------------------------- |
| 9 pods                | PASS (9)                               | PASS (9)     | PASS (9)                            |
| k floor               | PASS (.55)                             | PASS (.90)   | PASS (.90)                          |
| text coverage         | PASS (.8674)                           | PASS (.9581) | PASS (.9124)                        |
| text rect pair        | PASS (0)                               | PASS (0)     | PASS (0)                            |
| avatar pair           | PASS (0)                               | PASS (0)     | PASS (0)                            |
| hero/primary board    | N/A / 0                                | PASS (0)     | PASS (0)                            |
| pod content pair      | PASS (0px²)                            | PASS (0px²)  | PASS (0px²)                         |
| cluster content       | FAIL (156px²)                          | PASS (0)     | PASS (0)                            |
| controls usable       | FAIL（myturn 内容仍有覆盖）            | PASS         | PASS                                |
| primary board         | N/A                                    | PASS (.9242) | FAIL（.8249）                       |
| additional run/status | N/A                                    | N/A          | FAIL（additional run 尚未独立量测） |
| fan/avatar            | PASS (.7297）                          | N/A          | N/A                                 |
| preflop deck          | PASS（source 节点 present but hidden） | N/A          | N/A                                 |
| page errors           | PASS（0）                              | PASS（0）    | PASS（0）                           |

## 桌面回归

使用相同 synthetic browser probe：

| viewport | 9p myturn podPairPx² | 9p showdown | 9p multirun3 |
| -------- | -------------------: | ----------: | -----------: |
| 1440×900 |                    0 |           0 |            0 |
| 1280×720 |                    0 |           0 |            0 |

桌面 `TABLE_CANVAS`、`SEAT_ANCHOR`、`FELT`、`BET_RING` 和 `CENTER_COLUMN` 没有改动。桌面截图已由 probe 重新生成到临时输出，但仓库没有保留 L2 前截图 artifact，因此无法诚实给出像素 diff 数值；pixel diff gate 仍待有固定 baseline 文件后补跑。

## 结论与未解决项

- 不需要改 `geometry.ts`；anchor 仍是契约，主要 pod content pair 已从 `70/213/571px²` 降到 `0px²`。
- 320 控制区仍覆盖内容，须继续做 console host / action cluster 的独立布局修复。
- multirun additional run / status layer 尚未独立测量，primary board 在 multirun 仍只有 `.8216/.8249`。
- 真实 DOM 是 synthetic room_state，不是真人登录房间；没有伪称为真人证据。
- 本轮没有改服务端、packages、shared、geometry 或 collectorSeats。
