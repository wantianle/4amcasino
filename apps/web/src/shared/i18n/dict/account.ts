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

  // Recovery code row (read-only: codes are minted at signup, shown once on
  // the login page, and never downloadable or configurable from settings). The
  // login page owns the one-time display keys below.
  'Recovery code': '恢复码',
  'Save this now — you will not see it again': '现在就存好——之后不会再显示了',
  '✓ Copied': '✓ 已复制',
  Copy: '复制',
  'Working…': '处理中…',
  'Your recovery code is generated automatically when you create your account and shown exactly once. It cannot be viewed or changed here.':
    '恢复码在创建账号时自动生成，并且只显示一次。这里无法查看或修改。',
  '✓ A recovery code is on file for this account.': '✓ 这个账号已有恢复码存档。',
  '⚠ No recovery code on file. If you get locked out, ask the platform to reset your password.':
    '⚠ 这个账号还没有恢复码。如果被锁在外面，请联系平台重置密码。',

  // Devices row
  'Signed-in devices': '已登录的设备',
  'Could not load signed-in devices.': '无法加载已登录设备。',
  'Loading devices…': '正在加载设备…',
  'No signed-in devices found.': '没有找到已登录设备。',
  'This device': '当前设备',
  'Device': '设备',
  'Created {date}': '创建于 {date}',
  'This is the session currently used by this browser.': '这是当前浏览器正在使用的会话。',
  'Other session': '其他会话',
  'Signs out every browser except this one. Your password and keys stay the same.':
    '退出除当前浏览器以外的所有登录，密码和密钥都不变。',
  'Signed out {n} other session(s).': '已退出 {n} 个其他设备的登录。',
  'No other sessions.': '没有其他设备的登录。',
  'could not do that': '操作没成功，再试一次。',
  'Sign out everywhere else': '退出其他所有设备',
};

export default account;
