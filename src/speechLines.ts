// When the player character says what (subtitles, src/speech.ts), as plain data; the words are shared/text.ts `speech`.
// Guidelines in docs/speech.md: first person, one short sentence, plain words, a little dry humour; a line nudges
// toward what to do (pick it up, get shade, find water), never names keys or numbers.
//
// A line answers an event (`on`) when its condition (`when`) holds at that moment. Lines sharing an `id` are
// variants of one remark (e.g. by day and by night, or the same thing met two ways): the first whose condition
// holds is said, and they share its memory. Without `again` a remark is said once ever on this browser; with it,
// at most once per `again` ms. `say` may list several wordings; one is picked at random.
import type { Loot } from '../shared/loot.ts';
import type { Vehicle } from '../shared/vehicles.ts';
import type { Item, Slots } from '../shared/items.ts';
import { isGear, repaired } from '../shared/gear.ts';
import { partOf } from '../shared/parts.ts';
import { RECEIVERS, RELICS } from '../shared/bosses.ts';
import { RELIC_DROPS } from '../shared/tables.ts';
import { COMPONENTS, SALVAGE } from '../shared/salvage.ts';
import { TEXT } from '../shared/text.ts';
import type { Aggro, Kill } from './guardians';

/** What a line can look at, sampled every frame by src/main.ts. */
export type SpeechState = {
  /** Sun above the horizon. */
  day: boolean;
  /** In the base or a shelter; in a shelter (one of the small bunkers out in the desert). */
  indoors: boolean;
  shelter: boolean;
  /** Close enough to a pump to fill a bottle. */
  atPump: boolean;
  /** At an electric well that isn't running (shared/wells.ts): its pump's parts not all in, or no power. */
  dryWell: 'parts' | 'power' | null;
  /** Out on a mud flat (shared/biomes.ts): hotter by day, no shade. */
  mudflat: boolean;
  /** Body heat (0..shared/water.ts HEAT_MAX), whether it's building up, and whether we stand in shade. */
  heat: number;
  rising: boolean;
  shade: boolean;
  /** Sips left in the best working water bottle in the bag, and how many it holds (0: no working bottle). */
  sips: number;
  maxSips: number;
  /** Sandstorm here (0..1), and the storm detector warning of one on its way. */
  storm: number;
  stormWarning: boolean;
  /** A mega-storm front about to hit us, out in the open; choking in one; sitting one out in the lee of rock. */
  frontComing: boolean;
  choking: boolean;
  lee: boolean;
  /** Poison gas about to reach us (out in the open or in a bunker); breathing it. */
  gasComing: boolean;
  gassed: boolean;
  /** On the motorcycle. */
  riding: boolean;
  /** A boss close by. */
  boss: boolean;
  bag: Slots;
  dead: boolean;
  /** By the crashed ship we arrived in (shared/ship.ts). */
  atShip: boolean;
};

/** Events and what each one carries. `tick` is polled a couple of times a second, for remarks about the state. */
export type SpeechEvents = {
  tick: undefined;
  /** Looking at a find on the sand, close enough to pick it up. */
  see: Loot;
  /** Looking at a vehicle in reach (shared/vehicles.ts), broken or working. */
  vehicle: Vehicle;
  /** In reach of a machine or wreck at a crash site; `carry`: small enough to take home whole. */
  near: { kind: string; carry: boolean };
  /** An item newly in the bag: picked up, crafted, repaired, taken out of a machine or a chest. */
  got: Item;
  /** Tried to pick something up with no room for it. */
  bagFull: undefined;
  /** Back on our feet after dying. */
  respawn: undefined;
  /** Something turned on us (src/guardians.ts). */
  aggro: Aggro;
  /** Something we shot or jammed lately just died (src/kills.ts). */
  killed: Kill | 'boss';
};

export type Line = {
  [E in keyof SpeechEvents]: {
    id: string;
    on: E;
    when?: (s: SpeechState, arg: SpeechEvents[E]) => boolean;
    say: string | string[];
    again?: number;
  };
}[keyof SpeechEvents];

const MIN = 60_000;

/** Any item of this kind in the bag, working or broken. */
const carries = (s: SpeechState, kind: string) => s.bag.some((it) => it?.kind === kind);
/** Machines and wrecks carried home whole to take apart. */
const MACHINE_KINDS = new Set([...Object.keys(SALVAGE), ...Object.entries(COMPONENTS).flatMap(([k, c]) => (c.carry ? [k] : []))]);
const isReceiver = (kind: string) => Object.values(RECEIVERS).includes(kind as never);
const isRelic = (kind: string) => Object.values(RELICS).includes(kind) || Object.values(RELIC_DROPS).some((d) => d.kind === kind);

