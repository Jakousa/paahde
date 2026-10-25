# The desktop app

`desktop/` wraps the web build in an Electron window: the first step towards a Steam build. It has its own
`package.json`, so the game's install doesn't pull Electron. Nothing Steam-specific is in it yet (no Steamworks, no
Steam login); see "Towards Steam" below.

## Getting it

A push to `main` with `[minor]` or `[major]` in a commit message makes a GitHub release
(`.github/workflows/desktop.yml`) with the app for macOS (Apple silicon and Intel), Windows and Linux; so does a manual
run (Actions → Desktop app → Run workflow). Other pushes build nothing: the app updates its game files by itself
(below), so a release is only needed when `desktop/` changes. Put `[minor]` in such a commit. The newest is always at
`https://github.com/woltsu/paahde/releases/latest/download/<file>`: `Paahde-mac-arm64.zip`, `Paahde-mac-x64.zip`,
`Paahde-win-x64.zip`, `Paahde-linux-x64.tar.gz`.

Versions: the last `desktop-v*` tag with the minor (or major) part bumped. The version lives only in the tag (CI
doesn't commit). The tags are `desktop-v*` only: they deploy nothing (CLAUDE.md).

The builds aren't signed. On macOS, after unzipping: `xattr -cr Paahde.app` (or right-click → Open, then allow it in
System Settings → Privacy & Security). Windows SmartScreen: More info → Run anyway.

## Running it from the checkout

```sh
npm run build                 # the app ships dist/
cd desktop && npm install
npm start                     # the dev server
PAAHDE_SERVER=http://localhost:8787 npm start   # ... or a local npm run dev / npm run preview
npm run start:remote          # the page itself from the server, like a browser tab
npm run pack                  # a packaged app in desktop/out/ (unsigned; dist/ is copied in)
npm run dist                  # the zips CI makes, for this OS
```

Flags: `--open=<query>` opens the page with that query (`--open=w=<id>` is a world's lobby); `--profile=<name>` keeps
separate saved data (browser ID, downloaded builds), for a second player on one machine or a test; `--shot=<file>`
loads, waits `SHOT_WAIT_MS` (8 s), saves a screenshot and quits, with `SHOT_JS` run in the page first (fill in a name
and press Join, say). F11 toggles fullscreen. Add `--mute-audio` when testing.

The icon is `desktop/build/icon.png`, rendered from `public/favicon.svg` by `tools/favicon.mjs`.

## How it works

- `desktop/main.mjs` serves the game from `app://game/`: a standard, secure scheme, so the page has a stable origin
  (its localStorage, and the browser ID, name, colour and character look in it, survive restarts), a secure context (WebGPU, pointer lock) and module
  workers. Everything under `app://game/api/` is passed on to the server, so the page's relative `fetch('api/...')`
  calls work unchanged.
- A WebSocket can't be passed on like that (`new WebSocket('app://...')` throws), so `desktop/preload.cjs` gives the
  page the server's address and `src/desktop.ts` (`PAGE_URL`) dials it; in a browser `PAGE_URL` is the page's own
  address, as before. Invite links use it too.
- Links that open a new window go to the player's browser.

## Updates

The protocol has no version: a client only works with a server of the same build. So the app keeps its game files at
the server's build (`desktop/update.mjs`). They come from the game server it plays on (`PAAHDE_SERVER`, the dev server
by default), the same files it serves to browsers, never from GitHub: the server's image and its files are one deploy,
so they can't drift apart. GitHub only has the app's releases (above).

```
push to main ──► deploy.yml: image with dist/ + manifest.json ──► dev server
             └─► desktop.yml: desktop-v* release with the apps     │
                                                                   ▼
app start / reload ──► GET manifest.json ──► GET each file it lacks, check its hash
                                             └─► userData/content/<hash>; the rest from the shipped dist/
```

- `npm run build` writes `dist/manifest.json` (`tools/manifest.ts`): every file with a hash of its content.
- Each time the page loads, the app first reads the server's `manifest.json` and downloads the files whose hash it
  doesn't have into `userData/content/<hash>`; the rest come from the `dist/` it shipped with. Only what a
  deploy changed is downloaded (the scripts, mostly; a models change adds those models).
- That covers a deploy during play too: the server tells the page its new build and `src/update.ts` fetches the
  page, which makes the app download the new files while the game runs, then reloads into them, as in a browser.
- Offline, or if a file changes mid-download (another deploy), the app stays on the build it has.
- A window that is still dark while a big update downloads (an old app, many new models) is the update; there is no
  progress shown yet.

The app itself (`desktop/`) doesn't update: a change there needs a new download. A Steam build would get those
through Steam.

## Towards Steam (not done)

- Steamworks through `steamworks.js` in the main process: overlay (`electronEnableSteamOverlay()`), achievements,
  rich presence, invites (an invite would open `--open=w=<id>`).
- Steam login instead of the browser ID: the app gets a ticket (`GetAuthTicketForWebApi`), the server checks it with
  `ISteamUserAuth/AuthenticateUserTicket` and keys the player by Steam ID.
- Signing and notarising on macOS (an Apple Developer ID), a Windows code-signing certificate.
- Which server a Steam build talks to: the game files follow the server, so it would be a server for players (prod),
  not dev.
- Steam Deck: no keyboard needed anywhere (the name field, the password), legible text at 1280×800.
- An in-game credits screen: the CC-BY assets in `public/credits.txt` need visible credit.
