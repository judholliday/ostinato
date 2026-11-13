// Makes the factory samples (samples/) that the factory granular sounds use: each rendered by the
// Sound Lab's own engine, so they can be remade or changed. Open tools/make_samples.html (served by
// serve.py) and download them, or call makeSamples() from the page.
import { LabSynth, renderSound } from '../js/lab/engine.js';
import { cleanPatch } from '../js/lab/patch.js';
import { FACTORY } from '../js/lab/sounds.js';
import { encodeWav } from '../js/rec/audio.js';

const SR = 32000;
const m = (type, id, params = {}) => ({ id, type, params });

// "Ah": three detuned saws and a breath of noise through formant filters (730, 1090, 2440 Hz),
// with a slow vibrato. Held 5 s at C4.
const VOWEL = cleanPatch({
  name: 'Vowel', voices: 1, volume: 1,
  modules: [m('osc', 'o1', { wave: 'saw', fine: -7, level: 0.6 }), m('osc', 'o2', { wave: 'saw', level: 0.6 }), m('osc', 'o3', { wave: 'saw', fine: 7, level: 0.6 }),
    m('noise', 'n1', { level: 0.05 }),
    m('filter', 'f1', { type: 'bandpass', slope: '12', cutoff: 730, resonance: 8, keytrack: 0 }),
    m('filter', 'f2', { type: 'bandpass', slope: '12', cutoff: 1090, resonance: 9, keytrack: 0 }),
    m('filter', 'f3', { type: 'bandpass', slope: '12', cutoff: 2440, resonance: 10, keytrack: 0 }),
    m('lfo', 'vib', { wave: 'sine', rate: 5.2, delay: 0.6, depth: 1 }),
    m('amp', 'a1', { attack: 0.35, decay: 0.5, sustain: 1, release: 0.6, level: 1 })],
  audio: [...['o1', 'o2', 'o3', 'n1'].flatMap(o => ['f1', 'f2', 'f3'].map(f => ({ from: o, to: f }))), ...['f1', 'f2', 'f3'].map(f => ({ from: f, to: 'a1' })), { from: 'a1', to: 'out' }],
  mod: ['o1', 'o2', 'o3'].map(o => ({ from: 'vib', to: `${o}.pitch`, amount: 18 })),
});

// Wind: noise through a resonant band-pass swept slowly up and down, swelling in and out.
const WIND = cleanPatch({
  name: 'Wind', voices: 1, volume: 1,
  modules: [m('noise', 'n1', { level: 0.9 }), m('filter', 'f1', { type: 'bandpass', slope: '12', cutoff: 700, resonance: 7, keytrack: 0 }),
    m('lfo', 'sweep', { wave: 'sine', rate: 0.17, depth: 1 }), m('lfo', 'gust', { wave: 'random', rate: 0.8, depth: 1 }),
    m('amp', 'a1', { attack: 1.2, decay: 1, sustain: 1, release: 1.5, level: 1 })],
  audio: [{ from: 'n1', to: 'f1' }, { from: 'f1', to: 'a1' }, { from: 'a1', to: 'out' }],
  mod: [{ from: 'sweep', to: 'f1.cutoff', amount: 1300 }, { from: 'gust', to: 'f1.cutoff', amount: 400 }],
});

const bell = () => FACTORY.find(p => p.name === 'FM Bell');

// A phrase on the bell (C5 E5 G5 B5 C6 G5 E5 D5), for scanning through slowly.
async function phrase() {
  const notes = [72, 76, 79, 83, 84, 79, 76, 74], step = 0.32, secs = notes.length * step + 2.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * secs), SR), s = new LabSynth(ctx, ctx.destination);
  s.setPatch({ ...cleanPatch(bell()), voices: 8 });
  await s.ready();
  notes.forEach((n, k) => s.play(n, 96 - (k % 2) * 14, 0.02 + k * step, step * 0.9));
  return ctx.startRendering();
}

// A bowed string: two saws and a little bow noise through a low-pass, a slow attack, vibrato that
// comes in after half a second. Held 5 s at C3.
const BOWED = cleanPatch({
  name: 'Bowed', voices: 1, volume: 1,
  modules: [m('osc', 'o1', { wave: 'saw', fine: -4, level: 0.6 }), m('osc', 'o2', { wave: 'saw', fine: 5, level: 0.45 }), m('noise', 'n1', { level: 0.04 }),
    m('filter', 'f1', { type: 'lowpass', slope: '12', cutoff: 1700, resonance: 1.5, keytrack: 0.5 }),
    m('filter', 'body', { type: 'bandpass', slope: '12', cutoff: 420, resonance: 3, keytrack: 0 }),
    m('lfo', 'vib', { wave: 'sine', rate: 5.4, delay: 0.8, depth: 1 }),
    m('amp', 'a1', { attack: 0.3, decay: 0.6, sustain: 0.9, release: 0.5, level: 1 })],
  audio: [...['o1', 'o2', 'n1'].flatMap(o => [{ from: o, to: 'f1' }, { from: o, to: 'body' }]), { from: 'f1', to: 'a1' }, { from: 'body', to: 'a1' }, { from: 'a1', to: 'out' }],
  mod: [{ from: 'vib', to: 'o1.pitch', amount: 16 }, { from: 'vib', to: 'o2.pitch', amount: 16 }, { from: 'vib', to: 'f1.cutoff', amount: 150 }],
});

