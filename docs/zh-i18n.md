# 4AM Casino 中文本地化设计方案

> 基于对 `D:\4amcasino` 实际源码的逐文件核对（SettingsPage / KeyboardShortcuts / LoginPage / ProfileDialog / ActionBar / LandingPage / ChatPanel / shared 包 / server 端 error·ledger·abort 字符串 / canvas 分享图 / index.html）。本方案只做设计，不改任何源码。

---

## 1. 风格指南（Tone of Voice）

### 1.1 这个产品是谁在说话

读完源码后可以确认：4AM 不是赌场后台，是**朋友牌局的组织工具**。文案的人设从头到尾一致——

- 落地页：「Your people. Your poker night.」（不是「极致沉浸的德州扑克体验」）
- 登录页副标题：「Nobody sees your cards. Not even the house.」（悬念、口语、短句）
- 账本备注：`table commission - keeps the lights on`（自嘲，把抽成说成「交电费」）
- 成功态按钮：「Dealing you in…」（发牌了伙计，不是「操作成功」）

**中文人设：一个攒局的老友**。会打牌、说话干脆、偶尔损你一句，但从不得罪人。不是客服，不是解说员，不是产品经理。

### 1.2 「你」还是「您」：**一律用「你」，全文禁用「您」**

英文通篇是不带敬语的 "you"，品牌调性是亲密的口语。「您」会瞬间把牌桌变成银行柜台。唯一例外场景（法规要求敬语的公告类文案）在本产品不存在。

- ❌ 正在为您加载您的资料……
- ✅ 正在加载你的资料…

### 1.3 正式度刻度

| 场景 | 刻度 | 例 |
|---|---|---|
| 牌桌 HUD、按钮、状态行 | 最口语，能省则省 | 「轮到你了。」「跟 200」 |
| 设置、个人页描述 | 口语但完整成句 | 「快捷键轮到你时生效。」 |
| 错误/警告 | 口语、不责备、给出路 | 「密码不对，再试一次。」 |
| 落地页营销 | 保留英文的克制俏皮，不加码 | 「自己人。自己的牌局。」 |
| 公平性说明、账号合并等严肃流程 | 中性清晰，仍可说「你」 | 「你的密码只在这个浏览器里推导出签名密钥，从不发给服务器。」 |

### 1.4 「拟人」而非「AI 味」三条硬规则

1. **短句优先，动词开头。** 英文文案的力量来自名词与短句对仗（Deal. Talk. Run it back.），中文对策是用动词短语，不是把英文从句结构原样搬过来。
2. **允许一点玩家黑话，但不许满篇。** 「开一桌」「跟注」「买命筹」这种牌桌口气可以用；「宝子们」「绝绝子」「拿捏」不行。
3. **幽默点要翻成「中文里同样好笑」，不是「直译后解释一下」。** `keeps the lights on` → 「电费的钱」（不译「维持灯火」）；`Tight is right.` → 「紧得稳，赢得狠」（不译「紧就是对」）。

### 1.5 处理随意营销语气的规则

- 英文的**对仗结构尽量保留**（两行标题、三个名词排比），这是这套文案的灵魂，但允许换词：「All the tension. None of the stakes.」→「该心跳的一样不少，真钱一分没有。」
- 英文的**省略与留白不许用成语填满**。原文三个词 `Deal. Talk. Run it back.` 不能译成「发牌论道，再战江湖」。
- 英文里没有出现 emoji，中文营销文案**也不许加 emoji** 来「活跃气氛」（见 3.3）。

---

## 2. 术语表（Glossary）

### 2.1 扑克术语

