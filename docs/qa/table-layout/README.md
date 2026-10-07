# 牌桌布局 A 证据

证据由 `apps/web/test/browser/table-baseline.mjs` 生成，使用 mock room 和 mock
WebSocket，不连接真实账户或服务端。

重点视口（`desktop-9p-myturn`，包含已断言的 live betting hand、可操作下注区与两项玩法按钮）：

- `desktop-9p-myturn-1440x900.jpg`
- `desktop-9p-myturn-1280x720.jpg`
- `desktop-9p-myturn-390x844.jpg`
- `desktop-9p-myturn-844x390.jpg`

脚本以 `VIEWS=both UAT_OUTPUT=docs/qa/table-layout` 执行，生成桌面和手机各场景
截图；本次运行 `pageerror` 为 **0**。

布局覆盖：手机顶栏常驻历史图标、筹码下拉中的账本、`⋮` 菜单、左上玩法/炸弹
入口、右上快捷键/排名，以及左下聊天/离座。

`myturn` fixture 通过 mock WebSocket 注入真实客户端会消费的
`betting_state`（hero seat 是 `toAct`），而不是只改页面外部 store；这避免了
页面订阅仍停留在 ready/deal 分支的竞态。截图前后都断言：`hand.betting !== null`、
`hand.betting.toAct === mySeat`、`Your turn`、可用 Fold、Call/Check 按钮，以及
下注面板的可用操作。`waiting`、`showdown`、`multirun` 也分别断言其对应状态后才
截图。手机 `⋮` 菜单是 fixed overlay，脚本逐项执行 elementFromPoint 与
Playwright trial click 命中检查，并确认命中的正是当前 menuitem。

对应菜单证据：

- `desktop-9p-myturn-390x844-chips-menu.jpg`
- `desktop-9p-myturn-390x844-more-menu.jpg`
- `desktop-9p-myturn-1440x900-chips-menu.jpg`
- `desktop-9p-myturn-1440x900-more-menu.jpg`

账本入口对桌内成员可见；服务端仍以 `isMember` 限制访问，watch spectator 不在
桌内成员范围内，会被服务端拒绝（403）。本次 mock 截图使用桌内成员身份。
