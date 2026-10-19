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
  ];
  return made.map(([name, buf]) => ({ name, wav: encodeWav([mono(buf)], SR), seconds: buf.length / SR }));
}
