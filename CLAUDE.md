# dadajam

Public game jam repo, three collaborators. Browser game: three.js + TypeScript + Vite, hot paths in
WebAssembly via AssemblyScript. Every merge to `main` goes live at https://herkku.org/dadajam/ within
a few minutes, so `main` must always build.

## Commands

- `npm run dev` — compile `assembly/` to wasm, then Vite dev server (http://localhost:5173)
- `npm run asbuild` — recompile wasm only (Vite does not watch `assembly/`)
- `npm run build` — wasm + `tsc --noEmit` + production build into `dist/`. Run before pushing.

There are no tests yet; `npm run build` is the check CI runs on PRs.

## Layout

- `src/main.ts` — entry: renderer, scene, game loop
- `src/wasm.ts` — loads the compiled wasm; use exports as `wasm.<fn>`
- `assembly/` — AssemblyScript source (compiled to `src/wasm/`, gitignored — never edit `src/wasm/`)
- `public/` — static assets (models, textures, audio), copied as-is into the build
- `deploy/`, `Dockerfile`, `.github/workflows/` — deployment; see README. Don't change without asking.

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

- Work on a branch and open a PR; CI builds it. Merge to `main` to deploy.
- Small, focused commits. Pull often — three people are editing a small codebase quickly.
- The live build SHA is shown in the top-left corner of the game.
