// Wire codecs kept apart from gameplay. Owner reconciliation keeps full precision and state;
// remote players carry only their rendered pose, with appearance sent on change.
import type { PlayerState } from './sim.ts';
import type { Hands } from './protocol.ts';
import { EDIT_CHUNK } from './terrain.ts';

export const PLAYER_VIEW_RADIUS = 1200;
export const MAX_PENDING_INPUTS = 120;
export type PlayerAppearance = { id: number; color: number; look?: number; hands?: Hands; aim?: 1; item?: string; gear?: number; tiers?: number; down?: [number, number, number] };
export type PlayerPose = [id: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, facing: number, pitch: number, flags: number, nose: number, bike: number];
export type RemotePlayerSnap = PlayerAppearance & Pick<PlayerState, 'x' | 'y' | 'z' | 'vx' | 'vy' | 'vz' | 'facing' | 'grounded' | 'sliding' | 'crouching' | 'riding' | 'jumpHeld' | 'nose' | 'bike'> & { pitch: number };
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function packPlayerPose(id: number, s: PlayerState, pitch: number): PlayerPose {
  const flags = Number(s.grounded) | (Number(s.sliding) << 1) | (Number(s.crouching) << 2) | (Number(s.riding) << 3) | (Number(s.jumpHeld) << 4);
  return [id, r3(s.x), r3(s.y), r3(s.z), r3(s.vx), r3(s.vy), r3(s.vz), r3(s.facing), pitch, flags, r3(s.nose), s.bike];
}

export function unpackPlayerPose(p: PlayerPose, appearance: PlayerAppearance): RemotePlayerSnap {
  return { ...appearance, id: p[0], x: p[1], y: p[2], z: p[3], vx: p[4], vy: p[5], vz: p[6], facing: p[7], pitch: p[8],
    grounded: !!(p[9] & 1), sliding: !!(p[9] & 2), crouching: !!(p[9] & 4), riding: !!(p[9] & 8), jumpHeld: !!(p[9] & 16), nose: p[10], bike: p[11] };
}

export type ChunkData = { data: number[]; rle?: 1 };

/** RLE for sparse/flat chunks; dense, changing chunks use plain values if that is shorter. */
export function encodeChunk(mm: Int32Array): ChunkData {
  const runs: number[] = [];
  for (let i = 0; i < mm.length;) {
    let end = i + 1;
    while (end < mm.length && mm[end] === mm[i]) end++;
    runs.push(end - i, mm[i]);
    i = end;
  }
  return runs.length < mm.length ? { data: runs, rle: 1 } : { data: Array.from(mm) };
}

export function decodeChunk(c: ChunkData): Int32Array | null {
  const size = EDIT_CHUNK * EDIT_CHUNK;
  if (!c.rle) return c.data.length === size ? Int32Array.from(c.data) : null;
  if (c.data.length % 2) return null;
  const mm = new Int32Array(size);
  let at = 0;
  for (let i = 0; i < c.data.length; i += 2) {
    const count = c.data[i];
    if (!Number.isInteger(count) || count <= 0 || at + count > size) return null;
    mm.fill(c.data[i + 1], at, at + count);
    at += count;
  }
  return at === size ? mm : null;
}