// A voice going through the vowels, ah eh ee oh oo, once in 5 s: saws through the Vowel filter,
// its vowel moved from A to U by one slow rising LFO. Held 5 s at C3.
const VOWELS5 = cleanPatch({
  name: 'Vowel phrase', voices: 1, volume: 1,
  modules: [m('osc', 'o1', { wave: 'saw', fine: -6, level: 0.6 }), m('osc', 'o2', { wave: 'saw', fine: 6, level: 0.6 }), m('noise', 'n1', { level: 0.04 }),
    m('vowel', 'v1', { vowel: 2, resonance: 12 }), m('lfo', 'say', { wave: 'rise', rate: 0.2, depth: 1 }),
    m('lfo', 'vib', { wave: 'sine', rate: 5, delay: 0.5, depth: 1 }),
    m('amp', 'a1', { attack: 0.08, decay: 0.5, sustain: 1, release: 0.3, level: 1 })],
  audio: [{ from: 'o1', to: 'v1' }, { from: 'o2', to: 'v1' }, { from: 'n1', to: 'v1' }, { from: 'v1', to: 'a1' }, { from: 'a1', to: 'out' }],
  mod: [{ from: 'say', to: 'v1.vowel', amount: 2 }, { from: 'vib', to: 'o1.pitch', amount: 14 }, { from: 'vib', to: 'o2.pitch', amount: 14 }],
});

const sound = name => cleanPatch(FACTORY.find(p => p.name === name));

// Notes played on a factory sound: [[note, velocity, start (s), length (s)]], rendered for `secs`.
async function played(name, notes, secs, voices = 8) {
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * secs), SR), s = new LabSynth(ctx, ctx.destination);
  s.setPatch({ ...sound(name), voices });
  s.out.gain.cancelScheduledValues(0);
  s.out.gain.value = s.patch.volume;
  await s.ready();
  for (const [n, v, at, len] of notes) s.play(n, v, at, len);
  return ctx.startRendering();
}

// A C major ninth chord on the Grand Piano (C3 G3 E4 B4 D5), left to ring.
const chord = () => played('Grand Piano', [[48, 84, 0.02, 5], [55, 76, 0.025, 5], [64, 88, 0.03, 5], [71, 72, 0.035, 5], [74, 80, 0.04, 5]], 6);

// Two bars of the 808 Kit at 100 bpm, exactly 4.8 s so it loops: kick, snare, hats, a clap and a
// cowbell. (The kit is dry, so nothing is cut off at the loop point but the last hat's tail.)
function loop() {
  const s16 = 60 / 100 / 4, notes = [];
  const lane = (note, pattern, vel = 100) => [...pattern.replace(/ /g, '')].forEach((c, i) => { if (c !== '.') notes.push([note, c === 'X' ? vel : Math.round(vel * 0.55), i * s16, s16 * 0.9]); });
  lane(36, 'X..x ..X. ..X. .x.. X..x ..X. .xX. ....', 112);
  lane(38, '.... X... .... X..x .... X... .... X.xx', 104);
  lane(42, 'X.x. X.x. X.x. X.xx X.x. X.x. X.x. X...', 80);
  lane(46, '.... .... .... .... .... .... .... ..X.', 84);
  lane(39, '.... .... .... X... .... .... .... X...', 70);
  lane(56, '..x. .... .x.. .... ..x. .... .x.. x...', 64);
  return played('808 Kit', notes, 32 * s16, 16);
}

// Record crackle, made directly: quiet hiss with a slow rumble, small ticks about 30 times a second
// and a louder pop now and then, each a few milliseconds of decaying noise. 6 s.
function crackle() {
  const n = SR * 6, out = new Float32Array(n);
  let lp = 0, rumble = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    lp += 0.25 * (w - lp);
    rumble += 0.002 * (w - rumble);
    out[i] = lp * 0.035 + rumble * 0.5;
  }
  const hit = (at, amp, ms) => {
    const len = Math.round(SR * ms / 1000), sign = Math.random() < 0.5 ? -1 : 1;
    for (let k = 0; k < len && at + k < n; k++) out[at + k] += sign * amp * Math.exp(-5 * k / len) * (k < 2 ? 1 : Math.random() * 2 - 1);
  };
  for (let t = 0; t < n; t += Math.round(-Math.log(1 - Math.random()) * SR / 30) + 1) hit(t, 0.05 + 0.25 * Math.random() ** 3, 0.5 + Math.random() * 1.5);
  for (let t = Math.round(SR * 0.4); t < n; t += Math.round(-Math.log(1 - Math.random()) * SR / 1.2) + 1) hit(t, 0.5 + 0.5 * Math.random(), 2 + Math.random() * 3);
  return { length: n, numberOfChannels: 1, getChannelData: () => out };
}

const mono = buf => {
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a, out = new Float32Array(buf.length);
  let peak = 0;
  for (let i = 0; i < out.length; i++) { out[i] = (a[i] + b[i]) / 2; peak = Math.max(peak, Math.abs(out[i])); }
  const k = peak ? 0.89 / peak : 1; // −1 dBFS
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
};

export async function makeSamples() {
  const made = [
    ['Vowel Ah (C4).wav', await renderSound(VOWEL, 60, 5, SR, 1.2)],
    ['Glass Bell (C5).wav', await renderSound(cleanPatch(bell()), 72, 0.2, SR, 4.5)],
    ['Wind.wav', await renderSound(WIND, 60, 6, SR, 2)],
    ['Music Box Phrase (C5).wav', await phrase()],
    ['Piano Chord (C4).wav', await chord()],
    ['Bowed Note (C3).wav', await renderSound(BOWED, 48, 5, SR, 1)],
    ['Vowel Phrase (C3).wav', await renderSound(VOWELS5, 48, 5, SR, 0.5)],
    ['Drum Loop (100 bpm).wav', await loop()],
    ['Vinyl Crackle.wav', crackle()],
  ];
  return made.map(([name, buf]) => ({ name, wav: encodeWav([mono(buf)], SR), seconds: buf.length / SR }));
}
