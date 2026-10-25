// Reads the stall telemetry (docs/netcode.md "Telemetry": telemetry.jsonl, written by server/telemetry.ts) and says
// what went wrong, when, for whom, and on whose side.
//
//   node tools/telemetry.ts [report] [options]   digest in the terminal + an HTML report (timeline, round trip and fps
//                                                per player, incidents), opened in the browser
//   node tools/telemetry.ts tail [options]       follow the live file, one coloured line per event
//
// Options:
//   --file <path>     read this file instead of the server's (e.g. data/telemetry.jsonl from `npm run dev`)
//   --host <ssh>      the server to read from over ssh (or set TELEMETRY_SSH)
//   --since <time>    only the last 30m / 6h / 2d, or since an ISO date (default 24h)
//   --max-mb <MiB>    newest log bytes read for a report, 1–256 (default 16)
//   --world <id>      only this world      --player <name>   only this player (name or id)
//   --out <path>      where the HTML goes (default data/telemetry-report.html)   --no-open  don't open it
//
// Stalls close together in one world make an incident, and its verdict follows the rules in docs/netcode.md: a late
// tick is the world's own loop; a `down` for several players at once is the server's side of the network; `down` and
// `up` from one player is their link stalling both ways; `frame` alone is their browser busy.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { REPORT_BYTES, TAIL_FILES, TelemetryTail, telemetryFiles, telemetryLines } from './telemetry-io.ts';

const REMOTE = '/opt/dadajam/data/telemetry.jsonl';
/** Stalls in one world this close (ms) to the last one's end belong to the same incident. */
const JOIN_MS = 1500;
/** A frame this long (ms) right after a player's first event is loading, not play. */
const LOAD_WINDOW_MS = 20_000;
/** A player id quiet this long (ms) is a new session when it comes back: worlds restart and count ids from 1 again. */
const SESSION_GAP_MS = 10 * 60_000;

type Ev = { at: string; w: string; kind: string; p?: number; name?: string; ms?: number; [k: string]: unknown };
/** `s`: the player's session (world, id and a count), set by sessions(). */
type Row = Ev & { t: number; start: number; s?: string };
type Incident = { w: string; start: number; end: number; ms: number; events: Row[]; who: string[]; verdict: string; cause: string };

const args = process.argv.slice(2);
const mode = args[0] && !args[0].startsWith('--') ? args.shift()! : 'report';
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const host = opt('host') ?? process.env.TELEMETRY_SSH ?? '';
const file = opt('file');
if (!host && !file) {
  console.error('Which server? Pass --host <ssh> or set TELEMETRY_SSH (or read a local --file).');
  process.exit(1);
}
const worldOnly = opt('world');
const playerOnly = opt('player');
const since = sinceOf(opt('since') ?? '24h');
const maxMb = Number(opt('max-mb') ?? REPORT_BYTES / 1024 / 1024);
if (!Number.isFinite(maxMb) || maxMb < 1 || maxMb > 256) throw new Error('--max-mb must be between 1 and 256');
const reportBytes = Math.floor(maxMb * 1024 * 1024);

const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2), bold = paint(1), red = paint(31), yellow = paint(33), cyan = paint(36), magenta = paint(35), green = paint(32), blue = paint(34);
const KIND_PAINT: Record<string, (s: string) => string> = { down: red, up: magenta, server: yellow, tick: yellow, frame: cyan, reconnect: blue, backlog: red, summary: dim };

function sinceOf(s: string | undefined): number {
  if (!s) return -Infinity;
  const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(s);
  if (m) return Date.now() - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`--since ${s}: give 30m, 6h, 2d or a date`);
  return t;
}

