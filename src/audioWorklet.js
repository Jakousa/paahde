import { LimiterKernel } from './limiterKernel.mjs';

registerProcessor('paahde-limiter', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.kernel = new LimiterKernel(sampleRate);
    this.recording = null;
    this.port.onmessage = ({ data }) => {
      if (data.capture) this.recording = { left: [], right: [], leftFrames: Math.min(sampleRate * 60, data.capture), frames: 0 };
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out.length) return true;
    this.kernel.process(inputs[0] ?? [], out);
    const r = this.recording;
    if (r) {
      const n = Math.min(out[0].length, r.leftFrames);
      r.left.push(out[0].slice(0, n)); r.right.push((out[1] ?? out[0]).slice(0, n));
      r.frames += n; r.leftFrames -= n;
      if (!r.leftFrames) {
        this.port.postMessage({ capture: r, sampleRate });
        this.recording = null;
      }
    }
    return true;
  }
});
