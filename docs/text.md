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
- **Keys and buttons are never written in words.** A hint names a control through the registry in
  `src/bindings.ts`: `kbd(prompt)` for a key cap, `ctl(prompt, label)` for a key cap with its label (hidden as a whole
  where the device has none), and inside a sentence the names from `hintKeys()` (`TEXT.hints`, `TEXT.gearUse`:
  "Hold ${k.use} to drink." reads "the left mouse button" or "RT"). They follow rebinding and the device in use: the
  keyboard and mouse, or the gamepad (Xbox or PlayStation names, `TEXT.controls.pad`; buttons in `src/padMap.ts`).
  A control with no action of its own (the pad's hotbar steps, the wheel's zoom, the inventory's mouse moves) is a
  `Prompt` in `src/bindings.ts`, named for each device in `promptKey`.
- **The voice:** labels (prompts, notices, menu items, step names, names of things) are terse: sentence case, a few
  words, no explanations or tutorials (CLAUDE.md "Game design"). The character's speech has its own guide:
  `docs/speech.md`.

## Flavor text: write like a person

Anything longer than a label (gear descriptions, hint banners, settings tips, the prologue, the death and win lines
and all of the speech) is written as natural, grammatical English, the way a person would say it. Keep it short by
saying less, never by clipping the grammar.

- **Whole sentences.** Avoid telegraph style. Pile-ups of one- and two-word fragments ("Broken. Dead, but a bike.
  Ironic.") and colon shorthand ("Motorcycle: Tab, into the Vehicle slot.") read as machine-written. Write
  "It's broken, but it's a bike." and "Put the motorcycle in the Vehicle slot (Tab)." instead.
- **Contractions and small words.** Use "it's", "I'll", "I'd better", "a bit of" and "the stuff". Dropping the
  articles and verbs ("Need a pump.", "Bottle's empty.") sounds like a status readout.
- **One fragment is fine, a habit isn't.** A real person says "Wheels, finally." Ten lines in that rhythm sound like a
  template. Vary the shape: a question, an aside, a complaint, a joke.
- **Personality.** The character is a tired, stubborn scavenger with a dry sense of humour who is mostly talking
  to keep themselves going. Lines should be relatable: sore feet, an aching back, sand in the teeth, relief at cool shade.
- **Swearing.** When things go badly (a boss shows up, choking in a storm front, out of water, spotted, just died),
  the character swears the way anyone would: "Shit, they've seen me.", "Oh hell, here it comes.", "Damn, I'm cooking
  out here." Keep it to the tough moments so it lands, and keep calm lines clean.
- **Instructions are still instructions.** Hints and tips say plainly what to press and where, in one or two
  ordinary sentences, without flavour that hides the point.

## Not in the registry

- Dev-only text: the F3 debug menu (`src/debugMenu.ts`), the models lab, the stats line.
- Numbers, units and symbols composed in code: `42%`, `31°C`, `×3`, `▲`.
- Player-written text (names, chat).
- Generated data whose labels aren't shown (`shared/crashKinds.ts`), and designer notes (`GEAR` `better`).
- `index.html`'s `<title>` (static). `src/entry.ts` sets it again from `TEXT.game.title`.

## Known gaps

- Server notices are sent as finished English strings, and `main.ts` compares one ('Bag full') to play a sound.
  For translation, the server should send a key (`notice: 'bagFull'`) and the client look it up.
