// Plays Lab patches (see patch.js) with Web Audio. Each note builds its own small graph of nodes
// from the patch's voice modules; the effects (global modules) are built once per instrument.
// Times are AudioContext seconds; atTime() converts from performance.now() milliseconds.
//
//   const synth = new LabSynth(audioContext, destinationNode);
//   synth.setPatch(patch);
//   synth.play(60, 100, synth.atTime(performance.now()), 0.5);   // or noteOn / noteOff
import { MODULES, isSource, zoneFor, DRAWBAR_HARMONIC, syncBeats, VOWELS, FORMANT_GAINS, arpOrder, resonatorRatios, stepCurve } from './patch.js';
import { ALIASES, padSoundKey } from './drums.js';
import { ensureFx, fxReady, WORKLET_FX, WORKLET_VOICES, WORKLET_HELPED } from './fxworklet.js';
import { fft } from '../core/spectral.js';

const OSC_TYPES = { saw: 'sawtooth', square: 'square', triangle: 'triangle', sine: 'sine' };
const LFO_TYPES = { sine: 'sine', triangle: 'triangle', square: 'square', saw: 'sawtooth' };
// An LFO wave that starts part-way through its cycle (`phase` 0-1): the same shapes as the browser's
// own (and 'rise'), from their sine series b(k), each harmonic turned by k × the phase.
const LFO_SERIES = {
  sine: k => (k === 1 ? 1 : 0),
  triangle: k => (k % 2 ? 8 / (Math.PI * Math.PI * k * k) * (k % 4 === 1 ? 1 : -1) : 0),
  square: k => (k % 2 ? 4 / (Math.PI * k) : 0),
  saw: k => 2 / (Math.PI * k) * (k % 2 ? 1 : -1),
  rise: k => -2 / (Math.PI * k),
};
function lfoWave(ac, cache, wave, phase) {
  const key = `${wave}@${phase}`, waves = (cache.lfoWaves ||= new Map());
  if (!waves.has(key)) {
    const H = wave === 'sine' ? 1 : wave === 'rise' ? 64 : 512, re = new Float32Array(H + 1), im = new Float32Array(H + 1), b = LFO_SERIES[wave] || LFO_SERIES.sine;
    for (let k = 1; k <= H; k++) { re[k] = b(k) * Math.sin(2 * Math.PI * k * phase); im[k] = b(k) * Math.cos(2 * Math.PI * k * phase); }
    waves.set(key, ac.createPeriodicWave(re, im));
  }
  return waves.get(key);
}
const STEP = 128; // samples per step of the random LFO's buffer

// Shared buffers and curves, made once per AudioContext.
const shared = new WeakMap();
function assets(ac) {
  let a = shared.get(ac);
  if (a) return a;
  const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  // Pulse: a sawtooth plus an offset through a hard comparator; the offset sets the width.
  const comparator = new Float32Array(2048);
  for (let i = 0; i < comparator.length; i++) comparator[i] = i < comparator.length / 2 ? -1 : 1;
  // Random (sample & hold) LFO: a looped buffer of random steps, played at the LFO's rate.
  const steps = ac.createBuffer(1, 64 * STEP, ac.sampleRate), sd = steps.getChannelData(0);
  for (let k = 0; k < 64; k++) { const v = Math.random() * 2 - 1; sd.fill(v, k * STEP, (k + 1) * STEP); }
  const cosine = ac.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])); // for orbits
  // The 'rise' LFO: a ramp from -1 up to 1 that starts each cycle at the bottom (a sawtooth's
  // series is sin(kx)/k; minus it, from phase 0, rises from the bottom), for pumping and ducking.
  const H = 64, ri = new Float32Array(H + 1);
  for (let k = 1; k <= H; k++) ri[k] = -2 / (Math.PI * k);
  const rise = ac.createPeriodicWave(new Float32Array(H + 1), ri);
  // Step sequences: one cycle as a straight ramp from -1 to 1, which a wave shaper holding the steps
  // turns into the pattern (stepSeq). Long, so the jump back at the end is over within a sample.
  const ramp = ac.createBuffer(1, RAMP, ac.sampleRate), rd = ramp.getChannelData(0);
  for (let i = 0; i < RAMP; i++) rd[i] = -1 + 2 * i / RAMP;
  a = { noise, comparator, steps, cosine, rise, ramp, drives: new Map() };
  shared.set(ac, a);
  return a;
}
const RAMP = 65536;
// A step sequence (the `seq` and `gseq` modules): the ramp buffer, looped once per cycle, through
// a wave shaper whose curve is the steps (patch.js stepCurve), then Depth. The curve can be
// swapped while it runs, so steps can be changed under sounding notes. `stepsPerSec()` gives the
// rate now (from the tempo when synced); `now()` the module's settings now.
function stepSeq(ac, a, now, stepsPerSec) {
  const osc = ac.createBufferSource(), shaper = ac.createWaveShaper(), depth = ac.createGain();
  osc.buffer = a.ramp;
  osc.loop = true;
  const rate = () => stepsPerSec() / Math.max(1, Math.round(now().length)) * RAMP / ac.sampleRate;
  osc.playbackRate.value = rate();
  shaper.curve = stepCurve(now());
  depth.gain.value = now().depth;
  osc.connect(shaper).connect(depth);
  const rerate = () => osc.playbackRate.setTargetAtTime(rate(), ac.currentTime, 0.02);
  const recurve = () => { shaper.curve = stepCurve(now()); };
  const set = { rate: rerate, sync: rerate, _tempo: rerate, length: () => { recurve(); rerate(); }, glide: recurve, depth: v => depth.gain.setTargetAtTime(v, ac.currentTime, 0.02) };
  for (const k of Object.keys(now())) if (/^s\d+$/.test(k)) set[k] = recurve;
  return { osc, shaper, depth, set };
}
// The vowel filter: formant k's frequency (Hz) along the vowel position, as a wave shaper's curve
// (input -1…1 = vowel 0…4, A E I O U), moved by `shift` semitones. Cached.
const vowelCurves = new Map();
function vowelCurve(k, shift = 0) {
  const key = `${k}:${shift}`;
  if (!vowelCurves.has(key)) {
    const c = new Float32Array(1025), mul = 2 ** (shift / 12);
    for (let i = 0; i < c.length; i++) {
      const x = i / (c.length - 1) * 4, j = Math.min(3, Math.floor(x)), f = x - j;
      c[i] = (VOWELS[j][k] * (1 - f) + VOWELS[j + 1][k] * f) * mul;
    }
    vowelCurves.set(key, c);
  }
  return vowelCurves.get(key);
}
// Band-passes keep only a sliver of the sound (less, the sharper they are): this brings the vowel
// filter back to about the input's level (measured on a saw at Resonance 10).
const vowelMakeup = q => 7.5 * Math.sqrt(q / 10);
// A pitch shifter from two delay taps whose delay falls at (ratio - 1) seconds per second, so what
// passes through comes out `ratio` times higher; each tap jumps back every grain and they're
// crossfaded (sin² / cos², half a grain apart) so the jumps don't click. The control signals are
// looped buffers started together, so they stay in step.
const GRAIN = 0.08;
function pitchShifter(ac, ratio) {
  const input = ac.createGain(), output = ac.createGain(), n = Math.round(GRAIN * ac.sampleRate), nodes = [input, output];
  const ctl = (fn) => { const b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = fn(i / n); const s = ac.createBufferSource(); s.buffer = b; s.loop = true; nodes.push(s); return s; };
  const taps = [0, 0.5].map(off => {
    const d = ac.createDelay(1), g = ac.createGain();
    d.delayTime.value = 0; g.gain.value = 0;
    input.connect(d).connect(g).connect(output);
    nodes.push(d, g);
    return { d, g, off };
  });
  const span = Math.max(0, ratio - 1) * GRAIN, at = ac.currentTime + 0.01;
  for (const t of taps) {
    const ph = x => (x + t.off) % 1;
    const dl = ctl(x => span * (1 - ph(x))), gn = ctl(x => Math.sin(Math.PI * ph(x)) ** 2);
    dl.connect(t.d.delayTime); gn.connect(t.g.gain);
    dl.start(at); gn.start(at);
  }
  return { input, output, nodes };
}
let softClipCurve = null;
const softClip = () => (softClipCurve ||= Float32Array.from({ length: 1025 }, (_, i) => Math.tanh((i / 512 - 1) * 1.5) / Math.tanh(1.5)));
function driveCurve(ac, amount) {
  const cache = assets(ac).drives, key = Math.round(amount * 100);
  if (!cache.has(key)) {
    const k = 0.5 + key / 100 * 30, c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) { const x = i / (c.length - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    cache.set(key, c);
  }
  return cache.get(key);
}
// The Rotary's amp: tanh(g·x)/g, so quiet signals pass at their own level (driveCurve's gain of
// up to ×30 made the old Drive 0.15 a ×5 clipper on every organ) and only loud ones are rounded
// off: g = 2 × Drive, so 0 = clean, 0.15 rounds off big chords a little, 1 = overdriven. The curve
// spans ±ROTARY_ROOM (the input is scaled down to fit, the output isn't), since an organ chord
// peaks well above 1 and a WaveShaper clips everything outside its curve.
const ROTARY_ROOM = 4;
function rotaryAmpCurve(ac, drive) {
  const cache = assets(ac).drives, key = 'rotary' + Math.round(drive * 100);
  if (!cache.has(key)) {
    const g = 2 * Math.round(drive * 100) / 100, c = new Float32Array(1025);
    for (let i = 0; i < c.length; i++) { const x = (i / (c.length - 1) * 2 - 1) * ROTARY_ROOM; c[i] = g ? Math.tanh(g * x) / g : x; }
    cache.set(key, c);
  }
  return cache.get(key);
}
// A reverb's impulse response, made up rather than recorded. After the pre-delay come a few early
// reflections (rooms and halls: the first echoes off nearby walls), then a dense tail that builds
// up and fades by 60 dB over `size` seconds, its highs dying away faster than its lows (damping).
// Each side gets its own noise, so it's wide. Every type comes out about equally loud.
const REVERBS = {
  room: { er: [[7, 0.7], [11, 0.55], [17, 0.5], [23, 0.4], [31, 0.35], [41, 0.25]], build: 0.01, bright: 9000 },
  hall: { er: [[15, 0.5], [27, 0.45], [38, 0.35], [53, 0.3], [71, 0.22]], build: 0.04, bright: 7000 },
  plate: { er: [], build: 0.002, bright: 13000 },
  ambience: { er: [[5, 0.8], [9, 0.6], [14, 0.5], [19, 0.4], [26, 0.3]], build: 0.004, bright: 8000, maxSize: 0.8 },
};
export function reverbImpulse(sampleRate, { type = 'hall', size = 2.5, predelay = 20, damping = 0.5 } = {}, makeBuffer) {
  const r = REVERBS[type] || REVERBS.hall, decay = Math.min(size, r.maxSize || size);
  const pre = Math.round(sampleRate * predelay / 1000), tail = Math.round(sampleRate * decay * 1.05);
  const len = pre + tail, chans = [new Float32Array(len), new Float32Array(len)];
  const loTo = 300 + (1 - damping) * (r.bright - 300); // where the highs end up by the end of the tail
  chans.forEach((d, ch) => {
    let lp = 0;
    for (let i = 0; i < tail; i++) {
      const t = i / sampleRate, env = 10 ** (-3 * t / decay) * Math.min(1, t / r.build);
      const fc = r.bright * (loTo / r.bright) ** Math.min(1, t / decay), a = Math.exp(-2 * Math.PI * fc / sampleRate);
      lp = (1 - a) * (Math.random() * 2 - 1) + a * lp;
      d[pre + i] = lp * env;
    }
    for (const [ms, g] of r.er) { // a slightly different spot on each side
      const at = pre + Math.round(sampleRate * (ms * (ch ? 1.07 : 0.94)) / 1000);
      if (at < len) d[at] += g * (ch ? -1 : 1) * 0.6;
    }
  });
  // The same energy for every type and size, so changing them doesn't jump in level.
  let e = 0;
  for (const d of chans) for (let i = 0; i < len; i++) e += d[i] * d[i];
  const k = 0.5 / Math.sqrt(e / sampleRate || 1); // about as loud as the old reverb at 2.5 s
  for (const d of chans) for (let i = 0; i < len; i++) d[i] *= k;
  return makeBuffer ? makeBuffer(chans, len) : chans;
}
// A piano soundboard's impulse response (or an upright's smaller board), made up: hundreds of
// resonances (modes) spaced fairly evenly, as on a plate, from the board's lowest mode up to 10 kHz,
// each ringing at its own frequency with a Q of 25-60 up to 100 Hz, falling as 100/f above (Q 10 at
// 1 kHz; at least 6), so low modes ring for a few tenths of a second and high ones for a few
// milliseconds (a real board's response lasts about 0.3-0.4 s). Plus a direct part as strong as
// all the resonances: with sharp resonances only (Q 25-60 everywhere, no direct part), every note
// swelled for 50-80 ms after the strike (a tone on a resonance takes Q/πf to build up) and the
// attack sounded soft; measured now, notes peak 1-11 ms after the strike, as a piano does.
// The modes' levels are random (each partial of a string lands on a different mix of them), but
// set per third-octave band so that, on average, a tone passes at the same level at any pitch:
// rising to the lowest mode, a broad bump around 300 Hz (the upright's boxier), falling above
// `tone`. The two sides differ above 300 Hz (a board radiates each mode in its own direction), so
// it's wide; the bass stays in the middle. A string played into it gets the board's
// colour and bloom, and the thud of the hammer (which hammered strings send as their knock).
const BOARDS = {
  grand: { lowest: 45, spacing: 13, bump: 1.4, radiates: 300 },
  upright: { lowest: 85, spacing: 22, bump: 2.2, radiates: 400 }, // a smaller board: sparser modes, boxier
};
export function soundboardImpulse(sampleRate, { type = 'grand', size = 1, tone = 2500, width = 0.7, direct = 0.3, qfall = 1, radiates } = {}, makeBuffer, rnd = Math.random) {
  const b = { ...(BOARDS[type] || BOARDS.grand), ...(radiates ? { radiates } : {}) }, len = Math.round(sampleRate * 0.6 * Math.max(0.25, size));
  const top = Math.min(10000, sampleRate * 0.45);
  // The board radiates the bass poorly (a piano's bass fundamentals are weaker than their upper
  // partials): rising ~10 dB/oct to `radiates` Hz; falling 12 dB/oct above Tone. Fitted to the
  // University of Iowa grand's recordings (C2, C4, C6 at pp and ff; tools in recordings/piano/):
  // radiates 300 Hz and Tone 2.5 kHz gave the closest partial levels (mean error 13 dB, was 20).
  const rise = f => (f / b.radiates) ** 3.5 / (1 + (f / b.radiates) ** 3.5);
  const target = f => rise(f) * (f / b.lowest) ** 4 / (1 + (f / b.lowest) ** 4) / (1 + (f / tone) ** 4) * (1 + (b.bump - 1) * Math.exp(-((Math.log2(f / 300) / 1.2) ** 2)));
  // One set of modes: their levels set per band (a mode's energy goes with level² × ring time) so
  // the set follows the target curve from `from` Hz up.
  const board = from => {
    const d = new Float32Array(len), modes = [], energy = new Map();
    for (let f = Math.max(from, b.lowest) * (0.9 + 0.2 * rnd()); f < top; f += b.spacing * (0.4 + 1.2 * rnd()) * (1 + f / 4000)) {
      const q = Math.max(6, (25 + 35 * rnd()) * Math.min(1, (100 / f) ** qfall)), m = { f, t60: Math.min(0.45 * size, 2.2 * q / f), r: Math.sqrt(-2 * Math.log(1 - rnd() * 0.999)), band: Math.round(3 * Math.log2(f / 20)), ph: (rnd() < 0.5 ? 1 : -1) * Math.PI / 2 }; // ±cosine: a band-pass (a random phase leaves a floor below each mode, ~20 dB under its peak, that filled in the bass)
      modes.push(m);
      energy.set(m.band, (energy.get(m.band) || 0) + m.r * m.r * m.t60);
    }
    for (const m of modes) {
      const fc = 20 * 2 ** (m.band / 3), bw = fc * (2 ** (1 / 6) - 2 ** (-1 / 6)), g = m.r * Math.sqrt(target(m.f) * bw / energy.get(m.band));
      // A decaying sine by recursion: two multiplies a sample.
      const n = Math.min(len, Math.round(m.t60 * sampleRate)), w = 2 * Math.PI * m.f / sampleRate, r = 10 ** (-3 / (m.t60 * sampleRate)), c = 2 * r * Math.cos(w);
      let y1 = g * Math.sin(m.ph), y2 = g * Math.sin(m.ph - w) / r;
      for (let i = 0; i < n; i++) { const y = c * y1 - r * r * y2; d[i] += y1; y2 = y1; y1 = y; }
    }
    return d;
  };
  // Middle and sides: two different boards, left = mid + side, right = mid − side, so the sides
  // differ (wide) but always add up to the middle in mono. The sides start above 300 Hz.
  const mid = board(0), side = board(300), w = width * 0.8;
  // The direct part: what the board radiates at once, before its resonances build up (a tone
  // landing on a resonance otherwise swells for tens of ms). An impulse shaped by the same curve's
  // ends (rising to the lowest mode, falling above Tone), as loud as `direct` × the resonances.
  if (direct > 0) {
    let e = 0; for (let i = 0; i < len; i++) e += mid[i] * mid[i];
    const imp = new Float32Array(len), wl = 2 * Math.PI * b.radiates * 0.8 / sampleRate, wh = 2 * Math.PI * tone / sampleRate;
    const ah = Math.exp(-wh), al = Math.exp(-wl);
    let x = 1, l1 = 0, l2 = 0, h1 = 0, p1 = 0, h2 = 0, p2 = 0, ed = 0;
    for (let i = 0; i < Math.min(len, 4096); i++) {
      l1 = (1 - ah) * x + ah * l1; l2 = (1 - ah) * l1 + ah * l2; // two low-pass poles at Tone
      h1 = al * (h1 + l2 - p1); p1 = l2; h2 = al * (h2 + h1 - p2); p2 = h1; // two high-pass poles: the rise
      imp[i] = h2; ed += h2 * h2; x = 0;
    }
    const k = Math.sqrt(direct * e / (ed || 1));
    for (let i = 0; i < len; i++) mid[i] += imp[i] * k;
  }
  const chans = [mid.map((x, i) => x + w * side[i]), mid.map((x, i) => x - w * side[i])];
  // Levelled so a tone between 100 Hz and 5 kHz passes at about its own level: the mean of |H(f)|²
  // there (both sides together) is 2, since a tone lands on a mode's slope more often than its peak
  // (measured on strings: about 3 dB below the mean).
  let n2 = 1; while (n2 < len) n2 *= 2;
  let sum = 0, bins = 0;
  for (const d of chans) {
    const re = new Float64Array(n2), im = new Float64Array(n2);
    re.set(d);
    fft(re, im);
    for (let i = Math.ceil(100 * n2 / sampleRate); i < 5000 * n2 / sampleRate; i++) { sum += re[i] * re[i] + im[i] * im[i]; bins += 0.5; }
  }
  const k = Math.SQRT2 / Math.sqrt(sum / bins || 1);
  for (const d of chans) for (let i = 0; i < len; i++) d[i] *= k;
  return makeBuffer ? makeBuffer(chans, len) : chans;
}
function impulse(ac, params) {
  return reverbImpulse(ac.sampleRate, params, (chans, len) => {
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    chans.forEach((d, ch) => buf.copyToChannel(d, ch));
    return buf;
  });
}
// One of your recordings (data/audio/), decoded once per context: impulse responses, samples.
const fileIRs = new WeakMap();
export function fileBuffer(ac, file) {
  let m = fileIRs.get(ac);
  if (!m) fileIRs.set(ac, m = new Map());
  if (!m.has(file)) {
    m.set(file, import('../core/storage.js').then(({ audioBlob }) => audioBlob(file))
      .then(blob => blob.arrayBuffer()).then(b => ac.decodeAudioData(b)).catch(() => { m.delete(file); return null; }));
  }
  return m.get(file);
}
// The Piano module's data (pianos/<name>.json and .strikes, made by tools/piano from recordings of a
// real piano): loaded once, then the strikes as AudioBuffers per context. A key plays the nearest
// fitted note, moved by at most a semitone and a half, at the piano's own tuning there.
const pianoFiles = new Map(), pianoBuffers = new WeakMap();
const PIANO_GAIN = 3;   // the recordings' own level is low: a loud middle C then peaks about where the String pianos' does
const PIANO_HALO = 80;  // see the Pedal resonance effect
export function loadPiano(ac, name = 'steinway-b') {
  if (!pianoFiles.has(name)) {
    pianoFiles.set(name, Promise.all([fetch(`pianos/${name}.json`).then(r => r.json()), fetch(`pianos/${name}.strikes`).then(r => r.arrayBuffer())])
      .then(([data, raw]) => {
        const pcm = new Int16Array(raw);
        for (const d of data.notes) {
          d.cents = 1200 * Math.log2(d.f0 / hz(d.note));
          d.count = d.modes.length / 7;
        }
        return { ...data, pcm };
      }).catch(() => { pianoFiles.delete(name); return null; }));
  }
  let m = pianoBuffers.get(ac);
  if (!m) pianoBuffers.set(ac, m = new Map());
  if (!m.has(name)) {
    m.set(name, null);
    return pianoFiles.get(name).then(data => {
      if (!data) { m.delete(name); return null; }
      const strikes = new Map(), buf = s => {
        if (!s) return null;
        const b = ac.createBuffer(2, s[1], data.rate), l = b.getChannelData(0), r = b.getChannelData(1), k = s[2] / 32767;
        for (let i = 0, j = s[0] * 2; i < s[1]; i++) { l[i] = data.pcm[j++] * k; r[i] = data.pcm[j++] * k; }
        return b;
      };
      for (const d of data.notes) strikes.set(d.note, { ff: buf(d.ff), pp: buf(d.pp) });
      const piano = { notes: data.notes, strikes };
      m.set(name, piano);
      return piano;
    });
  }
  return Promise.resolve(m.get(name));
}
const pianoReady = (ac, name = 'steinway-b') => pianoBuffers.get(ac)?.get(name) || null;
// What one key press needs: the modes at this velocity, the fade-in, the damper's time, the strikes.
// Velocity 120 is the loud recording, 30 the soft one; in between each partial's starting level
// moves in dB along log(velocity) (a piano is linear after the hammer: playing softer only changes
// how loud each partial starts). `tone` > 0 is una corda: softer felt, as if played a little softer.
export function pianoNote(piano, note, vel, { velocity = 1, tone = 0, hardness = 1, detune = 0 } = {}) {
  const ns = piano.notes;
  let d = ns[0];
  for (const q of ns) if (Math.abs(q.note - note) < Math.abs(d.note - note)) d = q;
  const lo = [...ns].reverse().find(q => q.note <= note) || ns[0], hi = ns.find(q => q.note >= note) || ns[ns.length - 1];
  const cents = hi === lo ? lo.cents : lo.cents + (hi.cents - lo.cents) * (note - lo.note) / (hi.note - lo.note);
  const ratio = hz(note) * 2 ** (cents / 1200) / d.f0;
  // Hammer (hardness) below 1 gives the softer playing's tone at the same loudness: the partials
  // take their soft levels, and the level that costs overall is given back.
  const felt = 1 - Math.max(0, Math.min(1, hardness));
  const u = Math.max(-0.1, Math.min(1.7, velocity * Math.log(120 / Math.max(1, vel)) / Math.log(4) + tone + felt));
  const back = 10 ** (-felt * d.soft / 20);
  // Out of tune (detune, cents): the note three times over, as three strings tuned apart; how far
  // apart differs from key to key, as on a neglected piano.
  const k = Math.sin(note * 12.9898) * 43758.5453, wob = 0.6 + 0.8 * (k - Math.floor(k));
  const copies = detune > 0 ? [-1, 0.25, 1].map(c => 2 ** (c * detune * wob / 1200)) : [1], share = detune > 0 ? 0.45 : 1;
  const n = d.count, modes = new Float64Array(n * 6 * copies.length), m = d.modes;
  copies.forEach((c, j) => {
    for (let i = 0; i < n; i++) {
      const g = 10 ** (u * m[i * 7 + 6] / 20) * back * share, o = (j * n + i) * 6;
      modes[o] = m[i * 7] * ratio * c; modes[o + 1] = m[i * 7 + 1];
      modes[o + 2] = m[i * 7 + 2] * g; modes[o + 3] = m[i * 7 + 3]; modes[o + 4] = m[i * 7 + 4] * g; modes[o + 5] = m[i * 7 + 5];
    }
  });
  const u1 = Math.max(0, Math.min(1, u)), st = piano.strikes.get(d.note), lev = v => 10 ** (v * d.soft / 20) * back;
  // the strike: the loud and the soft recordings' own, crossfaded; quieter still below the soft one
  const strikes = [[st.ff, st.pp ? (1 - u1) * lev(Math.min(0, u)) : lev(u)], [st.pp, u1 * lev(Math.max(0, u - 1))]].filter(([b, g]) => b && g > 0);
  return { modes, ratio, ramp: (d.ramp + (d.rampSoft - d.ramp) * u1) / 1000, strikes,
    damper: note > 88 ? 0 : 0.12 + 0.5 * Math.max(0, (72 - note) / 36) };   // a grand has no dampers above about E6
}
// The Distortion module's curves, at a drive (1 = barely, 40 = a lot).
function shaperCurve(type, drive) {
  const n = 2048, c = new Float32Array(n), d = Math.max(1, drive);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1, y = x * d;
    c[i] = type === 'hard' ? Math.max(-1, Math.min(1, y))
      : type === 'fold' ? Math.sin(y * Math.PI / 2)
      : type === 'tube' ? (y >= 0 ? Math.tanh(y) : 0.8 * Math.tanh(y * 0.6) / 0.6) * 0.9
      : type === 'rectify' ? Math.tanh(Math.abs(y))
      : Math.tanh(y) / Math.tanh(Math.min(d, 3));
  }
  return c;
}
// A drawbar registration as one waveform: each bar is a harmonic of the 16' tone (16' = 1,
// 5 1/3' = 3, 8' = 2 … 1' = 16), 3 dB quieter per step below 8, not normalised (more bars, louder,
// as on the organ). With percussion on, the 1' bar is silent: the organ's percussion takes its key
// contact. Cached per context and registration.
const organWaves = new WeakMap();
function organWave(ac, p) {
  let m = organWaves.get(ac);
  if (!m) organWaves.set(ac, m = new Map());
  const bars = Array.from({ length: 9 }, (_, k) => (k === 8 && p.perc && p.perc !== 'off' ? 0 : Math.round(p[`bar${k + 1}`] || 0))), key = bars.join('');
  if (!m.has(key)) {
    const imag = new Float32Array(17), real = new Float32Array(17);
    bars.forEach((d, k) => { if (d > 0) imag[DRAWBAR_HARMONIC[k]] += 0.28 * 10 ** ((d - 8) * 3 / 20); });
    m.set(key, ac.createPeriodicWave(real, imag, { disableNormalization: true }));
  }
  return m.get(key);
}
// Soft saturation for the tape echo's feedback.
let tapeCurve = null;
const tapeSat = () => (tapeCurve ||= Float32Array.from({ length: 1024 }, (_, i) => Math.tanh(1.5 * (i / 1023 * 2 - 1)) / Math.tanh(1.5)));