| English | 中文 | 备注 |
|---|---|---|
| small blind / big blind | 小盲 / 大盲 | UI 里足够短；描述文可写「小盲注/大盲注」。盲注结构写 `10/20`，不加空格 |
| blinds | 盲注 | |
| preflop / flop / turn / river | 翻牌前 / 翻牌 / 转牌 / 河牌 | 行业标准，无争议 |
| street | 下注轮 | 描述文用全称；极窄处（HUD）可写「本轮」 |
| pot | 底池 | 不用「彩池」（港台）。side pot 不存在于本作的展示文案 |
| bet / raise / call / check / fold | 下注 / 加注 / 跟注 / 过牌 / 弃牌 | |
| raise to N | 加注至 N | `Bet N` 与 `Raise to N` 必须区分：前者无人下注，后者已有注 |
| all-in | 全下 | 不用「All in 梭哈」；按钮保留 All-in 也可（行业通用），推荐「全下」 |
| stack | 筹码 | 绝不写「筹码堆」；金额/HUD 直接用「筹码」；starting stack → 起始筹码 |
| showdown | 摊牌 | |
| hole cards | 底牌 | 「Your cards stay yours」语境统一用「底牌」 |
| community cards | 公共牌 | |
| run it multiple times / multi-run | 多次发牌 | 桌面提示「🔁 Run it how many times?」→「🔁 发几次牌？」；GIF 角标 `RUN 2` →「第 2 跑」 |
| banker / backup banker | 账房 / 副账房 | ⚠️ 绝不译「庄家」。这里的 banker 是管点数买卖与结算的朋友，「庄家」在扑克语境=荷官/平台，会引起歧义 |
| ledger | 账本 | 页面标题「账本」，行内「流水」可用于列表语境 |
| settle up | 结账 | 「Bought from the bank (to settle up)」→「向银行买入（用于结账）」 |
| buy-in / buy points | 买入 / 买点数 | 本作是 play-money，银行卖的是点数/筹码，解释性 prose 用「娱乐筹码」；不出现「充值」「点数控」 |
| house cut / table commission | 台费 | `commission - keeps the lights on` →「台费——电费的钱」。kind 徽章统一「台费」 |
| the house | 平台 | "Not even the house" →「连平台也不行」。不译「赌场/庄家」 |
| bounty（7-2 offsuit） | 7-2 彩头 | `paid the 7-2 offsuit bounty` →「付了 7-2 不同花的彩头」 |
| offsuit / suited | 不同花 / 同花 | 牌面记号 `7-2 offsuit` →「7-2 不同花」 |
| peek（付费看别人的牌） | 买看 | 「看牌权」太法律腔；`paid to see seat 3's cards` →「付费看了 3 号位的底牌」 |
| hand history | 出牌记录 | |
| replay | 回放 | |
| kicker / straddle | 起脚张 / 前盲（Straddle） | 当前源码里**未出现** straddle；预留译法，保留英文注 Straddle |
| Royal Flush / Straight Flush / Four of a Kind / Full House / Flush / Straight / Three of a Kind / Two Pair / Pair / High Card | 皇家同花顺 / 同花顺 / 四条 / 葫芦 / 同花 / 顺子 / 三条 / 两对 / 对子 / 高牌 | HAND_CATEGORY_NAMES 的既定译序 |
| describeScore: "Queens full of Nines" | 葫芦，三 Q 带两 9 | 完整句式：同花，K 高 / 顺子，9 高 / 四条 K / 两对，J 和 4 / 一对 6 / 高牌 A。牌点直接用 A/K/Q/J/10…2 |
| Texas Hold'em | 德州扑克 | 首次出现全称，空间紧张可「德扑」，同一屏不混用 |
| seat 3 / Seat N | N 号位 | 不用「座位 3 号」长句；徽章可写「3 号」 |

### 2.2 产品术语

| English | 中文 | 备注 |
|---|---|---|
| room | 房间 | |
| table | 牌桌 | 抽象的「场子」只允许出现在落地页 |
| lobby | 大厅 | |
| host | 房主 | 不译「主持人」 |
| viewer / watch | 观战 | Watch 页 →「观战」；publicWatch →「允许观战」 |
| sit out / take a break | 休息 | sit out 绝不译「旁观」；「观战/旁观」只属于 viewer；leave seat → 离座 |
| standings | 排名 | |
| session report | 战绩小结 | |
| chip-leader crown | 筹码王皇冠 | |
| auto-deal | 自动发牌 | |
| ready check | 就绪确认 | 状态行「X/Y ready」→「X/Y 人就绪」 |
| hand abort / void hand | 本手作废 / 作废手牌 | 徽章「作废」 |
| purchase / transfer / revert | 买入 / 转账 / 撤销 | 账本 kind 徽章 |
| hand-settlement | 结算 | 徽章「结算」 |
| provably fair / fair play guide | 可验证发牌 / 公平玩法说明 | 页脚「Fair play」→「公平玩法」 |
| 4AM Casino / 4AM | **不翻译** | 品牌名保留原文；正文中英混排时按 4.5 加半角空格 |

### 2.3 UI 通用术语

| English | 中文 | 备注 |
|---|---|---|
| toggle / switch | 开关（名）/ 开启、关闭（状态） | Toggle chat →「打开或关闭聊天」；描述行不用「切换」当动词尾巴 |
| Save / Saved. | 保存 / 已保存 | 状态词不加句号于按钮，正文说明加。 |
| Retry | 重试 | |
| Listening… | 按键捕捉中… | 快捷键录制态 |
| Record | 录制 | 快捷键按钮 |
| Restore defaults | 恢复默认 | |
| Pre-action / "Arms now, acts on your turn" | 预操作 / 「先挂上，轮到你自动执行」 | |
| Call any | 有注就跟 | 预操作按钮；any=任意注额自动跟，非时间含义 |
| Sending… | 发送中… | |
| ellipsis `…` | 用单字符「…」 | 严禁 `...` 三个点 |
| Sign out | 退出登录 | |
| light / dark | 浅色 / 深色 | |

---

## 3. 去 AI 味 / 删减规则

### 3.1 禁词表（出现即打回）

> 极致、沉浸式、无缝、赋能、打造、一站式、海量、全新升级、轻松搞定、畅享、无论是…还是…、让每一次…都…、「为你保驾护航」、把字句滥用、被字句直译（"cards are dealt" ≠「牌被发出」→「牌发出」）

