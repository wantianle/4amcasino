// Landing page dictionary (LandingPage).
// Keys are the exact English source strings; several Chinese values are trimmed
// per docs/zh-i18n.md §3.2 (marketing filler dropped, synonym pairs merged).
// Apostrophes are U+2019 in this page's source (Hold’em / It’s / you’re / friend’s)
// and must be byte-identical in the keys.
// Shared keys defined elsewhere: 'Log in' (dict/login.ts).
const landing: Record<string, string> = {
  // Header / nav
  'Skip to content': '跳到正文',
  '4AM Casino home': '4AM Casino 首页',
  'Main navigation': '主导航',
  'The experience': '体验',
  'How it works': '怎么玩',
  Questions: '常见问题',
  'Your lobby': '你的大厅',
  'Open your lobby': '去大厅',
  'Start a table': '开一桌',

  // Hero
  'Your people.': '自己人。',
  'Your poker night.': '自己的牌局。',
  'Pull up a chair. Play a few hands. Stay for the conversation. Your favourite group chat now has a poker table.':
    '找个位置坐下，打几手牌，留下来聊聊天。你最常聊的那个群，现在也有牌桌了。',
  'Play-money poker.': '纯娱乐筹码。',
  'Right in your browser.': '浏览器直接开打。',
  'Have a room code?': '有房间码？',
  'Join your friends': '进朋友的桌',
  'Private rooms': '私密房间',
  'Voice & chat': '语音和文字',
  'Hand replays': '牌局回放',
  'Included at every table': '每张牌桌都包含',

  // Join form
  'Room code': '房间码',
  'Join table': '加入牌桌',
  'Enter the 6-letter or number code from your host.': '输入房主给你的 6 位字母数字房间码。',

  // 'The table' is also used by the replay / tournament / player pages.
  'The table': '牌桌',

  // Example hand widget
  'Interactive example hand': '互动示例牌局',
  'Texas Hold’em': '德州扑克',
  'Example hand': '示例牌局',
  'Before the flop': '翻牌前',
  'The flop': '翻牌',
  'The turn': '转牌',
  'The river': '河牌',
  'Deal the flop': '发翻牌',
  'Deal the turn': '发转牌',
  'Deal the river': '发河牌',
  'Try again': '再来一次',
  'Two cards, just for you. The community cards come next.':
    '两张底牌，只给你看。公共牌随后就到。',
  'Three cards on the table. Everyone can use them.': '桌上三张公共牌，人人都能用。',
  'A third jack. Your best hand is now three of a kind.': '第三张 J 到位，你的最佳牌型成了三条。',
  'Five community cards. Make your best five-card hand.': '公共牌齐了，凑出你最好的五张。',
  'Community cards': '公共牌',
  'Your cards': '你的底牌',
  'Only you can see these.': '只有你看得见。',
  'Try a deal': '试发一手',

  // Setup section
  'The plan is simple.': '计划很简单。',
  'Get everyone in.': '先把人喊来。',
  // §3.2: 「Just a table with room for your friends.」 is marketing filler — dropped in ZH.
  'No venue to book. No chips to count out. Just a table with room for your friends.':
    '不用订场地，不用数筹码。',
  'Make tonight poker night': '今晚就开牌',
  'Make it your table.': '开一桌，变成你的场子。',
  'Create a private room and choose your blinds. The host gets things ready for the first hand.':
    '建个私密房间，定好盲注，房主把第一手牌张罗好。',
  'Drop the link in the chat.': '把链接丢进群聊。',
  'Share the invite link or room code. Your friends sign in, join the room, and pick a seat.':
    '邀请链接或房间码都行，朋友登录、进房、挑个位子。',
  'Deal. Talk. Run it back.': '发牌，闲聊，再来一局。',
  'Play Texas Hold’em together. React to a hand and run it back.':
    '一起打德州扑克，甩个表情，再来一局。',

  // Game section
  'All the tension.': '该心跳的一样不少，',
  'None of the stakes.': '真钱一分没有。',
  // §3.2: 「Real poker moments, play-money chips.」 overlaps the opener — dropped in ZH.
  'The hopeful flop. The unexpected river. The friend who definitely has it this time. Real poker moments, play-money chips.':
    '盼翻牌，怕河牌，还有那个每次都说「这把有牌」的朋友。',
  // §3.2: two English sentences say one thing — merged in ZH.
  'Keep your focus on the cards, with everyone at the same table.':
    '专心看牌，大家同坐一张桌。',
  'Take a look around': '四处看看',

  // Trust section
  'Good games.': '牌局要爽，',
  'Nothing swept under the table.': '更要摊得开。',
  'An encrypted deal, a record of every chip, and replays for the hands you’re still talking about.':
    '加密发牌、每一枚筹码都有账，那些你们聊到半夜的牌局都能回放。',
  'Read the fair-play guide': '看公平玩法说明',
  'Your cards stay yours.': '底牌只属于你。',
  'Players participate in an encrypted shuffle. The fair-play guide explains how cards are dealt and verified.':
    '发牌由全员参与的加密洗牌完成，怎么验证请看公平玩法说明。',
  'The night adds up.': '一夜都有账。',
  'Follow buy-ins, chip transfers, and settlement in the room ledger. Revisit finished hands in the replay viewer.':
    '买入、转账、结账都在房间账本里，打完的牌还能翻回放。',
  'Open source. Open to a closer look.': '开源，欢迎细看。',

  // FAQ
  'Before you sit down.': '上桌之前。',
  'Is this real-money poker?': '这是真钱扑克吗？',
  'No. 4AM uses play-money chips. It does not take deposits, pay out winnings, or process real-money bets.':
    '不是。4AM 只用娱乐筹码：不收存款，不提现，不经手任何真钱。',
  'Does everyone need to download an app?': '每个人都要装 App 吗？',
  'No download is needed. Open 4AM in your browser, sign in, and join your friend’s table using its invite link or room code.':
    '谁都不用装。浏览器打开 4AM，登录，凭邀请链接或房间码进桌。',
  'Can we talk while we play?': '打牌时能说话吗？',
  'Yes. Rooms have text chat and voice controls. You can also react at the table.':
    '能。房间有文字聊天和语音控制，还可以在牌桌上甩个表情。',
  'How can I check what happened in a hand?': '想复盘某一手怎么办？',
  'Finished hands have replays and a recorded action history. The room ledger tracks chip movement. Our fair-play guide explains the encrypted deal and what the verification checks cover.':
    '打完的牌局有回放和完整的操作记录，筹码流向看房间账本；加密发牌和验证的说明在公平玩法页。',

  // Closing + footer
  'Same friends.': '还是那帮人。',
  'New favourite place.': '多了个新据点。',
  'Someone has to start the group chat. Make it you.': '总得有人攒局。这次就你来。',
  'For the love of the game. Play-money only.': '因为爱牌。纯娱乐，无真钱。',
  Footer: '页脚',
  'Fair play': '公平玩法',
  License: '许可协议',
};

export default landing;
