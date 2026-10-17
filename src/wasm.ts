// Loads the AssemblyScript module from assembly/ (compiled into src/wasm/ by `npm run asbuild`).
import wasmUrl from './wasm/game.wasm?url';
import { instantiate } from './wasm/game.js';

export const wasm = await instantiate(await WebAssembly.compileStreaming(fetch(wasmUrl)), {});
