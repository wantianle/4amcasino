// Spectator link resolver `/watch/:token` (WatchPage). api.watch() rejects with
// tr()'d server prose (shared/api.ts), so t(error) only needs the client
// fallback below — e.g. 'no such watch link' is already covered in
// dict/server.ts. Viewer word follows the glossary: watch → 观战 (§2.2).
const watch: Record<string, string> = {
  'could not open the watch link': '观战链接没能打开，再试一次',
  'Opening the table…': '正在打开牌桌…',
  'Back to the lobby': '返回大厅',
};

export default watch;
