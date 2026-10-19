"""Read a Chrome performance trace (DevTools > Performance > save profile, a .json or .json.gz) of the game and say where the time goes.

    python tools/trace-report.py <trace file> [frames|profile|compare]

  frames    frame pacing of the render loop (frame gaps and work per frame), long tasks, and how much the main thread is busy
  profile   the main thread's CPU profile: self time by function, and by our own source files (inclusive)
  compare   splits the frames into fast (< 12.5 ms apart) and slow (> 15.5 ms) and shows what the slow ones spend more time on, main thread and
            every other thread: tells a CPU-bound frame (the JS grew) from a GPU-bound one (the main thread waits in native code)

With no mode it prints frames, then profile. Needs only the standard library. Reading a 50 MB trace takes ~30 s.
What it showed so far (see docs/machines.md "Performance"): the game's own code is under 1 % of a frame; the cost is three.js drawing (objects, shadow
cascades) and the GPU.
"""

import bisect
import gzip
import json
import sys
from collections import Counter, defaultdict


def load(path):
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt', encoding='utf8') as f:
        d = json.load(f)
    return d['traceEvents'] if isinstance(d, dict) else d


def main_thread(ev):
    names = {}
    for e in ev:
        if e.get('name') == 'thread_name':
            names[(e['pid'], e['tid'])] = e['args']['name']
    cnt = Counter((e['pid'], e['tid']) for e in ev if 'pid' in e)
    pid, tid = sorted([k for k, v in names.items() if v == 'CrRendererMain'], key=lambda k: -cnt[k])[0]
    return pid, tid, names


def frames(ev):
    pid, tid, _ = main_thread(ev)
    tasks = sorted([e for e in ev if e.get('pid') == pid and e.get('tid') == tid and e.get('name') == 'RunTask' and e.get('ph') == 'X'], key=lambda e: e['ts'])
    t0 = tasks[0]['ts']
    af = sorted([e for e in ev if e.get('pid') == pid and e.get('tid') == tid and e.get('name') == 'FireAnimationFrame' and e.get('ph') == 'X'], key=lambda e: e['ts'])
    print(f'span {(tasks[-1]["ts"] + tasks[-1]["dur"] - t0) / 1e6:.1f} s, {len(af)} animation frames')
    if len(af) > 2:
        gaps = sorted((af[i + 1]['ts'] - af[i]['ts']) / 1e3 for i in range(len(af) - 1))
        work = sorted(e['dur'] / 1e3 for e in af)
        q = lambda a, p: a[min(len(a) - 1, int(len(a) * p))]
        print(f'frame gap ms  median {q(gaps, .5):.1f}  p90 {q(gaps, .9):.1f}  p99 {q(gaps, .99):.1f}  max {gaps[-1]:.1f}   (median fps {1000 / q(gaps, .5):.0f})')
        print(f'frame work ms median {q(work, .5):.1f}  p90 {q(work, .9):.1f}  max {work[-1]:.1f}')
        busy = sum(e['dur'] for e in af) / (af[-1]['ts'] - af[0]['ts'])
        print(f'main thread busy in frames: {100 * busy:.0f} %  (near 100 % = CPU-bound; well under with slow frames = waiting on the GPU)')
        sec = defaultdict(list)
        for i in range(len(af) - 1):
            sec[int((af[i]['ts'] - t0) / 1e6)].append((af[i + 1]['ts'] - af[i]['ts']) / 1e3)
        print('fps by second: ' + ' '.join(f'{s}:{1000 / (sum(v) / len(v)):.0f}' for s, v in sorted(sec.items())))
    long = [e for e in tasks if e['dur'] > 50000]
    print(f'long tasks > 50 ms: {len(long)}')
    for e in sorted(long, key=lambda e: -e['dur'])[:8]:
        print(f'  at {(e["ts"] - t0) / 1e6:.2f} s  {e["dur"] / 1e3:.0f} ms')


def profile_of(ev):
    pid, tid, _ = main_thread(ev)
    prof = {e['id']: (e['tid'], e['args']['data'].get('startTime', e['ts'])) for e in ev if e.get('name') == 'Profile' and e.get('pid') == pid}
    pid_main = [i for i, (t, _) in prof.items() if t == tid]
    if not pid_main:
        return None
    pid_main = pid_main[0]
    nodes, parent, samples, deltas = {}, {}, [], []
    for e in ev:
        if e.get('name') == 'ProfileChunk' and e.get('id') == pid_main:
            cp = e['args']['data'].get('cpuProfile', {})
            for n in cp.get('nodes', []):
                nodes[n['id']] = n
                for c in n.get('children', []):
                    parent[c] = n['id']
            samples += cp.get('samples', [])
            deltas += e['args']['data'].get('timeDeltas', [])
    times, t = [], prof[pid_main][1]
    for dt in deltas:
        t += dt
        times.append(t)
    return nodes, parent, samples, deltas, times


