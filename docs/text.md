# Text: one registry for every word the player sees

Every player-visible text lives in `shared/text.ts`, in `TEXT`. That covers names of things, prompts, notices,
menus, controls, hints, disassembly steps and the character's speech. Code reads `TEXT.<area>.<key>` and never
writes player-facing words inline. Two reasons:

- **Authoring:** all the words sit side by side, so it's easy to keep them consistent: one word per thing ("Bag
  full", never "Backpack full" in one place and "Bag full" in another), one tone, one way of casing.
- **Translation later:** `Texts` (the type of the English object) is the shape another language would fill in.
  Nothing is translated yet.

## Rules

- **New player-facing text goes in `shared/text.ts` first**, then code reads it. That includes server notices
  (`{t:'notice', text}`), `title=` tooltips, placeholders, button labels, CSS `content:` and labels in data tables
  (`ITEMS`, `SALVAGE`, `GEAR` use texts, ...). Data tables point at `TEXT`. They don't hold their own words.
- **Reuse before adding.** Search `TEXT` for the thing first. If "Too far" exists, don't add "Too far away".
- **Values go in as arguments, not by gluing strings.** Anything with a number, a name or a key in it is a function:
  `TEXT.prompt.pickUp(label)`, `TEXT.notice.got(n, label)`, `TEXT.controls.onlyKey(key, action)`. Never
  `'Pick up ' + label` in code: another language may put the words in a different order.
- **Casing lives in the registry.** Names are stored in sentence case ("Water bottle"). When a name goes mid-sentence,
  the function lowercases it with `lower()`, which keeps acronyms ("AI control system", "UV lamp"). Don't
  call `.toLowerCase()` on a label in code.
- **Group by where it appears**, not by which file uses it: `prompt` (under the crosshair), `notice` (toasts),
  `inventory`, `hud`, `menu`, `controls`, `landing`, `teardown`, `minigame`, `steps`, `hints`, `speech`, and the names of things
  (`items`, `parts`, `tiers`, `machines`, `bosses`, `equip`, `boxes`).
- **Keys are stable names for the meaning**, not the English words: `notice.cantWear`, not `notice.cantWearIt`
  copied from the text. Item, part and machine sections are keyed by their item kind ids.
- **The voice:** terse labels, sentence case, a few words, no explanations or tutorials (CLAUDE.md "Game design").
  The character's speech has its own guide: `docs/speech.md`.

## Not in the registry

- Dev-only text: the F3 debug menu (`src/debugMenu.ts`), the models lab, the stats line.
- Numbers, units and symbols composed in code: `42%`, `31°C`, `×3`, `▲`.
- Player-written text (names, chat).
- Generated data whose labels aren't shown (`shared/crashKinds.ts`), and designer notes (`GEAR` `better`).
- `index.html`'s `<title>` (static). `src/entry.ts` sets it again from `TEXT.game.title`.

## Known gaps

- Server notices are sent as finished English strings, and `main.ts` compares one ('Bag full') to play a sound.
  For translation, the server should send a key (`notice: 'bagFull'`) and the client look it up.
- Hints and some `GEAR` use texts name keys or mouse buttons in words ("Press 9", "Left mouse"). Hints get the
  bound keys passed in. The `GEAR` texts don't yet.
