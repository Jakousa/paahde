// WebSocket message shapes (JSON). `t` is the message type.
import type { PlayerState } from './sim.ts';
import type { Slots } from './items.ts';
import type { Loot } from './loot.ts';
import type { Storm } from './storm.ts';
import type { Placed } from './placed.ts';
import type { BedState } from './garden.ts';

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
  // Plant or harvest the plant bed with this placed id (shared/garden.ts, shared/placed.ts).
  | { t: 'tend'; bed: number }
  // Put down the placeable item in bag slot `slot` (shared/placed.ts) at floor point (x, z) with turn rot
  // (0/1). The server checks the item, reach and placeError(), then answers 'items' (bag) and broadcasts
  // 'placed'; a refusal gets a 'notice'.
  | { t: 'place'; slot: number; x: number; z: number; rot: number }
  // Pick a placed thing back up into the bag (reach, room in the bag). A bed's crop is lost.
  | { t: 'unplace'; id: number }
  // Craft a recipe at the workbench (shared/crafting.ts RECIPES id): reach checked, ingredients used up from
  // the bag, answered with 'items' (got: what was made) or a 'notice'.
  | { t: 'craft'; recipe: string }
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
  // slot: the selected hotbar slot (-1 none); the server digs with what's in it (a repaired shovel digs
  // faster, shared/gear.ts digTool).
  | { t: 'hands'; hands: Hands; slot?: number }
  // Debug menu: a sandstorm right here (shared/storm.ts), after the usual warning.
  | { t: 'storm' }
  // Inventory (shared/items.ts, shared/storage.ts): move n (default all) of the stack in box `from` slot fi
  // to box `to` slot ti (ti -1: anywhere in it). Boxes: 'bag', 'bike', 'chest<i>'. The server checks
  // you can open both, applies moveItem() and answers with 'items' for each box that changed.
  // `r`: lay it down turned 90° (shared/items.ts Item.r); left out, as it lies.
  | { t: 'move'; from: string; fi: number; to: string; ti: number; n?: number; r?: boolean }
  // Tidy a box (sortItems; the bag's hotbar stays put).
  | { t: 'sort'; box: string }
  // Repairs at the workbench (shared/gear.ts fitPart / unfitPart): fit the part at box `from` slot fi into
  // part slot `slot` of the item on the bench (what was there comes out), or take one out into box `to`
  // slot ti (-1: anywhere). Answered with 'items' for each box involved.
  | { t: 'fit'; from: string; fi: number; slot: number }
  | { t: 'unfit'; slot: number; to: string; ti: number }
  // Drop one of the item in box `box` slot `slot` (not 'equip' or 'bench') on the sand in front of you: it becomes
  // loot (src 'drop') anyone can pick up. Answered with 'items' for the box (and a 'notice' if refused, e.g. in the base).
  | { t: 'drop'; box: string; slot: number }
  // Pick up loot (shared/loot.ts) in reach. Answered with 'items' (or a 'notice' when the bag is full).
  | { t: 'lootTake'; id: number }
  // Debug menu: repaired gear of every kind, Common parts (for testing).
  | { t: 'debugGear' }
  // Crash-site machines (shared/crash.ts). Carry a small one home: the server checks reach and that it is still
  // there, puts it in your bag as an item (of the component's kind) and answers 'items'.
  | { t: 'crashTake'; id: string }
  // Put a carried machine (item kind) on the disassembly table to take it apart: if the table is free, uses one
  // up from the bag (checked against the table's reach), picks the machine's seed and tells everyone ('bench');
  // answers 'items' either way.
  | { t: 'crashUse'; kind: string }
  // Large crash sites, and the table (id 'bench'), are worked on together. Join/leave the session; hold a lifting
  // eye (it needs `players` of you holding at once, re-sent about once a second while held); report a step done (a
  // lift is checked against the holders) or take a part (first one wins: its item goes in your bag, answered with
  // 'siteTook' and 'items'). Step numbers are indexes into the machine the seed builds (src/teardown/junk.ts),
  // part numbers into machineParts() (shared/machine.ts), the same on every client and the server.
  | { t: 'siteJoin'; id: string }
  | { t: 'siteLeave'; id: string }
  | { t: 'siteHold'; id: string; i: number; players: number; on: boolean }
  | { t: 'siteDone'; id: string; i: number }
  | { t: 'siteTake'; id: string; i: number };

