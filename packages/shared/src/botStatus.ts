/**
 * Bot lifecycle state vocabulary. The server (apps/server/src/botRoutes.ts)
 * owns the state machine; this is the one list both the server and the web UI
 * agree on, so the web only has to add display copy (label/tone), not its own
 * copy of the allowed values.
 */
export const BOT_STATUSES = [
  'created',
  'waiting_buy_approval',
  'ready',
  'starting',
  'running',
  'stopping',
  'stopped',
  'removed',
  'error',
] as const;

export type BotStatus = (typeof BOT_STATUSES)[number];