const hz = (note, octave = 0, semi = 0) => 440 * 2 ** ((note - 69) / 12 + octave + semi / 12);
const rad = d => d * Math.PI / 180;
// Modulation amounts are in the target's units; pulse width is scaled to the comparator offset.
const modScale = key => (key === 'pw' ? 2 : 1);

// Attack-decay-sustain on an AudioParam from t0, up to `peak`. `k` scales the times (see envTimes).
function envOn(param, t0, p, peak = 1, k = { attack: 1, decay: 1 }) {
  const attack = p.attack * k.attack;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  param.setTargetAtTime(p.sustain * peak, t0 + attack, p.decay * k.decay / 4);
}
// How an envelope's times change with the note: Key → time shortens them up the keyboard (1 =
// half as long each octave above C4, twice as long each octave below), Velocity → time makes
// harder notes ring longer and attack faster (or, below 0, the reverse), up to twice / half.
function envTimes(p, note, vel) {
  const key = 2 ** (-(note - 60) / 12 * (p.keytrack || 0)), v = 2 ** ((p.veltime || 0) * (vel - 64) / 63);
  return { attack: key / v, decay: key * v, release: key * v };
}
function envOff(param, t, release) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t); else param.cancelScheduledValues(t);
  param.setTargetAtTime(0, t, release / 4);
}

// One drum hit from a kit pad (lab/drums.js): up to two tone layers swept down to their pitch,
// a noise layer (in bursts for claps), a click, then drive, pan and level. `kit` holds the Drum
// kit module's own settings, which apply to every pad (tune, decay, tone, level). Returns how long
// it lasts. Notes without a pad play a short blip at their pitch.
const METAL = [1, 1.483, 1.8, 2.546, 2.63, 3.897]; // the 808's six cymbal oscillators, as ratios
function drumHit(ac, a, note, vel, t0, kit, pads, out, src, keep, samples = new Map()) {
  const v = (vel / 127) ** 1.2, tune = 2 ** (kit.tune / 12), dk = kit.decay, bright = 0.5 + kit.tone;
  const p = pads?.[note] || pads?.[ALIASES[note]];
  let longest = 0;
  // The pad's output: drive → pan → level.
  let into = out;
  if (p) {
    const lvl = keep(ac.createGain()), pan = keep(ac.createStereoPanner());
    lvl.gain.value = p.level;
    pan.pan.value = p.pan;
    pan.connect(lvl).connect(out);
    into = pan;
    if (p.drive > 0) { const sh = keep(ac.createWaveShaper()); sh.curve = driveCurve(ac, p.drive); sh.oversample = '2x'; sh.connect(pan); into = sh; }
    if (p.hp > 20) { const hp = keep(ac.createBiquadFilter()); hp.type = 'highpass'; hp.frequency.value = p.hp; hp.Q.value = 0.7; hp.connect(into); into = hp; }
  }
  const envelope = (level, decay, delay = 0) => {
    const t = t0 + delay, d = decay * dk, g = keep(ac.createGain());
    g.gain.setValueAtTime(0, t0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * v, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0005, t + d);
    // Then silence: held keys keep the voice (and its sources) going, and drive or a kit's
    // compressor would bring a -66 dB remainder back up into a hum or hiss.
    g.gain.setValueAtTime(0, t + d);
    longest = Math.max(longest, delay + d + 0.05);
    g.connect(into);
    return g;
  };
  const toneLayer = (level, wave, pitch, sweep, bend, decay) => {
    if (!(level > 0)) return;
    const g = envelope(level, decay), f = pitch * tune;
    const oscs = wave === 'metal' ? METAL.map(r => r) : [1];
    let dest = g;
    if (wave === 'metal') { const hp = keep(ac.createBiquadFilter()); hp.type = 'highpass'; hp.frequency.value = Math.min(16000, f * 2 * bright); hp.connect(g); dest = hp; }
    for (const r of oscs) {
      const o = src(ac.createOscillator());
      o.type = wave === 'metal' ? 'square' : wave === 'saw' ? 'sawtooth' : wave;
      o.frequency.setValueAtTime(f * r * 2 ** (sweep / 12), t0);
      if (sweep > 0) o.frequency.exponentialRampToValueAtTime(f * r, t0 + bend * dk);
      const k = keep(ac.createGain());
      k.gain.value = 1 / oscs.length ** 0.5;
      o.connect(k).connect(dest);
    }
  };
  const noiseLayer = (level, type, freq, q, decay, delay = 0) => {
    const g = envelope(level, decay, delay), n = src(ac.createBufferSource()), fl = keep(ac.createBiquadFilter());
    n.buffer = a.noise;
    n.loop = true;
    n.loopStart = Math.random();
    fl.type = type;
    fl.frequency.value = Math.min(18000, freq * (type === 'lowpass' ? 1 : bright));
    fl.Q.value = q;
    n.connect(fl).connect(g);
  };
  if (!p) { toneLayer(0.6, 'triangle', hz(note) / tune, 0, 0.01, 0.15); return longest; }
  toneLayer(p.t1Level, p.t1Wave, p.t1Pitch, p.t1Sweep, p.t1Bend, p.t1Decay);
  toneLayer(p.t2Level, p.t2Wave, p.t2Pitch, p.t2Sweep, p.t2Bend, p.t2Decay);
  if (p.nLevel > 0) {
    // Bursts: quick short ones about 11 ms apart, the last with the full decay.
    for (let k = 0; k < p.nBursts; k++) {
      const last = k === p.nBursts - 1;
      noiseLayer(p.nLevel * (last && p.nBursts > 1 ? 0.75 : 1), p.nFilter, p.nFreq, p.nQ, last ? p.nDecay : 0.03, k * 0.011);
    }
  }
  if (p.click > 0) noiseLayer(p.click * bright, 'bandpass', 2500, 0.8, 0.015);
  // A recording (the sample, or the pad's sound rendered to audio), faded over its decay.
  const bufferLayer = (buf, level, rate, from, decay) => {
    const s = src(ac.createBufferSource());
    s.buffer = buf;
    s.playbackRate.value = rate;
    const natural = (buf.duration - from) / rate, d = Math.min(natural, decay * dk), g = keep(ac.createGain());
    g.gain.setValueAtTime(level * v, t0);
    if (d < natural) { g.gain.exponentialRampToValueAtTime(0.0005, t0 + d); g.gain.setValueAtTime(0, t0 + d); }
    s._start = [from];
    s.connect(g).connect(into);
    longest = Math.max(longest, d + 0.05);
  };
  // The sample: at its own pitch (plus the pad's and the kit's tuning), trimmed at its start.
  const buf = p.sFile && p.sLevel > 0 && samples.get(p.sFile);
  if (buf) bufferLayer(buf, p.sLevel, 2 ** (p.sTune / 12) * tune, Math.min(p.sStart, 0.999) * buf.duration, p.sDecay);
  // The pad's sound, once rendered (see LabSynth.loadSamples); the kit's tuning still applies.
  const lbuf = p.lSound && p.lLevel > 0 && samples.get(padSoundKey(p));
  if (lbuf) bufferLayer(lbuf, p.lLevel, tune, 0, p.lDecay);
  return longest;
}

