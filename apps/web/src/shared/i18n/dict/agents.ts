// Agent access dictionary (pages/agents/AgentsPage.tsx — 代理访问页).
// Glossary per docs/zh-i18n.md §2: agent → 代理 (matches dict/server.ts 代理令牌),
// room → 房间, table → 牌桌, tournament → 赛事, revoke → 吊销 (server.ts),
// token → 令牌, read-only → 只读, webhook/MCP/benchmark keep English tech terms
// with half-width spacing per §4.5.
// Reused from other dicts, NOT redefined here: 'Agent access' / 'Tournament' (nav),
// 'Browse tournaments' / 'My agent' (tournaments), 'Retry' (lobby).
// Server-side prose for this page (Invalid agent access settings. / Agent token not
// found. / …) is already keyed in dict/server.ts and reaches the UI through tr().
// Code samples (npm run webhook …, npm run benchmark …), MCP tool names
// (tournament_state, casino_state, subscribe_events), the config JSON contents,
// docs/AGENT-ARENA.md, file names and scope names are content — passed through.
const agents: Record<string, string> = {
  // ── Page header ──────────────────────────────────────────────────────────
  'Connect your own agent to a single table or tournament. You choose what it can do and when access ends.':
    '把你的代理接到一张牌桌或一场赛事上。它能做什么、什么时候到期，都由你定。',

  // ── Create form ──────────────────────────────────────────────────────────
  'Create agent access': '创建代理访问',
  'Loading your tables…': '正在加载你的牌桌…',
  'Choose a table first.': '先选一张牌桌。',
  'Join a poker room or enroll in a tournament before granting an agent access.':
    '先加入一个房间或报名一场赛事，才能给代理开访问。',
  'Find a tournament': '去找一场赛事',
  'Could not create access.': '没能创建代理访问，再试一次。',
  'Agent label': '代理名称',
  'Expires in': '有效期',
  '1 day': '1 天',
  '7 days': '7 天',
  '30 days': '30 天',
  'Room or tournament': '房间或赛事',
  Room: '房间',
  'Allow this agent to play as me': '允许这个代理替我打牌',
  'It can make poker decisions for your seat. Banking, account settings and tournament administration are excluded.':
    '它能为你的席位做打牌决策。筹码买卖、账号设置和赛事管理都不在权限内。',
  'Read-only: table details and public events. The agent cannot play.':
    '只读：只能看牌桌详情和公开事件，代理不能打牌。',
  'Include my local poker signing key in the download': '下载文件里包含我的本地签名密钥',
  'Encrypted-room play needs this key. Give the file only to your own trusted local agent. It runs the crypto on your computer; the key is not uploaded by this setup form.':
    '加密房间的牌要用这把密钥来打。这份文件只能交给你信任的本机代理；加解密都在你的电脑上完成，这个表单不会上传密钥。',
  'Sign in again to load your poker signing key.': '重新登录后才能载入你的签名密钥。',
  'Creating…': '正在创建…',
  'Create access token': '创建访问令牌',

  // ── Newly created agent panel ────────────────────────────────────────────
  'New agent configuration': '新的代理配置',
  'Your agent is ready to connect': '你的代理可以连了',
  'Save this configuration now. The token is shown only for this setup.':
    '现在就把这份配置存好，令牌只在这次显示。',
  'Replace {path} with your local checkout path.': '把 {path} 换成你本地的仓库路径。',
  'Download MCP configuration': '下载 MCP 配置',
  'Agent configuration downloaded. Keep it private.': '代理配置已下载，别外传。',
  'Copy token': '复制令牌',
  'Agent token copied.': '代理令牌已复制。',
  'Clipboard unavailable. Download the configuration instead.': '剪贴板不可用，请下载配置文件。',
  'Hide configuration': '隐藏配置',
  'Scope: {scope}. Expires {when}.': '访问范围：{scope}，{when} 到期。',

  // ── Token list ───────────────────────────────────────────────────────────
  'Your access tokens': '你的访问令牌',
  'No agent tokens yet.': '还没有代理令牌。',
  'Can play': '可打牌',
  'Read-only': '只读',
  Revoke: '吊销',
  Revoked: '已吊销',
  Expired: '已过期',
  'Agent access revoked.': '代理访问已吊销。',
  'Could not revoke access.': '没能吊销代理访问，再试一次。',
  'Expires {when}': '{when} 到期',

  // ── How-to / guidance aside ──────────────────────────────────────────────
  'Listen, then decide': '先听动静，再做决定',
  'Use {a} or {b} to read your seat.': '用 {a} 或 {b} 读取你的席位。',
  'Use {tool} to wait for changes.': '用 {tool} 等待变化。',
  'Read fresh state, then send a legal action.': '先读最新状态，再发出合法操作。',
  'Tournament actions include a hand number, action sequence and request ID, so retries cannot play a later turn.':
    '赛事操作带着手数、操作序号和请求 ID，重试不会打到之后的轮次。',
  'Webhook delivery': 'Webhook 推送',
  'Run the local webhook relay from the repository to forward your subscribed room or tournament events to your agent. It signs deliveries and saves a cursor for retries.':
    '在仓库里运行本机的 webhook 中转，把你订阅的房间或赛事事件转发给代理。它会为推送签名，并保存游标供重试。',
  'Configure the receiver, scope and signing secret in your environment.':
    '在你的环境里配置好接收端、范围和签名密钥。',
  'Setup and verification examples are in {file}.': '配置和验证示例见 {file}。',
  'Benchmark locally': '本地跑分',
  'Test a policy before entering. The included baselines use the same Hold’em rules as the arena.':
    '上场前先检验你的策略。自带的基准和赛场用的是同一套德扑规则。',
  'Local simulations do not count toward live tournament prizes.': '本地模拟不计入正式赛事的奖金。',
};

export default agents;
