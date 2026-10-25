// Dev-only full-mix capture using the game's actual sound graphs, not peak-normalized copies of its samples.
import { audio } from '../src/audio.ts';
import { audioMetrics, tickEchoBus } from '../src/acoustics.ts';
import { music } from '../src/music.ts';
import { WindSound } from '../src/windSound.ts';
import { CrashSound } from '../src/crashSound.ts';
import { wind } from '../src/world/wind.ts';
import { rifleSound } from '../src/rifleSound.ts';
import { guardianSound } from '../src/guardianSound.ts';
import { wormSound } from '../src/wormSound.ts';
import { listen } from '../src/echo.ts';
import { spawnPoint } from '../shared/sim.ts';
import { heightAt } from '../shared/terrain.ts';

const windSound = new WindSound(), crashSound = new CrashSound();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function wav(left: Float32Array, right: Float32Array, rate: number) {
  const bytes = new Uint8Array(44 + left.length * 8), v = new DataView(bytes.buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 8, true); v.setUint16(32, 8, true); v.setUint16(34, 32, true);
  text(36, 'data'); v.setUint32(40, left.length * 8, true);
  for (let i = 0; i < left.length; i++) { v.setFloat32(44 + i * 8, left[i], true); v.setFloat32(48 + i * 8, right[i], true); }
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

Object.assign(window, { measureAudio: async (scenario: 'exploration' | 'storm' | 'combat' | 'multiplayer', volume = 0.4, seconds = 20, components?: readonly string[]) => {
  if (!audio.ctx) throw new Error('Click Start audio first');
  const enabled = (part: string) => !components || components.includes(part);
  audio.setVolume(volume); audio.setMusicVolume(enabled('music') ? 1 : 0);
  const p = spawnPoint(), ear = { x: p.x, y: heightAt(p.x, p.z) + 1.7, z: p.z };
  const listener = audio.ctx.listener;
  listener.positionX.value = ear.x; listener.positionY.value = ear.y; listener.positionZ.value = ear.z;
  listener.forwardX.value = 0; listener.forwardY.value = 0; listener.forwardZ.value = -1;
  listener.upX.value = 0; listener.upY.value = 1; listener.upZ.value = 0;
  const at = (x: number, z: number) => ({ x: ear.x + x, y: heightAt(ear.x + x, ear.z + z) + 1, z: ear.z + z });
  const fight = scenario === 'combat' || scenario === 'multiplayer';
  const multi = scenario === 'multiplayer';
  wind.override = scenario === 'storm' || multi ? 23 : 8;
  wind.local = scenario === 'storm' || multi ? 1 : 0;
  const start = performance.now(); let last = start;
  let nextShot = 1, nextStep = 1.2, nextTell = 4, nextBoom = 2.7, nextCrawler = 3;
  const timer = setInterval(() => {
    const now = performance.now(), t = (now - start) / 1000, dt = Math.min(0.1, (now - last) / 1000); last = now;
    wind.update(t);
    if (enabled('ambience')) { windSound.update(dt, ear, 0, { vx: 0, vy: 0, vz: -3 }); crashSound.update(ear, 0); }
    listen(ear); tickEchoBus();
    music.update(dt, { epic: fight, sandstorm: scenario === 'storm' });
    if (!fight) return;
    if (enabled('shots') && t >= nextShot) {
      nextShot = t + 0.4;
      rifleSound.shot();
      if (multi) for (const d of [25, 45, 65]) rifleSound.shot(at(d, -10), ear);
    }
    if (enabled('steps') && t >= nextStep) { nextStep = t + 1.2; const q = at(20, -12); guardianSound.footfall(q.x, q.y, q.z, 1, ear); }
    if (enabled('booms') && t >= nextBoom) { nextBoom = t + 2.7; const q = at(-30, -20); guardianSound.boom(q.x, q.y, q.z, ear); }
    if (enabled('tells') && t >= nextTell) { nextTell = t + 6; wormSound.tell(at(35, -15), ear, 1.72); }
    if (enabled('crawler') && t >= nextCrawler) { nextCrawler = t + 5; const q = at(3, -2); guardianSound.rattle(q.x, q.y, q.z, 0.5, ear); }
    if (enabled('drones')) guardianSound.drones([{ id: 1, ...at(20, -20) }, ...(multi ? [{ id: 2, ...at(-25, -15) }, { id: 3, ...at(35, 10) }] : [])], ear);
  }, 1000 / 60);
  try {
    await sleep(3500);
    const captured = await audio.capture(seconds);
    return { scenario, volume, seconds, components: components ?? 'all', sampleRate: captured.sampleRate, wav: wav(captured.left, captured.right, captured.sampleRate),
      metrics: { voicePeak: audioMetrics.voices.peak, voiceDrops: audioMetrics.voices.dropped, voiceSteals: audioMetrics.voices.stolen,
        echoPeak: audioMetrics.echoes.peak, echoDrops: audioMetrics.echoes.dropped, baseLatency: audio.ctx.baseLatency, outputLatency: audio.ctx.outputLatency } };
  } finally { clearInterval(timer); await audio.ctx.suspend(); }
} });
