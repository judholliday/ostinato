// Drum kits for Ostinato Synth's Drum kit module: 16 pads on the General MIDI drum notes, each its
// own little drum synth. A pad is plain data (the engine plays it, the Sound Lab edits it):
//   two tone layers  (t1…, t2…): a wave at a pitch, swept down from `sweep` semitones above it
//                    over `bend` seconds, fading over `decay`. 'metal' = six detuned squares (808
//                    cymbals and hats).
//   a noise layer    (n…): filtered noise, in 1–4 quick bursts (claps).
//   a sample      (s…): one of your recordings, tuned, trimmed and faded, on top of the rest.
//   a sound       (l…): any Ostinato Synth sound (a copy of its patch), played at a note for a
//                    moment and rendered to audio by the engine, so it plays like a sample.
//   a click, drive, pan, level, and a choke group (pads in the same group cut each other off,
//   like open and closed hats).
// A layer at level 0 is off. No DOM or audio here.

const num = (key, label, min, max, def, extra = {}) => ({ key, label, kind: 'num', min, max, def, ...extra });
const choice = (key, label, choices, def) => ({ key, label, kind: 'choice', choices, def });
const time = (key, label, min, max, def) => num(key, label, min, max, def, { unit: 's', curve: 'log' });
const file = (key, label, extra = {}) => ({ key, label, kind: 'file', def: '', ...extra });
const sound = (key, label, extra = {}) => ({ key, label, kind: 'sound', def: null, ...extra });
const tone = n => [
  num(`t${n}Level`, 'Level', 0, 1.5, 0),
  choice(`t${n}Wave`, 'Wave', ['sine', 'triangle', 'square', 'saw', 'metal'], 'sine'),
  num(`t${n}Pitch`, 'Pitch', 20, 5000, 100, { unit: 'Hz', curve: 'log' }),
  num(`t${n}Sweep`, 'Sweep', 0, 48, 0, { unit: 'st', step: 0.5, help: 'Starts this many semitones higher and falls to the pitch' }),
  time(`t${n}Bend`, 'Sweep time', 0.003, 1, 0.06),
  time(`t${n}Decay`, 'Decay', 0.01, 4, 0.3),
];

// Every setting of a pad, grouped as the editor shows them.
export const PAD_GROUPS = [
  { title: 'Body', help: 'The tone: a kick\'s boom, a tom\'s note, a snare\'s ring', params: tone(1) },
  { title: 'Body 2', help: 'A second tone, e.g. a kick\'s punch or a cowbell\'s other note', params: tone(2) },
  { title: 'Noise', help: 'Snares, hats, claps and cymbals', params: [
    num('nLevel', 'Level', 0, 1.5, 0),
    choice('nFilter', 'Filter', ['lowpass', 'bandpass', 'highpass'], 'highpass'),
    num('nFreq', 'Frequency', 100, 16000, 5000, { unit: 'Hz', curve: 'log' }),
    num('nQ', 'Resonance', 0.3, 15, 1, { curve: 'log' }),
    time('nDecay', 'Decay', 0.01, 4, 0.2),
    num('nBursts', 'Bursts', 1, 4, 1, { step: 1, help: 'Quick repeats at the start, like the hands of a clap' }),
  ] },
  { title: 'Sample', help: 'One of your recordings (a real drum, a hit you made), played with the layers above', params: [
    file('sFile', 'Sample', { help: 'A recording (Capture → Audio) or a file you imported' }),
    num('sLevel', 'Level', 0, 1.5, 1),
    num('sTune', 'Tune', -24, 24, 0, { unit: 'st', step: 0.5 }),
    num('sStart', 'Start', 0, 1, 0, { help: 'Trim the beginning' }),
    time('sDecay', 'Decay', 0.01, 8, 8),
  ] },
  { title: 'Sound', help: 'Any Ostinato Synth sound (yours or the factory\'s), played as a hit: an FM bell, a granular cloud, a bass blip', params: [
    sound('lSound', 'Sound', { help: 'A copy of the sound is kept in the pad, so changing the original later doesn\'t change the pad' }),
    num('lLevel', 'Level', 0, 1.5, 1),
    num('lNote', 'Note', 24, 96, 60, { step: 1, help: 'The note it plays (C4 = 60)' }),
    time('lHold', 'Hold', 0.01, 4, 0.2),
    time('lDecay', 'Decay', 0.01, 8, 1),
  ] },
  { title: 'Out', help: '', params: [
    num('click', 'Click', 0, 1, 0, { help: 'A short tick at the start, for attack' }),
    num('drive', 'Drive', 0, 1, 0),
    num('pan', 'Pan', -1, 1, 0),
    num('level', 'Level', 0, 1.5, 1),
    num('choke', 'Choke group', 0, 4, 0, { step: 1, help: 'Pads in the same group (1–4) cut each other off, like open and closed hats; 0 = none' }),
  ] },
];
export const PAD_PARAMS = PAD_GROUPS.flatMap(g => g.params);
export const padParam = key => PAD_PARAMS.find(p => p.key === key);

