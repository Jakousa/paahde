// Comparing two commits' benchmark runs (docs/bench.md): per number, the change of the median and a 95 % bootstrap interval
// for it (each side's runs resampled), and whether it's a change worth saying: a time moved past its suite's threshold with
// the interval clear of no change, or a count moved at all (past 2 %). As a Markdown report, and a short Discord text.
import { mulberry32 } from '../../shared/noise.ts';
import { COUNT_UNITS, type Sample } from './common.ts';

export type SuiteRuns = { base: Sample[]; head: Sample[]; errors: { base?: string; head?: string } };
export type Results = { base: string; head: string; suites: Record<string, SuiteRuns>; skipped: string[] };

/** What a suite is, and how far its times must move to be flagged (they wobble more in a browser than in a loop). */
export const SUITES: Record<string, { title: string; threshold: number }> = {
  worldgen: { title: 'World generation (shared/, from the seed)', threshold: 0.1 },
  physics: { title: 'Movement physics (shared/sim.ts)', threshold: 0.1 },
  ai: { title: 'Enemies and weather (server/, a simulated minute)', threshold: 0.1 },
  server: { title: 'World server under load (8 players, everything summoned)', threshold: 0.15 },
  client: { title: 'Client in headless Chrome (software rendering, low settings)', threshold: 0.15 },
};
const COUNT_THRESHOLD = 0.02;

export type Row = {
  suite: string; name: string; unit: string; base: number; head: number;
  /** head / base of the medians, and its 95 % interval. */
  ratio: number; lo: number; hi: number;
  flag: 'worse' | 'better' | null;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
};

function bootstrap(b: number[], h: number[], rand: () => number): [number, number] {
  const pick = (xs: number[]) => xs.map(() => xs[Math.floor(rand() * xs.length)]);
  const rs: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const mb = median(pick(b));
    rs.push(mb > 0 ? median(pick(h)) / mb : 1);
  }
  rs.sort((x, y) => x - y);
  return [rs[Math.floor(rs.length * 0.025)], rs[Math.floor(rs.length * 0.975)]];
}

export function compare(r: Results): Row[] {
  const rows: Row[] = [];
  const rand = mulberry32(7);
  for (const [suite, runs] of Object.entries(r.suites)) {
    const names = [...new Set(runs.head.flatMap((s) => Object.keys(s.m)))];
    for (const name of names) {
      const h = runs.head.map((s) => s.m[name]?.[0]).filter((v): v is number => Number.isFinite(v));
      const b = runs.base.map((s) => s.m[name]?.[0]).filter((v): v is number => Number.isFinite(v));
      const unit = runs.head.find((s) => s.m[name])!.m[name][1];
      const mb = median(b), mh = median(h);
      const ratio = b.length && mb > 0 ? mh / mb : b.length && mb === mh ? 1 : NaN;
      const [lo, hi] = b.length && h.length && mb > 0 ? bootstrap(b, h, rand) : [ratio, ratio];
      let flag: Row['flag'] = null;
      if (Number.isFinite(ratio)) {
        const count = COUNT_UNITS.has(unit);
        const t = count ? COUNT_THRESHOLD : SUITES[suite]?.threshold ?? 0.1;
        // A time must also move more than the timer's grain (0.05 ms): a few µs either way on a 0.3 ms number is nothing.
        const big = Math.abs(ratio - 1) >= t && (count || unit !== 'ms' || Math.abs(mh - mb) >= 0.05);
        const sure = count || lo > 1 || hi < 1;
        if (big && sure) flag = ratio > 1 ? 'worse' : 'better';
      }
      rows.push({ suite, name, unit, base: mb, head: mh, ratio, lo, hi, flag });
    }
  }
  return rows;
}

/** Texts (checksums) that differ between the commits: the code now does something else, not just at another speed. */
export function infoChanges(r: Results): { suite: string; name: string; base: string; head: string }[] {
  const out: { suite: string; name: string; base: string; head: string }[] = [];
  for (const [suite, runs] of Object.entries(r.suites)) {
    const names = new Set(runs.head.flatMap((s) => Object.keys(s.info ?? {})));
    for (const name of names) {
      const set = (xs: Sample[]) => [...new Set(xs.map((s) => s.info?.[name]).filter(Boolean))].join(', ');
      const b = set(runs.base), h = set(runs.head);
      if (b && b !== h) out.push({ suite, name, base: b, head: h });
    }
  }
  return out;
}

