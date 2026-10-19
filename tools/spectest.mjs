// Spectrogram maths (js/core/spectral.js): round trip, a tone in the right bin, edits.
import assert from 'node:assert/strict';
import { stft, istft, brush, dbAt, heat, rowHz, hzRow, copySpec } from '../js/core/spectral.js';

const sr = 44100, n = sr / 2;
const tone = (hz, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / sr));
const rms = (a, from = 0, to = a.length) => { let e = 0; for (let i = from; i < to; i++) e += a[i] * a[i]; return Math.sqrt(e / (to - from)); };
{
  const x = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.01) * 0.3 + Math.sin(i * 0.37) * 0.2 + (i % 97) / 970);
  const s = stft(x), y = istft(s, x.length);
  let err = 0;
  for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(x[i] - y[i]));
  assert.ok(err < 1e-4, `round trip is exact (max error ${err})`);
}
{
  const s = stft(tone(1000)), bin = Math.round(1000 / (sr / s.size)), f = Math.floor(s.frames / 2);
  assert.ok(Math.abs(dbAt(s, f, bin) - 20 * Math.log10(0.5)) < 1.5, `a 0.5 sine reads about −6 dB (${dbAt(s, f, bin).toFixed(1)})`);
  assert.ok(dbAt(s, f, bin * 3) < -60, 'nothing far away');
  // Erasing the tone's bins silences it; quieter takes 12 dB off.
  const e = copySpec(s);
  brush(e, 'erase', Array.from({ length: e.frames }, (_, k) => [k, bin - 6, bin + 6, 1]));
  assert.ok(rms(istft(e, n), 4000, n - 4000) < 0.001, 'erased (away from the tone\'s abrupt start and end)');
  const q = copySpec(s);
  brush(q, 'quieter', Array.from({ length: q.frames }, (_, k) => [k, 0, q.bins - 1, 1]));
  const ratio = 20 * Math.log10(rms(istft(q, n), 4000, n - 4000) / rms(tone(1000), 4000, n - 4000));
  assert.ok(Math.abs(ratio + 12) < 0.1, `quieter = −12 dB (${ratio.toFixed(2)})`);
  // Smear on a click spreads it in time.
  const click = new Float32Array(n); click[n / 2] = 1;
  const c = stft(click), mid = Math.floor((n / 2 + c.size) / c.hop);
  const before = dbAt(c, mid - 5, 40);
  brush(c, 'smear', Array.from({ length: c.frames }, (_, k) => [k, 0, c.bins - 1, 1]));
  assert.ok(dbAt(c, mid - 5, 40) > before + 10, 'smear spreads a click');
}
assert.deepEqual(heat(0), [12, 8, 32]);
assert.deepEqual(heat(1), [255, 240, 170]);
assert.ok(Math.abs(rowHz(hzRow(440, 300, 30, 20000), 300, 30, 20000) - 440) < 1e-6);
console.log('ok — spectrograms');