// The pads and their notes, in the order of a 4 × 4 pad grid (bottom row first, like an MPC).
export const KIT_NOTES = [36, 37, 38, 39, 42, 44, 46, 49, 41, 43, 45, 47, 48, 50, 51, 56];
// Notes without a pad of their own that play a similar one.
export const ALIASES = { 35: 36, 40: 38, 52: 49, 53: 51, 55: 49, 57: 49, 59: 51 };

const st = ratio => Math.round(12 * Math.log2(ratio) * 2) / 2;
const defaults = Object.fromEntries(PAD_PARAMS.map(p => [p.key, p.def]));
const pad = (name, o) => ({ ...defaults, name, ...o });
const tom = (name, f) => pad(name, { t1Level: 1, t1Pitch: Math.round(f), t1Sweep: st(1.6), t1Bend: 0.14, t1Decay: 0.35 });

// The original kit (analog drum machine recipes), now as pads.
export const DEFAULT_PADS = {
  36: pad('Kick', { t1Level: 1.4, t1Pitch: 48, t1Sweep: st(180 / 48), t1Bend: 0.18, t1Decay: 0.45,
    t2Level: 0.9, t2Wave: 'triangle', t2Pitch: 70, t2Sweep: st(240 / 70), t2Bend: 0.064, t2Decay: 0.16, click: 0.35 }),
  37: pad('Rim', { t1Level: 0.5, t1Wave: 'square', t1Pitch: 1700, t1Decay: 0.035, nLevel: 0.2, nFilter: 'bandpass', nFreq: 1700, nQ: 4, nDecay: 0.02 }),
  38: pad('Snare', { nLevel: 0.7, nFilter: 'highpass', nFreq: 1200, nDecay: 0.2, t1Level: 0.6, t1Wave: 'triangle', t1Pitch: 185, t1Decay: 0.11 }),
  39: pad('Clap', { nLevel: 1.5, nFilter: 'bandpass', nFreq: 1400, nQ: 1.5, nDecay: 0.18, nBursts: 4 }),
  42: pad('Closed hat', { nLevel: 0.45, nFilter: 'highpass', nFreq: 7500, nDecay: 0.06, choke: 1 }),
  44: pad('Pedal hat', { nLevel: 0.45, nFilter: 'highpass', nFreq: 7500, nDecay: 0.04, choke: 1 }),
  46: pad('Open hat', { nLevel: 0.4, nFilter: 'highpass', nFreq: 7000, nDecay: 0.4, choke: 1 }),
  49: pad('Crash', { nLevel: 0.4, nFilter: 'highpass', nFreq: 4500, nDecay: 1.5 }),
  41: tom('Low tom', 70), 43: tom('Floor tom', 70 * 2 ** (2 / 9)), 45: tom('Mid tom', 70 * 2 ** (4 / 9)),
  47: tom('Mid tom 2', 70 * 2 ** (6 / 9)), 48: tom('High tom', 70 * 2 ** (7 / 9)), 50: tom('High tom 2', 70 * 2 ** (9 / 9)),
  51: pad('Ride', { nLevel: 0.3, nFilter: 'highpass', nFreq: 8000, nDecay: 0.8, t1Level: 0.07, t1Wave: 'square', t1Pitch: 3100, t1Decay: 0.6 }),
  56: pad('Cowbell', { t1Level: 0.3, t1Wave: 'square', t1Pitch: 540, t1Decay: 0.3, t2Level: 0.3, t2Wave: 'square', t2Pitch: 800, t2Decay: 0.3 }),
};

