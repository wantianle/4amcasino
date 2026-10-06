import { createApp } from './app.js';
import { attachHub } from './hub.js';
import { SnapshotPersistence } from './persist.js';
import { ensurePlatformAccount } from './platform.js';
import { derivePlatformCredentials } from './platform-crypto.js';
import { BotSupervisor } from './botSupervisor.js';
import { llmOptionsFromEnv } from './botPolicy.js';

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? './4amcasino.db';

async function main(): Promise<void> {
  let persist: SnapshotPersistence | null = null;
  if (process.env.MONGO_URL) {
    try {
      persist = await SnapshotPersistence.connect(process.env.MONGO_URL, dbPath);
    } catch (err) {
      console.error('MongoDB unreachable; continuing with local storage only:', err);
    }
  }

  const { app, db, botControl } = createApp(dbPath, () => ({
    storage: persist ? 'mongodb' : dbPath.startsWith('/data') ? 'disk' : 'ephemeral',
    lastBackup: persist?.lastBackupTs() ?? null,
  }));

  // Seed (or adopt) the platform/house account on boot so the room commission
  // routes to it instead of falling back to the room banker - a plain deploy is
  // enough, no manual seed script needed. Idempotent: adopts the existing account
  // by username when it already exists (the prod case), creates it otherwise.
  // Requested by notpritam (docs/FEATURES.md).
  const platformUsername = process.env.PLATFORM_USERNAME ?? '4amcasino';
  const seeded = ensurePlatformAccount(db, {
    username: platformUsername,
    createCreds: () =>
      derivePlatformCredentials(platformUsername, process.env.PLATFORM_PASSWORD ?? 'Fun99312@'),
  });
  console.log(
    `platform account ${seeded.adopted ? 'adopted' : seeded.created ? 'created' : 'ready'} (id ${seeded.userId})`,
  );

  attachHub(app, db);
  persist?.start(db);

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`4amcasino server on :${port}`);

  // Bots connect back over the loopback WS, so the supervisor can only be wired
  // once the listener is up. It then recovers any bot left running/starting by a
  // previous process (a fresh grant is issued; the stale one dies).
  const botServerUrl = process.env.BOT_SERVER_URL ?? `http://127.0.0.1:${port}`;
  // Phase 3: LLM config is read from server env only (never DB/API/DB logs).
  // The metric sink logs structured events that contain no prompt, key or raw
  // model output, so it is safe to keep on.
  const llm = llmOptionsFromEnv(process.env, (event) =>
    console.log(`[llm-metric] ${JSON.stringify(event)}`),
  );
  const supervisor = new BotSupervisor(db, {
    baseUrl: botServerUrl,
    // Slots are pooled per room (BOT_MAX_PER_ROOM, default 8); BOT_MAX_CONCURRENT
    // is now a wide server-wide safety valve (default 64), not a shared pool.
    maxPerRoom: Number(process.env.BOT_MAX_PER_ROOM ?? 8),
    maxConcurrent: Number(process.env.BOT_MAX_CONCURRENT ?? 64),
    runner: { llm },
  });
  botControl.hooks = supervisor;
  // A retired room (archived via /close, admin archive or lifecycle approval, or
  // deleted) must not keep occupying its runner pool: release its runners as soon
  // as the room change lands.
  supervisor.subscribeRoomEvents();
  supervisor.recover();

  // deploys send SIGTERM: stop the runners gracefully (so no bot is mid-hand
  // when the DB goes away), flush SQLite, close sockets, exit.
  const hardShutdownMs = Number.isFinite(Number(process.env.SHUTDOWN_HARD_MS))
    ? Number(process.env.SHUTDOWN_HARD_MS)
    : 30_000;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      console.log(`[shutdown] ${sig} received; stopping bot runners (hard bound ${hardShutdownMs}ms)`);
      void (async () => {
        await supervisor.stopAll().catch((err) => console.error('[shutdown] stopAll failed:', err));
        await persist?.flush().catch(() => {});
        await app.close();
        process.exit(0);
      })();
      // The hard bound must never kill the process BEFORE bot state is safe: a
      // live hand can outlast any fixed grace (graceMs is only a soft
      // threshold). On timeout, synchronously force every runtime bot to
      // `stopped` + revoke its grant first, then exit - so no exit path leaves a
      // `running`/`stopping` bot with a live grant and no runner.
      setTimeout(() => {
        const finalized = supervisor.finalizeAllRuntimeBots();
        console.error(
          `[shutdown] hard timeout (${hardShutdownMs}ms); fail-safe finalized ${finalized} bot(s) before exit`,
        );
        process.exit(0);
      }, hardShutdownMs).unref();
    });
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
