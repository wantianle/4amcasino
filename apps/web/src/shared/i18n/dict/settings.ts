// Settings dictionary (SettingsPage, KeyboardShortcuts, PokerShortcutButton).
// Keys are the exact English source strings (B+ scheme, docs/zh-i18n.md §6.2);
// §5a translations are used verbatim where the doc provides them.
// The section-rail titles (Profile / Table & play / …) live here and are also
// reused by ProfileDialog's cards via the merged dictionary.
const settings: Record<string, string> = {
  // Page shell: title, header, section rail
  Settings: '设置',
  'Settings sections': '设置分组',
  'Loading your profile…': '正在加载你的资料…',
  'Signed in as {name}. Who you are at the table, and how the table behaves for you.':
    '已登录：{name}。你是什么样的玩家，牌桌就怎么配合你。',
  Profile: '个人资料',
  'Table & play': '牌桌与对战',
  'Keyboard shortcuts': '快捷键',
  Appearance: '外观',
  'Account & security': '账号与安全',
  'Merge accounts': '账号合并',
  Session: '登录状态',

  // Card descriptions (§5a)
  'Your quick actions, saved to your account.': '你的快捷操作，保存在账号里。',
  'Choose light or dark. Your preference is saved on this device.': '浅色或深色，只记在这台设备上。',
  'Your password derives the key that signs your cards, right here in this browser. Nothing on this card is ever sent to the server in the clear.':
    '你的密码在这个浏览器里推导出为牌签名的密钥；本页任何内容都不会明文发给服务器。',
  'Combine two accounts that belong to the same person. Once a platform admin approves it, everything moves to the account you keep.':
    '把同一个人的两个账号合成一个。平台管理员批准后，东西全进保留的那个账号。',
  'Signing out clears your keys from this browser. You get them back by logging in again with the same password.':
    '退出会清空这个浏览器里的密钥，用同一个密码重新登录就能找回。',
  'Sign out': '退出登录',

  // Merge accounts form (§5a)
  'Moves everything the first account owns to the second, then retires the first. Use this when the same person ended up with two accounts. A platform admin reviews every request before anything happens.':
    '把第一个账号的东西全部转给第二个，然后注销第一个。同一个人不小心有了两个账号时用它。所有申请都要平台管理员过目才会生效。',
  'Username to retire': '要注销的用户名',
  'Username to keep': '要保留的用户名',
  username: '用户名',
  'Note for the platform (optional)': '给平台的备注（可选）',
  'Why these are the same person': '说明这两个为什么是同一个人',
  'Enter both usernames.': '两个用户名都要填。',
  'Request sent to the platform for approval.': '申请已发给平台，等审批。',
  'Could not send that request.': '申请没发出去，稍后再试。',
  'Send merge request': '提交合并申请',
  'Sending…': '正在提交…',

  // Shortcut action labels and descriptions (§5a)
  Fold: '弃牌',
  Check: '过牌',
  Call: '跟注',
  'Bet / raise': '下注·加注',
  'Half pot': '半池',
  Pot: '满池',
  'All-in': '全下',
  'Fold immediately on your turn.': '轮到你时直接弃牌。',
  'Check only when nothing is owed.': '无需跟注时才能过牌。',
  'Call the amount shown on your turn.': '轮到你时按显示的金额跟注。',
  'Edit the amount, then Enter to confirm.': '可改金额，回车确认。',
  'Select half pot, then Enter to confirm.': '选半池，回车确认。',
  'Select pot size, then Enter to confirm.': '选满池，回车确认。',
  'Select your full stack, then Enter to confirm.': '选全部筹码，回车确认。',

  // Shortcut panel (§5a)
  'Enable keyboard shortcuts': '启用快捷键',
  'Shortcuts work in 2D and 3D on your turn. They pause while you type, open a menu or dialog, or wait for the server. WASD stays available for lounge movement.':
    '快捷键在 2D 和 3D 里轮到你时生效；输入文字、打开菜单或弹窗、等待服务器时会暂停。WASD 仍用于酒廊走位。',
  None: '无',
  'Shortcut for {action}': '「{action}」的快捷键',
  'Record {action} shortcut': '录制「{action}」快捷键',
  'Listening…': '按键捕捉中…',
  Record: '录制',
  'Press a key for {action}. Escape cancels; Backspace clears.':
    '按下要绑定「{action}」的键。Esc 取消，Backspace 清除。',
  'Recording cancelled.': '已取消录入。',
  '{action} set to {key}. Save to apply.': '「{action}」已设为 {key}，保存后生效。',
  'Choose a letter or number, optionally with Shift. WASD and browser shortcuts are reserved.':
    '请选一个字母或数字，可加 Shift。WASD 和浏览器自带快捷键不可用。',
  'Keyboard shortcuts saved to your account.': '快捷键已保存到账号。',
  'Could not load your keyboard shortcuts.': '没能加载你的快捷键设置。',
  'Could not load shortcuts.': '快捷键没能加载出来。',
  'Could not save shortcuts. Try again.': '没能保存快捷键，再试一次。',
  'Loading keyboard shortcuts…': '正在加载快捷键…',
  'Retry shortcuts': '重新加载快捷键',
  'Save shortcuts': '保存快捷键',
  'Saving…': '保存中…',
  'Restore defaults': '恢复默认',
  'Defaults restored. Save to apply.': '已恢复默认，保存后生效。',

  // In-panel table toolbar button (PokerShortcutButton)
  Shortcuts: '快捷键',
  'Shortcuts off': '快捷键未启用',
  'Edit keyboard shortcuts': '编辑快捷键',

  // Validation prose produced by packages/shared/pokerHotkeys.ts and shown as
  // text here (translated at the display site; the shared package stays English).
  'Invalid shortcut settings.': '快捷键设置无效。',
  'Include every action, or clear its shortcut.': '每个动作都要绑定，或者清空绑定。',
  'Use a letter or number, optionally with Shift. WASD is reserved for 3D movement.':
    '请用字母或数字，可加 Shift。WASD 留给 3D 走位了。',
  '{key} is assigned to more than one action.': '「{key}」已分配给多个动作。',
};

export default settings;
