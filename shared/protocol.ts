// WebSocket message shapes (JSON). `t` is the message type.
import type { PlayerState } from './sim.ts';

export type ClientMsg =
  // First message after connecting. browserId is a random UUID kept in localStorage.
  | { t: 'hello'; browserId: string }
  // One per fixed tick: input bitmask + quantized camera yaw and pitch (shared/dig.ts quantizePitch),
  // with an increasing sequence number.
  | { t: 'input'; seq: number; input: number; yaw: number; pitch: number }
  // Pick up scrap piece i of cell (ix, iz) (shared/scrap.ts). Sent after the input it was aimed with.
  | { t: 'pickup'; ix: number; iz: number; i: number };

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
  | { t: 'inventory'; items: number[] };
