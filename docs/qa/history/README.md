# 战绩页 `/history` — QA 证据

本目录只放**真实数据**证据：页面数字来自真实 server 上被真实发牌、真实结算的手牌（临时隔离 SQLite + 真实 WS / 心理扑克 / 账本），不是 mock。

## 真实 E2E（real）

脚本：`apps/server/test/historyE2E.mjs`

```
node --import tsx apps/server/test/historyE2E.mjs
```

流程：进程内启动真实 server（`DB_PATH` 落在 `tmpdir()`，绝不碰默认 `4amcasino.db`）→ 注册真实账号 → 建房入座买入 → 起 2 个真实 bot（`BotSupervisor`）→ 真人 `HeadlessClient` 打完 3 手 → 房主经真实 `POST /api/rooms/:id/void-hand` 作废最新一手 → 无头 Chrome 登录同一账号，访问 `/history` 与 `/history/:roomId`，断言页面渲染的数字与 API 完全一致。

本轮补强还覆盖：房间分页契约（`total`/`hasMore`/下一页）、同 `ts` 手牌的稳定排序、房间切换时 offset 重置、`active`/`archived` 筛选走服务端。

一次通过的运行（`history-e2e-report.json`）：

| 断言 | 值 |
| --- | --- |
| 落库手牌总数 `total` | 3 |
| 我的有效手数 `myHands`（已排除作废） | 2 |
| 我的净收益 `myNet` | +40 |
| 本页净胜 `pageNet`（排除作废） | +40 |
| `/api/rooms/:id/hands` 中作废手 `voided` | `true` |
| `/history` 行文本 | `History QA 房主 3 名玩家 · 刚刚 · 盲注 10/20 2 手 +40 账本` |
| `/history/:roomId` 作废徽标 | 出现「作废」 |
| 房间分页 `total` / 第 1 页 / 第 2 页 | 25 / 20（`hasMore=true`）/ 5（`hasMore=false`） |
| 同 `ts` 稳定排序（每页 2 条） | `t5,t4` / `t3,t2` / `t1`，无重复无遗漏 |
| 房间切换 offset 重置 | 从分页房第 2 页切到主房间，未出现空态，且以 `offset=0` 重新请求 |
| `archived` 筛选 | 仅返回已关闭的主房间，请求带 `archived=true` |
| `active` 筛选 | 已归档主房间消失，请求带 `archived=false` |
| 页面 / 控制台错误 | 0 |

分页契约（`GET /api/me/rooms`）：返回 `{ rooms, total, limit, offset, hasMore, totals: { hands, net } }`，`total`/`hasMore`/`totals` 均基于**筛选后**的完整集合，排序为 `updatedAt`（ledger 最新 ts / archived_at / created_at 取 MAX）降序、`created_at`、`id` 兜底，保证 offset 分页是全序。

截图：

- `01-history-list.jpg` — `/history` 列表：真实 `myHands=2`、`myNet=+40`，含「已归档」筛选。
- `02-history-room-voided.jpg` — `/history/:roomId`：3 手全部列出，被作废的那手带「作废」徽标，本页净胜 `+40`（作废手不计入）。
- `03-history-room-switch.jpg` — 从 21 手房间第 2 页切换到另一房间，offset 已重置。
- `04-history-paged.jpg` — `/history` 第 2 页（服务端分页，与前页无重复）。
- `05-history-archived-filter.jpg` — 点击「已归档」后的服务端筛选结果。
- `06-history-active-filter.jpg` — 点击「进行中」后已归档房间被排除。

## 非真实 / mock（none）

没有 mock 证据混入本目录。前端单元层面没有为本页新增 DOM mock 测试；页面正确性以本轮真实 E2E 为准，后端 void 关联键另有单元测试（`apps/server/test/voidHandReadModels.test.ts`、`apps/server/test/history.test.ts`）。
