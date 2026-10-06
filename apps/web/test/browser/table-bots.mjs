/** Table-bots UI evidence + flow tests: the host's 「机器人」 entry, the
 *  BotsDialog create flow, and the bot seat pods on the felt.
 *
 * Same driving style as table-baseline.mjs (Vite dev server + synthetic room
 * over a mocked websocket), but the REST layer is STATEFUL and the mock also
 * pushes updated `room_state` frames after create/start - exactly what the
 * real server's banker-credit + runner-connect do to room_players. So the
 * 「已入座」 shot shows the bot THIS run created, not a pre-seeded one.
 *
 * Two scenarios:
 *   approved - host is the banker: create(buy-in auto-approved) -> the dialog
 *     auto-starts, the new pod appears with its badge, success flash shown.
 *   pending  - buy-in waits: create returns buyRequest 'pending' and the bot
 *     parks at waiting_buy_approval. The dialog must NOT POST start (asserted
 *     against the recorded request log), shows the waiting prose, and only
 *     after the mocked banker approves (GET flips the bot to ready) does a
 *     Start button appear - clicking it must POST start (asserted).
 *
 *   PLAYWRIGHT_MODULE   path to a Playwright install (default 'playwright-core')
 *   BROWSER_EXECUTABLE  Chrome binary (default /usr/bin/google-chrome)
 *   UAT_OUTPUT          output directory (default /tmp/4am-table-bots)
 *   VIEWS               desktop | phone | both (as in the baseline; the
 *                       pending-approval flow is desktop-only - it asserts
 *                       wiring, not layout)
 *
 * Copy-coupling note: the click targets resolve through the zh-CN dictionary
 * (the product default locale): the entry chip's title is t('Bot opponents')
 * = 「机器人对手」, the dialog's aria-label the same. If those strings change,
 * update the selectors below.
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://localhost:5173';
const out = process.env.UAT_OUTPUT || '/tmp/4am-table-bots';
await mkdir(out, { recursive: true });

const MY_USER = 2;
const BOT_A = {
  id: 'boteventeen',
  userId: 2100,
  username: 'bot_eventeen',
  displayName: 'River Bot',
  seat: 3,
  configuredSeat: 3,
  status: 'running',
  policyKind: 'scripted',
  difficulty: 'low',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  stoppedAt: null,
  stopRequestedAt: null,
  identityRecoverable: true,
};
const BOT_B = {
  id: 'botnineteen',
  userId: 2101,
  username: 'bot_nineteen',
  displayName: 'Nit Bot',
  seat: 4,
  configuredSeat: 4,
  status: 'waiting_buy_approval',
  policyKind: 'scripted',
  difficulty: 'medium',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  stoppedAt: null,
  stopRequestedAt: null,
  identityRecoverable: true,
};

function human(seat, userId, name, stack) {
  return {
    seat,
    userId,
    username: name.toLowerCase(),
    displayName: name,
    stack,
    connected: true,
    sittingOut: false,
    totalBought: 2000,
    hasAvatar: false,
    avatarVersion: 0,
    publicKey: '',
    privateStats: false,
    pendingBuy: 0,
  };
}

/** The room the mocked server holds; create/start mutate it and re-broadcast,
 *  mirroring how the real routes insert the room_players row and how the
 *  runner's connect flips `connected`. */
function makeRoom() {
  return {
    t: 'room_state',
    room: {
      id: 'baseline',
      name: 'Bots Evidence',
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
    players: [
      human(0, MY_USER, 'Alex', 2000),
      human(1, 101, 'Meera', 1863),
      human(2, 102, 'Zoya', 1726),
      // the two pre-seeded bots: rows the real create route would have written
      human(3, BOT_A.userId, BOT_A.displayName, 2000),
      {
        ...human(4, BOT_B.userId, BOT_B.displayName, 0),
        connected: false,
        totalBought: 0,
        pendingBuy: 2000,
      },
    ],
    handActive: false,
  };
}

const DESKTOP_VIEWS = [{ width: 1440, height: 900 }];
const PHONE_VIEWS = [{ width: 390, height: 844 }];
const VIEW_MODE = process.env.VIEWS || 'desktop';
const VIEWPORTS =
  VIEW_MODE === 'phone'
    ? PHONE_VIEWS
    : VIEW_MODE === 'both'
      ? [...DESKTOP_VIEWS, ...PHONE_VIEWS]
      : DESKTOP_VIEWS;

const SCENARIOS = [
  { mode: 'approved', views: VIEWPORTS },
  // the pending-buy branch asserts wiring, not layout - desktop only
  { mode: 'pending', views: [{ width: 1440, height: 900 }] },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});