- 语气词：**禁用**「哦 / 呀 / 哇 / 啦~」；「呢/吗」每屏至多一处；系统文案不用波浪号「～」。
- 感叹号：全页面 ≤ 2 处；错误文案 **0** 感叹号。
- 「一键」：源码里没有一键概念，不造。
- 主语堆叠：英文爱说 "Your X"，中文要删「你的」。**每段中文里「你的」不得超过 3 次**（落地页标题「你的牌局夜」这类对仗处除外）。

### 3.2 落地页删减清单（逐条对照源码）

| 位置 | 处理 | 理由 |
|---|---|---|
| 段落：「Keep your focus on the cards, with everyone at the same table.」 | 「专心看牌，大家同坐一张桌。」 | 由原两句收敛为一句 |
| 「No venue to book. No chips to count out. Just a table with room for your friends.」 | **删第三句**，保留：「不用订场地，不用数筹码。」 | 英文第三句是总结性 marketing filler，中文里像凑字数 |
| 「The hopeful flop. The unexpected river. The friend who definitely has it this time. Real poker moments, play-money chips.」 | 保留前三个排比（这是灵魂），**删末句**，把 play-money 交给 FAQ 和页脚说 | 末句与首句语义重叠 |
| 「A place to play. A reason to hang out.」 | 意译为「能打牌，也能待着。」 | 直译「一个游玩的场所，一个相聚的理由」即 AI 味范本——正好用作团队对照教材 |
| meta description / og:description | **≤ 40 字**：「和朋友开私密德州牌局，语音聊天、牌局回放。纯娱乐筹码。」 | 分享文案被截断是硬约束，不是风格选择 |
| 「Inside 4AM — an example room」 | 「4AM 实拍 —— 示例房间」 | 短、清楚 |
| 三个步骤小标题 | 「开一桌，变成你的场子」「把链接丢进群聊」「发牌，闲聊，再来一局」 | 动词开头、口语量词「一桌」，去掉翻译腔 |

### 3.3 Emoji 政策

| 区域 | 规则 |
|---|---|
| 落地页 / 系统 UI / 错误提示 | **0 个 emoji**。英文源本身不用 emoji，靠图标（RemixIcon/Phosphor）承担视觉；中文不许「加料」。源码已有的 `✓` `🔁` `−` 等符号照抄位置保留 |
| 快捷聊天（QUICK_PHRASES）与表情贴纸（STICKERS） | emoji 是**内容不是装饰**，全部保留；只译文字部分，emoji 可按中文语感换同类（见  样例）。`gg` 不译，圈内通用 |
| 用户自定义快捷短语 placeholder | 保持「文字 + 单个 emoji」格式，与默认值同构 |
| 严禁 | 句尾叠加（「🎉🎉」）、emoji 当标点、错误提示用「❌」（用颜色和文案说话） |

---

## 4. 文案规范

### 4.1 数字与单位

- `fmt()`：改为 `Intl.NumberFormat('zh-CN')`，**保留千分位**（`1,234`），中文用户对逗号分组无障碍；≥ 10 万的大数只在图表里可用 `12.3 万`，牌桌金额不用（筹码不是人民币，折算成「万」反而乱）。
- 筹码/点数：只写数字，不写单位（`Call 200` →「跟 200」）。需要单位时用「筹码」二字，绝不用 ¥/$/元。
- 盲注结构：`10/20`，斜杠两侧不加空格。
- 百分比：`commissionRateLabel` 产出的 `1%`/`0.5%` 原样保留，不扩写。
- 秒：`${n}s` →「N 秒」（数字与「秒」之间加半角空格，见 4.5）；倒计时按钮内窄空间允许「Ns → 30s」保持「30 秒」。就绪倒计时示例：「30 秒后发牌」。
- 正负号：`+1,200` / `−300`（保留源用的 U+2212）。
- 日期/时间（全部走 `Intl.DateTimeFormat('zh-CN')`）：
  - 当天内：`14:05`（24 小时制，禁 PM/上午混排）
  - 当年：`10月1日`；跨年：`2026年10月1日`
  - 相对时间：**刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前**；超过 7 天回落到日期格式。`joined March 4` →「3月4日加入」。
  - 图表 `Mar 4` → `3/4` 或 `3月4日`，同一图表内一致。

### 4.2 插值占位符（红线）

- 模板变量名 **逐字保留**：`${n}`、`${rate}`、`no such user: ${fromUsername}` 里的 `${...}` 一律不动，只动周围的 prose。
- 中文可自由调整变量位置（中文没有英文的词序枷锁），但**禁止把一个变量拆进两个分句**。
- 服务器拼好的成品句（账本 note、abort reason、`Seat 3 chooses to run it 2 times`）走「短语库模板匹配」（6.2），匹配不到就**原样显示英文**——宁可露出英文，不可显示错误的中文。
- 徽章、按钮里英文源没有变量的，中文也不许加。

### 4.3 品牌与专名

