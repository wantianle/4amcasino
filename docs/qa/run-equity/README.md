# 全下跑马 · 实时胜率气泡（run-equity lane）交付说明

本 lane 实现"全下摊牌 → 亮牌 → 逐街实时胜率气泡"的端到端链路，并把气泡
严格排在发牌之前。截图由 `apps/web/test/browser/run-equity-bubble.mjs`
在真实浏览器（mock websocket）中生成：

| 截图              | 证明的可视状态                                                                         |
| ----------------- | -------------------------------------------------------------------------------------- |
| `00-reveal.jpg`   | 亮牌（对手两张底牌正面朝上、并排 `--side` 容器）**先于**任何气泡；两席头像可见；无气泡 |
| `01-flop.jpg`     | flop 后两席气泡出现：领先 85.96% 绿色、落后 14.04% 红色                                |
| `02-turn.jpg`     | turn 刷新为 93.18% / 6.82%，气泡复用未重建                                             |
| `03-low.jpg`      | <3% 显示"还有机会"、<1% 显示"听死牌"                                                   |
| `04-run2.jpg`     | 两条 run 之间气泡先隐藏 ~2s，再出现 run-2 复算值 70.00%                                |
| `05-showdown.jpg` | showdown 后气泡消失                                                                    |

`00-reveal.jpg` 的拍摄点有 DOM 几何断言兜底：两席 anchor 有实际尺寸、两席
`.table-avatar-ring` 可见、对手席恰好两张 `data-card-rank` 正面牌且使用
`--side` 容器（非 `--fan`）、气泡数为 0。断言不通过就不会写出该图，因此不会
再出现"空桌截图"。

## 如何复跑

**前提：必须用「全新启动」的 vite。** 经 HMR 的长期 dev server 会让脚本里
`import('/src/shared/store.ts')` 与 React 渲染的 store 分叉成两个模块实例，
补丁写进 UI 从不渲染的实例，从而截出空桌。用独立端口启动：

```bash
(cd apps/web && <repo>/node_modules/.bin/vite --port 5350 --strictPort &)
BASE_URL=http://127.0.0.1:5350 node apps/web/test/browser/run-equity-bubble.mjs
```

## 行为限制（发布说明请保留）

### 1. 已接受的 UX 代价：preflop 首帧让第一张公共牌等约 1–2 秒

**这是有意保留的产品取舍，不是 bug。** `finishMultiRun` 把
`openRemainingRunoutBoards()` 挂在 `equityChain` 之后，所以 preflop 全下时，
第一张公共牌要等首个 preflop equity（25,000 次 Monte Carlo）算完：

- **实测：cold ~2040 ms / warm ~1220 ms**（三人 preflop，25k MC，开发机）
- 表现：亮牌后到第一张公共牌之间约有 1–2 秒空档

保留理由：只有严格串行才能**保证气泡先于发牌**（用户要求的顺序
"先亮牌，再气泡，再发牌"）。改成异步/并发的替代方案会把公共牌抢到气泡
前面，已否决。代码注释见 `apps/server/src/game.ts` 中 `equityChain` 处的
"Accepted UX cost, deliberately KEPT"。

### 2. 中间帧不支持断线重连重放

`runout_reveal` 与 `equity_update` **都不写 durable transcript**（纯展示、
advisory）。因此跑马过程中断线重连的客户端：

- 重连后**看不到**已经亮出的底牌与已出现的气泡；
- 要等到 `showdown`（或 `hand_end`）才一次性补齐/清空。

影响范围仅限"跑马中途掉线"这一窗口。设计上这是可接受的：这两个帧不带
任何权威状态，重放价值低，且 transcript 每帧落库的成本不值得。若后续要求
可重放，需要把二者纳入 durable transcript（或让 `showdown`/`room_state`
快照携带当前气泡）。

### 3. 设计取舍：`resetMultiwayWorker()` 是全局模块级 reset

worker 超时善后使用 `resetMultiwayWorker()`，它是**模块级全局**的：一个
job 超时会终止整个 worker、reject 所有 pending、并丢弃排队任务。也就是说
**一个 job 的失败会波及其它 job**。

当前判定为**保守且可恢复**（不是 bug，但应明确是取舍）：worker 超时通常
意味着进程卡死，继续复用其状态风险更大；下一帧 job 会重启 worker 继续。
若未来 worker 需要承载多房间/多用途任务，应改成按用途隔离的 reset。

## 4. 格式范围

本 lane **不扩大格式化范围**：`apps/server/src/game.ts`、
`apps/web/src/shared/gameClient.ts`、`packages/shared/src/wsProtocol.ts`
这三个文件在 HEAD 与本 lane 工作区**都不符合当前 Prettier 配置**，本 lane
暂不整文件重排（避免巨大无关 diff）。
