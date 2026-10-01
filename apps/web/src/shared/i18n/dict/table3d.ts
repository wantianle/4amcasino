// 3D lounge / table dictionary (pages/table3d/*) — glossary per
// docs/zh-i18n.md §2: lounge → 酒廊（与 2D「大厅」区分）、LOUNGE_DESTINATIONS
// 用既定译名（入口/电视区/吧台/沙发角/舞池/落地窗景）、观战 / 牌桌 / 账房、
// peek → 买看、seat N → N 号位、盲注结构 `10/20` 不加空格。
// Style: 一律「你」，按钮/徽章不加句号，长句加；省略号用「…」；WASD / Esc /
// MP4 / 4AM 等键名与品牌原样透传。LOUNGE_DESTINATIONS 的英文 label 只在显示
// 处 t()，packages/shared 不动。画布文本（3D 铭牌 / 酒廊电视 / 桌布标语）按
// §6.2-3 同走 t()；system-ui / sans-serif 字体栈自带 CJK 回退。
// Reused keys owned elsewhere (do NOT redeclare): 'Table' / 'POT' / 'Seat {n}'
// / '{n}s' / 'Open chat' / 'More table controls' / 'Table controls' /
// 'Leave table' / 'player' / 'Run {n}' / 'Run 1' / 'Run 2' /
// 'Empty community card {n}' / 'Hand result' (dict/table-page.ts),
// 'Community cards' / 'Your cards' / 'Texas Hold’em' (landing), 'You' /
// 'Sitting out' (table), 'All-in' / 'None' / 'Saving…' (settings),
// 'Small blind' / 'Big blind' (lobby), 'Your turn' (tournaments).
// NB: the 2D page's key is 'Full screen is unavailable…' (two words); the
// LoungeTV literal is 'Fullscreen…' and gets its own key below.
// 相机视图 'Close' 与全局 'Close'(关闭) 撞键，改在显示处映射为 'Close-up'。
const table3d: Record<string, string> = {
  // ── 页头 / 连接状态 ─────────────────────────────────────────────────────
  '2D table': '2D 牌桌',
  'Switch to 2D table': '切到 2D 牌桌',
  'Open 2D table': '打开 2D 牌桌',
  'Your table': '你的牌桌',
  Connected: '已连接',
  Reconnecting: '重连中',
  'Reconnecting…': '正在重连…',
  '{sb} / {bb} blinds': '{sb}/{bb} 盲注',
  'Joining table': '正在进桌',
  'Open chat, {n} unread messages': '打开聊天，{n} 条未读',
  'Mute sound': '关闭音效',
  'Enable sound': '开启音效',
  'Your character': '你的角色',
  'Hide controls': '隐藏控件',
  'Show controls': '显示控件',
  'Hide controls for a clear view': '隐藏控件，清爽看全场',
  'Respond before hiding controls': '先处理当前操作，再隐藏控件',

  // ── HUD 状态行 / 读数 ───────────────────────────────────────────────────
  'Hand ended': '本手结束',
  'Hand complete': '本手打完',
  'Waiting for the next hand': '等下一手',
  '{name} is thinking': '{name} 正在思考',
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  Dealing: '正在发牌',

  // ── 世界 / 相机 ─────────────────────────────────────────────────────────
  '3D poker table': '3D 德州扑克桌',
  '3D casino. Drag to orbit. Use the camera buttons to change view.':
    '3D 场景。拖拽可旋转视角，用相机按钮切换视图。',
  'Lounge world. After taking a break, use W A S D or arrow keys to walk. Drag to look around.':
    '酒廊场景。起身休息后，可用 W A S D 或方向键走动，拖拽环顾四周。',
  Lounge: '酒廊',
  TV: '电视',
  'Camera views': '相机视角',
  'Camera view': '相机视角',
  '{view} view': '{view}视角',
  Overhead: '俯视',
  Side: '侧面',
  'Close-up': '特写',
  'WASD / arrows to walk · Tap floor to go · Drag to orbit':
    'WASD / 方向键走动 · 点地面过去 · 拖拽转视角',
  'Lounge to get up · Drag to orbit · Scroll to zoom':
    '点酒廊即可起身 · 拖拽转视角 · 滚轮缩放',

  // ── 酒廊目的地（LOUNGE_DESTINATIONS，显示处 t()）───────────────────────
  'Lounge entrance': '酒廊入口',
  'Watch TV': '电视区',
  'Drinks counter': '吧台',
  'Sofa corner': '沙发角',
  'Dance floor': '舞池',
  'City view': '落地窗景',

  // ── 起身休息 / 走动面板 ─────────────────────────────────────────────────
  'Explore the lounge': '逛逛酒廊',
  'Make yourself at home': '就当自己家',
  'Your break starts after this hand.': '这手打完就开始休息。',
  'Use WASD or arrow keys to walk. Drag to look around.':
    '用 WASD 或方向键走动，拖拽环顾四周。',
  'Take a break. Your seat and chips stay yours.': '去歇会儿，位置和筹码都给你留着。',
  'Choose a clear spot inside the lounge.': '在酒廊里找个空旷的位置。',
  'Close lounge controls': '关闭酒廊控制',
  'Walk with keyboard': '用键盘走动',
  'Get up and explore': '起身去逛逛',
  'Leave after this hand': '这手结束后离桌',
  'Choose seat': '挑个位置',
  'Choose a seat': '挑个位置',
  'Stay seated': '继续坐着',
  'Cancel break': '取消休息',
  'Return to seat': '回到座位',
  'Stop walking': '停止走动',
  'Free my seat': '让出座位',
  'You remain in this hand. You can still use all poker actions.':
    '这手牌你还在局中，所有牌桌操作照常可用。',
  'Getting up from your chair…': '正在起身…',
  'Walking through the lounge…': '正在穿过酒廊…',
  'Taking your seat…': '正在入座…',
  'Reactions and chat work throughout the room.': '走到哪都能发互动、聊天。',
  'Standing dances are available when you leave the chair.': '起身离座后，站着也能跳。',

  // ── 3D 场景错误 ─────────────────────────────────────────────────────────
  'The 3D scene is unavailable': '3D 场景打不开',
  'Your device could not start the 3D view. You can keep playing at the 2D table.':
    '你的设备带不动 3D 视图。去 2D 牌桌照样能打。',
  'The 3D view paused. Reload to restore it, or continue at the 2D table.':
    '3D 视图暂停了。刷新页面恢复，或者去 2D 牌桌继续。',

  // ── 玩家面板 ────────────────────────────────────────────────────────────
  'Players at the table': '桌边玩家',
  'At the table': '在桌边',
  'Close player list': '关闭玩家列表',
  'Profiles, seats, and table reactions.': '资料、座位，还有牌桌互动。',
  Folded: '已弃牌',
  'Their turn': '轮到 TA',
  Dealer: '庄位',
  Speaking: '正在说话',
  Muted: '已静音',
  '{n} pending': '待入账 {n}',
  Ready: '已就绪',
  React: '互动',
  'Stand up': '请起身',
  'Confirm stand up': '确认请起身',
  'Stand up {name}': '请 {name} 起身',
  'Confirm stand up {name}': '确认请 {name} 起身',

  // ── 帮助面板 ────────────────────────────────────────────────────────────
  '3D table help': '3D 牌桌说明',
  'How to use the 3D table': '3D 牌桌玩法说明',
  'Close help': '关闭帮助',
  'Drag to look around. Pinch or scroll to zoom. Camera presets bring you back to the action.':
    '拖拽环顾四周；捏合或滚动缩放；相机预设带你回到牌局。',
  'Take a break in Lounge, then click the world or choose Walk with keyboard. Use WASD or arrow keys to steer relative to the camera. Release to stop. Chat, menus, and poker decisions pause keyboard movement. Quick destinations work on every device.':
    '去「酒廊」歇会儿，然后点场景里的位置，或选「用键盘走动」。WASD 或方向键按相机朝向移动，松手即停。聊天、菜单和牌局决策会暂停键盘移动。快捷目的地在任何设备上都好用。',
  'Tap a character or open Players to send a playful nudge. Reactions are shared with the table.':
    '点一下角色，或打开「玩家」列表，都能皮一下。互动全桌可见。',
  'Open Cards for community cards, both runouts, and public reveals. Tap your cards to enlarge them. Open Table for invites, records, seats, and preferences.':
    '打开「牌面」看公共牌、两跑牌面和公开亮牌，点你的牌可放大；打开「牌桌」管邀请、记录、座位和偏好。',
  'Hide controls for a clear view. They return when you need to respond. Press Escape to bring them back.':
    '隐藏控件可清爽看全场；需要你操作时会自动回来，按 Esc 也能唤回。',

  // ── 互动 / 表情 ─────────────────────────────────────────────────────────
  'Table reactions': '牌桌互动',
  'Close reactions': '关闭互动面板',
  'Say it with a move': '用动作说话',
  'Standing moves. Everyone sees them.': '站着的动作，全桌都看得到。',
  'Seated reactions. Explore for standing moves.':
    '坐着能做的小动作。去「酒廊」面板解锁站立动作。',
  Reaction: '互动',
  '{label} sent': '已发出：{label}',
  Wave: '挥手',
  Dance: '跳舞',
  Disco: '蹦迪',
  Robot: '机器人',
  Twirl: '旋身',
  Jump: '跳一下',
  Clap: '鼓掌',
  Bow: '鞠躬',
  Flex: '秀肌肉',
  Facepalm: '扶额',
  Rage: '气炸了',
  Laugh: '大笑',
  Cry: '大哭',
  Shrug: '耸肩',
  Heart: '比心',
  'Thumbs up': '点赞',
  Headbang: '甩头',
  Moonwalk: '太空步',
  Spin: '转圈',
  Wiggle: '扭一扭',
  Salute: '敬礼',
  'Air guitar': '空气吉他',
  Dab: 'Dab',
  Chicken: '怂了',
  Pray: '祈祷',
  Levitate: '漂浮',
  Celebrate: '庆祝',

  // ── 玩家互动菜单（点角色弹出）───────────────────────────────────────────
  'Dismiss player interaction': '关闭玩家互动',
  'Close player interaction': '关闭玩家互动',
  'Interact with {name}': '和 {name} 互动',
  'Wave hello': '打个招呼',
  'Walk over': '走过去',
  Shove: '推一把',
  'High-energy slap': '高能一巴掌',
  'Toss a chip': '丢枚筹码',

  // ── 底部工具条 / 牌面挂件 ───────────────────────────────────────────────
  'Poker widgets': '牌桌面板',
  Cards: '牌面',
  'Cards on the table': '桌上的牌',
  'Cards appear when a hand is dealt': '发牌后这里会出现牌面',
  'Show card widget': '展开牌面面板',
  'Hide card widget': '收起牌面面板',
  Players: '玩家',
  'Private card offer — respond': '有人出价买看你的底牌，快回应',
  'Private card peeks': '买看请求',
  'Two runouts': '两跑牌面',
  'Enlarge your cards': '放大你的底牌',
  'Shown to everyone': '已公开亮牌',
  'Publicly shown cards': '公开亮出的牌',

  // ── 酒廊电视（LoungeTV）─────────────────────────────────────────────────
  'Lounge TV': '酒廊电视',
  'Lounge TV controls': '酒廊电视控制',
  'Your playback on this device.': '只影响你这台设备的播放。',
  'Close TV controls': '关闭电视控制',
  'TV channel': '电视频道',
  Video: '视频',
  'Table live': '牌桌直播',
  'Playback paused. Press Play to try again.': '播放停了。按「播放」再试一次。',
  'This video could not play. Try an MP4 or restore the lounge film.':
    '这个视频放不出来。换一个 MP4，或恢复酒廊默认影片。',
  'The screen shows the current pot, board, and whose turn it is. Private cards stay private.':
    '屏幕显示当前底池、公共牌和轮到谁。底牌照旧保密。',
  'Local file': '本地文件',
  'Silent ambient loop': '静音氛围循环',
  'Video position': '视频进度',
  Play: '播放',
  Pause: '暂停',
  'Play TV': '播放电视',
  'Pause TV': '暂停电视',
  'Mute TV': '电视静音',
  'Unmute TV': '取消电视静音',
  'TV volume': '电视音量',
  'Fullscreen video': '视频全屏',
  'Fullscreen is unavailable in this browser.': '这个浏览器不支持全屏。',
  'Choose a local video': '选择本地视频',
  'Open video': '打开视频',
  'Lounge film': '酒廊影片',
  'Local videos stay on your device. Opening this panel keeps the table and your game controls available.':
    '本地视频只留在你的设备上。开这个面板不影响牌桌和游戏操作。',
  'After Hours': '深夜场',

  // ── 角色工坊（Wardrobe / CharacterPreview / avatar 选项名）──────────────
  'Character studio': '角色工坊',
  'Close character studio': '关闭角色工坊',
  'A little more you at the table.': '在牌桌上更像你自己。',
  'Make it yours': '随你搭配',
  Shuffle: '随机',
  'Suit color': '西装颜色',
  'Light color': '灯光颜色',
  Lavender: '薰衣草紫',
  Orchid: '兰花紫',
  Cobalt: '钴蓝',
  Mint: '薄荷绿',
  Gold: '金黄',
  Coral: '珊瑚红',
  Pearl: '珍珠白',
  Graphite: '石墨灰',
  Silhouette: '身形',
  Orbit: '轨道',
  Block: '方块',
  Comet: '彗星',
  Headwear: '头饰',
  cap: '鸭舌帽',
  halo: '光环',
  crown: '皇冠',
  'Exit effect': '出局特效',
  boom: '爆炸',
  rocket: '火箭',
  sparks: '火花',
  'Your send-off when your stack reaches zero.': '筹码打光时，你的退场方式。',
  'High roller': '豪客',
  Wildcard: '百搭',
  'After hours': '深夜场',
  'Saved. Your character is ready for the table.': '已保存。你的角色可以上桌了。',
  'Could not save. Please try again.': '没能保存，再试一次。',
  'Couldn’t save: {error} Try again.': '没能保存：{error}，再试一次。',
  Reset: '重置',
  Saved: '已保存',
  'Save character': '保存角色',
  'Unsaved changes. Save to wear this at the table.':
    '还有没保存的改动，保存后牌桌上就是这身。',
  'Seen by everyone at your table.': '同桌所有人都看得到。',
  '{head} character preview with {hat}. Drag to rotate.':
    '当前形象：{head}、{hat}。拖拽可旋转。',
  round: '圆头',
  cube: '方块头',
  cone: '尖头',
  'no hat': '不戴帽',
  '3D preview is unavailable on this device. You can still customize and save.':
    '这台设备显示不了 3D 预览。照常可以定制和保存。',
  'Rotate preview': '旋转预览',
  'Drag to explore': '拖动查看',
  'Preview wave': '预览挥手',
  'Preview dance': '预览跳舞',

  // ── 画布文本（3D 铭牌 / 电视直播画面 / 桌布标语）────────────────────────
  'In the lounge': '酒廊中',
  'POW!': '砰！',
  '4AM  /  TABLE LIVE': '4AM 现场直播',
  '{pot} in the pot': '底池 {pot}',
  '{name} is playing': '{name} 正在行动',
  'The next hand is coming': '下一手马上开始',
  'Good company. One more hand.': '有好友作伴，有一手可打。',
  'A SEAT AT YOUR TABLE': '这桌给你留了位子',
};

export default table3d;