// cleanSound(patch) checks a pad sound's patch (patch.js passes normalizePatch, so this file
// needn't import it); without one, pad sounds are dropped.
function cleanValue(spec, v, cleanSound) {
  if (spec.kind === 'sound') {
    if (!cleanSound || !v || typeof v !== 'object' || !v.patch) return null;
    try { return { name: String(v.name || v.patch.name || 'Sound').trim().slice(0, 40) || 'Sound', patch: cleanSound(v.patch) }; } catch { return null; }
  }
  if (spec.kind === 'choice') return spec.choices.includes(String(v)) ? String(v) : spec.def;
  if (spec.kind === 'file') return typeof v === 'string' ? v.slice(0, 200) : '';
  const n = Number(v);
  if (!Number.isFinite(n)) return spec.def;
  const c = Math.min(spec.max, Math.max(spec.min, n));
  return spec.step ? Math.round(c / spec.step) * spec.step : c;
}
export function cleanPad(raw, note, cleanSound) {
  const base = DEFAULT_PADS[note] || pad(`Pad ${note}`, {});
  const out = { name: String(raw?.name ?? base.name).trim().slice(0, 24) || base.name };
  for (const p of PAD_PARAMS) out[p.key] = cleanValue(p, raw?.[p.key] ?? base[p.key], cleanSound);
  return out;
}
// A kit's pads, complete: every pad note, missing settings from the original kit.
export function cleanPads(raw, cleanSound) {
  return Object.fromEntries(KIT_NOTES.map(n => [n, cleanPad(raw?.[n], n, cleanSound)]));
}
// Where the engine keeps a pad's rendered sound: a new render whenever what it plays changes.
export const padSoundKey = p => `sound:${JSON.stringify([p.lSound.patch, p.lNote, p.lHold])}`;
// How long a pad sounds (seconds), at the kit's decay `dk`, ignoring any sample.
export const padLength = (p, dk = 1) => Math.max(p.t1Level ? p.t1Decay : 0, p.t2Level ? p.t2Decay : 0, p.nLevel ? p.nDecay : 0, 0.05) * dk;
export const copyPads = pads => JSON.parse(JSON.stringify(pads));

// A variation of a pad: numbers nudged at random by up to `amount` (0.15 = a little, 0.5 = wild),
// on the scale they're set on; wild ones sometimes change a wave or filter too. `rnd` is
// Math.random unless a test passes its own.
export function varyPad(p, amount, rnd = Math.random) {
  const out = { ...p };
  for (const spec of PAD_PARAMS) {
    if (spec.kind === 'file' || spec.kind === 'sound' || spec.key === 'lNote' || spec.key === 'choke' || spec.key === 'level' || spec.key === 'nBursts') continue;
    const v = p[spec.key];
    if (spec.kind === 'choice') { if (amount >= 0.4 && rnd() < amount * 0.25) out[spec.key] = spec.choices[Math.floor(rnd() * spec.choices.length)]; continue; }
    if (/Level$/.test(spec.key) && v === 0) continue; // a layer that's off stays off
    const r = (rnd() * 2 - 1) * amount;
    out[spec.key] = cleanValue(spec, spec.curve === 'log' ? v * 2 ** (r * 2) : v + r * (spec.max - spec.min) * 0.5);
  }
  return out;
}