- 「4AM Casino」「4AM」永远不译、不写成「凌晨4点赌场」。`4amcasino.com`、GitHub 链接、房间码（`ABC123`）、用户名、牌面记号（`Td`、`7-2`）、键名（`WASD`、`F`、`Esc`）均为**代码级文本，不动**。
- 「Texas Hold'em」→「德州扑克」，正文首次全称之后可用「德扑」。

### 4.4 标点与句尾

- 中文正文用全角 `，。！？：；（）`；数字、代码、单位保持半角。
- **按钮/标签/表头不加句号**；说明段落、错误信息、状态长句加。
- 引号用 `「」`（与源码中 `"I'm ready"` 的引用风格对应），嵌套用 `『』`；不用弯引号 “”。
- 破折号用 `——`，且每屏 ≤ 2 处（营销文案专属）。
- `✓`、`→`、`·` 分隔符按源码位置原样保留：「3/6 人就绪 · 30 秒后发牌」。

### 4.5 中英混排排版

- 中文与英文/数字之间加半角空格：「跟 200」「N 号位已就绪」「4AM 实拍」「10 秒后发牌」；`10/20`、`3/6` 这类紧凑计数不加。
- 全角标点前后不加空格。
- CSS 注意：`letter-spacing`、`tracking-wide` 类样式对 CJK 会产生难看空隙，本地化走查时逐处调整（尤其 `font-display` 标题与 `text-[10px]` 的 `<kbd>`）。

---

## 5. 样例翻译（EN → ZH，逐条对照真实源码）

### 5a. 设置页 `SettingsPage.tsx` + `KeyboardShortcuts.tsx`

**侧栏分组（SectionRail）**

| EN | ZH |
|---|---|
| Profile | 个人资料 |
| Table & play | 牌桌与对战 |
| Keyboard shortcuts | 快捷键 |
| Appearance | 外观 |
| Account & security | 账号与安全 |
| Merge accounts | 账号合并 |
| Session | 登录状态 |

**页头与卡片标题/描述**

| EN | ZH |
|---|---|
| Settings | 设置 |
| Signed in as {name}. Who you are at the table, and how the table behaves for you. | 已登录：{name}。你是什么样的玩家，牌桌就怎么配合你。 |
| Loading your profile… | 正在加载你的资料… |
| Keyboard shortcuts — Your quick actions, saved to your account. | 快捷键 —— 你的快捷操作，保存在账号里。 |
| Appearance — Choose light or dark. Your preference is saved on this device. | 外观 —— 浅色或深色，只记在这台设备上。 |
| Account & security — Your password derives the key that signs your cards, right here in this browser. Nothing on this card is ever sent to the server in the clear. | 账号与安全 —— 你的密码在这个浏览器里推导出为牌签名的密钥；本页任何内容都不会明文发给服务器。 |
| Merge accounts — Combine two accounts that belong to the same person. Once a platform admin approves it, everything moves to the account you keep. | 账号合并 —— 把同一个人的两个账号合成一个。平台管理员批准后，东西全进保留的那个账号。 |
| Session — Signing out clears your keys from this browser. You get them back by logging in again with the same password. | 登录状态 —— 退出会清空这个浏览器里的密钥，用同一个密码重新登录就能找回。 |
| Sign out | 退出登录 |

**合并表单**

| EN | ZH |
|---|---|
| Moves everything the first account owns to the second, then retires the first. Use this when the same person ended up with two accounts. A platform admin reviews every request before anything happens. | 把第一个账号的东西全部转给第二个，然后注销第一个。同一个人不小心有了两个账号时用它。所有申请都要平台管理员过目才会生效。 |
| Username to retire / Username to keep | 要注销的用户名 / 要保留的用户名 |
| Note for the platform (optional) — Why these are the same person | 给平台的备注（可选）—— 说明这两个为什么是同一个人 |
| Enter both usernames. | 两个用户名都要填。 |
| Request sent to the platform for approval. | 申请已发给平台，等审批。 |
| Could not send that request. | 申请没发出去，稍后再试。 |
| Send merge request / Sending… | 提交合并申请 / 正在提交… |

**快捷键面板（含 shared/pokerHotkeys.ts 校验错误）**