/** The job on the disassembly table: which carried machine, its seed (picked by the server), progress so far. */
export type BenchJob = { kind: string; seed: number; done: number[]; taken: number[] };

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
  // they change, every 'chest<i>' on join and to everyone when it changes. `got`: a pickup (scrap, a
  // carried machine, a part out of a machine) added this kind (for the HUD toast).
  | { t: 'items'; box: string; slots: Slots; got?: string }
  // Loot in the world (shared/loot.ts): added or changed (a cache dug up), and removed (ids). On join, before
  // 'welcome', with reset: everything there is.
  | { t: 'loot'; add: Loot[]; remove: number[]; reset?: boolean }
  // Small crash sites whose machine has been carried off (ids), or are back. On join, before 'welcome', with reset:
  // the full taken list.
  | { t: 'crash'; taken: string[]; back: string[]; reset?: boolean }
  // Crash sites (shared/crashsites.ts ids) whose large machine has been stripped: they stop smoking and stay that
  // way. On join (with reset: the full list), then each newly spent one.
  | { t: 'crashSpent'; spent: number[]; reset?: boolean }
  // A shared session was joined: what is already done (step indexes) and taken (part indexes) at that site.
  | { t: 'siteState'; id: string; done: number[]; taken: number[] }
  // On join, before 'welcome': the progress of every large site's machine that has been worked on. Kept for
  // good (server/crash.ts machine_progress); siteDone / siteTake keep it up to date, for everyone.
  | { t: 'sites'; sites: { id: string; done: number[]; taken: number[] }[] }
  // A site's machine is whole again (dev reset): forget its progress.
  | { t: 'siteReset'; id: string }
  // The machine on the base's disassembly table (null: the table is free). On join, and to everyone when a job
  // starts or its last part is taken. Its steps and takes come as siteDone / siteTake with id 'bench'.
  | { t: 'bench'; job: BenchJob | null }
  // Your siteTake was answered: ok, the part's item (`kind`, shared/items.ts) is in your bag ('items' follows);
  // or refused because your bag is full (the part stays on the machine). Lost races get siteTake instead.
  | { t: 'siteTook'; id: string; i: number; ok: boolean; reason?: 'full'; kind?: string }
  // How many players hold lifting eye i right now (to the session's players only).
  | { t: 'siteHolders'; id: string; i: number; n: number }
  | { t: 'siteDone'; id: string; i: number }
  // Step i is done, part i went to player `by` (the public id; -1 if from before a restart). Sent to everyone.
  // Whoever is carrying the part and isn't `by` has lost it.
  | { t: 'siteTake'; id: string; i: number; by: number }
  // Every placed thing in the base (shared/placed.ts), on join (before 'welcome') and whenever it changes
  // (before the snapshot, like terrainEdit, so prediction collides with it from the same tick on).
  | { t: 'placed'; list: Placed[] }
  // Every plant bed's stage and growth (shared/garden.ts), on join and whenever one changes.
  | { t: 'garden'; beds: BedState[] }
  // A short message for this player's HUD toast (a refused place, pickup or craft).
  | { t: 'notice'; text: string }
  // A bed this player tended was planted or harvested, for the HUD toast.
  | { t: 'tended'; what: 'planted' | 'harvested' }
  // The shared clock's epoch changed (debug menu), or a setEpoch was refused and this is the real one.
  | { t: 'epoch'; epoch: number }
  // Your heat meter (0..HEAT_MAX, rounded to 0.01; full = heatstroke), canteen sips left (0..CANTEEN_SIPS),
  // whether heat is building up right now, the felt temperature (°C, 0.1; shared/temperature.ts) and
  // whether you're out of direct sun (shade, night or the base; shared/shade.ts). Sent after 'welcome',
  // after every drink/fill (also refused ones, so the client resyncs), when heat starts or stops building
  // or shade flips, when temp moves by 0.5 °C, and about twice a second while the meter moves.
  // maxSips: what the water bottle in your bag holds (shared/gear.ts bottleSips), 0 without one.
  | { t: 'water'; heat: number; sips: number; maxSips: number; rising: boolean; temp: number; shade: boolean }
  // You died of heatstroke: the server has already moved you to BASE_SPAWN (the next snapshot snaps you
  // there) with no heat and a full canteen; a 'water' follows. For the death screen.
  | { t: 'died'; cause: 'heat' }
  // Every sandstorm announced and not yet over (shared/storm.ts; times on the server clock, like snap.time).
  // Sent before 'welcome' on join and to everyone whenever the list changes.
  | { t: 'storms'; storms: Storm[] };