const errors = [];
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
};

try {
  for (const sc of SCENARIOS) {
    for (const vp of sc.views) {
      // stateful store per context: create / start mutate what GET returns
      const bots = [{ ...BOT_A }, { ...BOT_B }];
      const room = makeRoom();
      const requests = [];
      const createBodies = [];
      const sockets = new Set();
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
                auth: { token: 'bots-fixture', userId: uid, username: 'alex', identity: null },
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
      page.on('pageerror', (e) => errors.push(`${sc.mode}@${vp.width}x${vp.height}: ${e.message}`));

      // broadcast the CURRENT room to the client, like the server does after
      // any membership/stack change
      const pushRoom = () => {
        const frame = JSON.stringify(room);
        for (const ws of sockets) {
          try {
            ws.send(frame);
          } catch {
            /* a closed socket just means the page navigated away */
          }
        }
      };
      const setPlayer = (userId, patch) => {
        const p = room.players.find((x) => x.userId === userId);
        if (p) Object.assign(p, patch);
        pushRoom();
      };

      await page.route('**/api/**', (route) => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        const path = url.pathname;
        requests.push(`${method} ${path}`);
        const json = (body, status = 200) =>
          route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

        if (path === '/api/rooms/baseline/bots') {
          if (method === 'GET') return json({ bots });
          if (method === 'POST') {
            const req = JSON.parse(route.request().postData() ?? '{}');
            createBodies.push(req);
            const seat = req.seat ?? 6;
            const buyIn = Number(req.initialBuyIn ?? 0);
            // host is the room's banker in the approved mode; in pending mode
            // the buy waits, so the bot parks at waiting_buy_approval
            const approved = sc.mode === 'approved';
            const bot = {
              id: 'botnew',
              userId: 2102,
              username: 'bot_new',
              displayName: req.name ?? 'bot_new',
              seat,
              configuredSeat: seat,
              status: approved ? 'ready' : 'waiting_buy_approval',
              policyKind: req.policyKind ?? 'scripted',
              difficulty: req.difficulty ?? 'medium',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              stoppedAt: null,
              stopRequestedAt: null,
              identityRecoverable: true,
            };
            bots.push(bot);
            // the real create route inserts the room_players row (stack 0)
            // immediately, whatever the buy's fate
            room.players = [
              ...room.players,
              {
                seat,
                userId: bot.userId,
                username: bot.username,
                displayName: bot.displayName,
                stack: 0,
                connected: false,
                sittingOut: false,
                totalBought: 0,
                hasAvatar: false,
                avatarVersion: 0,
                publicKey: '',
                privateStats: false,
                pendingBuy: approved ? 0 : buyIn,
              },
            ];
            if (approved) {
              // banker auto-approval credits the buy-in on the spot
              setPlayer(bot.userId, { stack: buyIn, totalBought: buyIn });
            } else {
              pushRoom();
            }
            return json(
              { bot, buyRequest: { id: 91, status: approved ? 'approved' : 'pending' } },
              201,
            );
          }
        }
        const lifecycle = path.match(
          /^\/api\/rooms\/baseline\/bots\/([a-z0-9]+)(\/(start|stop|buy))?$/,
        );
        if (lifecycle && method === 'POST') {
          const bot = bots.find((b) => b.id === lifecycle[1]);
          if (bot) {
            if (lifecycle[3] === 'start') {
              bot.status = 'running';
              bot.updatedAt = Date.now();
              // the supervisor's runner connects: the seat lights up
              setPlayer(bot.userId, { connected: true });
            }
            if (lifecycle[3] === 'stop') {
              bot.status = 'stopping';
              bot.updatedAt = Date.now();
            }
            if (lifecycle[3] === 'buy') {
              const body = JSON.parse(route.request().postData() ?? '{}');
              const approved = sc.mode === 'approved';
              if (approved) {
                const p = room.players.find((x) => x.userId === bot.userId);
                setPlayer(bot.userId, {
                  stack: (p?.stack ?? 0) + Number(body.amount ?? 0),
                  totalBought: (p?.totalBought ?? 0) + Number(body.amount ?? 0),
                  pendingBuy: 0,
                });
              }
              return json({ buyRequest: { id: 92, status: approved ? 'approved' : 'pending' } });
            }
          }
          return json({ bot: bot ?? null, runner: 'supervisor' });
        }
        if (lifecycle && method === 'DELETE') {
          const idx = bots.findIndex((b) => b.id === lifecycle[1]);
          const found = idx >= 0 ? bots[idx] : undefined;
          const bot = found ? { ...found, status: 'stopping' } : null;
          if (idx >= 0) bots.splice(idx, 1);
          if (bot) setPlayer(bot.userId, { connected: false });
          return json({ bot, runner: 'supervisor' });
        }
        // one generic body answers every other API the page pokes (profile,
        // leaderboard, room settings…) - same trick as table-baseline.mjs
        return json({
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
          bots: [],
          isPlatform: false,
          cardBack: 'crimson',
          fourColor: true,
        });
      });
      await page.routeWebSocket('**/*', (ws) => {
        sockets.add(ws);
        ws.onMessage((data) => {
          const msg = JSON.parse(String(data));
          if (msg.t === 'join_room') ws.send(JSON.stringify(room));
        });
      });

      const tag = vp.width >= 1000 ? 'desktop' : 'phone';
      await page.goto(`${base}/room/${room.room.id}`);
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Poker board"], .table-app-bg') !== null,
      );
      await page.evaluate(async () => {
        const { useStore } = await import('/src/shared/store.ts');
        const { deriveIdentity } = await import('/src/shared/crypto.ts');
        const s = useStore.getState();
        useStore.setState({
          auth: { ...s.auth, identity: deriveIdentity('alex', 'bots') },
          wsConnected: true,
        });
      });
      await page.waitForTimeout(600);

      // ── entry: top-bar chip on desktop, the ⋮ menu on phones ──────────────
      const openDialog = async () => {
        if (tag === 'phone') {
          await page.getByRole('button', { name: '更多牌桌控制' }).click();
          await page.getByRole('menuitem', { name: /机器人对手/ }).click();
        } else {
          await page.locator('button[title="机器人对手"]').click();
        }
        const dialog = page.getByRole('dialog', { name: '机器人对手' });
        await dialog.getByRole('heading', { name: '机器人对手' }).waitFor();
        return dialog;
      };
      if (tag === 'phone' && sc.mode === 'approved') {
        await page.getByRole('button', { name: '更多牌桌控制' }).click();
        await page.getByRole('menuitem', { name: /机器人对手/ }).waitFor();
        await page.screenshot({ path: `${out}/01-entry-${tag}-${vp.width}x${vp.height}.png` });
        await page.keyboard.press('Escape');
      } else if (tag === 'desktop' && sc.mode === 'approved') {
        await page.locator('button[title="机器人对手"]').waitFor();
        await page.screenshot({ path: `${out}/01-entry-${tag}-${vp.width}x${vp.height}.png` });
      }

      // ── dialog: fill the create form ──────────────────────────────────────
      const dialog = await openDialog();
      const botName = sc.mode === 'approved' ? 'Snap Bot' : 'Draw Bot';
      const botList = dialog.locator('section[aria-label="桌边的机器人"]');
      assert(
        (await botList.textContent()).includes('基础'),
        'bot list shows the low difficulty label',
      );
      assert(
        (await botList.textContent()).includes('进阶'),
        'bot list shows the medium difficulty label',
      );
      // Difficulty is orthogonal to style. Two tiers remain (low / medium); the
      // withdrawn `high` / Master tier is gone. Exercise the medium default, the
      // llm override, then leave medium selected to create.
      const difficultyButtons = dialog.locator('button[aria-describedby^="bot-difficulty-"]');
      const policyButtons = dialog.locator('button[aria-describedby^="bot-policy-"]');
      assert(
        (await difficultyButtons.count()) === 2,
        `difficulty offers exactly two tiers (got ${await difficultyButtons.count()})`,
      );
      assert(
        (await difficultyButtons.nth(1).getAttribute('aria-checked')) === 'true',
        'new bots default to medium difficulty',
      );
      await difficultyButtons.nth(0).click();
      assert(
        (await difficultyButtons.nth(0).getAttribute('aria-checked')) === 'true' &&
          (await difficultyButtons.nth(1).getAttribute('aria-checked')) === 'false',
        'low difficulty selection updates the selected radio state',
      );
      await policyButtons.nth(4).click();
      assert(
        (await difficultyButtons.count()) === 2 &&
          (await difficultyButtons.nth(0).isDisabled()) &&
          (await difficultyButtons.nth(1).isDisabled()),
        'llm disables all difficulty controls',
      );
      await dialog.getByText('大模型不受难度影响。', { exact: true }).waitFor();
      await policyButtons.nth(0).click();
      await difficultyButtons.nth(1).click();
      await dialog.getByText('基础', { exact: true }).waitFor();
      await dialog.getByText('进阶', { exact: true }).waitFor();
      await dialog.getByLabel('名字（可选）').fill(botName);
      if (sc.mode === 'approved' && tag === 'desktop') {
        await page.screenshot({
          path: `${out}/02-dialog-open-${tag}-${vp.width}x${vp.height}.png`,
        });
      }
      const startPosts = () =>
        requests.filter((r) => r.startsWith('POST') && /\/bots\/botnew\/start$/.test(r)).length;

      await dialog.getByRole('button', { name: /入座并开局/ }).click();
      assert(
        createBodies.at(-1)?.difficulty === 'medium',
        'create sends selected medium difficulty',
      );

      if (sc.mode === 'approved') {
        // host = banker: the buy auto-approves and the dialog auto-starts
        await page.getByText(/已上场，坐上 6 号位/).waitFor();
        assert(
          startPosts() === 1,
          `approved flow must POST start exactly once (got ${startPosts()})`,
        );
        await page.waitForTimeout(300);
        if (tag === 'desktop') {
          await page.screenshot({
            path: `${out}/03-dialog-started-${tag}-${vp.width}x${vp.height}.png`,
          });
        }
        // back at the felt: the pod for the bot THIS run created, badge lit
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () => document.querySelectorAll('.table-role-badge--bot').length >= 3,
        );
        await page.waitForTimeout(400);
        await page.screenshot({
          path: `${out}/04-bots-seated-${tag}-${vp.width}x${vp.height}.png`,
        });
      } else {
        // ── pending branch: no auto-start, waiting prose, manual Start ──────
        await page.getByText(/买入还在账房排队/).waitFor();
        assert(startPosts() === 0, `pending buy must NOT POST start (got ${startPosts()})`);
        // the row must offer no Start while the buy waits
        assert(
          (await dialog.getByRole('button', { name: '开始', exact: true }).count()) === 0,
          'waiting_buy_approval must not show Start yet',
        );
        await page.screenshot({
          path: `${out}/05-pending-waiting-${tag}-${vp.width}x${vp.height}.png`,
        });
        // the mocked banker approves: the next GET flips the bot to ready
        const bot = bots.find((b) => b.id === 'botnew');
        bot.status = 'ready';
        bot.updatedAt = Date.now();
        // dialog-open polling (4s) picks it up; the Start button appears
        await dialog.getByRole('button', { name: '开始', exact: true }).waitFor({ timeout: 15000 });
        await dialog.getByRole('button', { name: '开始', exact: true }).click();
        await page.waitForTimeout(800);
        assert(startPosts() === 1, `clicking Start must POST start (got ${startPosts()})`);
        // the row reads 牌局中 once the reload lands
        await dialog.getByText('牌局中', { exact: true }).last().waitFor({ timeout: 10000 });
        await page.screenshot({
          path: `${out}/06-pending-started-${tag}-${vp.width}x${vp.height}.png`,
        });
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () => document.querySelectorAll('.table-role-badge--bot').length >= 3,
        );
        await page.screenshot({
          path: `${out}/07-pending-seated-${tag}-${vp.width}x${vp.height}.png`,
        });
      }

      console.log(`[${sc.mode}] shots written to ${out} (${tag})`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
if (errors.length) process.exitCode = 1;
