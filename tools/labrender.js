// Helpers for checking Sound Lab sounds by rendering them offline, from the browser console (or
// the preview's JavaScript tool) on the test server:
//   const T = await import('/tools/labrender.js?' + Date.now());
//   const [L, R] = await T.render(patch, [[60, 100, 0.05, 0.5]], 3);   // notes: [note, velocity, start s, length s]
//   T.db(L, 0.1, 0.5), T.peak(L), T.level(L, 0.2, 0.3, 261.63), T.pitch(L, 0.2, 0.1)
// Reload the page after changing engine code: modules (and the worklet's code) are cached by it.
import { LabSynth } from '../js/lab/engine.js';
import { normalizePatch } from '../js/lab/patch.js';
export { FACTORY } from '../js/lab/sounds.js';

export const SR = 44100;
// Renders a patch playing `notes`; throws if the patch isn't clean. `setup(synth)` runs before the notes.
export async function render(raw, notes, secs, { tempo = 120, setup } = {}) {
  const ac = new OfflineAudioContext(2, Math.round(SR * secs), SR), synth = new LabSynth(ac);
  const { patch, notes: problems } = normalizePatch(raw);
  if (problems.length) throw new Error(problems.join(' | '));
  synth.setTempo(tempo);
  synth.setPatch(patch);
  await synth.ready();
  synth.setPatch(patch);
  setup?.(synth);
  for (const [n, v, t, d] of notes) synth.play(n, v, t, d);
  const buf = await ac.startRendering();
  return [buf.getChannelData(0), buf.getChannelData(1)];
}
const round = v => Math.round(v * 10) / 10;
// RMS level (dB) between two times.
export function db(x, from, to) {
  const a = Math.round(from * SR), b = Math.min(x.length, Math.round(to * SR));
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return round(10 * Math.log10(s / Math.max(1, b - a) + 1e-20));
}
export function peak(x) {
  let p = 0;
  for (const v of x) if (Math.abs(v) > p) p = Math.abs(v);
  return Math.round(p * 1000) / 1000;
}
// The level (dB) of a sine at `f` Hz in `len` seconds from `from` (a Hann-windowed Goertzel).
export function level(x, from, len, f) {
  const s = Math.round(from * SR), N = Math.round(len * SR), w = 2 * Math.PI * f / SR;
  let re = 0, im = 0;
  for (let i = 0; i < N; i++) {
    const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    re += x[s + i] * h * Math.cos(w * i); im += x[s + i] * h * Math.sin(w * i);
  }
  return round(20 * Math.log10(4 * Math.hypot(re, im) / N + 1e-12));
}
// Pitch (Hz) by autocorrelation: the shortest strong period, 37 Hz to 2.2 kHz.
export function pitch(x, from, len) {
  const s = Math.round(from * SR), N = Math.round(len * SR);
  let best = 0, lag = 1;
  for (let l = 20; l < 1200 && l < N / 2; l++) {
    let c = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < N - l; i++) { c += x[s + i] * x[s + i + l]; e1 += x[s + i] ** 2; e2 += x[s + i + l] ** 2; }
    const r = c / Math.sqrt(e1 * e2 + 1e-20);
    if (r > best + 0.01) { best = r; lag = l; }
  }
  return round(SR / lag);
}