| EN | ZH |
|---|---|
| Fold / Check / Call / Bet / raise / Half pot / Pot / All-in | 弃牌 / 过牌 / 跟注 / 下注·加注 / 半池 / 满池 / 全下 |
| Fold immediately on your turn. | 轮到你时直接弃牌。 |
| Check only when nothing is owed. | 无需跟注时才能过牌。 |
| Call the amount shown on your turn. | 轮到你时按显示的金额跟注。 |
| Edit the amount, then Enter to confirm. | 可改金额，回车确认。 |
| Select half pot, then Enter to confirm. | 选半池，回车确认。 |
| Select pot size, then Enter to confirm. | 选满池，回车确认。 |
| Select your full stack, then Enter to confirm. | 选全部筹码，回车确认。 |
| Enable keyboard shortcuts | 启用快捷键 |
| Shortcuts work on your turn. They pause while you type, open a menu or dialog, or wait for the server. | 快捷键在轮到你时生效；输入文字、打开菜单或弹窗、等待服务器时会暂停。 |
| None | 无 |
| Recording cancelled. | 已取消录制。 |
| {Action} set to {key}. Save to apply. | 「{动作}」已设为 {key}，保存后生效。 |
| Choose a letter or number, optionally with Shift. Browser shortcuts are reserved. | 请选一个字母或数字，可加 Shift。浏览器自带快捷键不可用。 |
| Keyboard shortcuts saved to your account. | 快捷键已保存到账号。 |
| Could not load your keyboard shortcuts. | 没能加载你的快捷键设置。 |
| Press a key for {action}. Escape cancels; Backspace clears. | 按下要绑定「{动作}」的键。Esc 取消，Backspace 清除。 |
| Listening… / Record | 按键捕捉中… / 录制 |
| Save shortcuts / Saving… / Restore defaults | 保存快捷键 / 保存中… / 恢复默认 |
| Defaults restored. Save to apply. | 已恢复默认，保存后生效。 |
| Invalid shortcut settings. | 快捷键设置无效。 |
| Include every action, or clear its shortcut. | 每个动作都要绑定，或者清空绑定。 |
| Use a letter or number, optionally with Shift. | 请用字母或数字，可加 Shift。 |

### 5b. 登录 / 注册 / 找回 `LoginPage.tsx`

| EN | ZH |
|---|---|
| 4AM Casino（标题） | 4AM Casino（不译） |
| Platform sign in | 平台账号登录 |
| Hold'em with friends. Nobody sees your cards. Not even the house. | 和朋友来一局德扑。没人看得到你的底牌——平台也不行。 |
| Use your 4AM Casino platform account to manage the casino. | 用 4AM Casino 平台账号管理平台。 |
| You were invited to a table ({code}). Log in or create an account and we'll seat you straight away. | 你收到了一张牌桌的邀请（{code}）。登录或注册后，马上入席。 |
| Your session has expired. Sign in again to continue. | 登录状态已过期，请重新登录。 |
| Log in / Register / Create account | 登录 / 注册 / 创建账号 |
| Reset my password | 重设密码 |
| Forgot your password? / ← Back to log in | 忘记密码？ / ← 返回登录 |
| Username / Password / New password / Repeat new password | 用户名 / 密码 / 新密码 / 再输一遍新密码 |
| Recovery code (XXXXXX-XXXXXX-…) | 恢复码（XXXXXX-XXXXXX-…）（格式原样） |
| Enter the recovery code you saved when you set up the account. It works once, and it issues you a brand-new signing key — your old hands stay verifiable either way. | 输入建号时保存的恢复码。它只能用一次，会为你签发一把全新的签名密钥——旧的牌局依旧可以验证。 |
| Deriving your keys… | 正在推导你的密钥… |
| Creating account… / Recovering… / Signing in… | 正在创建账号… / 正在恢复… / 正在登录… |
| ✓ Account created. Dealing you in… | ✓ 账号建好了，马上发你入桌… |
| ✓ Signed in. Dealing you in… | ✓ 登录成功，发牌了… |
| ✓ Seating you at the table… | ✓ 正在带你入席… |
| ✓ Signed in. Opening dashboard… | ✓ 登录成功，正在打开后台… |
| Username or password is incorrect.（'bad credentials'） | 用户名或密码不对。 |
| Could not sign in. Try again. | 没能登录，再试一次。 |
| the new passwords do not match | 两次输入的新密码不一样 |
| that recovery code looks too short | 恢复码看着不完整，再检查一下 |
| Your password also derives your card-signing key in this browser. It is never sent to the server. | 你的密码同时在这个浏览器里推导出签名密钥，密码本身从不发给服务器。 |
| How can an online deck be fair? Watch the 60-second explainer | 线上洗牌怎么做到公平？看 60 秒说明 |
| Back to 4AM Casino | 返回 4AM Casino |

（配套服务器错误走短语库：`no such user` → 查无此人? 不——「没有这个用户名」；`username taken` →「用户名已被占用」；`wrong password` →「密码不对」；`that recovery code does not match` →「恢复码不正确」。）

### 5c. 个人资料 `ProfileDialog.tsx`（含默认快捷短语）

