import type { FastifyInstance } from 'fastify';
import { publicTunables, tunablesRevision } from './tunables.js';

/**
 * Public, unauthenticated runtime-config endpoint.
 *
 * Lives in its own module rather than `app.ts` / `rooms.ts` because it is
 * app-wide infrastructure (like `/api/health`): it is not scoped to a room, a
 * bot, or a user, and the response is a single derived read of the declaration
 * in `tunables.ts`. Keeping transport separate from the declaration keeps both
 * testable without spinning up a room.
 *
 * Security: the body is built exclusively by `publicTunables()`, which filters
 * on `public: true`. There is no `process.env` passthrough, so credentials
 * (`LLM_API_KEY`, `BOT_IDENTITY_KEY`, ...) have no route into the response.
 */
export function registerConfigRoutes(app: FastifyInstance): void {
  app.get('/api/config', async (_req, reply) => {
    const tunables = publicTunables();
    return reply
      // A restart can change values, so never let a client or intermediary
      // replay a stale config across the restart.
      .header('cache-control', 'no-store')
      .send({ tunables, revision: tunablesRevision(tunables) });
  });
}
