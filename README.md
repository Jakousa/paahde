# dadajam

Game jam project. three.js (WebGPU renderer, automatic WebGL2 fallback) + TypeScript + Vite,
with performance-critical code in WebAssembly via [AssemblyScript](https://www.assemblyscript.org/).

**Live:** https://herkku.org/dadajam/ — every push to `main` deploys automatically (~2–3 min).

## Develop

Node 24+.

```sh
npm install
npm run dev      # compiles assembly/ to wasm, starts Vite on http://localhost:5173
npm run build    # production build into dist/
```

- `src/` — game code (TypeScript, three.js). Import three from `three/webgpu`.
- `public/` — static assets (models, textures, audio); reference them with relative paths.
- `assembly/` — AssemblyScript compiled to `src/wasm/game.wasm`; exported functions are available as
  `wasm.<name>` via `src/wasm.ts`. Rerun `npm run asbuild` (or restart `dev`) after changing it.

## Workflow

AI agents (Claude Code, Codex, Cursor…): project instructions are in `CLAUDE.md` (also `AGENTS.md`).

Branch, open a PR (CI checks it builds), merge to `main`. Don't push broken builds to `main` — it goes live.

## Deployment

1. GitHub Actions (`.github/workflows/deploy.yml`) builds the `Dockerfile` (Node build → static files in Caddy)
   and pushes `ghcr.io/woltsu/dadajam:latest` (public image).
2. On the server, Watchtower polls GHCR every 60 s and restarts the container when `:latest` changes
   (`deploy/compose.yml`, at `/opt/dadajam` on the server).
3. The host Caddy proxies `herkku.org/dadajam/*` to the container on `127.0.0.1:8086` (`deploy/dadajam.caddy`).

The build SHA is shown in the top-left corner, so you can check which commit is live.
