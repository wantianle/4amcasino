// Provably-fair explainer (FairPage) — seven mental-poker chapters + chrome.
// Keys are the exact English source strings (docs/zh-i18n.md §6.2).
// Left untranslated on purpose (§4.3): ristretto255, DLEQ, ed25519,
// hash-to-point, the hex digests, and the card tokens ('As', 'Td', …) —
// they ride inside the translated prose as code-level text.
// Reused, NOT redefined: 'You' → 你 (dict/table.ts), 'Next step' → 下一步
// (dict/tournaments.ts), 'flop' → 翻牌 (dict/table3d.ts).
const fair: Record<string, string> = {
  // ── Page chrome ──────────────────────────────────────────────────────────
  'How can this be fair?': '这怎么就公平了？',
  'Mental poker, in seven chapters. No trust in the server required.':
    '七章讲齐心智扑克，不需要你信任服务器。',
  'Back to poker': '返回牌局',
  'Replay this animation': '重播这段动画',
  Back: '上一步',
  'Deal me in': '拉我入桌',

  // ── Demo personas (avatars use the first letter, so translate short) ─────
  Meera: '米拉',
  Ishaan: '伊尚',

  // ── Chapter titles ───────────────────────────────────────────────────────
  'A deck with no dealer': '没有荷官的一副牌',
  'Keys are promised up front': '密钥先立字据',
  'Everyone locks, everyone shuffles': '人人上锁，人人洗牌',
  'The server is blind': '服务器看不见',
  'Dealing without revealing': '发牌不亮牌',
  'The table reveals together': '全桌一起亮牌',
  'Every move on the record': '每个动作都有记录',

  // ── Ch1 · deck ───────────────────────────────────────────────────────────
  '52 cards become 52 points on an elliptic curve': '52 张牌，变成椭圆曲线上的 52 个点',
  'There is no physical deck and no dealer. Before every hand, each card is encoded as pure math, a point on an elliptic curve. Math can be locked; paper cannot.':
    '没有实体牌，也没有荷官。每手牌开始前，每张牌都会编码成数学对象——椭圆曲线上的一个点。数学能上锁，纸不能。',
  'under the hood: ristretto255 group elements, hash-to-point per card':
    '底层：ristretto255 群元素，每张牌各做一次 hash-to-point',

  // ── Ch2 · commit ─────────────────────────────────────────────────────────
  'Before anything is shuffled, every player publishes a fingerprint of their secret key for this hand, pinned to the table for all to see. Nobody can quietly swap keys later: every unlock must match the promise made here.':
    '牌还没洗，每个玩家先公布本手秘密密钥的指纹，钉在桌上给所有人看。之后谁都不能悄悄换钥：每次解锁都得对上这里的承诺。',
  'under the hood: hash commitments to per-hand masking keys, sent before the shuffle':
    '底层：洗牌之前，先对每手牌的遮罩密钥做出哈希承诺',

  // ── Ch3 · shuffle ────────────────────────────────────────────────────────
  'In turn, every player scrambles the whole deck and seals every card with their own secret key. Watch the locks stack up. After the last player, the order is unknown to everyone at the table, and to us.':
    '轮流动手：每个玩家把整副牌重新打乱，再用自己的密钥封好每张牌。看着锁一层层叠上去。最后一个人封完，牌序桌上谁也不知道，我们也不知道。',
  shuffle: '洗牌',
  'under the hood: commutative masking, so locks can come off in any order':
    '底层：遮罩运算可交换，锁按任意顺序都能解',

  // ── Ch4 · blind ──────────────────────────────────────────────────────────
  'Your screen': '你的屏幕',
  'The server': '服务器',
  'The server only passes locked messages around. It never holds a single key, so even the person hosting the game (or anyone who hacks the server) sees exactly this: noise.':
    '服务器只负责转手上锁的消息，一把密钥也不过手。所以不管是房主本人，还是攻进服务器的黑客，看到的就是这些：一堆乱码。',
  'under the hood: the server is a relay for ciphertexts; keys never leave your device':
    '底层：服务器只中转密文，密钥从不出你的设备',

  // ── Ch5 · deal ───────────────────────────────────────────────────────────
  deal: '发牌',
  '{name} unlocked': '{name} 已解锁',
  '{name} still locked': '{name} 还锁着',
  'proof verified': '验证通过',
  'To deal you a card, everyone else removes their lock, and each removal carries a mathematical proof it was done with the exact key promised in chapter two. A faked unlock is rejected instantly and the cheater is named. Your own lock comes off last, on your device, so only you ever see the card.':
    '给你发牌时，其他人先各自解锁，每一下都带着数学证明，证明用的正是第二章承诺过的那把密钥。假解锁当场被拒，作弊的人会被点名。你自己那把锁最后才开，就在你的设备上，所以这张牌只有你见过。',
  'under the hood: a Chaum-Pedersen DLEQ proof rides along with every unmask':
    '底层：每次解遮罩都附带一个 Chaum-Pedersen DLEQ 证明',

  // ── Ch6 · board ──────────────────────────────────────────────────────────
  'all three unlocked, in public': '三把锁当众全部解开',
  'three locks on every board card': '每张公共牌都锁着三把锁',
  "Community cards work the same way, just in the open: everyone removes their lock in front of the whole table, proof attached, and the flop flips for all at once. The same machinery covers showdowns, voluntary reveals, and paid peeks: a reveal is always a proven unlock, never the server's word.":
    '公共牌走的是同一套，只是全在明面上：每个人当着整桌的面解锁，证明随行，翻牌一起亮开。摊牌、主动亮牌、付费买看都一样：亮牌永远是一次有证明的解锁，从不靠服务器一句话。',
  reveal: '亮牌',
  'under the hood: identical DLEQ-proved unmasks, broadcast to the table instead of one player':
    '底层：同样带 DLEQ 证明的解遮罩，只是广播给全桌，而不是发给某一个人',

  // ── Ch7 · chain ──────────────────────────────────────────────────────────
  'bet 60': '下注 60',
  'bet 6,000': '下注 6,000',
  BROKEN: '断裂',
  'tap any block to try tampering with it': '点任意一个区块，试试篡改它',
  'Every move of every hand is signed by its player and chained by hashes. Change one bet after the fact and every later link breaks, visibly, for everyone. Finished hands can be replayed and re-verified in your own browser. The one thing math cannot stop: a friend showing their screen to another friend. That part runs on friendship.':
    '每一手的每个动作都由玩家本人签名，再用哈希串成链。事后改一笔注，后面的每一环都会当场断裂，所有人都看得见。打完的牌局可以在你自己的浏览器里回放、重新验证。数学拦不住的只有一件事：朋友把屏幕给另一个朋友看。那部分靠交情。',
  'under the hood: ed25519-signed actions in a hash chain, same scheme as the chip ledger':
    '底层：动作以 ed25519 签名、按哈希成链，和筹码账本同一套方案',
};

export default fair;
