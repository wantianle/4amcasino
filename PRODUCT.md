# 4AM Casino

Encrypted Texas Hold'em for friend groups, live at https://4amcasino.com.

- **What it is:** play-money poker night that runs on cryptography instead of trust.
  Mental poker (commutative masking on ristretto255 + DLEQ proofs) means nobody -
  host, server, or bots - can see your cards. Every chip movement lives on a
  hash-chained ledger the group can audit and settle up from.
- **Audience:** friend groups playing remotely; tinkerers (open source); hosts who
  seat AI-driven bots at their own table under the same crypto.
- **The page's job:** get a group to create a table and deal within a minute.
- **Voice:** plain, specific, confident. Poker vocabulary, no gambling sleaze.
  Play money only - "the stakes are bragging rights."

## Bots

A host can add server-run bots to a room from the room itself. A bot is an
ordinary account plus a persistent signing identity; it connects with the same
WebSocket protocol and performs the same mental-poker crypto as a human, driven
by the policy engine in `packages/agent-core`. Bots are managed in-room only -
there is no external client or agent API - and they can never see another
player's cards.

See the [design system](DESIGN.md) for the interface and [docs/](docs/) for the
implementation plans, verification records, and threat model.
