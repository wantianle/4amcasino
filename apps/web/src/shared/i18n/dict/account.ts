// Account & security dictionary (AccountSecurity.tsx on the settings page).
// Keys are the exact English source strings (B+ scheme, docs/zh-i18n.md §6.2).
// Shared field labels already owned by dict/login.ts ('Password', 'Username',
// 'New password', 'Repeat new password', 'the new passwords do not match') are
// deliberately NOT redefined here — the merged dictionary resolves them.
const account: Record<string, string> = {
  // Password row
  'Your password also derives the key that signs your cards. Changing it issues a new signing key and signs out every other device. Old hands stay verifiable.':
    '你的密码同时在这个浏览器里推导出签名密钥。改密码等于换一把新的签名密钥，其他设备会全部退出；旧牌局照样可以验证。',
  'Current password': '当前密码',
  'Re-keying…': '正在更新密钥…',
  'Change password': '修改密码',
  'use at least 6 characters': '密码至少要 6 位',
  'Password changed. Other devices were signed out.': '密码已改好，其他设备都已退出。',
  'could not change it': '密码没能改掉，再试一次。',

  // Username row
  'Your name is part of how your keys are derived, so renaming also issues a new signing key. You will log in with the new name and your same password.':
    '用户名会参与密钥推导，所以改名同样会换一把签名密钥。以后用新用户名加原来的密码登录。',
  'New username': '新用户名',
  'Your password': '你的密码',
  'Change username': '修改用户名',
  'that is already your name': '这个就是你现在的用户名',
  'You are now {name}. Other devices were signed out.': '你现在是 {name} 了，其他设备都已退出。',
  'could not rename you': '用户名没能改掉，再试一次。',

  // Recovery code row
  'Nobody can reset your password for you - your key lives only in your browser. A recovery code is the one way back in. Generate it now, store it somewhere safe, and it works exactly once.':
    '没人能替你重设密码——密钥只存在你这个浏览器里。恢复码是唯一的回头路：现在就生成，存到安全的地方，它只能用一次。',
  'Recovery code': '恢复码',
  'Save this now — you will not see it again': '现在就存好——之后不会再显示了',
  '✓ Copied': '✓ 已复制',
  Copy: '复制',
  Download: '下载',
  'I saved it': '我存好了',
  '✓ A recovery code is armed on this account.': '✓ 这个账号已经备好恢复码。',
  '⚠ No recovery code. Forget your password and the account is gone for good.':
    '⚠ 还没有恢复码。忘了密码，这个账号就彻底回不去了。',
  'Working…': '处理中…',
  'Generate a new code': '生成新恢复码',
  'Generate code': '生成恢复码',
  'Turn off': '关闭',
  'enter your password first': '请先输入你的密码',
  'Recovery code turned off.': '恢复码已关闭。',
  'could not set it up': '没能设置好，再试一次。',
  'could not turn it off': '没能关闭，再试一次。',

  // Downloaded recovery file (the code line and the filename stay as-is)
  '4AM Casino recovery code': '4AM Casino 恢复码',
  'Account: {name}': '账号：{name}',
  'Keep this somewhere safe and private. It is the only way back into your account if you forget your password, and it works exactly once.':
    '把它存到安全可靠、别人看不到的地方。忘了密码时，这是回到你账号的唯一方式，而且只能用一次。',

  // Devices row
  'Signed-in devices': '已登录的设备',
  'Signs out every browser except this one. Your password and keys stay the same.':
    '退出除当前浏览器以外的所有登录，密码和密钥都不变。',
  'Signed out {n} other session(s).': '已退出 {n} 个其他设备的登录。',
  'No other sessions.': '没有其他设备的登录。',
  'could not do that': '操作没成功，再试一次。',
  'Sign out everywhere else': '退出其他所有设备',
};

export default account;
