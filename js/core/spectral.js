// Spectrograms: the short-time Fourier transform of a recording (how loud each frequency is,
// moment by moment), edits on it, and the way back to sound. No DOM or audio here, so the tests
// can run it.
//
//   const s = stft(samples, { size: 2048, hop: 512 })   → { size, hop, frames, bins, re: [Float32Array], im: [...] }
//   brush(s, op, { frame, bin… })                       edits it in place (see brush)
//   istft(s, length)                                    → Float32Array, the sound again
//
// Analysis and synthesis both use a sqrt-Hann window at 75% overlap, which adds back up to a flat
// gain (divided out), so an unedited spectrogram comes back as the same samples.

export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const windows = new Map();
function sqrtHann(n) {
  if (!windows.has(n)) windows.set(n, Float32Array.from({ length: n }, (_, i) => Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / n))));
  return windows.get(n);
}

export function stft(x, { size = 2048, hop = size / 4 } = {}) {
  const w = sqrtHann(size), bins = size / 2 + 1;
  // Frames start before 0 and run past the end so every sample is covered by four windows.
  const frames = Math.ceil((x.length + size) / hop);
  const re = [], im = [], fr = new Float32Array(size), fi = new Float32Array(size);
  for (let f = 0; f < frames; f++) {
    const at = f * hop - size;
    for (let i = 0; i < size; i++) { const k = at + i; fr[i] = k >= 0 && k < x.length ? x[k] * w[i] : 0; fi[i] = 0; }
    fft(fr, fi);
    re.push(fr.slice(0, bins));
    im.push(fi.slice(0, bins));
  }
  return { size, hop, frames, bins, re, im };
}

export function istft(s, length) {
  const { size, hop, frames, bins } = s, w = sqrtHann(size), out = new Float32Array(length);
  const fr = new Float32Array(size), fi = new Float32Array(size);
  // sqrt-Hann twice = Hann; Hann at hop size/4 sums to 2.
  const norm = 1 / (size / hop / 2);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < bins; k++) { fr[k] = s.re[f][k]; fi[k] = s.im[f][k]; }
    for (let k = bins; k < size; k++) { fr[k] = fr[size - k]; fi[k] = -fi[size - k]; } // mirror: a real signal
    fft(fr, fi, true);
    const at = f * hop - size;
    for (let i = 0; i < size; i++) { const k = at + i; if (k >= 0 && k < length) out[k] += fr[i] * w[i] * norm; }
  }
  return out;
}

export const copySpec = s => ({ ...s, re: s.re.map(a => a.slice()), im: s.im.map(a => a.slice()) });

// Magnitude in dB (0 dB = a full-scale sine) for drawing.
export function dbAt(s, f, k) {
  const m = Math.hypot(s.re[f][k], s.im[f][k]) / (s.size / 4);
  return 20 * Math.log10(m + 1e-9);
}

// An edit at some cells of the spectrogram: `cells` is [[frame, fromBin, toBin, weight 0–1], …]
// (the page works out which cells a brush stroke covers). Ops:
//   erase    the sound there disappears (weight = how much)
//   quieter  −12 dB at full weight        louder  +12 dB
//   smear    each cell takes on the average level of its neighbours in time (a blur that makes
//            notes ring and transients wash out), keeping its own phase
export function brush(s, op, cells, { strength = 1, smear = 6 } = {}) {
  const gainFor = w => {
    const k = w * strength;
    return op === 'erase' ? Math.max(0, 1 - k) : op === 'quieter' ? 10 ** (-12 * k / 20) : op === 'louder' ? 10 ** (12 * k / 20) : 1;
  };
  if (op !== 'smear') {
    for (const [f, b0, b1, w] of cells) {
      if (f < 0 || f >= s.frames) continue;
      const g = gainFor(w);
      for (let k = Math.max(0, b0); k <= Math.min(s.bins - 1, b1); k++) { s.re[f][k] *= g; s.im[f][k] *= g; }
    }
    return;
  }
  // Smear reads the levels before this stroke so it doesn't run away along the frames.
  const mag = (f, k) => Math.hypot(s.re[f][k], s.im[f][k]);
  const updates = [];
  for (const [f, b0, b1, w] of cells) {
    if (f < 0 || f >= s.frames) continue;
    for (let k = Math.max(0, b0); k <= Math.min(s.bins - 1, b1); k++) {
      let sum = 0, n = 0;
      for (let d = -smear; d <= smear; d++) { const g = f + d; if (g >= 0 && g < s.frames) { sum += mag(g, k); n++; } }
      const now = mag(f, k), want = sum / n, target = now + (want - now) * Math.min(1, w * strength);
      updates.push([f, k, now > 1e-12 ? target / now : 0, target]);
    }
  }
  for (const [f, k, g, target] of updates) {
    if (g) { s.re[f][k] *= g; s.im[f][k] *= g; } else { const ph = Math.random() * 2 * Math.PI; s.re[f][k] = target * Math.cos(ph); s.im[f][k] = target * Math.sin(ph); }
  }
}

// Colours for levels from quiet (0) to loud (1): dark blue-violet through magenta and orange to
// pale yellow, readable in light and dark themes.
const STOPS = [[0, [12, 8, 32]], [0.25, [70, 20, 110]], [0.5, [170, 40, 110]], [0.75, [245, 110, 40]], [1, [255, 240, 170]]];
export function heat(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i], [t0, c0] = STOPS[i - 1];
    if (t <= t1) { const u = (t - t0) / (t1 - t0); return c0.map((v, j) => Math.round(v + (c1[j] - v) * u)); }
  }
  return STOPS.at(-1)[1];
}

// Log-frequency rows: row 0 at the top = `hi` Hz, the last row = `lo` Hz.
export const rowHz = (row, rows, lo, hi) => hi * (lo / hi) ** (row / (rows - 1));
export const hzRow = (hz, rows, lo, hi) => (Math.log(hz / hi) / Math.log(lo / hi)) * (rows - 1);
