// Offline checks for the Recorder's audio helpers: node tools/rectest.mjs (also run by selftest.mjs)
import assert from 'node:assert/strict';
import { cut, encodeWav, findOnset, AudioIn } from '../js/rec/audio.js';

// findOnset: the first sample clearly above the noise before the expected time.
{
  const a = new Float32Array(10000);
  for (let i = 0; i < a.length; i++) a[i] = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.002; // quiet noise
  for (let i = 6000; i < 7000; i++) a[i] = Math.sin(i / 5) * 0.5;
  const at = findOnset([a], 5000);
  assert.ok(at >= 6000 && at < 6010, `onset ${at}`);
  assert.equal(findOnset([new Float32Array(5000)], 3000), -1, 'silence: none');
}
// cut: absolute frames, padded with silence either side.
{
  const rec = { frame: 1000, chans: [Float32Array.from([1, 2, 3, 4])] };
  assert.deepEqual([...cut(rec, 998, 8)[0]], [0, 0, 1, 2, 3, 4, 0, 0]);
  assert.deepEqual([...cut(rec, 1002, 2)[0]], [3, 4]);
}
// encodeWav: 24-bit PCM header and samples.
{
  const w = encodeWav([Float32Array.from([0, 1, -1, 0.5]), Float32Array.from([0, 0, 0, 0])], 48000);
  const v = new DataView(w.buffer), str = (o, n) => String.fromCharCode(...w.slice(o, o + n));
  assert.equal(str(0, 4) + str(8, 4) + str(36, 4), 'RIFFWAVEdata');
  assert.deepEqual([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)], [1, 2, 48000, 24]);
  assert.equal(v.getUint32(40, true), 4 * 2 * 3);
  const s24 = o => { const x = w[o] | w[o + 1] << 8 | w[o + 2] << 16; return x & 0x800000 ? x - 0x1000000 : x; };
  assert.deepEqual([s24(44 + 6), s24(44 + 12), s24(44 + 18)], [0x7fffff, -0x800000, Math.round(0.5 * 0x7fffff)]);
}
// Recording by time: blocks from before the start (arriving late) are left out, blocks that arrive
// after Stop is pressed are waited for, and everything lands at its own position.
{
  const sr = 1000; // 1 frame per ms keeps the numbers readable
  let clock = 0; // the audio clock, in frames, matching performance.now() offset by `skew`
  const skew = performance.now();
  const rec = new AudioIn();
  rec.ac = { sampleRate: sr, getOutputTimestamp: () => ({ contextTime: clock / sr, performanceTime: skew + clock }) };
  const block = (frame, v) => rec.onBlock({ frame, chans: [new Float32Array(100).fill(v)] });
  rec.channel = 0;
  clock = 1000; // "now" is frame 1000 when recording starts (performance.now() ~ skew + 1000)
  const realNow = performance.now;
  performance.now = () => skew + clock;
  rec.record();
  block(700, 9); // played before the start, arriving late: left out
  block(1100, 2); // out of order
  block(1000, 1);
  clock = 1300; // Stop pressed: blocks up to frame 1300 belong to the recording
  const done = rec.finish();
  setTimeout(() => block(1200, 3), 30); // the last block arrives after Stop
  const r = await done;
  performance.now = realNow;
  assert.equal(r.frame, 1000);
  assert.equal(r.chans[0].length, 300);
  assert.deepEqual([r.chans[0][0], r.chans[0][150], r.chans[0][210], r.chans[0][299]], [1, 2, 3, 3]);
}
// Sampling an instrument: which notes, which keys each plays, trimming, release, seamless loops.
{
  const { notesToSample, zonesFor, tidy, releaseTime, makeLoop } = await import('../js/rec/sampleinst.js');
  assert.deepEqual(notesToSample(36, 48, 4), [36, 40, 44, 48]);
  assert.deepEqual(notesToSample(36, 46, 4), [36, 40, 44, 46], 'always ends on the top note');
  const z = zonesFor([36, 40, 44]);
  assert.deepEqual(z.map(x => [x.lo, x.hi]), [[0, 38], [39, 42], [43, 127]], 'zones meet halfway and reach the ends');
  const sr = 8000, f = 220, hold = sr * 2, n = hold + sr;
  // A held tone that starts after 20 ms of silence and fades out after the key goes up.
  const tone = new Float32Array(n);
  for (let i = 160; i < n; i++) tone[i] = 0.5 * Math.sin(2 * Math.PI * f * i / sr) * (i < hold ? 1 : Math.exp(-(i - hold) / sr * 12));
  const t = tidy([tone], hold, sr);
  assert.ok(t.chans[0].length < n && Math.abs(t.hold - (hold - 160)) < 40, 'leading silence trimmed, key-up moved with it');
  const rel = releaseTime(t.chans, t.hold, sr);
  assert.ok(rel > 0.3 && rel < 0.5, `release about 0.38 s (${rel})`);
  const loop = makeLoop(t.chans, t.hold, sr);
  assert.ok(loop && loop.start > t.hold * 0.4 && loop.end < t.hold * 0.95, 'loop inside the held part');
  // Seamless: the samples either side of the jump back continue the wave.
  const a = t.chans[0], step = 2 * Math.PI * f / sr;
  assert.ok(Math.abs(a[loop.end - 1] - a[loop.start - 1]) < 0.05 && Math.abs(a[loop.start] - a[loop.start - 1]) < Math.sin(step) * 0.5 + 0.01, 'the loop joins smoothly');
}
console.log('ok — Recorder audio');
