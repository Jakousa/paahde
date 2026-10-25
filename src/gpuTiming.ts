/** Timestamp readbacks arrive late and can contain several frames, or the same batch again.
 * Keep frame identity; never count a cached resolve result as another rendered frame. */
export class GpuTiming {
  private lastFrame = -1;
  accepted = 0;
  rejected = 0;
  maxRawMs = 0;
  private recent: boolean[] = [];
  get reliable() { return this.recent.length >= 10 && this.recent.filter(Boolean).length >= this.recent.length * 0.8; }

  read(timestamps: ReadonlyMap<string, number>, frameGap: (frame: number) => number | undefined) {
    const frames = new Map<number, Map<string, number>>();
    for (const [uid, ms] of timestamps) {
      const match = /^r:[^:]+:([^:]+):f(\d+)$/.exec(uid);
      if (!match) continue;
      const frame = Number(match[2]);
      if (frame <= this.lastFrame) continue;
      let passes = frames.get(frame);
      if (!passes) frames.set(frame, passes = new Map());
      passes.set(match[1], (passes.get(match[1]) ?? 0) + ms);
    }
    const fresh: { frame: number; ms: number; passes: Map<string, number> }[] = [];
    for (const [frame, passes] of [...frames].sort(([a], [b]) => a - b)) {
      this.lastFrame = frame;
      const ms = [...passes.values()].reduce((a, b) => a + b, 0);
      if (Number.isFinite(ms)) this.maxRawMs = Math.max(this.maxRawMs, ms);
      const gap = frameGap(frame);
      // A huge summed duration inconsistent with presentation is not useful evidence of a bottleneck.
      // Reject it explicitly rather than displaying the last good sample as if it were fresh.
      const valid = gap !== undefined && Number.isFinite(ms) && ms > 0 && [...passes.values()].every(v => v >= 0)
        && ms <= Math.max(50, gap * 2);
      this.recent.push(valid);
      if (this.recent.length > 60) this.recent.shift();
      if (!valid) {
        this.rejected++;
        continue;
      }
      this.accepted++;
      fresh.push({ frame, ms, passes });
    }
    return fresh;
  }
}
