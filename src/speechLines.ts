// What the player character says (subtitles, src/speech.ts), as plain data: tune and add lines here.
// Guidelines in docs/speech.md: first person, one short sentence, plain words, a little dry humour; a line nudges
// toward what to do (pick it up, get shade, find water), never names keys or numbers.
//
// A line answers an event (`on`) when its condition (`when`) holds at that moment. Lines sharing an `id` are
// variants of one remark (e.g. by day and by night, or the same thing met two ways): the first whose condition
// holds is said, and they share its memory. Without `again` a remark is said once ever on this browser; with it,
// at most once per `again` ms. `say` may list several wordings; one is picked at random.
import type { Loot } from '../shared/loot.ts';
import type { Item, Slots } from '../shared/items.ts';
import { isGear, repaired } from '../shared/gear.ts';
import { partOf } from '../shared/parts.ts';
import { RECEIVERS, RELICS } from '../shared/bosses.ts';
import { RELIC_DROPS } from '../shared/tables.ts';
import { COMPONENTS, SALVAGE } from '../shared/salvage.ts';

/** What a line can look at, sampled every frame by src/main.ts. */
export type SpeechState = {
  /** Sun above the horizon. */
  day: boolean;
  /** In the base or a shelter; in a shelter (one of the small bunkers out in the desert). */
  indoors: boolean;
  shelter: boolean;
  /** Close enough to a pump to fill a bottle. */
  atPump: boolean;
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
  /** On the motorcycle. */
  riding: boolean;
  /** Walkers or drones after us; a boss close by. */
  combat: boolean;
  boss: boolean;
  bag: Slots;
  dead: boolean;
};

