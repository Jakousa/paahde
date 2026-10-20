# Paahde

Online multiplayer desert survival game, made in the dadajam game jam (repo name: dadajam). three.js (WebGPU renderer, automatic WebGL2 fallback) + TypeScript + Vite,
and a Node WebSocket game server with SQLite. See [docs/netcode.md](docs/netcode.md) for how syncing works.

**Dev:** https://dev.paahde.herkku.org/ — every push to `main` deploys there automatically (~2–3 min).
Prod (https://paahde.herkku.org/) is not deployed from this repo: it still runs the last release of the old repo,
[woltsu/dadajam](https://github.com/woltsu/dadajam).

## Develop

Node 24+.

```sh
npm install
npm run dev      # game server + Vite on http://localhost:5173 (open two tabs)
docker compose up   # same thing in a container (no local Node needed); stop with: docker compose down
npm run build    # production build into dist/
```

- `src/` — client (TypeScript, three.js). Import three from `three/webgpu`.
- `server/` — authoritative game server + SQLite; `shared/` — simulation and protocol used by both.
- `public/` — static assets (models, textures, audio); reference them with relative paths.

## Workflow

AI agents (Claude Code, Codex, Cursor…): project instructions are in `CLAUDE.md` (also `AGENTS.md`).

Small commits straight to `main` (CI also builds PRs). Run `npm run build` first: `main` goes to dev on every push.

## Deployment

1. GitHub Actions (`.github/workflows/deploy.yml`) builds the `Dockerfile` (Vite build + Node game server)
   and pushes `ghcr.io/woltsu/paahde:dev` on every push to `main` (public image).
2. On the server, Watchtower polls GHCR every 60 s and restarts a container when its tag changes
   (`deploy/compose.yml`, at `/opt/dadajam` on the server): `web-dev` runs `paahde:dev`; `web` (prod) stays on
   the old repo's `ghcr.io/woltsu/dadajam:latest`.
3. The host Caddy (`deploy/dadajam.caddy`) proxies `paahde.herkku.org` and `herkku.org/dadajam/*` (including the
   `/ws` WebSocket) to prod on `127.0.0.1:8086`, and `dev.paahde.herkku.org` to dev on `127.0.0.1:8087`.
   The SQLite DBs live in `/opt/dadajam/data` (prod) and `/opt/dadajam/data-dev` (dev) on the server.

The build SHA is shown at the bottom of the Esc menu, so you can check which commit is live.

## Credits

Third-party assets and their licences are listed in [`public/credits.txt`](public/credits.txt), which ships
with the game (linked from the Esc menu). Add every downloaded asset there.