// SSH concatenates its command arguments remotely, so quote each value as shell data.
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function remotePatterns(rotated: boolean): string {
  const base = [shellQuote(REMOTE), ...(rotated ? [shellQuote(`${REMOTE}.1`)] : [])];
  const stem = REMOTE.replace(/\.jsonl$/, '');
  if (worldOnly) base.push(shellQuote(`${stem}.${worldOnly}.jsonl`), ...(rotated ? [shellQuote(`${stem}.${worldOnly}.jsonl.1`)] : []));
  else base.push(`${shellQuote(`${stem}.`)}*.jsonl`, ...(rotated ? [`${shellQuote(`${stem}.`)}*.jsonl.1`] : []));
  return base.join(' ');
}

async function* read(): AsyncGenerator<string> {
  if (file) {
    const budget = { remaining: reportBytes, truncated: false };
    yield* telemetryLines(telemetryFiles(file, worldOnly), budget);
    if (budget.truncated) console.error(`Report limited to the newest ${maxMb} MiB of logs; narrow --world or raise --max-mb.`);
    return;
  }
  // Bound bytes at the source, before SSH sends them. Paths contain no shell syntax from user input.
  const command = `ls -1t -- ${remotePatterns(true)} 2>/dev/null | (
    left=${reportBytes}
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      size=$(wc -c < "$f") || continue
      if [ "$left" -le 0 ]; then echo 'Telemetry report reached its byte limit; narrow --world or raise --max-mb.' >&2; break; fi
      if [ "$size" -gt "$left" ]; then
        echo 'Telemetry report reached its byte limit; narrow --world or raise --max-mb.' >&2
        tail -c "$left" -- "$f" | sed '1d'
        left=0
      else
        head -c "$size" -- "$f"
        left=$((left - size))
      fi
      printf '\\n'
    done
  )`;
  const ssh = spawn('ssh', [host, command], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<void>((resolve, reject) => {
    ssh.once('error', reject);
    ssh.once('close', (code) => code === 0 ? resolve() : reject(new Error(`ssh exited with ${code}`)));
  });
  void exited.catch(() => {}); // Awaited below; an early spawn failure must not become an unhandled rejection.
  const lines = createInterface({ input: ssh.stdout, crlfDelay: Infinity });
  try { for await (const line of lines) yield line; await exited; }
  finally { lines.close(); if (ssh.exitCode === null) ssh.kill(); }
}

function parseEvent(line: string): Row | null {
  let e: Ev;
  try { e = JSON.parse(line); } catch { return null; }
  if (!e || typeof e !== 'object' || typeof e.kind !== 'string') return null;
  const t = Date.parse(e.at);
  return Number.isNaN(t) ? null : { ...e, t, start: t - (e.kind === 'summary' || e.kind === 'backlog' ? 0 : Number(e.ms) || 0) };
}

function parse(text: string): Row[] {
  return sessions(text.split('\n').map(parseEvent).filter((e): e is Row => !!e).sort((a, b) => a.t - b.t));
}

/** Groups events into player sessions. Ids are reused (the lowest free one, and from 1 again when a world restarts), so
 *  a player is their world and name; an unnamed event goes with whoever had that id last, or stands on its id. A player
 *  quiet for SESSION_GAP_MS starts a new session. */
function sessions(rows: Row[]): Row[] {
  // A player is unnamed for their first seconds: those events go with the name their id gets next.
  const named = new Map<string, Row>(), soon = new Map<Row, string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i], id = `${e.w}/#${e.p}`;
    if (e.p === undefined) continue;
    if (e.name) named.set(id, e);
    else if (named.has(id) && named.get(id)!.start - e.t < 60_000) soon.set(e, named.get(id)!.name!);
  }
  const last = new Map<string, { s: string; t: number; n: number }>();
  const byId = new Map<string, string>();
  for (const e of rows) {
    if (e.p === undefined) continue;
    const id = `${e.w}/#${e.p}`, name = e.name || soon.get(e);
    const who = name ? `${e.w}/${name}` : (byId.get(id) ?? id);
    let cur = last.get(who);
    if (!cur || e.start - cur.t > SESSION_GAP_MS) {
      const n = (cur?.n ?? 0) + 1;
      cur = { s: `${who}/${n}`, t: e.t, n };
      last.set(who, cur);
    }
    cur.t = Math.max(cur.t, e.t);
    if (e.name) byId.set(id, who);
    e.s = cur.s;
  }
  return rows;
}