def label(n):
    cf = n['callFrame']
    return f"{cf['functionName'] or '(anon)'} {cf.get('url', '').split('/')[-1].split('?')[0]}:{cf.get('lineNumber')}"


def profile(ev):
    p = profile_of(ev)
    if not p:
        print('no CPU profile in this trace (record with the JavaScript sampling on)')
        return
    nodes, parent, samples, deltas, _ = p
    selfc, incl = Counter(), Counter()
    for s, dt in zip(samples, deltas):
        n = nodes.get(s)
        if not n:
            continue
        selfc[label(n)] += dt
        seen, x = set(), s
        while x is not None:
            nn = nodes.get(x)
            if nn:
                l = label(nn)
                if l not in seen:
                    incl[l] += dt
                    seen.add(l)
            x = parent.get(x)
    tot = sum(selfc.values())
    print(f'{len(samples)} samples, {tot / 1e3:.0f} ms')
    print('SELF time')
    for k, v in selfc.most_common(25):
        print(f'{v / 1e3:8.0f} ms {100 * v / tot:5.1f}%  {k}')
    print('INCLUSIVE time of our own source (src/ and shared/)')
    for k, v in [(k, v) for k, v in incl.most_common(300) if '.ts:' in k][:25]:
        print(f'{v / 1e3:8.0f} ms {100 * v / tot:5.1f}%  {k}')


def compare(ev):
    pid, tid, names = main_thread(ev)
    af = sorted([(e['ts'], e['dur']) for e in ev if e.get('pid') == pid and e.get('tid') == tid and e.get('name') == 'FireAnimationFrame' and e.get('ph') == 'X'])
    cls = []
    for i in range(len(af) - 1):
        gap = (af[i + 1][0] - af[i][0]) / 1e3
        cls.append((af[i][0], af[i + 1][0], 'fast' if gap < 12.5 else 'slow' if gap > 15.5 else 'mid'))
    starts = [c[0] for c in cls]
    nfr = Counter(c[2] for c in cls)
    print('frames:', dict(nfr))
    if not nfr['fast'] or not nfr['slow']:
        print('need both fast and slow frames to compare')
        return
    acc = {'fast': defaultdict(float), 'slow': defaultdict(float)}
    for e in ev:
        if e.get('ph') != 'X' or 'dur' not in e:
            continue
        i = bisect.bisect_right(starts, e['ts']) - 1
        if i < 0 or i >= len(cls) or e['ts'] > cls[i][1] or cls[i][2] == 'mid':
            continue
        acc[cls[i][2]][(names.get((e['pid'], e['tid']), '?'), e['name'])] += e['dur'] / 1e3
    rows = sorted(((acc['slow'][k] / nfr['slow'] - acc['fast'][k] / nfr['fast'], acc['fast'][k] / nfr['fast'], acc['slow'][k] / nfr['slow'], k)
                   for k in set(acc['fast']) | set(acc['slow'])), reverse=True)
    print('per frame, ms (all threads):   fast    slow    diff')
    for dd, f, s, k in rows[:18]:
        print(f'  {f:7.2f} {s:7.2f} {dd:+7.2f}  {k}')
    p = profile_of(ev)
    if p:
        nodes, _, samples, deltas, times = p
        iv = sum(deltas) / len(deltas) / 1e3
        selfc = {'fast': Counter(), 'slow': Counter()}
        for s, tm in zip(samples, times):
            i = bisect.bisect_right(starts, tm) - 1
            if i < 0 or i >= len(cls) or tm > cls[i][1] or cls[i][2] == 'mid':
                continue
            n = nodes.get(s)
            if n:
                selfc[cls[i][2]][label(n)] += 1
        rows = sorted(((selfc['slow'][k] * iv / nfr['slow'] - selfc['fast'][k] * iv / nfr['fast'], k) for k in set(selfc['fast']) | set(selfc['slow'])), reverse=True)
        print('main-thread self time that grows in slow frames (ms per frame); "(program)" = native code, often waiting on the GPU:')
        for dd, k in rows[:12]:
            print(f'  {dd:+6.2f}  {k}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    ev = load(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else None
    if mode in (None, 'frames'):
        frames(ev)
    if mode in (None, 'profile'):
        profile(ev)
    if mode == 'compare':
        compare(ev)
