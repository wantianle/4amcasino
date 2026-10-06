import { useStore } from './store.ts';
import { tr } from './i18n/index.ts';
import type {
  AdminOverview,
  BotDifficulty,
  BotStatus,
  CommissionScope,
  CommissionSettings,
  RoomGameplaySettings,
} from '@4am/shared';
import { isAdminSite } from './adminSite.ts';
import { statsQuery, type StatsQuery, type HandStats, type HiddenStats, type RoomHud } from '../features/stats/types.ts';

/** The single shared vocabularies (values + types) live in @4am/shared; this
 *  module re-exports them so the rest of the web app has one import site. */
export type { BotDifficulty, BotStatus };

/** The new-gameplay features a host can fire on demand (as opposed to the
 *  always-on time bank / multi-run switches). Matches the server's
 *  `room_feature_triggers.kind` allowlist. */
export type FeatureTriggerKind = 'squid' | 'bomb';

/** One row of the platform admin audit trail (GET /api/admin/audit). `detail`
 *  is whatever JSON the server recorded for that action, or null. */
export interface AdminAuditEntry {
  id: number;
  operatorUserId: number;
  operatorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  ts: number;
}

export interface AdminAuditPage {
  entries: AdminAuditEntry[];
  total: number;
  offset: number;
  hasMore: boolean;
}

/** One row of `GET /api/me/rooms`: a room this account has ever been part of,
 *  including archived/closed ones, with the caller's own net and hand count.
 *  `myHands` already excludes voided hands; `myNet` is the net chip result. */
export interface MyRoomSummary {
  roomId: string;
  name: string;
  sb: number;
  bb: number;
  createdAt: number;
  hostId: number;
  hostName: string;
  archived: boolean;
  archivedAt: number | null;
  /** Legacy alias of `archivedAt`, kept for the closing-room consumers. */
  closedAt: number | null;
  /** Last activity in the room (latest ledger movement, archive or creation). */
  updatedAt: number;
  deleted: boolean;
  voided: boolean;
  /** Participants excluding the platform/bank account. */
  playerCount: number;
  myNet: number;
  myHands: number;
  isHost: boolean;
}

/** One hand in `GET /api/rooms/:id/hands`, already carrying YOUR result. */
export interface MyHandRef {
  handId: string;
  head: string;
  ts: number;
  myNet: number | null;
  outcome: string;
  voided: boolean;
}

/** ── Table bots (apps/server/src/botRoutes.ts) ───────────────────────────────
 * The PUBLIC, sanitized view of a bot opponent: the server never ships the
 * encrypted seed or a runner grant on these routes. Mirrors
 * `botPublicJson()` / the shared `BOT_STATUSES`. */
export interface BotPublic {
  id: string;
  userId: number;
  username: string | null;
  displayName: string | null;
  /** The seat the bot actually occupies (room_players wins over the
   *  configured seat), or null while it never sat down. */
  seat: number | null;
  configuredSeat: number | null;
  status: BotStatus;
  policyKind: string;
  /** Difficulty tier; `medium` is the default. The withdrawn `high` is no longer
   *  accepted on write (legacy rows are migrated to `medium` server-side). */
  difficulty: BotDifficulty;
  createdAt: number;
  updatedAt: number;
  stoppedAt: number | null;
  stopRequestedAt: number | null;
  identityRecoverable: boolean;
  /** Current room_players stack, using the same source as the table. */
  stack: number;
}

/** The buy request the create/buy endpoints echo back. `approved` means the
 *  chips already landed (host is the room's banker); `pending` waits in the
 *  normal banker approval queue. */
export interface BotBuyEcho {
  id: number;
  status: string;
}

/** A deep-partial feature patch: the server merges it over the stored settings,
 *  so the UI can send just the knob that changed (`{ squid: { enabled: true } }`).
 *  Mirrors the server's `gameplayFeaturesSchema`. */
export interface RoomFeaturesPatch {
  squid?: Partial<RoomGameplaySettings['squid']>;
  timeBank?: Partial<RoomGameplaySettings['timeBank']>;
  bombPot?: Partial<Omit<RoomGameplaySettings['bombPot'], 'schedule'>> & {
    schedule?: Partial<RoomGameplaySettings['bombPot']['schedule']>;
  };
  multiRun?: Partial<RoomGameplaySettings['multiRun']>;
}

