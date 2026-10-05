/** Nickname (display name) rules - the browser-side view of the exact same
 *  predicate the server runs. The server is authoritative; this copy exists so
 *  the settings form can give instant feedback before a round trip.
 *
 *  The rule and the real East_Asian_Width table live in `@4am/shared`, so the
 *  two sides can never drift. Re-exported here so existing imports keep
 *  working. */
export {
  DISPLAY_NAME_MAX_WIDTH,
  displayNameError,
  displayNameWidth,
} from '@4am/shared';
