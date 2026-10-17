# dadajam

Public game jam repo, three collaborators. Online multiplayer browser game: three.js + TypeScript + Vite
client, Node 24 WebSocket game server with SQLite, hot paths in WebAssembly via AssemblyScript. Every merge to `main` goes live at https://herkku.org/dadajam/ within
a few minutes, so `main` must always build.

## Commands

- `npm run dev` — compile wasm, then run the game server (:8787, auto-restarts) and Vite
  (http://localhost:5173, proxies `/ws`). Open two tabs to see multiplayer.
- `npm run asbuild` — recompile wasm only (Vite does not watch `assembly/`)
- `npm run build` — wasm + `tsc --noEmit` + production build into `dist/`. Run before pushing.
- `npm run preview` — build, then run the production server (serves `dist/` + `/ws` on :8787).

There are no tests yet; `npm run build` is the check CI runs on PRs.

## Layout

- `shared/sim.ts` — deterministic movement/physics, run by **both** client and server
- `shared/protocol.ts` — WebSocket message types
- `shared/scrap.ts` — deterministic scrap-pile layout + hitboxes (collided in `step()`, drawn by `src/world/scrap.ts`)
- `server/index.ts` — authoritative game server (static files + `/ws`); `server/db.ts` — SQLite
- `src/main.ts` — entry: renderer, scene, fixed-step game loop
- `src/net.ts` — client netcode (prediction, reconciliation, interpolation, reconnect)
- `src/input.ts` — keyboard → input bitmask
- `src/wasm.ts` — loads the compiled wasm; use exports as `wasm.<fn>`
- `assembly/` — AssemblyScript source (compiled to `src/wasm/`, gitignored — never edit `src/wasm/`)
- `docs/devlog.md` — what's been built and why, known gaps; `docs/look.md` — art direction
- `public/` — static assets (models, textures, audio), copied as-is into the build
- `deploy/`, `Dockerfile`, `.github/workflows/` — deployment; see README. Don't change without asking.

## Multiplayer rules (read docs/netcode.md before changing netcode)

- The server is authoritative; clients send only input bitmasks. Anything that moves a player must be in
  `shared/sim.ts` and deterministic (fixed `DT`, no `Math.random()`/`Date.now()`/frame time), or the
  client prediction will rubber-band.
- Server and shared code run with Node's native type stripping: import with `.ts` extensions, and no
  enums, namespaces or constructor parameter properties (`erasableSyntaxOnly` enforces this).
- The browser ID is a secret credential: never include it in messages to other clients.

## Conventions and gotchas

- Import three from `three/webgpu`, not `three`. `WebGPURenderer` falls back to WebGL2 automatically.
  - Use node materials (`MeshStandardNodeMaterial`, etc.) and TSL (`three/tsl`) for custom shaders.
    `ShaderMaterial`/GLSL does not work with `WebGPURenderer`.
  - `await renderer.init()` before the first render; loop with `renderer.setAnimationLoop`.
- The game is served under a subpath (`/dadajam/`) with `base: './'`. Never use absolute URLs like
  `/models/x.glb`; use relative paths (`./models/x.glb`) or `import url from './x.glb?url'`.
- AssemblyScript is TypeScript-like but not TypeScript: explicit numeric types (`f32`, `i32`, `f64`),
  no closures, no union types or `any`. Use `Mathf` for f32 math. Keep the JS↔wasm boundary to numbers
  (or shared typed-array views over `wasm.memory`) — crossing it with strings/objects is slow.
- Put per-frame number crunching (physics, simulation, procedural generation) in `assembly/`;
  scene graph, input, UI and loading stay in TypeScript.
- Strict TypeScript; keep it compiling with no errors.

## Workflow

- Commit and push straight to `main` (no PRs needed); a push to `main` deploys. Run `npm run build` first.
- Small, focused commits. Pull often — three people are editing a small codebase quickly.
- The live build SHA is shown in the top-left corner of the game.