/** The first time each kind of item is in the bag: by kind, then broken (`b`) or working (`w`). */
const firstGot = (kind: string): Line[] => [
  { id: `got.${kind}`, on: 'got', when: (_, it) => it.kind === kind && !repaired(it), say: TEXT.speech.got[kind][0] },
  { id: `got.${kind}.fixed`, on: 'got', when: (_, it) => it.kind === kind && repaired(it), say: TEXT.speech.got[kind][1] },
];

/** Something of this kind turning on us, and going down after we shot it. */
const aggro = (kind: Aggro): Line =>
  ({ id: `aggro.${kind}`, on: 'aggro', when: (s, k) => !s.dead && k === kind, say: TEXT.speech.aggro[kind], again: 10 * MIN });
const killed = (kind: Kill | 'boss', again: number): Line =>
  ({ id: `killed.${kind}`, on: 'killed', when: (_, k) => k === kind, say: TEXT.speech.killed[kind], again });

/** In order: for one event, the first line whose condition holds (and isn't resting) is said. */
export const LINES: Line[] = [
  // A water bottle, and we have none: the first thing anyone needs out here.
  { id: 'bottle', on: 'see', when: (s, l) => l.kind === 'canteen' && !carries(s, 'canteen') && s.day,
    say: TEXT.speech.bottleDay, again: 3 * MIN },
  { id: 'bottle', on: 'see', when: (s, l) => l.kind === 'canteen' && !carries(s, 'canteen') && !s.day,
    say: TEXT.speech.bottleNight, again: 3 * MIN },

  // Machines full of parts: the big ones are opened where they stand, the small ones and wrecks go home whole.
  { id: 'machine', on: 'near', when: (_, m) => !m.carry, say: TEXT.speech.machine },
  { id: 'machine.carry', on: 'near', when: (_, m) => m.carry, say: TEXT.speech.machineCarry },
  { id: 'machine.carry', on: 'got', when: (_, it) => MACHINE_KINDS.has(it.kind), say: TEXT.speech.machineCarry },

  // The first time each kind of thing is in the bag.
  ...firstGot('canteen'),
  // The motorcycle isn't carried (shared/vehicles.ts): said on first seeing one up close, broken, then working.
  { id: 'got.motorcycle', on: 'vehicle', when: (_, v) => v.kind === 'motorcycle' && !v.up, say: TEXT.speech.got.motorcycle[0] },
  { id: 'got.motorcycle.fixed', on: 'vehicle', when: (_, v) => v.kind === 'motorcycle' && v.up, say: TEXT.speech.got.motorcycle[1] },
  ...firstGot('spyglass'),
  ...firstGot('backpack'),
  ...firstGot('storm_detector'),
  ...firstGot('wristpad'),
  ...firstGot('shield'),
  ...firstGot('laser_rifle'),
  ...firstGot('laser_pistol'),
  ...firstGot('jammer'),
  { id: 'got.receiver', on: 'got', when: (_, it) => isReceiver(it.kind) && !repaired(it), say: TEXT.speech.got.receiver[0] },
  { id: 'got.receiver.fixed', on: 'got', when: (_, it) => isReceiver(it.kind) && repaired(it), say: TEXT.speech.got.receiver[1] },
  { id: 'got.broken', on: 'got', when: (_, it) => isGear(it.kind) && !repaired(it), say: TEXT.speech.gotBroken },
  { id: 'got.scrap', on: 'got', when: (_, it) => it.kind === 'scrap', say: TEXT.speech.gotScrap },
  { id: 'got.cloth', on: 'got', when: (_, it) => it.kind === 'cloth', say: TEXT.speech.gotCloth },
  { id: 'got.part.space', on: 'got', when: (_, it) => partOf(it.kind)?.tier === 'space', say: TEXT.speech.gotSpacePart },
  { id: 'got.part', on: 'got', when: (_, it) => !!partOf(it.kind), say: TEXT.speech.gotPart },
  { id: 'got.plant_bed', on: 'got', when: (_, it) => it.kind === 'plant_bed', say: TEXT.speech.gotPlantBed },
  { id: 'got.uv_lamp', on: 'got', when: (_, it) => it.kind === 'uv_lamp', say: TEXT.speech.gotUvLamp },
  { id: 'got.bedroll', on: 'got', when: (_, it) => it.kind === 'bedroll', say: TEXT.speech.gotBedroll },
  { id: 'got.relic', on: 'got', when: (_, it) => isRelic(it.kind), say: TEXT.speech.gotRelic },

  // On the bike.
  { id: 'ride', on: 'tick', when: (s) => s.riding, say: TEXT.speech.ride },

  // Water.
  { id: 'pump', on: 'tick', when: (s) => s.atPump && s.maxSips > 0 && s.sips < s.maxSips, say: TEXT.speech.pump },
  { id: 'well.dry', on: 'tick', when: (s) => s.dryWell === 'parts' && s.maxSips > 0, say: TEXT.speech.wellNoPump, again: 10 * MIN },
  { id: 'well.dry', on: 'tick', when: (s) => s.dryWell === 'power' && s.maxSips > 0 && s.sips < s.maxSips, say: TEXT.speech.wellNoPower,
    again: 5 * MIN },
  { id: 'pump.nothing', on: 'tick', when: (s) => s.atPump && s.shelter && !carries(s, 'canteen'),
    say: TEXT.speech.pumpNothing, again: 10 * MIN },

  // Overheating.
  { id: 'hot', on: 'tick', when: (s) => !s.dead && !s.indoors && s.rising && s.heat > 55 && s.maxSips === 0,
    say: TEXT.speech.hot, again: 2 * MIN },
  { id: 'hot', on: 'tick', when: (s) => !s.dead && s.rising && s.heat > 55 && s.sips > 0,
    say: TEXT.speech.sip, again: 2 * MIN },
  { id: 'dry', on: 'tick', when: (s) => !s.dead && s.maxSips > 0 && s.sips === 0 && s.heat > 40,
    say: TEXT.speech.dry, again: 4 * MIN },

  // Places. The first look at the wreck we came down in, by day and by night.
  { id: 'ship', on: 'tick', when: (s) => !s.dead && s.atShip && s.day, say: TEXT.speech.shipDay },
  { id: 'ship', on: 'tick', when: (s) => !s.dead && s.atShip, say: TEXT.speech.shipNight },
  { id: 'shelter', on: 'tick', when: (s) => s.shelter, say: TEXT.speech.shelter },
  { id: 'mudflat', on: 'tick', when: (s) => !s.dead && s.mudflat && s.day, say: TEXT.speech.mudflatDay },
  { id: 'mudflat', on: 'tick', when: (s) => !s.dead && s.mudflat, say: TEXT.speech.mudflatNight },

  // Sandstorms.
  { id: 'stormWarning', on: 'tick', when: (s) => !s.dead && s.stormWarning,
    say: TEXT.speech.stormWarning, again: 5 * MIN },
  { id: 'storm', on: 'tick', when: (s) => !s.dead && !s.indoors && s.storm > 0.5,
    say: TEXT.speech.storm, again: 5 * MIN },
  { id: 'stormFront', on: 'tick', when: (s) => !s.dead && s.frontComing, say: TEXT.speech.stormFront, again: 10 * MIN },
  { id: 'choking', on: 'tick', when: (s) => !s.dead && s.choking, say: TEXT.speech.choking, again: MIN },
  { id: 'lee', on: 'tick', when: (s) => !s.dead && s.lee, say: TEXT.speech.lee, again: 20 * MIN },

  // Poison gas.
  { id: 'gasComing', on: 'tick', when: (s) => !s.dead && s.gasComing && s.indoors, say: TEXT.speech.gasIndoors, again: 10 * MIN },
  { id: 'gasComing', on: 'tick', when: (s) => !s.dead && s.gasComing, say: TEXT.speech.gasComing, again: 10 * MIN },
  { id: 'gassed', on: 'tick', when: (s) => !s.dead && s.gassed, say: TEXT.speech.gassed, again: MIN },

  // Things that want us dead.
  { id: 'boss', on: 'tick', when: (s) => !s.dead && s.boss, say: TEXT.speech.boss },
  aggro('guardian'),
  aggro('crawler'),
  aggro('drone'),
  aggro('harvester'),

  // Things that wanted us dead, and don't any more.
  killed('guardian', 10 * MIN),
  killed('crawler', 10 * MIN),
  killed('drone', 10 * MIN),
  killed('jet', 10 * MIN),
  killed('harvester', 10 * MIN),
  killed('boss', MIN),

  // The first night out.
  { id: 'night', on: 'tick', when: (s) => !s.dead && !s.day && !s.indoors, say: TEXT.speech.night },

  { id: 'bagFull', on: 'bagFull', say: TEXT.speech.bagFull, again: 5 * MIN },
  { id: 'respawn', on: 'respawn', say: TEXT.speech.respawn, again: 10 * MIN },
];