// The drum pads with a sound, by padSoundKey.
function padSoundsOf(patch) {
  const out = new Map();
  for (const m of patch?.modules || []) for (const p of Object.values(m.pads || {})) if (p.lSound) out.set(padSoundKey(p), p);
  return out;
}

// A sound played once, rendered to audio: the note held for `hold` seconds, then up to `tail`
// seconds of release (trailing silence cut off, with a short fade at the end).
export async function renderSound(patch, note, hold, sampleRate = 44100, tail = 4) {
  const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * (hold + tail)), sampleRate), s = new LabSynth(ctx, ctx.destination);
  s.setPatch(patch);
  s.out.gain.cancelScheduledValues(0);
  s.out.gain.value = s.patch.volume;
  await s.ready();
  s.play(note, 110, 0, hold);
  const buf = await ctx.startRendering(), chans = [buf.getChannelData(0), buf.getChannelData(1)];
  let end = Math.ceil(hold * sampleRate);
  for (const d of chans) for (let i = d.length - 1; i > end; i--) if (Math.abs(d[i]) > 1e-4) { end = i; break; }
  const len = Math.min(buf.length, end + Math.round(0.01 * sampleRate)), fade = Math.min(len, Math.round(0.01 * sampleRate));
  const out = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, len), sampleRate });
  chans.forEach((d, ch) => {
    const c = d.slice(0, len);
    for (let i = 0; i < fade; i++) c[len - 1 - i] *= i / fade;
    out.copyToChannel(c, ch);
  });
  return out;
}

// The arpeggiators' clock: one 25 ms tick for every synth on the page that has keys held, from a
// worker (browsers slow page timers to once a second in background tabs, not workers'), made once
// and kept, with a page timer beside it in case the worker never starts. (Each synth made and
// ended its own worker at first, one per run of notes.)
const arpSynths = new Set();
let arpWorker = null, arpTimer = null;
const arpTick = () => { for (const s of arpSynths) { try { s.arpPump(); } catch (e) { console.error('arpeggiator', e); } } };
function arpListen(synth, on) {
  if (!on) { arpSynths.delete(synth); return; }
  arpSynths.add(synth);
  if (!arpWorker) {
    try {
      arpWorker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 25)'], { type: 'text/javascript' })));
      arpWorker.onmessage = arpTick;
      arpWorker.onerror = () => { arpWorker = null; };
    } catch { arpWorker = null; }
  }
  arpTimer ??= setInterval(arpTick, 50);
}

export class LabSynth {
  constructor(ac, destination = ac.destination) {
    this.ac = ac;
    this.tempo = 120; // for tempo-synced LFOs, delays and tremolos (setTempo)
    this.out = ac.createGain();
    this.out.connect(destination);
    this.bus = ac.createGain(); // where voices and effects meet before the volume
    this.bus.connect(this.out);
    this.wheel = ac.createConstantSource();
    this.wheel.offset.value = 0;
    this.wheel.start();
    // Pitch bend, -1 to 1, scaled to cents for every oscillator.
    this.bend = ac.createConstantSource();
    this.bend.offset.value = 0;
    this.bendCents = ac.createGain();
    this.bendCents.gain.value = 200; // ± 2 semitones
    this.bend.connect(this.bendCents);
    this.bend.start();
    this.voices = [];
    this.globals = new Map();
    this.gain = 1;
    this.patch = null;
    this.scopes = null; // module id (or 'out') -> AnalyserNode, once enableScopes() is called
    this.samples = new Map(); // file -> AudioBuffer: the recordings the patch's samplers and pads use
    this.onSample = null; // called with a file name when it has loaded
    this.loading = Promise.resolve(); // settles when everything loadSamples() started has loaded
    this.padWait = []; // ready() calls waiting for pad sounds to render
    this.arp = { holds: [], next: null, index: 0, seq: 0, last: -1 }; // the arpeggiator (see arpPump)
    // Rendering offline, every note is given before rendering starts: the arpeggiator works its
    // steps out then (it can't as each note arrives, since a chord's other notes come after).
    if (typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext) {
      const start = ac.startRendering.bind(ac);
      ac.startRendering = () => { this.arpPump(ac.length / ac.sampleRate); return start(); };
    }
  }

  // Loads every recording the patch uses, so notes can start them at once (a note played before
  // its sample has loaded is silent). Drum pads' sounds are rendered to audio here too, kept
  // under padSoundKey() beside the recordings, a moment after their settings stop changing.
  loadSamples() {
    const files = new Set(), sounds = padSoundsOf(this.patch);
    for (const m of this.patch?.modules || []) {
      if ((m.type === 'sampler' || m.type === 'granular') && m.params.file) files.add(m.params.file);
      for (const z of m.zones || []) files.add(z.file);
      for (const p of Object.values(m.pads || {})) if (p.sFile) files.add(p.sFile);
    }
    const loads = [];
    for (const f of files) if (!this.samples.has(f)) {
      loads.push(fileBuffer(this.ac, f).then(b => { if (b) { this.samples.set(f, b); this.onSample?.(f); } }));
    }
    for (const k of this.samples.keys()) if (k.startsWith('sound:') && !sounds.has(k)) this.samples.delete(k);
    if ([...sounds.keys()].some(k => !this.samples.has(k))) loads.push(this.renderPadSounds());
    if ((this.patch?.modules || []).some(m => m.type === 'piano') && !pianoReady(this.ac)) loads.push(loadPiano(this.ac));
    // Effects that need the worklet: load it, then rebuild the effects that waited for it.
    const fx = t => WORKLET_FX.includes(t) || WORKLET_HELPED.includes(t);
    const usesFx = (this.patch?.modules || []).some(m => fx(m.type) || WORKLET_VOICES.includes(m.type) || m.rack?.modules.some(e => fx(e.type)));
    if (usesFx && !fxReady(this.ac)) loads.push(ensureFx(this.ac).then(ok => { if (ok && this.fxPending) { this.fxPending = false; this.buildGlobals(); } }));
    this.loading = Promise.all(loads);
  }
  renderPadSounds() {
    clearTimeout(this.padTimer);
    const done = new Promise(res => this.padWait.push(res));
    this.padTimer = setTimeout(async () => {
      const wait = this.padWait.splice(0);
      for (;;) {
        const [k, p] = [...padSoundsOf(this.patch)].find(([key]) => !this.samples.has(key)) || [];
        if (!k) break;
        const buf = await renderSound(p.lSound.patch, p.lNote, p.lHold, this.ac.sampleRate).catch(() => null);
        if (!buf) break;
        if (padSoundsOf(this.patch).has(k)) { this.samples.set(k, buf); this.onSample?.(k); }
      }
      wait.forEach(res => res());
    }, 120);
    return done;
  }
  // Settles once every recording and pad sound the patch uses has loaded (or failed to).
  async ready() {
    for (let last; last !== this.loading;) { last = this.loading; await last; }
  }

  // Taps for drawing waveforms: every audio module's output (all its notes summed) and the
  // instrument's output each feed an AnalyserNode. Off unless asked for (only the Lab page draws).
  enableScopes() {
    if (this.scopes) return;
    this.scopes = new Map();
    this.out.connect(this.scope('out'));
    if (this.patch) this.buildGlobals();
  }
  scope(id) {
    let a = this.scopes.get(id);
    if (!a) {
      a = this.ac.createAnalyser();
      a.fftSize = 8192;
      a.smoothingTimeConstant = id === 'out' ? 0.6 : 0;
      this.scopes.set(id, a);
    }
    return a;
  }
  // Is a note held right now (keys down, or sustained)?
  holding() { return this.voices.some(v => !v.released) || this.arp.holds.some(h => h.to === Infinity); }

  atTime(ms) { return Math.max(this.ac.currentTime, this.ac.currentTime + (ms - performance.now()) / 1000); }

  // A new patch: settings-only changes update sounding notes; new modules or connections rebuild
  // the effects and cut sounding notes short.
  setPatch(input) {
    const patch = JSON.parse(JSON.stringify(input)); // our own copy; change it with setParam / setMod
    // Settings marked `rebuild` (an oscillator's wave, a filter's slope...) change which nodes a note uses.
    const fx = m => [m.type, !!m.off, ...MODULES[m.type].params.filter(x => x.rebuild).map(x => m.params[x.key])];
    const shape = p => JSON.stringify([p.modules.map(m => [m.id, ...fx(m), m.rack?.modules.map(fx)]), p.audio, p.mod.map(m => [m.from, m.to])]);
    const old = this.patch;
    this.patch = patch;
    if (old && !old.arp !== !patch.arp) { this.allOff(); } // arpeggiator switched on or off: held keys are let go
    if (old?.arp?.latch && patch.arp && !patch.arp.latch) this.arpUnlatch(); // Latch off: the latched keys stop
    this.loadSamples();
    if (old && shape(old) === shape(patch)) {
      for (const m of patch.modules) {
        const was = old.modules.find(x => x.id === m.id);
        for (const [k, v] of Object.entries(m.params)) if (was?.params[k] !== v) this.applyParam(m.id, k, v);
        m.rack?.modules.forEach((e, i) => { for (const [k, v] of Object.entries(e.params)) if (was?.rack?.modules[i]?.params[k] !== v) this.applyParam(m.id, `${i}.${k}`, v); });
      }
      patch.mod.forEach((c, i) => { if (old.mod[i]?.amount !== c.amount) this.applyMod(c); });
      this.setVolume();
      return;
    }
    this.allOff(true);
    this.buildGlobals();
    this.setVolume();
  }

  setGain(g) { this.gain = g; this.setVolume(); }
  setVolume() { if (this.patch) this.out.gain.setTargetAtTime(this.patch.volume * this.gain, this.ac.currentTime, 0.02); }
  setWheel(v) { this.wheel.offset.setTargetAtTime(v, this.ac.currentTime, 0.01); }
  setBend(v) { this.bend.offset.setTargetAtTime(v, this.ac.currentTime, 0.005); }

  // One setting of one module, or one modulation amount, while notes sound.
  // ---- tempo sync (patch.js SYNC) ----
  // The page tells the tempo (the Sequencer's); synced LFOs, delays and tremolos follow it, in
  // sounding notes too.
  setTempo(bpm) {
    if (!(bpm > 0) || bpm === this.tempo) return;
    this.tempo = bpm;
    const call = set => { for (const [k, f] of Object.entries(set || {})) if (k === '_tempo' || k.endsWith('._tempo')) f(); };
    for (const v of this.voices || []) call(v.set);
    for (const g of this.globals?.values() || []) call(g.set);
    if (this.g) call(this.g.set); // an FxChain's rack
  }
  // A setting's rate (Hz) or time (s): from the tempo when it's synced, else its own.
  rateOf(p, rate = p.rate) { const b = syncBeats(p.sync); return b ? (this.tempo || 120) / 60 / b : rate; }
  timeOf(p, time = p.time) { const b = syncBeats(p.sync); return b ? Math.min(2.4, b * 60 / (this.tempo || 120)) : time; }

  setParam(id, key, value) {
    const m = this.patch?.modules.find(x => x.id === id);
    if (!m) return;
    const [k, inner] = key.split('.'); // "<index>.<key>": an effect inside a rack
    if (inner !== undefined) { const e = m.rack?.modules[+k]; if (e) e.params[inner] = value; } else m.params[key] = value;
    this.applyParam(id, key, value);
  }
  setMod(index, amount) {
    const c = this.patch?.mod[index];
    if (!c) return;
    c.amount = amount;
    this.applyMod(c);
  }
  applyParam(id, key, value) {
    for (const v of this.voices) v.set[`${id}.${key}`]?.(value);
    this.globals.get(id)?.set[key]?.(value);
  }
  applyMod(c) {
    for (const v of this.voices) v.set[`mod:${c.from}>${c.to}`]?.(c.amount);
    const gm = this.globalMods?.get(`${c.from}>${c.to}`);
    if (gm) gm.amt.gain.setTargetAtTime(c.amount * gm.k, this.ac.currentTime, 0.01);
  }

  // ---- effects ----
  buildGlobals() {
    for (const g of this.globals.values()) g.nodes.forEach(n => { try { n.stop?.(); } catch { /* not started */ } n.disconnect(); });
    this.globals.clear();
    const ac = this.ac, t = ac.currentTime;
    for (const m of this.patch.modules) {
      if (MODULES[m.type].scope !== 'global') continue;
      const now = () => this.patch.modules.find(x => x.id === m.id)?.params || m.params; // its settings as they are now
      this.globals.set(m.id, m.type === 'glfo' ? this.buildGlobalLfo(m) : m.type === 'gseq' ? this.buildGlobalSeq(m) : m.type === 'rack' ? this.buildRack(m) : this.buildEffect(m, now));
    }
    // Modulation of effects: from the mod wheel or a Global LFO (global sources only; patch.js).
    this.globalMods = new Map();
    for (const c of this.patch.mod) {
      const [tid, key] = c.to.split('.'), target = this.globals.get(tid), params = target?.targets?.[key];
      const from = c.from === 'wheel' ? this.wheel : this.globals.get(c.from)?.out;
      if (!from || !params?.length) continue;
      const amt = ac.createGain(), k = target.scales?.[key] ?? 1;
      amt.gain.value = c.amount * k;
      from.connect(amt);
      params.forEach(pm => amt.connect(pm));
      target.nodes.push(amt, { disconnect: () => { try { from.disconnect(amt); } catch { /* gone */ } } });
      this.globalMods.set(`${c.from}>${c.to}`, { amt, k });
    }
    if (this.scopes) for (const [id, g] of this.globals) g.output?.connect(this.scope(id));
    for (const c of this.patch.audio) {
      const from = this.globals.get(c.from);
      if (!from?.output) continue;
      from.output.connect(c.to === 'out' ? this.bus : this.globals.get(c.to).input);
    }
  }