| EN | ZH |
|---|---|
| Profile — Your face and name at the table, and the phrases you can fire into chat in one tap. | 个人资料 —— 牌桌上的头像和名字，还有那些一点就能甩进群聊的话。 |
| Table & play — How the felt looks and sounds for you, and what other players get to see. | 牌桌与对战 —— 桌布长什么样、有什么声音，以及别人能看到你的什么。 |
| Change photo / Remove | 更换头像 / 移除 |
| Display name | 昵称 |
| Bio — placeholder "Tight is right." | 个性签名 —— 示例：「紧得稳，赢得狠。」 |
| Your quick chat phrases (one per line, max 8) | 快捷聊天短语（每行一条，最多 8 条） |
| placeholder: nice hand 👏 / bluff! 🤨 / run it again 🔁 | 示例：这手漂亮 👏 / 诈的！🤨 / 再来一手 🔁 |
| 默认 QUICK_PHRASES: nice hand 👏 / bluff! 🤨 / run it again 🔁 / ouch 💀 / gg / so lucky 🍀 | 这手漂亮 👏 / 诈的！🤨 / 再来一手 🔁 / 这也能输 💀 / gg / 手气真好 🍀 |
| Deck style: indigo / crimson / emerald / slate | 牌背样式：靛蓝 / 酒红 / 翠绿 / 岩灰 |
| 4-color deck | 四色牌 |
| Auto-join: when a friend invites me to a table, add me right away instead of asking. | 自动入桌：朋友邀请我时直接坐下，不再问我。 |
| Auto ready: deal me into every hand without asking. Skips the "I'm ready" check — turn it off if you want a beat to step away between hands. | 自动就绪：每手牌直接发给我，跳过「我准备好了」确认。想每手之间缓口气就关掉。 |
| Private mode: hide my winnings from other players. Leaderboards, the session report, and the chip-leader crown skip you; bankers still see everything so the group can settle up. | 私密模式：不让别人看到你的输赢。排行榜、战绩小结和筹码王皇冠都会跳过你；账房照常全览，方便大家结账。 |
| Game sounds / Volume / Test | 游戏音效 / 音量 / 试听 |
| Save profile / Saving… / ✓ Saved. | 保存资料 / 保存中… / ✓ 已保存 |
| Deck and sound apply instantly. | 牌背和音效即时生效。 |
| upload failed / could not save | 头像上传失败 / 没能保存 |

### 5d. 牌桌操作条 `ActionBar.tsx`（+ 相邻关键状态行）

| EN | ZH |
|---|---|
| Your turn. | 轮到你了。 |
| Fold / Check / Call {n} / Bet {n} / Raise to {n} / Raise | 弃牌 / 过牌 / 跟 {n} / 下注 {n} / 加注至 {n} / 加注 |
| Check / Fold（预操作合并态） | 过牌·弃牌 |
| Call any | 有注就跟 |
| Ahead of turn（图标 aria-label） | 提前操作 |
| Arms now, acts on your turn | 先挂上，轮到你自动执行 |
| Raising unlocks on your turn | 轮到你才能加注 |
| Min / ⅓ pot / ½ pot / ¾ pot / Pot / All-in | 最小 / ⅓ 池 / ½ 池 / ¾ 池 / 满池 / 全下 |
| Sending… | 发送中… |
| Show cards | 亮牌 |
| Start hand / Deal hand | 开一手 / 发牌 |
| I'm ready · {n}s | 我准备好了 · {n} 秒 |
| ✓ You are ready / Ready check | ✓ 已就绪 / 就绪确认 |
| {a}/{b} ready · deals in {n}s, without the rest | {a}/{b} 人就绪 · {n} 秒后发牌，不等其余 |
| Out of chips. Chips menu → Buy points. | 筹码打光了。打开「筹码」菜单 → 买点数。 |
| Automatic ready check soon… | 马上自动发起就绪确认… |
| Auto-deal paused. Table menu → Auto-deal. | 自动发牌已暂停。去「牌桌」菜单 → 自动发牌 开启。 |
| Deal when ready. | 准备好就发牌。 |
| Waiting for two online players with chips… | 还差一位在线且有筹码的玩家才能开牌… |
| Host deals soon… | 等房主发牌… |
| Holding ~40s for {names}… | {names} 掉线了，这手牌等他们约 40 秒… |
| Shuffling… | 洗牌中… |
| Your bet / Your bet this street | 你的下注 / 本轮已投入 |
| Your balance. Bought {n} total. | 余额。累计买入 {n}。 |
| Bet amount / Raise to / Enter to confirm | 下注金额 / 加注至 / 回车确认 |
| Enter an amount. | 请输入金额。 |
| 🔁 Run it how many times?（MultiRunPrompt） | 🔁 发几次牌？ |
| Could not send your action. | 操作没发出去，再试一次。 |
| Seat {n} chooses to run it {count} times（replay 旁白） | {n} 号位选择跑 {count} 次 |

### 5e. 落地页 `LandingPage.tsx` —— 英雄区、三步、FAQ（已按 3.2 删减）

**英雄区**

| EN | ZH |
|---|---|
| H1: Your people. / Your poker night. | 自己人。/ 自己的牌局。 |
| Pull up a chair. Play a few hands. Stay for the conversation. Your favourite group chat now has a poker table. | 找个位置坐下，打几手牌，留下来聊聊天。你最常聊的那个群，现在也有牌桌了。 |
| Start a table / Open your lobby | 开一桌 / 去大厅 |
| Play-money poker. / Right in your browser. | 纯娱乐筹码。/ 浏览器直接开打。 |
| Have a room code? Join your friends → | 有房间码？进朋友的桌 → |
| Private rooms / Voice & chat / Hand replays | 私密房间 / 语音和文字 / 牌局回放 |

**三步（含小标题下压成一个动词短句）**

