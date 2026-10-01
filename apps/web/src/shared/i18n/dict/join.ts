// Share-link landing `/j/:code` (JoinPage). The room code itself is code-level
// text (docs/zh-i18n.md §4.3) and renders untranslated. Errors thrown by
// api.joinRoom() are server prose already run through tr() in shared/api.ts;
// t(error) here catches the two client-generated fallbacks below.
// Reused, NOT redefined: 'Username' etc. live in dict/login.ts.
const join: Record<string, string> = {
  "Couldn't join": '进桌失败',
  'that link is missing its table code': '这个链接没带牌桌房间码',
  'could not join that table': '没能进这张牌桌，再试一次',
  'Go to the lobby': '前往大厅',
  'Signed in as {username} — use a different account': '已登录 {username}，换一个账号',
  'Taking you to the table…': '正在带你入席…',
};

export default join;
