// WebSocket message shapes (JSON). `t` is the message type.
import type { PlayerState } from './sim.ts';

export type ClientMsg =
  // First message after connecting. browserId is a random UUID kept in localStorage.
  // spawn: 'base' starts at the home base's door instead of the saved position (dev helper, ?spawn=base).
  | { t: 'hello'; browserId: string; spawn?: 'base' }
  // One per fixed tick: input bitmask + quantized camera yaw and pitch (shared/dig.ts quantizePitch),
  // with an increasing sequence number.
  | { t: 'input'; seq: number; input: number; yaw: number; pitch: number }
  // Pick up scrap piece i of cell (ix, iz) (shared/scrap.ts). Sent after the input it was aimed with.
  | { t: 'pickup'; ix: number; iz: number; i: number }
  // Plant or harvest greenhouse bed i (shared/garden.ts BEDS).
  | { t: 'tend'; bed: number }
  // Debug menu: move the shared day/night clock by changing the wall-clock epoch. Ignored in production.
  // epoch null = back to the real clock.
  | { t: 'setEpoch'; epoch: number | null }
  // Survival (shared/water.ts): one sip from the canteen finished (sent when the ~1.2 s drink completes).
  // The server checks sips > 0, the drink cooldown and that you are not mid-respawn, then answers 'water'.
  | { t: 'drink' }
  // Refill the canteen at the base (sent when the ~1.5 s fill completes). The server checks you are in
  // the base (insideBase with FILL_SLACK) and answers 'water'.
  | { t: 'fill' };

// pitch: the player's quantized camera pitch (pitchFromQ in shared/dig.ts), so remote avatars can
// tilt their heads.
export type PlayerSnap = PlayerState & { id: number; color: number; pitch: number };

export type ServerMsg =
  // First message on every connection: the build the server is serving (dist/version.txt, 'dev' if
  // none). A client built from another SHA reloads the page to pick up the new build.
  | { t: 'version'; build: string }
  // id is a public per-connection id; the browserId is never sent to other players.
  // epoch = wall-clock ms (Unix) at server time 0, so the time of day survives server restarts.
  | { t: 'welcome'; id: number; state: PlayerState; color: number; epoch: number }
  // ack = last input seq the server applied for *this* client; time = server clock in ms.
  // Sent right after the tick's terrainEdit, so terrain changes up to `ack` have already arrived.
  | { t: 'snap'; time: number; ack: number; players: PlayerSnap[] }
  // Terrain edit layer (shared/terrain.ts): absolute millimetre offsets. Sent as whole chunks on join
  // (in batches before 'welcome': the first batch has reset, the last has done; chunks the client holds
  // that the server didn't send are dropped at done) and as changed vertices [ix, iz, mm, ...] after digs.
  | { t: 'terrainChunks'; chunks: { cx: number; cz: number; mm: number[] }[]; reset?: boolean; done?: boolean }
  | { t: 'terrainEdit'; cells: number[] }
  // Another player dug (pile = false) or piled sand at (x, y, z): for particle effects only.
  | { t: 'dug'; id: number; x: number; y: number; z: number; pile: boolean }
  // Scrap pieces picked up (taken) or respawned (back), as flat [ix, iz, i, ...] triples. On join, before
  // 'welcome', with reset: the full taken list, replacing whatever the client had. Sent before the
  // snapshot, like terrainEdit. A rejected pickup gets its piece back in a message to that player only.
  | { t: 'scrap'; taken: number[]; back: number[]; reset?: boolean }
  // The player's inventory: count per SCRAP_KINDS index. Sent after 'welcome' and on every change.
  | { t: 'inventory'; items: number[] }
  // Growth stage of every greenhouse bed (shared/garden.ts), on join and whenever one changes.
  | { t: 'garden'; beds: number[] }
  // A bed this player tended was planted or harvested, for the HUD toast.
  | { t: 'tended'; what: 'planted' | 'harvested' }
  // The shared clock's epoch changed (debug menu), or a setEpoch was refused and this is the real one.
  | { t: 'epoch'; epoch: number }
  // Your thirst bar (0..WATER_MAX, rounded to 0.01), canteen sips left (0..CANTEEN_SIPS) and whether the
  // sun is draining you right now. Sent after 'welcome', after every drink/fill (also refused ones, so the
  // client resyncs), when heat starts or stops, and about twice a second while draining.
  | { t: 'water'; water: number; sips: number; heat: boolean }
  // You died of thirst: the server has already moved you to BASE_SPAWN (the next snapshot snaps you
  // there) with full water and a full canteen; a 'water' follows. For the death screen.
  | { t: 'died'; cause: 'thirst' };