  // A Global LFO: one for the whole sound, for modulating effects. Its `out` feeds modulations.
  buildGlobalLfo(m) {
    const ac = this.ac, p = m.params, osc = ac.createOscillator(), depth = ac.createGain();
    osc.type = { sine: 'sine', triangle: 'triangle', square: 'square', saw: 'sawtooth' }[p.wave] || 'sine';
    osc.frequency.value = this.rateOf(p);
    depth.gain.value = p.depth;
    osc.connect(depth);
    if (!m.off) osc.start();
    const now = () => this.patch.modules.find(x => x.id === m.id)?.params || p;
    const rerate = () => osc.frequency.setTargetAtTime(this.rateOf(now()), ac.currentTime, 0.05);
    return { out: depth, nodes: [osc, depth], set: { rate: rerate, sync: rerate, _tempo: rerate, depth: v => depth.gain.setTargetAtTime(v, ac.currentTime, 0.05) },
      targets: { rate: [osc.frequency], depth: [depth.gain] } };
  }

  // A Global step sequence: one for the whole sound, running from when the effects were built.
  buildGlobalSeq(m) {
    const now = () => this.patch.modules.find(x => x.id === m.id)?.params || m.params;
    const s = stepSeq(this.ac, assets(this.ac), now, () => this.rateOf(now()));
    if (!m.off) s.osc.start();
    return { out: s.depth, nodes: [s.osc, s.shaper, s.depth], set: s.set, targets: { depth: [s.depth.gain] } };
  }

