// WebSocket message shapes (JSON). `t` is the message type.
import type { PlayerState } from './sim.ts';
import type { Slots } from './items.ts';
import type { Loot } from './loot.ts';
import type { Corpse } from './corpse.ts';
import type { MissilePath } from './missiles.ts';
import type { Storm } from './storm.ts';
import type { Jet } from './jets.ts';
import type { TossPath } from './throw.ts';
import type { Placed } from './placed.ts';
import type { BedState } from './garden.ts';

export type ClientMsg =
  // First message after connecting. browserId is a random UUID kept in localStorage.
  // spawn: 'base' starts at the home base's door instead of the saved position, 'crash' next to the nearest
  // crash site with a large machine, 'field' at the edge of the nearest scrap field, 'shelter' outside the nearest
  // shelter's door (dev helpers, ?spawn=base / ?spawn=crash / ?spawn=field / ?spawn=shelter).
  | { t: 'hello'; browserId: string; spawn?: 'base' | 'crash' | 'field' | 'shelter' }
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
  // aim: a gun (or the jammer) in hand is raised to aim; others see it shouldered along the pitch.
  | { t: 'hands'; hands: Hands; slot?: number; aim?: boolean }
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
  // Debug menu: bring the nearest guardian 90 m from you, a searchlight drone over you for a minute (by day too), or
  // a fixed-wing drone past you in about 15 s.
  | { t: 'summon'; what: 'guardian' | 'drone' | 'jet' }
  // A laser rifle or pistol shot (shared/rifle.ts) from (x, y, z) to where it stopped, (ex, ey, ez). `g`/`i`: the client
  // found it hit weak point i of walker g (i -1: just its body, which angers it); `d`: it hit drone d; `j`: fixed-wing
  // drone j (shared/jets.ts). The server checks
  // the gun is in hand, its reach, the rate and that the shot was aimed at that walker, breaks the point, and shows the
  // shot to everyone near ('zap').
  // Holding the jammer (shared/jammer.ts) on jet or drone `id` from the eye (x, y, z) along (dx, dy, dz), about every
  // JAM_SEND_MS while the use button is down; the server adds up the lock and brings the target down at JAM_MS.
  | { t: 'jam'; kind: 'jet' | 'drone'; id: number; x: number; y: number; z: number; dx: number; dy: number; dz: number }
  // A guardian's foot (client IK) came down on you (shared/guardians.ts FOOT_CRUSH_R); the server checks guardian `g`
  // is alive and near enough, and kills you ('died', cause 'guardian').
  | { t: 'stomped'; g: number }
  | { t: 'fire'; x: number; y: number; z: number; ex: number; ey: number; ez: number; g?: number; i?: number; d?: number; j?: number }
  // Throw the scrap item in hotbar slot `slot` (shared/throw.ts) from the eye (x, y, z) along unit (dx, dy, dz). `n`:
  // the client's count of its throws, echoed in the 'toss' so it can tie its own flying junk to the server's.
  | { t: 'throw'; slot: number; n: number; x: number; y: number; z: number; dx: number; dy: number; dz: number }
  // Debug menu: repaired gear of every kind, Scrap parts (for testing).
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
  | { t: 'siteTake'; id: string; i: number }
  // A chat line (Enter, src/chat.ts). The server trims it to CHAT_MAX, drops empty ones and rate-limits, then sends
  // it to everyone as 'chat'.
  | { t: 'chat'; text: string };

/** Longest chat line (characters). */
export const CHAT_MAX = 160;

/** The job on the disassembly table: which carried machine, its seed (picked by the server), progress so far. */
export type BenchJob = { kind: string; seed: number; done: number[]; taken: number[] };

// 0 empty hands, 1 holding the canteen, 2 drinking from it, 3 filling it at the pump.
export type Hands = 0 | 1 | 2 | 3;

