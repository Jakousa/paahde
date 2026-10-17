// Hot-path game code compiled to WebAssembly (AssemblyScript = TypeScript-like syntax).
// Built by `npm run asbuild` into src/wasm/, imported from src/main.ts.

export function spin(angle: f32, dt: f32, speed: f32): f32 {
  const next = angle + dt * speed;
  return next > Mathf.PI * 2 ? next - Mathf.PI * 2 : next;
}