  // One effect: input → dry and wet → output, with `set` functions for its settings. `now()` gives
  // its settings as they are now (the page swaps the patch object as you edit).
  buildEffect(m, now) {
    const ac = this.ac, t = ac.currentTime;
    const p = m.params, input = ac.createGain(), output = ac.createGain(), dry = ac.createGain(), wet = ac.createGain();
    if (m.off) { // bypassed: straight through
      input.connect(output);
      return { input, output, nodes: [input, output], set: {} };
    }
    input.connect(dry).connect(output);
    wet.connect(output);
    const g = { input, output, nodes: [input, output, dry, wet], set: {} };
    const mix = (wetAmount, dryAmount = 1 - wetAmount) => { wet.gain.setTargetAtTime(wetAmount, ac.currentTime, 0.02); dry.gain.setTargetAtTime(dryAmount, ac.currentTime, 0.02); };
    if (m.type === 'chorus') {
      const lfo = ac.createOscillator(), depth = ac.createGain();
      lfo.frequency.value = p.rate;
      depth.gain.value = p.depth * 0.004;
      lfo.connect(depth);
      for (const [base, pan] of [[0.012, -0.7], [0.019, 0.7]]) {
        const d = ac.createDelay(0.1), panner = ac.createStereoPanner(), inv = ac.createGain();
        d.delayTime.value = base;
        panner.pan.value = pan;
        inv.gain.value = pan < 0 ? 1 : -1; // the two sides move opposite ways
        depth.connect(inv).connect(d.delayTime);
        input.connect(d).connect(panner).connect(wet);
        g.nodes.push(d, panner, inv);
      }
      lfo.start(t);
      g.nodes.push(lfo, depth);
      g.set = { rate: v => lfo.frequency.setTargetAtTime(v, ac.currentTime, 0.05), depth: v => depth.gain.setTargetAtTime(v * 0.004, ac.currentTime, 0.05), mix: v => mix(v, 1 - v * 0.5) };
      mix(p.mix, 1 - p.mix * 0.5);
      Object.assign(g, { targets: { rate: [lfo.frequency], depth: [depth.gain], mix: [wet.gain] }, scales: { depth: 0.004 } });
    } else if (m.type === 'delay') {
      // Normal: one echo line. Ping-pong: two, crossing, one each side. Tape: one with a
      // wobbling time and a little saturation in the loop.
      const line = pan => {
        const d = ac.createDelay(2.5), tone = ac.createBiquadFilter(), fb = ac.createGain();
        d.delayTime.value = this.timeOf(p);
        tone.type = 'lowpass';
        tone.frequency.value = p.tone;
        fb.gain.value = p.feedback;
        d.connect(tone).connect(fb);
        if (pan === null) tone.connect(wet);
        else { const pn = ac.createStereoPanner(); pn.pan.value = pan; tone.connect(pn).connect(wet); g.nodes.push(pn); }
        g.nodes.push(d, tone, fb);
        return { d, tone, fb };
      };
      const lines = p.mode === 'ping-pong' ? [line(-0.85), line(0.85)] : [line(null)];
      input.connect(lines[0].d);
      if (lines.length === 2) { lines[0].fb.connect(lines[1].d); lines[1].fb.connect(lines[0].d); }
      else if (p.mode === 'tape') {
        const sat = ac.createWaveShaper(), slow = ac.createOscillator(), fast = ac.createOscillator(), wob = ac.createGain();
        sat.curve = tapeSat();
        lines[0].fb.connect(sat).connect(lines[0].d);
        slow.frequency.value = 0.6; fast.frequency.value = 3.1;
        wob.gain.value = p.wobble * 0.004;
        slow.connect(wob); fast.connect(wob);
        wob.connect(lines[0].d.delayTime);
        slow.start(t); fast.start(t);
        g.nodes.push(sat, slow, fast, wob);
        g.set.wobble = v => wob.gain.setTargetAtTime(v * 0.004, ac.currentTime, 0.05);
      } else lines[0].fb.connect(lines[0].d);
      const retime = () => lines.forEach(l => l.d.delayTime.setTargetAtTime(this.timeOf(now()), ac.currentTime, 0.05));
      Object.assign(g.set, {
        time: retime, sync: retime, _tempo: retime,
        feedback: v => lines.forEach(l => l.fb.gain.setTargetAtTime(v, ac.currentTime, 0.02)),
        tone: v => lines.forEach(l => l.tone.frequency.setTargetAtTime(v, ac.currentTime, 0.02)),
        mix: v => mix(v, 1),
      });
      mix(p.mix, 1);
      g.targets = { time: lines.map(l => l.d.delayTime), feedback: lines.map(l => l.fb.gain), mix: [wet.gain] };
    } else if (m.type === 'reverb') {
      const conv = ac.createConvolver();
      // The response is remade (or the file loaded) a moment after its settings stop changing.
      let timer = null, made = 0;
      const remake = () => {
        const q = now(), n = ++made;
        if (q.type === 'file' && q.file) {
          fileBuffer(ac, q.file).then(buf => {
            if (n !== made) return;
            if (!buf) { conv.buffer = impulse(ac, { ...q, type: 'hall' }); return; }
            // The pre-delay goes in front of the file's own response.
            const pre = Math.round(ac.sampleRate * q.predelay / 1000), b = ac.createBuffer(2, buf.length + pre, ac.sampleRate);
            // Levelled like the made-up ones, so a loud recording doesn't jump out.
            let e = 0;
            for (let ch = 0; ch < buf.numberOfChannels; ch++) for (const x of buf.getChannelData(ch)) e += x * x;
            const k = 0.5 / Math.sqrt((e * 2 / buf.numberOfChannels) / ac.sampleRate || 1);
            for (let ch = 0; ch < 2; ch++) b.copyToChannel(buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1)).map(x => x * k), ch, pre);
            conv.buffer = b;
          });
        } else conv.buffer = impulse(ac, q.type === 'file' ? { ...q, type: 'hall' } : q);
      };
      remake();
      input.connect(conv).connect(wet);
      g.nodes.push(conv);
      const later = () => { clearTimeout(timer); timer = setTimeout(remake, 150); };
      g.set = { type: later, file: later, size: later, predelay: later, damping: later, mix: v => mix(v, 1 - v * 0.4) };
      mix(p.mix, 1 - p.mix * 0.4);
      g.targets = { mix: [wet.gain] };
    } else if (m.type === 'shimmer') {
      // Input → reverb → out, and reverb → octave-up pitch shifter → low-pass → feedback → back into
      // the reverb (with a short delay, which a feedback loop needs, and a soft clip so high settings
      // can't run away), so each pass of the tail rings higher.
      const sum = ac.createGain(), conv = ac.createConvolver(), lp = ac.createBiquadFilter(), hp = ac.createBiquadFilter(), fb = ac.createGain(), dl = ac.createDelay(0.1), clip = ac.createWaveShaper();
      const ratioOf = q => ({ fifth: 1.5, '2 octaves': 4 })[q.interval] || 2;
      // The reverb's response peaks above 1 at some frequencies, so feedback at face value built up
      // without end (measured over 12 s, worst on a bright saw); a fifth stays below the loop's
      // low-pass for more passes than an octave, so it gets less. Shimmer 0.9 = the longest bloom
      // that still dies away.
      const loopGain = ({ fifth: 0.5 })[p.interval] || 0.68;
      const shifter = pitchShifter(ac, ratioOf(p));
      lp.type = 'lowpass'; lp.frequency.value = p.tone;
      hp.type = 'highpass'; hp.frequency.value = 300; // the low residue the grain crossfades leave unshifted would recirculate
      fb.gain.value = p.shimmer * loopGain;
      dl.delayTime.value = 0.03;
      clip.curve = softClip();
      input.connect(sum).connect(conv).connect(wet);
      conv.connect(shifter.input); shifter.output.connect(hp).connect(lp).connect(fb).connect(clip).connect(dl).connect(sum);
      const remake = () => { const q = now(); conv.buffer = impulse(ac, { type: 'hall', size: q.size, predelay: 10, damping: q.damping }); };
      remake();
      let timer = null;
      const later = () => { clearTimeout(timer); timer = setTimeout(remake, 150); };
      g.nodes.push(sum, conv, lp, hp, fb, dl, clip, ...shifter.nodes);
      g.set = { size: later, damping: later, tone: v => lp.frequency.setTargetAtTime(v, ac.currentTime, 0.02),
        shimmer: v => fb.gain.setTargetAtTime(v * loopGain, ac.currentTime, 0.02), mix: v => mix(v, 1 - v * 0.4) };
      mix(p.mix, 1 - p.mix * 0.4);
      g.targets = { mix: [wet.gain], shimmer: [fb.gain] };
      g.scales = { shimmer: loopGain };
    } else if (m.type === 'soundboard') {
      const conv = ac.createConvolver();
      conv.normalize = false;
      let timer = null;
      const remake = () => {
        conv.buffer = soundboardImpulse(ac.sampleRate, now(), (chans, len) => {
          const buf = ac.createBuffer(2, len, ac.sampleRate);
          chans.forEach((d, ch) => buf.copyToChannel(d, ch));
          return buf;
        });
      };
      remake();
      input.connect(conv).connect(wet);
      g.nodes.push(conv);
      const later = () => { clearTimeout(timer); timer = setTimeout(remake, 150); };
      g.set = { type: later, size: later, tone: later, width: later, mix: v => mix(v) };
      mix(p.mix);
      g.targets = { mix: [wet.gain] };
    } else if (m.type === 'phaser') {
      // Four all-pass filters swept together by an LFO; mixed with the dry sound they cut moving notches.
      const lfo = ac.createOscillator(), depth = ac.createGain(), fb = ac.createGain(), aps = [];
      for (let k = 0; k < 4; k++) { const f = ac.createBiquadFilter(); f.type = 'allpass'; f.frequency.value = 700; f.Q.value = 0.6; aps.push(f); }
      aps.reduce((a, b) => a.connect(b));
      input.connect(aps[0]);
      aps[3].connect(wet);
      aps[3].connect(fb).connect(aps[0]);
      fb.gain.value = p.feedback;
      lfo.frequency.value = p.rate;
      depth.gain.value = p.depth * 2400; // cents: up to ±2 octaves
      lfo.connect(depth);
      aps.forEach(f => depth.connect(f.detune));
      lfo.start(t);
      g.nodes.push(lfo, depth, fb, ...aps);
      g.set = { rate: v => lfo.frequency.setTargetAtTime(v, ac.currentTime, 0.05), depth: v => depth.gain.setTargetAtTime(v * 2400, ac.currentTime, 0.05),
        feedback: v => fb.gain.setTargetAtTime(v, ac.currentTime, 0.02), mix: v => mix(v, 1) };
      mix(p.mix, 1);
      Object.assign(g, { targets: { rate: [lfo.frequency], depth: [depth.gain], feedback: [fb.gain] }, scales: { depth: 2400 } });
    } else if (m.type === 'flanger') {
      const d = ac.createDelay(0.05), lfo = ac.createOscillator(), depth = ac.createGain(), fb = ac.createGain();
      d.delayTime.value = 0.004;
      lfo.frequency.value = p.rate;
      depth.gain.value = p.depth * 0.0035;
      lfo.connect(depth).connect(d.delayTime);
      fb.gain.value = p.feedback;
      input.connect(d).connect(wet);
      d.connect(fb).connect(d);
      lfo.start(t);
      g.nodes.push(d, lfo, depth, fb);
      g.set = { rate: v => lfo.frequency.setTargetAtTime(v, ac.currentTime, 0.05), depth: v => depth.gain.setTargetAtTime(v * 0.0035, ac.currentTime, 0.05),
        feedback: v => fb.gain.setTargetAtTime(v, ac.currentTime, 0.02), mix: v => mix(v, 1) };
      mix(p.mix, 1);
      Object.assign(g, { targets: { rate: [lfo.frequency], depth: [depth.gain], feedback: [fb.gain] }, scales: { depth: 0.0035 } });
    } else if (m.type === 'tremolo') {
      // The depth is shared between volume (pan 0) and left-right movement (pan 1).
      const vca = ac.createGain(), pn = ac.createStereoPanner(), lfo = ac.createOscillator(), vol = ac.createGain(), side = ac.createGain();
      const apply = () => {
        const q = now(), at = ac.currentTime;
        vca.gain.setTargetAtTime(1 - q.depth * (1 - q.pan) * 0.5, at, 0.02);
        vol.gain.setTargetAtTime(q.depth * (1 - q.pan) * 0.5, at, 0.02);
        side.gain.setTargetAtTime(q.depth * q.pan, at, 0.02);
      };
      lfo.frequency.value = this.rateOf(p);
      lfo.connect(vol).connect(vca.gain);
      lfo.connect(side).connect(pn.pan);
      input.connect(vca).connect(pn).connect(wet);
      lfo.start(t);
      apply();
      g.nodes.push(vca, pn, lfo, vol, side);
      const rerate = () => lfo.frequency.setTargetAtTime(this.rateOf(now()), ac.currentTime, 0.05);
      g.set = { rate: rerate, sync: rerate, _tempo: rerate, depth: apply, pan: apply };
      g.targets = { rate: [lfo.frequency] };
      mix(1, 0);
    } else if (m.type === 'eq') {
      const lo = ac.createBiquadFilter(), mid = ac.createBiquadFilter(), hi = ac.createBiquadFilter();
      lo.type = 'lowshelf'; lo.frequency.value = 120; lo.gain.value = p.low;
      mid.type = 'peaking'; mid.frequency.value = p.midfreq; mid.Q.value = 0.9; mid.gain.value = p.mid;
      hi.type = 'highshelf'; hi.frequency.value = 8000; hi.gain.value = p.high;
      input.connect(lo).connect(mid).connect(hi).connect(wet);
      g.nodes.push(lo, mid, hi);
      const to = (param, v) => param.setTargetAtTime(v, ac.currentTime, 0.02);
      g.set = { low: v => to(lo.gain, v), mid: v => to(mid.gain, v), midfreq: v => to(mid.frequency, v), high: v => to(hi.gain, v) };
      g.targets = { low: [lo.gain], mid: [mid.gain], high: [hi.gain] };
      mix(1, 0);
    } else if (m.type === 'shaper') {
      const sh = ac.createWaveShaper(), dc = ac.createBiquadFilter(), tone = ac.createBiquadFilter(), lvl = ac.createGain();
      sh.curve = shaperCurve(p.curve, p.drive);
      sh.oversample = '4x';
      dc.type = 'highpass'; dc.frequency.value = 20; // the lopsided curves add a DC offset
      tone.type = 'lowpass'; tone.frequency.value = p.tone; tone.Q.value = 0.5;
      lvl.gain.value = p.level;
      input.connect(sh).connect(dc).connect(tone).connect(lvl).connect(wet);
      g.nodes.push(sh, dc, tone, lvl);
      const reshape = () => { const q = now(); sh.curve = shaperCurve(q.curve, q.drive); };
      g.set = { curve: reshape, drive: reshape, tone: v => tone.frequency.setTargetAtTime(v, ac.currentTime, 0.02), level: v => lvl.gain.setTargetAtTime(v, ac.currentTime, 0.02), mix: v => mix(v) };
      g.targets = { tone: [tone.frequency], level: [lvl.gain] };
      mix(p.mix);
    } else if (m.type === 'resonance') {
      // Pedal resonance (fxworklet.js): the other strings, ringing while the sustain pedal is down.
      // It hears the pedal and which notes are sounding from setPedal() and the voices (port).
      if (!fxReady(ac)) { this.fxPending = true; mix(0, 1); return g; }
      const node = new AudioWorkletNode(ac, 'ost-resonance', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      const to = (key, v) => node.parameters.get(key)?.setValueAtTime(v, ac.currentTime);
      to('amount', p.amount); to('ring', p.ring); to('pedal', this.pedals?.sustain ? 1 : 0);
      g.pedal = node.parameters.get('pedal');
      g.held = [0, 1, 2, 3].map(i => node.parameters.get('held' + i));
      this.tellResonance(ac.currentTime);
      // Fed by a Piano module (finished sound, far smaller numbers than a String's bridge signal) it
      // needs more input: set so the halo of a pedalled phrase sits about 12 dB under the notes at Amount 0.5.
      const feeds = (id, seen = new Set()) => this.patch.audio.some(c => c.to === id && !seen.has(c.from) && (seen.add(c.from), this.patch.modules.find(x => x.id === c.from)?.type === 'piano' || feeds(c.from, seen)));
      const fromPiano = feeds(m.id);   // straight from it, or through a filter or EQ
      const drive = ac.createGain();
      drive.gain.value = fromPiano ? PIANO_HALO : 1;
      input.connect(drive).connect(node).connect(wet);
      g.nodes.push(node, drive);
      g.set = { amount: v => to('amount', v), ring: v => to('ring', v) };
      mix(1, 1); // added to the strings, not instead of them
    } else if (m.type === 'grains') {
      // Grain delay (fxworklet.js 'ost-grains'); passes the sound through until the worklet has loaded.
      if (!fxReady(ac)) { this.fxPending = true; mix(0, 1); return g; }
      const node = new AudioWorkletNode(ac, 'ost-grains', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      const to = (key, v) => node.parameters.get(key)?.setValueAtTime(v, ac.currentTime);
      const keys = ['scatter', 'size', 'density', 'pitch', 'jitter', 'reverse', 'feedback', 'width'];
      for (const k of keys) { to(k, p[k]); g.set[k] = v => to(k, v); }
      const retime = () => to('time', this.timeOf(now()));
      retime(); to('hold', p.hold === 'on' ? 1 : 0);
      Object.assign(g.set, { time: retime, sync: retime, _tempo: retime, hold: v => to('hold', v === 'on' ? 1 : 0), mix: v => mix(v) });
      input.connect(node).connect(wet);
      g.nodes.push(node);
      g.targets = { ...Object.fromEntries(['time', 'pitch', 'density', 'feedback', 'hold'].map(k => [k, [node.parameters.get(k)]])), mix: [wet.gain] };
      mix(p.mix);
    } else if (WORKLET_FX.includes(m.type)) {
      // Bitcrusher, Stutter, Freeze (fxworklet.js). Until the worklet has loaded they pass the
      // sound through; loadSamples() rebuilds the effects once it has.
      if (!fxReady(ac)) { this.fxPending = true; mix(0, 1); return g; }
      const name = { crusher: 'ost-crush', stutter: 'ost-stutter', freeze: 'ost-freeze' }[m.type];
      const node = new AudioWorkletNode(ac, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      const to = (key, v) => node.parameters.get(key)?.setValueAtTime(v, ac.currentTime);
      if (m.type === 'crusher') { to('bits', p.bits); to('hold', p.hold); }
      if (m.type === 'stutter') { to('size', p.size); to('chance', p.chance); to('repeats', p.repeats); }
      if (m.type === 'freeze') { to('frozen', p.state === 'frozen' ? 1 : 0); to('size', p.size); }
      input.connect(node).connect(wet);
      g.nodes.push(node);
      g.set = { bits: v => to('bits', v), hold: v => to('hold', v), size: v => to('size', v), chance: v => to('chance', v), repeats: v => to('repeats', v),
        state: v => to('frozen', v === 'frozen' ? 1 : 0), mix: v => mix(v) };
      g.targets = Object.fromEntries(['bits', 'hold', 'chance', 'frozen'].map(k => [k, node.parameters.get(k) ? [node.parameters.get(k)] : []]));
      mix(p.mix);
    } else if (m.type === 'scanner') {
      // The tonewheel organ's vibrato scanner: a tapped delay line (about 1 ms, 9 LC stages)
      // swept up and back by a 16-pole capacitive switch at 412 rpm, ≈ 6.9 Hz, so the delay moves
      // in a triangle: V3 sweeps the whole line, V2 about half, V1 about a third (Hammond-Leslie
      // FAQ; stefanv.com). Chorus (C1–C3) mixes it with the dry signal, equal parts at equal power
      // (halves lost ~3 dB where the two beat). The line also
      // acts as a sweeping low-pass; that isn't modelled (its cutoff isn't published).
      const SWEEP = { 1: 0.00033, 2: 0.0005, 3: 0.001 };
      const d = ac.createDelay(0.005), lfo = ac.createOscillator(), amt = ac.createGain();
      lfo.type = 'triangle'; lfo.frequency.value = 6.9;
      lfo.connect(amt).connect(d.delayTime);
      input.connect(d).connect(wet);
      lfo.start(t);
      g.nodes.push(d, lfo, amt);
      const setMode = v => {
        const sweep = SWEEP[v[1]] || SWEEP[3];
        d.delayTime.setValueAtTime(0.0002 + sweep / 2, ac.currentTime); amt.gain.setValueAtTime(sweep / 2, ac.currentTime);
        if (v[0] === 'C') mix(Math.SQRT1_2, Math.SQRT1_2); else mix(1, 0);
      };
      setMode(p.mode);
      g.set = { mode: setMode };
    } else if (m.type === 'rotary') {
      // Highs to the horn, lows to the drum: an 800 Hz Linkwitz-Riley crossover (two Butterworths
      // a side), whose halves add back up flat (a single pair left a ~10 dB hole at 800 Hz).
      // Recorded with two mics (left and right, 120° apart), each hearing every rotor along a few
      // paths, as Smith, Serafin, Abel & Berners model it (DAFx 2002): straight from the rotor and
      // off two of the cabinet's walls, each path a delay that follows the rotor's distance along
      // its direction (the Doppler wobble, each path's a little different: the chorus), a gain
      // and, for the horn, a low-pass that opens as the horn's mouth turns towards it (a horn
      // beams its highs, so they swing more than its lows); plus a little of the horn's sound
      // leaking out unmoved. Horn radius ~0.25 m (±0.74 ms, about ±50 cents at tremolo); the drum
      // is a rotating scoop in front of a fixed woofer, so it's mostly a swing in level with very
      // little Doppler (Henricksen 1981). Their speeds come from a control signal (slow 0 … fast
      // 1, plus the wheel) through a lag that spins up faster than it coasts down, as a Leslie's
      // do: the horn gets 90% of the way in Inertia seconds up and 1.5× that down, the drum 4.5×
      // and 6.5× (reported: horn ~1–1.5 s up, ~1.5–2 s down; drum ~5 s up, ~7 s down). The lag
      // runs in the worklet; until it has loaded, a first-order filter with the spin-up times
      // stands in.
      const SPEEDS = { horn: [0.8, 6.7], drum: [0.67, 5.8] }, LAGS = { horn: [1, 1.5], drum: [4.5, 6.5] };
      const MICS = [-60, 60]; // degrees
      // Per rotor, at Depth 1: Doppler (s of delay swing), level swing, the horn's beam (low-pass
      // Hz, swinging ±1 octave); each path's direction (degrees from its mic), delay and level.
      const ROTORS = {
        horn: { doppler: 0.00074, am: 0.4, beam: 5000, leak: 0.12,
          paths: [{ dir: 0, delay: 0.0015, level: 1 }, { dir: 110, delay: 0.0032, level: 0.45 }, { dir: -130, delay: 0.0047, level: 0.35 }] },
        drum: { doppler: 0.00008, am: 0.5,
          paths: [{ dir: 0, delay: 0.0015, level: 1 }, { dir: 140, delay: 0.003, level: 0.5 }] },
      };
      const merge = ac.createChannelMerger(2);
      merge.connect(wet);
      g.nodes.push(merge);
      const fit = ac.createGain(), pre = ac.createWaveShaper(), speed = ac.createConstantSource();
      const lowF = [0, 1].map(() => ac.createBiquadFilter()), highF = [0, 1].map(() => ac.createBiquadFilter());
      pre.curve = rotaryAmpCurve(ac, p.drive);
      pre.oversample = p.drive > 0 ? '2x' : 'none';
      fit.gain.value = 1 / ROTARY_ROOM;
      // Web Audio's low/high-pass Q is a resonance in dB: Butterworth (Q 1/√2) = −3.01 dB.
      for (const f of lowF) { f.type = 'lowpass'; f.frequency.value = 800; f.Q.value = 20 * Math.log10(Math.SQRT1_2); }
      for (const f of highF) { f.type = 'highpass'; f.frequency.value = 800; f.Q.value = 20 * Math.log10(Math.SQRT1_2); }
      lowF[0].connect(lowF[1]); highF[0].connect(highF[1]);
      speed.offset.value = p.speed === 'fast' ? 1 : 0;
      speed.start(t);
      input.connect(fit).connect(pre);
      g.nodes.push(fit, pre, ...lowF, ...highF, speed);
      if (!fxReady(ac)) this.fxPending = true;
      const tau = (name, inertia, k) => LAGS[name][k] * inertia / Math.LN10; // 90% of the way = 2.3 τ
      const rotor = (name, band) => {
        const [slow, fast] = SPEEDS[name];
        const base = ac.createConstantSource(), span = ac.createGain();
        base.offset.value = slow; span.gain.value = fast - slow;
        let lag;
        if (fxReady(ac)) {
          lag = new AudioWorkletNode(ac, 'ost-slew', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
          lag.parameters.get('up').value = tau(name, p.inertia, 0);
          lag.parameters.get('down').value = tau(name, p.inertia, 1);
        } else {
          const a = Math.exp(-1 / (tau(name, p.inertia, 0) * ac.sampleRate));
          lag = ac.createIIRFilter([1 - a], [1, -a]);
        }
        speed.connect(span).connect(lag);
        base.connect(lag);
        if (p.wheel !== 'off') { this.wheel.connect(span); g.nodes.push({ disconnect: () => { try { this.wheel.disconnect(span); } catch { /* gone */ } } }); }
        const sin = ac.createOscillator(), cos = ac.createOscillator();
        sin.frequency.value = cos.frequency.value = 0;
        cos.setPeriodicWave(assets(ac).cosine);
        lag.connect(sin.frequency); lag.connect(cos.frequency);
        base.start(t); sin.start(t); cos.start(t);
        g.nodes.push(base, span, lag, sin, cos);
        const spec = ROTORS[name], k = Math.sqrt(0.5 / spec.paths.reduce((e, q) => e + q.level ** 2, (spec.leak || 0) ** 2));
        const buses = [0, 1].map(ch => { const b = ac.createGain(); b.gain.value = (name === 'horn' ? p.balance : 1 - p.balance) * 2; b.connect(merge, 0, ch); g.nodes.push(b); return b; });
        const out = band[1], paths = [];
        pre.connect(band[0]);
        MICS.forEach((mic, ch) => {
          for (const q of spec.paths) {
            // How far the rotor points along this path: cos(θ − φ) = cos θ cos φ + sin θ sin φ.
            const phi = (mic + q.dir) * Math.PI / 180, toward = ac.createGain(), ps = ac.createGain(), pc = ac.createGain();
            ps.gain.value = Math.sin(phi); pc.gain.value = Math.cos(phi);
            sin.connect(ps).connect(toward); cos.connect(pc).connect(toward);
            const delay = ac.createDelay(0.02), am = ac.createGain(), level = ac.createGain(), dAmt = ac.createGain(), aAmt = ac.createGain();
            delay.delayTime.value = q.delay;
            level.gain.value = q.level * k;
            toward.connect(dAmt).connect(delay.delayTime);
            toward.connect(aAmt).connect(am.gain);
            let into = am;
            const path = { dAmt, aAmt, am };
            if (spec.beam) {
              const lp = ac.createBiquadFilter(), fAmt = ac.createGain();
              lp.type = 'lowpass'; lp.frequency.value = spec.beam; lp.Q.value = 20 * Math.log10(Math.SQRT1_2);
              toward.connect(fAmt).connect(lp.detune);
              am.connect(lp); into = lp;
              path.fAmt = fAmt;
              g.nodes.push(lp, fAmt);
            }
            out.connect(delay).connect(am);
            into.connect(level).connect(buses[ch]);
            g.nodes.push(toward, ps, pc, delay, am, level, dAmt, aAmt);
            paths.push(path);
          }
          if (spec.leak) { const lk = ac.createGain(); lk.gain.value = spec.leak * k; out.connect(lk).connect(buses[ch]); g.nodes.push(lk); }
        });
        return { name, buses, paths, spec, lag };
      };
      const horn = rotor('horn', highF), drum = rotor('drum', lowF);
      const depthTo = v => [horn, drum].forEach(r => r.paths.forEach(q => {
        q.dAmt.gain.value = -r.spec.doppler * v; // pointing along the path = nearer = shorter
        q.am.gain.value = 1 - r.spec.am * v / 2; q.aAmt.gain.value = r.spec.am * v / 2;
        if (q.fAmt) q.fAmt.gain.value = 1200 * v;
      }));
      depthTo(p.depth);
      g.set = {
        speed: v => speed.offset.setValueAtTime(v === 'fast' ? 1 : 0, ac.currentTime),
        depth: depthTo,
        drive: v => { pre.curve = rotaryAmpCurve(ac, v); pre.oversample = v > 0 ? '2x' : 'none'; },
        balance: v => { horn.buses.forEach(b => b.gain.setTargetAtTime(v * 2, ac.currentTime, 0.02)); drum.buses.forEach(b => b.gain.setTargetAtTime((1 - v) * 2, ac.currentTime, 0.02)); },
        inertia: v => [horn, drum].forEach(r => { if (r.lag.parameters) { r.lag.parameters.get('up').value = tau(r.name, v, 0); r.lag.parameters.get('down').value = tau(r.name, v, 1); } }),
        mix: v => mix(v),
      };
      g.targets = { speed: [speed.offset] };
      mix(p.mix);
    } else if (m.type === 'compressor') {
      const c = ac.createDynamicsCompressor(), make = ac.createGain();
      c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.attack.value = p.attack; c.release.value = p.release; c.knee.value = 6;
      make.gain.value = 10 ** (p.gain / 20);
      input.connect(c).connect(make).connect(wet);
      g.nodes.push(c, make);
      const to = (param, v) => param.setTargetAtTime(v, ac.currentTime, 0.02);
      g.targets = { threshold: [c.threshold] };
      g.set = { threshold: v => to(c.threshold, v), ratio: v => to(c.ratio, v), attack: v => to(c.attack, v), release: v => to(c.release, v),
        gain: v => to(make.gain, 10 ** (v / 20)) };
      mix(1, 0);
    }
    return g;
  }

  // An effect rack: its effects in series, blended with the dry sound by Mix, then Level.
  // Settings of the effects inside are set as "<index>.<key>".
  buildRack(m) {
    const ac = this.ac, input = ac.createGain(), output = ac.createGain(), dry = ac.createGain(), wet = ac.createGain();
    const g = { input, output, nodes: [input, output, dry, wet], set: {} };
    const inner = () => this.patch.modules.find(x => x.id === m.id)?.rack || m.rack;
    if (m.off || !m.rack.modules.length) { input.connect(output); return g; }
    input.connect(dry).connect(output);
    let prev = input;
    m.rack.modules.forEach((e, k) => {
      const fx = this.buildEffect(e, () => inner().modules[k]?.params || e.params);
      prev.connect(fx.input);
      prev = fx.output;
      g.nodes.push(...fx.nodes);
      for (const [key, f] of Object.entries(fx.set)) g.set[`${k}.${key}`] = f;
    });
    prev.connect(wet).connect(output);
    const mix = v => { wet.gain.setTargetAtTime(v, ac.currentTime, 0.02); dry.gain.setTargetAtTime(1 - v, ac.currentTime, 0.02); };
    mix(m.params.mix);
    output.gain.value = m.params.level;
    g.set.mix = mix;
    g.set.level = v => output.gain.setTargetAtTime(v, ac.currentTime, 0.02);
    return g;
  }

  // ---- pedals ----
  // The sustain pedal (the page holds the notes; this tells Pedal resonance) and the soft pedal
  // (una corda: hammered strings struck from now on hit one string fewer, with softer felt).
  setPedal(kind, down, t = this.ac.currentTime) {
    this.pedals = { ...this.pedals, [kind]: !!down };
    if (kind === 'sustain') for (const g of this.globals.values()) g.pedal?.setValueAtTime(down ? 1 : 0, t);
  }
  // Which notes are sounding at time t, as Pedal resonance's held0-3 bits (22 notes each from A0),
  // set at t: called when a note starts or is let go (in time order, as notes are played).
  tellResonance(t) {
    const bits = [0, 0, 0, 0];
    for (const v of this.voices) {
      if (v.t0 > t + 1e-6 || (v.released && v.relAt <= t + 1e-6)) continue;
      const k = v.note - 21;
      if (k >= 0 && k < 88 && !(Math.floor(bits[Math.floor(k / 22)] / 2 ** (k % 22)) % 2)) bits[Math.floor(k / 22)] += 2 ** (k % 22);
    }
    for (const g of this.globals.values()) g.held?.forEach((prm, i) => prm.setValueAtTime(bits[i], t));
  }

  // ---- notes ----
  // With the arpeggiator on, keys aren't played but held for it (arpPump plays them).
  noteOn(note, vel, t0 = this.ac.currentTime) {
    if (this.patch?.arp) { this.arpHold(note, vel, t0, Infinity); return null; }
    return this.startNote(note, vel, t0);
  }
  noteOff(note, t = this.ac.currentTime) {
    const h = this.arp.holds.find(x => x.note === note && x.to === Infinity && !x.latched);
    if (!h) { this.stopNote(note, t); return; }
    // Latch: a key let go keeps playing, until a new key goes down with all the others up.
    if (this.patch?.arp?.latch) h.latched = true; else { h.to = t; this.arpPump(); }
  }
  play(note, vel, t0, dur) {
    if (this.patch?.arp) this.arpHold(note, vel, t0, t0 + dur); else this.playNote(note, vel, t0, dur);
  }

  // ---- the arpeggiator (patch.arp) ----
  // Keys are "holds" ({ note, vel, from, to }: `to` is Infinity until a live key is let go; notes
  // from the sequencer come with their end). A clock steps at the arp's rate from the moment the
  // first key goes down, playing one of the notes held at each step; when a step finds no key
  // held, the clock stops, and starts again (from the top of the pattern) with the next key. Steps
  // are worked out a little ahead (120 ms) on a timer in a worker, which browsers don't slow down
  // in background tabs; offline, all at once before rendering.
  arpHold(note, vel, from, to) {
    const a = this.arp;
    // Latched keys with no finger left on any key: a new key (a live one) starts a new set.
    if (to === Infinity && !a.holds.some(h => h.to === Infinity && !h.latched)) for (const h of a.holds) if (h.latched && h.to === Infinity) h.to = from;
    for (const h of a.holds) if (h.note === note && h.to === Infinity) h.to = from;
    // The clock starts with this key if it isn't running, or if nothing is held between now and its
    // next step: waiting for the old clock made a key played just after letting go start late, and
    // a short tap (let go before that step) never sound at all.
    if (a.next == null || (a.next > from && !a.holds.some(h => h.to > from && h.from < a.next))) { a.next = from; a.index = 0; }
    a.holds.push({ note, vel, from, to, seq: a.seq++ });
    if (this.offline()) return;
    this.arpTicker(true);
    // Step once the caller is done, not now: a sequencer hands over a chord one note at a time, and
    // stepping on the first would start the pattern with only that note held.
    if (!a.soon) { a.soon = true; queueMicrotask(() => { a.soon = false; this.arpPump(); }); }
  }
  offline() { return typeof OfflineAudioContext !== 'undefined' && this.ac instanceof OfflineAudioContext; }
  arpPump(horizon = this.ac.currentTime + 0.12) {
    const a = this.arp, arp = this.patch?.arp;
    if (!arp) { a.holds = []; a.next = null; this.arpTicker(false); return; }
    const step = syncBeats(arp.rate) * 60 / (this.tempo || 120), len = Math.max(0.02, step * arp.gate), now = this.ac.currentTime;
    if (!(step > 0.005)) { a.next = null; return; } // no rate: nothing to step by (and the loop below would never end)
    while (a.next != null && a.next < horizon) {
      // Fallen behind (the page was busy, or asleep): the missed steps are skipped, not all played at once.
      if (a.next < now - 0.15) { const missed = Math.ceil((now - a.next) / step); a.next += missed * step; a.index += missed; continue; }
      const t = a.next, held = a.holds.filter(h => h.from <= t + 1e-4 && h.to > t + 1e-4);
      if (!held.length) {
        // Nobody's holding a key: wait for the next one, and start the pattern again there.
        const coming = a.holds.filter(h => h.from > t).map(h => h.from);
        a.next = coming.length ? Math.min(...coming) : null;
        a.index = 0;
        continue;
      }
      // All new keys since the last step (a sequencer's next chord, which starts as the last one ends): from the top.
      if (a.heldSeqs && !held.some(h => a.heldSeqs.has(h.seq))) a.index = 0;
      a.heldSeqs = new Set(held.map(h => h.seq));
      const order = arpOrder(held, arp);
      let k = a.index % order.length;
      if (arp.mode === 'random') { k = Math.floor(Math.random() * order.length); if (k === a.last && order.length > 1) k = (k + 1) % order.length; a.last = k; }
      a.index++;
      a.next = t + step; // before playing: a note that fails must not be tried again every tick
      try {
        if (arp.mode === 'chord') for (const h of held) this.playNote(h.note, h.vel, t, len);
        else this.playNote(order[k].note, order[k].vel, t, len);
      } catch (e) { console.error('arpeggiator', e); }
    }
    a.holds = a.holds.filter(h => h.to > now - 0.5);
    if (!a.holds.length && a.next == null) this.arpTicker(false);
  }
  arpTicker(on) { this.arp.ticking = on; arpListen(this, on); }
  arpOff() { this.arp.holds = []; this.arp.next = null; this.arpTicker(false); }
  arpUnlatch(t = this.ac.currentTime) { for (const h of this.arp.holds) if (h.latched && h.to === Infinity) h.to = t; this.arpPump(); }

  startNote(note, vel, t0 = this.ac.currentTime) {
    if (!this.patch) return null;
    if (this.patch.play === 'mono' || this.patch.play === 'legato') return this.monoOn(note, vel, t0);
    for (const v of this.voices) if (v.note === note && !v.released) this.release(v, t0);
    const live = this.voices.filter(v => v.end > t0);
    if (live.length >= this.patch.voices) this.kill(live.find(v => v.released) || live[0], t0);
    const v = this.buildVoice(note, vel, t0);
    // Drum pads in a choke group cut each other off (an open hat stops when the closed one plays).
    if (v.choke) for (const o of this.voices) if (o.choke === v.choke && o.end > t0) this.kill(o, t0);
    this.voices.push(v);
    this.voices = this.voices.filter(x => x.end === Infinity || x.end > this.ac.currentTime - 0.1);
    v.t0 = t0;
    this.tellResonance(t0);
    return v;
  }
  stopNote(note, t = this.ac.currentTime) {
    if (this.patch?.play === 'mono' || this.patch?.play === 'legato') { this.monoOff(note, t); return; }
    for (const v of this.voices) if (v.note === note && !v.released) this.release(v, t);
  }
  playNote(note, vel, t0, dur) {
    if (this.patch?.play === 'mono' || this.patch?.play === 'legato') { this.monoOn(note, vel, t0); this.monoOff(note, t0 + dur); return; }
    const v = this.startNote(note, vel, t0);
    if (v) this.release(v, t0 + dur);
  }

  // ---- mono and legato: one voice; keys held down are remembered (last one wins) ----
  // Mono: every new note starts the envelopes again, and with Glide the pitch slides from the last
  // note. Legato: a note played while another is held (or within 10 ms of its end, so a sequencer's
  // touching notes count) moves the sounding voice to the new pitch, gliding if Glide is set, without
  // starting the envelopes again; letting go goes back to the key still held.
  monoOn(note, vel, t0) {
    this.held = (this.held || []).filter(h => h.note !== note);
    this.held.push({ note, vel });
    const cur = this.voices.find(v => v.mono && v.end === Infinity && (!v.released || v.relAt > t0 - 0.01));
    if (cur && this.patch.play === 'legato' && (!cur.released || cur.relAt >= t0 - 0.01)) {
      this.unrelease(cur);
      this.glideTo(cur, note, t0);
      return cur;
    }
    const from = this.lastPitch;
    for (const v of this.voices) if (v.mono && v.end === Infinity) this.kill(v, t0);
    const v = this.buildVoice(note, vel, t0);
    v.mono = true;
    if (this.patch.glide > 0 && from != null && from !== note && (this.patch.play === 'mono' || cur)) {
      v.glide.setValueAtTime((from - note) * 100, t0);
      v.glide.setTargetAtTime(0, t0, this.patch.glide / 3);
    }
    this.lastPitch = note;
    this.voices.push(v);
    this.voices = this.voices.filter(x => x.end === Infinity || x.end > this.ac.currentTime - 0.1);
    return v;
  }
  monoOff(note, t) {
    this.held = (this.held || []).filter(h => h.note !== note);
    const cur = this.voices.find(v => v.mono && !v.released && v.note === note);
    if (!cur) return;
    const back = this.held.at(-1);
    if (!back) { this.release(cur, t); return; }
    if (this.patch.play === 'legato') this.glideTo(cur, back.note, t);
    else { this.held.pop(); this.monoOn(back.note, back.vel, t); }
  }
  glideTo(v, note, t) {
    const cents = (note - v.base) * 100, g = this.patch.glide || 0;
    v.glide.cancelScheduledValues(t);
    if (g > 0) v.glide.setTargetAtTime(cents, t, g / 3); else v.glide.setValueAtTime(cents, t);
    v.note = note;
    this.lastPitch = note;
  }
  // A mono voice whose release was scheduled, carried on by a legato note: its release is taken back.
  unrelease(v) {
    if (!v.released) return;
    for (const p of v.relParams) p.cancelScheduledValues(v.relAt);
    v.released = false;
    v.relAt = undefined;
  }

  // Fast fade on everything (Stop, or a rebuild).
  allOff(now = false) {
    this.arpOff();
    const t = this.ac.currentTime;
    for (const v of this.voices) if (now || !v.released) this.kill(v, t);
  }

  // Quiet at once, echoes and reverb tails included: a quick fade, then fresh effects.
  silence() {
    this.allOff(true);
    if (!this.patch) return;
    const g = this.bus.gain, t = this.ac.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, 0.01);
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.buildGlobals();
      g.cancelScheduledValues(this.ac.currentTime);
      g.setValueAtTime(1, this.ac.currentTime);
    }, 80);
  }

  release(v, t) {
    if (v.released) return;
    v.released = true;
    v.relAt = t;
    this.tellResonance(t);
    for (const f of v.offs) f(t);
    if (!v.mono) { v.stopAt(t + v.tail); return; }
    // Mono: stop later, unless a legato note has carried the voice on by then.
    const check = () => {
      if (!v.released || v.end !== Infinity) return;
      if (this.ac.currentTime < v.relAt + v.tail) { setTimeout(check, 250); return; }
      v.stopAt(v.relAt + v.tail);
    };
    setTimeout(check, Math.max(0, (t + v.tail - this.ac.currentTime) * 1000) + 50);
  }
  kill(v, t) {
    v.released = true;
    for (const e of v.exits) { e.gain.cancelScheduledValues(t); e.gain.setTargetAtTime(0, t, 0.006); }
    v.stopAt(t + 0.05);
  }

  buildVoice(note, vel, t0) {
    const ac = this.ac, patch = this.patch, a = assets(ac);
    const nodes = {}, sources = [], all = [], offs = [], set = {}, exits = [];
    const keep = n => { all.push(n); return n; };
    const src = n => { sources.push(n); return keep(n); };
    let tail = 0.02, gated = false, minEnd = 0, choke = 0;
    // Glide: a per-voice pitch offset in cents beside the pitch bend, which mono and legato slide
    // (see glideTo). Everything pitched listens to both.
    const gl = src(ac.createConstantSource());
    gl.offset.value = 0;
    const pitchIn = param => { this.bendCents.connect(param); gl.connect(param); };
    const relParams = []; // the envelope params a release moves (legato can take it back)
    const resonators = []; // [module id, the gain at its input]: closed at release when nothing before it ends the note
    const stops = []; // called with the voice's end time (granular voices stop making grains) // gated: something shapes the note's end (an Amp, an FM operator...)
    for (const m of patch.modules) {
      const p = m.params;
      if (MODULES[m.type].scope !== 'voice') continue;
      if (m.off) {
        // Bypassed: a shaper (filter, drive, amp, ring, space) passes the sound straight through;
        // a source or a modulator is simply left out, so whatever it fed gets nothing from it.
        if (!isSource(m.type) && MODULES[m.type].audioIn && MODULES[m.type].audioOut) {
          const g = keep(ac.createGain());
          nodes[m.id] = { in: g, out: g, targets: {} };
        }
        continue;
      }
      if (m.type === 'osc') {
        // Unison: `unison` copies, detuned evenly from -spread to +spread cents and panned across
        // the stereo field, each at √(2/n) (detuned copies add up by power; panning costs 3 dB).
        const n = Math.max(1, Math.round(p.unison || 1));
        const out = keep(ac.createGain());
        out.gain.value = p.level;
        const off = k => (n === 1 ? 0 : (k / (n - 1) * 2 - 1) * (m.params.spread ?? 20));
        const oscs = [], offset = p.wave === 'pulse' ? src(ac.createConstantSource()) : null;
        if (offset) offset.offset.value = 2 * p.pw - 1;
        for (let k = 0; k < n; k++) {
          const osc = src(ac.createOscillator());
          osc.frequency.value = hz(note, p.octave, p.semi);
          osc.detune.value = p.fine + off(k);
          pitchIn(osc.detune);
          let into = out;
          if (n > 1) {
            const g = keep(ac.createGain()), pan = keep(ac.createStereoPanner());
            g.gain.value = Math.sqrt(2 / n);
            pan.pan.value = (k / (n - 1) * 2 - 1) * 0.8 * (k % 2 ? -1 : 1);
            g.connect(pan).connect(out);
            into = g;
          }
          if (offset) {
            osc.type = 'sawtooth';
            const shaper = keep(ac.createWaveShaper());
            shaper.curve = a.comparator;
            shaper.oversample = '4x';
            osc.connect(shaper);
            offset.connect(shaper);
            shaper.connect(into);
          } else {
            osc.type = OSC_TYPES[p.wave];
            osc.connect(into);
          }
          oscs.push(osc);
        }
        const targets = { pitch: oscs.map(o => o.detune), level: [out.gain], pw: offset ? [offset.offset] : [] };
        if (offset) set[`${m.id}.pw`] = v => offset.offset.setTargetAtTime(2 * v - 1, ac.currentTime, 0.01);
        const retune = () => oscs.forEach(o => o.frequency.setTargetAtTime(hz(note, m.params.octave, m.params.semi), ac.currentTime, 0.005));
        const redetune = () => oscs.forEach((o, k) => o.detune.setTargetAtTime(m.params.fine + off(k), ac.currentTime, 0.01));
        Object.assign(set, { [`${m.id}.octave`]: retune, [`${m.id}.semi`]: retune, [`${m.id}.fine`]: redetune, [`${m.id}.spread`]: redetune,
          [`${m.id}.level`]: v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01) });
        nodes[m.id] = { out, targets };
      } else if (m.type === 'sampler') {
        // A recording at the note's pitch relative to the root, trimmed, looped or one-shot. A
        // multi-sample sampler plays the zone for the note, with the zone's own loop.
        const zone = m.zones?.length ? zoneFor(m.zones, note) : null;
        const file = zone ? zone.file : p.file, root = zone ? zone.root : p.root;
        const loopStart = zone && zone.loopEnd > zone.loopStart ? zone.loopStart : p.loopStart;
        const loopEnd = zone && zone.loopEnd > zone.loopStart ? zone.loopEnd : p.loopEnd;
        const buf = this.samples.get(file), out = keep(ac.createGain());
        out.gain.value = p.level;
        if (buf) {
          const s = src(ac.createBufferSource()), dur = buf.duration;
          s.buffer = buf;
          s.playbackRate.value = 2 ** ((note - root + p.tune) / 12);
          s.detune.value = p.fine;
          pitchIn(s.detune);
          const from = Math.min(p.start, 0.999) * dur;
          if (p.mode === 'loop') {
            s.loop = true;
            s.loopStart = Math.min(loopStart, loopEnd - 0.001) * dur;
            s.loopEnd = Math.max(loopEnd, loopStart + 0.001) * dur;
            s._start = [from];
          } else {
            const len = Math.max(0.005, (Math.max(p.end, p.start + 0.001) - p.start) * dur);
            s._start = [from, len];
            if (p.mode === 'one-shot') { gated = true; minEnd = Math.max(minEnd, t0 + len / s.playbackRate.value); }
          }
          s.connect(out);
          set[`${m.id}.fine`] = v => s.detune.setTargetAtTime(v, ac.currentTime, 0.01);
          nodes[m.id] = { out, targets: { pitch: [s.detune], level: [out.gain] } };
        } else nodes[m.id] = { out, targets: { pitch: [], level: [out.gain] } };
        set[`${m.id}.level`] = v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01);
      } else if (m.type === 'granular') {
        // Grains: short windows of the recording, each with its own place, pitch and pan, made a
        // little ahead of time by a timer (all at once, for a few seconds, when rendering offline).
        // They read the module's settings as they are now, so moving a slider changes the cloud.
        const out = keep(ac.createGain()), buf = this.samples.get(p.file);
        out.gain.value = p.level;
        src(ac.createConstantSource()); // the voice's lifetime: grains come and go by themselves
        if (buf) {
          const now = () => this.patch.modules.find(x => x.id === m.id)?.params || p;
          const offline = typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext;
          let next = t0, until = Infinity;
          const grain = t => {
            const c = now(), dur = buf.duration, size = c.size;
            const rate = 2 ** ((note - c.root + c.tune) / 12 + (Math.random() * 2 - 1) * c.jitter / 1200);
            let pos = c.position + c.scan * (t - t0) / dur + (Math.random() - 0.5) * c.spread;
            pos = ((pos % 1) + 1) % 1;
            const offset = Math.min(pos * dur, Math.max(0, dur - size * rate));
            const s = ac.createBufferSource(), g = ac.createGain(), pn = ac.createStereoPanner();
            s.buffer = buf;
            s.playbackRate.value = rate;
            const amp = Math.min(1, 1 / Math.sqrt(Math.max(1, c.density * size)));
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(amp, t + size / 2);
            g.gain.linearRampToValueAtTime(0, t + size);
            pn.pan.value = (Math.random() * 2 - 1) * c.width;
            s.connect(g).connect(pn).connect(out);
            s.onended = () => { s.disconnect(); g.disconnect(); pn.disconnect(); };
            s.start(t, offset, size * rate);
          };
          const pump = () => {
            const horizon = offline ? t0 + 4 : ac.currentTime + 0.12;
            while (next < horizon && next < until) { grain(next); next += (1 / now().density) * (0.7 + Math.random() * 0.6); }
          };
          pump();
          if (!offline) {
            const timer = setInterval(pump, 30);
            stops.push(t => { until = t; setTimeout(() => clearInterval(timer), Math.max(0, (t - ac.currentTime) * 1000) + 60); });
          } else stops.push(t => { until = t; });
        }
        nodes[m.id] = { out, targets: { level: [out.gain] } };
        set[`${m.id}.level`] = v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01);
      } else if (m.type === 'noise') {
        const n = src(ac.createBufferSource()), out = keep(ac.createGain());
        n.buffer = a.noise;
        n.loop = true;
        n.loopStart = Math.random();
        out.gain.value = p.level;
        n.connect(out);
        set[`${m.id}.level`] = v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01);
        nodes[m.id] = { out, targets: { level: [out.gain] } };
      } else if (m.type === 'organ') {
        // Drawbar organ: every drawbar in one oscillator (a waveform made of the bars' harmonics of
        // the 16' tone), plus percussion (a struck 4' or 2 2/3' sine, fading) and key click. It
        // speaks and stops at once, like the organ (its own short envelope, no Amp needed).
        gated = true;
        const out = keep(ac.createGain()), osc = src(ac.createOscillator());
        osc.frequency.value = hz(note, -1);
        osc.setPeriodicWave(organWave(ac, p));
        pitchIn(osc.detune);
        osc.connect(out);
        out.gain.setValueAtTime(0, t0);
        out.gain.linearRampToValueAtTime(p.level, t0 + 0.004);
        offs.push(t => { out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(p.level, t); out.gain.linearRampToValueAtTime(0, t + 0.012); });
        relParams.push(out.gain);
        tail = Math.max(tail, 0.03);
        if (p.perc !== 'off') {
          // One percussion envelope for the whole manual, as on the organ: it starts when a key goes
          // down with no other key held, and every note sounds it at its level then (so chords
          // struck together all get it, a legato line only at its start). Fast fades 60 dB in about
          // 1 s, slow in about 4 (Hammond-Leslie FAQ; an A-105 measured ~1 and ~5 s). It's 3 dB
          // stronger against the drawbars than it would be alone, the balance of the organ, which
          // drops the drawbars 3 dB while percussion is on.
          const tau = p.percDecay === 'fast' ? 1 / 6.9 : 4 / 6.9;
          const held = this.voices.some(v => v.t0 <= t0 + 1e-6 && !(v.released && v.relAt <= t0 + 1e-6));
          if (p.percTrig === 'every note' || !held || this.percAt == null) this.percAt = t0;
          const po = src(ac.createOscillator()), pe = keep(ac.createGain());
          po.frequency.value = hz(note) * (p.perc === 'second' ? 2 : 3);
          pitchIn(po.detune);
          pe.gain.setValueAtTime(0.45 * Math.SQRT2 * Math.exp(-(t0 - this.percAt) / tau), t0);
          pe.gain.setTargetAtTime(0, t0, tau);
          po.connect(pe).connect(out);
        }
        if (p.click > 0) {
          const n = src(ac.createBufferSource()), bp = keep(ac.createBiquadFilter()), ce = keep(ac.createGain());
          n.buffer = a.noise; n.loop = true; n.loopStart = Math.random();
          bp.type = 'bandpass'; bp.frequency.value = 2500; bp.Q.value = 0.8;
          ce.gain.setValueAtTime(0, t0);
          ce.gain.linearRampToValueAtTime(p.click * 0.25, t0 + 0.001);
          ce.gain.setTargetAtTime(0, t0 + 0.001, 0.003);
          n.connect(bp).connect(ce).connect(out);
        }
        const rewave = () => osc.setPeriodicWave(organWave(ac, m.params));
        for (let k = 1; k <= 9; k++) set[`${m.id}.bar${k}`] = rewave;
        set[`${m.id}.perc`] = rewave; // the 1' bar goes quiet or comes back
        set[`${m.id}.level`] = v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01);
        nodes[m.id] = { out, targets: { pitch: [osc.detune], level: [out.gain] } };
      } else if (m.type === 'string') {
        // A physical string (fxworklet.js): plucked or struck at the note's start, damped at release.
        // Silent until the worklet has loaded (loadSamples starts that when the patch has one).
        gated = true;
        const out = keep(ac.createGain());
        out.gain.value = p.level;
        if (fxReady(ac)) {
          const node = keep(new AudioWorkletNode(ac, 'ost-string', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
            processorOptions: { ...p, freq: hz(note, p.octave), start: t0, vel: vel / 127, unacorda: !!this.pedals?.soft } }));
          pitchIn(node.parameters.get('detune'));
          node.connect(out);
          const damp = node.parameters.get('damp');
          offs.push(t => damp.setValueAtTime(1, t));
          relParams.push(damp); // legato can take the damper back
          tail = Math.max(tail, p.release * 1.6);
          nodes[m.id] = { out, targets: { pitch: [node.parameters.get('detune')], level: [out.gain] } };
        } else nodes[m.id] = { out, targets: { pitch: [], level: [out.gain] } };
        set[`${m.id}.level`] = v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01);
      } else if (m.type === 'piano') {
        // A piano note from modes fitted to recordings (fxworklet.js 'ost-piano'), plus the recorded
        // strike. Silent until the worklet and the piano's data have loaded (loadSamples starts both).
        gated = true;
        const out = keep(ac.createGain()), piano = pianoReady(ac);
        out.gain.value = p.level * PIANO_GAIN;
        if (fxReady(ac) && piano) {
          const key = Math.max(21, Math.min(108, note + 12 * p.octave));
          const v = pianoNote(piano, key, vel, { velocity: p.velocity, tone: this.pedals?.soft ? 0.25 : 0, hardness: p.hardness, detune: p.detune });
          const node = keep(new AudioWorkletNode(ac, 'ost-piano', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
            processorOptions: { modes: v.modes, start: t0, ramp: v.ramp, damper: v.damper * p.release } }));
          node.connect(out);
          for (const [buffer, g] of v.strikes) {
            if (!(g * p.strike > 0)) continue;
            const s = src(ac.createBufferSource()), sg = keep(ac.createGain());
            s.buffer = buffer; s.playbackRate.value = v.ratio; sg.gain.value = g * p.strike;
            s.connect(sg).connect(out);
          }
          const damp = node.parameters.get('damp');
          offs.push(t => damp.setValueAtTime(1, t));
          relParams.push(damp); // legato can take the damper back
          tail = Math.max(tail, v.damper ? v.damper * p.release * 1.2 : 6);
        }
        set[`${m.id}.level`] = v => out.gain.setTargetAtTime(v * PIANO_GAIN, ac.currentTime, 0.01);
        nodes[m.id] = { out, targets: { pitch: [], level: [out.gain] } };
      } else if (m.type === 'filter') {
        const f1 = keep(ac.createBiquadFilter()), f2 = p.slope === '24' ? keep(ac.createBiquadFilter()) : null;
        const fs = f2 ? [f1, f2] : [f1];
        const cutoff = () => Math.min(ac.sampleRate * 0.45, Math.max(20, m.params.cutoff * 2 ** ((note - 60) / 12 * m.params.keytrack)));
        for (const f of fs) { f.type = p.type; f.frequency.value = cutoff(); f.Q.value = 0.707; }
        f1.Q.value = p.resonance;
        if (f2) f1.connect(f2);
        // A glide moves the cutoff too, by the key tracking.
        const kt = keep(ac.createGain());
        kt.gain.value = p.keytrack;
        gl.connect(kt);
        fs.forEach(f => kt.connect(f.detune));
        Object.assign(set, {
          [`${m.id}.cutoff`]: () => fs.forEach(f => f.frequency.setTargetAtTime(cutoff(), ac.currentTime, 0.01)),
          [`${m.id}.keytrack`]: v => { fs.forEach(f => f.frequency.setTargetAtTime(cutoff(), ac.currentTime, 0.01)); kt.gain.setTargetAtTime(v, ac.currentTime, 0.01); },
          [`${m.id}.resonance`]: v => f1.Q.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.type`]: v => fs.forEach(f => { f.type = v; }),
        });
        nodes[m.id] = { in: f1, out: f2 || f1, targets: { cutoff: fs.map(f => f.detune), resonance: [f1.Q] } };
      } else if (m.type === 'drive') {
        const sh = keep(ac.createWaveShaper());
        sh.curve = driveCurve(ac, p.amount);
        sh.oversample = '2x';
        set[`${m.id}.amount`] = v => { sh.curve = driveCurve(ac, v); };
        nodes[m.id] = { in: sh, out: sh, targets: {} };
      } else if (m.type === 'amp') {
        gated = true;
        const env = keep(ac.createGain()), level = keep(ac.createGain());
        level.gain.value = p.level;
        env.connect(level);
        const k = envTimes(p, note, vel);
        envOn(env.gain, t0, p, 1 - p.velocity + p.velocity * (vel / 127) ** 1.5, k);
        offs.push(t => envOff(env.gain, t, m.params.release * k.release));
        relParams.push(env.gain);
        tail = Math.max(tail, p.release * k.release * 1.6);
        set[`${m.id}.level`] = v => level.gain.setTargetAtTime(v, ac.currentTime, 0.01);
        nodes[m.id] = { in: env, out: level, targets: { level: [level.gain] } };
      } else if (m.type === 'env') {
        const c = src(ac.createConstantSource()), k = envTimes(p, note, vel);
        envOn(c.offset, t0, p, 1 - (p.velocity || 0) + (p.velocity || 0) * (vel / 127) ** 1.5, k);
        offs.push(t => envOff(c.offset, t, m.params.release * k.release));
        relParams.push(c.offset);
        nodes[m.id] = { out: c, targets: {} };
      } else if (m.type === 'lfo') {
        const depth = keep(ac.createGain()), fade = keep(ac.createGain());
        let osc, rate, perHz = 1;
        if (p.wave === 'random') {
          // Stepped random: the step buffer played so that `rate` steps go by each second.
          osc = src(ac.createBufferSource());
          osc.buffer = a.steps;
          osc.loop = true;
          perHz = STEP / ac.sampleRate;
          osc.playbackRate.value = this.rateOf(p) * perHz;
          rate = osc.playbackRate;
        } else {
          osc = src(ac.createOscillator());
          if (p.phase > 0) osc.setPeriodicWave(lfoWave(ac, a, p.wave, p.phase));
          else if (p.wave === 'rise') osc.setPeriodicWave(a.rise); else osc.type = LFO_TYPES[p.wave];
          osc.frequency.value = this.rateOf(p);
          rate = osc.frequency;
        }
        depth.gain.value = p.depth;
        fade.gain.setValueAtTime(p.delay > 0 ? 0 : 1, t0);
        if (p.delay > 0) fade.gain.linearRampToValueAtTime(1, t0 + p.delay);
        osc.connect(depth).connect(fade);
        const rerate = () => rate.setTargetAtTime(this.rateOf(m.params) * perHz, ac.currentTime, 0.02);
        Object.assign(set, { [`${m.id}.rate`]: rerate, [`${m.id}.sync`]: rerate, [`${m.id}._tempo`]: rerate,
          [`${m.id}.depth`]: v => depth.gain.setTargetAtTime(v, ac.currentTime, 0.02) });
        nodes[m.id] = { out: fade, targets: { rate: [rate], depth: [depth.gain] }, scales: { rate: perHz } };
      } else if (m.type === 'seq') {
        // A step sequence, from its first step at the note's start.
        const s = stepSeq(ac, a, () => m.params, () => this.rateOf(m.params));
        src(s.osc); keep(s.shaper); keep(s.depth);
        for (const [k, f] of Object.entries(s.set)) set[`${m.id}.${k}`] = f;
        nodes[m.id] = { out: s.depth, targets: { depth: [s.depth.gain] } };
      } else if (m.type === 'resonator') {
        // A bank of tuned resonators (fxworklet.js 'ost-resonator') rung by the sound sent in, at
        // the note's pitch or a fixed one. It rings on after the key is up (Release), so it counts
        // as shaping the note's end. Passes only the dry part until the worklet has loaded.
        gated = true;
        const input = keep(ac.createGain()), gate = keep(ac.createGain()), dry = keep(ac.createGain()), wet = keep(ac.createGain()), out = keep(ac.createGain());
        const f = () => hz(m.params.tune === 'fixed' ? m.params.note : note, m.params.octave, m.params.semi);
        input.connect(dry).connect(out);
        wet.connect(out);
        dry.gain.value = 1 - p.mix; wet.gain.value = p.mix; out.gain.value = p.level;
        const targets = { pitch: [], mix: [wet.gain], level: [out.gain] };
        if (fxReady(ac)) {
          const node = keep(new AudioWorkletNode(ac, 'ost-resonator', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
            processorOptions: { ratios: resonatorRatios(p.shape), start: t0, vel: vel / 127, strike: p.strike } }));
          const to = (key, v) => node.parameters.get(key).setValueAtTime(v, ac.currentTime);
          const keys = ['decay', 'damping', 'bright', 'position', 'spacing', 'release', 'width'];
          for (const k of keys) { to(k, p[k]); set[`${m.id}.${k}`] = v => to(k, v); }
          to('freq', f());
          for (const k of ['tune', 'note', 'octave', 'semi']) set[`${m.id}.${k}`] = () => to('freq', f());
          if (p.tune !== 'fixed') pitchIn(node.parameters.get('detune'));
          input.connect(gate).connect(node).connect(wet);
          const damp = node.parameters.get('damp');
          offs.push(t => damp.setValueAtTime(1, t));
          relParams.push(damp);
          tail = Math.max(tail, Math.min(p.decay, p.release) * 1.2);
          targets.pitch = [node.parameters.get('detune')];
          resonators.push([m.id, gate]);
        }
        Object.assign(set, { [`${m.id}.mix`]: v => { dry.gain.setTargetAtTime(1 - v, ac.currentTime, 0.02); wet.gain.setTargetAtTime(v, ac.currentTime, 0.02); },
          [`${m.id}.level`]: v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01) });
        nodes[m.id] = { in: input, out, targets };
      } else if (m.type === 'fmop') {
        // A sine at ratio × the note's pitch with its own envelope. Audio arriving at its input
        // moves its frequency: deviation = input × fm depth × its frequency (so depth ≈ FM index).
        gated = true;
        const f = () => hz(note) * m.params.ratio;
        const osc = src(ac.createOscillator()), fmIn = keep(ac.createGain()), env = keep(ac.createGain()), level = keep(ac.createGain());
        osc.type = 'sine';
        osc.frequency.value = f();
        osc.detune.value = p.fine;
        pitchIn(osc.detune);
        fmIn.gain.value = p.fm * f();
        fmIn.connect(osc.frequency);
        level.gain.value = p.level;
        osc.connect(env).connect(level);
        const k = envTimes(p, note, vel);
        envOn(env.gain, t0, p, 1 - p.velocity + p.velocity * (vel / 127) ** 1.5, k);
        offs.push(t => envOff(env.gain, t, m.params.release * k.release));
        relParams.push(env.gain);
        tail = Math.max(tail, p.release * k.release * 1.6);
        const retune = () => { osc.frequency.setTargetAtTime(f(), ac.currentTime, 0.005); fmIn.gain.setTargetAtTime(m.params.fm * f(), ac.currentTime, 0.01); };
        Object.assign(set, { [`${m.id}.ratio`]: retune, [`${m.id}.fm`]: retune,
          [`${m.id}.fine`]: v => osc.detune.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.level`]: v => level.gain.setTargetAtTime(v, ac.currentTime, 0.01) });
        nodes[m.id] = { in: fmIn, out: level, targets: { pitch: [osc.detune], level: [level.gain], fm: [fmIn.gain] }, scales: { fm: f() } };
      } else if (m.type === 'vowel') {
        // Three band-passes at the formants. One control, the vowel position (0-4, plus any
        // modulation), drives all three frequencies through wave shapers whose curves map the
        // position to each formant's Hz (vowelCurve), so modulation sweeps between vowels smoothly.
        const input = keep(ac.createGain()), out = keep(ac.createGain()), dry = keep(ac.createGain()), wet = keep(ac.createGain());
        const pos = src(ac.createConstantSource()), bias = src(ac.createConstantSource()), scale = keep(ac.createGain());
        pos.offset.value = p.vowel;
        bias.offset.value = -1;
        scale.gain.value = 0.5; // 0…4 → -1…1, the shapers' input range
        pos.connect(scale);
        const shapers = [], filters = [], gains = [];
        for (let k = 0; k < 3; k++) {
          const sh = keep(ac.createWaveShaper()), f = keep(ac.createBiquadFilter()), g = keep(ac.createGain());
          sh.curve = vowelCurve(k, p.shift);
          scale.connect(sh); bias.connect(sh);
          f.type = 'bandpass';
          f.frequency.value = 0; // the shaper's output is the frequency
          f.Q.value = p.resonance;
          sh.connect(f.frequency);
          g.gain.value = FORMANT_GAINS[k] * vowelMakeup(p.resonance);
          input.connect(f).connect(g).connect(wet);
          shapers.push(sh); filters.push(f); gains.push(g);
        }
        input.connect(dry);
        dry.connect(out); wet.connect(out);
        dry.gain.value = 1 - p.mix; wet.gain.value = p.mix;
        Object.assign(set, {
          [`${m.id}.vowel`]: v => pos.offset.setTargetAtTime(v, ac.currentTime, 0.02),
          [`${m.id}.resonance`]: v => filters.forEach((f, k) => { f.Q.setTargetAtTime(v, ac.currentTime, 0.02); gains[k].gain.setTargetAtTime(FORMANT_GAINS[k] * vowelMakeup(v), ac.currentTime, 0.02); }),
          [`${m.id}.shift`]: v => shapers.forEach((sh, k) => { sh.curve = vowelCurve(k, v); }),
          [`${m.id}.mix`]: v => { dry.gain.setTargetAtTime(1 - v, ac.currentTime, 0.02); wet.gain.setTargetAtTime(v, ac.currentTime, 0.02); },
        });
        nodes[m.id] = { in: input, out, targets: { vowel: [pos.offset], mix: [wet.gain] } };
      } else if (m.type === 'ring') {
        // The input multiplied by a sine at ratio × the note's pitch, mixed with the dry input.
        const input = keep(ac.createGain()), vca = keep(ac.createGain()), dry = keep(ac.createGain()), wet = keep(ac.createGain()), out = keep(ac.createGain());
        const car = src(ac.createOscillator());
        car.frequency.value = hz(note) * p.ratio;
        car.detune.value = p.fine;
        vca.gain.value = 0;
        car.connect(vca.gain);
        input.connect(vca).connect(wet).connect(out);
        input.connect(dry).connect(out);
        wet.gain.value = p.mix;
        dry.gain.value = 1 - p.mix;
        Object.assign(set, { [`${m.id}.ratio`]: v => car.frequency.setTargetAtTime(hz(note) * v, ac.currentTime, 0.01),
          [`${m.id}.fine`]: v => car.detune.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.mix`]: v => { wet.gain.setTargetAtTime(v, ac.currentTime, 0.01); dry.gain.setTargetAtTime(1 - v, ac.currentTime, 0.01); } });
        nodes[m.id] = { in: input, out, targets: { mix: [wet.gain] } };
      } else if (m.type === 'drums') {
        // One-shot drums on the General MIDI notes; a note-off doesn't cut them.
        gated = true;
        const out = keep(ac.createGain());
        out.gain.value = p.level;
        const len = drumHit(ac, a, note, vel, t0, p, m.pads, out, src, keep, this.samples);
        choke = (m.pads?.[note] || m.pads?.[ALIASES[note]])?.choke || 0;
        minEnd = Math.max(minEnd, t0 + len);
        nodes[m.id] = { out, targets: {} };
      } else if (m.type === 'space') {
        // Binaural (HRTF) placement on headphones. Spread scatters notes at random around the
        // listener; orbit circles them around the head.
        const pan = keep(ac.createPanner());
        pan.panningModel = 'HRTF';
        pan.distanceModel = 'inverse';
        pan.refDistance = 1;
        const az = rad(p.azimuth + (Math.random() * 2 - 1) * p.spread), el = rad(p.elevation), d = p.distance;
        pan.positionX.value = Math.sin(az) * Math.cos(el) * d;
        pan.positionY.value = Math.sin(el) * d;
        pan.positionZ.value = -Math.cos(az) * Math.cos(el) * d;
        if (p.orbit > 0) {
          const r = Math.cos(el) * d, orbiters = [];
          set[`${m.id}.orbit`] = v => orbiters.forEach(o => o.frequency.setTargetAtTime(Math.max(0.001, v), ac.currentTime, 0.05));
          for (const [param, wave, sign] of [[pan.positionX, 'sine', 1], [pan.positionZ, 'cosine', -1]]) {
            const o = src(ac.createOscillator()), g = keep(ac.createGain());
            if (wave === 'sine') o.type = 'sine'; else o.setPeriodicWave(a.cosine);
            o.frequency.value = p.orbit;
            g.gain.value = r * sign;
            param.value = 0;
            o.connect(g).connect(param);
            orbiters.push(o);
          }
        }
        nodes[m.id] = { in: pan, out: pan, targets: { x: [pan.positionX] } };
      }
    }
    // Velocity as a modulation source (0-1), only if used.
    if (patch.mod.some(c => c.from === 'vel')) {
      const c = src(ac.createConstantSource());
      c.offset.value = vel / 127;
      nodes.vel = { out: c };
    }
    nodes.wheel = { out: this.wheel };

    if (this.scopes) {
      for (const m of patch.modules) if (MODULES[m.type].audioOut && nodes[m.id]) nodes[m.id].out.connect(this.scope(m.id));
    }
    for (const c of patch.audio) {
      const from = nodes[c.from];
      if (!from) continue; // a global module: wired in buildGlobals
      if (c.to !== 'out' && nodes[c.to]) { from.out.connect(nodes[c.to].in); continue; }
      const dest = c.to === 'out' ? this.bus : this.globals.get(c.to)?.input;
      if (!dest) continue;
      const exit = keep(ac.createGain()); // lets a note be cut short without a click
      from.out.connect(exit).connect(dest);
      exits.push(exit);
    }
    for (const c of patch.mod) {
      const [tid, key] = c.to.split('.'), from = nodes[c.from], params = nodes[tid]?.targets[key];
      if (!from || !params?.length) continue;
      const g = keep(ac.createGain()), k = modScale(key) * (nodes[tid].scales?.[key] ?? 1);
      g.gain.value = c.amount * k;
      from.out.connect(g);
      params.forEach(pm => g.connect(pm));
      set[`mod:${c.from}>${c.to}`] = v => g.gain.setTargetAtTime(v * k, ac.currentTime, 0.01);
    }
    // A Resonator fed by something that never ends by itself (a bare oscillator or noise) stops
    // listening at release, so only its ringing is left; fed by an Amp, a drum, a string… it keeps
    // listening, since those end the note themselves (a drum hit outlasts its key).
    const ENDS = ['amp', 'fmop', 'string', 'piano', 'drums', 'organ', 'resonator'];
    for (const [id, gate] of resonators) {
      const shaped = (to, seen = new Set()) => patch.audio.some(c => c.to === to && !seen.has(c.from) && (seen.add(c.from),
        ENDS.includes(patch.modules.find(x => x.id === c.from)?.type) || shaped(c.from, seen)));
      if (shaped(id)) continue;
      offs.push(t => gate.gain.setTargetAtTime(0, t, 0.01));
      relParams.push(gate.gain);
    }
    // Without an Amp module, a note simply stops when released (with a tiny fade).
    if (!gated) { offs.push(t => exits.forEach(e => { e.gain.cancelScheduledValues(t); e.gain.setTargetAtTime(0, t, 0.008); })); relParams.push(...exits.map(e => e.gain)); }
    for (const s of sources) s.start(t0, ...(s._start || [])); // samples start at their trim point
    const v = { note, base: note, released: false, offs, exits, set, tail, end: Infinity, choke, glide: gl.offset, relParams };
    v.stopAt = t => {
      t = Math.max(t, minEnd); // one-shots (drums) play to their end
      v.end = t;
      for (const f of stops) f(t);
      for (const s of sources) { try { s.stop(t); } catch { /* already stopped */ } }
      if (sources[0]) sources[0].onended = () => {
        all.forEach(n => n.disconnect());
        for (const o of sources) if (o.detune) { try { this.bendCents.disconnect(o.detune); } catch { /* not connected */ } }
      };
    };
    return v;
  }
}

// A saved effect rack on its own, between `input` and `output`, on any AudioContext: the
// sequencer's track inserts and master. `set(fx)` takes { rack: { modules }, mix, off } (or null
// for straight through); it rebuilds only when the effects change, else updates their settings.
export class FxChain {
  constructor(ac) {
    this.ac = ac;
    this.input = ac.createGain();
    this.output = ac.createGain();
    this.input.connect(this.output);
    this.patch = null; // { modules: [the rack as a rack module] }, which buildRack reads
    this.tempo = 120;
    this.g = null;
    this.shape = '';
  }
  set(fx) {
    const m = fx ? { id: 'fx', type: 'rack', params: { mix: fx.mix ?? 1, level: 1 }, rack: fx.rack, ...(fx.off ? { off: true } : {}) } : null;
    const shape = m ? JSON.stringify([m.off, m.rack.modules.map(e => [e.type, !!e.off, ...MODULES[e.type].params.filter(x => x.rebuild).map(x => e.params[x.key])])]) : '';
    const old = this.patch?.modules[0];
    this.patch = m ? { modules: [JSON.parse(JSON.stringify(m))] } : null;
    if (this.g && shape === this.shape) {
      const now = this.patch.modules[0];
      if (old.params.mix !== now.params.mix) this.g.set.mix?.(now.params.mix);
      now.rack.modules.forEach((e, i) => { for (const [k, v] of Object.entries(e.params)) if (old.rack.modules[i]?.params[k] !== v) this.g.set[`${i}.${k}`]?.(v); });
      return;
    }
    this.shape = shape;
    this.input.disconnect();
    if (this.g) this.g.nodes.forEach(n => { try { n.stop?.(); } catch { /* not started */ } n.disconnect(); });
    this.g = null;
    if (!m) { this.input.connect(this.output); return; }
    this.g = this.buildRack(this.patch.modules[0]);
    this.input.connect(this.g.input);
    this.g.output.connect(this.output);
  }
}
FxChain.prototype.buildRack = LabSynth.prototype.buildRack;
FxChain.prototype.buildEffect = LabSynth.prototype.buildEffect;
FxChain.prototype.rateOf = LabSynth.prototype.rateOf;
FxChain.prototype.timeOf = LabSynth.prototype.timeOf;
FxChain.prototype.setTempo = LabSynth.prototype.setTempo;
