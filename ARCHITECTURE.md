# VEIL — Architecture blueprint

## Rules: the offline-first vertical slice
Each player starts with a five-card hand. On their turn they select one or more cards, make a rank claim, and play them face-down. The next player either accepts the claim or calls **Bluff**. A true claim penalizes the challenger; a false claim penalizes the player who made it. Penalties add cards from a server-owned deck. The first player with no cards wins. Specials are modeled as cards with explicit resolution effects (Spy, Swap, Shield, Reverse, Wild, Truth, Double Down).

## Folder structure
```
src/
  engine/       pure types, deck and transition functions — no React imports
  components/   presentational table, player and card components (next phase)
  App.tsx       application composition and local/offline controller
  styles.css    responsive visual system
```

## State model
`GameState` holds public turn state, deck count, players, last claim and phase. `Player` has `hand` only in the authoritative/local state. `publicPlayerView` is the shape that online clients will receive; it never contains opponents' cards. Game transitions are pure engine functions (`play`, `challenge`, `accept`).

## Networking plan
The future Node/Socket.IO host owns one `GameState` per room. Clients send intent events (`game:play`, `game:challenge`, `game:accept`) with an action ID. The server validates actor, turn, card ownership and phase, runs engine transitions, then broadcasts per-player filtered snapshots. Reconnect tokens rejoin the same seat and receive a private snapshot. Randomness, penalties, score updates and timers stay server-side.

## Database plan
PostgreSQL: `users(id, username, avatar_url, xp, created_at)`, `player_stats(user_id, games, wins, losses, bluff_successes, challenge_successes, streak)`, `game_rooms(id, code, host_id, status, config, created_at)`, `game_participants(id, room_id, user_id, seat, joined_at, outcome)`, `game_events(id, room_id, sequence, type, payload, created_at)`. Store only public/auditable event data; active hands live in the room process or Redis.
