import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BotsDialog } from '../src/features/bots/BotsDialog.tsx';
import { t } from '../src/shared/i18n/index.ts';
import type { BotPublic } from '../src/shared/api.ts';

/**
 * The host's create entry must disappear once the table is full
 * (seated humans + SEATED bots >= MAX_TABLE_PLAYERS_WITH_BOTS), so the host
 * cannot
 * fill in a form the server would only reject. Pure render assertion - the
 * route itself is covered in apps/server/test/botTableCap.test.ts.
 */

function bot(i: number, seated = true): BotPublic {
  return {
    id: `bot-${i}`,
    userId: 100 + i,
    username: `bot_${i}`,
    displayName: `Bot ${i}`,
    seat: i,
    seated,
    configuredSeat: i,
    status: 'running',
    policyKind: 'scripted',
    difficulty: 'medium',
    createdAt: 1,
    updatedAt: 1,
    stoppedAt: null,
    stopRequestedAt: null,
    identityRecoverable: true,
    stack: 1000,
  };
}

function renderBots(seatedHumans: number, bots: BotPublic[]): string {
  return renderToStaticMarkup(
    <BotsDialog
      roomId="room-1"
      open
      onClose={() => {}}
      takenSeats={Array.from({ length: seatedHumans + bots.length }, (_, i) => i)}
      seatedHumans={seatedHumans}
      bb={20}
      bots={bots}
      loading={false}
      error={null}
      reload={() => {}}
    />,
  );
}

function render(seatedHumans: number, botCount: number): string {
  return renderBots(
    seatedHumans,
    Array.from({ length: botCount }, (_, i) => bot(i)),
  );
}

describe('BotsDialog 6-max capacity', () => {
  it('hides the create form with 1 human + 5 bots', () => {
    const markup = render(1, 5);
    expect(markup).toContain(
      t(
        'This table is full (6 players, bots included) - remove a bot or have a player stand up first.',
      ),
    );
    expect(markup).not.toContain(t('Seat & start'));
  });

  it('hides the create form with no human + 6 bots', () => {
    const markup = render(0, 6);
    expect(markup).not.toContain(t('Seat & start'));
  });

  it('shows the create form while a slot is free', () => {
    const markup = render(1, 4);
    expect(markup).toContain(t('Seat & start'));
    expect(markup).not.toContain(
      t(
        'This table is full (6 players, bots included) - remove a bot or have a player stand up first.',
      ),
    );
  });

  it('does not count an UNSEATED bot row toward the cap', () => {
    // 6 ghost bot rows with no real seat + 0 humans: the table is NOT full, so
    // the create form stays. The server's `botCapacity` ignores ghosts too, so
    // this is the mirror that must not drift.
    const ghosts = Array.from({ length: 6 }, (_, i) => bot(i, false));
    const markup = renderBots(0, ghosts);
    expect(markup).toContain(t('Seat & start'));
    expect(markup).toContain(t('Up to 6 players including bots - {left} more can join.', { left: 6 }));
  });

  it('counts seated and unseated rows correctly together', () => {
    // 1 human + 5 seated bots + 3 ghosts = full (ghosts invisible).
    const bots = [
      ...Array.from({ length: 5 }, (_, i) => bot(i, true)),
      ...Array.from({ length: 3 }, (_, i) => bot(10 + i, false)),
    ];
    const markup = renderBots(1, bots);
    expect(markup).not.toContain(t('Seat & start'));
  });
});
