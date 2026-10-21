// Summing up many simulated worlds, and comparing two sets of them (base and head, world by world: the same world ids
// and seeds on both sides, so the difference is the commit, not the dice), as a short Markdown report.
import { seeded } from '../../shared/crash.ts';
import type { RunResult } from './sim.ts';

export type Results = {
  /** What was simulated: the commit, a hash of the simulator's own code, the time cap. */
  sha: string;
  simHash: string;
  capS: number;
  runs: (RunResult & { seed: number; ms: number })[];
};

/** Milestones in the order a player meets them (others follow, sorted by when they're reached). */
const ORDER = [
  'gear:backpack', 'gear:canteen', 'gear:laser_pistol', 'gear:motorcycle', 'gear:spyglass', 'gear:shield', 'gear:laser_rifle', 'q2:laser_rifle',
  'gear:jammer', 'first_jet', 'gear:receiver_colossus', 'boss:colossus', 'gear:receiver_queen', 'boss:queen', 'gear:receiver_carrier', 'boss:carrier',
  'gear:receiver_worm', 'boss:worm', 'won', 'game_over', 'first_death',
];

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};

/** When each world reached milestone `m` (Infinity: never, in the time it had). */
function times(r: Results, m: string): Map<string, number> {
  return new Map(r.runs.map((run) => [run.world, m === 'won' ? run.wonS ?? Infinity : m === 'game_over' ? run.gameOverS ?? Infinity : run.milestones[m] ?? Infinity]));
}

export function milestoneNames(...rs: Results[]): string[] {
  const seen = new Set<string>(['won', 'game_over']);
  for (const r of rs) for (const run of r.runs) for (const m of Object.keys(run.milestones)) seen.add(m);
  const rest = [...seen].filter((m) => !ORDER.includes(m)).sort();
  return [...ORDER.filter((m) => seen.has(m)), ...rest];
}

export type Stat = { reach: number; p10: number; p50: number; p90: number };
export function stat(r: Results, m: string): Stat {
  const ts = [...times(r, m).values()];
  return { reach: ts.filter(Number.isFinite).length / Math.max(1, ts.length), p10: quantile(ts, 0.1), p50: quantile(ts, 0.5), p90: quantile(ts, 0.9) };
}

/** Mean per world of a per-run count table (sources, wait, leftover...). */
function means(r: Results, get: (run: Results['runs'][number]) => Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const run of r.runs) for (const [k, v] of Object.entries(get(run))) out[k] = (out[k] ?? 0) + v / r.runs.length;
  return out;
}
const sourcesOf = (run: Results['runs'][number]) => {
  const flat: Record<string, number> = {};
  for (const [part, by] of Object.entries(run.sources)) for (const [src, n] of Object.entries(by)) flat[`${part}\t${src}`] = n;
  return flat;
};

export type Change = {
  m: string; base: Stat; head: Stat;
  /** Relative change of the median and its 95% bootstrap interval (worlds resampled in pairs; never = the time cap). */
  rel: number; lo: number; hi: number;
  flag: string | null;
};

/** Each milestone base against head, world by world. */
export function compare(base: Results, head: Results, flagRel = 0.1, flagReach = 0.1): Change[] {
  const out: Change[] = [];
  for (const m of milestoneNames(base, head)) {
    const b = times(base, m), h = times(head, m);
    const worlds = [...b.keys()].filter((w) => h.has(w));
    const cap = (x: number, c: number) => (Number.isFinite(x) ? x : c);
    const bs = worlds.map((w) => cap(b.get(w)!, base.capS)), hs = worlds.map((w) => cap(h.get(w)!, head.capS));
    const sb = stat(base, m), sh = stat(head, m);
    const rel = quantile(hs, 0.5) / quantile(bs, 0.5) - 1;
    const rand = seeded(12345);
    const boots: number[] = [];
    for (let k = 0; k < 400; k++) {
      const idx = worlds.map(() => Math.floor(rand() * worlds.length));
      boots.push(quantile(idx.map((i) => hs[i]), 0.5) / quantile(idx.map((i) => bs[i]), 0.5) - 1);
    }
    const lo = quantile(boots, 0.025), hi = quantile(boots, 0.975);
    let flag: string | null = null;
    const dReach = sh.reach - sb.reach;
    if (Math.abs(dReach) >= flagReach) flag = dReach > 0 ? 'reached more often' : 'reached less often';
    else if (Math.abs(rel) >= flagRel && (lo > 0 || hi < 0) && sb.reach > 0.5) flag = rel > 0 ? (m === 'game_over' ? 'later' : 'slower') : m === 'game_over' ? 'sooner' : 'faster';
    out.push({ m, base: sb, head: sh, rel, lo, hi, flag });
  }
  return out;
}

