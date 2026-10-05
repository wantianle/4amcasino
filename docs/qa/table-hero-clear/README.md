# Hero 手牌 / 牌桌菜单修复证据

## 修复

- `.table-pod-pills` 改为相对 pod anchor 的绝对浮层，不再参与 hero pod 的 flex 高度；
  hero 卡片间距从 `+10px` 收紧为 `+6px`。
- hero 节点移到 pod anchor 的直接相对容器中，probe 现在统计
  `[data-testid="hero-hole-cards"]` 与真实公共牌的交叠，并记录
  `heroTop`、`boardBottom`、`heroBoardGap`、`heroBoardOverlapPx`。
- `⋮` 菜单的 `invite` / `watch` 从 `desktopMenuGroups` 过滤；顶栏邀请和观战入口保留。
  没有改动右上角关闭/离开入口，也没有做房主解散房间逻辑。

## 当前证据

- `before/overlap.json`
- `after/overlap.json`
- `after/probe-9p-myturn-1440x900.png`
- `after/probe-9p-myturn-390x844.png`
- `after/probe-9p-showdown-1440x900.png`
- `after/probe-9p-showdown-390x844.png`
- `after/9p-myturn-390x844-more-menu.png`

after probe 使用 `gitHash=583fcb1`、probe hash `418956eca319`、locale `zh-CN`，
并在截图前等待字体加载。`ASSERT=1 VIEWS=both` PASS、无 page errors。

9p 桌面实测 hero 与 board 的 gap：myturn 约 `14px`，showdown 约 `14px`；
after JSON 中 `heroBoardOverlapPx=0` 的桌面场景证明公共牌未被 hero 手牌遮挡。
手机 hero 牌已单独上移到 board 上方的安全层；手机其他座位的 text/pod 交叠仍按
现有 probe 完整记录，不把窄屏空间债务伪装成桌面零回归。

截图自查：1440×900 / 390×844 的 myturn 与 showdown 中，公共牌下缘可见；
myturn 包含实时下注面板。more-menu 截图中不再出现“邀请朋友”或“观战链接”，
顶栏入口仍可见。
