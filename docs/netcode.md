# Multiplayer architecture

How the game keeps players in sync, why it is built this way, and what to keep in mind when changing it.
Researched October 2026; the frameworks and transport notes are as of then.

## Model: authoritative server + client prediction + interpolation

This is the standard for real-time action games (Valve's Source engine, Gabriel Gambetta's
[client-server game architecture](https://www.gabrielgambetta.com/client-server-game-architecture.html)).

1. **Clients send inputs, never positions.** Each fixed tick (60 Hz) the client sends
   `{seq, input}` where `input` is a bitmask of held keys (move, jump, slide, bike…). The server runs the simulation; it is
   the only source of truth, so clients can't teleport or fly.
2. **Client-side prediction.** The client runs the *same* `shared/sim.ts` step on its own input
   immediately, so you move with zero perceived latency.
3. **Reconciliation.** Snapshots tell each client the last input `seq` the server consumed or discarded (`ack`).
   The client takes the server's state for itself, drops acknowledged inputs and replays the rest.
   Any remaining difference is shown as a visual offset that decays over ~100 ms instead of a jump.
4. **Entity interpolation.** Other players are drawn 100 ms in the past, between the two snapshots
   around that time. Snapshots come at 20 Hz, so there are always two to blend between.

```
client                         server
  tick: input → step() ──seq,input──▶ bounded queue → fixed 60 Hz step()
  pending inputs [seq…]               every 50 ms: snapshot {time, ack, state, players[]}
  snapshot ◀───────────────────────── 
  state = server state + replay(pending after ack)
  remote players = lerp(snapshots, now − 100 ms)
```

### Why not the alternatives

| Approach | Verdict |
|---|---|
| Lockstep (everyone waits for all inputs each tick) | Needs a bit-exact deterministic sim; one slow player stalls everyone; bad with drop-in/drop-out. |
| Rollback (GGPO) | Great for 2–4 player fighting games. Complex with many players joining and leaving. |
| CRDT / document sync (Yjs, Automerge) | Built for collaborative editing, not 60 Hz physics. |
| Clients send positions | Trivial to cheat and players fight over the truth. |

## Transport: WebSocket

- **WebSocket over TLS through Caddy** — works everywhere, no extra ports, proxied with the rest of herkku.org.
- **WebTransport** (QUIC/UDP, no head-of-line blocking) is now in all major browsers (Safari 26.4,
  March 2026), but Caddy only gained experimental WebTransport proxying in 2.12, which hasn't shipped yet.
  Revisit later; the protocol here is transport-agnostic.
- **WebRTC data channels** (geckos.io) would need UDP ports and ICE/STUN next to Docker. Not worth it for a jam.
- Head-of-line blocking over TCP only hurts under packet loss; the 100 ms interpolation buffer
  absorbs most of it at our scale.

## Frameworks considered

We use a small hand-written server (`server/index.ts` in front, one `server/world.ts` process per world) because the model above is simple
at our scale and the whole team can read and change it. Alternatives, if needs grow:

- **[Colyseus](https://colyseus.io) 0.18** (MIT): rooms, matchmaking, binary delta-compressed state
  and, since 0.18, built-in prediction helpers. The natural upgrade if we need rooms/lobbies.
- **SpacetimeDB 2.x**: database and server in one, with TypeScript modules. BSL licence and a different
  programming model; no prediction layer.
- **Nakama**: a full game backend (Go + Postgres). Too heavy for a 4 GB VPS.
- **PartyKit/PartyServer**: tied to Cloudflare Durable Objects.
- Hosted: **Playroom**, **Rune** (mobile only). **Hathora** shut down in May 2026.

## Persistence: SQLite

- `node:sqlite` (built into Node 24; no native dependencies), WAL mode. Each world has its own file,
  `data/worlds/<id>.db` (the front server keeps `data/dadajam.db`), on a Docker volume in production.
- Players (browser ID, colour, position, survival state), items, terrain edits, crash sites, loot and the rest
  are saved on join and leave, every 5 s, and on shutdown.
- Calls are synchronous: keep queries tiny and out of hot loops.

## Identity

- `localStorage['dadajam.browserId']` is a random UUID. It works like a password: whoever has it *is*
  that player. It is only ever sent to the server; other players see a per-connection numeric `id`.
- No accounts. Clearing site data means a new player.

## Robustness

- **Deploys restart the server.** On SIGTERM it saves everyone and closes sockets with code 1012.
  Clients reconnect with exponential backoff plus jitter and resume from the saved position.
- **Heartbeat.** The server pings every 25 s and drops dead sockets.
- **Caddy reloads.** `stream_close_delay 5m` keeps WebSockets open when the host Caddy config reloads.
- **Server time.** Physics advances at 60 Hz regardless of incoming packet rate. Each step consumes at most one
  queued input; the queue holds 12 (200 ms), and older overflow is acknowledged as discarded. A late server callback
  catches up at most six steps. Extra packets cannot speed movement or slow gravity.
- **Hidden tabs and stalls.** The server holds the last controls for up to 250 ms, then uses no keys while
  physics keeps running. The client keeps at most 120 pending inputs; after a longer acknowledgment stall it stops
  prediction and waits for an authoritative state acknowledging its last sent input before resuming.
- Message size is capped at 1 KB, every action is validated at runtime, and browser IDs are format-checked.
- Loading players cannot perform gameplay actions; readiness is explicit and loading times out after three minutes.
- The hello/version exchange checks a schema version independently of the build SHA. Incompatible clients stop
  and offer an update instead of continuing against changed rules.

## Bandwidth and backpressure

The schema version is 2. Each `snap` contains a complete `state` for owner reconciliation and compact pose tuples
for ready players within 1200 m (plus the owner). Boolean pose flags are packed; remote positions/velocities round
to millimetres. Colour, look, held item and gear are sent as whole appearance patches only when they change or
re-enter range. Owner simulation fields retain the previous precision.

Terrain subscriptions cover a 1792 m window around a centre quantized to 256 m. Chunk-local vertex indices avoid
repeating world coordinates in deltas. Full chunks use run-length encoding when shorter; dense chunks stay plain.
Live updates and full chunk batches contain at most sixteen chunks per message. Initial and newly entered windows stream those batches, yield between batches, and wait above 64 KiB
of socket backlog. Each batch reads current absolute values, so live edits/healing can safely interleave. The first
baseline completes before `welcome`; entering a new window completes before the next snapshot. Distant chunks are
evicted and a return always sends current values, including healing missed while away.

Obsolete player/enemy snapshots are skipped above 64 KiB of backlog. Reliable changes remain ordered; above 1 MiB
the connection closes with 1013 and reconnects from a fresh baseline. The browser stops prediction at 120 pending
inputs and closes/reconnects if its outgoing socket exceeds 128 KiB. These bounds keep a slow connection from
turning into unlimited memory growth.

## Telemetry (stall tracing)

Clients trace the stalls they see (`src/telemetry.ts`) and send them in small batches, with a summary a minute; the
world adds its own (`server/telemetry.ts`). Each world owns `telemetry.<world>.jsonl` next to the databases
(`/opt/dadajam/data/` on the server), with one JSON line per event. Past 20 MiB it becomes `.1`; a bounded pending
queue prevents a slow disk from growing memory without limit. Independent files prevent worlds racing during rotation.
`at` is when it happened, `w` the world, `p`/`name` the player, `ms` how long.

| kind | from | means |
|---|---|---|
| `down` | client | no snapshots for `ms` though the server stamped them on time: the network, server → player; `n` arrived in the burst after |
| `up` | client | snapshots on time, but an input waited `ms` for its ack: the network, player → server |
| `server` | client | snapshots stamped `ms` apart: the world's loop was late |
| `frame` | client | one frame took `ms` (the browser's main thread was busy); snapshots queued behind it aren't counted as `down` |
| `reconnect` | client | offline `ms` after the socket closed with `code` |
| `summary` | client | the last minute: round trip `rtt50`/`rtt95`/`rttMax`, worst snapshot gap `gapMax`, worst frame `frameMax`, `fps` |
| `tick` | world | a tick came `ms` after the last (the event loop was blocked), with `players` on |
| `backlog` | world | `bytes` queued for a player that TCP can't send out (a stalled or slow link) |

**`node tools/telemetry.ts`** reads it over ssh (`--file data/telemetry.jsonl` for a local one), prints a digest
(incidents by cause, round trip and fps per player, the worst incidents) and opens an HTML report: a timeline per world
and player, round trip and fps per player minute, incidents and events you can filter and zoom (`--since 6h`,
`--world`, `--player`). Reports default to the past 24 hours and read at most 16 MiB from the newest log file tails
(`--max-mb 1–256` changes that cap); a warning says when data was omitted. `--world` selects filenames before
reading, and old shared logs are still supported. Local and SSH reports stream bounded reads.
`node tools/telemetry.ts tail` follows up to 64 recent world files. Local tail discovers newly active worlds, preserves
partial lines and UTF-8 characters, and recovers unread events across rotation. Remote tail follows files present at
startup. Stalls close together in one world make an
incident, and its verdict follows the reading below. Player ids are reused, so the tool groups by world and name.

Or by hand: `ssh <server> 'tail -F /opt/dadajam/data/telemetry.<world>.jsonl'`, or e.g. `jq -c 'select(.kind != "summary")'` on it. A `down`
and `up` at the same moment from one player is their link stalling both ways (Wi-Fi); `down` for everyone at once is
the server's side of the network; `tick` is the world itself. The stats line (Esc → Show stats) shows the round trip
and the last stall.

## Rules when changing gameplay

- **All movement or physics that affects position goes in `shared/sim.ts`**, which both sides run.
  Anything only the client simulates will rubber-band. Keep it deterministic: no `Math.random()`,
  `Date.now()` or frame-time `dt` inside `step`.
- Add new inputs as bits in the input bitmask (the server masks unknown bits: update `INPUT_MASK`
  in `shared/sim.ts`).
- Purely visual effects (particles, squash and stretch) stay client-side.
- New message types go in `shared/protocol.ts`.
- **Terrain edits** (craters, `shared/dig.ts`; players don't dig any more): the server stamps craters, runs the
  angle-of-repose sand relaxation at 30 Hz on recently changed vertices only, and broadcasts changed vertices as
  `terrainEdit` right before each snapshot. Edits are absolute integer millimetres, so they are idempotent. The wind's healing pass (every 5 s, every edited vertex creeps back towards 0) isn't sent vertex by
  vertex: the server says `terrainHeal` and each client runs the same deterministic `heal()` on its copy (edits
  flushed after it carry the post-heal absolute values, so the two can't drift). Joining clients get nearby edited chunks (`terrainChunks`) before `welcome`, then current chunks as they enter new areas; chunks persist in
  the `terrain_chunks` SQLite table (saved every 5 s and on shutdown).
- **Scrap pickups** (`shared/scrap.ts`, `server/scrap.ts`): the client sends `pickup` with the piece id
  and hides the piece (and its hitbox) at once. The server checks reach from its own view of the player,
  marks it taken, adds it to the player's inventory (SQLite `scrap_taken`, `inventory`) and broadcasts
  `scrap` before the snapshot; a refused pickup gets its piece back. Pieces respawn after 30 minutes.
- **Survival** (`shared/water.ts`, `server/water.ts`): water and canteen sips are server state outside the
  sim. The server drains them in its tick loop from the shared clock (`shared/sun.ts`) and sends `water`
  (~2 Hz while draining, and after every `drink`/`fill`). Drink/fill are requests sent when the client's
  animation finishes; the server validates and always answers with the real state. A thirst death moves
  the player on the server and sends `died`; the client snaps its next reconciliation instead of gliding.
- Player-vs-player collision isn't done: it would make predicted players interact with
  interpolated ones (other players appear 100 ms in the past), so keep any such interaction forgiving.

## Sources

- Gabriel Gambetta, *Fast-Paced Multiplayer*: https://www.gabrielgambetta.com/client-server-game-architecture.html
- Valve, *Source Multiplayer Networking*: https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- Glenn Fiedler, *Networked Physics*: https://gafferongames.com/post/networked_physics_2004/
- WebKit, Safari 26.4 features: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- Caddy WebTransport PR: https://github.com/caddyserver/caddy/pull/7669
- Colyseus 0.18: https://colyseus.io/blog/colyseus-018-is-here/
- Node `node:sqlite`: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
