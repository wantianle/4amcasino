# 牌桌布局 B 证据

本轮完成 GGPoker 风格的桌内信息重排：座位牌变为横向扁牌，hero 手牌脱离
座位牌并置于座位前方的 felt 上，座位信息区压缩；公共牌和多跑结构继续由
`geometry.ts` 与现有 `multiRunBoard` / `ribbonFitsRail` 语义驱动。

## 截图

由 `apps/web/test/browser/table-baseline.mjs` 生成，使用 mock room / WebSocket：

- `desktop-9p-myturn-1440x900.png`
- `desktop-9p-myturn-1280x720.png`
- `desktop-9p-myturn-390x844.png`
- `desktop-9p-myturn-844x390.png`
- `desktop-9p-showdown-1440x900.png`
- `desktop-9p-multirun3-1440x900.png`
- `idle-6p-1440x900.png`

这些场景覆盖下注态、摊牌、多跑和空闲桌；截图生成结果为 `pageerror=0`。

## overlap 对比

使用同一份当前 probe（probe hash `5ab1eb0d9836`，locale `zh-CN`）：

- baseline（临时移除本轮 `table-pod.css` / `RoundTable.tsx`，同一 probe）：`before/overlap.json`
- after：`after/overlap.json`

判定结论：之前的手机失败是本轮 `.table-canvas` 样式钩子缺失造成的回归；修复后
真实场景断言通过：myturn 有 live betting actions，showdown 有 5 张公共牌与
reveals/result，multirun 有 3 行、15 张牌，且 after 的 hero pair 为 2 张（桌面和
手机均验证）。after 的真实牌面指标为：showdown `boardCov=1`（1440/390/667），
multirun `boardCov=1 / 0.9763 / 0.9666`（1440/390/667）；空 board 的 myturn
不再把占位 slot 计入 boardCov，而是 `boardCardCount=0`、`boardCov=null`。

Gate 明确如下：

- **桌面硬门禁**：1440×900 / 1280×720 要求 `podPairPx=0`（两两 pod 重叠为 0），
  该检查不再被视口过滤跳过。
- **手机门禁**：390/667 检查真实牌面 `boardCov`、文字可读性、`dockVsClusterPx`、
  slider/dock 触控尺寸、页面错误，以及 390 的 `clusterVisible`（cluster 未被祖先裁切）。
- **手机诊断（不伪装为零碰撞，数字完整保留在 JSON）**：
  - 390 仍有 `clusterCoveredPods`：9p-myturn/2p-headsup-myturn/8p-myturn 均为 `[0]`
    （`clusterVisible=1` 只表示 cluster 未被裁剪，不等于没有压到 seat pod）；
  - 手机 `podPairPx`：9p myturn 390 `200` / 667 `142`；9p showdown、multirun 390 `725` / 667 `471`；
    8p myturn 390 `39` / 667 `28`；
  - 短横屏 667 的 `clusterVisible=0.4611`（short-landscape 已知权衡）。
- `ASSERT=1` 结果为 PASS；320/568 是未门禁的退化尺寸，数字仍完整记录。

每份报告记录 `gitHash=bd9fafb`、`probeHash=5ab1eb0d9836`、`locale=zh-CN`、
`generatedAt`，并在截图前等待 `document.fonts.ready`；scene 记录额外保存
`fontsReady=true`、牌面数、hero 牌数、run 数和可用 betting action 数。

## 几何与语义

本轮没有修改 `geometry.ts` 常量。修正的是 `RoundTable` 缺失的 `table-canvas` 样式
钩子，并把桌面座位牌切成横向信息区；座位锚点、中心预算、手机 canvas、公共牌、多跑
行、发牌入口、下注、pts/BB 切换、热键和 per-slot 对齐均沿用原实现。新 hero 卡片
使用现有 `HoleCards` 与 `PlayingCard`，弃牌通过既有 pod dim 状态保持半透明。
