# The desktop app

`desktop/` wraps the web build in an Electron window: the first step towards a Steam build. It has its own
`package.json`, so the game's install and CI don't pull Electron. Nothing Steam-specific is in it yet (no Steamworks,
no Steam login); see "Towards Steam" below.

## Running it

```sh
npm run build                 # the app serves dist/
cd desktop && npm install
npm start                     # bundled dist/, talking to the dev server
PAAHDE_SERVER=http://localhost:8787 npm start   # ... or to a local npm run dev / npm run preview
npm run start:remote          # the page itself from the server, like a browser tab
npm run pack                  # a packaged app in desktop/out/ (unsigned; dist/ is copied in)
```

Flags: `--open=<query>` opens the page with that query (`--open=w=<id>` is a world's lobby), `--shot=<file>` loads,
waits `SHOT_WAIT_MS` (8 s), saves a screenshot and quits; `SHOT_JS` is run in the page first (fill in a name and
press Join, say). F11 toggles fullscreen. Add `--mute-audio` when testing.

## How it works

- `desktop/main.mjs` serves `dist/` from `app://game/`: a standard, secure scheme, so the page has a stable origin
  (its localStorage, and the browser ID in it, survive restarts), a secure context (WebGPU, pointer lock) and module
  workers. Everything under `app://game/api/` is passed on to the server, so the page's relative `fetch('api/...')`
  calls work unchanged.
- A WebSocket can't be passed on like that (`new WebSocket('app://...')` throws), so `desktop/preload.cjs` gives the
  page the server's address and `src/desktop.ts` (`PAGE_URL`) dials it; in a browser `PAGE_URL` is the page's own
  address, as before. Invite links use it too.
- Links that open a new window go to the player's browser.

## The build has to match the server

The protocol has no version: a client only works with a server of the same build. In a browser that's handled by
`src/update.ts` (the server says its build, the page reloads into it). A bundled app can't reload into a newer build,
and a local build (`BUILD_SHA` unset, so `dev`) doesn't even try. So `npm start` against the dev server only works
while `dist/` is built from the commit dev is running; after the next push to `main` it may break in odd ways.
`--remote` doesn't have that problem (it is a browser tab without the browser).

A Steam build needs one of: a server pinned to the build Steam ships (a release server next to prod), a protocol
version the server checks so an old app can say "update", or Steam updating the app with every server deploy.

## Towards Steam (not done)

- Steamworks through `steamworks.js` in the main process: overlay (`electronEnableSteamOverlay()`), achievements,
  rich presence, invites (an invite would open `--open=w=<id>`).
- Steam login instead of the browser ID: the app gets a ticket (`GetAuthTicketForWebApi`), the server checks it with
  `ISteamUserAuth/AuthenticateUserTicket` and keys the player by Steam ID.
- An icon (electron-builder uses Electron's), signing and notarising on macOS, Windows and Linux builds (`npm run
  pack` on each, or electron-builder's `--win`/`--linux` from one machine). Steam takes the `dir` output as it is.
- Steam Deck: no keyboard needed anywhere (the name field, the password), legible text at 1280×800.
- An in-game credits screen: the CC-BY assets in `public/credits.txt` need visible credit.
