/** L6 phone layout debt probe: quantify the overlap the screenshots only hint
 *  at. For each scenario x viewport it walks the live DOM and reports:
 *
 *  - textCov   : fraction of every seat-pod TEXT line's area (name / stack /
 *                action / strength / state / pills) that is NOT covered by a
 *                foreign subtree (another pod, the board column, the felt bet
 *                piles, the action cluster, the dock, overlays). 1 = clean.
 *  - boardCov  : fraction of the community-card row area (dealt cards + empty
 *                slots, center column) NOT covered by pods, pills, piles or
 *                any fixed control. 1 = clean.
 *  - podPairPx : summed pairwise intersection area between pod subtrees
 *                (the structural 9p showdown/multirun overlap).
 *  - clusterVsSeats / dockVsCluster / clusterVsStageLeft : the corner-control
 *                collisions L4 flagged for phone.
 *  - effective text px: computed font sizes x the canvas scale k.
 *
 *   PLAYWRIGHT_MODULE   path to a Playwright install (default 'playwright-core')
 *   BROWSER_EXECUTABLE  Chrome binary (default /usr/bin/google-chrome)
 *   UAT_OUTPUT          output directory (default /tmp/4am-table-overlap)
 *   VIEWS               phone | desktop | both        (default phone)
 *   BASE_URL            dev server (default http://localhost:5173)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://localhost:5173';
const out = process.env.UAT_OUTPUT || '/tmp/4am-table-overlap';
await mkdir(out, { recursive: true });
const sharedPath = fileURLToPath(
  new URL('../../../../packages/shared/src/index.ts', import.meta.url),
);

const MY_USER = 2;
const LOCALE = process.env.LOCALE || 'zh-CN';
/** ASSERT=1 turns the report into a gate (for CI):
 *  - desktop 1440x900 / 1280x720: podPairPx (pairwise pod overlap) must be 0;
 *  - primary phone 390x844 / 667x375: textCov/boardCov thresholds, dock-vs-cluster
 *    and touch-target sizes must pass.
 *  Phone podPairPx and short-landscape cluster-covered pods are retained as
 *  explicit DIAGNOSTICS (reported in JSON/README), not zero-collision gates.
 *  `clusterVisible=1` on 390 means the cluster is not clipped by its ancestor,
 *  NOT that it never overlaps a seat pod. Secondary views stay informational. */
const ASSERT = process.env.ASSERT === '1';
const EXPECT_HERO = process.env.EXPECT_HERO === '1';
const SELF_PATH = fileURLToPath(import.meta.url);
const probeHash = createHash('sha256')
  .update(await readFile(SELF_PATH))
  .digest('hex')
  .slice(0, 12);
const gitHash = process.env.GIT_HASH || null;
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
      pendingBuy: i === (mySeat + 1) % count ? 2000 : 0,
    })),
    handActive: true,
  };
}

const SCENARIOS = [
  { name: '9p-myturn', count: 9, mySeat: 4, kind: 'myturn' },
  { name: '9p-showdown', count: 9, mySeat: 4, kind: 'showdown' },
  { name: '9p-multirun3', count: 9, mySeat: 4, kind: 'multirun' },
  { name: '2p-headsup-myturn', count: 2, mySeat: 0, kind: 'myturn' },
  { name: '4p-myturn', count: 4, mySeat: 1, kind: 'myturn' },
  { name: '8p-myturn', count: 8, mySeat: 3, kind: 'myturn' },
  { name: 'idle-6p', count: 6, mySeat: 3, kind: 'idle' },
];

