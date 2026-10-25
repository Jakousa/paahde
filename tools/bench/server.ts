// The whole world server under load (docs/bench.md): server/world.ts of the tree `dir`, as server/index.ts forks it (a fresh
// database of the bench world, tools/bench/serverHook.ts preloaded), with eight bot players joined over WebSockets at the
// dev spawns, walking with input at 60 Hz like a client. A few seconds in, one of them makes it night and summons
// everything on them (a storm, a jet, a harvester, walkers, drones, crawlers, the four bosses); then 30 s are measured: the
// 60 Hz loop, CPU, how busy the event loop is, memory, and what each player is sent. Prints a Sample (tools/bench/common.ts).
//
//   node tools/bench/server.ts [dir] [--seconds 30] [--bots 8] [--types (what the players were sent, by message type, to stderr)]
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BENCH_WORLD_ID, type Sample } from './common.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const SECONDS = Number(opt('seconds', '30'));
const BOTS = Number(opt('bots', '8'));
/** Seconds after everyone joined before the summons, and after the summons before measuring (they arrive, the bosses
 *  rise, the first deaths and the terrain's craters go out). */
const SETTLE_S = 3, WARM_S = 4;
/** Where each bot starts (the server's dev spawns; null: where new players start, by the pods (the crashed ship before them) or, in older commits, the bunker). */
const SPAWNS = [null, 'field', 'shelter', 'crash', 'field', null, 'shelter', 'canyon'] as const;
/** shared/sim.ts input bits (fixed here: the driver must speak to old commits too). */
const FORWARD = 1, LEFT = 4, RIGHT = 8, JUMP = 16, SLIDE = 256;
/** shared/sun.ts: a day is 30 min, shifted by 0.3 of a day. */
const DAY_MS = 30 * 60 * 1000, DAY_OFFSET = 0.3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const data = mkdtempSync(join(tmpdir(), 'dadajam-bench-'));
const started = performance.now();
const child = fork(join(dir, 'server/world.ts'), {
  cwd: dir,
  env: { ...process.env, WORLD_ID: BENCH_WORLD_ID, DB_PATH: join(data, `${BENCH_WORLD_ID}.db`), TELEMETRY_PATH: join(data, 'telemetry.jsonl') },
  execArgv: ['--no-warnings', '--import', pathToFileURL(join(import.meta.dirname, 'serverHook.ts')).href],
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const ask = <T>(t: string) => new Promise<T>((res) => {
  const on = (m: { t?: string }) => m?.t === t && (child.off('message', on), res(m as T));
  child.on('message', on);
  child.send({ t });
});
const port = await new Promise<number>((res, rej) => {
  child.on('message', (m: { t?: string; port?: number }) => m?.t === 'port' && res(m.port!));
  child.on('exit', (code) => rej(new Error(`the world exited (${code})`)));
});
const startupMs = performance.now() - started;

type Bot = { ws: WebSocket; seq: number; bytes: number; msgs: number; snapTime: number; joinMs: number };
/** Bytes sent by message type, over all players (--types). */
const byType = new Map<string, number>();
const bots: Bot[] = [];
for (let i = 0; i < BOTS; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const bot: Bot = { ws, seq: 0, bytes: 0, msgs: 0, snapTime: 0, joinMs: 0 };
  const t0 = performance.now();
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'hello', protocol: 1, browserId: randomUUID(), name: `Bench${i + 1}`, ...(SPAWNS[i % SPAWNS.length] ? { spawn: SPAWNS[i % SPAWNS.length] } : {}) }));
    ws.send(JSON.stringify({ t: 'ready' }));
  };
  ws.onmessage = (e) => {
    const text = String(e.data);
    bot.bytes += text.length;
    bot.msgs++;
    if (text.startsWith('{"t":"snap"')) {
      if (!bot.joinMs) bot.joinMs = performance.now() - t0;
      bot.snapTime = (JSON.parse(text) as { time: number }).time;
    }
    const type = /^\{"t":"(\w+)"/.exec(text)?.[1] ?? '?';
    byType.set(type, (byType.get(type) ?? 0) + text.length);
  };
  bots.push(bot);
}
while (bots.some((b) => !b.joinMs)) await sleep(50);
const joinMs = Math.max(...bots.map((b) => b.joinMs));

