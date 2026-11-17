// Microphone capture. Browser voice processing is OFF by default for studio quality.
export class Recorder {
  constructor(ctx) {
    this.ctx = ctx; this.stream = null; this.node = null; this.source = null;
    this.onMeter = () => {}; this.onChunk = () => {};
    this.chunks = []; this._finish = null; this.deviceId = '';
    this.processing = false; // browser echo/noise/gain processing
    this.clipped = false;
  }

  async open() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record audio. Open the page over https in a current browser.');
    const audio = {
      echoCancellation: this.processing, noiseSuppression: this.processing, autoGainControl: this.processing,
      channelCount: { ideal: 1 },
    };
    if (this.deviceId) audio.deviceId = { exact: this.deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (!this.node) {
      await this.ctx.audioWorklet.addModule(new URL('./worklets/recorder-worklet.js', import.meta.url));
      this.node = new AudioWorkletNode(this.ctx, 'takeflow-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.node.port.onmessage = (e) => this._msg(e.data);
      // the worklet must be pulled by the graph; route it to a silent gain
      this.sink = new GainNode(this.ctx, { gain: 0 });
      this.node.connect(this.sink).connect(this.ctx.destination);
    }
    this.source = new MediaStreamAudioSourceNode(this.ctx, { mediaStream: this.stream });
    this.source.connect(this.node);
    const track = this.stream.getAudioTracks()[0];
    this.label = track?.label || 'Microphone';
    track?.addEventListener('ended', () => this.close());
  }

  close() {
    try { this.source?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.source = null;
  }

  get isOpen() { return !!this.stream; }

  async reopen() { const was = this.isOpen; this.close(); if (was) await this.open(); }

  _msg(m) {
    if (m.type === 'meter') { if (m.peak >= 0.999 && this._recording) this.clipped = true; this.onMeter(m.peak); }
    else if (m.type === 'chunk') {
      if (m.data.length) { this.chunks.push(m.data); this.onChunk(m.data); }
      if (m.final && this._finish) { const f = this._finish; this._finish = null; f(); }
    }
  }

  /** Begin capturing at AudioContext time `when` (seconds). */
  start(when) {
    this.chunks = []; this.clipped = false; this._recording = true;
    const startFrame = Math.round(when * this.ctx.sampleRate);
    this.node.port.postMessage({ type: 'start', startFrame });
  }

  /** Stop and return the full take as one Float32Array. */
  stop() {
    this._recording = false;
    return new Promise((resolve) => {
      this._finish = () => {
        const n = this.chunks.reduce((a, c) => a + c.length, 0);
        const out = new Float32Array(n); let o = 0;
        for (const c of this.chunks) { out.set(c, o); o += c.length; }
        this.chunks = [];
        resolve(out);
      };
      this.node.port.postMessage({ type: 'stop' });
    });
  }

  get recordedSamples() { return this.chunks.reduce((a, c) => a + c.length, 0); }

  static async listInputs() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); }
    catch { return []; }
  }
}

export const looksLikeBluetooth = (label = '') => /bluetooth|airpods|hands-?free|headset|buds|bt\b/i.test(label);
