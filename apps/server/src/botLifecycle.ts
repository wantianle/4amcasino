/**
 * The single definition of "this bot is gone or on its way out": either a legacy
 * soft-deleted `removed` row, or a hard delete already requested
 * (`delete_requested_at` set, typically while parked `stopping`); see
 * `finalizeBotRemoved`. Once a delete is requested the row can be removed
 * underneath us at any moment, so anything that would still mutate money/state
 * for that bot must refuse instead.
 *
 * This lives in its own leaf module rather than `botRoutes.ts` because
 * `buyService.ts` sits BELOW the route layer: it is imported by `botRoutes.ts`
 * (and by `rooms.ts`). Importing `botRoutes.ts` from the money path would make
 * a cycle. This module imports nothing, so both sides share one predicate.
 *
 * Deliberately NOT consulted by `resolveAgentGrant`: a deleting runner keeps a
 * valid grant for the duration of its wind-down so it can fold and leave its
 * seat; only an already-`removed` legacy row invalidates the grant there.
 */
export interface BotGoneLike {
  status: string;
  delete_requested_at: number | null;
}

export function isBotGone(bot: BotGoneLike): boolean {
  return bot.status === 'removed' || bot.delete_requested_at !== null;
}

/**
 * The 409 message for a gone/deleting bot, single-sourced so the route layer and
 * the buy service cannot drift apart.
 */
export function botGoneMessage(bot: BotGoneLike): string {
  return bot.status === 'removed' ? 'bot has been removed' : 'bot deletion is in progress';
}
