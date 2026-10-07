import type { CardId, PlayerAction } from '@4am/shared';

/**
 * Pure data shapes for the table domain.
 *
 * `SeatView` is produced by the pages (`TablePage`, `ReplayPage`) from room +
 * hand state and consumed by the `RoundTable` widget. It lives here, in the
 * entities layer, so pages can name the shape without importing the widget's
 * implementation file (no `pages/` → `widgets/` reverse dependency).
 */

export interface SeatView {
  seat: number;
  userId: number;
  displayName: string;
  avatarVersion: number;
  stack: number;
  isButton: boolean;
  isToAct: boolean;
  folded: boolean;
  allIn: boolean;
  inHand: boolean;
  broke: boolean;
  sittingOut: boolean;
  /** Currently up the most chips in this room (stack minus buy-ins). */
  isLeader: boolean;
  connected: boolean;
  speaking: boolean;
  voiceMuted: boolean;
  revealed?: CardId[];
  won: boolean;
  /** Chips netted by this seat in the settled hand. */
  wonAmount: number;
  /** Chips requested from the bank, still waiting for approval. */
  pendingBuy: number;
  lastAction?: PlayerAction & { auto?: boolean };
  /** P2 B2: this seat's remaining time bank in ms. Optional and additive. */
  bankMs?: number;
  /** Table bot: its lifecycle status drives the cyan identity badge and the
   *  status pill under the pod. Absent for human seats. */
  bot?: { status: string; policyKind: string };
}
