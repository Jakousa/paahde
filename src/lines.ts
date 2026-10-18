// What the player character says (subtitles, src/speech.ts), as plain data: tune and add lines here.
// Guidelines in docs/speech.md: first person, one short sentence, plain words, a little dry humour; a line nudges
// toward what to do (pick it up, get shade, find water), never names keys or numbers.
//
// A line answers an event (`on`) when its condition (`when`) holds at that moment. Lines sharing an `id` are
// variants of one remark (e.g. by day and by night): the first whose condition holds is said, and they share its
// memory. Without `again` a remark is said once ever on this browser; with it, at most once per `again` ms.
// `say` may list several wordings; one is picked at random.
import type { Loot } from '../shared/loot.ts';
import type { Slots } from '../shared/items.ts';

/** What a line can look at, sampled every frame by src/main.ts. */
export type SpeechState = {
  /** Sun above the horizon. */
  day: boolean;
  /** In the base or a shelter. */
  indoors: boolean;
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
  bag: Slots;
  dead: boolean;
};

/** Events and what each one carries. `tick` is polled a couple of times a second, for remarks about the state. */
export type SpeechEvents = {
  tick: undefined;
  /** Looking at a find on the sand, close enough to pick it up. */
  see: Loot;
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

/** In order: for one event, the first line whose condition holds (and isn't resting) is said. */
export const LINES: Line[] = [
  // A water bottle, and we have none: the first thing anyone needs out here.
  { id: 'bottle', on: 'see', when: (s, l) => l.kind === 'canteen' && !carries(s, 'canteen') && s.day,
    say: 'This should help me live through this heat...', again: 3 * MIN },
  { id: 'bottle', on: 'see', when: (s, l) => l.kind === 'canteen' && !carries(s, 'canteen') && !s.day,
    say: 'This should help me survive out there during the day...', again: 3 * MIN },

  // Overheating.
  { id: 'hot', on: 'tick', when: (s) => !s.dead && !s.indoors && s.rising && s.heat > 55 && s.maxSips === 0,
    say: ['Too hot. I need shade.', "I'm cooking out here.", 'Shade. Any shade.'], again: 2 * MIN },
  { id: 'hot', on: 'tick', when: (s) => !s.dead && s.rising && s.heat > 55 && s.sips > 0,
    say: ['Time for a sip.', 'My throat is sand.'], again: 2 * MIN },
  { id: 'dry', on: 'tick', when: (s) => !s.dead && s.maxSips > 0 && s.sips === 0 && s.heat > 40,
    say: ["Bottle's empty. Need a pump.", 'Not a drop left.'], again: 4 * MIN },

  // Sandstorms.
  { id: 'stormWarning', on: 'tick', when: (s) => !s.dead && s.stormWarning,
    say: ["That beeping can't be good. Better get under a roof."], again: 5 * MIN },
  { id: 'storm', on: 'tick', when: (s) => !s.dead && !s.indoors && s.storm > 0.5,
    say: ["Can't see a thing!", 'Sand in my everything.'], again: 5 * MIN },

  // The first night out.
  { id: 'night', on: 'tick', when: (s) => !s.dead && !s.day && !s.indoors, say: 'Finally, it cools down.' },

  { id: 'respawn', on: 'respawn', say: ["Note to self: don't do that again.", 'Ow. Where was I?'], again: 10 * MIN },
];