const keep = (e: Row) =>
  e.t >= since && (!worldOnly || e.w === worldOnly) && (!playerOnly || e.name === playerOnly || String(e.p) === playerOnly || e.p === undefined);

const who = (e: Ev) => (e.p === undefined ? '' : e.name ? e.name : `#${e.p}`);
const playerKey = (e: Row) => e.s ?? `${e.w}/${e.p}`;
const secs = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const clock = (t: number) => new Date(t).toISOString().slice(5, 19).replace('T', ' ');
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

/** Stalls that overlap or follow each other within JOIN_MS in one world, with a verdict on whose side it was. */
function incidents(rows: Row[]): Incident[] {
  const firstSeen = new Map<string, number>();
  for (const e of rows) if (e.p !== undefined && !firstSeen.has(playerKey(e))) firstSeen.set(playerKey(e), e.start);
  const open = new Map<string, Incident>();
  const out: Incident[] = [];
  for (const e of [...rows].filter((e) => e.kind !== 'summary').sort((a, b) => a.start - b.start)) {
    let inc = open.get(e.w);
    if (!inc || e.start > inc.end + JOIN_MS) {
      inc = { w: e.w, start: e.start, end: e.t, ms: 0, events: [], who: [], verdict: '', cause: '' };
      open.set(e.w, inc);
      out.push(inc);
    }
    inc.events.push(e);
    inc.end = Math.max(inc.end, e.t);
  }
  for (const inc of out) {
    inc.ms = inc.end - inc.start;
    inc.who = [...new Set(inc.events.map(who).filter(Boolean))];
    [inc.verdict, inc.cause] = verdict(inc, firstSeen);
  }
  return out;
}

function verdict(inc: Incident, firstSeen: Map<string, number>): [string, string] {
  const by = (k: string) => inc.events.filter((e) => e.kind === k);
  const players = (k: string) => new Set(by(k).map(playerKey));
  const longest = (k: string) => Math.max(0, ...by(k).map((e) => Number(e.ms) || 0));
  if (by('tick').length) return ['world loop', `a tick came ${secs(longest('tick'))} late: the event loop was blocked (server CPU, GC, a slow sync call)`];
  if (players('server').size) return ['world loop', `snapshots stamped ${secs(longest('server'))} apart: the world's loop was late`];
  if (players('down').size >= 2) return ['server network', `${players('down').size} players stopped getting snapshots at once: the server's side of the network`];
  if (by('backlog').length) return ['slow link', `${Math.max(...by('backlog').map((e) => Number(e.bytes) || 0))} bytes queued for ${inc.who.join(', ')} that TCP could not send out`];
  if (by('reconnect').length) return ['disconnect', `offline ${secs(longest('reconnect'))} (close code ${by('reconnect').map((e) => e.code).join(', ')})`];
  const downUp = [...players('down')].filter((k) => players('up').has(k));
  if (downUp.length) return ['player link', 'snapshots and acks stalled together for one player: their link both ways (Wi-Fi, mobile)'];
  if (players('down').size) return ['downlink', 'snapshots stopped for one player while the world ran on time: server → player'];
  if (players('up').size) return ['uplink', "the player's inputs waited for their ack while snapshots came: player → server"];
  if (players('frame').size) {
    const loading = by('frame').every((e) => e.start - (firstSeen.get(playerKey(e)) ?? -Infinity) < LOAD_WINDOW_MS);
    return loading
      ? ['loading', `long frames (${secs(longest('frame'))}) right after joining: shader compiles and uploads`]
      : ['client busy', `${by('frame').length > 1 ? `${by('frame').length} long frames, the worst` : 'a frame took'} ${secs(longest('frame'))}: the browser's main thread (GC, shader compile, a slow system)`];
  }
  return ['other', [...new Set(inc.events.map((e) => e.kind))].join(', ')];
}

