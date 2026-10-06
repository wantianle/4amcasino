// Admin dictionary (pages/admin: AdminPage, AdminSections, CommissionControl).
// Keys are the exact English source strings (B+ scheme,
// docs/zh-i18n.md §6.2). Glossary: the house → 平台, house cut / commission →
// 台费, host → 房主.
// Usernames, room names, ids, URLs, hashes and user-written
// notes pass through as vars, untranslated. Server error prose is already
// handled by tr() at the api boundary; only local fallbacks are keys here.
// Reused, NOT redefined (owner modules win globally): 'Cancel' (ledger),
// 'Retry' (lobby), 'Search' (nav), 'Approve'/'Reject' (bank), 'Working…'
// 'Re-keying…'/'use at least 6 characters'* (account — *account owns the
// value), 'Saving…'/'Sign out'/'New password' (settings/login — login owns
// the value), 'Note (optional)' (bank), 'Merge accounts' (settings),
// 'Outstanding'/'Payments recorded'/
// 'Recording…' (settle/house), 'Refreshing…' (house).
// NOTE: bare 'Record' is '录制' in dict/settings.ts (keyboard shortcuts) and
// wins globally. The Rate/Earnings column meaning "记录" uses the trailing-
// space key 'Record ' — rendered identically in both locales, never collides.
const admin: Record<string, string> = {
  // ── AdminPage shell: sidebar, topbar, gates ────────────────────────────────
  Overview: '总览',
  'The platform at a glance, with the work that needs your attention.': '一眼看清平台，以及需要你处理的事。',
  'Revenue & dues': '收入与欠款',
  'Find who needs to pay, review recorded payments, and inspect each room.': '查看谁需要付款、核对已记录的付款、逐间检查房间。',
  Rooms: '房间',
  'Manage tables and see the house cut assigned to each room.': '管理牌桌，查看每个房间的台费。',
  Users: '用户',
  'Find an account by name or ID, then manage it directly.': '按昵称或 ID 找到账号，然后直接管理。',
  Requests: '申请',
  'Review account merge requests.': '审核账号合并申请。',
  'Platform settings': '平台设置',
  'Control the house cut without a deployment.': '不发版也能调整台费。',
  'Skip to dashboard content': '跳到后台内容',
  Administration: '管理后台',
  'Admin navigation': '后台导航',
  'Open casino': '前往主站',
  'Platform account': '平台账号',
  'Platform administrator': '平台管理员',
  'Signing out…': '正在退出…',
  'Platform workspace': '平台工作台',
  Refresh: '刷新',
  'Page not found': '页面不存在',
  'Choose a dashboard section from the navigation.': '从导航中选择一个后台分区。',
  'House cut': '台费',
  'Return to overview': '返回总览',
  'Loading platform activity…': '正在加载平台动态…',
  'Platform access': '平台权限',
  'Checking your platform account…': '正在检查你的平台账号…',
  'Retry access check': '重试权限检查',
  'Platform account required': '需要平台账号',
  'This dashboard is only available to the platform account. Your player account can continue on the main site.':
    '这个后台只对平台账号开放。你的玩家账号可以回主站继续。',
  'Sign in with another account': '换个账号登录',
  'Back to 4AM Casino': '返回 4AM Casino',
  'Could not check access.': '没能确认访问权限。',
  'Could not load the dashboard.': '没能加载后台数据。',
  'Could not sign out. Try again.': '没能退出登录，再试一次。',

  // ── Overview: metrics, revenue chart, attention, house accounting ──────────
  'Outstanding dues': '待付欠款',
  '{n} users need to pay': '{n} 人待付',
  'Active rooms': '活跃房间',
  '{n} rooms in total': '共 {n} 个房间',
  'Player accounts': '玩家账号',
  '{n} settled hands in active rooms': '活跃房间已结算 {n} 手',
  'Default for newly created rooms': '新建房间的默认值',
  'Commission activity': '台费动态',
  'Actual deductions in active rooms · last 14 days · UTC': '活跃房间实际扣取 · 近 14 天 · UTC',
  chips: '筹码',
  '{n} chips accrued over the last 14 days': '近 14 天累计 {n} 筹码',
  '{date}: {n} chips': '{date}：{n} 筹码',
  'Each bar is one day of commission.': '每根柱是一天的台费。',
  'Commission will appear after qualifying pots are settled.': '达到资格的底池结算后，台费才会出现在这里。',
  'View daily amounts': '查看每日金额',
  'Date (UTC)': '日期（UTC）',
  Commission: '台费',
  'Needs attention': '待你处理',
  '{n} pending requests': '{n} 条待审申请',
  'Room changes and account merges': '房间变更和账号合并',
  '{n} users with dues': '{n} 人欠款',
  '{n} chips outstanding': '待付 {n} 筹码',
  'Payments shown here are recorded by users. Confirm receipt separately before treating them as paid.':
    '这里展示的付款由用户自行记录。单独确认到账之前，不要视为已付。',
  'House accounting': '平台账务',
  'Active rooms, excluding voided hands. Amounts are in chips.': '只计活跃房间，不含作废手牌。金额单位为筹码。',
  'Accrued commission': '累计台费',
  'User credits': '用户信用额',
  'Open dues breakdown': '查看欠款明细',

  // ── UsersDirectory ─────────────────────────────────────────────────────────
  'User directory': '用户目录',
  'Search all accounts, including users without outstanding dues.': '搜索全部账号，包括没有欠款的用户。',
  'Search users by name or ID': '按昵称或 ID 搜索用户',
  'Name, @username, or user ID': '昵称、@用户名或用户 ID',
  'Searching…': '正在搜索…',
  'Search users': '搜索用户',
  'Search again to load the directory.': '重新搜索以加载目录。',
  'Loading accounts…': '正在加载账号…',
  'No accounts match this search. Try a username or user ID.': '没有匹配的账号。试试用户名或用户 ID。',
  User: '用户',
  Status: '状态',
  Joined: '加入时间',
  Actions: '操作',
  Platform: '平台',
  Disabled: '已停用',
  // NOTE: intentionally not 'Active' — that key belongs to dict/history.ts (the
  // room filter, 「进行中」). Sharing it let history.ts silently win and this
  // column rendered "进行中" instead of "已启用".
  Enabled: '已启用',
  Manage: '管理',
  'Manage {user}': '管理 {user}',
  'Manage @{user}': '管理 @{user}',
  '{from}–{to} of {total} accounts': '{from}–{to} / 共 {total} 个账号',
  Previous: '上一页',
  Next: '下一页',
  'Close account controls': '收起账号操作',
  'Could not load users.': '没能加载用户。',

  // ── shared request-list strings (merge + rooms sections) ───────────────────
  'Could not load requests. Try again.': '没能加载申请，再试一次。',
  'could not decide that request': '没能处理这条申请。',
  'Retry requests': '重新加载申请',
  'Loading requests…': '正在加载申请…',
  'Nothing waiting on you.': '没有等你处理的事。',
  'Loading rooms…': '正在加载房间…',

  // ── AdminSections: merge requests ──────────────────────────────────────────
  'Merge requests': '合并申请',
  'Folding one account into another. Approving cannot be undone.': '把一个账号并入另一个。批准后无法撤销。',
  into: '并入',
  'note: {note}': '备注：{note}',
  '{user}: {net} net, {n} room': '{user}：净额 {net}，{n} 个房间',
  '{user}: {net} net, {n} rooms': '{user}：净额 {net}，{n} 个房间',
  'Merge accounts directly': '直接合并账号',
  'Skips the request queue and folds one account into another immediately. Approving cannot be undone.':
    '跳过申请队列，立刻把一个账号并入另一个。执行后无法撤销。',
  'From username': '转出的用户名',
  'Into username': '保留的用户名',
  'Merge now': '立即合并',
  'Merging…': '正在合并…',
  'enter both usernames': '两个用户名都要填。',
  'Merged @{from} into @{into}.': '已把 @{from} 并入 @{into}。',
  'could not merge those accounts': '没能合并这两个账号。',
  'Approve this merge?': '批准这次合并？',
  'Everything @{a} owns moves to @{b}, and @{a} is retired. This cannot be undone.':
    '@{a} 名下的一切都会转到 @{b}，@{a} 随即注销。此操作无法撤销。',
  'Merge these accounts now?': '现在就合并这两个账号？',
  'Everything @{a} owns moves to @{b}, and @{a} is retired. This takes effect immediately and cannot be undone.':
    '@{a} 名下的一切都会转到 @{b}，@{a} 随即注销。立即生效，无法撤销。',

  // ── AdminSections: user admin ──────────────────────────────────────────────
  'User admin': '账号管理',
  'Look a player up by their user ID. It\'s visible in the URL of their profile page, /players/ID.':
    '按用户 ID 查找玩家。ID 就在他的个人页网址里：/players/ID。',
  'enter a valid user ID': '请输入有效的用户 ID。',
  'could not find that user': '没找到这个用户。',
  'User ID': '用户 ID',
  'Looking up…': '正在查找…',
  'Look up': '查找',
  'House account': '平台账号',
  'The house account can\'t be disabled or reset from here.': '平台账号不能在这里停用或重设密码。',
  'Disable account': '停用账号',
  'Signs them out everywhere and blocks further logins. Nothing is deleted.':
    '会让该账号在所有设备退出登录，并阻止再次登录。不会删除任何数据。',
  'Disable @{user}': '停用 @{user}',
  'Disable @{user}?': '停用 @{user}？',
  '@{user} is disabled and signed out everywhere.': '@{user} 已停用，并在所有设备退出登录。',
  'could not disable that account': '没能停用这个账号。',
  'Reset password': '重设密码',
  'Sets a new password and signing key for @{user}. They must not be seated at a table when you do this.':
    '为 @{user} 设置新密码和签名密钥。操作时他不能坐在牌桌上。',
  'Password reset for @{user}. Tell them the new password directly, they were signed out everywhere.':
    '已重设 @{user} 的密码。请把新密码直接转告本人，他已在所有设备退出登录。',
  'could not reset that password': '没能重设这个密码。',
  'They\'re signed out everywhere and can\'t log back in until re-enabled. Nothing they own is deleted.':
    '他会在所有设备退出登录，重新启用前无法再登录。他名下的数据不会被删除。',
  'Enable account': '启用账号',
  'Lets the account log in again. Nothing was deleted while it was disabled.':
    '允许该账号重新登录。停用期间没有删除任何数据。',
  'Enable @{user}': '启用 @{user}',
  '@{user} is enabled and can log in again.': '@{user} 已启用，可以重新登录。',
  'could not enable that account': '没能启用这个账号。',
  Merged: '已合并',
  'This account was merged into another one. It cannot be enabled or reset.':
    '该账号已并入其他账号，不能启用或重设密码。',
  'that account was merged into another one and cannot be re-enabled':
    '该账号已并入其他账号，不能重新启用。',
  'that account was merged into another one and cannot be reset':
    '该账号已并入其他账号，不能重设密码。',
  'Reset to initial password': '重置为初始密码',
  'Sets @{user} back to the password 123456, re-keys their signing identity, and signs them out everywhere. They must not be seated at a table.':
    '把 @{user} 的密码重置为 123456，重新生成签名密钥，并在所有设备退出登录。操作时他不能坐在牌桌上。',
  'Reset to 123456': '重置为 123456',
  'Resetting…': '正在重置…',
  'Reset @{user} to the initial password?': '把 @{user} 重置为初始密码？',
  'This sets @{user}\'s password back to 123456 and re-keys their signing identity. Every device they are signed in on is cleared immediately. Tell them the new password directly.':
    '这会把 @{user} 的密码改回 123456，并重新生成签名密钥。他所有已登录的设备会立即被清退。请把新密码直接转告本人。',
  'Password reset to 123456 for @{user}. They were signed out everywhere and re-keyed. Tell them the password directly.':
    '已把 @{user} 的密码重置为 123456，并在所有设备退出登录、更换密钥。请把密码直接转告本人。',

  // ── AdminSections: audit log ───────────────────────────────────────────────
  'Audit log': '审计日志',
  'Every administrative action, newest first.': '每一项管理操作，最新在前。',
  'Filter by action': '按操作筛选',
  'Action, e.g. user.disable': '操作，例如 user.disable',
  'Filter by target ID': '按目标 ID 筛选',
  'Target ID': '目标 ID',
  'Apply filters': '应用筛选',
  Clear: '清除',
  'Could not load the audit log.': '没能加载审计日志。',
  'Loading audit log…': '正在加载审计日志…',
  'No audit entries match.': '没有匹配的审计记录。',
  Time: '时间',
  Operator: '操作者',
  Action: '操作',
  Target: '目标',
  Detail: '详情',
  '{from}–{to} of {total} entries': '{from}–{to} / 共 {total} 条记录',

  // ── AdminSections: rooms ───────────────────────────────────────────────────
  'Archive or delete any table directly. Delete cannot be undone.': '可直接归档或删除任意牌桌。删除无法撤销。',
  'Search by name': '按名称搜索',
  'Could not load rooms. Search again to retry.': '没能加载房间。重新搜索即可重试。',
  'could not update that room': '没能更新这个房间。',
  'could not delete that room': '没能删除这个房间。',
  'No rooms found.': '没有找到房间。',
  Archived: '已归档',
  'Hosted by {host} · {n} player · {rate} house cut': '房主 {host} · {n} 人 · 台费 {rate}',
  'Hosted by {host} · {n} players · {rate} house cut': '房主 {host} · {n} 人 · 台费 {rate}',
  Unarchive: '取消归档',
  Archive: '归档',
  Delete: '删除',
  'Delete this room?': '删除这个房间？',
  '"{name}" will be removed from every list. This cannot be undone.': '「{name}」将从所有列表移除。此操作无法撤销。',
  'Delete room': '删除房间',
  'Deleting…': '正在删除…',

  // ── CommissionControl: house cut ───────────────────────────────────────────
  'Could not load the house cut.': '没能加载台费设置。',
  'Enter 0 to 100, using at most two decimal places.': '请输入 0 到 100 之间的数，最多两位小数。',
  '{rate} saved. {n} existing room updated for their next hand.': '台费 {rate} 已保存。{n} 个现有房间从下一手起使用新费率。',
  '{rate} saved. {n} existing rooms updated for their next hand.': '台费 {rate} 已保存。{n} 个现有房间从下一手起使用新费率。',
  '{rate} saved for newly created rooms.': '已为新建房间保存台费 {rate}。',
  'Could not save the house cut. Reload to check the current value.': '台费没保存成功。点「重新加载」确认当前值。',
  'Change the platform commission directly from your account.': '直接用你的平台账号调整台费。',
  'Reload settings': '重新加载设置',
  'Loading settings…': '正在加载设置…',
  'Commission per pot': '每池台费',
  'House cut percentage': '台费百分比',
  'Current default': '当前默认值',
  'Apply this change to': '让这次改动作用于',
  'All rooms': '所有房间',
  'Existing rooms use this rate from their next hand. New rooms use it too.': '现有房间从下一手开始用这个费率，新房间也用它。',
  'New rooms only': '仅新房间',
  'Existing rooms keep their currently assigned rate.': '现有房间保持当前分配的费率。',
  'On a 2,000-chip pot': '以 2,000 筹码的底池为例',
  '{n} chips to the house': '平台收走 {n} 筹码',
  'Enter a valid rate': '先输入有效费率',
  'Each pot is rounded down to whole chips. Completed hands and hands in progress keep their original rate.':
    '每池台费向下取整为整数筹码。已完成和进行中的手牌维持原费率。',
  'Save house cut': '保存台费',
  'Applies immediately. No redeploy needed.': '即时生效，不用重新部署。',

  // ── CommissionControl: qualification note + rate history ──────────────────
  'Qualification rules': '资格规则',
  'Rooms can require up to': '房间最多可要求先打满',
  ' hands before winnings qualify.': ' 手，赢得的筹码才算数。',
  'Hosts can choose a lower requirement or set it to zero. Existing requirements above 30 have been reduced.':
    '房主可以选更低的门槛，或直接设为 0。此前高于 30 手的门槛已经降到 30。',
  'Rate history': '费率历史',
  'The latest 50 changes, with their scope and administrator.': '最近 50 次变更，含生效范围和操作管理员。',
  Changed: '变更时间',
  'Applies to': '生效范围',
  'Changed by': '操作人',
  '{n} existing rooms updated': '已更新 {n} 个现有房间',
  'Load settings to view the change history.': '加载设置后可查看变更历史。',

};

export default admin;
