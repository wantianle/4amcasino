// Profile dictionary (ProfileDialog.tsx / ProfileEditor: identity + table & play).
// Keys are the exact English source strings (B+ scheme, docs/zh-i18n.md §6.2);
// §5c translations are used verbatim where the doc provides them.
// The section-card titles ('Profile', 'Table & play') and 'Saving…' are defined
// in dict/settings.ts and resolve through the merged dictionary.
const profile: Record<string, string> = {
  // Card descriptions (§5c)
  'Your face and name at the table, and the phrases you can fire into chat in one tap.':
    '牌桌上的头像和名字，还有那些一点就能甩进群聊的话。',
  'How the felt looks and sounds for you, and what other players get to see.':
    '桌布长什么样、有什么声音，以及别人能看到你的什么。',

  // Identity block (§5c)
  'Change photo': '更换头像',
  Remove: '移除',
  'Display name': '昵称',
  'Up to {n} columns wide — Chinese counts as two. Leave empty to use your username.':
    '最多 {n} 个字符宽——中文算两个。留空则使用你的用户名。',
  'Nicknames may only use Chinese, Latin letters, digits, _ @ - · and emoji.':
    '昵称只能使用中文、英文字母、数字、_ @ - · 和 emoji。',
  'Nickname must be 16 characters wide or fewer (Chinese counts as two).':
    '昵称最宽 16 个字符（中文算两个）。',
  Bio: '个性签名',
  'Tight is right.': '紧得稳，赢得狠。',
  'Your quick chat phrases (one per line, max 8)': '快捷聊天短语（每行一条，最多 8 条）',
  'Your quick chat phrases': '快捷聊天短语',
  'nice hand 👏\nbluff! 🤨\nrun it again 🔁': '这手漂亮 👏\n诈的！🤨\n再来一手 🔁',

  // Table & play block (§5c)
  'Deck style': '牌面与牌背样式',
  'Card back': '牌背',
  'Card face': '牌面',
  'Table skin': '牌桌皮肤',
  'indigo card back': '靛蓝牌背',
  'crimson card back': '酒红牌背',
  'emerald card back': '翠绿牌背',
  'slate card back': '岩灰牌背',
  'wine-lattice card back': '酒红格纹牌背',
  'black-gold card back': '黑金牌背',
  'classic-red-blue card back': '经典红蓝牌背',
  'geometry card back': '几何牌背',
  'deep-blue-silver card back': '深蓝银牌背',
  'gg-four-color card face': '四色竞技牌面',
  'gg-solid card face': '纯色竞技牌面',
  'classic-large card face': '经典大字牌面',
  'jumbo-accessible card face': '无障碍特大牌面',
  'minimal card face': '极简牌面',
  'gg-green table skin': '竞技绿毡',
  'sapphire table skin': '午夜蓝毡',
  'burgundy table skin': '酒红丝绒',
  'classic-casino table skin': '经典赌场',
  'Auto-join: when a friend invites me to a table, add me right away instead of asking.':
    '自动入桌：朋友邀请我时直接坐下，不再问我。',
  'Auto ready: deal me into every hand without asking. Skips the "I\'m ready" check — turn it off if you want a beat to step away between hands.':
    '自动就绪：每手牌直接发给我，跳过「我准备好了」确认。想每手之间缓口气就关掉。',
  'Private mode: hide my winnings from other players. Leaderboards, the session report, and the chip-leader crown skip you; bankers still see everything so the group can settle up.':
    '私密模式：不让别人看到你的输赢。排行榜、战绩小结和筹码王皇冠都会跳过你；账房照常全览，方便大家结账。',
  'Game sounds': '游戏音效',
  Volume: '音量',
  'Sound volume': '音量',
  Test: '试听',

  // Save bar (§5c)
  'Save profile': '保存资料',
  '✓ Saved.': '✓ 已保存',
  'Saved.': '已保存',
  'Deck and sound apply instantly.': '牌背和音效即时生效。',
  'upload failed': '头像上传失败',
  'could not save': '没能保存',
};

export default profile;