type Player = { key: string; w: string; p: number; name: string; first: number; last: number; summaries: Row[]; stalls: Record<string, number>; frameMax: number };

function players(rows: Row[]): Player[] {
  const map = new Map<string, Player>();
  for (const e of rows) {
    if (e.p === undefined) continue;
    let pl = map.get(playerKey(e));
    if (!pl) map.set(playerKey(e), (pl = { key: playerKey(e), w: e.w, p: e.p, name: '', first: e.start, last: e.t, summaries: [], stalls: {}, frameMax: 0 }));
    if (e.name) pl.name = e.name;
    pl.first = Math.min(pl.first, e.start);
    pl.last = Math.max(pl.last, e.t);
    if (e.kind === 'summary') pl.summaries.push(e);
    else pl.stalls[e.kind] = (pl.stalls[e.kind] ?? 0) + 1;
    if (e.kind === 'frame') pl.frameMax = Math.max(pl.frameMax, Number(e.ms) || 0);
  }
  return [...map.values()].sort((a, b) => a.first - b.first);
}

async function report() {
  const rows: Row[] = [];
  let seen = 0;
  for await (const line of read()) {
    const event = parseEvent(line);
    if (!event) continue;
    seen++;
    if (keep(event)) rows.push(event);
  }
  sessions(rows.sort((a, b) => a.t - b.t));
  if (!rows.length) {
    console.log(seen ? 'no events match the filters' : 'no telemetry yet');
    return;
  }
  const incs = incidents(rows);
  const pls = players(rows);
  digest(rows, incs, pls);
  const out = resolve(opt('out') ?? 'data/telemetry-report.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html(rows, incs, pls));
  console.log(`\n${bold('report')} ${out}`);
  if (!args.includes('--no-open')) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [out], { stdio: 'ignore', detached: true }).unref();
}

function digest(rows: Row[], incs: Incident[], pls: Player[]) {
  const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
  const worlds = new Set(rows.map((e) => e.w));
  console.log(`${bold('telemetry')} ${clock(t0)} → ${clock(t1)} UTC · ${rows.length} events · ${worlds.size} worlds · ${pls.length} players`);
  const kinds = new Map<string, number>();
  for (const e of rows) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  console.log([...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => (KIND_PAINT[k] ?? String)(`${k} ${n}`)).join(dim(' · ')));

  const tally = new Map<string, { n: number; ms: number }>();
  for (const i of incs) {
    const s = tally.get(i.verdict) ?? { n: 0, ms: 0 };
    s.n++;
    s.ms += i.ms;
    tally.set(i.verdict, s);
  }
  console.log(`\n${bold('incidents by cause')}`);
  for (const [v, s] of [...tally].sort((a, b) => b[1].ms - a[1].ms)) console.log(`  ${v.padEnd(15)} ${String(s.n).padStart(4)} × · ${secs(s.ms).padStart(6)} stalled in all`);

  console.log(`\n${bold('players')} ${dim('(round trip p50/p95 over their minutes, fps median, stalls)')}`);
  for (const pl of pls) {
    const s = pl.summaries.filter((e) => !e.hidden && Number(e.fps) > 0);
    const rtt50 = pct(s.map((e) => Number(e.rtt50)), 0.5), rtt95 = pct(s.map((e) => Number(e.rtt95)), 0.95), fps = pct(s.map((e) => Number(e.fps)), 0.5);
    const stalls = Object.entries(pl.stalls).map(([k, n]) => (KIND_PAINT[k] ?? String)(`${k} ${n}`)).join(' ');
    const fpsText = Number.isNaN(fps) ? '  –' : String(fps).padStart(3);
    console.log(
      `  ${(pl.name || `#${pl.p}`).padEnd(14).slice(0, 14)} ${dim(pl.w)} ${dim(clock(pl.first).slice(6))}–${dim(clock(pl.last).slice(6))}` +
        `  rtt ${Number.isNaN(rtt50) ? '  –' : String(rtt50).padStart(3)}/${Number.isNaN(rtt95) ? '–' : String(rtt95).padEnd(4)} fps ${fps < 40 ? red(fpsText) : fpsText}  ${stalls}`,
    );
  }

  console.log(`\n${bold('worst incidents')}`);
  for (const i of [...incs].sort((a, b) => b.ms - a.ms).slice(0, 12)) {
    console.log(`  ${clock(i.start)} ${dim(i.w)} ${secs(i.ms).padStart(6)}  ${bold(i.verdict.padEnd(14))} ${i.who.join(', ') || dim('(world)')}`);
    console.log(`  ${' '.repeat(15)}${dim(i.cause)}`);
  }
}

