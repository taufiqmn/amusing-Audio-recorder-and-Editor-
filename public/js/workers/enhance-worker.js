// Runs the enhancement chain off the main thread.
import { enhance } from '../enhance.js';
import createRNNoise from '../vendor/rnnoise.js';

let modP = null;
function rnModule() {
  if (!modP) {
    modP = fetch(new URL('../vendor/rnnoise.wasm', import.meta.url))
      .then((r) => { if (!r.ok) throw new Error('Could not load the noise removal model'); return r.arrayBuffer(); })
      .then((buf) => createRNNoise({ wasmBinary: buf }));
  }
  return modP;
}

self.onmessage = async (e) => {
  const { id, audio, sampleRate, params } = e.data;
  try {
    const Module = params.denoise > 0 ? await rnModule() : null;
    let last = 0;
    const res = enhance(audio, sampleRate, params, Module, (f, label) => {
      const now = performance.now();
      if (now - last > 80 || f >= 1) { last = now; self.postMessage({ id, type: 'progress', value: f, label }); }
    });
    self.postMessage({ id, type: 'done', audio: res.audio, report: res.report }, [res.audio.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
