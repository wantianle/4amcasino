// Navigation dictionary (widgets/nav/AppShell + app/App route fallback).
// Glossary per docs/zh-i18n.md §2: lobby → 大厅, table → 牌桌, settle up → 结账,
// Sign out/Log out → 退出登录, profile → 个人资料. Brand 「4AM Casino」 never
// translates; room names and usernames pass through as vars untranslated.
// Reused from other dicts, NOT redefined here: 'Settings' (settings),
// 'Leaderboard' (leaderboard), 'Settle up' (player), 'Table'/'Share'/'Decline'
// (table-page), 'Try again' (landing), 'Lobby'-style marketing lines (landing).
const nav: Record<string, string> = {
  // Rail items
  Lobby: '大厅',
  'Agent access': '代理访问',
  'My stats': '我的战绩',
  "How it's fair": '公平玩法',
  Admin: '后台',

  // Landmark aria-labels and section headers.
  // Reused, NOT redefined: 'Main navigation'/'Skip to content'/'Join table'
  // (landing), 'Retry' (lobby), 'Share'/'Table'/'Decline'/'No' (table-page),
  // 'Outstanding' (settle). 'Try again' (landing).
  'Account navigation': '账号导航',
  Sidebar: '侧边栏',
  'Your tables': '你的牌桌',
  'Your profile': '个人资料',

  // Log out (aria-label, dialog title, brand link)
  'Log out': '退出登录',
  'Could not log out. Check your connection and try again.':
    '没能退出登录。检查网络后再试一次。',

  // Search tools, drawer, and results
  Search: '搜索',
  'Search navigation': '搜索导航',
  'Search navigation (⌘K)': '搜索导航（⌘K）',
  'Search pages': '搜索页面',
  'Open navigation': '打开导航',
  'Expand sidebar': '展开侧栏',
  'Collapse sidebar': '收起侧栏',
  Navigation: '导航',
  'Go to': '前往',
  'Search pages and tables': '搜索页面和牌桌',
  'Search pages and tables…': '搜索页面和牌桌…',
  'Search results': '搜索结果',
  'No pages or tables match “{query}”.': '没有匹配「{query}」的页面或牌桌。',

  // Invites pill in the account section
  'Invites and friend requests': '邀请与好友申请',
  'Invites & requests': '邀请与申请',
  '{n} invites and friend requests': '{n} 条邀请与好友申请',

  // Composed aria-label templates ({var} passed in untranslated)
  '{label} ({n} waiting)': '{label}（{n} 项待处理）',
  '{name} (opens in a new tab)': '{name}（在新标签页打开）',
  '4AM Casino lobby': '4AM Casino 大厅',

  // App route fallback (app/App.tsx). 'You' is already defined in
  // dict/table.ts ('你') and wins merge order — not redefined here.
  'Loading…': '正在加载…',
};

export default nav;
