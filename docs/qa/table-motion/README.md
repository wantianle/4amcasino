# 桌内动效批 QA

本批新增证据由 browser fixture 输出到 `UAT_OUTPUT`：`motion-in-progress.png`
（`MOTION_EVIDENCE=1 FEATURE=1`）和 `reduced-motion-static.png`
（`MOTION_REDUCED_EVIDENCE=1 FEATURE=1`）。这两张进行中截图不提交到仓库，
因为动画时间点无法稳定复现；fixture 会断言炸弹池提示、发牌进行中状态和
reduced-motion 静态状态，并收集
`pageerror`；音效沿用 `4am-sounds` 与 WebAudio 合成，不加载资源文件。

Desktop action-label comparison for the same 9-player / active-turn fixture:

- Before: `before-action-labels.png` — existing baseline captured before the motion tuning.
- After: `after-action-labels.png` — `table-baseline.mjs`, 1440×900, after the timing changes.

The fixture includes visible call action labels (the same label path used by check,
bet, and raise). The screenshot fixture runs with reduced motion enabled, so these
images verify the action-label placement and desktop layout without introducing
animation timing into the pixels. Timing changes are verified from the source
constants below and with the browser fixture completing without page errors.

发牌动效覆盖 hero 手牌、对手座位背牌和公共牌。客户端 hand-local epoch
只由对应的权威 `your_card` / `board_open` 事件推进；snapshot
注入、重连重渲染和换手重挂载不会自行启动动效。

browser fixture 还会运行 StrictMode 合约探针：首次 mount 累计 1 次
`animate()`，普通 rerender 仍为 1，卸载 30ms 后 remount 仍为 1；并以
`deckIndex` 为乱序公共牌帧排序依据，`[30@10,32@11,31@12]` 最终得到
`[30,32,31]`。

同一 fixture 还直接走 `gameClient` handler：snapshot `[30,32,31]` → 重复
`board_open` 补齐 `30@10/32@11/31@12` → 新 turn `33@13`，并覆盖 run 2
shared board 与后续权威 `betting_state.board` 纠正；最终 slot 顺序和不重播
规则均有断言。

## Timing record

| Feedback | Before | After |
| --- | ---: | ---: |
| Acting glow | 0.20s | 0.45s |
| Fold/leave dim | 0.30s | 0.46s |
| Win highlight | 0.40s | 0.62s |
| Action-label spring stiffness / damping | 380 / 17 | 220 / 22 |
| Action-label highlight hold | none | 0.82s (`0–18%` highlight, then settles) |
| Bet flight | 0.32s + 0.06s stagger | 0.48s + 0.09s stagger |

Command used:

```sh
BASE_URL=http://127.0.0.1:5177 UAT_OUTPUT=/tmp/4am-table-motion-after \
  VIEWS=desktop node apps/web/test/browser/table-baseline.mjs
```

Result: 22 screenshots generated, no page errors.

本次复审的手机 utility 契约：idle fixture 的五项控件都必须可见且 enabled；live-hand
fixture 的 timer 必须存在且 disabled，其余控件仍须 enabled；fullscreen/voice 探针直接
命中真实 button，且打开 utility 菜单后先断言 `[role="menu"]` 可见。

## 未覆盖 + 原因

协议没有“下一手炸弹池预告”帧，也没有独立的 `deal` 帧；前端使用权威的
`feature_started.bombPot`（本手提示）、本人收到的 `your_card`（发牌节拍）和
`board_open`（公共牌）驱动，不能提前展示服务端尚未确认的下一手状态。对手
背牌是装饰性同步：纯观战者收不到本人的 `your_card`，因此不会看到这段背牌
飞入动画。snapshot/reconnect 不重播；公共牌始终按协议 `deckIndex` 排序。
`shuffle_deck` 是客户端上行帧，不能当作服务端广播事件；洗牌音效在权威
`hand_start` 播放一次。
