# Speech: the character talks to themselves

The player character sometimes says a line out loud, shown as a subtitle at the bottom of the screen. It's how
the game guides without tutorials: the character notices what matters and reacts the way a person stuck in a
desert would. That lets us drop explanatory UI text.

Code: the words in `shared/text.ts` `TEXT.speech` (with every other text in the game, docs/text.md), when each is
said in `src/speechLines.ts` (plain data, tune there), the engine and subtitle in `src/speech.ts`, fed each frame
from `src/main.ts`. A line types out letter by letter with a soft blip per letter, visual-novel style (`src/speechSound.ts`;
rate and punctuation pauses at the top of `src/speech.ts`), so a remark is heard as well as read.

## How a line is written

- **First person, out loud, to nobody.** "This should help me live through this heat...", not "Water bottle:
  restores hydration".
- **One or two short sentences.** About eight words, rarely more than twelve. It's read while playing. Short means
  saying less, not clipping the grammar: "The bottle's empty. I need to find a pump.", not "Bottle's empty. Need
  pump." Strings of one-word fragments sound machine-written (docs/text.md "Flavor text").
- **Plain words.** No game words (no "heat meter", "item", "slot", "quality", "repair at workbench"), no keys, no
  numbers. The character lives in the world, not in the UI.
- **Point at what to do, don't spell it out.** "It's too hot. I need some shade." tells you to find shade. It doesn't
  explain how heat works. Leave the player something to figure out.
- **A person, not a narrator.** Tired, stubborn and dry, talking mostly to keep their spirits up. Relatable
  complaints and small reliefs are good ("More room to carry junk. My back is going to hate me.").
- **Sometimes funny.** Dry and understated, never zany: "Note to self: don't do that again." Only some lines
  should be jokes. A joke repeated too often gets old, so give repeating lines a few wordings.
- **Swears when it's bad.** A boss, being spotted, choking in a storm front, an empty bottle in the heat, dying:
  "Oh no. Oh, shit.", "Oh hell, here it comes.", "Well, that hurt like hell." Everyday lines stay clean, so the
  swearing marks the moments that really are bad.
- **Right for the moment.** If the same thing means different things at different times, write a variant for each
  (day/night, inside/outside, already have one/don't). A line that's wrong for the moment is worse than no line.

## When the character speaks

- **Only when it helps or it's earned.** It's for the first time something matters (a water bottle when you have
  none, the first night) or a danger the player may not have noticed (overheating, a storm coming). Don't
  narrate what the player can plainly see.
- **Rarely.** One line at a time, a pause after each, and a quiet start after joining. A remark that matters only
  once is said once per browser (no `again`). One that can come back (overheating) has a long `again`, measured
  in minutes.
- **Conditions decide, not just events.** A line has an event plus a condition on what the player has and where they
  are (`SpeechState`). Events: `see` (a find in reach), `near` (a crash-site machine or wreck in reach), `got` (an
  item newly in the bag: picked up, crafted, repaired, taken out of a machine), `bagFull`, `respawn`, `aggro` (an enemy
  turning on us, by kind: `GuardianFx.onAggro`), `killed` (an enemy we shot or jammed in the last 20 s dying, by kind,
  bosses as one: `src/kills.ts`), and `tick` (polled, for state: riding, at a pump, in a shelter, overheating, storms,
  a boss near, night). If the condition
  doesn't hold, the line isn't said. Example: the water bottle remark needs a bottle in sight and *none in the
  bag, working or broken*, and it's worded by whether the sun is up.

## Adding a line

1. Need a new trigger? Add the event to `SpeechEvents` in `src/speechLines.ts` and call `speech.event(...)` from where it
   happens. Need new state for a condition? Add a field to `SpeechState` and fill it in `src/main.ts`.
2. Write the words in `TEXT.speech` (a string, or a list to pick from at random; read the neighbours so it fits),
   then add the line to `LINES` pointing at them. Lines that share an `id` are variants of one remark: the first whose `when` holds is
   said, and they share one once/again memory.
   Every item kind should have a first-`got` line, worded by whether it's broken or working (`firstGot`, words in
   `TEXT.speech.got`): picking a
   thing up for the first time is when the player most wonders what it's for.
3. Read it aloud. If it sounds like a tooltip, rewrite it.

## What has lines, and what could

Has lines: arriving in a world (wanting a shelter; then the hint for the inventory, src/main.ts `onSaid`), a water
bottle in sight with none in the bag (day/night), a machine to take apart (the big ones on the spot, the small ones and
wrecks to carry home; the first one in the bag wants a dismantling bench built), the first of each item kind in the bag (each piece of gear broken
and working, scrap, cloth, parts and the space-grade ones, plant bed, UV lamp, bedroll, receivers, relics), the
crashed pod we came down in (day/night), the first ride,
a pump (with a bottle to fill, or in a shelter with none), the first shelter, overheating, an empty bottle, the storm
warning and being in a storm, each kind of enemy turning on you (a guardian hunting you, crawlers, a drone's light
locking on, a harvester charging) and each kind going down after you shot or jammed it, the first boss, the first night out, a full bag, respawning.

Ideas, not built yet (most need a new event or state field):
- Taking the first part out of a machine; the first repair or craft at the workbench ("Good as new. Well, good.").
- Low on water far from any pump; a full bottle that's been carried a while without drinking in the heat.
- The first drone searchlight at night; the first jet overhead; being shot at for the first time.
- A shield plate breaking ("That was close."); a line per boss kind beaten, and the last one (the world won).
- Lost: far from home (the bedroll, the pods) for a long time with no wrist computer.
- Lives running low for the world (src/lives.ts).
- Another player nearby for the first time; a dead player's pack ("Whoever this was, they won't mind.").
- Sand sifting into a shelter during a storm; a plant bed growing up, and the first harvest.
