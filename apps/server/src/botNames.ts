import { randomInt } from 'node:crypto';

/**
 * Default display names for freshly created bots.
 *
 * A bot's `username` is its login identity (`bot_<hex>`, unique, feeds key
 * derivation) and must never change; its `display_name` is pure presentation and
 * is what the table actually shows. Owners who pass an explicit name still win -
 * this pool only fills the gap when they leave the name blank, so the seat reads
 * as "河牌杀手" instead of "bot_9f2c1a0b3d".
 *
 * Style: short poker/casino-flavoured winks, Chinese or mixed CN/EN, table-safe.
 * Keep it curated rather than generated - no cheap homophones, no edge.
 */
export const FUN_BOT_NAMES = [
  '河牌杀手',
  '诈唬大师',
  '全下小王子',
  '跟注站老王',
  '坚果猎手',
  '翻牌前教授',
  '慢打艺术家',
  '铁头娃',
  '无情加注机',
  '松凶少年',
  '紧弱守望者',
  '河牌收割机',
  '顶对狂魔',
  '三条猎手',
  '顺子梦想家',
  '同花追逐者',
  '筹码搬运工',
  '大盲守卫者',
  '翻倍或回家',
  '读牌机器',
  '长考之王',
  '冷静的鲨鱼',
  '底池建造师',
  '诈唬终结者',
] as const;

/**
 * Pick a display name for a new bot.
 *
 * `taken` is the set of display names already live in the target room (humans
 * and bots alike). A clash gets a numeric suffix (`河牌杀手2`) so two players at
 * the same table are never ambiguous. Because `taken` is finite, at most
 * `taken.size` suffixed candidates can collide, so the bounded loop below always
 * returns.
 */
export function pickFunBotName(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base = FUN_BOT_NAMES[randomInt(FUN_BOT_NAMES.length)]!;
  if (!used.has(base)) return base;
  for (let i = 2; i <= used.size + 2; i++) {
    const candidate = `${base}${i}`;
    if (!used.has(candidate)) return candidate;
  }
  // Unreachable: with `used.size + 1` distinct suffixes at least one is free.
  return base;
}
