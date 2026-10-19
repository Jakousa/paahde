// The stats display ("Show stats" in the Esc menu, src/menu.ts): the last five seconds as graphs instead of a line of numbers that flicker too fast to read.
//   - frame time, one bar per frame (ms, with the 60 and 120 fps budgets drawn in), coloured by how far over budget it was: a stutter or an every-other-frame
//     zigzag shows as a pattern, and the numbers above are averaged over half a second (and the slowest 1 % of frames) so they hold still;
//   - draw calls and thousands of triangles per frame as lines;
//   - with adaptive resolution on, the render scale it picked (src/resolution.ts) as a line.
// Fed once a frame by src/main.ts; only drawn while shown. The text line under it (src/menu.ts setInfo) keeps the rarely changing things.

/** Frames kept: about five seconds at 60 fps. */
const N = 300;
const W = 320;
const GRAPH_H = 56;
const H = 176;
/** Taller by the resolution line when adaptive resolution is on. */
const H_RES = 304;
/** Frame time axis (ms): the bars are clamped to this. */
const MAX_MS = 33.4;
const FONT = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';

/** Colour of a frame that took `ms`: green within the 120 fps budget, through yellow at 60 fps, to red. */
function frameColour(ms: number): string {
  if (ms <= 8.4) return '#58d27a';
  if (ms <= 11.2) return '#a4d65a';
  if (ms <= 16.8) return '#e6d150';
  if (ms <= 25) return '#f0963c';
  return '#ee5a4a';
}

export class StatsGraph {
  private el = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private ms = new Float32Array(N);
  private draws = new Float32Array(N);
  private tris = new Float32Array(N);
  private res = new Float32Array(N);
  private cpu = new Float32Array(N);
  private gpu = new Float32Array(N);
  private showGpu = false;
  private showRes = false;
  /** Next slot to write, and how many are filled. */
  private head = 0;
  private count = 0;
  private last = performance.now();
  private on = false;
  private sorted = new Float32Array(N);

  constructor() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.el.width = W * ratio;
    this.el.height = H_RES * ratio;
    this.el.style.cssText = `position:fixed;top:8px;left:8px;width:${W}px;height:${H_RES}px;pointer-events:none;display:none;z-index:20`;
    document.body.appendChild(this.el);
    this.ctx = this.el.getContext('2d')!;
    this.ctx.scale(ratio, ratio);
  }

  set visible(v: boolean) {
    if (v === this.on) return;
    this.on = v;
    this.el.style.display = v ? 'block' : 'none';
  }

  /** Once per rendered frame: the draw calls and (thousands of) triangles of the frame before. */
  frame(draws: number, trisK: number, ratio?: number, cpuMs = 0, gpuMs?: number) {
    this.showRes = ratio !== undefined;
    const now = performance.now();
    const i = this.head;
    this.ms[i] = Math.min(250, now - this.last);
    this.draws[i] = draws;
    this.tris[i] = trisK;
    this.res[i] = ratio ?? 0;
    this.cpu[i] = cpuMs;
    this.gpu[i] = gpuMs ?? 0;
    this.showGpu = gpuMs !== undefined;
    this.last = now;
    this.head = (i + 1) % N;
    this.count = Math.min(N, this.count + 1);
    if (this.on) this.draw();
  }

  /** The value `k` frames back (0 the latest). */
  private at(a: Float32Array, k: number) {
    return a[(this.head - 1 - k + 2 * N) % N];
  }

  private draw() {
    const c = this.ctx, n = this.count;
    c.clearRect(0, 0, W, H_RES);
    c.fillStyle = 'rgba(8, 6, 4, 0.55)';
    c.beginPath();
    c.roundRect(0, 0, W, 86 + 44 * (3 + (this.showGpu ? 1 : 0) + (this.showRes ? 1 : 0)) - 6, 6);
    c.fill();
    c.font = FONT;
    c.textBaseline = 'top';

    // the numbers: averaged over the last 30 frames, and the slowest 1 % of the whole window
    let sum = 0;
    const recent = Math.min(30, n);
    for (let k = 0; k < recent; k++) sum += this.at(this.ms, k);
    const avg = sum / Math.max(1, recent);
    for (let k = 0; k < n; k++) this.sorted[k] = this.at(this.ms, k);
    const view = this.sorted.subarray(0, n).sort();
    const slow = view[Math.min(n - 1, Math.floor(n * 0.99))] || avg;
    c.fillStyle = '#e8e4dc';
    c.fillText(`${(1000 / avg).toFixed(0).padStart(3)} fps  ${avg.toFixed(1).padStart(5)} ms`, 8, 6);
    c.fillStyle = '#a8a298';
    c.fillText(`1% low ${(1000 / slow).toFixed(0).padStart(3)}  worst ${view[n - 1].toFixed(0)} ms`, 156, 6);

    // frame time: a bar per frame, the 60 and 120 fps budgets as lines
    const x0 = 8, y0 = 24, w = W - 16, bw = w / N;
    for (let k = 0; k < n; k++) {
      const ms = this.at(this.ms, k);
      const h = Math.max(1, Math.min(GRAPH_H, (ms / MAX_MS) * GRAPH_H));
      c.fillStyle = frameColour(ms);
      c.fillRect(x0 + w - (k + 1) * bw, y0 + GRAPH_H - h, Math.max(1, bw - 0.25), h);
    }

    for (const [budget, label] of [[16.67, '60'], [8.33, '120']] as const) {
      const y = y0 + GRAPH_H - (budget / MAX_MS) * GRAPH_H;
      c.fillStyle = 'rgba(255,255,255,0.22)';
      c.fillRect(x0, y, w, 1);
      c.fillStyle = 'rgba(255,255,255,0.5)';
      c.fillText(label, x0 + w - 22, y - 11);
    }
    this.line('draws', this.draws, 86, '#7cc4f2', (v) => v.toFixed(0));
    this.line('tris', this.tris, 130, '#f2b87c', (v) => `${v.toFixed(0)}k`);
    this.line('cpu ms', this.cpu, 174, '#e07cc4', (v) => v.toFixed(1));
    let y = 218;
    if (this.showGpu) {
      this.line('gpu ms', this.gpu, y, '#c4a0f2', (v) => v.toFixed(1));
      y += 44;
    }
    if (this.showRes) this.line('scale', this.res, y, '#b8e07c', (v) => `${v.toFixed(2)}x`);
  }

  /** A labelled line graph of the last frames of `a`, from its lowest to its highest value, with the latest value written beside the label. */
  private line(label: string, a: Float32Array, y: number, colour: string, fmt: (v: number) => string) {
    const c = this.ctx, n = this.count, h = 26, x0 = 8, w = W - 16;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < n; k++) {
      const v = this.at(a, k);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo < hi * 0.1) lo = Math.max(0, hi * 0.9 - 1); // (a steady value reads as a steady line, not as magnified noise)
    const span = Math.max(1e-6, hi - lo);
    c.fillStyle = '#a8a298';
    c.fillText(`${label} ${fmt(this.at(a, 0))}`, x0, y - 1);
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillText(`${fmt(hi)}`, x0 + w - 6 * fmt(hi).length, y - 1);
    const gy = y + 12;
    c.strokeStyle = colour;
    c.lineWidth = 1.25;
    c.beginPath();
    for (let k = n - 1; k >= 0; k--) {
      const px = x0 + w - (k / N) * w, py = gy + h - ((this.at(a, k) - lo) / span) * h;
      if (k === n - 1) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();
  }
}
