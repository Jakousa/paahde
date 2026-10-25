// Stereo-linked look-ahead limiter. Four-phase, 32-tap reconstruction detects intersample peaks;
// the extra look-ahead lets gain settle before the offending sample reaches the output.
export class LimiterKernel {
  constructor(rate) {
    this.delay = Math.max(192, Math.ceil(rate * 0.004));
    this.size = 2048;
    this.buffers = [new Float64Array(this.size), new Float64Array(this.size)];
    this.peaks = new Float64Array(this.size);
    this.indices = new Float64Array(this.size);
    this.head = this.tail = this.frame = 0;
    this.gain = 1;
    this.release = 1 - Math.exp(-1 / (rate * 0.08));
    this.ceiling = 10 ** (-1.5 / 20);
    this.filters = [0.25, 0.5, 0.75].map((phase) => {
      const taps = new Float64Array(32);
      let sum = 0;
      for (let j = 0; j < 32; j++) {
        const d = phase - (j - 15);
        const sinc = Math.sin(Math.PI * d) / (Math.PI * d);
        taps[j] = sinc * (0.5 + 0.5 * Math.cos(Math.PI * d / 17));
        sum += taps[j];
      }
      for (let j = 0; j < 32; j++) taps[j] /= sum;
      return taps;
    });
  }

  process(input, output) {
    const frames = output[0].length, mask = this.size - 1;
    for (let k = 0; k < frames; k++, this.frame++) {
      const n = this.frame;
      let peak = 0;
      for (let ch = 0; ch < 2; ch++) {
        const b = this.buffers[ch], sample = input[ch]?.[k] ?? input[0]?.[k] ?? 0;
        b[n & mask] = Number.isFinite(sample) ? sample : 0;
        peak = Math.max(peak, Math.abs(b[(n - 16) & mask]));
        for (const filter of this.filters) {
          let v = 0;
          for (let j = 0; j < 32; j++) v += b[(n - 31 + j) & mask] * filter[j];
          peak = Math.max(peak, Math.abs(v));
        }
      }
      while (this.tail > this.head && this.peaks[(this.tail - 1) & mask] <= peak) this.tail--;
      this.peaks[this.tail & mask] = peak;
      this.indices[this.tail++ & mask] = n;
      while (this.head < this.tail && this.indices[this.head & mask] < n - this.delay + 16) this.head++;
      const maximum = this.peaks[this.head & mask];
      const target = maximum > this.ceiling ? this.ceiling / maximum : 1;
      this.gain = Math.min(target, this.gain + (1 - this.gain) * this.release);
      for (let ch = 0; ch < output.length; ch++) output[ch][k] = n < this.delay ? 0 : this.buffers[Math.min(ch, 1)][(n - this.delay) & mask] * this.gain;
    }
  }
}
