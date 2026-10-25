import { heightAt } from '../shared/terrain.ts';
import { shelterSolid } from '../shared/shelters.ts';

type P = { x: number; y: number; z: number };
const cache = new Map<string, { at: number; value: number }>();
let budgetAt = 0, tokens = 32;
/** Bounded direct-path test. Shelter interiors override the terrain above their rooms. */
export function obstruction(source: P, ear: P, now: number): number {
  const key = [source.x, source.y, source.z, ear.x, ear.y, ear.z].map((n) => Math.floor(n / 2)).join(',');
  const old = cache.get(key);
  if (old && now - old.at < 0.5) return old.value;
  tokens = Math.min(32, tokens + Math.max(0, now - budgetAt) * 32);
  budgetAt = now;
  if (tokens < 1) return old?.value ?? 0;
  tokens--;
  const d = Math.hypot(source.x - ear.x, source.y - ear.y, source.z - ear.z);
  const steps = Math.min(32, Math.max(2, Math.ceil(d / 2)));
  let blocked = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = source.x + (ear.x - source.x) * t, y = source.y + (ear.y - source.y) * t, z = source.z + (ear.z - source.z) * t;
    const room = shelterSolid(x, y, z);
    if (room === true || room === null && heightAt(x, z) > y + 0.25) blocked++;
  }
  const value = Math.min(1, blocked / 2);
  if (cache.size >= 512) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, value });
  return value;
}
