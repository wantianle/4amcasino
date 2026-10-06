import * as dbModel from '../db.js';
import type { DB } from '../db.js';
import { migrateAgentPlatform } from '../agentSchema.js';
import { migrateHandStats } from '../handProjection.js';
import { migrate } from './base.js';
import { migrateBots } from './bots.js';
import { migrateAdminAudit } from './adminAudit.js';
import { migrateSettlementPrepared } from './settlementPrepared.js';
import { migrateRoomsIndex } from './roomsIndex.js';

/** One named, ordered schema migration. */
export type Migration = { name: string; run: (db: DB) => void };

/**
 * The boot migration chain, in the exact order it has always run. Order is
 * load-bearing - `bots` needs the `agent_grants` table created by
 * `agent-platform`, and `reconcile-lifecycle` reads the `hands`/`hand_players`
 * tables created by `hand-stats` - so keep the `needs:` notes truthful when
 * adding or reordering steps.
 *
 * The `base` step now lives in `./base.ts`, which has no runtime dependency on
 * `db.ts`, so it is imported by name like every other standalone step. The one
 * remaining step implemented in `db.ts` (`reconcile-lifecycle`) is reached
 * through the `dbModel` namespace and only dereferenced when the step runs:
 * `db.ts` imports this runner, so at module-evaluation time its own exports are
 * not installed yet and a direct named import would resolve to `undefined`.
 */
export const STEPS: Migration[] = [
  { name: 'base', run: migrate },
  { name: 'agent-platform', run: migrateAgentPlatform },
  // needs: agent-platform (creates agent_grants).
  { name: 'bots', run: migrateBots },
  { name: 'hand-stats', run: migrateHandStats },
  // needs: hand-stats (creates hands / hand_players).
  { name: 'reconcile-lifecycle', run: (db) => dbModel.reconcileMissingSettlements(db) },
  { name: 'admin-audit', run: migrateAdminAudit },
  { name: 'settlement-prepared', run: migrateSettlementPrepared },
  { name: 'rooms-index', run: migrateRoomsIndex },
];

/** Run every schema migration in its registered order. */
export function runMigrations(db: DB): void {
  for (const step of STEPS) step.run(db);
}
