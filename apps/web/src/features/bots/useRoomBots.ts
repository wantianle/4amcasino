// Table bots: one read path shared by the page (seat badges) and the host
// dialog (management + create form). Bots move through their lifecycle in the
// background - the supervisor claims `starting` rows and winds `stopping`
// ones down - so readers poll WHILE something is in flight, not always.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type BotPublic } from '../../shared/api.ts';

/** Fast transitions: the supervisor is actively moving this bot. */
const IN_FLIGHT: ReadonlySet<string> = new Set(['created', 'starting', 'stopping']);
/** Slow transition: a human (the banker) has to act; seconds of staleness
 *  are fine, hammering the route for an approval that takes minutes is not. */
const AWAITING_HUMAN: ReadonlySet<string> = new Set(['waiting_buy_approval']);

export function botsInFlight(bots: BotPublic[]): boolean {
  return bots.some((b) => IN_FLIGHT.has(b.status));
}

/**
 * Poll cadence for a bot reader:
 * - 1.5s while a bot is mid-supervisor-transition (badge must not lag),
 * - 4s while the management dialog is open (the host is watching),
 * - 5s while a buy-in merely waits for the banker,
 * - 0 (one GET at join) otherwise - every host action reloads explicitly.
 */
export function botsPollMs(bots: BotPublic[], dialogOpen: boolean): number {
  if (botsInFlight(bots)) return 1500;
  if (dialogOpen) return 4000;
  if (bots.some((b) => AWAITING_HUMAN.has(b.status))) return 5000;
  return 0;
}

export interface RoomBotsState {
  bots: BotPublic[];
  /** True until the first successful read - lets callers avoid flashing an
   *  empty list while the request is still out. */
  loading: boolean;
  /** The last read error (sanitized display prose; null when healthy). */
  error: string | null;
  reload: () => void;
}

/**
 * Polls `GET /api/rooms/:id/bots` while `enabled`. `pollMs` is intentionally
 * caller-supplied so the page and the dialog can share ONE instance (seat
 * badges and the management list never disagree, and a dialog action refresh
 * repaints the felt too); pass `enabled: false` to park it.
 *
 * The route answers 403 for someone outside the room (a watch-link
 * spectator). `quiet` folds exactly THAT into "no badges" - a 503 or a
 * network failure still surfaces through `error`, because those are real
 * faults a member should hear about.
 */
export function useRoomBots(
  roomId: string | undefined,
  enabled: boolean,
  pollMs = 0,
  quiet = false,
): RoomBotsState {
  const [bots, setBots] = useState<BotPublic[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one read at a time: a slow response must never stack behind a poll tick
  const inFlight = useRef(false);
  // newest-request-wins: a response for an older room (or an older reload)
  // may not land on top of newer state - that is the room-switch guard
  const seq = useRef(0);
  const lastRoom = useRef<string | undefined>(undefined);

  const reload = useCallback(() => {
    if (!roomId) return;
    // a room change always re-reads, even with an old request still out
    const forced = roomId !== lastRoom.current;
    lastRoom.current = roomId;
    if (inFlight.current && !forced) return;
    inFlight.current = true;
    const my = ++seq.current;
    api
      .roomBots(roomId)
      .then((r) => {
        if (my !== seq.current) return;
        setBots(r.bots.filter((b) => b.status !== 'removed'));
        setLoaded(true);
        setError(null);
      })
      .catch((e: unknown) => {
        if (my !== seq.current) return;
        setLoaded(true);
        // only the spectator's expected 403 is silenced; 503 / network / 500
        // stay visible so a broken bot service never reads as "no bots"
        const silenced = quiet && e instanceof ApiError && e.status === 403;
        setError(silenced ? null : e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (my === seq.current) inFlight.current = false;
      });
  }, [roomId, quiet]);

  useEffect(() => {
    if (!enabled || !roomId) return;
    reload();
    if (pollMs <= 0) return;
    const iv = setInterval(reload, pollMs);
    return () => clearInterval(iv);
  }, [enabled, roomId, pollMs, reload]);

  return { bots, loading: enabled && !loaded, error, reload };
}