// pitch: the player's quantized camera pitch (pitchFromQ in shared/dig.ts), so remote avatars can
// tilt their heads.
// hands: what they're holding (Hands), omitted when empty.
// item: the kind of the item in their selected hotbar slot (drawn in their hand), omitted when empty.
// aim: their gun (or jammer) is raised to aim (the 'hands' message), omitted when not.
// gear: the gear they wear (shared/gear.ts wornGear bits), omitted when none.
// down: dead, lying as a ragdoll until the respawn (shared/ragdoll.ts); the push (m/s) that threw the body, [0, 0, 0] if none.
export type PlayerSnap = PlayerState & { id: number; color: number; pitch: number; hands?: Hands; aim?: 1; item?: string; gear?: number; down?: [number, number, number] };

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
  // Packs left where players died (shared/corpse.ts): new ones, and ones emptied or gone (ids), to everyone. On join,
  // with reset: all of them, each one's contents following as 'items' (box 'corpse<id>').
  | { t: 'corpses'; add: Corpse[]; remove: number[]; reset?: boolean }
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
  // You died: you lie where you fell as a ragdoll for DOWN_MS (shared/ragdoll.ts; your input is ignored), then
  // 'respawn' says the server has moved you to BUNKER_SPAWN (the next snapshot snaps you there) with no heat and a
  // full canteen; a 'water' follows. For the death screen. push: the blast's launch velocity for the body (m/s).
  // 'heat': heatstroke; 'guardian': one walked over you; 'laser': a guardian's cannon got you; 'missile': one called
  // down by a drone's searchlight landed on you (shared/missiles.ts); 'crawler': bitten once too often.
  | { t: 'died'; cause: DeathCause; push?: [number, number, number] }
  | { t: 'respawn' }
  // Every sandstorm announced and not yet over (shared/storm.ts; times on the server clock, like snap.time).
  // Sent before 'welcome' on join and to everyone whenever the list changes.
  | { t: 'storms'; storms: Storm[] }
  // Every fixed-wing drone flight in the air (shared/jets.ts; times on the server clock). Like 'storms': before
  // 'welcome' on join and to everyone whenever the list changes.
  | { t: 'jets'; jets: Jet[] }
  // Guardians and night drones (shared/guardians.ts) within reach, about 10 times a second, at server time `time`.
  // g: [id, kind, legs, x, z, yaw, hunt, ax, ay, az, gun, broken, dead] per walker (kind: shared/guardians.ts KINDS
  // index; (ax, ay, az) where its cannon aims; gun -1 idle, 0 aiming, 1 charging; broken: bit i set once weak point i
  // is shot (shared/rifle.ts); dead: 0 alive, else seconds since it died + 0.01);
  // d: [id, x, y, z, yaw, dx, dy, dz, lock, hurt, down, jammed] per drone ((dx, dy, dz) the searchlight's unit direction;
  // hurt: rifle hits taken (shared/rifle.ts DRONE_HP); down: 0 flying, else seconds since it was shot down + 0.01;
  // jammed: 1 brought down by a jammer (shared/jammer.ts), sinking gently instead of falling).
  // hunt / lock: 0 nobody, 1 someone else, 2 you.
  // f: [id, leg, x, y, z, left] per foot of each living guardian (shared/guardians.ts F_STRIDE): where the server has
  // planted it (y its sole), or is swinging it to with `left` s to go (0 planted). Planted feet block players.
  | { t: 'bots'; time: number; g: number[]; d: number[]; f?: number[] }
  // Guardian `g` fired laser bolt `id` from (x, y, z) along unit (dx, dy, dz) at server time `time`; it flies at
  // BOLT_SPEED (shared/guardians.ts) until it bursts ('boom': on the ground, a player, or out of range).
  | { t: 'shot'; id: number; g: number; time: number; x: number; y: number; z: number; dx: number; dy: number; dz: number }
  | { t: 'boom'; id: number; x: number; y: number; z: number; ground: boolean }
  // Guardian `g` launched missile `id` at server time `time` on the arc from (x0, y0, z0) to the impact (x1, y1, z1),
  // landing `flight` seconds later (shared/missiles.ts missileAt); 'blast' when it does. Sent to everyone near the
  // impact.
  | ({ t: 'missile'; id: number; g: number; time: number } & MissilePath)
  | { t: 'blast'; id: number; x: number; y: number; z: number }
  // Player `by` fired a laser rifle (or the pistol: `pistol`) from (x, y, z) to (ex, ey, ez); `hit`: it broke a weak point there.
  // Player `id` (public id; `color` their avatar's) said `text` in chat, to everyone (also back to the sender).
  | { t: 'chat'; id: number; color: number; text: string }
  | { t: 'zap'; by: number; x: number; y: number; z: number; ex: number; ey: number; ez: number; hit: boolean; pistol?: true }
  // Thrown scrap `id` (shared/throw.ts tossAt), item `kind`, thrown by player `by` (their throw `n`), flying from
  // (x, y, z) with velocity (vx, vy, vz) at server time `time`; sent again with `hit` as it bounces off a drone, and
  // 'tossEnd' where it lands (it becomes loot there) or is lost.
  | ({ t: 'toss'; id: number; by: number; n: number; kind: string; hit?: true } & TossPath)
  | { t: 'tossEnd'; id: number; x: number; y: number; z: number };

export type DeathCause = 'heat' | 'guardian' | 'laser' | 'missile' | 'crawler';