/** Events and what each one carries. `tick` is polled a couple of times a second, for remarks about the state. */
export type SpeechEvents = {
  tick: undefined;
  /** Looking at a find on the sand, close enough to pick it up. */
  see: Loot;
  /** In reach of a machine or wreck at a crash site; `carry`: small enough to take home whole. */
  near: { kind: string; carry: boolean };
  /** An item newly in the bag: picked up, crafted, repaired, taken out of a machine or a chest. */
  got: Item;
  /** Tried to pick something up with no room for it. */
  bagFull: undefined;
  /** Back on our feet after dying. */
  respawn: undefined;
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
const firstGot = (kind: string, b: string | string[], w: string | string[]): Line[] => [
  { id: `got.${kind}`, on: 'got', when: (_, it) => it.kind === kind && !repaired(it), say: b },
  { id: `got.${kind}.fixed`, on: 'got', when: (_, it) => it.kind === kind && repaired(it), say: w },
];

/** In order: for one event, the first line whose condition holds (and isn't resting) is said. */
export const LINES: Line[] = [
  // A water bottle, and we have none: the first thing anyone needs out here.
  { id: 'bottle', on: 'see', when: (s, l) => l.kind === 'canteen' && !carries(s, 'canteen') && s.day,
    say: 'This should help me live through this heat...', again: 3 * MIN },
  { id: 'bottle', on: 'see', when: (s, l) => l.kind === 'canteen' && !carries(s, 'canteen') && !s.day,
    say: 'This should help me survive out there during the day...', again: 3 * MIN },

  // Machines full of parts: the big ones are opened where they stand, the small ones and wrecks go home whole.
  { id: 'machine', on: 'near', when: (_, m) => !m.carry, say: 'Full of good parts. Time to open it up.' },
  { id: 'machine.carry', on: 'near', when: (_, m) => m.carry, say: "Too fiddly to strip out here. I'll take it home." },
  { id: 'machine.carry', on: 'got', when: (_, it) => MACHINE_KINDS.has(it.kind), say: "Too fiddly to strip out here. I'll take it home." },

  // The first time each kind of thing is in the bag.
  ...firstGot('canteen', "Cracked. I'll need to patch it up first.", 'Water bottle. My new best friend.'),
  ...firstGot('motorcycle', 'A bike! Dead, but a bike.', 'Wheels. Finally.'),
  ...firstGot('spyglass', 'Cracked lens. Shame, I could see far with this.', 'Now I can see trouble before it sees me.'),
  ...firstGot('backpack', 'Torn. Still, more room than my pockets.', 'More room. My back will hate me.'),
  ...firstGot('storm_detector', 'Something to hear the storms coming. If it worked.', 'If this beeps, I run.'),
  ...firstGot('wristpad', 'A wrist computer. Dead as the desert.', 'A little map of who is where.'),
  ...firstGot('shield', 'A plate to hide behind. Bent, though.', 'Something between me and a bad day.'),
  ...firstGot('laser_rifle', 'A rifle. Once it works, those walkers had better watch out.', 'Now we can talk to those walkers.'),
  ...firstGot('laser_pistol', 'A pistol. Broken, but a pistol.', 'Small, but it bites.'),
  ...firstGot('jammer', 'Some kind of jammer. For the things in the sky?', 'Let them come down to my level.'),
  { id: 'got.receiver', on: 'got', when: (_, it) => isReceiver(it.kind) && !repaired(it), say: 'Some kind of radio. Who would it call?' },
  { id: 'got.receiver.fixed', on: 'got', when: (_, it) => isReceiver(it.kind) && repaired(it), say: "Whatever answers this, it won't be small." },
  { id: 'got.broken', on: 'got', when: (_, it) => isGear(it.kind) && !repaired(it), say: 'Broken. The right parts might fix it.' },
  { id: 'got.scrap', on: 'got', when: (_, it) => it.kind === 'scrap', say: 'Scrap. Everything out here is made of it.' },
  { id: 'got.cloth', on: 'got', when: (_, it) => it.kind === 'cloth', say: 'Some cloth. Good for patching.' },
  { id: 'got.part.space', on: 'got', when: (_, it) => partOf(it.kind)?.tier === 'space', say: "That's no ordinary part." },
  { id: 'got.part', on: 'got', when: (_, it) => !!partOf(it.kind), say: 'A good part. Something broken will want this.' },
  { id: 'got.plant_bed', on: 'got', when: (_, it) => it.kind === 'plant_bed', say: 'A garden. In a bunker. Sure.' },
  { id: 'got.uv_lamp', on: 'got', when: (_, it) => it.kind === 'uv_lamp', say: 'Sunlight for underground. Ironic.' },
  { id: 'got.relic', on: 'got', when: (_, it) => isRelic(it.kind), say: 'Still warm. Somebody will want this back.' },

  // On the bike.
  { id: 'ride', on: 'tick', when: (s) => s.riding, say: 'Wind in my face, sand in my teeth.' },

  // Water.
  { id: 'pump', on: 'tick', when: (s) => s.atPump && s.maxSips > 0 && s.sips < s.maxSips, say: 'Water. Fill her up.' },
  { id: 'pump.nothing', on: 'tick', when: (s) => s.atPump && s.shelter && !carries(s, 'canteen'),
    say: 'Water, and nothing to carry it in.', again: 10 * MIN },

  // Overheating.
  { id: 'hot', on: 'tick', when: (s) => !s.dead && !s.indoors && s.rising && s.heat > 55 && s.maxSips === 0,
    say: ['Too hot. I need shade.', "I'm cooking out here.", 'Shade. Any shade.'], again: 2 * MIN },
  { id: 'hot', on: 'tick', when: (s) => !s.dead && s.rising && s.heat > 55 && s.sips > 0,
    say: ['Time for a sip.', 'My throat is sand.'], again: 2 * MIN },
  { id: 'dry', on: 'tick', when: (s) => !s.dead && s.maxSips > 0 && s.sips === 0 && s.heat > 40,
    say: ["Bottle's empty. Need a pump.", 'Not a drop left.'], again: 4 * MIN },

  // Places.
  { id: 'shelter', on: 'tick', when: (s) => s.shelter, say: 'Somebody dug in here once. Nice and cool.' },

  // Sandstorms.
  { id: 'stormWarning', on: 'tick', when: (s) => !s.dead && s.stormWarning,
    say: ["That beeping can't be good. Better get under a roof."], again: 5 * MIN },
  { id: 'storm', on: 'tick', when: (s) => !s.dead && !s.indoors && s.storm > 0.5,
    say: ["Can't see a thing!", 'Sand in my everything.'], again: 5 * MIN },

  // Things that want us dead.
  { id: 'boss', on: 'tick', when: (s) => !s.dead && s.boss, say: 'Oh. Oh no.' },
  { id: 'combat', on: 'tick', when: (s) => !s.dead && s.combat, say: "They've seen me. Keep moving!" },

  // The first night out.
  { id: 'night', on: 'tick', when: (s) => !s.dead && !s.day && !s.indoors, say: 'Finally, it cools down.' },

  { id: 'bagFull', on: 'bagFull', say: ['No room. Something has to go.', "My pockets aren't bottomless."], again: 5 * MIN },
  { id: 'respawn', on: 'respawn', say: ["Note to self: don't do that again.", 'Ow. Where was I?'], again: 10 * MIN },
];
