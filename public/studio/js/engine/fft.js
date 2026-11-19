// In-place radix-2 complex FFT with cached twiddles. re/im are Float64Array of length n (power of 2).
const cache = new Map();
function tables(n) {
  let t = cache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n); const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  t = { rev, cos, sin }; cache.set(n, t); return t;
}
export function fft(re, im, inverse = false) {
  const n = re.length; const { rev, cos, sin } = tables(n);
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sgn * sin[k * step];
        const a = s + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
/** Power spectrum (bins 0..n/2) of a windowed real frame. */
export function powerSpectrum(frame, win, out) {
  const n = frame.length; const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * win[i];
  fft(re, im);
  const o = out || new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) o[k] = re[k] * re[k] + im[k] * im[k];
  return o;
}
export const hann = (n) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
export const sqrtHann = (n) => Float64Array.from({ length: n }, (_, i) => Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)));