/** Client-generated opaque id for manual feature triggers. Lets the server
 *  dedupe the POST/DELETE pair without trusting anything else in the body. */
function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Fetch with retries on 502/503/504 and network failure, GETs only. Redeploys
 *  take the server down for a few seconds; reads ride the gap out instead of
 *  erroring, while writes stay single-shot so nothing money-shaped repeats. */
async function send(path: string, method: string, body?: unknown): Promise<Response> {
  // a measured deploy swap is ~1 min (Render detaches and reattaches the
  // disk), so reads stay patient for about that long before giving up
  const tries = method === 'GET' ? 12 : 1;
  for (let attempt = 1; ; attempt++) {
    const token = useStore.getState().auth.token;
    try {
      const res = await fetch(path, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (attempt === tries || ![502, 503, 504].includes(res.status)) return res;
    } catch (err) {
      if (attempt === tries) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(6000, 1200 * attempt)));
  }
}

/** An HTTP failure from the API. `message` is display-ready Chinese prose
 *  (`tr()` of the server's English, falling back to English when a phrase has
 *  no dictionary entry — better raw English than wrong Chinese). `raw` keeps
 *  the canonical English for logs, tests and agents; `.status` is unchanged. */
export class ApiError extends Error {
  readonly raw: string;
  readonly status: number;
  constructor(raw: string, status: number) {
    super(tr(raw));
    this.name = 'ApiError';
    this.raw = raw;
    this.status = status;
  }
}

export interface SettlementMark {
  userId: number;
  name: string;
  note: string | null;
  hasProof: boolean;
  ts: number;
}

export interface SettlementMarks {
  marks: SettlementMark[];
}

async function req(path: string, body?: unknown, method?: string): Promise<any> {
  const token = useStore.getState().auth.token;
  const res = await send(path, method ?? (body === undefined ? 'GET' : 'POST'), body);
  const json = await res.json().catch(() => ({}));
  if (
    res.status === 401 &&
    token &&
    !path.startsWith('/api/login') &&
    !path.startsWith('/api/register')
  ) {
    // stale session (e.g. the server redeployed and reset its data): sign out cleanly
    const admin = isAdminSite() || /^\/admin(?:\/|$)/.test(location.pathname);
    const next = location.pathname;
    useStore.getState().logout();
    if (!location.pathname.startsWith('/login'))
      location.assign(
        `/login?expired=1${admin ? `&admin=1&next=${encodeURIComponent(next)}` : ''}`,
      );
    throw new ApiError('session expired', 401);
  }
  if (!res.ok) throw new ApiError(json.error ?? `request failed (${res.status})`, res.status);
  return json;
}