function line(e: Row): string {
  const k = (KIND_PAINT[e.kind] ?? String)(e.kind.padEnd(9));
  const rest =
    e.kind === 'summary'
      ? `rtt ${e.rtt50}/${e.rtt95}/${e.rttMax} gap ${e.gapMax} frame ${e.frameMax} fps ${e.fps}${e.hidden ? ' hidden' : ''}`
      : e.kind === 'backlog'
        ? `${e.bytes} bytes queued`
        : `${secs(Number(e.ms) || 0)}${e.n !== undefined ? ` n=${e.n}` : ''}${e.code !== undefined ? ` code ${e.code}` : ''}${e.players !== undefined ? ` · ${e.players} players` : ''}`;
  return `${dim(clock(e.t))} ${dim(e.w)} ${k} ${(who(e) || '').padEnd(12)} ${rest}`;
}

function tail() {
  const lines = (text: string) => {
    for (const e of parse(text)) if (keep(e)) console.log(line(e));
  };
  if (file) {
    const reader = new TelemetryTail();
    const poll = () => {
      // Include a current name while only its .1 exists during rotation, then cap the active tail set.
      const files = [...new Set(telemetryFiles(file, worldOnly).map((f) => f.endsWith('.1') ? f.slice(0, -2) : f))].slice(0, TAIL_FILES);
      lines(reader.poll(files).join('\n'));
    };
    poll();
    setInterval(poll, 1000);
    return;
  }
  const ssh = spawn('ssh', [host, `ls -1t -- ${remotePatterns(false)} 2>/dev/null | head -n ${TAIL_FILES} | xargs -r tail -n 40 -F --`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  ssh.stdout.setEncoding('utf8');
  ssh.stdout.on('data', (chunk: string) => {
    buf += chunk;
    const cut = buf.lastIndexOf('\n');
    if (cut < 0) return;
    lines(buf.slice(0, cut));
    buf = buf.slice(cut + 1);
  });
  ssh.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ssh.kill());
}

function html(rows: Row[], incs: Incident[], pls: Player[]): string {
  const data = {
    made: new Date().toISOString(),
    source: file ?? `${host}:${REMOTE}`,
    events: rows.map(({ start: _s, ...e }) => e),
    incidents: incs.map((i) => ({ w: i.w, start: i.start, end: i.end, ms: i.ms, who: i.who, keys: [...new Set(i.events.map((e) => e.s).filter(Boolean))], verdict: i.verdict, cause: i.cause, kinds: [...new Set(i.events.map((e) => e.kind))] })),
    players: pls.map(({ summaries: _s, ...p }) => p),
  };
  const page = readFileSync(new URL('./telemetry.html', import.meta.url), 'utf8');
  return page.replace('/*DATA*/null', JSON.stringify(data).replace(/</g, '\\u003c'));
}

if (mode === 'tail') tail();
else if (mode === 'report') await report();
else {
  console.error(`unknown mode '${mode}': report or tail`);
  process.exit(1);
}
