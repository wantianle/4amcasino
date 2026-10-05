# 手牌专业模式验证

入口：`/room/:id/hands?mode=pro`。普通模式保留原来的记录组件；切换通过查询参数完成，不新增路由。

- ProStats：本桌自己的最近 5,000 手结算记录，`GET /api/me/stats?roomId=…&minHands=20`。维度切换使用同一响应的分组；街切片仅有 AF/AFq。曲线始终表示完整查询样本，不随分组切换。
- API 提供 myStats / userStats / roomHud，前端类型独立维护，不导入服务端。
- PlayerHud：桌内按钮开启；关闭即卸载并清除统计。手动刷新，不后台轮询。隐藏玩家仅显示名字和隐藏提示；不足服务端门槛的玩家不显示指标。20–49 手显示低置信度。
- null 与无机会显示破折号，0/0 保留为原始计数；net 使用 hits，AFq 保留 ratio 单位；bb/100 分子按当前 API 的实际缩放显示。
- 复用现有暗色主题、Panel/Button/Badge、NetAreaChart；位置列横向滚动、指标列固定。

## 证据分层

- `overview-*`、`position-*`、`street-*`、`ip-*`、`empty-*`、`low-sample-*`、`hud-*`：**mock 证据**，由 `stats-pro.mjs` 生成，用于稳定覆盖布局、空态和交互。
- `real-overview-1440.png`、`real-position-1440.png`、`real-street-1440.png`、`real-ip-1440.png`、`real-hud-1440.png`：**真实 server 证据**，由 `stats-pro-real.mjs` 生成。真实请求没有 Playwright route interception，真实数据来自隔离 SQLite 的结算投影。
- `real-result.json` 是真实 API 断言和 HUD 三态记录；`bot-live-report.json` 是造牌阶段的真实游戏报告。

真实闭环本次结果：25 手已结算、0 abort、VPIP `83.33%`，PFR 及其他统计均有实际机会样本，`byPosition`、`byStreet`、`byIpOop`、`trend`、`dataQuality` 均非空；真实 HUD 共 5 个 roster 条目，覆盖足样本可见、低样本 `insufficient`、`hidden:true` 三态，page error 为 0。

生成 mock 证据：`node apps/web/test/browser/stats-pro.mjs`，需要运行 Vite（默认 5173）。

生成真实证据（先启动隔离 server，再造牌，再打开真实页面）：

```sh
DB_PATH=/tmp/opencode/stats-e2e.sqlite PORT=8797 \
  BOT_IDENTITY_KEY=$(printf 'ab%.0s' {1..32}) \
  node apps/server/scripts/start.mjs

BASE_URL=http://127.0.0.1:8797 OUT=docs/qa/stats-pro HANDS=25 BOTS=2 \
  PLAYWRIGHT_MODULE=/tmp/4am-release-qa/node_modules/playwright-core \
  BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  node apps/web/test/browser/bot-live.mjs

BASE_URL=http://127.0.0.1:8797 OUT=docs/qa/stats-pro \
  BOT_LIVE_REPORT=docs/qa/stats-pro/bot-live-report.json \
  PLAYWRIGHT_MODULE=/tmp/4am-release-qa/node_modules/playwright-core \
  BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  node apps/web/test/browser/stats-pro-real.mjs
```

启动后健康检查：`curl -fsS http://127.0.0.1:8797/api/health`，本次返回 `{ "ok": true, "storage": "ephemeral" }`。`bot-live.mjs` 使用真实注册、真实 WS、真实 bot runner 和真实 settlement；`stats-pro-real.mjs` 注册两个额外真实用户，把其中一个设置 `privateMode`，实际请求 `/api/me/stats` 和 `/api/rooms/:id/hud`，不拦截 API。所有数据写入 `/tmp/opencode/stats-e2e.sqlite`，未污染生产库。

验证：web typecheck、指定 workspace build、web Vitest、`git diff --check` 均通过。workspace build 自带 server build 链，因此生成了忽略的 server dist 产物；未改服务端源码。现有 zod 注释和大包告警不影响构建。
