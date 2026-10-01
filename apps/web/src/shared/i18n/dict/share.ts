// Share dictionary (features/share/ShareRoom + ShareHandDialog — DOM only;
// the canvas renderers shareCard.ts / replayGif.ts are a separate lane).
// Brand 「4AM Casino」, room names, join codes, filenames (4am-hand.png) and
// the WhatsApp label are code-level text and never translate. The source's
// own symbols (✓, 🔗) stay in position per docs/zh-i18n.md §3.3.
// Reused, NOT redefined: 'Share' → 分享 (dict/table-page.ts).
const share: Record<string, string> = {
  // One-tap copy on lobby room cards
  'Copy the invite link for {room}': '复制 {room} 的邀请链接',
  '✓ Copied': '✓ 已复制',
  '🔗 Invite': '🔗 邀请',

  // ShareRoom: copy buttons and flash messages
  'Copy the table code': '复制牌桌房间码',
  'Copy the invite link': '复制邀请链接',
  'Copy code': '复制房间码',
  'Copy invite link': '复制邀请链接',
  'Share…': '分享…',
  'Invite copied': '邀请文案已复制',
  'Code copied': '房间码已复制',
  'Link copied': '链接已复制',
  'Anyone with this link joins the table right after they log in — no account needed first.':
    '拿到这个链接的人，一登录就进桌，不用先注册账号。',

  // ShareHandDialog: export preview image
  'Share this hand': '分享这一手',
  'Download PNG': '下载 PNG',
  '4AM Casino hand': '4AM Casino 这手牌',
  'Saved as 4am-hand.png': '已保存为 4am-hand.png',
  'Shared.': '已分享。',
  'Image copied to the clipboard.': '图片已复制到剪贴板。',
};

export default share;
