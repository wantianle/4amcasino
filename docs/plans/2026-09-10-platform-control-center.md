# Platform Control Center Implementation Plan

> Historical note — the sponsor/tournament admin actions named in the audit-coverage
> section were removed with the Agent Arena feature; the house-cut and dashboard plan
> remains current.

**Goal:** Set the house cut to 0.5%, let the platform account change it at runtime,
and provide a dedicated admin dashboard at admin.4amcasino.com.

**Architecture:** Keep the existing Render service and database. Persist the default
rate and an audit history in SQLite, explicitly snapshot the default when creating
a room, and preserve each hand's starting rate. The admin host serves a separate
authenticated application shell using the existing platform-only API guards.

**Tech Stack:** Fastify, SQLite, React Router, Zeus UI, Vitest and browser UAT.

## Rate controls and accounting

1. Add failing tests for the 50-basis-point default, platform authorization,
   bounded integer inputs, optimistic revision checks, persistence and scope.
2. Add settings/history storage and a one-time initial migration to 0.5% for
   all rooms. Record historical hand rates before updating any room rates.
3. Expose the current default to players and guarded settings GET/PUT to the
   platform account. A save chooses all rooms or new rooms only, records its
   actor and affected count, and broadcasts changed room settings.
4. Read the persisted default for every room creation. Each running hand keeps
   its starting rate, including its disclosure; future hands pick up changes.
5. Keep settlement and dues history accurate when a room has multiple rates.
   Floor each pot independently and preserve existing ledger hashes.

## Qualification requirements

Cap room creation and settings at 30 qualifying hands, with zero meaning no requirement.
Migrate existing requirements above 30 down to 30. Verify API validation, migration,
and the room controls used by both 2D and 3D modes.

## Dedicated admin interface

1. Add a standalone responsive Zeus admin shell with Overview, Revenue, Rooms,
   Users, Requests, and Settings destinations. Reuse existing management actions.
2. Add real aggregate overview data, recent revenue, user search and room rates.
3. Add an inline rate editor with scope, whole-chip example, save/error states,
   stale-version protection and an audit log.
4. Route the admin subdomain to the admin shell and its own sign-in experience;
   retain /admin/* on the main site as an accessible fallback. Verify the role
   with the server and show a clear access-denied state for regular players.
5. Replace hardcoded player rate copy with the live setting and disclose the
   rate of each room/hand. Extend the existing Zeus light/dark design system.

## Verification and release

1. Run relevant accounting, migration, auth, real-hand and UI tests; all workspace
   typechecks and the production build.
2. Use an isolated synthetic database for desktop/mobile, light/dark browser UAT:
   settings changes without restart, scope, history, invalid inputs, denied access,
   searches, navigation, refreshed player copy and failure recovery.
3. Review the captured admin surface and document the new surface boundary.
4. Merge and deploy; verify the exact release, live assets, health, rate endpoint,
   protected admin endpoints, canonical redirect and custom-domain routing.

## Domain dependency

Cloudflare: CNAME admin -> fouramcasino.onrender.com, DNS only for verification.
Render: add admin.4amcasino.com to the existing service's Custom Domains.
The subdomain was unresolved when work began. Browser control could not complete
Render sign-in, so the user has received the DNS and Render setup steps.

## Admin follow-ups (2026-10-05)

Three gaps in the platform console:

1. **Reversible disable.** `POST /api/admin/users/:id/enable` is idempotent
   (`UPDATE users SET disabled = 0 WHERE id = ? AND disabled = 1`, returns
   `{ok, changed}`). Enabling the platform account is allowed (harmless);
   disabling it stays blocked. The user panel now shows Enable instead of
   Disable for a disabled target and refreshes the directory afterwards.
2. **Server-side initial-password reset.** `POST /api/admin/users/:id/reset-initial`
   derives `scrypt('123456', '4am/auth/<username>')` / `scrypt('123456', '4am/id/<username>')`
   through platform-crypto.ts and reuses `rekey()`. Keeps the seated-409 guard
   and the full session purge; no forced password change. A new route rather
   than a `mode` on `/password`, so the existing client-derived reset stays
   intact. The panel adds a confirm-dialog button spelling out that it clears
   every session and swaps the signing key.
3. **Admin audit trail.** Append-only `admin_audit` plus `GET /api/admin/audit`
   (platform-only, newest first, `limit`/`offset`/`action`/`targetId`). Every
   successful admin action writes one row inside the same business transaction
   as its state change, so the two commit or roll back together (no
   separate-write window): `user.disable`/`user.enable`,
   `user.password-reset` (detail `{mode:'custom'|'initial'}`),
   `room.archive`/`room.unarchive`/`room.delete`,
   `lifecycle.approve`/`lifecycle.reject` (`{requestId, decisionType, changed}`),
   `merge.approve`/`merge.reject`/`merge.create`. AdminPage gains an Audit
   section with action/target filters and paging.

### Review fixes (round 2)

1. **Login refuses disabled accounts.** `auth.ts`'s `checkLogin` also reads
   `disabled` and returns null, so a disabled (or merge-retired) account gets
   401 and no session instead of a live token that only dies on the next
   authenticated request.
2. **Merged accounts stay retired.** `enable` returns 409 when `merged_into` is
   set and its `UPDATE` also carries `AND merged_into IS NULL`; a successful
   enable deletes any surviving session row. Both password-reset routes
   (`/password`, `/reset-initial`) no longer trust an outside-the-transaction
   read: they re-check the target inside the write transaction with a
   conditional `UPDATE ... WHERE merged_into IS NULL`, so a merged row changes 0
   rows and the whole reset (rekey + audit) is abandoned. That closes the window
   where a concurrent merge could otherwise rekey an already-retired account.
3. **`disable` is a conditional update** (`WHERE id = ? AND disabled = 0`) so
   its `changed` is truthful; the update, the session purge and the audit row
   share one transaction.
4. **Broader audit coverage.** `writeAdminAudit` moved to `db.ts` (no import
   cycle) and is now called inside the existing business transactions of the
   platform-only writes: `settings.commission`, `sponsor.create/update/delete/
   receipt`, `tournament.media`, `tournament.review.approve/reject`,
   `tournament.settlement`. Two tournament actions that a platform account can
   perform on another organizer's tournament are audited on their **platform
   branch only**, inside the same transaction as the change:
   `tournament.terms` (a platform account editing terms publishes immediately
   instead of queueing for review, detail `{revision, approvalStatus}`) and
   `tournament.control` (a platform account bypassing the organizer for
   start/pause/resume/cancel, detail `{action, status}`). An organizer's own
   terms edit or control action is not written to the platform audit trail.
   Every audit row now commits or rolls back with the change it records (no
   separate-write window). The corresponding lifecycle events
   (`tournament.start`, `tournament.terms_updated`, `tournament.control`,
   `tournament.reviewed`) are published by the caller only after the enclosing
   transaction commits, so a failed audit insert cannot roll the DB back while
   an event has already gone out.
5. **Read shape.** Added `(ts DESC, id DESC)`, `(action, ts DESC, id DESC)` and
   `(target_id)` indexes; `GET /api/admin/audit` sends `Cache-Control:
   no-store`.
6. **Accurate admin lookup.** `GET /api/admin/users?id=` returns a single user
   with `disabled` and `mergedInto` so the console's ID box can show
   Disable / Enable / merged correctly; the table select also exposes
   `mergedInto`.
