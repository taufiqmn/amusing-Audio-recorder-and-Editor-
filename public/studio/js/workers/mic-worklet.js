// Microphone capture for Mic Check and quick recording: raw mono samples plus a level meter.
class StudioMic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.peak = 0; this.k = 0; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      let v = ch[i]; if (inputs[0].length > 1) v = (v + inputs[0][1][i]) / 2;
      const a = Math.abs(v); if (a > this.peak) this.peak = a;
      this.buf[this.n++] = v; if (this.n === this.buf.length) { const d = this.buf; this.buf = new Float32Array(4096); this.n = 0; this.port.postMessage({ data: d }, [d.buffer]); }
    }
    if (++this.k >= 12) { this.port.postMessage({ peak: this.peak }); this.peak = 0; this.k = 0; }
    return true;
  }
}
registerProcessor('studio-mic', StudioMic);
