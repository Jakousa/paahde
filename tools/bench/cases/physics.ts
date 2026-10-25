// Movement physics (shared/sim.ts step, what the server runs for every player at 60 Hz and the client re-runs to predict):
// a minute of scripted input in a few kinds of place, and a minute on the motorcycle. Each also gives a checksum of where
// it ended up: if that changes, the physics does something else now (and old clients would rubber-band against it).
import { checksum, originFront, time, type Sample } from '../common.ts';

export async function run(): Promise<Sample> {
  const { spawnState, spawnPoint, step, quantizeYaw, TICK_RATE, FORWARD, LEFT, RIGHT, JUMP, SLIDE, CROUCH } = await import('../../../shared/sim.ts');
  const ORIGIN_FRONT = await originFront();
  const { crashSitesNear } = await import('../../../shared/crashsites.ts');
  const { sheltersNear } = await import('../../../shared/shelters.ts');
  type State = ReturnType<typeof spawnState>;

  /** Input at tick `t` of a walk: forward, a slow weave, a jump every 2 s, a slide every 7 s, crouching a while. */
  const walkInput = (t: number) => {
    let k = FORWARD;
    if (t % 120 < 6) k |= JUMP;
    if (t % 420 < 30) k |= SLIDE;
    if (t % 600 > 540) k |= CROUCH;
    if (t % 300 < 40) k |= t % 600 < 300 ? LEFT : RIGHT;
    return k;
  };
  const walkYaw = (t: number) => quantizeYaw(Math.sin(t / 300) * 1.5 + t / 900);
  /** A minute (or `seconds`) from `s`: the end state and the ms it took (the fastest of three goes: a minute is only
   *  ~10 ms, short enough for one hiccup of the machine to show). */
  const go = (from: State, input: (t: number) => number, yaw: (t: number) => number, seconds = 60) => {
    let s = from, ms = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      s = from;
      ms = Math.min(ms, time(() => {
        for (let t = 0; t < seconds * TICK_RATE; t++) s = step(s, input(t), yaw(t));
      }));
    }
    return { s, ms };
  };

  const field = crashSitesNear(ORIGIN_FRONT.x, ORIGIN_FRONT.z, 3000).find((o) => o.level === 0);
  const shelter = sheltersNear(ORIGIN_FRONT.x, ORIGIN_FRONT.z, 6000)[0];
  const places: [string, State][] = [
    ['spawn', spawnState(spawnPoint().x, spawnPoint().z)],
    ['origin', spawnState(ORIGIN_FRONT.x, ORIGIN_FRONT.z)],
    ...(field ? [['scrap field', spawnState(field.x + field.radius, field.z)] as [string, State]] : []),
    ...(shelter ? [['shelter', spawnState(shelter.x + shelter.dx * 4, shelter.z + shelter.dz * 4)] as [string, State]] : []),
    ['open dunes', spawnState(ORIGIN_FRONT.x + 700, ORIGIN_FRONT.z - 900)],
  ];
  // Warm the heightfield's caches and the JIT first: the numbers are the physics, not the first touch of the sand.
  for (const [, s] of places) go(s, walkInput, walkYaw, 5);

  const m: Sample['m'] = {};
  const ends: number[] = [];
  let total = 0;
  for (const [name, s] of places) {
    const r = go(s, walkInput, walkYaw);
    m[`walk a minute: ${name}`] = [r.ms, 'ms'];
    total += r.ms;
    ends.push(r.s.x, r.s.y, r.s.z, r.s.vx, r.s.vy, r.s.vz);
  }
  m['walking, per step'] = [(total / (places.length * 60 * TICK_RATE)) * 1000, 'µs'];

  // The motorcycle: on it at the start (bike 2: a basic one), full throttle with long turns and a jump now and then.
  const bike = { ...spawnState(ORIGIN_FRONT.x + 700, ORIGIN_FRONT.z - 900), riding: true, bike: 2 } as State;
  const ride = go(bike, (t) => FORWARD | (t % 240 < 60 ? LEFT : 0) | (t % 600 < 4 ? JUMP : 0), (t) => quantizeYaw(t / 200));
  m['ride a minute'] = [ride.ms, 'ms'];
  ends.push(ride.s.x, ride.s.y, ride.s.z, ride.s.heading, ride.s.nose);

  return { m, info: { 'where the physics took them': checksum(ends) } };
}
