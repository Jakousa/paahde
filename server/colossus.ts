// The colossus boss's brain (shared/bosses.ts, server/bosses.ts). A stand-in for now: it stands where it was put, then goes.
import type { Brain } from './bosses.ts';
import { BOSSES } from '../shared/bosses.ts';
import { heightAt } from '../shared/terrain.ts';

export const colossus: Brain = {
  spawn(b, x, z, summoned) {
    b.x = x + (summoned ? 60 : 300);
    b.z = z;
    b.y = heightAt(b.x, b.z) + 10;
  },
  tick(b) {
    return b.leaving;
  },
  near(b, x, y, z) {
    return Math.hypot(x - b.x, y - b.y, z - b.z) < 40;
  },
  snap: () => [],
};
void BOSSES;
