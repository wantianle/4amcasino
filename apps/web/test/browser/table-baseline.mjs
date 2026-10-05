/** Phase 0 baseline: screenshot the 2D table in representative states.
 *
 * Drives the Vite dev server (BASE_URL, default http://localhost:5173) with a
 * synthetic room and mocked transport, mirroring the other browser tests here.
 * No real account or server state is touched.
 *
 *   PLAYWRIGHT_MODULE   path to a Playwright install (default 'playwright-core')
 *   BROWSER_EXECUTABLE  Chrome binary (default /usr/bin/google-chrome)
 *   UAT_OUTPUT          output directory (default /tmp/4am-table-baseline)
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://localhost:5173';
const out = process.env.UAT_OUTPUT || '/tmp/4am-table-baseline';
await mkdir(out, { recursive: true });
const sharedPath = fileURLToPath(
  new URL('../../../../packages/shared/src/index.ts', import.meta.url),
);

const MY_USER = 2;
const NAMES = ['Alex', 'Meera', 'Zoya', 'Ishaan', 'River', 'Jules', 'Mira', 'Sol', 'Sam'];

function makeRoom(count, mySeat) {
  return {
    t: 'room_state',
    room: {
      id: 'baseline',
      name: 'UI Baseline',
      joinCode: 'BASELN',
      hostId: MY_USER,
      bankerId: MY_USER,
      sb: 10,
      bb: 20,
      auditMode: 'private',
      actionTimeoutMs: 45000,
      actionSecs: 45,
      coBankerId: null,
      minSettleHands: 0,
      sevenDeuceBonus: 0,
      voided: false,
       meetLink: 'https://meet.example.test/baseline',
      autoApproveBuys: false,
      tvReplays: false,
      commissionBps: 50,
    },
    players: Array.from({ length: count }, (_, i) => ({
      seat: i,
      userId: i === mySeat ? MY_USER : 100 + i,
      username: (i === mySeat ? 'alex' : NAMES[i]).toLowerCase(),
      displayName: i === mySeat ? 'Alex' : NAMES[i],
      stack: 2000 - i * 137,
      connected: true,
      sittingOut: false,
      totalBought: 2000,
      hasAvatar: false,
      avatarVersion: 0,
      // L2 evidence: one seat carries a pending buy so the dashed pill shows
      // (seat after mine — never the hero, whose pod already runs TO ACT+bank)
      pendingBuy: i === (mySeat + 1) % count ? 2000 : 0,
    })),
    handActive: true,
  };
}

const SCENARIOS = [
  { name: 'desktop-9p-myturn', count: 9, mySeat: 4, kind: 'myturn' },
  { name: 'desktop-7p-myturn', count: 7, mySeat: 3, kind: 'myturn' },
  { name: 'desktop-6p-myturn', count: 6, mySeat: 3, kind: 'myturn' },
  { name: 'desktop-2p-headsup-myturn', count: 2, mySeat: 0, kind: 'myturn' },
  { name: 'desktop-9p-showdown', count: 9, mySeat: 4, kind: 'showdown' },
  { name: 'desktop-9p-waiting', count: 9, mySeat: 4, kind: 'waiting' },
  { name: 'desktop-9p-multirun3', count: 9, mySeat: 4, kind: 'multirun' },
  { name: 'desktop-4p-myturn', count: 4, mySeat: 1, kind: 'myturn' },
  { name: 'desktop-8p-myturn', count: 8, mySeat: 3, kind: 'myturn' },
  { name: 'idle-6p', count: 6, mySeat: 3, kind: 'idle' },
  { name: 'idle-empty-table', count: 1, mySeat: 0, kind: 'idle' },
];

const DESKTOP_VIEWS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
];
// L2 phone evidence: the merged layout renders the same locked canvas at
// exact 1/2 (590×330, PHONE_CANVAS). These shots verify the enlarged pods /
// hole cards don't collide on narrow canvases. VIEWS=phone | desktop | both.
const PHONE_VIEWS = [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 320, height: 700 },
  { width: 667, height: 375 },
  { width: 568, height: 320 },
];
const VIEW_MODE = process.env.VIEWS || 'desktop';
const VIEWPORTS =
  VIEW_MODE === 'phone'
    ? PHONE_VIEWS
    : VIEW_MODE === 'both'
      ? [...DESKTOP_VIEWS, ...PHONE_VIEWS]
      : DESKTOP_VIEWS;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});

const errors = [];
try {
  for (const sc of SCENARIOS) {
    const room = makeRoom(sc.count, sc.mySeat);
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        reducedMotion: process.env.MOTION_EVIDENCE === '1' ? 'no-preference' : 'reduce',
      });
      await ctx.addInitScript(
        (uid) =>
          localStorage.setItem(
            '4am-auth',
            JSON.stringify({
              state: {
                auth: { token: 'baseline-fixture', userId: uid, username: 'alex', identity: null },
              },
              version: 0,
            }),
          ),
        MY_USER,
      );
      await ctx.addInitScript(() => {
        localStorage.setItem('4am-sounds', 'off');
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(30000);
      page.on('pageerror', (e) => errors.push(`${sc.name}@${vp.width}: ${e.message}`));
      await page.route('**/api/**', (route) =>
        route.fulfill({
          json: {
            ok: true,
            userId: MY_USER,
            username: 'alex',
            displayName: 'Alex',
            rooms: [],
            requests: [],
            rows: [],
            friends: [],
            incoming: [],
            outgoing: [],
            hands: [],
            isPlatform: false,
            // DESIGN SCENARIO, not a product default: the baseline simulates an
            // account that explicitly chose the GG-mode deck (burgundy lattice
            // back + four-color suits) so the L2 seat-unit shots show the
            // approved look. As of the four-color/crimson flip these also match
            // the product default; the fixture still states them explicitly so
            // the scenario stays pinned regardless of future default changes.
            cardBack: 'crimson',
            fourColor: true,
            features: {
              squid: { enabled: true, penaltyBb: 100, minPlayers: 2 },
              timeBank: {
                enabled: true,
                initialSeconds: 30,
                refillEveryHands: 30,
                refillSeconds: 30,
              },
              bombPot: { enabled: true, anteBb: 3, schedule: { mode: 'hands', value: 10 } },
              multiRun: { enabled: true, maxRuns: 3 },
            },
          },
        }),
      );
      await page.routeWebSocket('**/*', (ws) =>
        ws.onMessage((data) => {
          const msg = JSON.parse(String(data));
          if (msg.t === 'join_room') {
            ws.send(JSON.stringify(room));
            if (sc.kind === 'myturn') {
              const seats = room.players.map((player) => ({ ...player }));
              const order = [
                0,
                1,
                sc.mySeat,
                ...seats
                  .map((player) => player.seat)
                  .filter((seat) => ![0, 1, sc.mySeat].includes(seat)),
              ];
              const bettingSeats = order.map((seat) => ({
                seat,
                stack: 2000 - seat * 137,
                committed: seat === 0 ? 10 : seat === 1 ? 20 : 0,
                total: seat === 0 ? 10 : seat === 1 ? 20 : 0,
                folded: false,
                allIn: false,
                lastActedAt: null,
              }));
              setTimeout(() => {
                ws.send(
                  JSON.stringify({
                    t: 'betting_state',
                    handId: 'baseline',
                    actionSeq: 0,
                    state: {
                      street: 'preflop',
                      seats: bettingSeats,
                      buttonSeat: 0,
                      sb: 10,
                      bb: 20,
                      currentBet: 20,
                      lastRaiseSize: 20,
                      lastFullRaiseAt: 20,
                      toAct: sc.mySeat,
                      needToAct: [sc.mySeat, ...order.filter((seat) => seat !== sc.mySeat)],
                      winnerByFold: null,
                    },
                    board: [],
                    deadline: Date.now() + 30000,
                    baseDeadline: Date.now() + 30000,
                  }),
                );
              }, 700);
            }
          }
        }),
      );

      await page.goto(`${base}/room/${room.room.id}`);
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Poker board"], .table-app-bg') !== null,
      );
      // Let the real room_state effect settle first. Injecting the visual hand
      // before that effect runs lets the websocket's empty hand win the race.
      await page.waitForFunction(
        async ({ count }) => {
          const { useStore } = await import('/src/shared/store.ts');
          return useStore.getState().room?.players.length === count;
        },
        { count: sc.count },
      );
      await page.evaluate(
        async ({ path, count, mySeat, kind, feature, motionEvidence, roomFixture }) => {
           const { useStore, emptyHand } = await import('/src/shared/store.ts');
           const { noteDealMotion } = await import('/src/shared/gameClient.ts');
          const { startHand, evaluate7 } = await import('/@fs' + path);
          const { deriveIdentity } = await import('/src/shared/crypto.ts');

          const s = useStore.getState();
          const fixtureAuth = {
            ...s.auth,
            token: 'baseline-fixture',
            userId: 2,
            username: 'alex',
            identity: deriveIdentity('alex', 'baseline'),
          };
          s.setAuth(fixtureAuth);
          s.setRoom(roomFixture);

          // The websocket mock is intentionally minimal and the page may not
          // have committed its room state before this fixture is applied.
          // Read from the fixture we are injecting rather than the stale
          // pre-navigation snapshot returned by getState().
          const players = roomFixture.players;
          const meSeat = players.find((p) => p.userId === 2).seat;
          const seatNums = players.map((p) => p.seat);
          const others = seatNums.filter((x) => x !== meSeat);
          const baseHand = {
            ...emptyHand,
            handId: 'baseline',
            seats: players,
            myCards: [0, 1],
            buttonSeat: (meSeat + 1) % count,
            // FEATURE=1 arms both P2 features so the L3 ribbon (bomb pill +
            // squid pill + bomb-before-flop note) is in every acceptance shot
            ...(feature
              ? {
                  featureStarted: {
                    handId: 'baseline',
                    bombPot: { enabled: true, anteBb: 3 },
                    squid: { enabled: true, penaltyBb: 100 },
                  },
                }
              : {}),
          };

          let hand = baseHand;
          if (kind === 'idle') {
            // L3/L4 evidence: no live hand — empty felt, sit spots, invite
            // entry (count=1); and the L4 merged card: host deal post +
            // auto-deal clock + ready check all in the bottom-right cluster
            hand = {
              ...emptyHand,
              autoDealAt: Date.now() + 7000,
              // a real server never runs a ready check on a solo table - only
              // the seated-idle shot carries the merged deal+ready card
              readyCheck:
                players.length > 1
                  ? {
                      deadlineTs: Date.now() + 12000,
                      eligible: players.map((p) => p.userId),
                      ready: players.slice(1, 3).map((p) => p.userId),
                    }
                  : null,
            };
          } else if (kind === 'waiting') {
            // L4 evidence: hand live, NOT your turn, you are dealt in →
            // the pre-action chips (call-any / check-fold / call N) render
            const order = [meSeat, others[0], others[1], ...others.slice(2)];
            const betting = startHand(
              order.map((seat) => ({ seat, stack: 2000 })),
              meSeat,
              10,
              20,
            );
            hand = {
              ...baseHand,
              betting,
              preAction: 'call-any',
              deadline: Date.now() + 30000,
              baseDeadline: Date.now() + 30000,
              timeBanks: { [meSeat]: 60000 },
            };
          } else if (kind === 'myturn') {
            const order = [others[0], others[1], meSeat, ...others.slice(2)];
            const betting = startHand(
              order.map((seat) => ({ seat, stack: 2000 })),
              order[0],
              10,
              20,
            );
            hand = {
              ...baseHand,
              betting,
              deadline: Date.now() + 30000,
              baseDeadline: Date.now() + 30000,
              // L2 evidence: time-bank pills — loud on the acting seat, a normal
              // value on one opponent, and the 0s quiet variant on another.
              timeBanks: {
                [meSeat]: 60000,
                [others[0]]: 45000,
                ...(others[1] !== undefined ? { [others[1]]: 0 } : {}),
              },
              lastActions: Object.fromEntries(
                order.slice(0, 2).map((seat) => [seat, { type: 'call' }]),
              ),
            };
          } else {
            const b1 = [20, 25, 29, 33, 41];
            const reveals = players.map((p, i) => {
              const cards = [(i * 2 + 3) % 52, (i * 2 + 4) % 52];
              return { seat: p.seat, cards, score: evaluate7([...b1, ...cards]) };
            });
            const winner = reveals.reduce((a, b) => (a.score > b.score ? a : b)).seat;
            const result = {
              t: 'hand_end',
              handId: 'baseline',
              head: 'baseline',
              commission: 2,
              stacks: players.map((p) => ({ seat: p.seat, stack: 2000 })),
              deltas: players.map((p) => ({
                seat: p.seat,
                delta: p.seat === winner ? 880 : -110,
              })),
            };
            if (kind === 'showdown') {
              hand = {
                ...baseHand,
                boards: [b1],
                showdown: {
                  t: 'showdown',
                  handId: 'baseline',
                  reveals,
                  awards: [{ seat: winner, amount: 990 }],
                },
                result,
              };
            } else if (kind === 'multirun') {
              const boards = [b1, [21, 26, 30, 34, 42], [22, 27, 31, 35, 43]];
              const awards = boards.map((_, r) => [
                { seat: reveals[(r + 1) % reveals.length].seat, amount: 990 },
              ]);
              hand = {
                ...baseHand,
                boards,
                showdown: {
                  t: 'showdown',
                  handId: 'baseline',
                  reveals,
                  awards: awards[0],
                  multiRun: { boards, awards },
                },
                result,
              };
            }
          }

           if (motionEvidence) {
             // The evidence run models a fresh server deal after the snapshot:
             // mount the empty hand first, then deliver the cards under a new
             // local deal epoch. This keeps the production rule (snapshots do
             // not animate) while making the capture deterministic.
             useStore.getState().resetHand({ ...hand, myCards: [], myCardPoints: [] });
             useStore.getState().resetHand(hand);
           } else {
             useStore.getState().resetHand(hand);
           }
           useStore.getState().setWsConnected(true);
        },
        {
          path: sharedPath,
          count: sc.count,
          mySeat: sc.mySeat,
          kind: sc.kind,
           feature: process.env.FEATURE === '1',
           motionEvidence:
             process.env.MOTION_EVIDENCE === '1' || process.env.MOTION_REDUCED_EVIDENCE === '1',
           roomFixture: room,
        },
      );

      await page.evaluate(async () => {
        for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
      });
      if (process.env.MOTION_EVIDENCE === '1' && sc.name === 'desktop-9p-myturn' && vp.width === 1440) {
        const probe = await page.evaluate(async () => {
          const ReactModule = await import('/node_modules/.vite/deps/react.js');
          const React = ReactModule.default ?? ReactModule;
          const ReactDomModule = await import('/node_modules/.vite/deps/react-dom_client.js');
          const { createRoot } = ReactDomModule.default ?? ReactDomModule;
          const { DealCard, activeDealRegistrySize } = await import('/src/widgets/table/DealCard.tsx');
          const { noteDealMotion } = await import('/src/shared/gameClient.ts');
          const canvas = document.querySelector('.table-canvas');
          if (!canvas) throw new Error('StrictMode probe: table canvas missing');
          let probeDeck = null;
          if (!canvas.querySelector('[data-table-deck]')) {
            probeDeck = document.createElement('div');
            probeDeck.setAttribute('data-table-deck', '');
            canvas.append(probeDeck);
          }
          const host = document.createElement('div');
          canvas.append(host);
          let animations = 0;
          const animationsSeen = [];
          const mediaQueries = [];
          let mediaAdds = 0;
          let mediaRemoves = 0;
          let mediaActive = 0;
          const originalMatchMedia = window.matchMedia;
          window.matchMedia = (query) => {
            const media = originalMatchMedia.call(window, query);
            if (query.includes('prefers-reduced-motion')) {
              mediaQueries.push(media);
              const listeners = new Set();
              const add = media.addEventListener.bind(media);
              const remove = media.removeEventListener.bind(media);
              media.addEventListener = (...args) => {
                if (!listeners.has(args[1])) { listeners.add(args[1]); mediaAdds += 1; mediaActive += 1; }
                return add(...args);
              };
              media.removeEventListener = (...args) => {
                if (listeners.delete(args[1])) { mediaRemoves += 1; mediaActive -= 1; }
                return remove(...args);
              };
            }
            return media;
          };
           const originalAnimate = Element.prototype.animate;
          Element.prototype.animate = function () {
            const animation = originalAnimate.apply(this, arguments);
            if (host.contains(this)) {
              animations += 1;
              animationsSeen.push(animation);
            }
            return animation;
          };
           const probeEpoch = noteDealMotion('strict-probe', 'hole:hero:0');
          const props = { handId: 'strict-probe', motionKey: 'hole:hero:0', epoch: probeEpoch, children: React.createElement('span', null, 'card') };
          const root = createRoot(host);
          root.render(React.createElement(React.StrictMode, null, React.createElement(DealCard, props)));
          await new Promise((resolve) => setTimeout(resolve, 50));
           const afterStrictMount = animations;
          const runningState = animationsSeen[0]?.playState;
          const lateOldFinish = animationsSeen[0]?.onfinish;
          root.render(React.createElement(React.StrictMode, null, React.createElement(DealCard, props)));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const afterRerender = animations;
          mediaQueries.forEach((media) => media.dispatchEvent(new Event('change')));
          await new Promise((resolve) => setTimeout(resolve, 20));
          const afterReducedState = animationsSeen[0]?.playState;
           root.unmount();
          await new Promise((resolve) => setTimeout(resolve, 30));
          const afterUnmountState = animationsSeen[0]?.playState;
          const registryAfterUnmount = activeDealRegistrySize();
          const remount = createRoot(host);
          remount.render(React.createElement(React.StrictMode, null, React.createElement(DealCard, props)));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const afterLateRemount = animations;
          remount.unmount();
          await new Promise((resolve) => setTimeout(resolve, 30));
          const registryAfterRemount = activeDealRegistrySize();
          const nextEpoch = noteDealMotion('strict-probe', 'hole:hero:0');
          const nextRoot = createRoot(host);
          nextRoot.render(React.createElement(React.StrictMode, null, React.createElement(DealCard, {
            ...props,
            epoch: nextEpoch,
          })));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const afterNewEpoch = animations;
          const oldAnimationAfterNewEpoch = animationsSeen[0]?.playState;
          const newElement = host.querySelector('.table-dealt-card');
          const newMarkerBeforeLateFinish = newElement?.dataset.dealing === 'true';
          const registryBeforeLateFinish = activeDealRegistrySize();
          lateOldFinish?.();
          const newMarkerAfterLateFinish = newElement?.dataset.dealing === 'true';
          const registryAfterLateFinish = activeDealRegistrySize();
          nextRoot.unmount();
          await new Promise((resolve) => setTimeout(resolve, 30));
           const registryAfterNewEpoch = activeDealRegistrySize();
           Element.prototype.animate = originalAnimate;
          window.matchMedia = originalMatchMedia;
          host.remove();
          probeDeck?.remove();
          return {
            afterStrictMount,
            afterRerender,
            afterLateRemount,
            afterReducedState,
            afterNewEpoch,
            oldAnimationAfterNewEpoch,
            runningState,
            afterUnmountState,
            registryAfterUnmount,
            registryAfterRemount,
            registryAfterNewEpoch,
            mediaActive,
            mediaAdds,
            mediaRemoves,
            newMarkerBeforeLateFinish,
            newMarkerAfterLateFinish,
            registryBeforeLateFinish,
            registryAfterLateFinish,
          };
          });
        if (probe.afterStrictMount !== 1 || probe.afterRerender !== 1 || probe.afterLateRemount !== 1)
          throw new Error(`${sc.name}: StrictMode motion probe failed ${JSON.stringify(probe)}`);
        if (!(probe.mediaAdds > 0) || probe.mediaAdds !== probe.mediaRemoves || probe.mediaActive !== 0)
          throw new Error(`${sc.name}: media listener probe failed ${JSON.stringify({ mediaAdds: probe.mediaAdds, mediaRemoves: probe.mediaRemoves, mediaActive: probe.mediaActive })}`);
        if (probe.runningState !== 'running' || !['idle', 'finished'].includes(probe.afterReducedState) || !['idle', 'finished'].includes(probe.afterUnmountState) || probe.afterNewEpoch !== 2 || !['idle', 'finished'].includes(probe.oldAnimationAfterNewEpoch) || probe.registryAfterUnmount !== 0 || probe.registryAfterRemount !== 0 || probe.registryAfterNewEpoch !== 0 || probe.mediaActive !== 0 || !probe.newMarkerBeforeLateFinish || !probe.newMarkerAfterLateFinish || probe.registryBeforeLateFinish !== 1 || probe.registryAfterLateFinish !== 1)
          throw new Error(`${sc.name}: animation lifecycle probe failed ${JSON.stringify(probe)}`);
        const boardProbe = await page.evaluate(async () => {
          const { useStore } = await import('/src/shared/store.ts');
          const { handle, dealMotionEpoch, boardMotionKey } = await import('/src/shared/gameClient.ts');
          const saved = useStore.getState().hand;
          try {
            useStore.getState().resetHand({ ...saved, handId: 'board-handler-probe', boards: [[30,32,31], [30,32,31]] });
            const send = (card, deckIndex, run = 1) => handle({ t: 'board_open', handId: 'board-handler-probe', card, deckIndex, run });
            const snapshotEpochs = [];
            for (const run of [1, 2]) {
              for (const [card, deckIndex] of [[31, 12], [30, 10], [32, 11]]) {
                send(card, deckIndex, run);
                const epoch = dealMotionEpoch('board-handler-probe', boardMotionKey('board-handler-probe', run - 1, card));
                snapshotEpochs.push({ run, card, epoch });
                if (epoch !== 0)
                  throw new Error(`snapshot replay advanced epoch ${JSON.stringify({ run, card, epoch })}`);
              }
            }
            useStore.getState().resetHand({ ...useStore.getState().hand, handId: 'board-handler-probe', boards: [[30,32,31], [30,32,31]] });
            send(33,13);
            send(34,15,2);
            const boards = useStore.getState().hand.boards;
            if (JSON.stringify(boards) !== '[[30,32,31,33],[30,32,31,34]]') throw new Error(JSON.stringify(boards));
            useStore.getState().resetHand({ ...saved, handId: 'board-order-probe', boards: [[], []] });
            const sendOrder = (card, deckIndex, run = 1) => handle({ t: 'board_open', handId: 'board-order-probe', card, deckIndex, run });
            sendOrder(31,12); sendOrder(30,10); sendOrder(32,11); sendOrder(34,15,2);
            const ordered = useStore.getState().hand.boards;
            if (JSON.stringify(ordered) !== '[[30,32,31],[34]]') throw new Error(`unordered handler result ${JSON.stringify(ordered)}`);
            handle({ t: 'betting_state', handId: 'board-handler-probe', actionSeq: 1, state: {
              street: 'turn', seats: [], buttonSeat: 0, sb: 10, bb: 20, currentBet: 20,
              lastRaiseSize: 20, lastFullRaiseAt: 20, toAct: null, needToAct: [], winnerByFold: null,
            }, board: [30,32,31,33,35], deadline: null });
            const corrected = useStore.getState().hand.boards[0];
            if (JSON.stringify(corrected) !== '[30,32,31,33,35]') throw new Error('authoritative correction failed');
            return { boards, corrected, snapshotEpochs };
          } finally { useStore.getState().resetHand(saved); }
        });
        console.log(`board handler probe ${JSON.stringify(boardProbe)}`);
        console.log(`motion contract probe ${JSON.stringify(probe)}`);
      }
      if (process.env.MOTION_EVIDENCE === '1' && sc.kind === 'myturn') {
        await page.evaluate(async () => {
          const { useStore } = await import('/src/shared/store.ts');
          const { noteDealMotion } = await import('/src/shared/gameClient.ts');
          noteDealMotion('baseline', 'hole:hero:0');
          noteDealMotion('baseline', 'hole:hero:1');
          const current = useStore.getState().hand;
          useStore.getState().patchHand({ myCards: [...current.myCards] });
          useStore.getState().patchHand({ featureStarted: { bombPot: { enabled: true, anteBb: 3 } } });
        });
        await page.waitForSelector('[data-testid="bomb-pot-intro"]', { state: 'visible' });
         if (!(await page.locator('[data-testid="bomb-pot-intro"]').getByText(/炸弹池|Bomb pot/i).count()))
          throw new Error(`${sc.name}: bomb-pot intro text is missing`);
        if ((await page.locator('[data-dealing="true"]').count()) === 0)
          throw new Error(`${sc.name}: no deal animation was in progress`);
        await page.screenshot({ path: `${out}/motion-in-progress.png` });
      }
      if (process.env.MOTION_REDUCED_EVIDENCE === '1' && sc.kind === 'myturn') {
        await page.evaluate(async () => {
          const { useStore } = await import('/src/shared/store.ts');
          const { noteDealMotion } = await import('/src/shared/gameClient.ts');
          noteDealMotion('baseline', 'hole:hero:0');
          noteDealMotion('baseline', 'hole:hero:1');
          const current = useStore.getState().hand;
          useStore.getState().patchHand({ myCards: [...current.myCards] });
          useStore.getState().patchHand({ featureStarted: { bombPot: { enabled: true, anteBb: 3 } } });
        });
        await page.waitForSelector('[data-testid="bomb-pot-intro"]', { state: 'visible' });
         if (!(await page.locator('[data-testid="bomb-pot-intro"]').getByText(/炸弹池|Bomb pot/i).count()))
          throw new Error(`${sc.name}: bomb-pot prompt missing in reduced-motion mode`);
        if ((await page.locator('[data-dealing="true"]').count()) !== 0)
          throw new Error(`${sc.name}: reduced-motion still has an active deal animation`);
        await page.screenshot({ path: `${out}/reduced-motion-static.png` });
      }
      await page.waitForFunction(
        async ({ kind, mySeat }) => {
          const { useStore } = await import('/src/shared/store.ts');
          const hand = useStore.getState().hand;
          if (kind === 'myturn') {
            return (
              hand.handId !== null &&
              hand.betting !== null &&
              hand.betting.toAct === mySeat &&
              hand.seats.some((seat) => seat.seat === mySeat) &&
              hand.myCards.length >= 2
            );
          }
          if (kind === 'waiting') return hand.betting !== null;
          if (kind === 'idle') return hand.betting === null;
          if (kind === 'showdown' || kind === 'multirun') return hand.result !== null;
          return false;
        },
        { kind: sc.kind, mySeat: sc.mySeat },
      );
      await page.waitForTimeout(1500);
      if (sc.kind === 'myturn') {
        // Clone the already-valid snapshot once more after the page effects
        // settle. This forces every subscribed panel to render the same
        // authoritative hand, rather than retaining the pre-deal branch from
        // the websocket fixture's first paint.
        await page.evaluate(async () => {
          const { useStore } = await import('/src/shared/store.ts');
          const state = useStore.getState();
          const nextHand = {
            ...state.hand,
            handId: state.hand.handId || 'baseline',
            readyCheck: null,
            betting: state.hand.betting
              ? {
                  ...state.hand.betting,
                  toAct:
                    state.room?.players.find((p) => p.userId === 2)?.seat ??
                    state.hand.betting.toAct,
                }
              : null,
          };
          useStore.getState().patchHand(nextHand);
          const refreshed = useStore.getState();
          if (refreshed.room) {
            refreshed.setRoom({
              ...refreshed.room,
              players: refreshed.room.players.map((player) => ({ ...player })),
            });
          }
        });
      }
      if (sc.kind === 'myturn') {
        const handStateBeforeShot = await page.evaluate(async () => {
          const { useStore } = await import('/src/shared/store.ts');
          const state = useStore.getState();
          return {
            hand: state.hand,
            mySeat: state.room?.players.find((p) => p.userId === 2)?.seat,
          };
        });
        if (
          handStateBeforeShot.hand.betting === null ||
          handStateBeforeShot.hand.betting.toAct !== handStateBeforeShot.mySeat
        ) {
          throw new Error(`${sc.name}: hero is not to act before shot`);
        }
        await page.waitForSelector('[data-testid="gameplay-squid"]');
        await page.waitForSelector('[data-testid="gameplay-bomb"]');
         const bombIntroVisible = await page.locator('[data-testid="bomb-pot-intro"]').isVisible().catch(() => false);
         // Bomb-pot preflop intentionally has no action buttons: the hand goes
         // straight to the flop. The intro itself is the contract for this path.
          const motionBombPath = process.env.MOTION_EVIDENCE === '1';
          if (!bombIntroVisible && !motionBombPath) await page.waitForSelector('[data-testid="betting-panel"] button:not([disabled])');
          if (!bombIntroVisible && !motionBombPath && !(await page.getByText(/轮到你了|Your turn/i).count())) {
          throw new Error(
            `${sc.name}: turn prompt is missing; body=${(await page.locator('body').innerText()).slice(-1200)}`,
          );
        }
          const actionText = bombIntroVisible || motionBombPath ? 'Bomb pot' : (
          await page
            .locator('[data-testid="betting-panel"] button:not([disabled])')
            .allTextContents()
         ).join(' ');
          if (!bombIntroVisible && !motionBombPath && (!/弃牌|Fold/i.test(actionText) || !/跟|过牌|Call|Check/i.test(actionText))) {
          throw new Error(
            `${sc.name}: usable fold/call-or-check actions are missing: ${actionText}`,
          );
        }
      }
      if (vp.width === 390) {
        const bounds = await page.evaluate(() => {
          const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
          const labels = [
            ...document.querySelectorAll(
              '[data-testid="table-header"] button, [data-testid="table-header"] a',
            ),
          ].map((el) => ({
            label:
              el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim(),
            rect: el.getBoundingClientRect().toJSON(),
          }));
          const menu = rect('[data-testid="table-more"]');
          const history = rect('[data-testid="mobile-history"]');
          const chips = rect('[aria-label="Chips"]');
          return { width: innerWidth, labels, menu, history, chips };
        });
        const required = [
          'mobile-history',
          'mobile-auto-deal',
          'mobile-bots',
          'mobile-invite',
          'mobile-watch',
        ];
        const controls = await page.evaluate(
          (selectors) =>
            selectors.map((selector) => {
              const el = document.querySelector(`[data-testid="${selector}"]`);
              const rect = el?.getBoundingClientRect();
              if (!el || !rect) return { selector, missing: true };
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              const hit = document.elementFromPoint(cx, cy);
              return {
                selector,
                missing: false,
                width: rect.width,
                height: rect.height,
                inViewport:
                  rect.left >= 0 &&
                  rect.top >= 0 &&
                  rect.right <= innerWidth &&
                  rect.bottom <= innerHeight,
                hit: hit === el || hit?.closest(`[data-testid="${selector}"]`) === el,
              };
            }),
          required,
        );
        if (
          controls.some(
            (control) =>
              control.missing ||
              !control.inViewport ||
              !control.hit ||
              control.width < 44 ||
              control.height < 44,
          )
        ) {
          throw new Error(`${sc.name}: mobile header bounds invalid ${JSON.stringify(bounds)}`);
        }
         const moreCount = await page.locator('[data-testid="table-more"]').count();
         if (moreCount !== 0) {
           throw new Error(`${sc.name}: mobile must not render the desktop table-more entry`);
          }
          await page.locator('[data-testid="mobile-table-utilities"]').click();
          await page.locator('[role="menu"]').waitFor({ state: 'visible' });
          for (const action of ['auto-deal', 'sit-out', 'bots']) {
            const count = await page.locator(`[data-testid="mobile-utility-${action}"]`).count();
            if (count !== 0) throw new Error(`${sc.name}: duplicate mobile ${action} utility count=${count}`);
          }
          for (const action of ['video', 'timer', 'preferences', 'fullscreen', 'voice']) {
            const entry = page.locator(`[data-testid="mobile-utility-${action}"]`);
            if (!(await entry.count())) {
              throw new Error(`${sc.name}: mobile ${action} utility entry missing`);
            }
            const target = action === 'timer'
              ? entry.locator('select')
              : action === 'fullscreen' || action === 'voice'
                ? entry.locator('button').or(entry.and(page.locator('button')))
                : entry.locator('a,button');
            if (!(await target.count()) || !(await target.isVisible()))
              throw new Error(`${sc.name}: mobile ${action} utility must be visible`);
            // Timer belongs to the utility group, but is deliberately disabled
            // during a live hand. Idle fixtures assert the complete enabled
            // contract; live fixtures assert timer presence plus disabled state.
            const timerIsLive = action === 'timer' && ['myturn', 'waiting'].includes(sc.kind);
            if (timerIsLive ? !(await target.isDisabled()) : !(await target.isEnabled()))
              throw new Error(
                `${sc.name}: mobile ${action} utility must be ${timerIsLive ? 'disabled' : 'enabled'}`,
              );
          }
         await page.keyboard.press('Escape');
        await page.locator('[data-testid="chips-trigger"]').click();
        const chipsMenuBounds = await page.locator('[role="menu"]').first().boundingBox();
        if (
          !chipsMenuBounds ||
          chipsMenuBounds.x < 0 ||
          chipsMenuBounds.x + chipsMenuBounds.width > bounds.width
        ) {
          throw new Error(
            `${sc.name}: chips menu bounds invalid ${JSON.stringify(chipsMenuBounds)}`,
          );
        }
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(400);
      const file = `${out}/${sc.name}-${vp.width}x${vp.height}.png`;
      await page.screenshot({ path: file });
      if (sc.kind === 'myturn') {
        const handStateAfterShot = await page.evaluate(async () => {
          const { useStore } = await import('/src/shared/store.ts');
          const state = useStore.getState();
          return {
            hand: state.hand,
            mySeat: state.room?.players.find((p) => p.userId === 2)?.seat,
          };
        });
        if (
          handStateAfterShot.hand.betting === null ||
          handStateAfterShot.hand.betting.toAct !== handStateAfterShot.mySeat
        ) {
          throw new Error(`${sc.name}: hero stopped being to act after shot`);
        }
      }
      // Capture the two menus as evidence as well as the resting layout. The
      // chip hub and ⋮ trigger both expose aria-haspopup="menu"; selecting
      // the last trigger keeps this stable if the header gains another menu.
      const menuTriggers = page.locator('button[aria-haspopup="menu"]');
      const menuCount = await menuTriggers.count();
      if (menuCount > 0) {
        await menuTriggers.nth(0).click();
        await page.screenshot({
          path: `${out}/${sc.name}-${vp.width}x${vp.height}-chips-menu.png`,
        });
        await page.keyboard.press('Escape');
      }
      if (menuCount > 1) {
        await menuTriggers.nth(menuCount - 1).click();
        await page.screenshot({ path: `${out}/${sc.name}-${vp.width}x${vp.height}-more-menu.png` });
        await page.keyboard.press('Escape');
      }
      console.log(`shot ${file}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
if (errors.length) {
  console.error(`PAGE ERRORS:\n${errors.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('no page errors');
}