| EN | ZH |
|---|---|
| The plan is simple. / Get everyone in. | 计划很简单。/ 先把人喊来。 |
| No venue to book. No chips to count out. | 不用订场地，不用数筹码。 |
| Make tonight poker night | 今晚就开牌 |
| 1. Make it your table. — Create a private room and choose your blinds. The host gets things ready for the first hand. | ① 开一桌，变成你的场子。—— 建个私密房间，定好盲注，房主把第一手牌张罗好。 |
| 2. Drop the link in the chat. — Share the invite link or room code. Your friends sign in, join the room, and pick a seat. | ② 把链接丢进群聊。—— 邀请链接或房间码都行，朋友登录、进房、挑个位子。 |
| 3. Deal. Talk. Run it back. — Play Texas Hold'em together. React to a hand and run it back. | ③ 发牌，闲聊，再来一局。—— 一起打德州扑克，甩个表情，再来一局。 |

**中段与收尾**

| EN | ZH |
|---|---|
| All the tension. / None of the stakes. | 该心跳的一样不少，/ 真钱一分没有。 |
| The hopeful flop. The unexpected river. The friend who definitely has it this time.（末句删） | 盼翻牌，怕河牌，还有那个每次都说「这把有牌」的朋友。 |
| Keep your focus on the cards, with everyone at the same table. | 专心看牌，大家同坐一张桌。 |
| Good games. / Nothing swept under the table. | 牌局要爽，/ 更要摊得开。 |
| An encrypted deal, a record of every chip, and replays for the hands you're still talking about. | 加密发牌、每一枚筹码都有账，那些你们聊到半夜的牌局都能回放。 |
| Read the fair-play guide | 看公平玩法说明 |
| Your cards stay yours. — Players participate in an encrypted shuffle… | 底牌只属于你。—— 发牌由全员参与的加密洗牌完成，怎么验证请看公平玩法说明。 |
| The night adds up. — Follow buy-ins, chip transfers, and settlement in the room ledger… | 一夜都有账。—— 买入、转账、结账都在房间账本里，打完的牌还能翻回放。 |
| Open source. Open to a closer look. | 开源，欢迎细看。 |
| Before you sit down.（FAQ 标题） | 上桌之前。 |
| Same friends. / New favourite place. | 还是那帮人。/ 多了个新据点。 |
| Someone has to start the group chat. Make it you. | 总得有人攒局。这次就你来。 |
| For the love of the game. Play-money only. | 因为爱牌。纯娱乐，无真钱。 |

**FAQ**

| EN | ZH |
|---|---|
| Is this real-money poker? — No. 4AM uses play-money chips. It does not take deposits, pay out winnings, or process real-money bets. | 这是真钱扑克吗？—— 不是。4AM 只用娱乐筹码：不收存款，不提现，不经手任何真钱。 |
| Does everyone need to download an app? — No download is needed. Open 4AM in your browser, sign in, and join your friend's table using its invite link or room code. | 每个人都要装 App 吗？—— 谁都不用装。浏览器打开 4AM，登录，凭邀请链接或房间码进桌。 |
| Can we talk while we play? — Yes. Rooms have text chat and voice controls. You can also react at the table. | 打牌时能说话吗？—— 能。房间有文字聊天和语音控制，还可以在牌桌上甩个表情。 |
| How can I check what happened in a hand? — Finished hands have replays and a recorded action history… | 想复盘某一手怎么办？—— 打完的牌局有回放和完整的操作记录，筹码流向看房间账本；加密发牌和验证的说明在公平玩法页。 |

**静态 head（index.html，`lang="zh-CN"`）**

| EN | ZH |
|---|---|
| title: 4AM Casino — your people, your poker night | 4AM Casino —— 自己人，自己的牌局 |
| meta/og description（≤40 字） | 和朋友开私密德州牌局：语音聊天、牌局回放。纯娱乐筹码，浏览器直接开打。 |

---

## 6. 机制建议（实现路径）

### 6.1 结论：推荐 **B+（英文原句作键的 zh 词典 + t()）**，坚决不用纯 A，暂不上 C

三个候选的裁决：

- **A（源头就地改中文字面量）——否。** 仓库是活跃开源项目（`github.com/notpritam/4amcasino`，注释里多处「requested by notpritam」），upstream 更新是主要成本来源。就地改 2050 处字面量 = 每次上游同步都在全仓库打架；术语一致性也无法审计（改完就散在 300 个文件里）。
- **C（服务器改发错误码 + 客户端词典）——暂缓。** 有一个 A/B 都绕不开、但 C 尤其无解的事实：**账本 note、abort reason 等 prose 已经作为数据持久化在 DB 里**（`paid the 7-2 offsuit bounty` 这种历史行），错误码救不了历史数据，只有「拿英文原句反查词典」能。C 需要的协议改造、server 与 web 双侧改动，对"只做中文"的产品收益不抵成本。若未来真要多语言，再对**新增**接口逐步引入码。
- **B+（推荐）**：web 侧 `t(英文原句, 变量?)`，词典键就是英文文本本身。

### 6.2 B+ 的具体形态

