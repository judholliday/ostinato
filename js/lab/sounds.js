// The Sound Lab's sound library for Ostinato Synth (the Lab's engine): the factory sounds that
// come with Ostinato, the types sounds are sorted by, and a guess at a type for sounds without
// one. Your own sounds are the saved instruments (data/instruments/). No DOM here.
import { STARTERS, cleanPatch, defaultParams } from './patch.js';
import { DEFAULT_PADS, copyPads } from './drums.js';

// The types the library groups by (a sound can have any other type too; these come first).
export const TYPES = ['Bass', 'Lead', 'Pad', 'Keys', 'Pluck', 'Bell', 'Strings', 'Brass', 'Organ', 'Drums', 'FX', 'Other'];

// A sound's type: its own, else a guess from its name, else from what it's made of.
export function typeOf(patch) {
  if (patch.type) return patch.type;
  const n = String(patch.name || '').toLowerCase();
  const words = [['Bass', /bass|sub\b|808/], ['Lead', /lead|solo|sync/], ['Pad', /pad|choir|atmos|ambient|drone/],
    ['Keys', /piano|keys|rhodes|wurli|ep\b|clav/], ['Pluck', /pluck|harp|guitar|pizz/], ['Bell', /bell|chime|glass|mallet|marimba/],
    ['Strings', /string|violin|cello|ensemble/], ['Brass', /brass|horn|trumpet|stab/], ['Organ', /organ/],
    ['Drums', /drum|kick|snare|hat|perc/], ['FX', /fx|noise|sweep|wind|riser|zap|siren/]];
  for (const [type, re] of words) if (re.test(n)) return type;
  const types = new Set((patch.modules || []).map(m => m.type));
  if (types.has('drums')) return 'Drums';
  if (types.has('fmop')) return 'Bell';
  return 'Other';
}

const mod = (type, id, params = {}) => ({ id, type, params: { ...defaultParams(type), ...params } });
const chain = (...ids) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));
// A kit: the original pads with some changed ({ note: { settings } }).
const kitPads = changes => { const pads = copyPads(DEFAULT_PADS); for (const [n, c] of Object.entries(changes)) Object.assign(pads[n], c); return pads; };
const tom909 = (name, f) => ({ name, t1Level: 1, t1Wave: 'sine', t1Pitch: f, t1Sweep: 7, t1Bend: 0.08, t1Decay: 0.4, nLevel: 0.12, nFilter: 'lowpass', nFreq: 3000, nDecay: 0.05 });

