/** Shared transient budgets. A warning can replace a quiet effect; effects never replace warnings. */
export class AudioBudget {
  private active: { until: number; priority: number; score: number; stop?: () => void }[] = [];
  dropped = 0;
  stolen = 0;
  peak = 0;
  readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  reserve(now: number, duration: number, priority: number, score: number, stop?: () => void): boolean {
    this.active = this.active.filter((v) => v.until > now);
    if (this.active.length >= this.limit) {
      let i = 0;
      for (let j = 1; j < this.active.length; j++) if (this.active[j].priority < this.active[i].priority ||
        this.active[j].priority === this.active[i].priority && this.active[j].score < this.active[i].score) i = j;
      const old = this.active[i];
      if (priority < old.priority || priority === old.priority && score <= old.score) { this.dropped++; return false; }
      old.stop?.();
      this.active.splice(i, 1);
      this.stolen++;
    }
    this.active.push({ until: now + duration, priority, score, stop });
    this.peak = Math.max(this.peak, this.active.length);
    return true;
  }
  count(now: number) { return this.active.filter((v) => v.until > now).length; }
}