// Input like a client's: every tick, forward with a weave, a jump and a slide now and then (each bot its own phase).
let tick = 0;
const input = setInterval(() => {
  tick++;
  for (const [i, b] of bots.entries()) {
    if (b.ws.readyState !== WebSocket.OPEN) continue;
    const t = tick + i * 97;
    const k = FORWARD | (t % 120 < 6 ? JUMP : 0) | (t % 420 < 30 ? SLIDE : 0) | (t % 300 < 40 ? (t % 600 < 300 ? LEFT : RIGHT) : 0);
    const yaw = Math.round((((Math.sin(t / 300) * 1.5 + t / 900 + i) / (2 * Math.PI)) % 1 + 1) % 1 * 65536) % 65536;
    b.ws.send(JSON.stringify({ t: 'input', seq: ++b.seq, input: k, yaw, pitch: 0 }));
  }
}, 1000 / 60);

await sleep(SETTLE_S * 1000);
const say = (b: Bot, msg: object) => b.ws.readyState === WebSocket.OPEN && b.ws.send(JSON.stringify(msg));
// Midnight (shared/sun.ts timeOfDayAt), from the server's clock in the last snapshot: the drones are out.
const serverNow = bots[0].snapTime;
say(bots[0], { t: 'setEpoch', epoch: Math.ceil((serverNow / DAY_MS + DAY_OFFSET) + 1) * DAY_MS - DAY_OFFSET * DAY_MS - serverNow });
const summons: [number, object][] = [
  [0, { t: 'storm' }], [1, { t: 'summon', what: 'jet' }], [2, { t: 'summon', what: 'harvester' }], [3, { t: 'summon', what: 'crawlers' }],
  [4, { t: 'summon', what: 'guardian' }], [5, { t: 'summon', what: 'drone' }], [6, { t: 'summon', what: 'drone' }],
  [0, { t: 'summon', what: 'worm' }], [2, { t: 'summon', what: 'carrier' }], [4, { t: 'summon', what: 'colossus' }], [6, { t: 'summon', what: 'queen' }],
];
for (const [i, msg] of summons) say(bots[i % bots.length], msg);
await sleep(WARM_S * 1000);

child.send({ t: 'bench-reset' });
for (const b of bots) (b.bytes = 0), (b.msgs = 0);
byType.clear();
await sleep(SECONDS * 1000);
type Stats = { wallMs: number; cpuMs: number; elu: number; rssMB: number; heapMB: number; loops: Record<string, { n: number; p50: number; p99: number; max: number; mean: number }> };
const s = await ask<Stats>('bench-stats');
clearInterval(input);
const kb = bots.reduce((a, b) => a + b.bytes, 0) / bots.length / 1024 / (s.wallMs / 1000);
const msgs = bots.reduce((a, b) => a + b.msgs, 0) / bots.length / (s.wallMs / 1000);
for (const b of bots) b.ws.close();
child.kill('SIGTERM');
await new Promise((r) => child.once('exit', r));
rmSync(data, { recursive: true, force: true });

const tickLoop = s.loops[String(1000 / 60)] ?? { n: 0, p50: 0, p99: 0, max: 0, mean: 0 };
const sample: Sample = {
  m: {
    'world process start': [startupMs, 'ms'],
    'all joined (first snapshot)': [joinMs, 'ms'],
    'CPU per second': [s.cpuMs / (s.wallMs / 1000), 'ms'],
    'event loop busy': [s.elu * 100, '%'],
    '60 Hz tick, mean': [tickLoop.mean, 'ms'],
    '60 Hz tick, p99': [tickLoop.p99, 'ms'],
    '60 Hz tick, max': [tickLoop.max, 'ms'],
    'sent to each player': [kb, 'KB/s'],
    'messages to each player': [msgs, 'msg/s'],
    'memory (RSS)': [s.rssMB, 'MB'],
  },
};
if (args.includes('--types')) for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) process.stderr.write(`${t}\t${(n / BOTS / 1024 / (s.wallMs / 1000)).toFixed(2)} KB/s\n`);
process.stdout.write(JSON.stringify(sample) + '\n');
process.exit(0);