const fmt = (v: number, unit: string) => {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
  return unit ? `${s} ${unit}` : s;
};
const pct = (r: number) => (Number.isFinite(r) ? `${r >= 1 ? '+' : ''}${((r - 1) * 100).toFixed(1)} %` : '–');
const mark = (f: Row['flag']) => (f === 'worse' ? '🔺' : f === 'better' ? '🟢' : '');
const short = (sha: string) => sha.slice(0, 7);

export function reportMd(r: Results, link?: string): string {
  const rows = compare(r);
  const flagged = rows.filter((x) => x.flag).sort((a, b) => (a.flag === b.flag ? Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1) : a.flag === 'worse' ? -1 : 1));
  const infos = infoChanges(r);
  const out: string[] = [`## Benchmarks: ${short(r.head)} against ${short(r.base)}`, ''];
  out.push(flagged.length ? `**${flagged.length} change${flagged.length > 1 ? 's' : ''} past the noise:**` : 'Nothing moved past the noise.', '');
  for (const x of flagged) out.push(`- ${mark(x.flag)} ${x.suite}: **${x.name}** ${pct(x.ratio)} (${fmt(x.base, x.unit)} → ${fmt(x.head, x.unit)})`);
  for (const x of infos) out.push(`- ↺ ${x.suite}: ${x.name} changed (${x.base} → ${x.head}): the code does something else now, not only at another speed`);
  if (r.skipped.length) out.push('', `_Not run (nothing they measure changed): ${r.skipped.join(', ')}._`);
  for (const [suite, runs] of Object.entries(r.suites)) {
    out.push('', `### ${SUITES[suite]?.title ?? suite}`, '');
    if (runs.errors.head) out.push(`**Failed at ${short(r.head)}:** \`${runs.errors.head.slice(0, 300)}\``, '');
    if (runs.errors.base) out.push(`_Could not run at ${short(r.base)} (older than this benchmark?): \`${runs.errors.base.slice(0, 200)}\`_`, '');
    if (!runs.head.length) continue;
    out.push(`Runs: ${runs.base.length} at the base, ${runs.head.length} here; medians. A time is flagged past ±${Math.round((SUITES[suite]?.threshold ?? 0.1) * 100)} % with its 95 % interval clear of 0, a count past ±${COUNT_THRESHOLD * 100} %.`, '');
    out.push('| | base | head | change | 95 % interval |', '|---|--:|--:|--:|--:|');
    for (const x of rows.filter((o) => o.suite === suite)) {
      const ci = Number.isFinite(x.lo) && runs.base.length ? `${pct(x.lo)} … ${pct(x.hi)}` : '';
      out.push(`| ${mark(x.flag)} ${x.name} | ${fmt(x.base, x.unit)} | ${fmt(x.head, x.unit)} | ${pct(x.ratio)} | ${ci} |`);
    }
  }
  if (link) out.push('', `[The run](${link})`);
  return out.join('\n') + '\n';
}

/** Something to tell the team: a change past the noise, a changed behaviour, or a suite failing here. */
export function worthTelling(r: Results): boolean {
  return compare(r).some((x) => x.flag) || infoChanges(r).length > 0 || Object.values(r.suites).some((s) => s.errors.head);
}

export function discordText(r: Results, link?: string): string {
  const rows = compare(r).filter((x) => x.flag).sort((a, b) => (a.flag === b.flag ? Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1) : a.flag === 'worse' ? -1 : 1));
  const lines = [`**Benchmarks** ${short(r.head)} vs ${short(r.base)}${link ? ` · <${link}>` : ''}`];
  for (const x of rows.slice(0, 12)) lines.push(`${mark(x.flag)} ${x.suite}: ${x.name} ${pct(x.ratio)} (${fmt(x.base, x.unit)} → ${fmt(x.head, x.unit)})`);
  if (rows.length > 12) lines.push(`…and ${rows.length - 12} more`);
  for (const x of infoChanges(r)) lines.push(`↺ ${x.suite}: ${x.name} changed`);
  for (const [suite, s] of Object.entries(r.suites)) if (s.errors.head) lines.push(`❌ ${suite} failed: ${s.errors.head.slice(0, 150)}`);
  return lines.join('\n').slice(0, 1900);
}
