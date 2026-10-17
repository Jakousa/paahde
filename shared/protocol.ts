// WebSocket message shapes (JSON). `t` is the message type.
import type { PlayerState } from './sim.ts';
import type { Slots } from './items.ts';
import type { Storm } from './storm.ts';

export type ClientMsg =
  // First message after connecting. browserId is a random UUID kept in localStorage.
  // spawn: 'base' starts at the home base's door instead of the saved position, 'crash' next to the nearest
  // crash site (dev helpers, ?spawn=base / ?spawn=crash).
  | { t: 'hello'; browserId: string; spawn?: 'base' | 'crash' }
  // One per fixed tick: input bitmask + quantized camera yaw and pitch (shared/dig.ts quantizePitch),
  // with an increasing sequence number.
  | { t: 'input'; seq: number; input: number; yaw: number; pitch: number }
  // Pick up scrap piece i of cell (ix, iz) (shared/scrap.ts). Sent after the input it was aimed with.
  | { t: 'pickup'; ix: number; iz: number; i: number }
  // Plant or harvest greenhouse bed i (shared/garden.ts BEDS).
  | { t: 'tend'; bed: number }
  // Debug menu: move the shared day/night clock by changing the wall-clock epoch.
  // epoch null = back to the real clock.
  | { t: 'setEpoch'; epoch: number | null }
  // Survival (shared/water.ts): one sip from the canteen finished (sent when the ~1.2 s drink completes).
  // The server checks sips > 0, the drink cooldown and that you are not mid-respawn, then answers 'water'.
  | { t: 'drink' }
  // Refill the canteen at the base (sent when the ~1.5 s fill completes). The server checks you are in
  // the base (inBase with FILL_SLACK) and answers 'water'.
  | { t: 'fill' }
  // What's in your hands (Hands below), sent when it changes and after every 'welcome'. Cosmetic: other
  // players see it on your avatar; the drink/fill checks don't depend on it.
  | { t: 'hands'; hands: Hands }
  // Debug menu: a sandstorm right here (shared/storm.ts), after the usual warning.
  | { t: 'storm' }
  // Inventory (shared/items.ts, shared/storage.ts): move n (default all) of the stack in box `from` slot fi
  // to box `to` slot ti (ti -1: anywhere in it). Boxes: 'bag', 'bike', 'chest<i>'. The server checks
  // you can open both, applies moveItem() and answers with 'items' for each box that changed.
  | { t: 'move'; from: string; fi: number; to: string; ti: number; n?: number }
  // Tidy a box (sortItems; the bag's hotbar stays put).
  | { t: 'sort'; box: string }
  // Crash-site machines (shared/crash.ts). Carry a small one home: the server checks reach and that it is still
  // there, puts it in your bag as an item (of the component's kind) and answers 'items'.
  | { t: 'crashTake'; id: string }
  // Put a carried machine (item kind) on the workbench to take it apart: uses one up from the bag (checked
  // against the bench's reach) and answers 'items'.
  | { t: 'crashUse'; kind: string }
  // Large crash sites are worked on together. Join/leave the site's session; hold a lifting eye (it needs
  // `players` of you holding at once, re-sent about once a second while held); report a step done (a lift is
  // checked against the holders) or a part taken (first one wins). Step and part numbers are indexes into the
  // machine the site's seed builds (src/teardown/junk.ts), the same on every client.
  | { t: 'siteJoin'; id: string }
  | { t: 'siteLeave'; id: string }
  | { t: 'siteHold'; id: string; i: number; players: number; on: boolean }
  | { t: 'siteDone'; id: string; i: number }
  | { t: 'siteTake'; id: string; i: number };

// 0 empty hands, 1 holding the canteen, 2 drinking from it.
export type Hands = 0 | 1 | 2;

// pitch: the player's quantized camera pitch (pitchFromQ in shared/dig.ts), so remote avatars can
// tilt their heads.
// hands: what they're holding (Hands), omitted when empty.
export type PlayerSnap = PlayerState & { id: number; color: number; pitch: number; hands?: Hands };

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
  // The contents of an item box (shared/storage.ts BoxId): your 'bag' and 'bike' after 'welcome' and when
  // they change, every 'chest<i>' on join and to everyone when it changes. `got`: a scrap pickup added
  // this kind (for the HUD toast).
  | { t: 'items'; box: string; slots: Slots; got?: string }
  // Small crash sites whose machine has been carried off (ids), or are back. On join, before 'welcome', with reset:
  // the full taken list.
  | { t: 'crash'; taken: string[]; back: string[]; reset?: boolean }
  // A shared session was joined: what is already done (step indexes) and taken (part indexes) at that site.
  | { t: 'siteState'; id: string; done: number[]; taken: number[] }
  // How many players hold lifting eye i right now.
  | { t: 'siteHolders'; id: string; i: number; n: number }
  | { t: 'siteDone'; id: string; i: number }
  // Part i went to player `by` (the public id). Whoever is carrying it and isn't `by` has lost it.
  | { t: 'siteTake'; id: string; i: number; by: number }
  // Growth stage of every greenhouse bed (shared/garden.ts), on join and whenever one changes.
  | { t: 'garden'; beds: number[] }
  // A bed this player tended was planted or harvested, for the HUD toast.
  | { t: 'tended'; what: 'planted' | 'harvested' }
  // The shared clock's epoch changed (debug menu), or a setEpoch was refused and this is the real one.
  | { t: 'epoch'; epoch: number }
  // Your heat meter (0..HEAT_MAX, rounded to 0.01; full = heatstroke), canteen sips left (0..CANTEEN_SIPS),
  // whether heat is building up right now, the felt temperature (°C, 0.1; shared/temperature.ts) and
  // whether you're out of direct sun (shade, night or the base; shared/shade.ts). Sent after 'welcome',
  // after every drink/fill (also refused ones, so the client resyncs), when heat starts or stops building
  // or shade flips, when temp moves by 0.5 °C, and about twice a second while the meter moves.
  | { t: 'water'; heat: number; sips: number; rising: boolean; temp: number; shade: boolean }
  // You died of heatstroke: the server has already moved you to BASE_SPAWN (the next snapshot snaps you
  // there) with no heat and a full canteen; a 'water' follows. For the death screen.
  | { t: 'died'; cause: 'heat' }
  // Every sandstorm announced and not yet over (shared/storm.ts; times on the server clock, like snap.time).
  // Sent before 'welcome' on join and to everyone whenever the list changes.
  | { t: 'storms'; storms: Storm[] };
