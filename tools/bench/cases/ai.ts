// Enemies and weather, the server's side (server/guardians.ts with the drones and crawlers, server/bosses.ts,
// server/harvesters.ts, server/storm.ts, server/jets.ts): a minute of night with four players about, everything summoned
// on them, ticked as server/world.ts ticks it (bots at TICK_HZ, weather at the snapshot rate) on a simulated clock, and
// what each player is sent about them built and serialized. The dice are seeded, so both commits fight the same fight.
import { checksum, type Sample } from '../common.ts';

export async function run(): Promise<Sample> {
  const { GuardianServer, TICK_HZ } = await import('../../../server/guardians.ts');
  const { BossServer } = await import('../../../server/bosses.ts');
  const { HarvesterServer } = await import('../../../server/harvesters.ts');
  const { StormServer } = await import('../../../server/storm.ts');
  const { JetServer } = await import('../../../server/jets.ts');
  const { BOSS_KINDS } = await import('../../../shared/bosses.ts');
  const { coreCrashSites } = await import('../../../shared/crashsites.ts');
  const { BASE_SPAWN } = await import('../../../shared/base.ts');
  const { heightAt } = await import('../../../shared/terrain.ts');

  let now = 1_000_000; // server ms
  const guardians = new GuardianServer();
  const bosses = new BossServer();
  const harvesters = new HarvesterServer(now);
  const storms = new StormServer(now);
  const jets = new JetServer(now);

  // Four players: at crawler ground, at guardian ground, out on the dunes twice. They walk small circles.
  const sites = coreCrashSites();
  const at = (level: number) => sites.find((s) => s.level === level) ?? sites[0];
  const homes = [at(1), at(2), { x: BASE_SPAWN.x + 700, z: BASE_SPAWN.z - 900 }, { x: BASE_SPAWN.x - 800, z: BASE_SPAWN.z + 600 }].map((s, i) => ({ x: s.x + 40, z: s.z + 40 * (i % 2 ? 1 : -1) }));
  const players = homes.map((h, id) => ({ id: id + 1, x: h.x, y: heightAt(h.x, h.z), z: h.z, safe: false }));
  const move = (t: number) => {
    for (const [i, p] of players.entries()) {
      const a = t * 0.3 + i;
      p.x = homes[i].x + Math.sin(a) * 12;
      p.z = homes[i].z + Math.cos(a) * 12;
      p.y = heightAt(p.x, p.z);
    }
  };

  guardians.summon('crawlers', players[0], now);
  guardians.summon('guardian', players[1], now);
  guardians.summon('drone', players[2], now);
  guardians.summon('drone', players[3], now);
  for (const [i, kind] of BOSS_KINDS.entries()) bosses.summon(kind, players[i % players.length], now);
  harvesters.spawn(players[3].x, players[3].z, now, true);
  storms.spawn(players[2].x, players[2].z, 0, now);
  jets.spawn(players[3].x, players[3].z, 0, now, true);

  const ms = { guardians: 0, bosses: 0, harvesters: 0, weather: 0, msgs: 0 };
  let bytes = 0, events = 0, kills = 0;
  const tod = 0; // midnight: the drones are out
  const dt = 1 / TICK_HZ;
  for (let t = 0; t < 60 * 20; t++) { // (20 Hz: the snapshots, which carry the weather; the bots every other one)
    now += 50;
    move(t / 20);
    let t0 = performance.now();
    storms.tick(now, players, tod, true);
    jets.tick(now, players);
    ms.weather += performance.now() - t0;
    if (t % Math.round(20 / TICK_HZ)) continue;
    guardians.storms = storms.storms;
    t0 = performance.now();
    const crushed = harvesters.tick(now, players, [], storms.storms);
    const t1 = performance.now();
    ms.harvesters += t1 - t0;
    const r = guardians.tick(dt, now, tod, players);
    const t2 = performance.now();
    ms.guardians += t2 - t1;
    const b = bosses.tick(dt, now, players);
    const t3 = performance.now();
    ms.bosses += t3 - t2;
    for (const p of players) {
      bytes += JSON.stringify(guardians.msg(now, p.id, p.x, p.z)).length;
      for (const m of bosses.msgs(now, p.id, p.x, p.z)) bytes += JSON.stringify(m).length;
    }
    for (const e of r.events) bytes += JSON.stringify(e.msg).length * players.length;
    ms.msgs += performance.now() - t3;
    events += r.events.length + b.events.length;
    kills += crushed.length + r.shot.length + r.blasted.length + b.kills.length;
  }

  return {
    m: {
      'walkers, drones, crawlers': [ms.guardians, 'ms'],
      'bosses (all four)': [ms.bosses, 'ms'],
      'harvester': [ms.harvesters, 'ms'],
      'storms and jets': [ms.weather, 'ms'],
      'messages to players': [ms.msgs, 'ms'],
      'sent to players': [bytes / 1024 / 60, 'KB/s'],
    },
    info: { 'how the fight went': checksum([events, kills, bytes], 0) },
  };
}
