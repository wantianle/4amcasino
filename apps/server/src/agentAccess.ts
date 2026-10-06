import { createHash } from 'node:crypto';
import type { DB } from './db.js';

export type ScopeKind = 'room';
export interface AgentGrant {
  id: string;
  user_id: number;
  scope_kind: ScopeKind;
  scope_id: string;
  can_play: number;
  expires_at: number;
  /** 'user' for grants a person minted for themselves, 'bot_runner' for the
   *  internal grant that lets a bot account play its seat. */
  grant_kind: string;
  /** Set for bot_runner grants: the bot_accounts row they belong to. */
  bot_id: string | null;
}
export class AgentError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
function enabledUser(db: DB, userId: number): boolean {
  return !!db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0').get(userId);
}
export function scopeMember(db: DB, userId: number, kind: ScopeKind, id: string): boolean {
  if (kind !== 'room') return false;
  return !!db.prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?').get(id, userId);
}
export function resolveAgentGrant(db: DB, token: string): AgentGrant | null {
  if (!token.startsWith('4am_agent_') || token.length > 150) return null;
  const grant = db
    .prepare(
      'SELECT * FROM agent_grants WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
    )
    .get(tokenHash(token), Date.now()) as AgentGrant | undefined;
  if (!grant || !enabledUser(db, grant.user_id)) return null;
  if (!scopeMember(db, grant.user_id, grant.scope_kind, grant.scope_id)) return null;
  // A bot_runner grant is only valid while it names an existing bot whose user
  // and room still match the grant. Normal `user` grants are unchanged.
  if (grant.grant_kind === 'bot_runner') {
    if (!grant.bot_id) return null;
    const bot = db
      .prepare('SELECT user_id, room_id, status FROM bot_accounts WHERE id = ?')
      .get(grant.bot_id) as { user_id: number; room_id: string; status: string } | undefined;
    if (!bot || bot.user_id !== grant.user_id || bot.room_id !== grant.scope_id) return null;
    if (bot.status === 'removed') return null;
  }
  return grant;
}
const PLAY_MESSAGES = new Set([
  'sit',
  'leave_seat',
  'sit_out',
  'start_hand',
  'key_commit',
  'shuffle_deck',
  'unmask_share',
  'action',
  'reveal_key',
  'show_cards',
  'fold_key',
  'rit_vote',
  'im_ready',
  // A bot is just another player: it must be able to answer a paid peek on the
  // same offer/accept path a human uses.
  'peek_accept',
  'peek_decline',
]);
export function agentMaySend(grant: AgentGrant, msg: { t: string; roomId?: string }): boolean {
  if (grant.scope_kind !== 'room') return false;
  if (msg.t === 'join_room') return msg.roomId === grant.scope_id;
  return !!grant.can_play && PLAY_MESSAGES.has(msg.t);
}