const DESKTOP_VIEWS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
];
const PHONE_VIEWS = [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 320, height: 700 },
  { width: 667, height: 375 },
  { width: 568, height: 320 },
];
const VIEW_MODE = process.env.VIEWS || 'phone';
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
const results = [];
try {
  for (const sc of SCENARIOS) {
    const room = makeRoom(sc.count, sc.mySeat);
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        reducedMotion: 'reduce',
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
      await ctx.addInitScript((loc) => {
        localStorage.setItem('4am.locale', JSON.stringify({ state: { locale: loc }, version: 0 }));
      }, LOCALE);
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
            cardBack: 'crimson',
            fourColor: true,
          },
        }),
      );
      await page.routeWebSocket('**/*', (ws) =>
        ws.onMessage((data) => {
          const msg = JSON.parse(String(data));
          if (msg.t === 'join_room') {
            ws.send(JSON.stringify(room));
            if (sc.kind === 'myturn') {
              const order = [
                ...new Set([
                  0,
                  1,
                  sc.mySeat,
                  ...room.players
                    .map((p) => p.seat)
                    .filter((seat) => ![0, 1, sc.mySeat].includes(seat)),
                ]),
              ];
              setTimeout(
                () =>
                  ws.send(
                    JSON.stringify({
                      t: 'betting_state',
                      handId: 'baseline',
                      actionSeq: 0,
                      state: {
                        street: 'preflop',
                        seats: order.map((seat) => ({
                          seat,
                          stack: 2000 - seat * 137,
                          committed: seat === 0 ? 10 : seat === 1 ? 20 : 0,
                          total: seat === 0 ? 10 : seat === 1 ? 20 : 0,
                          folded: false,
                          allIn: false,
                          lastActedAt: null,
                        })),
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
                  ),
                250,
              );
            }
          }
        }),
      );

      await page.goto(`${base}/room/${room.room.id}`);
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Poker board"], .table-app-bg') !== null,
      );
      await page.waitForFunction(
        async ({ count }) => {
          const storeUrl = performance
            .getEntriesByType('resource')
            .map((r) => r.name)
            .find((url) => /\/src\/shared\/store\.ts(?:\?|$)/.test(url));
          const { useStore } = await import(storeUrl);
          return useStore.getState().room?.players.length === count;
        },
        { count: sc.count },
      );
      await page.evaluate(
        async ({ path, count, mySeat, kind, roomFixture }) => {
          const storeUrl = performance
            .getEntriesByType('resource')
            .map((r) => r.name)
            .find((url) => /\/src\/shared\/store\.ts(?:\?|$)/.test(url));
          const { useStore, emptyHand } = await import(storeUrl);
          const { startHand, evaluate7 } = await import('/@fs' + path);
          const { deriveIdentity } = await import('/src/shared/crypto.ts');

          const s = useStore.getState();
          s.setAuth({
            ...s.auth,
            token: 'baseline-fixture',
            userId: 2,
            username: 'alex',
            identity: deriveIdentity('alex', 'baseline'),
          });
          s.setRoom(roomFixture);

          const players = roomFixture.players;
          const meSeat = players.find((p) => p.userId === 2).seat;
          const seatNums = players.map((p) => p.seat);
          const others = seatNums.filter((x) => x !== meSeat);
          const activeSeats = players.map((p) => ({
            ...p,
            inHand: kind !== 'idle',
            folded: false,
          }));
          const baseHand = {
            ...emptyHand,
            handId: 'baseline',
            seats: activeSeats,
            myCards: [0, 1],
            buttonSeat: (meSeat + 1) % count,
          };

          let hand = baseHand;
          if (kind === 'idle') {
            hand = {
              ...emptyHand,
              autoDealAt: Date.now() + 7000,
              readyCheck:
                players.length > 1
                  ? {
                      deadlineTs: Date.now() + 12000,
                      eligible: players.map((p) => p.userId),
                      ready: players.slice(1, 3).map((p) => p.userId),
                    }
                  : null,
            };
          } else if (kind === 'myturn') {
            const order =
              count === 2
                ? [meSeat, others[0]]
                : [others[0], others[1], meSeat, ...others.slice(2)];
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

          useStore.getState().resetHand(hand);
          useStore.getState().setWsConnected(true);
        },
        { path: sharedPath, count: sc.count, mySeat: sc.mySeat, kind: sc.kind, roomFixture: room },
      );

      await page.evaluate(async () => {
        for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
      });
      await page.waitForTimeout(350);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(
        async ({ kind, mySeat }) => {
          const storeUrl = performance
            .getEntriesByType('resource')
            .map((r) => r.name)
            .find((url) => /\/src\/shared\/store\.ts(?:\?|$)/.test(url));
          const { useStore } = await import(storeUrl);
          const hand = useStore.getState().hand;
          if (kind === 'myturn') return hand.betting?.toAct === mySeat && hand.myCards.length >= 2;
          if (kind === 'showdown')
            return (
              hand.result !== null &&
              hand.boards.some((b) => b.length >= 5) &&
              (hand.showdown?.reveals?.length ?? 0) > 0
            );
          if (kind === 'multirun')
            return (
              hand.result !== null &&
              hand.boards.length === 3 &&
              hand.boards.every((b) => b.length >= 5)
            );
          if (kind === 'idle') return hand.betting === null;
          return false;
        },
        { kind: sc.kind, mySeat: sc.mySeat, expectHero: EXPECT_HERO },
      );
      await page.evaluate(async () => {
        for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
      });
      await page.waitForTimeout(250);
      if (sc.kind === 'myturn') {
        await page.evaluate(
          async ({ mySeat }) => {
            const storeUrl = performance
              .getEntriesByType('resource')
              .map((r) => r.name)
              .find((url) => /\/src\/shared\/store\.ts(?:\?|$)/.test(url));
            const { useStore } = await import(storeUrl);
            const state = useStore.getState();
            const hand = state.hand;
            state.patchHand({
              ...hand,
              handId: hand.handId || 'baseline',
              seats: state.room?.players ?? hand.seats,
              myCards: hand.myCards.length >= 2 ? hand.myCards : [0, 1],
              betting: hand.betting ? { ...hand.betting, toAct: mySeat } : hand.betting,
            });
          },
          { mySeat: sc.mySeat },
        );
      }

      /* ── the probe itself ─────────────────────────────────────────────── */
      // BettingPanel deliberately holds its action buttons disabled for one
      // settling beat whenever the live options change.  A fixed 400 ms sleep
      // races the 400 ms guard (and made the fixture report "missing actions"
      // even though the injected hand was live).  Wait for the actual live
      // state and controls instead; this keeps the probe's assertion intact.
      if (sc.kind === 'myturn') {
        // The table page mounts its corner console after the room snapshot has
        // produced a seated `me` view.  The hand store can be ready one render
        // before that subtree exists, so do not sample the DOM in that gap.
        await page.waitForFunction(async () => {
          if (document.querySelector('[data-testid="betting-panel"]')) return true;
          const storeUrl = performance
            .getEntriesByType('resource')
            .map((r) => r.name)
            .find((url) => /\/src\/shared\/store\.ts(?:\?|$)/.test(url));
          if (!storeUrl) return false;
          const { useStore } = await import(storeUrl);
          const state = useStore.getState();
          return !!state.room && state.room.players.length > 0;
        });
        await page.waitForFunction(async ({ mySeat }) => {
          const storeUrl = performance
            .getEntriesByType('resource')
            .map((r) => r.name)
            .find((url) => /\/src\/shared\/store\.ts(?:\?|$)/.test(url));
          const { useStore } = await import(storeUrl);
          const hand = useStore.getState().hand;
          const actions = document.querySelectorAll(
            '[data-testid="betting-panel"] button:not([disabled])',
          ).length;
          return hand.betting?.toAct === mySeat && actions >= 2;
        }, { mySeat: sc.mySeat });
      } else {
        await page.waitForTimeout(400);
      }
      const scene = await page.evaluate(
        async ({ kind, mySeat, expectHero }) => {
          const storeUrl = performance
            .getEntriesByType('resource')
            .map((r) => r.name)
            .find((url) => /\/src\/shared\/store\.ts(?:\?|$)/.test(url));
          const { useStore } = await import(storeUrl);
          const h = useStore.getState().hand;
          const faces = document.querySelectorAll(
            '.table-center-col [data-card-size][role="img"]',
          ).length;
          const heroCards = document.querySelectorAll(
            '[data-testid="hero-hole-cards"] [data-card-size]',
          ).length;
          const runs = document.querySelectorAll('.table-run-chip').length;
          const actions = document.querySelectorAll(
            '[data-testid="betting-panel"] button:not([disabled])',
          ).length;
          if (kind === 'myturn' && (h.betting?.toAct !== mySeat || actions < 2))
            throw new Error(
              `Missing live betting actions: toAct=${h.betting?.toAct ?? 'null'} mySeat=${mySeat} actions=${actions} actionSeq=${h.actionSeq} ws=${useStore.getState().wsConnected} auth=${useStore.getState().auth.userId} players=${useStore.getState().room?.players.map((p) => `${p.userId}:${p.seat}`).join(',')} result=${!!h.result} abort=${!!h.abort} bettingPanel=${!!document.querySelector('[data-testid="betting-panel"]')} buttons=${[...document.querySelectorAll('[data-testid="betting-panel"] button')].map((b) => `${b.textContent?.trim()}:${b.disabled}`).join('|')}`,
            );
          if (kind === 'showdown' && (faces !== 5 || !h.result || !h.showdown?.reveals.length))
            throw new Error('Missing showdown faces/result');
          if (kind === 'multirun' && (faces !== 15 || runs !== 3 || !h.result))
            throw new Error('Missing three dealt runs');
          if (expectHero && kind !== 'idle' && heroCards !== 2)
            throw new Error('Missing hero pair');
          return {
            faces,
            heroCards,
            runs,
            actions,
            fontsReady: document.fonts.status === 'loaded',
            storeUrl,
          };
        },
        { kind: sc.kind, mySeat: sc.mySeat, expectHero: EXPECT_HERO },
      );
      const data = await page.evaluate(() => {
        const R = (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        const inter = (a, b) => {
          const x = Math.max(a.x, b.x);
          const y = Math.max(a.y, b.y);
          const x2 = Math.min(a.x + a.w, b.x + b.w);
          const y2 = Math.min(a.y + a.h, b.y + b.h);
          return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
        };
        const area = (r) => r.w * r.h;
        const unionInter = (target, occluders) => {
          // approximate union coverage by tiling into 4px cells (exact enough)
          const S = 4;
          let covered = 0;
          const cols = occluders.map((o) => inter(target, o)).filter(Boolean);
          if (cols.length === 0) return 0;
          const x0 = Math.max(target.x, Math.min(...cols.map((c) => c.x)));
          const x1 = Math.min(target.x + target.w, Math.max(...cols.map((c) => c.x + c.w)));
          const y0 = Math.max(target.y, Math.min(...cols.map((c) => c.y)));
          const y1 = Math.min(target.y + target.h, Math.max(...cols.map((c) => c.y + c.h)));
          for (let x = x0; x < x1; x += S)
            for (let y = y0; y < y1; y += S)
              if (cols.some((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h))
                covered += S * S;
          return Math.min(covered, area(target));
        };

        const pods = [...document.querySelectorAll('.table-pod-card')].map((el) => ({
          el,
          root: el.closest('div.absolute.z-20') ?? el,
          r: R(el),
        }));
        const podSubtreeRects = () => pods.flatMap((p) => [p.r, R(p.root)]);

        // ── pod text lines: everything readable inside a pod + its pills row
        const textSel =
          '.table-pname, .table-pstack, .table-paction, .table-pstrength, .table-pstate, .table-pill, .table-pod-pills > *';
        const texts = [];
        for (const p of pods) {
          const own = p.root;
          for (const el of own.querySelectorAll(textSel)) {
            if (el.matches('.table-pill') && el.closest('.table-pod-pills') === null) continue;
            const r = R(el);
            if (r.w < 2 || r.h < 2) continue;
            texts.push({ el, r, own, cls: el.className.split(' ')[0] });
          }
        }
        // occluders = foreign visual elements: any other pod's card subtree,
        // the center column's opaque kids, felt bet piles, controls, overlays
        const foreignOf = (own) => {
          const list = [];
          const tag = (el, kind) => ({
            r: R(el),
            src: kind || (el.className?.toString?.().split(' ')[0] ?? el.tagName),
          });
          for (const p of pods)
            if (p.root !== own)
              list.push(
                tag(p.el, 'pod'),
                ...[...p.el.querySelectorAll('.table-pod-holo')].map((e) => tag(e, 'pod-holo')),
              );
          for (const p of pods)
            if (p.root !== own) {
              const pills = p.root.querySelector('.table-pod-pills');
              if (pills) list.push(tag(pills, 'pills'));
            }
          const col = document.querySelector('.table-center-col');
          if (col)
            for (const el of col.querySelectorAll(
              '.table-pot-pill, .table-prompt, [role="img"], .table-slot, .table-ribbon, .table-outcome, .table-squid-summary, .table-invite, .table-notinhand',
            ))
              list.push(
                tag(el, 'center:' + (el.getAttribute('aria-label') ?? el.className.split(' ')[0])),
              );
          // felt bet piles + D disc + amount pill (anywhere on the canvas)
          for (const sel of ['.table-bet-amt', '.table-disc-d'])
            for (const el of document.querySelectorAll(sel))
              list.push(tag(el, 'bet:' + el.className.split(' ')[0]));
          for (const el of document.querySelectorAll(
            '.table-cluster, .table-lasthand, .table-dock-chip, .fixed, .absolute.z-30',
          ))
            if (!el.closest('.table-pod-card'))
              list.push(tag(el, 'ctl:' + el.className.split(' ')[0]));
          return list.filter((o) => o.r.w > 1 && o.r.h > 1);
        };
        let textNum = 0;
        let textDen = 0;
        const worstTexts = [];
        for (const t of texts) {
          const a = area(t.r);
          if (a === 0) continue;
          const cov = unionInter(
            t.r,
            foreignOf(t.own).map((o) => o.r),
          );
          textNum += ((a - cov) / a) * a;
          textDen += a;
          if (cov / a > 0.15) {
            const by = foreignOf(t.own)
              .filter((o) => inter(t.r, o.r))
              .map((o) => o.src);
            worstTexts.push({
              cls: t.cls,
              cov: +(cov / a).toFixed(2),
              r: t.r,
              by: [...new Set(by)].slice(0, 4),
            });
          }
        }

        // ── board coverage: center-column community cards + slots
        const col = document.querySelector('.table-center-col');
        let boardNum = 0;
        let boardDen = 0;
        // Only dealt board faces count. Empty slots are useful for layout
        // inspection, but must never make an un-dealt fixture look healthy.
        const boardEls = col
          ? [
              ...col.querySelectorAll(
                '[data-card-size="board"], [data-card-size="sm"], [data-card-size="xs"]',
              ),
            ]
          : [];
        const boardOcc = [
          ...[...document.querySelectorAll('.table-hero-cards')].map(R),
          ...podSubtreeRects(),
          ...[
            ...document.querySelectorAll(
              '.table-bet-amt, .table-disc-d, .table-cluster, .table-lasthand',
            ),
          ].map(R),
        ].filter((r) => r.w > 1 && r.h > 1);
        const worstBoard = [];
        for (const el of boardEls) {
          const r = R(el);
          const a = area(r);
          if (a === 0) continue;
          const cov = unionInter(r, boardOcc);
          boardNum += a - cov;
          boardDen += a;
          if (cov / a > 0.1)
            worstBoard.push({
              label: el.getAttribute('aria-label') ?? el.className.split(' ')[0],
              cov: +(cov / a).toFixed(2),
              r,
            });
        }

        // ── pod vs pod pairwise intersection (card boxes + pills)
        let podPair = 0;
        const boxes = pods.map((p) => ({
          own: p.root,
          rects: [
            p.r,
            ...(p.root.querySelector('.table-pod-pills')
              ? [R(p.root.querySelector('.table-pod-pills'))]
              : []),
          ],
        }));
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) {
            for (const a of boxes[i].rects)
              for (const b of boxes[j].rects) {
                const x = inter(a, b);
                if (x) podPair += area(x);
              }
          }

        // ── corner controls vs seats and each other
        const cluster = document.querySelector('.table-cluster');
        const dockWrap = [...document.querySelectorAll('div')].find(
          (d) =>
            d.className.includes('pointer-events-none') &&
            d.querySelector(':scope > .table-dock-chip, :scope > div .table-dock-chip') &&
            d.className.includes('bottom-'),
        );
        const dockRects = [...document.querySelectorAll('.table-dock-chip')]
          .map(R)
          .concat(
            [...document.querySelectorAll('button[title]')]
              .filter((b) => b.closest('.pointer-events-none'))
              .map(R),
          );
        const clusterR = cluster ? R(cluster) : null;
        const podBoxes = podSubtreeRects().filter((r, i) => i % 2 === 0);
        let clusterVsPods = 0;
        const clusterCovered = [];
        if (clusterR)
          pods.forEach((p, i) => {
            const x = inter(clusterR, p.r);
            if (x) {
              clusterVsPods += area(x);
              clusterCovered.push(i);
            }
          });
        let dockVsCluster = 0;
        if (clusterR)
          for (const d of dockRects) {
            const x = inter(clusterR, d);
            if (x) dockVsCluster += area(x);
          }

        // ── canvas scale k + effective text px
        const canvasEl =
          document.querySelector('.table-canvas--narrow, .table-canvas--dense') ??
          [...document.querySelectorAll('div')].find(
            (d) =>
              /^\d+(\.\d+)?px$/.test(d.style.width) &&
              /scale\(/.test(d.style.transform || '') &&
              parseFloat(d.style.width) >= 500,
          );
        let k = null;
        if (canvasEl) {
          const m = /scale\(([\d.]+)\)/.exec(canvasEl.style.transform || '');
          if (m) k = +m[1];
        }
        const nameEl = document.querySelector('.table-pname');
        const effNamePx =
          nameEl && k ? +(parseFloat(getComputedStyle(nameEl).fontSize) * k).toFixed(1) : null;
        const sectionEl = cluster?.closest('section') ?? null;
        const clipR = sectionEl
          ? R(sectionEl)
          : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
        let clusterVisible = null;
        if (clusterR) {
          const v = inter(clusterR, clipR);
          clusterVisible = +(v ? area(v) / area(clusterR) : 0).toFixed(4);
        }
        const sliderEl = document.querySelector('.table-cluster--phone .table-slider');
        const sliderH = sliderEl ? +sliderEl.getBoundingClientRect().height.toFixed(1) : null;
        const dockChipEls = [...document.querySelectorAll('.table-dock--phone .table-dock-chip')];
        const dockMinH = dockChipEls.length
          ? +Math.min(...dockChipEls.map((e) => e.getBoundingClientRect().height)).toFixed(1)
          : null;

        const hero = document.querySelector('[data-testid="hero-hole-cards"]');
        // Hero hole cards live outside the center column. Only community-board
        // faces are part of this check; generic card-size selectors also catch
        // center-column run/placeholder art and made clean HEAD report a false
        // hero overlap.
        const slots = [...(col?.querySelectorAll('[data-card-size="board"][role="img"]') ?? [])].map(R);
        const heroRect = hero ? R(hero) : null;
        const boardBottom = slots.length ? Math.max(...slots.map((r) => r.y + r.h)) : null;
        // This is an intersection area, not a linear distance: units are px².
        const heroBoardOverlapPx2 = heroRect
          ? slots.reduce((sum, r) => sum + (inter(r, heroRect) ? area(inter(r, heroRect)) : 0), 0)
          : 0;
        return {
          heroTop: heroRect?.y ?? null,
          boardBottom,
          heroBoardGap: heroRect && boardBottom !== null ? heroRect.y - boardBottom : null,
          heroBoardOverlapPx2,
          pods: pods.length,
          k,
          canvasW: canvasEl ? parseFloat(canvasEl.style.width) : null,
          canvasH: canvasEl ? parseFloat(canvasEl.style.height) : null,
          textCov: textDen ? +(textNum / textDen).toFixed(4) : null,
          boardCov: boardDen ? +(boardNum / boardDen).toFixed(4) : null,
          boardCardCount: boardEls.length,
          boardEls: boardEls.length,
          podPairPx: Math.round(podPair),
          clusterVsPodsPx: Math.round(clusterVsPods),
          clusterCoveredPods: clusterCovered,
          dockVsClusterPx: Math.round(dockVsCluster),
          effNamePx,
          sliderH,
          dockMinH,
          clusterVisible,
          worstTexts: worstTexts.slice(0, 8),
          worstBoard: worstBoard.slice(0, 6),
          clusterRect: clusterR,
          dockRects: dockRects.slice(0, 10),
        };
      });

      results.push({ scenario: sc.name, vp: `${vp.width}x${vp.height}`, scene, ...data });
      console.log(
        `${sc.name} @${vp.width}x${vp.height}: pods=${data.pods} k=${data.k} canvas=${data.canvasW}x${data.canvasH} textCov=${data.textCov} boardCov=${data.boardCov} podPair=${data.podPairPx}px² clusterCovers=${data.clusterVsPodsPx}px² docks=${data.dockVsClusterPx}px²`,
      );
      await page.screenshot({ path: `${out}/probe-${sc.name}-${vp.width}x${vp.height}.png` });
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  `${out}/overlap.json`,
  JSON.stringify(
    {
      meta: { gitHash, probeHash, locale: LOCALE, generatedAt: new Date().toISOString() },
      results,
    },
    null,
    1,
  ),
);
console.log(`meta: git=${gitHash ?? 'n/a'} probe=${probeHash} locale=${LOCALE}`);
if (errors.length) {
  console.error(`PAGE ERRORS:\n${errors.join('\n')}`);
  process.exit(1);
}

if (ASSERT) {
  // Gate viewports: 390 (primary portrait) + 667 (short landscape). 320 and
  // 568 are degraded targets whose residuals are reported in the JSON only.
  const ASSERTED_VPS = ['390x844', '667x375'];
  const failures = [];
  for (const r of results) {
    if (r.heroBoardOverlapPx2 > 0)
      failures.push(`${r.scenario}@${r.vp} heroBoardOverlap=${r.heroBoardOverlapPx2}px²`);
    // Desktop hard gate, viewport-independent of ASSERTED_VPS: the desktop
    // geometry must have zero pairwise pod overlap.
    if ((r.vp === '1440x900' || r.vp === '1280x720') && r.podPairPx > 0)
      failures.push(`${r.scenario}@${r.vp} podPair=${r.podPairPx}`);
    if (!ASSERTED_VPS.includes(r.vp)) continue;
    // a null metric means the DOM it reads is missing - treat as fail, not skip.
    if (r.textCov === null || r.textCov < 0.85)
      failures.push(`${r.scenario}@${r.vp} textCov=${r.textCov}`);
    if (r.boardCardCount > 0 && (r.boardCov === null || r.boardCov < 0.9))
      failures.push(`${r.scenario}@${r.vp} boardCov=${r.boardCov}`);
    if (r.dockVsClusterPx > 0)
      failures.push(`${r.scenario}@${r.vp} dockVsCluster=${r.dockVsClusterPx}`);
    if (r.sliderH !== null && r.sliderH < 44)
      failures.push(`${r.scenario}@${r.vp} sliderH=${r.sliderH}`);
    if (r.dockMinH !== null && r.dockMinH < 44)
      failures.push(`${r.scenario}@${r.vp} dockMinH=${r.dockMinH}`);
    // the panel scrollport must sit fully inside the section clip, else its top
    // controls start off-screen and no scroll can bring them back.
    if (r.clusterVisible !== null && r.vp === '390x844' && r.clusterVisible < 0.99)
      failures.push(`${r.scenario}@${r.vp} clusterVisible=${r.clusterVisible}`);
    // clusterCoveredPods is retained as an explicit diagnostic. Live betting
    // controls are allowed to extend over the short landscape stage; this is
    // reported, but the hard gate is the fully visible cluster plus podPair.
  }
  if (failures.length) {
    console.error(`ASSERT FAIL (${failures.length}):\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('assertions: PASS');
}
console.log('no page errors');