const min = (s: number) => (Number.isFinite(s) ? `${Math.round(s / 60)}` : '—');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%` : '');
const label = (m: string) => m.replace(/^gear:/, '').replace(/^q2:(.*)$/, '$1 (quality)').replace(/^boss:(.*)$/, '☠ $1').replace(/_/g, ' ');

/** The waits that held the top goal up most, minutes per world. */
export function bottlenecks(r: Results, n = 6): [string, number][] {
  return Object.entries(means(r, (run) => run.wait)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, v / 60]);
}

/** A one-set summary (no base to compare with). */
export function summaryMd(r: Results): string {
  const lines = [`## Economy sim · \`${r.sha.slice(0, 7)}\``, '', `${r.runs.length} worlds, ${r.capS / 3600} h of play each (solo).`, '',
    '| milestone | reached | median min | p10–p90 |', '|---|---:|---:|---:|'];
  for (const m of milestoneNames(r)) {
    const s = stat(r, m);
    lines.push(`| ${label(m)} | ${pct(s.reach)} | ${min(s.p50)} | ${min(s.p10)}–${min(s.p90)} |`);
  }
  lines.push('', '**Bottlenecks** (min per world the top goal waited on): ' + bottlenecks(r).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', '));
  return lines.join('\n');
}

/** The report of base against head: what moved first, then everything. */
export function compareMd(base: Results, head: Results, changes: Change[], link?: string): string {
  const flagged = changes.filter((c) => c.flag);
  const out = [`## Economy sim · \`${head.sha.slice(0, 7)}\` vs \`${base.sha.slice(0, 7)}\``, ''];
  out.push(`${head.runs.length} worlds, ${head.capS / 3600} h of solo play each, the same worlds on both sides.${link ? ` [Run](${link})` : ''}`, '');
  if (base.simHash !== head.simHash) out.push('> ⚠️ The simulator itself changed between these: some of the difference may be the yardstick, not the game.', '');
  out.push(flagged.length ? `**${flagged.length} change${flagged.length > 1 ? 's' : ''}:**` : '**No significant change.**', '');
  const row = (c: Change) => `| ${label(c.m)} | ${min(c.base.p50)} → **${min(c.head.p50)}** | ${signed(c.rel)} (${signed(c.lo)}…${signed(c.hi)}) | ${pct(c.base.reach)} → ${pct(c.head.reach)} | ${c.flag ?? ''} |`;
  const head4 = ['| milestone | median min | Δ (95% CI) | reached | |', '|---|---:|---:|---:|---|'];
  if (flagged.length) out.push(...head4, ...flagged.map(row), '');
  out.push('<details><summary>All milestones</summary>', '', ...head4, ...changes.map(row), '', '</details>', '');
  const bb = new Map(bottlenecks(base, 20)), hb = bottlenecks(head);
  out.push('**Bottlenecks** (min per world the top goal waited on, head vs base): ' + hb.map(([k, v]) => `${k} ${v.toFixed(0)} (${(bb.get(k) ?? 0).toFixed(0)})`).join(', '), '');
  // Where parts come from: the per-world counts that moved most.
  const sb = means(base, sourcesOf), sh = means(head, sourcesOf);
  const moved = [...new Set([...Object.keys(sb), ...Object.keys(sh)])]
    .map((k) => ({ k, b: sb[k] ?? 0, h: sh[k] ?? 0 }))
    .filter((x) => Math.abs(x.h - x.b) >= 0.5 && Math.abs(x.h - x.b) / Math.max(x.b, 0.5) >= 0.25)
    .sort((a, b) => Math.abs(b.h - b.b) - Math.abs(a.h - a.b)).slice(0, 12);
  if (moved.length) {
    out.push('<details><summary>Part sources that moved (per world)</summary>', '', '| part | from | base | head |', '|---|---|---:|---:|');
    for (const x of moved) out.push(`| ${x.k.split('\t')[0]} | ${x.k.split('\t')[1]} | ${x.b.toFixed(1)} | ${x.h.toFixed(1)} |`);
    out.push('', '</details>', '');
  }
  const deaths = (r: Results) => r.runs.reduce((a, x) => a + x.deaths, 0) / r.runs.length;
  out.push(`Deaths per world: ${deaths(base).toFixed(1)} → ${deaths(head).toFixed(1)}.`);
  return out.join('\n');
}

/** A Discord message (≤ 2000 characters): the flagged changes, and a link to the full report. */
export function discordText(base: Results, head: Results, changes: Change[], link?: string): string {
  const flagged = changes.filter((c) => c.flag);
  const lines = [`**Economy sim** \`${head.sha.slice(0, 7)}\` vs \`${base.sha.slice(0, 7)}\` (${head.runs.length} worlds)${base.simHash !== head.simHash ? ' · sim changed' : ''}`];
  if (!flagged.length) lines.push('No significant change.');
  for (const c of flagged.slice(0, 15)) lines.push(`• ${label(c.m)}: ${min(c.base.p50)} → ${min(c.head.p50)} min (${signed(c.rel)}), reached ${pct(c.base.reach)} → ${pct(c.head.reach)} — ${c.flag}`);
  if (flagged.length > 15) lines.push(`…and ${flagged.length - 15} more`);
  if (link) lines.push(link);
  return lines.join('\n').slice(0, 1990);
}
