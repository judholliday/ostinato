// The Sound Lab's sound library for Ostinato Synth (the Lab's engine): the factory sounds that
// come with Ostinato, the types sounds are sorted by, and a guess at a type for sounds without
// one. Your own sounds are the saved instruments (data/instruments/). No DOM here.
import { STARTERS, cleanPatch, defaultParams } from './patch.js';
import { DEFAULT_PADS, copyPads } from './drums.js';
import { KEYS } from './keys.js';

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
const COMP = () => mod('compressor', 'comp1', { threshold: -30, ratio: 3, attack: 0.02, release: 0.3, gain: 7 });
// A limiter at the end of spiky sounds (crushed FM, stuttered drums) keeps their peaks in line.
const LIMIT = () => mod('compressor', 'limit1', { threshold: -10, ratio: 12, attack: 0.001, release: 0.1, gain: 0 });
const tom909 = (name, f) => ({ name, t1Level: 1, t1Wave: 'sine', t1Pitch: f, t1Sweep: 7, t1Bend: 0.08, t1Decay: 0.4, nLevel: 0.12, nFilter: 'lowpass', nFreq: 3000, nDecay: 0.05 });

// The starting points (patch.js) plus more, one or more of each type.
const MORE = [
  {
    name: 'Sub Bass', play: 'mono', glide: 0.03, type: 'Bass', voices: 4,
    modules: [mod('osc', 'osc1', { wave: 'sine', octave: -1, level: 0.9 }), mod('osc', 'osc2', { wave: 'triangle', level: 0.25 }),
      mod('amp', 'amp1', { attack: 0.004, decay: 0.3, sustain: 0.9, release: 0.12 })],
    audio: [{ from: 'osc1', to: 'amp1' }, { from: 'osc2', to: 'amp1' }, { from: 'amp1', to: 'out' }],
  },
  {
    name: 'Acid Bass', play: 'legato', glide: 0.07, type: 'Bass', voices: 2,
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
    name: 'Saw Lead', play: 'legato', glide: 0.08, type: 'Lead', voices: 4,
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -6, level: 0.5 }), mod('osc', 'osc2', { wave: 'saw', fine: 6, level: 0.5 }),
      mod('filter', 'filter1', { cutoff: 2800, resonance: 3, keytrack: 0.7 }), mod('lfo', 'lfo1', { rate: 5.5, delay: 0.3, depth: 0 }),
      mod('amp', 'amp1', { attack: 0.01, decay: 0.3, sustain: 0.85, release: 0.2 }), mod('delay', 'delay1', { time: 0.3, feedback: 0.3, mix: 0.2 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'out')],
    mod: [{ from: 'lfo1', to: 'osc1.pitch', amount: 30 }, { from: 'lfo1', to: 'osc2.pitch', amount: 30 }, { from: 'wheel', to: 'lfo1.depth', amount: 1 }],
  },
  {
    name: 'Square Lead', play: 'mono', type: 'Lead', voices: 4,
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
      mod('amp', 'amp1', { keytrack: 0.5, attack: 0.001, decay: 0.9, sustain: 0, release: 0.35, velocity: 0.7 }), mod('reverb', 'reverb1', { size: 1.5, mix: 0.18 })],
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

  // ---- with the newer effects: Distortion, Bitcrusher, Stutter, Freeze ----
  {
    name: 'Fuzz Bass', play: 'mono', type: 'Bass', voices: 2,
    modules: [mod('osc', 'osc1', { wave: 'saw', octave: -1, level: 0.6 }), mod('osc', 'osc2', { wave: 'square', octave: -2, level: 0.45 }),
      mod('filter', 'filter1', { cutoff: 900, resonance: 2, keytrack: 0.4 }), mod('env', 'env1', { attack: 0.002, decay: 0.3, sustain: 0.3, release: 0.1 }),
      mod('amp', 'amp1', { attack: 0.003, decay: 0.4, sustain: 0.85, release: 0.08 }),
      mod('shaper', 'fuzz1', { curve: 'tube', drive: 9, tone: 3200, mix: 1, level: 0.55 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'fuzz1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 2000 }],
  },
  {
    name: 'Folded Lead', play: 'legato', glide: 0.12, type: 'Lead', voices: 4,
    modules: [mod('osc', 'osc1', { wave: 'sine', level: 0.8 }), mod('osc', 'osc2', { wave: 'triangle', octave: 1, fine: 4, level: 0.3 }),
      mod('lfo', 'lfo1', { rate: 5.4, delay: 0.4, depth: 0 }),
      mod('amp', 'amp1', { attack: 0.01, decay: 0.4, sustain: 0.8, release: 0.25 }),
      mod('shaper', 'fold1', { curve: 'fold', drive: 5, tone: 7000, mix: 1, level: 0.5 }), mod('delay', 'delay1', { time: 0.33, feedback: 0.35, mix: 0.22 })],
    audio: [{ from: 'osc1', to: 'amp1' }, { from: 'osc2', to: 'amp1' }, ...chain('amp1', 'fold1', 'delay1', 'out')],
    mod: [{ from: 'lfo1', to: 'osc1.pitch', amount: 25 }, { from: 'wheel', to: 'lfo1.depth', amount: 1 }, { from: 'vel', to: 'osc1.level', amount: 0.3 }],
  },
  {
    name: 'Octave Fuzz Lead', play: 'legato', glide: 0.06, type: 'Lead', voices: 2,
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.7 }), mod('filter', 'filter1', { cutoff: 2400, resonance: 4, keytrack: 0.6 }),
      mod('amp', 'amp1', { attack: 0.005, decay: 0.3, sustain: 0.9, release: 0.2 }),
      mod('shaper', 'fuzz1', { curve: 'rectify', drive: 6, tone: 4500, mix: 1, level: 0.5 }), mod('reverb', 'reverb1', { type: 'room', size: 1.2, mix: 0.18 })],
    audio: chain('osc1', 'filter1', 'amp1', 'fuzz1', 'reverb1', 'out'),
  },
  {
    name: 'Lo-Fi Keys', type: 'Keys', voices: 8, volume: 0.6,
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 1.1, attack: 0.002, decay: 2, sustain: 0.25, release: 0.4, level: 0.7 }),
      mod('fmop', 'op2', { ratio: 1, decay: 1.2, sustain: 0.2, release: 0.4, velocity: 0.9, level: 0.6 }),
      mod('crusher', 'crush1', { bits: 7, hold: 3, mix: 0.75 }), mod('chorus', 'chorus1', { rate: 0.6, depth: 0.7, mix: 0.4 }),
      mod('eq', 'eq1', { low: 2, high: -5 }), LIMIT()],
    audio: [{ from: 'op2', to: 'op1' }, ...chain('op1', 'crush1', 'chorus1', 'eq1', 'limit1', 'out')],
  },
  {
    name: 'Chip Lead', play: 'legato', glide: 0.04, type: 'Lead', voices: 1,
    modules: [mod('osc', 'osc1', { wave: 'pulse', pw: 0.25, level: 0.6 }), mod('lfo', 'lfo1', { rate: 6.5, delay: 0.25, depth: 1 }),
      mod('amp', 'amp1', { attack: 0.001, decay: 0.2, sustain: 0.7, release: 0.05 }),
      mod('crusher', 'crush1', { bits: 4, hold: 6, mix: 1 }), mod('delay', 'delay1', { mode: 'ping-pong', time: 0.25, feedback: 0.3, mix: 0.25 })],
    audio: chain('osc1', 'amp1', 'crush1', 'delay1', 'out'),
    mod: [{ from: 'lfo1', to: 'osc1.pitch', amount: 30 }],
  },
  {
    name: 'Stutter Pluck', type: 'Pluck', voices: 8, volume: 1,
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.55 }), mod('osc', 'osc2', { wave: 'square', octave: 1, level: 0.2 }),
      mod('filter', 'filter1', { cutoff: 500, resonance: 6 }), mod('env', 'env1', { attack: 0.001, decay: 0.15, sustain: 0, release: 0.12 }),
      mod('amp', 'amp1', { keytrack: 0.4, attack: 0.001, decay: 0.45, sustain: 0, release: 0.25 }),
      mod('stutter', 'stut1', { size: 0.125, chance: 0.35, repeats: 3, mix: 1 }), mod('delay', 'delay1', { time: 0.375, feedback: 0.3, mix: 0.2 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'stut1', 'delay1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 5200 }],
  },
  {
    name: 'Glitch Pad', type: 'Pad', voices: 8,
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -9, level: 0.45 }), mod('osc', 'osc2', { wave: 'saw', fine: 9, level: 0.45 }),
      mod('filter', 'filter1', { cutoff: 1600, resonance: 2, keytrack: 0.3 }), mod('lfo', 'lfo1', { rate: 0.2, depth: 1 }),
      mod('amp', 'amp1', { attack: 0.8, decay: 1, sustain: 0.85, release: 1.8 }),
      mod('stutter', 'stut1', { size: 0.06, chance: 0.18, repeats: 6, mix: 1 }), mod('reverb', 'reverb1', { type: 'hall', size: 3.5, mix: 0.35 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'stut1', 'reverb1', 'out')],
    mod: [{ from: 'lfo1', to: 'filter1.cutoff', amount: 900 }],
  },
  {
    name: 'Freeze Pad', type: 'Pad', voices: 8,
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -6, level: 0.4 }), mod('osc', 'osc2', { wave: 'triangle', octave: 1, fine: 6, level: 0.35 }),
      mod('filter', 'filter1', { cutoff: 2200, resonance: 1, keytrack: 0.4 }),
      mod('amp', 'amp1', { attack: 0.4, decay: 1, sustain: 0.8, release: 1.2 }),
      mod('freeze', 'freeze1', { state: 'listen', size: 0.6, mix: 1 }), mod('reverb', 'reverb1', { type: 'hall', size: 4.5, mix: 0.4 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'freeze1', 'reverb1', 'out')],
  },
  {
    name: 'Dusty Kit', type: 'Drums', voices: 16, volume: 0.7,
    modules: [{ ...mod('drums', 'drums1', { tone: 0.35, decay: 0.9 }), pads: kitPads({ 36: { drive: 0.3, click: 0.25 }, 38: { nFilter: 'bandpass', nFreq: 1800 } }) },
      mod('crusher', 'crush1', { bits: 9, hold: 3, mix: 0.7 }), mod('shaper', 'sat1', { curve: 'soft', drive: 2.5, tone: 6000, mix: 1, level: 0.75 }),
      mod('eq', 'eq1', { low: 2, high: -3 }), LIMIT()],
    audio: chain('drums1', 'crush1', 'sat1', 'eq1', 'limit1', 'out'),
  },
  {
    name: 'Glitch Kit', type: 'Drums', voices: 16, volume: 0.7,
    modules: [{ ...mod('drums', 'drums1', { tone: 0.6, decay: 0.7 }), pads: kitPads({ 42: { t1Level: 0.2, t1Wave: 'metal', t1Pitch: 420, t1Decay: 0.05 } }) },
      mod('stutter', 'stut1', { size: 0.0625, chance: 0.25, repeats: 4, mix: 1 }), mod('crusher', 'crush1', { bits: 6, hold: 2, mix: 0.35 }),
      mod('compressor', 'comp1', { threshold: -16, ratio: 4, gain: 0 }), LIMIT()],
    audio: chain('drums1', 'stut1', 'crush1', 'comp1', 'limit1', 'out'),
  },
  {
    name: 'Broken Radio', type: 'FX', voices: 4, volume: 1,
    modules: [mod('osc', 'osc1', { wave: 'square', level: 0.7 }), mod('noise', 'noise1', { level: 0.35 }),
      mod('filter', 'filter1', { type: 'bandpass', cutoff: 1400, resonance: 6, keytrack: 0.3 }), mod('lfo', 'lfo1', { wave: 'random', rate: 7, depth: 1 }),
      mod('amp', 'amp1', { attack: 0.02, decay: 0.5, sustain: 0.8, release: 0.3 }),
      mod('shaper', 'drive1', { curve: 'soft', drive: 6, tone: 5000, mix: 1, level: 1 }),
      mod('crusher', 'crush1', { bits: 3, hold: 12, mix: 0.8 }), mod('tremolo', 'trem1', { rate: 9, depth: 0.5 })],
    // Driven hard before the crusher: at 3 bits a quiet signal would round to nothing.
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'noise1', to: 'filter1' }, ...chain('filter1', 'amp1', 'drive1', 'crush1', 'trem1', 'out')],
    mod: [{ from: 'lfo1', to: 'filter1.cutoff', amount: 1100 }],
  },

  // ---- granular: clouds made from the factory samples (samples/) ----
  // Grain clouds come out quiet (many soft overlapping grains), so a compressor lifts them.
  {
    name: 'Grain Choir', volume: 1, type: 'Pad', voices: 6,
    modules: [mod('granular', 'gr1', { file: 'factory/Vowel Ah (C4).wav', root: 60, position: 0.45, spread: 0.25, scan: 0.04, size: 0.14, density: 40, jitter: 8, width: 0.9, level: 0.9 }),
      mod('amp', 'amp1', { attack: 0.9, decay: 1, sustain: 0.9, release: 2.5, level: 0.8 }), COMP(), mod('reverb', 'reverb1', { type: 'hall', size: 4, mix: 0.35 })],
    audio: chain('gr1', 'amp1', 'comp1', 'reverb1', 'out'),
  },
  {
    name: 'Glass Cloud', volume: 1, type: 'Bell', voices: 6,
    modules: [mod('granular', 'gr1', { file: 'factory/Glass Bell (C5).wav', root: 72, position: 0.08, spread: 0.35, scan: 0.1, size: 0.06, density: 55, jitter: 12, width: 1, level: 0.8 }),
      mod('amp', 'amp1', { attack: 0.3, decay: 1.5, sustain: 0.7, release: 3, level: 0.8 }), COMP(),
      mod('delay', 'delay1', { mode: 'ping-pong', time: 0.42, feedback: 0.4, tone: 3500, mix: 0.3 }), mod('reverb', 'reverb1', { type: 'plate', size: 4, mix: 0.35 })],
    audio: chain('gr1', 'amp1', 'comp1', 'delay1', 'reverb1', 'out'),
  },
  {
    name: 'Wind Grains', volume: 1, type: 'FX', voices: 4,
    modules: [mod('granular', 'gr1', { file: 'factory/Wind.wav', root: 60, position: 0.3, spread: 0.4, scan: 0.25, size: 0.25, density: 18, jitter: 300, width: 1, level: 1 }),
      mod('filter', 'filter1', { type: 'bandpass', cutoff: 1200, resonance: 3, keytrack: 0.8 }),
      mod('amp', 'amp1', { attack: 1.2, decay: 1, sustain: 1, release: 2.5, level: 0.9 }), COMP(), mod('reverb', 'reverb1', { type: 'hall', size: 5, mix: 0.4 })],
    audio: chain('gr1', 'filter1', 'amp1', 'comp1', 'reverb1', 'out'),
  },
  {
    name: 'Slow Music Box', volume: 1, type: 'Pad', voices: 4,
    modules: [mod('granular', 'gr1', { file: 'factory/Music Box Phrase (C5).wav', root: 72, position: 0, spread: 0.03, scan: 0.2, size: 0.18, density: 30, jitter: 0, width: 0.8, level: 0.9 }),
      mod('amp', 'amp1', { attack: 0.5, decay: 1, sustain: 1, release: 2, level: 0.8 }), COMP(), mod('reverb', 'reverb1', { type: 'hall', size: 5, mix: 0.4 })],
    audio: chain('gr1', 'amp1', 'comp1', 'reverb1', 'out'),
  },
  {
    name: 'Crushed Grains', volume: 1, type: 'FX', voices: 4,
    modules: [mod('granular', 'gr1', { file: 'factory/Glass Bell (C5).wav', root: 72, position: 0.2, spread: 0.6, scan: 0, size: 0.02, density: 70, jitter: 500, width: 1, level: 0.9 }),
      mod('amp', 'amp1', { attack: 0.05, decay: 0.8, sustain: 0.7, release: 1, level: 0.8 }), COMP(),
      mod('crusher', 'crush1', { bits: 5, hold: 4, mix: 0.7 }), mod('stutter', 'stut1', { size: 0.09, chance: 0.3, repeats: 3, mix: 1 }),
      mod('delay', 'delay1', { mode: 'ping-pong', time: 0.27, feedback: 0.35, mix: 0.25 })],
    audio: chain('gr1', 'amp1', 'comp1', 'crush1', 'stut1', 'delay1', 'out'),
  },

  // ---- for fast arpeggios: short, clear attacks that don't smear at 16ths ----
  {
    name: 'Glass Arp', type: 'Pluck', voices: 12, volume: 0.55,
    about: 'A bright FM pluck for fast arpeggios: a glassy tick on the attack that fades to a pure tone, with a ping-pong echo.',
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 2.2, attack: 0.001, decay: 0.32, sustain: 0, release: 0.12, velocity: 0.5, level: 0.75, keytrack: 0.5 }),
      mod('fmop', 'op2', { ratio: 3.5, attack: 0.001, decay: 0.09, sustain: 0, release: 0.05, velocity: 0.7, level: 0.8 }),
      mod('eq', 'eq1', { low: -4, high: 2 }),
      mod('delay', 'delay1', { mode: 'ping-pong', time: 0.28, feedback: 0.32, tone: 5000, mix: 0.22 })],
    audio: [{ from: 'op2', to: 'op1' }, ...chain('op1', 'eq1', 'delay1', 'out')],
  },
  {
    name: 'Saw Arp', type: 'Pluck', voices: 12, volume: 0.8,
    about: 'Two detuned saws through a resonant filter that snaps shut: the classic electronic arpeggio. Velocity opens the filter.',
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -8, level: 0.5 }), mod('osc', 'osc2', { wave: 'saw', fine: 8, level: 0.5 }),
      mod('filter', 'filter1', { cutoff: 420, resonance: 7, keytrack: 0.7 }), mod('env', 'env1', { attack: 0.001, decay: 0.11, sustain: 0, release: 0.08 }),
      mod('amp', 'amp1', { attack: 0.001, decay: 0.22, sustain: 0.15, release: 0.09, velocity: 0.5 }),
      mod('delay', 'delay1', { mode: 'ping-pong', time: 0.21, feedback: 0.3, tone: 4000, mix: 0.18 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 5200 }, { from: 'vel', to: 'filter1.cutoff', amount: 1800 }],
  },
  {
    name: 'Blip Arp', type: 'Pluck', voices: 12, volume: 0.85,
    about: 'A tiny hollow blip: a narrow pulse with its width wobbling slowly, so long runs of notes shift in colour.',
    modules: [mod('osc', 'osc1', { wave: 'pulse', pw: 0.18, level: 0.6 }), mod('osc', 'osc2', { wave: 'sine', octave: 1, level: 0.25 }),
      mod('lfo', 'lfo1', { wave: 'triangle', rate: 0.35 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 2600, resonance: 2, keytrack: 0.6 }),
      mod('amp', 'amp1', { attack: 0.001, decay: 0.12, sustain: 0, release: 0.06, velocity: 0.5 }),
      mod('delay', 'delay1', { time: 0.14, feedback: 0.25, tone: 3500, mix: 0.15 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'out')],
    mod: [{ from: 'lfo1', to: 'osc1.pw', amount: 0.14 }],
  },
  {
    name: 'Rubber Arp', type: 'Pluck', voices: 12, volume: 1,
    about: 'A round, bouncy pluck: a band-pass filter sweeping down fast over a square wave, like a plucked rubber band. Darker than Saw Arp.',
    modules: [mod('osc', 'osc1', { wave: 'square', level: 0.65 }), mod('osc', 'osc2', { wave: 'triangle', octave: -1, level: 0.35 }),
      mod('filter', 'filter1', { type: 'bandpass', slope: '12', cutoff: 500, resonance: 5, keytrack: 0.8 }),
      mod('env', 'env1', { attack: 0.001, decay: 0.07, sustain: 0, release: 0.06 }),
      mod('amp', 'amp1', { attack: 0.001, decay: 0.18, sustain: 0.1, release: 0.08, velocity: 0.5, level: 1 }),
      mod('shaper', 'sat1', { curve: 'tube', drive: 2.5, tone: 6000, mix: 1, level: 1.5 }),
      mod('reverb', 'reverb1', { type: 'room', size: 0.9, mix: 0.12 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'sat1', 'reverb1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 2600 }],
  },

  // ---- an electronic kit for fast, odd-meter beats, and a bass to go with it ----
  {
    name: 'Odd Step Kit', type: 'Drums', voices: 16, volume: 0.75,
    about: 'Crisp programmed drums for skittering beats in 5/4 and other odd meters: a deep sub kick, a tight snare, a roomy 808-style clap, '
      + 'and hats chopped short and stuttered (Pedal hat) so they sound sliced. Toms are electronic, the Low tom is a sub drop.',
    modules: [{ ...mod('drums', 'drums1', { tone: 0.55 }), pads: kitPads({
      36: { name: 'Sub kick', t1Level: 1.4, t1Wave: 'sine', t1Pitch: 43, t1Sweep: 26, t1Bend: 0.045, t1Decay: 0.75,
        t2Level: 0.7, t2Wave: 'triangle', t2Pitch: 95, t2Sweep: 18, t2Bend: 0.02, t2Decay: 0.07, click: 0.55, drive: 0.2 },
      37: { name: 'Tick', t1Level: 0.45, t1Wave: 'square', t1Pitch: 2400, t1Sweep: 0, t1Decay: 0.014, nLevel: 0.35, nFilter: 'bandpass', nFreq: 6500, nQ: 3, nDecay: 0.012 },
      38: { name: 'Tight snare', t1Level: 0.55, t1Wave: 'triangle', t1Pitch: 220, t1Sweep: 7, t1Bend: 0.015, t1Decay: 0.07,
        nLevel: 0.85, nFilter: 'highpass', nFreq: 2600, nDecay: 0.11, click: 0.45, drive: 0.25, level: 0.55 },
      39: { name: 'Room clap', nLevel: 1.5, nFilter: 'bandpass', nFreq: 1150, nQ: 1.6, nDecay: 0.38, nBursts: 4, level: 1.1 },
      42: { name: 'Short hat', nLevel: 0.5, nFilter: 'highpass', nFreq: 9500, nDecay: 0.022, t1Level: 0.12, t1Wave: 'metal', t1Pitch: 380, t1Decay: 0.02, choke: 1 },
      44: { name: 'Sliced hat', nLevel: 0.5, nFilter: 'highpass', nFreq: 8500, nDecay: 0.03, nBursts: 3, choke: 1 },
      46: { name: 'Open hat', nLevel: 0.35, nFilter: 'highpass', nFreq: 8000, nDecay: 0.22, t1Level: 0.14, t1Wave: 'metal', t1Pitch: 380, t1Decay: 0.2, choke: 1 },
      49: { name: 'Noise crash', nLevel: 0.4, nFilter: 'highpass', nFreq: 3500, nDecay: 1.1 },
      51: { name: 'Shaker', nLevel: 0.4, nFilter: 'bandpass', nFreq: 5500, nQ: 1.2, nDecay: 0.06, t1Level: 0 },
      56: { name: 'Blip', t1Level: 0.35, t1Wave: 'sine', t1Pitch: 1500, t1Sweep: 12, t1Bend: 0.008, t1Decay: 0.05, t2Level: 0 },
      41: { name: 'Sub drop', t1Level: 1.2, t1Wave: 'sine', t1Pitch: 36, t1Sweep: 24, t1Bend: 0.35, t1Decay: 1.3, nLevel: 0, click: 0.2 },
      43: { name: 'Elec tom low', t1Level: 0.9, t1Wave: 'sine', t1Pitch: 95, t1Sweep: 10, t1Bend: 0.12, t1Decay: 0.28, nLevel: 0.08, nFilter: 'lowpass', nFreq: 2500, nDecay: 0.03 },
      45: { name: 'Elec tom mid', t1Level: 0.85, t1Wave: 'sine', t1Pitch: 130, t1Sweep: 10, t1Bend: 0.1, t1Decay: 0.24, nLevel: 0.08, nFilter: 'lowpass', nFreq: 2500, nDecay: 0.03 },
      47: { name: 'Elec tom high', t1Level: 0.8, t1Wave: 'sine', t1Pitch: 175, t1Sweep: 10, t1Bend: 0.09, t1Decay: 0.2, nLevel: 0.08, nFilter: 'lowpass', nFreq: 3000, nDecay: 0.03 },
      48: { name: 'Zap', t1Level: 0.6, t1Wave: 'triangle', t1Pitch: 260, t1Sweep: 36, t1Bend: 0.06, t1Decay: 0.12 },
      50: { name: 'Zap high', t1Level: 0.5, t1Wave: 'triangle', t1Pitch: 520, t1Sweep: 36, t1Bend: 0.04, t1Decay: 0.09 },
    }) },
      mod('eq', 'eq1', { low: 2, mid: -2, midfreq: 400, high: 2 }),
      mod('compressor', 'comp1', { threshold: -18, ratio: 3, attack: 0.008, release: 0.12, gain: 2 }),
      mod('reverb', 'reverb1', { type: 'plate', size: 1.4, predelay: 10, damping: 0.5, mix: 0.12 }), LIMIT()],
    audio: chain('drums1', 'eq1', 'comp1', 'reverb1', 'limit1', 'out'),
  },
  {
    // The TR-808's sixteen voices on the pads, from Roland's service-manual chart and circuit analyses
    // (Werner/Abel/Smith; Baratatronix): bass drum a decaying sine near 50 Hz that starts at ~130 Hz
    // and falls within ~6 ms; snare 238 + 476 Hz with noise high-passed near 2.7 kHz; toms 90/135/185 Hz
    // and congas without their noise; rimshot 455 + 1667 Hz for 10 ms; claves 2.5 kHz; hats and cymbal
    // the six square oscillators at 205.3, 304.4, 369.6, 522.7, 540 and 800 Hz (the engine's 'metal'),
    // filtered high; cowbell 540 + 800 Hz. Dry, as the machine is.
    name: '808 Kit', type: 'Drums', voices: 16, volume: 0.8,
    about: 'The Roland TR-808\'s sixteen voices: a booming sine bass drum (Decay on the kit lengthens it), snare, clap, rimshot, '
      + 'claves, maracas, cowbell, closed and open hats, cymbal, three toms (Low, Mid, High tom pads) and three congas (the other tom pads).',
    modules: [{ ...mod('drums', 'drums1', { tone: 0.5 }), pads: kitPads({
      36: { name: 'Bass drum', t1Level: 1.4, t1Wave: 'sine', t1Pitch: 50, t1Sweep: 16.5, t1Bend: 0.006, t1Decay: 0.8, t2Level: 0, nLevel: 0, click: 0.12, level: 1.3 },
      38: { name: 'Snare', t1Level: 0.6, t1Wave: 'sine', t1Pitch: 238, t1Sweep: 1, t1Bend: 0.02, t1Decay: 0.14, t2Level: 0.35, t2Wave: 'sine', t2Pitch: 476, t2Sweep: 1, t2Bend: 0.02, t2Decay: 0.08,
        nLevel: 0.6, nFilter: 'highpass', nFreq: 2750, nQ: 0.7, nDecay: 0.2 },
      37: { name: 'Rimshot', t1Level: 0.45, t1Wave: 'square', t1Pitch: 1667, t1Sweep: 0, t1Decay: 0.012, t2Level: 0.4, t2Wave: 'square', t2Pitch: 455, t2Sweep: 0, t2Decay: 0.014, nLevel: 0, hp: 400 },
      39: { name: 'Hand clap', t1Level: 0, nLevel: 1.5, nFilter: 'bandpass', nFreq: 1000, nQ: 1.4, nDecay: 0.32, nBursts: 4 },
      42: { name: 'Closed hat', t1Level: 1.3, level: 1.2, t1Wave: 'metal', t1Pitch: 205.3, t1Sweep: 0, t1Decay: 0.05, nLevel: 0, hp: 7000, choke: 1 },
      44: { name: 'Maracas', t1Level: 0, nLevel: 0.45, nFilter: 'highpass', nFreq: 5000, nDecay: 0.03, choke: 0 },
      46: { name: 'Open hat', t1Level: 1.2, level: 1.2, t1Wave: 'metal', t1Pitch: 205.3, t1Sweep: 0, t1Decay: 0.4, nLevel: 0, hp: 6500, choke: 1 },
      49: { name: 'Cymbal', t1Level: 0.9, t1Wave: 'metal', t1Pitch: 205.3, t1Sweep: 0, t1Decay: 1.6, nLevel: 0, hp: 3500 },
      51: { name: 'Claves', t1Level: 0.5, t1Wave: 'triangle', t1Pitch: 2500, t1Sweep: 0, t1Decay: 0.03, t2Level: 0, nLevel: 0 },
      56: { name: 'Cowbell', t1Level: 0.18, t1Wave: 'square', t1Pitch: 540, t1Sweep: 0, t1Decay: 0.28, t2Level: 0.18, t2Wave: 'square', t2Pitch: 800, t2Sweep: 0, t2Decay: 0.28, hp: 500 },
      41: { name: 'Low tom', t1Level: 1, t1Wave: 'sine', t1Pitch: 90, t1Sweep: 1, t1Bend: 0.2, t1Decay: 0.2, nLevel: 0.06, nFilter: 'lowpass', nFreq: 1500, nDecay: 0.24 },
      45: { name: 'Mid tom', t1Level: 1, t1Wave: 'sine', t1Pitch: 135, t1Sweep: 1, t1Bend: 0.13, t1Decay: 0.13, nLevel: 0.06, nFilter: 'lowpass', nFreq: 1800, nDecay: 0.16 },
      48: { name: 'High tom', t1Level: 1, t1Wave: 'sine', t1Pitch: 185, t1Sweep: 1, t1Bend: 0.1, t1Decay: 0.1, nLevel: 0.06, nFilter: 'lowpass', nFreq: 2200, nDecay: 0.12 },
      43: { name: 'Low conga', t1Level: 0.9, t1Wave: 'sine', t1Pitch: 165, t1Sweep: 1, t1Bend: 0.18, t1Decay: 0.18, nLevel: 0 },
      47: { name: 'Mid conga', t1Level: 0.9, t1Wave: 'sine', t1Pitch: 250, t1Sweep: 1, t1Bend: 0.15, t1Decay: 0.15, nLevel: 0 },
      50: { name: 'High conga', t1Level: 0.9, t1Wave: 'sine', t1Pitch: 370, t1Sweep: 1, t1Bend: 0.12, t1Decay: 0.12, nLevel: 0 },
    }) }],
    audio: [{ from: 'drums1', to: 'out' }],
  },
  {
    name: 'Elastic Bass', play: 'legato', glide: 0.05, type: 'Bass', voices: 2, volume: 0.65,
    about: 'A round, warm bass with a rubbery FM bite on each attack (harder notes bite more) over a clean sine sub. Slides between notes you play legato.',
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 1.4, attack: 0.002, decay: 0.6, sustain: 0.7, release: 0.12, velocity: 0.4, level: 0.6 }),
      mod('fmop', 'op2', { ratio: 2, attack: 0.001, decay: 0.16, sustain: 0.12, release: 0.08, velocity: 0.9, level: 0.75 }),
      mod('osc', 'sub1', { wave: 'sine', octave: -1, level: 0.55 }),
      mod('amp', 'amp2', { attack: 0.003, decay: 0.5, sustain: 0.85, release: 0.12, velocity: 0.3 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 1400, resonance: 1.5, keytrack: 0.5 }),
      mod('shaper', 'sat1', { curve: 'tube', drive: 2.2, tone: 4000, mix: 1, level: 0.85 })],
    audio: [{ from: 'op2', to: 'op1' }, { from: 'op1', to: 'filter1' }, { from: 'sub1', to: 'amp2' }, { from: 'amp2', to: 'filter1' }, ...chain('filter1', 'sat1', 'out')],
  },
].map(cleanPatch);

export const FACTORY = [...STARTERS, ...MORE, ...KEYS.map(cleanPatch)];
