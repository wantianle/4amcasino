// One-off strings from shared entities that belong to no page domain
// (PlayingCard's screen-reader label). Card tokens (As, Td, …) and suit
// glyphs stay code-level text (docs/zh-i18n.md §4.3).
//
// Also hosts the creation-site strings that bypass render-time translation:
// voice.ts toast, useCommissionSettings.ts error, the 7-2 bounty chat line
// (gameClient.ts) and the WhatsApp/native-share invite text (pendingJoin.ts).
// 'House rule' is the bounty sender badge; bounties/台费 glossary per
// docs/zh-i18n.md §2.1. The share template keeps its \n structure and the
// untranslated 4AM Casino brand (§4.3).
const misc: Record<string, string> = {
  'face-down card': '背面朝上的牌',
  'Microphone blocked. Voice chat stays off.': '麦克风被占用或没授权，语音聊天先保持关闭。',
  'Could not load the current house cut. Try again.': '没能加载当前台费，请重试。',
  'House rule': '房规',
  '7-2 offsuit! {name} collects {amount} in bounties.': '7-2 不同花！{name} 收下 {amount} 彩头。',
  'Join my poker table "{roomName}" on 4AM Casino.\nCode: {joinCode}\n{link}':
    '来我的牌桌「{roomName}」一起打牌 · 4AM Casino。\n房间码：{joinCode}\n{link}',
};

export default misc;