// The starting points (patch.js) plus more, one or more of each type.
const MORE = [
  {
    name: 'Sub Bass', type: 'Bass', voices: 4,
    modules: [mod('osc', 'osc1', { wave: 'sine', octave: -1, level: 0.9 }), mod('osc', 'osc2', { wave: 'triangle', level: 0.25 }),
      mod('amp', 'amp1', { attack: 0.004, decay: 0.3, sustain: 0.9, release: 0.12 })],
    audio: [{ from: 'osc1', to: 'amp1' }, { from: 'osc2', to: 'amp1' }, { from: 'amp1', to: 'out' }],
  },
  {
    name: 'Acid Bass', type: 'Bass', voices: 2,
    modules: [mod('osc', 'osc1', { wave: 'saw', octave: -1, level: 0.7 }), mod('filter', 'filter1', { cutoff: 260, resonance: 12, keytrack: 0.5 }),
      mod('env', 'env1', { attack: 0.002, decay: 0.22, sustain: 0, release: 0.1 }), mod('drive', 'drive1', { amount: 0.45 }),
      mod('amp', 'amp1', { attack: 0.002, decay: 0.3, sustain: 0.8, release: 0.06 })],
    audio: chain('osc1', 'filter1', 'drive1', 'amp1', 'out'),
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 3900 }, { from: 'vel', to: 'filter1.cutoff', amount: 1800 }],
  },
  {
    name: 'FM Bass', type: 'Bass', voices: 4,
    modules: [mod('fmop', 'op1', { ratio: 0.5, fm: 1.6, attack: 0.002, decay: 0.8, sustain: 0.6, release: 0.15, level: 0.8 }),
      mod('fmop', 'op2', { ratio: 0.5, attack: 0.001, decay: 0.25, sustain: 0.1, release: 0.1, velocity: 0.8, level: 0.7 })],
    audio: [{ from: 'op2', to: 'op1' }, { from: 'op1', to: 'out' }],
  },
  {
    name: 'Saw Lead', type: 'Lead', voices: 4,
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -6, level: 0.5 }), mod('osc', 'osc2', { wave: 'saw', fine: 6, level: 0.5 }),
      mod('filter', 'filter1', { cutoff: 2800, resonance: 3, keytrack: 0.7 }), mod('lfo', 'lfo1', { rate: 5.5, delay: 0.3, depth: 0 }),
      mod('amp', 'amp1', { attack: 0.01, decay: 0.3, sustain: 0.85, release: 0.2 }), mod('delay', 'delay1', { time: 0.3, feedback: 0.3, mix: 0.2 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'out')],
    mod: [{ from: 'lfo1', to: 'osc1.pitch', amount: 30 }, { from: 'lfo1', to: 'osc2.pitch', amount: 30 }, { from: 'wheel', to: 'lfo1.depth', amount: 1 }],
  },
  {
    name: 'Square Lead', type: 'Lead', voices: 4,
    modules: [mod('osc', 'osc1', { wave: 'pulse', pw: 0.3, level: 0.6 }), mod('osc', 'osc2', { wave: 'square', octave: -1, level: 0.25 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 3500, resonance: 1.5 }), mod('lfo', 'lfo1', { wave: 'triangle', rate: 0.5 }),
      mod('amp', 'amp1', { attack: 0.005, decay: 0.2, sustain: 0.9, release: 0.15 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'out')],
    mod: [{ from: 'lfo1', to: 'osc1.pw', amount: 0.15 }],
  },
  {
    name: 'Warm Keys', type: 'Keys', voices: 10,
    modules: [mod('osc', 'osc1', { wave: 'triangle', level: 0.6 }), mod('osc', 'osc2', { wave: 'saw', fine: 4, level: 0.2 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 900, resonance: 0.8, keytrack: 0.8 }), mod('env', 'env1', { attack: 0.002, decay: 0.9, sustain: 0.2, release: 0.4 }),
      mod('amp', 'amp1', { attack: 0.003, decay: 1.8, sustain: 0.35, release: 0.45, velocity: 0.8 }), mod('chorus', 'chorus1', { rate: 0.4, mix: 0.3 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'chorus1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 2400 }, { from: 'vel', to: 'filter1.cutoff', amount: 1500 }],
  },
  {
    name: 'Drawbar Organ', type: 'Organ', voices: 10, volume: 0.7,
    modules: [mod('osc', 'osc1', { wave: 'sine', level: 0.5 }), mod('osc', 'osc2', { wave: 'sine', octave: 1, level: 0.35 }),
      mod('osc', 'osc3', { wave: 'sine', octave: 1, semi: 7, level: 0.25 }), mod('osc', 'osc4', { wave: 'sine', octave: -1, level: 0.3 }),
      mod('amp', 'amp1', { attack: 0.004, decay: 0.1, sustain: 1, release: 0.05, velocity: 0 }), mod('chorus', 'chorus1', { rate: 6, depth: 0.25, mix: 0.4 })],
    audio: [{ from: 'osc1', to: 'amp1' }, { from: 'osc2', to: 'amp1' }, { from: 'osc3', to: 'amp1' }, { from: 'osc4', to: 'amp1' }, ...chain('amp1', 'chorus1', 'out')],
  },
  {
    name: 'Glass Bell', type: 'Bell', voices: 10, volume: 0.7,
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 1.8, attack: 0.001, decay: 3.5, sustain: 0, release: 2.5, level: 0.7 }),
      mod('fmop', 'op2', { ratio: 7, attack: 0.001, decay: 1.2, sustain: 0, release: 1, velocity: 0.8, level: 0.6 }),
      mod('reverb', 'reverb1', { size: 3.5, mix: 0.3 })],
    audio: [{ from: 'op2', to: 'op1' }, ...chain('op1', 'reverb1', 'out')],
  },
  {
    name: 'Nylon Pluck', type: 'Pluck', voices: 8,
    modules: [mod('osc', 'osc1', { wave: 'triangle', level: 0.6 }), mod('osc', 'osc2', { wave: 'saw', level: 0.2 }),
      mod('filter', 'filter1', { cutoff: 700, resonance: 1, keytrack: 0.8 }), mod('env', 'env1', { attack: 0.001, decay: 0.12, sustain: 0, release: 0.1 }),
      mod('amp', 'amp1', { attack: 0.001, decay: 0.9, sustain: 0, release: 0.35, velocity: 0.7 }), mod('reverb', 'reverb1', { size: 1.5, mix: 0.18 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'reverb1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 3600 }],
  },
  {
    name: 'String Ensemble', type: 'Strings', voices: 10, volume: 0.7,
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -10, level: 0.45 }), mod('osc', 'osc2', { wave: 'saw', fine: 10, level: 0.45 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 2400, resonance: 0.6 }), mod('amp', 'amp1', { attack: 0.6, decay: 1, sustain: 0.9, release: 1.2, velocity: 0.3 }),
      mod('chorus', 'chorus1', { rate: 0.7, depth: 0.7, mix: 0.55 }), mod('reverb', 'reverb1', { size: 3, mix: 0.3 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'chorus1', 'reverb1', 'out')],
  },
  {
    name: 'Brass Stab', type: 'Brass', voices: 8,
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.55 }), mod('osc', 'osc2', { wave: 'saw', fine: 7, level: 0.55 }),
      mod('filter', 'filter1', { cutoff: 500, resonance: 1.5 }), mod('env', 'env1', { attack: 0.02, decay: 0.25, sustain: 0.2, release: 0.15 }),
      mod('amp', 'amp1', { attack: 0.01, decay: 0.35, sustain: 0.4, release: 0.15 }), mod('reverb', 'reverb1', { size: 1.2, mix: 0.15 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'reverb1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 4200 }, { from: 'vel', to: 'filter1.cutoff', amount: 1200 }],
  },
  {
    name: 'Dark Pad', type: 'Pad', voices: 10, volume: 0.75,
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -5, level: 0.45 }), mod('osc', 'osc2', { wave: 'saw', octave: -1, fine: 5, level: 0.45 }),
      mod('filter', 'filter1', { cutoff: 550, resonance: 2 }), mod('lfo', 'lfo1', { rate: 0.12 }),
      mod('amp', 'amp1', { attack: 1.8, decay: 1, sustain: 0.9, release: 3 }), mod('reverb', 'reverb1', { size: 6, mix: 0.45 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'reverb1', 'out')],
    mod: [{ from: 'lfo1', to: 'filter1.cutoff', amount: 900 }],
  },
  {
    name: 'Noise Sweep', type: 'FX', voices: 4, volume: 0.7,
    modules: [mod('noise', 'noise1', { level: 1 }), mod('filter', 'filter1', { type: 'bandpass', slope: '12', cutoff: 800, resonance: 3, keytrack: 0 }),
      mod('lfo', 'lfo1', { wave: 'triangle', rate: 0.25 }), mod('amp', 'amp1', { attack: 0.5, decay: 1, sustain: 0.9, release: 1.5 }),
      mod('reverb', 'reverb1', { size: 4, mix: 0.4 })],
    audio: chain('noise1', 'filter1', 'amp1', 'reverb1', 'out'),
    mod: [{ from: 'lfo1', to: 'filter1.cutoff', amount: 3600 }],
  },
  {
    name: 'Wind', type: 'FX', voices: 4, volume: 0.9,
    modules: [mod('noise', 'noise1', { level: 1 }), mod('filter', 'filter1', { type: 'bandpass', slope: '12', cutoff: 600, resonance: 1.2, keytrack: 0.5 }),
      mod('lfo', 'lfo1', { wave: 'random', rate: 1.5 }), mod('amp', 'amp1', { attack: 0.6, decay: 1, sustain: 1, release: 2, velocity: 0.2 }),
      mod('space', 'space1', { spread: 120, distance: 1.2 }), mod('reverb', 'reverb1', { size: 5, mix: 0.35 })],
    audio: chain('noise1', 'filter1', 'amp1', 'space1', 'reverb1', 'out'),
    mod: [{ from: 'lfo1', to: 'filter1.cutoff', amount: 1500 }, { from: 'lfo1', to: 'space1.x', amount: 2 }],
  },
  {
    name: 'Suitcase Keys', type: 'Keys', voices: 10, volume: 0.6,
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 0.9, attack: 0.002, decay: 2.4, sustain: 0.2, release: 0.5, velocity: 0.8, level: 0.5 }),
      mod('fmop', 'op2', { ratio: 1, decay: 1.2, sustain: 0.15, release: 0.4, velocity: 1, level: 0.6 }),
      mod('tremolo', 'trem1', { rate: 4.5, depth: 0.6, pan: 1 }), mod('phaser', 'phaser1', { rate: 0.3, depth: 0.5, feedback: 0.3, mix: 0.35 }),
      mod('reverb', 'reverb1', { type: 'room', size: 1.2, predelay: 10, damping: 0.6, mix: 0.2 })],
    audio: [{ from: 'op2', to: 'op1' }, ...chain('op1', 'trem1', 'phaser1', 'reverb1', 'out')],
  },
  {
    name: 'Dub Chord', type: 'Keys', voices: 8, volume: 0.75,
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.5 }), mod('osc', 'osc2', { wave: 'square', semi: 7, level: 0.3 }),
      mod('filter', 'filter1', { cutoff: 900, resonance: 4 }), mod('env', 'env1', { attack: 0.001, decay: 0.15, sustain: 0, release: 0.1 }),
      mod('amp', 'amp1', { attack: 0.002, decay: 0.25, sustain: 0, release: 0.15 }),
      mod('delay', 'delay1', { mode: 'tape', time: 0.375, feedback: 0.5, tone: 2200, wobble: 0.4, mix: 0.4 }),
      mod('reverb', 'reverb1', { type: 'plate', size: 2.5, predelay: 30, damping: 0.4, mix: 0.25 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'reverb1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 3000 }],
  },
  {
    name: '909 Kit', type: 'Drums', voices: 16,
    modules: [{ ...mod('drums', 'drums1'), pads: kitPads({
      36: { t1Level: 1.3, t1Pitch: 52, t1Sweep: 24, t1Bend: 0.03, t1Decay: 0.5, t2Level: 0, click: 0.6, drive: 0.25 },
      38: { t1Level: 0.5, t1Wave: 'triangle', t1Pitch: 190, t1Decay: 0.12, t2Level: 0.3, t2Wave: 'triangle', t2Pitch: 330, t2Decay: 0.08, nLevel: 0.75, nFreq: 1800, nDecay: 0.25 },
      39: { nLevel: 1.5, nFreq: 1100, nQ: 2, nDecay: 0.25 },
      42: { t1Level: 0.2, t1Wave: 'metal', t1Pitch: 320, t1Decay: 0.05, nLevel: 0.2, nFreq: 9000, nDecay: 0.04 },
      44: { t1Level: 0.18, t1Wave: 'metal', t1Pitch: 320, t1Decay: 0.035, nLevel: 0.18, nFreq: 9000, nDecay: 0.03 },
      46: { t1Level: 0.18, t1Wave: 'metal', t1Pitch: 320, t1Decay: 0.5, nLevel: 0.2, nFreq: 8000, nDecay: 0.45 },
      49: { t1Level: 0.15, t1Wave: 'metal', t1Pitch: 280, t1Decay: 1.6, nLevel: 0.3, nFreq: 5000, nDecay: 1.4 },
      51: { t1Level: 0.12, t1Wave: 'metal', t1Pitch: 450, t1Decay: 1.2, nLevel: 0.12, nFreq: 9000, nDecay: 0.6 },
      41: tom909('Low tom', 80), 43: tom909('Floor tom', 95), 45: tom909('Mid tom', 115), 47: tom909('Mid tom 2', 135), 48: tom909('High tom', 160), 50: tom909('High tom 2', 190),
    }) }, mod('reverb', 'reverb1', { type: 'room', size: 0.8, predelay: 5, damping: 0.6, mix: 0.1 })],
    audio: chain('drums1', 'reverb1', 'out'),
  },
  {
    name: 'Lo-Fi Kit', type: 'Drums', voices: 16,
    modules: [{ ...mod('drums', 'drums1', { tone: 0.25, decay: 0.8 }), pads: kitPads({
      36: { drive: 0.5, click: 0.2 }, 38: { drive: 0.45, nFilter: 'bandpass', nFreq: 2200, nQ: 0.8 }, 39: { drive: 0.3 },
      42: { nFilter: 'bandpass', nFreq: 6000, nQ: 1.2 }, 44: { nFilter: 'bandpass', nFreq: 6000, nQ: 1.2 }, 46: { nFilter: 'bandpass', nFreq: 5500, nQ: 1.2 },
    }) }, mod('eq', 'eq1', { low: 3, high: -6 }), mod('compressor', 'comp1', { threshold: -18, ratio: 4, attack: 0.005, release: 0.15, gain: 0 })],
    audio: chain('drums1', 'eq1', 'comp1', 'out'),
  },
].map(cleanPatch);

export const FACTORY = [...STARTERS, ...MORE];
