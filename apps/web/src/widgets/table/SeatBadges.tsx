import type { HudPlayer } from '../../features/stats/types.ts';

export function isValidHudPlayer(value: unknown): value is HudPlayer {
  const userId = value && typeof value === 'object' ? (value as { userId?: unknown }).userId : undefined;
  return Number.isInteger(userId) && (userId as number) > 0;
}

export function vpipTone(value: number) {
  return value < 10 ? 'red' : value < 20 ? 'yellow' : value < 30 ? 'green' : value < 40 ? 'blue' : 'purple';
}

export function SeatBadges({ player, minHands }: { player?: HudPlayer; minHands: number }) {
  const value = player?.stats?.vpip?.pct;
  const visible = player && isValidHudPlayer(player) && !player.hidden && player.sufficient && player.confidence !== 'insufficient'
    && player.sample >= Math.max(minHands, player.minHands) && value != null;
  return <span className="table-seat-badges">
    {visible && <span className={`table-vpip table-vpip--${vpipTone(value)}`} title={`VPIP ${value}% · ${player.sample}`} aria-label={`VPIP ${value}%`}>{Math.round(value)}</span>}
    {/* TODO: RoomHud has no explicit last-50-hands net BB field. Do not use
        lifetime bb100/net as a proxy. Reserved slot: ±30 small, ±85 large;
        neutral is absent. Render ice/fire only after the window is supplied. */}
    <span className="table-temperature-slot" />
  </span>;
}
