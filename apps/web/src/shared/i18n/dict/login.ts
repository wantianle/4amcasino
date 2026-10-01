// Login / register / recovery dictionary (LoginPage).
// Keys are the exact English source strings (B+ scheme, docs/zh-i18n.md §6.2).
// The trailing block holds server-prose phrases (docs/zh-i18n.md §5b note):
// `tr()` in shared/api.ts finds them via first-character-normalized matching;
// untranslated variants fall back to English on purpose — never wrong Chinese.
const login: Record<string, string> = {
  'Platform sign in': '平台管理登录',
  "Hold'em with friends. Nobody sees your cards. Not even the house.":
    '和朋友来一局德扑。没人看得到你的底牌——平台也不行。',
  'Use your 4AM Casino platform account to manage the casino.':
    '用 4AM Casino 平台账号管理整个场子。',
  "You were invited to a table ({code}). Log in or create an account and we'll seat you straight away.":
    '你收到了一张牌桌的邀请（{code}）。登录或注册后，直接带你入席。',
  'Your session has expired. Sign in again to continue.': '登录状态已过期，请重新登录。',

  'Log in': '登录',
  Register: '注册',
  'Create account': '创建账号',
  'Reset my password': '重设密码',
  'Forgot your password?': '忘记密码？',
  '← Back to log in': '← 返回登录',

  Username: '用户名',
  Password: '密码',
  'New password': '新密码',
  'Repeat new password': '再输一遍新密码',
  'Recovery code (XXXXXX-XXXXXX-…)': '恢复码（XXXXXX-XXXXXX-…）',
  'Enter the recovery code you saved when you set up the account. It works once, and it issues you a brand-new signing key — your old hands stay verifiable either way.':
    '输入建号时保存的恢复码。它只能用一次，会为你签发一把全新的签名密钥——旧的牌局依旧可以验证。',

  'Deriving your keys…': '正在推导你的密钥…',
  'Creating account…': '正在创建账号…',
  'Recovering…': '正在恢复…',
  'Signing in…': '正在登录…',
  '✓ Account created. Dealing you in…': '✓ 账号建好了，这就拉你入桌…',
  '✓ Signed in. Dealing you in…': '✓ 登录成功，发牌了…',
  '✓ Seating you at the table…': '✓ 正在带你入席…',
  '✓ Signed in. Opening dashboard…': '✓ 登录成功，正在打开后台…',

  'Username or password is incorrect.': '用户名或密码不对。',
  'Could not sign in. Try again.': '没能登录，再试一次。',
  'the new passwords do not match': '两次输入的新密码不一样',
  'that recovery code looks too short': '恢复码看着不完整，再检查一下',

  'Your password also derives your card-signing key in this browser. It is never sent to the server.':
    '你的密码同时在这个浏览器里推导出签名密钥，密码本身从不发给服务器。',
  'How can an online deck be fair? Watch the 60-second explainer':
    '线上洗牌怎么做到公平？看 60 秒说明',
  'Back to 4AM Casino': '返回 4AM Casino',

  // Server prose (§5b 配套短语库). tr() trims and ignores first-char case.
  // dict/server.ts owns the auth phrase set — 'no such user', 'username taken',
  // 'wrong password', 'that recovery code does not match' are defined there with
  // 句号 endings (错误信息收尾加标点, §4.4) and win the global merge; do not
  // restate them here.
  'bad credentials': '用户名或密码不对。',
};

export default login;
