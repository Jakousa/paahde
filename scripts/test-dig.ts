// Sanity checks for digging + sand relaxation: node scripts/test-dig.ts
import assert from 'node:assert/strict';
import {
  cellKey, cellX, cellZ, digTarget, MIN_EDIT_MM, pitchFromQ, quantizePitch, Relaxer, REPOSE_AXIS_MM, stroke,
} from '../shared/dig.ts';
import { quantizeYaw } from '../shared/sim.ts';
import { baseHeight, EDIT_CELL, edits, EDIT_CHUNK, TerrainEdits } from '../shared/terrain.ts';

// Keys round-trip, including negatives.
for (const [x, z] of [[0, 0], [-1, 5], [4000, -4000], [-32768, 32767]]) {
  const k = cellKey(x, z);
  assert.equal(cellX(k), x);
  assert.equal(cellZ(k), z);
}
// Pitch quantization round-trips within a step.
for (const p of [-1.5, -0.4, 0, 0.9]) assert.ok(Math.abs(pitchFromQ(quantizePitch(p)) - p) < 1e-4);

// Looking straight ahead never hits flat-ish ground within reach; looking down does.
const feet = { x: 10, y: baseHeight(10, 20), z: 20 };
assert.equal(digTarget(feet, quantizeYaw(0), quantizePitch(0.3)), null);
const hit = digTarget(feet, quantizeYaw(0), quantizePitch(-0.7));
assert.ok(hit && hit.z < feet.z, 'dig point is in front (-Z)');

/** Run a scripted session on the singleton `edits`, return a digest + timing. */
function session() {
  for (const [cx, cz] of [...edits.entries()]) edits.setChunk(cx, cz, new Int32Array(EDIT_CHUNK * EDIT_CHUNK));
  const relax = new Relaxer();
  const touch = (ix: number, iz: number) => relax.touch(ix, iz);
  let maxProcessed = 0, steps = 0;
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) {
    stroke(edits, feet, quantizeYaw(0.3), quantizePitch(-1.1), false, touch);
    // ~6 relax passes between strokes (30 Hz relax, 5 strokes/s)
    for (let j = 0; j < 6; j++, steps++) maxProcessed = Math.max(maxProcessed, relax.step(edits));
  }
  let settle = 0;
  while (!relax.idle && settle < 2000) relax.step(edits), settle++, steps++;
  const ms = performance.now() - t0;
  let digest = 0, min = 0, max = 0, sum = 0;
  for (const [cx, cz, c] of edits.entries()) {
    for (let i = 0; i < c.length; i++) {
      digest = (Math.imul(digest, 31) + c[i] + cx * 7 + cz * 13) | 0;
      min = Math.min(min, c[i]);
      max = Math.max(max, c[i]);
      sum += c[i];
    }
  }
  return { digest, min, max, sum, ms, steps, settle, maxProcessed, idle: relax.idle };
}

const a = session();
const b = session();
console.log('session', a);
assert.equal(a.digest, b.digest, 'deterministic');
assert.ok(a.idle, 'relaxation settles');
assert.ok(a.min < -500 && a.min >= MIN_EDIT_MM, 'a hole was dug');
assert.ok(a.max > 0, 'sand was deposited');
assert.ok(Math.abs(a.sum) < 2000, `sand is (roughly) conserved: sum ${a.sum}`);

// After settling, no edited pair is steeper than repose (beyond the natural slope).
let worst = 0;
for (const [cx, cz, c] of edits.entries()) {
  for (let i = 0; i < c.length; i++) {
    const ix = cx * EDIT_CHUNK + (i % EDIT_CHUNK), iz = cz * EDIT_CHUNK + Math.floor(i / EDIT_CHUNK);
    const h = (x: number, z: number) => Math.round(baseHeight(x * EDIT_CELL, z * EDIT_CELL) * 1000) + edits.getMm(x, z);
    const b0 = (x: number, z: number) => Math.round(baseHeight(x * EDIT_CELL, z * EDIT_CELL) * 1000);
    const d = Math.abs(h(ix, iz) - h(ix + 1, iz)) - Math.max(REPOSE_AXIS_MM, Math.abs(b0(ix, iz) - b0(ix + 1, iz)));
    worst = Math.max(worst, d);
  }
}
assert.ok(worst <= 0, `slopes at or below repose (worst excess ${worst} mm)`);

// Serialisation round-trip: chunk → bytes (as stored in SQLite) → chunk, and JSON (as sent).
const copy = new TerrainEdits();
for (const [cx, cz, c] of edits.entries()) {
  const bytes = new Uint8Array(c.buffer.slice(0));
  const back = new Int32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const json = JSON.parse(JSON.stringify({ cx, cz, mm: Array.from(back) }));
  copy.setChunk(json.cx, json.cz, Int32Array.from(json.mm));
}
for (const [cx, cz, c] of edits.entries()) assert.deepEqual(copy.chunk(cx, cz), c);
for (let z = 15; z < 25; z += 0.37) for (let x = 5; x < 15; x += 0.41) assert.equal(copy.sample(x, z), edits.sample(x, z));

console.log('ok');
