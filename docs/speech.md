# Speech: the character talks to themselves

The player character sometimes says a line out loud, shown as a subtitle at the bottom of the screen. It's how
the game guides without tutorials: the character notices what matters and reacts the way a person stuck in a
desert would. That lets us drop explanatory UI text.

Code: lines and their conditions in `src/lines.ts` (plain data, tune there), the engine and subtitle in
`src/speech.ts`, fed each frame from `src/main.ts`.

## How a line is written

- **First person, out loud, to nobody.** "This should help me live through this heat...", not "Water bottle:
  restores hydration".
- **One short sentence.** About eight words, rarely more than twelve. It's read while playing.
- **Plain words.** No game words (no "heat meter", "item", "slot", "quality", "repair at workbench"), no keys, no
  numbers. The character lives in the world, not in the UI.
- **Point at what to do, don't spell it out.** "Too hot. I need shade." tells you to find shade. It doesn't
  explain how heat works. Leave the player something to figure out.
- **Sometimes funny.** Dry and understated, never zany: "Note to self: don't do that again." Only some lines
  should be jokes. A joke repeated too often gets old, so give repeating lines a few wordings.
- **Right for the moment.** If the same thing means different things at different times, write a variant for each
  (day/night, inside/outside, already have one/don't). A line that's wrong for the moment is worse than no line.

## When the character speaks

- **Only when it helps or it's earned.** It's for the first time something matters (a water bottle when you have
  none, the first night) or a danger the player may not have noticed (overheating, a storm coming). Don't
  narrate what the player can plainly see.
- **Rarely.** One line at a time, a pause after each, and a quiet start after joining. A remark that matters only
  once is said once per browser (no `again`). One that can come back (overheating) has a long `again`, measured
  in minutes.
- **Conditions decide, not just events.** A line has an event (`see`, `respawn`, or `tick` for state that's
  polled), plus a condition on what the player has and where they are (`SpeechState`). If the condition
  doesn't hold, the line isn't said. Example: the water bottle remark needs a bottle in sight and *none in the
  bag, working or broken*, and it's worded by whether the sun is up.

## Adding a line

1. Need a new trigger? Add the event to `SpeechEvents` in `src/lines.ts` and call `speech.event(...)` from where it
   happens. Need new state for a condition? Add a field to `SpeechState` and fill it in `src/main.ts`.
2. Add the line to `LINES`. Lines that share an `id` are variants of one remark: the first whose `when` holds is
   said, and they share one once/again memory.
3. Read it aloud. If it sounds like a tooltip, rewrite it.
