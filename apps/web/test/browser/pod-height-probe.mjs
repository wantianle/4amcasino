/** gg-polish #3 pod-height probe — measures what table-overlap.mjs does NOT:
 *  the ACTUAL plaque size of the portrait seat unit against the geometry
 *  budget (geometry.ts podWorstPx=150 design px), plus colScale and the real
 *  board-card size, in both CSS px and design px. Companion to (not a
 *  modification of) table-overlap.mjs; the fixture injection mirrors that
 *  harness verbatim so the scenes are identical.
 *
 *  Env: same knobs as table-overlap.mjs —
 *    PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE, UAT_OUTPUT (default /tmp/4am-pod-probe),
 *    VIEWS (default desktop), VIEWPORTS (WxH,WxH override), BASE_URL, LOCALE,
 *    NINE_ONLY=1 keeps the three 9-seat scenarios (default here anyway).
 *
 *  Reports per scenario x viewport:
 *    plaqueMaxDesignPx / plaqueMaxCssPx  — tallest .table-pod-card (worst seat)
 *    plaqueWidthDesignPx
 *    budgetPx (150) + margin = budget - max
 *    colScale — the center column's own clamp scale
 *    boardFaceDesignPx — community card face h/w in design px
 *    heroTopVsBudget — hero pair top edge vs the budget bottom line (center
 *      column's max extent); negative = the plaque/hero stack overran it
 *    pods — worst three pods (seat, design-px h)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://localhost:5173';
const out = process.env.UAT_OUTPUT || '/tmp/4am-pod-probe';
await mkdir(out, { recursive: true });
const sharedPath =
  process.env.SHARED_PATH ||
  fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url));

const MY_USER = 2;
const LOCALE = process.env.LOCALE || 'zh-CN';
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
      actionTimeoutMs: 30000,
      actionSecs: null,
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
      publicKey: '',
      privateStats: false,
      pendingBuy: i === (mySeat + 1) % count ? 2000 : 0,
    })),
    handActive: true,
  };
}

const SCENARIOS = [
  { name: '9p-myturn', count: 9, mySeat: 4, kind: 'myturn' },
  { name: '9p-showdown', count: 9, mySeat: 4, kind: 'showdown' },
  { name: '9p-multirun3', count: 9, mySeat: 4, kind: 'multirun' },
];

const DESKTOP_VIEWS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
];
const VIEW_MODE = process.env.VIEWS || 'desktop';
const VIEWPORTS = process.env.VIEWPORTS
  ? process.env.VIEWPORTS.split(',').map((value) => {
      const [width, height] = value.split('x').map(Number);
      return { width, height };
    })
  : VIEW_MODE === 'phone'
    ? [{ width: 390, height: 844 }]
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
          if (kind === 'myturn') {
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
          return false;
        },
        { kind: sc.kind, mySeat: sc.mySeat },
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
        await page.waitForFunction(
          async ({ mySeat }) => {
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
          },
          { mySeat: sc.mySeat },
        );
      } else {
        await page.waitForTimeout(400);
      }

      /* ── the probe: plaque sizes, colScale, board faces, clearances ──── */
      const data = await page.evaluate(() => {
        const R = (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
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
        const col = document.querySelector('.table-center-col');
        let colScale = 1;
        if (col) {
          const m = /scale\(([\d.]+)\)/.exec(col.style.transform || '');
          if (m) colScale = +m[1];
        }
        const canvasRect0 = canvasEl ? R(canvasEl) : null;
        const podEls = [...document.querySelectorAll('.table-pod-card')];
        const pods = podEls.map((el) => {
          const r = R(el);
          const seat = el.closest('[data-testid]')?.dataset.testid?.replace('seat-pod-', '') ?? '?';
          return {
            seat,
            cssH: +r.h.toFixed(1),
            cssW: +r.w.toFixed(1),
            designH: k ? +(r.h / k).toFixed(1) : null,
            designW: k ? +(r.w / k).toFixed(1) : null,
            topCss: r.y,
            bottomCss: r.y + r.h,
            // canvas-relative design rect for pair diagnosis
            dRect: canvasRect0
              ? {
                  x: +((r.x - canvasRect0.x) / (k ?? 1)).toFixed(1),
                  y: +((r.y - canvasRect0.y) / (k ?? 1)).toFixed(1),
                  w: +(r.w / (k ?? 1)).toFixed(1),
                  h: +(r.h / (k ?? 1)).toFixed(1),
                }
              : null,
            acting: el.className.includes('--acting'),
          };
        });
        const faces = [...document.querySelectorAll('.table-center-col [data-card-size][role="img"]')];
        const faceRects = faces.map(R);
        const heroEl = document.querySelector('[data-testid="hero-hole-cards"]');
        const hero = heroEl ? R(heroEl) : null;
        // geometry model: budget bottom line in DESIGN px on the 1180x660
        // canvas; convert to CSS via k and the canvas rect.
        const canvasRect = canvasEl ? R(canvasEl) : null;
        const budgetLineCss =
          canvasRect && k ? canvasRect.y + ((660 * 0.9 - 12 - 150 - 38) / 660) * canvasRect.h : null;
        const boardBottomCss = faceRects.length
          ? Math.max(...faceRects.map((r) => r.y + r.h))
          : null;
        const podByHeight = [...pods].sort((a, b) => b.cssH - a.cssH);
        // podPair diagnosis (mirrors the harness's card+pill rect math):
        // report the worst intersecting PAIR so a failure names its seats.
        const inter = (a, b) => {
          const x = Math.max(a.x, b.x);
          const y = Math.max(a.y, b.y);
          const x2 = Math.min(a.x + a.w, b.x + b.w);
          const y2 = Math.min(a.y + a.h, b.y + b.h);
          return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
        };
        const boxes = podEls.map((el) => {
          const r = R(el);
          const pills = el.parentElement?.querySelector('.table-pod-pills');
          return {
            seat:
              el.closest('[data-testid]')?.dataset.testid?.replace('seat-pod-', '') ?? '?',
            rects: [
              { ...r, kind: 'card' },
              ...(pills ? [{ ...R(pills), kind: 'pills' }] : []),
            ],
          };
        });
        const pairs = [];
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++)
            for (const a of boxes[i].rects)
              for (const b of boxes[j].rects) {
                const x = inter(a, b);
                if (x)
                  pairs.push({
                    pair: `${boxes[i].seat}↔${boxes[j].seat}`,
                    kinds: `${a.kind}↔${b.kind}`,
                    designPx2: +((x.w * x.h) / ((k ?? 1) ** 2)).toFixed(0),
                    designW: +(x.w / (k ?? 1)).toFixed(1),
                    designH: +(x.h / (k ?? 1)).toFixed(1),
                    aDesign: {
                      y: +(a.y / (k ?? 1)).toFixed(1),
                      h: +(a.h / (k ?? 1)).toFixed(1),
                      x: +(a.x / (k ?? 1)).toFixed(1),
                      w: +(a.w / (k ?? 1)).toFixed(1),
                    },
                    bDesign: {
                      y: +(b.y / (k ?? 1)).toFixed(1),
                      h: +(b.h / (k ?? 1)).toFixed(1),
                      x: +(b.x / (k ?? 1)).toFixed(1),
                      w: +(b.w / (k ?? 1)).toFixed(1),
                    },
                  });
              }
        pairs.sort((a, b) => b.designPx2 - a.designPx2);
        const podPairDesignSum = pairs.reduce((s, p) => s + p.designPx2, 0);
        const underEls = [...document.querySelectorAll('.table-pod-strength')];
        const pillEls = [...document.querySelectorAll('.table-pod-pills')];
        // which FOREIGN rect covers each pills row (textCov diagnosis):
        // showdown holo fans ride plaque top edges and can reach a
        // neighbour's strength/pills row below its own plaque.
        const holoEls = [...document.querySelectorAll('.table-pod-holo')];
        const holoInfos = holoEls.map((el) => ({
          seat:
            el.closest('[data-testid]')?.dataset.testid?.replace('seat-pod-', '') ?? '?',
          kind: el.className.split(/\s+/).find((c) => c.startsWith('table-pod-holo--')) ?? 'fan',
          r: R(el),
        }));
        const pillOcclusion = [];
        for (const pills of pillEls) {
          const pr = R(pills);
          if (pr.w < 2 || pr.h < 2) continue;
          const owner = pills.closest('[data-testid]')?.dataset.testid ?? '?';
          for (const h of holoInfos) {
            if (h.seat === owner) continue;
            const x = inter(pr, h.r);
            if (x && x.w * x.h > 20)
              pillOcclusion.push({
                row: owner.replace('seat-pod-', ''),
                bySeat: h.seat,
                kind: h.kind,
                designPx2: Math.round((x.w * x.h) / ((k ?? 1) ** 2)),
                covPct: +((100 * (x.w * x.h)) / (pr.w * pr.h)).toFixed(0),
                rowRect: {
                  x: +((pr.x - (canvasRect?.x ?? 0)) / (k ?? 1)).toFixed(1),
                  y: +((pr.y - (canvasRect?.y ?? 0)) / (k ?? 1)).toFixed(1),
                  w: +(pr.w / (k ?? 1)).toFixed(1),
                  h: +(pr.h / (k ?? 1)).toFixed(1),
                },
                byRect: {
                  x: +((h.r.x - (canvasRect?.x ?? 0)) / (k ?? 1)).toFixed(1),
                  y: +((h.r.y - (canvasRect?.y ?? 0)) / (k ?? 1)).toFixed(1),
                  w: +(h.r.w / (k ?? 1)).toFixed(1),
                  h: +(h.r.h / (k ?? 1)).toFixed(1),
                },
              });
          }
        }
        return {
          k: k !== null ? +k.toFixed(4) : null,
          colScale: +colScale.toFixed(4),
          canvasCss: canvasRect ? { w: +canvasRect.w.toFixed(1), h: +canvasRect.h.toFixed(1) } : null,
          pods: pods.length,
          plaqueMaxDesignPx: podByHeight[0]?.designH ?? null,
          plaqueMaxCssPx: podByHeight[0]?.cssH ?? null,
          plaqueMaxSeat: podByHeight[0]?.seat ?? null,
          plaqueMaxActing: podByHeight[0]?.acting ?? null,
          plaqueWidthDesignPx: podByHeight[0]?.designW ?? null,
          worstThree: podByHeight.slice(0, 3).map((p) => ({
            seat: p.seat,
            designH: p.designH,
            cssH: p.cssH,
            acting: p.acting,
          })),
          boardFaceDesignH:
            k && colScale && faceRects.length
              ? +(Math.max(...faceRects.map((r) => r.h)) / (k * colScale)).toFixed(1)
              : null,
          boardFaceDesignW:
            k && colScale && faceRects.length
              ? +(Math.max(...faceRects.map((r) => r.w)) / (k * colScale)).toFixed(1)
              : null,
          faces: faces.length,
          boardBottomToPlaqueTopPx:
            boardBottomCss !== null && pods.length
              ? +((Math.min(...pods.map((p) => p.topCss)) - boardBottomCss) / (k ?? 1)).toFixed(1)
              : null,
          heroTopVsBoardBottomPx:
            hero && boardBottomCss !== null ? +((hero.y - boardBottomCss) / (k ?? 1)).toFixed(1) : null,
          heroTopVsBudgetPx:
            hero && budgetLineCss !== null ? +((budgetLineCss - hero.y) / (k ?? 1)).toFixed(1) : null,
          strengthCount: underEls.length,
          strengthDesignH: underEls.length
            ? +(Math.max(...underEls.map((e) => R(e).h)) / (k ?? 1)).toFixed(1)
            : null,
          pillCount: pillEls.length,
          pillVisibleDesignH: pillEls
            .map((e) => R(e))
            .filter((r) => r.h > 0)
            .map((r) => +(r.h / (k ?? 1)).toFixed(1)),
          podPairDesignSum,
          worstPairs: pairs.slice(0, 5),
          pillOcclusion,
          seatRects: pods.map((p) => ({ seat: p.seat, d: p.dRect })),
          holoRects: holoInfos.map((h) => ({
            seat: h.seat,
            kind: h.kind.replace('table-pod-holo--', ''),
            x: +((h.r.x - (canvasRect0?.x ?? 0)) / (k ?? 1)).toFixed(1),
            y: +((h.r.y - (canvasRect0?.y ?? 0)) / (k ?? 1)).toFixed(1),
            w: +(h.r.w / (k ?? 1)).toFixed(1),
            h: +(h.r.h / (k ?? 1)).toFixed(1),
          })),
        };
      });

      results.push({ scenario: sc.name, kind: sc.kind, vp: `${vp.width}x${vp.height}`, ...data });
      console.log(
        `${sc.name} @${vp.width}x${vp.height}: k=${data.k} colScale=${data.colScale} ` +
          `plaqueMax=${data.plaqueMaxDesignPx}designpx/${data.plaqueMaxCssPx}csspx (seat ${data.plaqueMaxSeat}${data.plaqueMaxActing ? ' acting' : ''}) ` +
          `budget150 margin=${data.plaqueMaxDesignPx !== null ? (150 - data.plaqueMaxDesignPx).toFixed(1) : '?'} ` +
          `boardFace=${data.boardFaceDesignH}x${data.boardFaceDesignW} faces=${data.faces} ` +
          `heroTop-boardBottom=${data.heroTopVsBoardBottomPx} heroTop-budgetLine=${data.heroTopVsBudgetPx} ` +
          `boardBottom-plaqueTop=${data.boardBottomToPlaqueTopPx} strength=${data.strengthCount}@${data.strengthDesignH}px ` +
          `podPairDesign=${data.podPairDesignSum} worst=${data.worstPairs.map((p) => `${p.pair}(${p.kinds},${p.designPx2})`).join(' ')} `,
      );
    }
  }
} finally {
  await browser.close();
}

await writeFile(`${out}/pod-height.json`, JSON.stringify({ results, errors }, null, 2));
if (errors.length) {
  console.error('page errors:', errors);
  process.exitCode = 1;
}
