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
console.log('ok — Recorder audio');