1. **抽取**：用 ast-grep/jscodeshift 半自动把 TSX 文本节点与用户可见属性包进 `t("Your turn.")`。**键 = 英文原文**，这一条决定全方案的上游友好性：
   - 上游新增句子 → 词典查不到 → **回退显示英文**（永远不出错、不会白屏），且可用脚本列出未命中键当作待译清单；
   - 上游改动句子 → 只在该行 t() 处可能冲突，且 codemod 可对 diff 重跑；
   - 术语一致性可集中审计（词典就是唯一的真相源 + 走查面）。
   - 需人工二次处理的只有"拼句式"文案（如 replay 的 `Seat N chooses to run it {count} times`），改成整句模板键 + 变量。
2. **服务器 prose**：不改协议。让 `packages/shared` 把 server 现在散发的散文字面量收口成导出常量（server 引用、web 词典同源），客户端 `tr(enText)`：精确匹配 → 模板匹配（正则捕获 `${name}` 等）→ 原样回退。这一层同样覆盖 ledger `kind` 徽章与 note、`hand_abort.reason`、`betting.ts` 抛出的 `minimum is ${x}` / `raise rights closed` 等。**注意 server 端 prose 大小写风格不统一（`invalid input` vs `Invalid agent access settings.`），短语库键要归一化匹配（trim + 首字母不敏感），但输出遵循中文规范。**
3. **Canvas 文案**（shareCard.ts / replayGif.ts）：同一 `tr()`，外加两条专属规则——① 画布版词典允许更短的变体键（`POT 1,200` → 「底池 1,200」；`RUN 2` → 「第 2 跑」；`4amcasino.com · provably fair` → 「4amcasino.com · 发牌可验证」）；② 现有 `.slice(0, 40)` / `ellipsize` 对 CJK 依然可用（slice 按码点截断没问题），但**字体栈必须补 CJK**：`Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`，否则导出图是豆腐块；GIF/分享图上的中文建议同步做一次字重与描边检查。
4. **格式化**：`fmt()` 换 `Intl.NumberFormat('zh-CN')`（行为几乎不变，保住占位）；把散落的 27 处裸 `toLocaleString()/toLocaleDateString()/toLocaleTimeString()` 收口到 `shared/lib/datetime.ts` 三个 helper（`fmtTime/fmtDate/fmtRelative`，统一 zh-CN 与 4.1 的相对时间规则）。这是纯机械 codemod，零上游冲突面。
5. **静态 head**：`index.html` 的 title/meta/og 与 `lang="zh-CN"` 单独维护一份中文常量（Vite 构建期注入或部署时替换均可，改动只在 1 个文件）；OG 图不带英文标语则无需重绘。
6. **键名残留排查**：CI 加一条 grep——`src/pages|features|widgets` 下未被 `t()` 包裹、含英文句子的 JSX 文本，输出报告不阻塞；每迭代清零。
7. **上线顺序**：设置/登录/资料（a–c，先定术语基调）→ 牌桌 HUD 与状态行（d，日活核心）→ shared/server prose 短语库（影响面大但机械）→ 落地页（最后做，需要创意审校轮）→ canvas 与格式化。
8. **QA**：伪 locale 超长串测试（中文一般比英文短，风险在按钮换行）、`letter-spacing`/`tracking` 对 CJK 的回归检查、canvas 中文导出截图走查、未命中键清单。

### 6.3 一句话理由

在"只做中文、上游持续更新、服务器发散文、历史数据里存着英文"这四个约束下，**以英文原文为键的客户端词典是唯一同时满足：零协议改动、可追溯历史数据、上游改动最坏情况只是露出英文（而非错误中文或 merge 地狱）的方案**。

---

*设计依据文件：SettingsPage.tsx、KeyboardShortcuts.tsx、LoginPage.tsx、ProfileDialog.tsx、ActionBar.tsx、LandingPage.tsx、ChatPanel.tsx、TablePage.tsx、gameClient.ts、replay.ts、LedgerPage.tsx、shared/{evaluate,betting,commission,pokerHotkeys,cards}.ts、apps/web/shared/lib/cn.ts、server/{game,rooms,ledger,settle,rake,account,admin,profile}.ts、apps/web/index.html。未改动任何源码。*

---

## 附录 A. 历史术语迁移（非现役）

以下为早期"run it twice / 跑两次牌"的二元投票术语，**已被 multi-run 协议取代**
（`run_count_choice` / `run_count_agree`，1–3 次，落后方选次数、领先方同意）。仅作历史资料保留，
不得作为现役文案依据：

| 历史英文串 | 历史译法 | 现役对应 |
| --- | --- | --- |
| `🔁 Run it twice?` / `🔁 Run it twice? · {n}s` | 跑两次？ | `🔁 Run it how many times?`（「🔁 发几次牌？」） |
| `Seat {n} votes to run it {twice\|once}` | {n} 号位选择跑{两遍\|一遍} | `Seat {n} chooses to run it {count} times`（「{n} 号位选择跑 {count} 次」） |
| `votes to run it twice` | 投票跑两次 | `chooses to run it {count} times` |
