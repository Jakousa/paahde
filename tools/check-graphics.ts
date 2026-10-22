// Focused checks for saved presets and independent CPU/GPU adaptation. Run: node tools/check-graphics.ts
import assert from 'node:assert/strict';

const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => saved.set(key, value),
} });
const { graphics, applyGraphicsPreset, currentGraphicsPreset, setGraphics, needsReload, adaptGraphics, onGraphics, GRAPHICS_PRESETS } = await import('../src/graphics.ts');
const { AutoQuality } = await import('../src/autoGraphics.ts');

assert.equal(currentGraphicsPreset(), 'auto', 'first visit starts in Auto');
setGraphics('fullscreen', false);
assert.equal(currentGraphicsPreset(), 'auto', 'display mode does not disable Auto');
for (const name of ['low', 'medium', 'high', 'ultra'] as const) {
  let notifications = 0;
  const unbind = onGraphics(() => {
    notifications++;
    for (const [key, value] of Object.entries(GRAPHICS_PRESETS[name])) assert.equal(graphics[key as keyof typeof graphics], value, 'listeners see the complete preset');
  });
  applyGraphicsPreset(name);
  unbind();
  assert.ok(notifications > 0);
  assert.equal(currentGraphicsPreset(), name);
  assert.equal(graphics.fullscreen, false);
  assert.deepEqual(JSON.parse(saved.get('dadajam.graphics')!), graphics);
}
applyGraphicsPreset('low');
assert.ok(needsReload(), 'changing renderer quality asks for reload');
setGraphics('occlusion', 0.2);
assert.equal(currentGraphicsPreset(), 'custom');
const manual = { ...graphics };
adaptGraphics({ shadows: true, shadowDistance: 1600, shadowRefresh: 1, sandDetail: 2, occlusion: 0.7 });
assert.deepEqual(graphics, manual, 'Auto never overrides manual choices');
applyGraphicsPreset('auto');
assert.equal(needsReload(), false, 'returning to startup settings removes reload prompt');
setGraphics('resScale', 0.75);
assert.equal(graphics.autoQuality, false);

function run(policy: AutoQuality, seconds: number, cpu: number, scale: number, pixelBound: boolean, dt = 1 / 60, active = true) {
  let result: ReturnType<AutoQuality['update']> = null;
  for (let i = 0; i < seconds / dt; i++) result = policy.update(dt, cpu, scale, pixelBound, active) ?? result;
  return result;
}
const cpuBound = run(new AutoQuality(), 30, 24, 1, false, 1 / 30)!;
assert.equal(cpuBound.shadowRefresh, 2);
assert.equal(cpuBound.shadowDistance, 400);
assert.equal(cpuBound.occlusion, 0.7, 'a weak CPU keeps GPU effects');
assert.equal(cpuBound.sandDetail, 2);
const gpuPolicy = new AutoQuality();
const gpuBound = run(gpuPolicy, 30, 4, 0.55, true)!;
assert.equal(gpuBound.shadows, false);
assert.equal(gpuBound.occlusion, 0);
assert.equal(gpuBound.shadowRefresh, 1, 'a weak GPU does not classify the CPU as weak');
assert.equal(gpuBound.shadowDistance, 1600);
assert.equal(run(gpuPolicy, 4, 4, 1, false)!.shadows, false, 'a brief easy view does not restore heavy effects');
assert.equal(run(gpuPolicy, 30, 4, 1, false)!.shadows, true, 'sustained headroom restores effects');
const capped = run(new AutoQuality(), 30, 4, 1, false, 1 / 30)!;
assert.equal(capped.occlusion, 0.7, 'a 30 Hz cap alone does not reduce GPU quality');
assert.equal(run(new AutoQuality(), 30, 100, 0.5, true, 1 / 30, false), null, 'loading and hidden frames are ignored');
const both = run(new AutoQuality(), 30, 24, 0.55, true, 1 / 30)!;
assert.equal(both.shadowRefresh, 2);
assert.equal(both.shadows, false);
assert.equal(run(new AutoQuality(0, 0), 7, 4, 1, false)!.shadows, false, 'saved low quality waits for sustained recovery');

// Integration with the actual resolution controller: pixel cost helps; fixed CPU/display caps do not.
Object.defineProperty(globalThis, 'window', { value: { devicePixelRatio: 1 } });
const { DynamicResolution } = await import('../src/resolution.ts');
const mockRenderer = { setPixelRatio() {} } as unknown as ConstructorParameters<typeof DynamicResolution>[0];
const pixels = new DynamicResolution(mockRenderer);
pixels.setMin(0.5);
for (let i = 0; i < 600; i++) pixels.update(Math.max(1 / 60, 0.04 * pixels.ratio ** 2));
assert.ok(pixels.pixelBound && pixels.ratio < 0.9, 'GPU pressure is confirmed by a successful probe');
const fixed = new DynamicResolution(mockRenderer);
for (let i = 0; i < 600; i++) fixed.update(1 / 30);
assert.equal(fixed.pixelBound, false, 'a fixed 30 Hz cap does not look GPU-bound');
assert.equal(fixed.ratio, 1, 'failed probes restore sharpness');

// Separate module instances simulate a reload with legacy and current settings.
saved.set('dadajam.graphics', JSON.stringify({ ...GRAPHICS_PRESETS.high, fullscreen: false }));
saved.set('dadajam.ao', '0.35');
const legacy = await import('../src/graphics.ts?legacy');
assert.equal(legacy.graphics.autoQuality, false);
assert.equal(legacy.graphics.occlusion, 0.7, 'new AO value wins over the old key');
saved.set('dadajam.graphics', JSON.stringify({ fpsLimit: 30, shadows: false }));
const older = await import('../src/graphics.ts?older');
assert.equal(older.graphics.occlusion, 0.35);
assert.equal(older.graphics.fpsLimit, 30);
assert.equal(older.graphics.autoQuality, false, 'legacy custom settings stay manual');
console.log('Graphics checks passed: presets, persistence, migration, CPU/GPU adaptation, caps, warmup and recovery.');