export const api = {
  myStats: (query: StatsQuery = {}) => req(`/api/me/stats?${statsQuery(query)}`) as Promise<HandStats>,
  userStats: (id: number, query: StatsQuery = {}) => req(`/api/users/${id}/stats?${statsQuery(query)}`) as Promise<HandStats | HiddenStats>,
  roomHud: (id: string) => req(`/api/rooms/${encodeURIComponent(id)}/hud`) as Promise<RoomHud>,
  register: (username: string, authKey: string, publicKey: string) =>
    req('/api/register', { username, authKey, publicKey }),
  login: (username: string, authKey: string) => req('/api/login', { username, authKey }),
  me: () => req('/api/me'),
  /** The sidebar/lobby "your tables" list. Archived (closed) rooms are hidden
   *  server-side by default; the lobby's explicit "Archived tables" section
   *  asks for `all` so it can still show them. */
  myRooms: (opts: { archived?: boolean | 'all' } = {}) => {
    const q = new URLSearchParams();
    if (opts.archived !== undefined) q.set('archived', String(opts.archived));
    const qs = q.toString();
    return req(`/api/my-rooms${qs ? `?${qs}` : ''}`);
  },
  /** My results: every room this account was ever part of. Paged like the hand
   *  history: `total`/`hasMore` describe the filtered set, and `archived`
   *  filters server-side (`true` = retired only, `false` = live only, `all` =
   *  both; absent = live only), so `/history` never silently loses rooms past
   *  one page. `totals` are career aggregates over the whole filtered set. */
  meRooms: (opts: { archived?: boolean | 'all'; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.archived !== undefined) q.set('archived', String(opts.archived));
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts.offset !== undefined) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return req(`/api/me/rooms${qs ? `?${qs}` : ''}`) as Promise<{
      rooms: MyRoomSummary[];
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
      totals: { hands: number; net: number };
    }>;
  },
  platformSettings: () =>
    req('/api/platform/settings') as Promise<
      Pick<CommissionSettings, 'commissionBps' | 'revision' | 'updatedAt'>
    >,
  adminSettings: () => req('/api/admin/settings') as Promise<CommissionSettings>,
  adminChangeCommission: (commissionBps: number, scope: CommissionScope, revision: number) =>
    req('/api/admin/settings/commission', { commissionBps, scope, revision }, 'PUT') as Promise<
      CommissionSettings & { affectedRooms: number }
    >,
  adminOverview: () => req('/api/admin/overview') as Promise<AdminOverview>,
  adminUsers: (q = '', offset = 0) =>
    req(`/api/admin/users?q=${encodeURIComponent(q)}&offset=${offset}`),
  /** Platform-only exact user lookup. Unlike `userProfile` it includes
   *  `disabled` and `mergedInto`, so the admin ID box can render the right
   *  Disable / Enable / merged state. */
  adminLookupUser: (id: number) =>
    req(`/api/admin/users?id=${id}`) as Promise<{
      user: {
        userId: number;
        username: string;
        displayName: string;
        disabled: number;
        mergedInto: number | null;
        isPlatform: boolean;
      } | null;
    }>,
  createRoom: (
    name: string,
    sb: number,
    bb: number,
    auditMode?: string,
    actionSecs?: number,
    minSettleHands?: number,
    commissionRevision?: number,
    features?: RoomFeaturesPatch,
  ) =>
    req('/api/rooms', {
      name,
      sb,
      bb,
      ...(auditMode ? { auditMode } : {}),
      ...(actionSecs !== undefined ? { actionSecs } : {}),
      ...(minSettleHands ? { minSettleHands } : {}),
      ...(commissionRevision !== undefined ? { commissionRevision } : {}),
      ...(features ? { features } : {}),
    }),
  joinRoom: (joinCode: string) => req('/api/rooms/join', { joinCode }),
  getRoom: (id: string) => req(`/api/rooms/${id}`),
  buy: (roomId: string, amount: number, note?: string) =>
    req(`/api/rooms/${roomId}/buy`, { amount, ...(note ? { note } : {}) }),
  requests: (roomId: string) => req(`/api/rooms/${roomId}/requests`),
  approve: (roomId: string, requestId: number, approve: boolean) =>
    req(`/api/rooms/${roomId}/approve`, { requestId, approve }),
  room: (id: string) => req(`/api/rooms/${id}`),
  revertPurchase: (roomId: string, entryId: number) =>
    req(`/api/rooms/${roomId}/revert`, { entryId }),
  setCoBanker: (roomId: string, userId: number | null) =>
    req(`/api/rooms/${roomId}/co-banker`, { userId }, 'PUT'),
  session: (roomId: string) => req(`/api/rooms/${roomId}/session`),
  timeline: () => req('/api/me/timeline'),
  playStyle: (userId: number) => req(`/api/users/${userId}/style`),
  friends: () => req('/api/friends'),
  addFriend: (username: string) => req('/api/friends/request', { username }),
  respondFriend: (userId: number, accept: boolean) =>
    req('/api/friends/respond', { userId, accept }),
  removeFriend: (userId: number) => req(`/api/friends/${userId}`, undefined, 'DELETE'),
  inviteFriend: (roomId: string, userId: number) => req(`/api/rooms/${roomId}/invite`, { userId }),
  invites: () => req('/api/invites'),
  respondInvite: (inviteId: number, accept: boolean) =>
    req(`/api/invites/${inviteId}/respond`, { accept }),
  voidRoom: (roomId: string, voided: boolean) => req(`/api/rooms/${roomId}/void`, { voided }),
  // Close a finished table on the spot: it leaves the room list and stops
  // counting towards stats, but nothing is deleted and debts stay owed
  // (requested by notpritam). Host or platform only.
  /** Immediate room close: archive the room and clear seats. */
  closeRoom: (roomId: string) =>
    req(`/api/rooms/${roomId}/close`, {}, 'POST') as Promise<{
      ok: true;
      roomId: string;
      archived: true;
      closedAt: number | null;
      alreadyClosed: boolean;
      /** Whether a hand was still running when the room was archived. */
      handActive: boolean;
    }>,
  publicRooms: () => req('/api/rooms/public'),
  joinPublic: (roomId: string) => req(`/api/rooms/${roomId}/join-public`, {}),
  spectateSettings: (roomId: string, allow?: boolean) =>
    req(`/api/rooms/${roomId}/spectate-settings`, allow === undefined ? {} : { allow }),
  watch: (token: string) => req(`/api/watch/${token}`),
  askJoin: (roomId: string) => req(`/api/rooms/${roomId}/ask-join`, {}),
  joinRequests: (roomId: string) => req(`/api/rooms/${roomId}/join-requests`),
  admit: (roomId: string, userId: number, accept: boolean) =>
    req(`/api/rooms/${roomId}/admit`, { userId, accept }),
  standUp: (roomId: string, userId: number) => req(`/api/rooms/${roomId}/stand-up`, { userId }),
  transfer: (roomId: string, toUserId: number, amount: number, note?: string) =>
    req(`/api/rooms/${roomId}/transfer`, { toUserId, amount, ...(note ? { note } : {}) }),
  roomExtras: (roomId: string, extras: Record<string, unknown>) =>
    req(`/api/rooms/${roomId}/settings`, extras, 'PUT'),
  setMeetLink: (roomId: string, meetLink: string) =>
    req(`/api/rooms/${roomId}/settings`, { meetLink }, 'PUT'),
  voidHand: (roomId: string, handId: string) => req(`/api/rooms/${roomId}/void-hand`, { handId }),
  ledger: (roomId: string) => req(`/api/rooms/${roomId}/ledger`),
  hands: (roomId: string, opts: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts.offset !== undefined) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return req(`/api/rooms/${roomId}/hands${qs ? `?${qs}` : ''}`) as Promise<{
      hands: MyHandRef[];
      total: number;
      limit: number;
      offset: number;
    }>;
  },
  hand: (roomId: string, handId: string) => req(`/api/rooms/${roomId}/hands/${handId}`),
  // account security: every one of these re-derives your signing identity in the
  // browser, so they all carry a fresh publicKey (requested by notpritam)
  changePassword: (currentAuthKey: string, newAuthKey: string, newPublicKey: string) =>
    req('/api/me/password', { currentAuthKey, newAuthKey, newPublicKey }),
  changeUsername: (
    username: string,
    currentAuthKey: string,
    newAuthKey: string,
    newPublicKey: string,
  ) => req('/api/me/username', { username, currentAuthKey, newAuthKey, newPublicKey }),
  recoveryStatus: () => req('/api/me/recovery'),
  recover: (username: string, recoveryAuthKey: string, newAuthKey: string, newPublicKey: string) =>
    req('/api/recover', { username, recoveryAuthKey, newAuthKey, newPublicKey }),
  logout: () => req('/api/logout', {}),
  sessions: () => req('/api/me/sessions'),
  revokeOtherSessions: () => req('/api/me/sessions/revoke-others', {}),
  profile: () => req('/api/profile'),
  updateProfile: (p: Record<string, unknown>) => req('/api/profile', p, 'PUT'),
  uploadAvatar: (image: string) => req('/api/profile/avatar', { image }, 'PUT'),
  deleteAvatar: () => req('/api/profile/avatar', undefined, 'DELETE'),
  leaderboard: () => req('/api/leaderboard'),
  roomLeaderboard: (roomId: string) => req(`/api/rooms/${roomId}/leaderboard`),
  userProfile: (userId: number) => req(`/api/users/${userId}/profile`),
  setMinSettleHands: (roomId: string, minSettleHands: number) =>
    req(`/api/rooms/${roomId}/settings`, { minSettleHands }, 'PUT'),
  setSevenDeuceBonus: (roomId: string, sevenDeuceBonus: number) =>
    req(`/api/rooms/${roomId}/settings`, { sevenDeuceBonus }, 'PUT'),
  setAutoApproveBuys: (roomId: string, autoApproveBuys: boolean) =>
    req(`/api/rooms/${roomId}/settings`, { autoApproveBuys }, 'PUT'),
  setTvReplays: (roomId: string, tvReplays: boolean) =>
    req(`/api/rooms/${roomId}/settings`, { tvReplays }, 'PUT'),
  setAutoDeal: (roomId: string, autoDeal: boolean) =>
    req(`/api/rooms/${roomId}/settings`, { autoDeal }, 'PUT'),
  /** Patch the room's new-gameplay feature settings (squid, time bank, bomb
   *  pot, multi-run). The server merges a deep-partial and validates bounds. */
  setRoomFeatures: (roomId: string, features: RoomFeaturesPatch) =>
    req(`/api/rooms/${roomId}/settings`, { features }, 'PUT') as Promise<{ ok: boolean }>,
  /** Fire a manual feature trigger on demand. `requestId` is client-generated
   *  so a retried POST can be deduped server-side. Returns the queued trigger. */
  triggerFeature: (roomId: string, feature: FeatureTriggerKind, requestId = newRequestId()) =>
    req(`/api/rooms/${roomId}/feature-triggers`, { feature, requestId }) as Promise<{
      trigger: { requestId: string; feature: string; status: string };
      duplicate?: boolean;
    }>,
  /** Cancel a previously queued manual trigger. The id must be the one returned
   *  by `triggerFeature`. */
  cancelFeatureTrigger: (roomId: string, feature: FeatureTriggerKind, requestId: string) =>
    req(
      `/api/rooms/${roomId}/feature-triggers/${encodeURIComponent(requestId)}`,
      { feature, requestId },
      'DELETE',
    ) as Promise<{ ok: boolean }>,
  myDebts: () => req('/api/me/debts'),
  handHistory: () => req('/api/me/hand-history'),
  bestHand: (userId: number) => req(`/api/users/${userId}/best-hand`),
  markSettled: (roomId: string, otherUserId: number, note?: string, proof?: string) =>
    req('/api/settlements', {
      roomId,
      otherUserId,
      ...(note ? { note } : {}),
      ...(proof ? { proof } : {}),
    }),
  // settling up across rooms: one line per person, plus the redirects that close
  // two debts with one payment (requested by notpritam)
  settleView: () => req('/api/me/settle'),
  pendingTasks: () => req('/api/me/pending'),
  settlementMarks: (settlementId: number) =>
    req(`/api/settlements/${settlementId}/marks`) as Promise<SettlementMarks>,
  settlementProof: async (settlementId: number, userId: number): Promise<Blob> => {
    const res = await send(`/api/settlements/${settlementId}/proof/${userId}`, 'GET');
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new ApiError(json.error ?? `request failed (${res.status})`, res.status);
    }
    return res.blob();
  },
  houseDues: () => req('/api/me/house'),
  payHouse: (amount: number, note?: string, proof?: string) =>
    req('/api/house/pay', { amount, ...(note ? { note } : {}), ...(proof ? { proof } : {}) }),
  sharedRooms: (userId: number) => req(`/api/users/${userId}/shared-rooms`),
  roomSettings: (roomId: string, actionSecs: number) =>
    req(`/api/rooms/${roomId}/settings`, { actionSecs }, 'PUT'),
  // ask the platform account to fold a duplicate account into another one
  mergeRequest: (fromUsername: string, intoUsername: string, note?: string) =>
    req('/api/me/merge-request', { fromUsername, intoUsername, ...(note ? { note } : {}) }),
  // platform-only console: account merges and user/room admin
  adminHouse: () => req('/api/admin/house'),
  adminMerges: () => req('/api/admin/merges'),
  adminDecideMerge: (id: number, approve: boolean) => req(`/api/admin/merges/${id}`, { approve }),
  adminDisableUser: (id: number) => req(`/api/admin/users/${id}/disable`, {}),
  adminEnableUser: (id: number) =>
    req(`/api/admin/users/${id}/enable`, {}) as Promise<{ ok: boolean; changed: boolean }>,
  adminSetUserPassword: (id: number, newAuthKey: string, newPublicKey: string) =>
    req(`/api/admin/users/${id}/password`, { newAuthKey, newPublicKey }),
  /** Server-side one-tap reset to the initial password 123456 (re-keys the
   *  account and signs it out everywhere; the client derives nothing). */
  adminResetUserInitialPassword: (id: number) =>
    req(`/api/admin/users/${id}/reset-initial`, {}) as Promise<{ ok: boolean }>,
  adminAudit: (opts: { limit?: number; offset?: number; action?: string; targetId?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts.offset !== undefined) q.set('offset', String(opts.offset));
    if (opts.action) q.set('action', opts.action);
    if (opts.targetId) q.set('targetId', opts.targetId);
    const qs = q.toString();
    return req(`/api/admin/audit${qs ? `?${qs}` : ''}`) as Promise<AdminAuditPage>;
  },
  // admin-initiated: bypass the request queue entirely (merge/archive/delete
  // take effect immediately, unlike the self-serve/approval flows above)
  adminMergeNow: (fromUsername: string, intoUsername: string, note?: string) =>
    req('/api/admin/merge', { fromUsername, intoUsername, ...(note ? { note } : {}) }),
  adminRooms: (q?: string) => req(`/api/admin/rooms${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  adminArchiveRoom: (id: string, archived: boolean) =>
    req(`/api/admin/rooms/${id}/archive`, { archived }),
  adminDeleteRoom: (id: string) => req(`/api/admin/rooms/${id}/delete`, {}),
  // ── table bots (host-only mutations; GET is open to members/bankers) ──────
  /** Public, sanitized bot list for the room (no seed, no grant token). */
  roomBots: (roomId: string) => req(`/api/rooms/${roomId}/bots`) as Promise<{ bots: BotPublic[] }>,
  /** Create a bot in a seat; with `initialBuyIn` it queues through the normal
   *  banker path, so the returned `buyRequest.status` says whether the bot is
   *  ready to start yet (`approved`) or still waiting (`pending`). */
  createBot: (
    roomId: string,
    body: {
      seat: number;
      name?: string;
      policyKind?: string;
      difficulty?: BotDifficulty;
      policyJson?: string;
      initialBuyIn?: number;
    },
  ) =>
    req(`/api/rooms/${roomId}/bots`, body) as Promise<{
      bot: BotPublic;
      buyRequest: BotBuyEcho | null;
    }>,
  /** Hand the bot to the supervisor (`ready|stopped|error` → `starting`). */
  startBot: (roomId: string, botId: string) =>
    req(`/api/rooms/${roomId}/bots/${encodeURIComponent(botId)}/start`, {}) as Promise<{
      bot: BotPublic;
    }>,
  /** Graceful stop: a live hand is allowed to finish first. */
  stopBot: (roomId: string, botId: string) =>
    req(`/api/rooms/${roomId}/bots/${encodeURIComponent(botId)}/stop`, {}) as Promise<{
      bot: BotPublic;
    }>,
  /** Fund the bot through the banker queue, exactly like a human buy-in. */
  buyBot: (roomId: string, botId: string, amount: number) =>
    req(`/api/rooms/${roomId}/bots/${encodeURIComponent(botId)}/buy`, {
      amount,
    }) as Promise<{ buyRequest: BotBuyEcho }>,
  /** Remove the bot (graceful when a supervisor is attached). */
  removeBot: (roomId: string, botId: string) =>
    req(`/api/rooms/${roomId}/bots/${encodeURIComponent(botId)}`, undefined, 'DELETE') as Promise<{
      bot: BotPublic;
    }>,
};
