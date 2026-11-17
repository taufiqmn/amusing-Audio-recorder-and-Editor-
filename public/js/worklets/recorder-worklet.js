// Captures raw 32-bit float microphone samples. Always meters; only records
// between a scheduled start frame and a stop request, so takes start sample-accurately.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.startFrame = Infinity;
    this.chunk = new Float32Array(4096);
    this.fill = 0;
    this.peak = 0;
    this.meterEvery = Math.round(sampleRate / 30 / 128); // ~30 meter updates per second
    this.blocks = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'start') { this.recording = true; this.startFrame = m.startFrame ?? currentFrame; this.fill = 0; }
      else if (m.type === 'stop') {
        if (this.recording) {
          this.recording = false;
          const last = this.chunk.slice(0, this.fill); this.fill = 0;
          this.port.postMessage({ type: 'chunk', data: last, final: true }, [last.buffer]);
        } else this.port.postMessage({ type: 'chunk', data: new Float32Array(0), final: true });
      }
    };
  }
  process(inputs) {
    const input = inputs[0];
    const ch0 = input && input[0];
    if (ch0) {
      // mono mix of all input channels
      const nCh = input.length;
      for (let i = 0; i < ch0.length; i++) {
        let v = ch0[i];
        if (nCh > 1) { for (let c = 1; c < nCh; c++) v += input[c][i]; v /= nCh; }
        const a = v < 0 ? -v : v; if (a > this.peak) this.peak = a;
        if (this.recording && currentFrame + i >= this.startFrame) {
          this.chunk[this.fill++] = v;
          if (this.fill === this.chunk.length) {
            const full = this.chunk; this.chunk = new Float32Array(4096); this.fill = 0;
            this.port.postMessage({ type: 'chunk', data: full }, [full.buffer]);
          }
        }
      }
    }
    if (++this.blocks >= this.meterEvery) {
      this.port.postMessage({ type: 'meter', peak: this.peak });
      this.peak = 0; this.blocks = 0;
    }
    return true;
  }
}
registerProcessor('takeflow-recorder', RecorderProcessor);
