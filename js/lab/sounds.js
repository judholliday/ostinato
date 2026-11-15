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

// A struck cowbell (for drum pads, as a pad's sound): its two main modes at 1 : 1.44 (about 587 and
// 845 Hz played at D5, after Sound On Sound's Synth Secrets), the first frequency-modulated by the
// second so the strike is a bright, inharmonic clank that falls within ~35 ms to a softer ring (the
// two-stage decay of struck metal), the higher mode dying sooner.
const COWBELL = {
  name: 'Struck cowbell', type: 'Drums', voices: 4, volume: 0.9,
  // The pad holds the note for 50 ms (lHold), so Decay/Sustain shape the strike and Release the ring.
  modules: [mod('fmop', 'op1', { ratio: 1, fm: 2.2, attack: 0.001, decay: 0.03, sustain: 0.4, release: 0.28, velocity: 0.5, level: 0.8 }),
    mod('fmop', 'op2', { ratio: 1.44, attack: 0.001, decay: 0.03, sustain: 0.3, release: 0.22, velocity: 0.8, level: 0.8 }),
    mod('fmop', 'op3', { ratio: 1.44, attack: 0.001, decay: 0.03, sustain: 0.35, release: 0.18, velocity: 0.5, level: 0.45 })],
  audio: [{ from: 'op2', to: 'op1' }, { from: 'op1', to: 'out' }, { from: 'op3', to: 'out' }], mod: [],
};

// A sound from keys.js with effects swapped in after its own: everything that went to the output (and
// the module named `drop`, e.g. its own room reverb) is replaced by the new effects in a chain.
function withFx(baseName, { name, type, about, volume, drop = null, fx }) {
  const base = JSON.parse(JSON.stringify(KEYS.find(k => k.name === baseName)));
  const modules = base.modules.filter(m => m.id !== drop);
  const audio = [];
  for (const c of base.audio) {
    if (c.from === drop) continue;
    const to = c.to === drop || c.to === 'out' ? fx[0].id : c.to;
    if (!audio.some(a => a.from === c.from && a.to === to)) audio.push({ from: c.from, to });
  }
  return { ...base, name, type, about, ...(volume ? { volume } : {}), modules: [...modules, ...fx], audio: [...audio, ...chain(...fx.map(m => m.id), 'out')] };
}

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

  // ---- for fast arpeggios: short, clear attacks that don't smear at 16ths; the arpeggiator is on
  // (the user expected sounds called Arp to arpeggiate; Arp → Off beside Play for plain plucks) ----
  {
    name: 'Glass Arp', type: 'Pluck', voices: 12, volume: 0.55, arp: { mode: 'up', rate: '1/16', octaves: 2, gate: 0.5 },
    about: 'A bright FM pluck for fast arpeggios: a glassy tick on the attack that fades to a pure tone, with a ping-pong echo.',
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 2.2, attack: 0.001, decay: 0.32, sustain: 0, release: 0.12, velocity: 0.5, level: 0.75, keytrack: 0.5 }),
      mod('fmop', 'op2', { ratio: 3.5, attack: 0.001, decay: 0.09, sustain: 0, release: 0.05, velocity: 0.7, level: 0.8 }),
      mod('eq', 'eq1', { low: -4, high: 2 }),
      mod('delay', 'delay1', { mode: 'ping-pong', time: 0.28, feedback: 0.32, tone: 5000, mix: 0.22 })],
    audio: [{ from: 'op2', to: 'op1' }, ...chain('op1', 'eq1', 'delay1', 'out')],
  },
  {
    name: 'Saw Arp', type: 'Pluck', voices: 12, volume: 0.8, arp: { mode: 'up', rate: '1/16', octaves: 1, gate: 0.5 },
    about: 'Two detuned saws through a resonant filter that snaps shut: the classic electronic arpeggio. Velocity opens the filter.',
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -8, level: 0.5 }), mod('osc', 'osc2', { wave: 'saw', fine: 8, level: 0.5 }),
      mod('filter', 'filter1', { cutoff: 420, resonance: 7, keytrack: 0.7 }), mod('env', 'env1', { attack: 0.001, decay: 0.11, sustain: 0, release: 0.08 }),
      mod('amp', 'amp1', { attack: 0.001, decay: 0.22, sustain: 0.15, release: 0.09, velocity: 0.5 }),
      mod('delay', 'delay1', { mode: 'ping-pong', time: 0.21, feedback: 0.3, tone: 4000, mix: 0.18 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 5200 }, { from: 'vel', to: 'filter1.cutoff', amount: 1800 }],
  },
  {
    name: 'Blip Arp', type: 'Pluck', voices: 12, volume: 0.85, arp: { mode: 'up-down', rate: '1/16', octaves: 2, gate: 0.5 },
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
    name: 'Rubber Arp', type: 'Pluck', voices: 12, volume: 1, arp: { mode: 'up', rate: '1/16', octaves: 1, gate: 0.6 },
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
  // ---- French house: filtered disco chords, robot voices, pumping ----
  {
    name: 'Disco Filter Chords', type: 'Keys', voices: 10, volume: 0.4,
    about: 'Bright stacked chords through a resonant filter that opens and closes over two bars (synced to the tempo); the mod wheel opens it further. A phaser swirls on top.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 3, spread: 12, level: 0.55 }), mod('osc', 'osc2', { wave: 'square', octave: -1, level: 0.25 }),
      mod('filter', 'filter1', { cutoff: 700, resonance: 7, keytrack: 0.4 }), mod('lfo', 'lfo1', { wave: 'triangle', sync: '2/1' }),
      mod('amp', 'amp1', { attack: 0.005, decay: 0.3, sustain: 1, release: 0.15 }),
      mod('phaser', 'phaser1', { rate: 0.3, depth: 0.6, feedback: 0.5, mix: 0.4 }), mod('compressor', 'comp1', { threshold: -20, ratio: 3, gain: 3 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'phaser1', 'comp1', 'out')],
    mod: [{ from: 'lfo1', to: 'filter1.cutoff', amount: 2400 }, { from: 'wheel', to: 'filter1.cutoff', amount: 3600 }],
  },
  {
    name: 'Robot Talk Lead', play: 'legato', glide: 0.05, type: 'Lead', voices: 2, volume: 0.45,
    about: 'A buzzy lead that talks: each note says "ah-oh" through the vowel filter, and the mod wheel moves the mouth further toward "oo". Slides between notes you play legato.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 3, spread: 10, level: 0.6 }), mod('osc', 'osc2', { wave: 'pulse', pw: 0.3, octave: -1, level: 0.3 }),
      mod('vowel', 'mouth', { vowel: 0, resonance: 12, shift: -2 }), mod('env', 'env1', { attack: 0.01, decay: 0.35, sustain: 0.4, release: 0.2 }),
      mod('amp', 'amp1', { attack: 0.005, decay: 0.3, sustain: 0.9, release: 0.12 }), mod('drive', 'drive1', { amount: 0.3 }),
      mod('delay', 'delay1', { sync: '1/8.', feedback: 0.3, tone: 3500, mix: 0.18 })],
    audio: [{ from: 'osc1', to: 'mouth' }, { from: 'osc2', to: 'mouth' }, ...chain('mouth', 'drive1', 'amp1', 'delay1', 'out')],
    mod: [{ from: 'env1', to: 'mouth.vowel', amount: 3 }, { from: 'wheel', to: 'mouth.vowel', amount: 1 }],
  },
  {
    name: 'Robot Rock Riff', type: 'Lead', voices: 6, volume: 0.55,
    about: 'A short, gated, overdriven stab for hammering riffs: it stops dead when you let go. Squashed hard by a compressor.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 2, spread: 8, level: 0.6 }), mod('osc', 'osc2', { wave: 'square', octave: -1, level: 0.35 }),
      mod('filter', 'filter1', { cutoff: 2600, resonance: 2, keytrack: 0.3 }),
      mod('amp', 'amp1', { attack: 0.002, decay: 0.2, sustain: 1, release: 0.03 }),
      mod('shaper', 'dist1', { curve: 'hard', drive: 12, tone: 5000, mix: 1, level: 0.5 }),
      mod('compressor', 'comp1', { threshold: -24, ratio: 8, attack: 0.003, release: 0.08, gain: 4 }), mod('reverb', 'room1', { type: 'room', size: 0.7, mix: 0.08 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'dist1', 'comp1', 'room1', 'out')],
  },
  {
    name: 'Pump Pad', type: 'Pad', voices: 10, volume: 0.55,
    about: 'A wide supersaw pad that ducks on every beat and swells back, like a pad side-chained to the kick. Synced to the tempo: start chords on the beat.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 5, spread: 18, level: 0.6 }), mod('osc', 'osc2', { wave: 'saw', octave: 1, unison: 3, spread: 12, level: 0.2 }),
      mod('filter', 'filter1', { cutoff: 2400, resonance: 1, keytrack: 0.3 }), mod('lfo', 'pump', { wave: 'rise', sync: '1/4' }),
      mod('amp', 'amp1', { attack: 0.02, decay: 0.5, sustain: 1, release: 0.4, level: 0.55 }),
      mod('reverb', 'reverb1', { type: 'hall', size: 2.5, mix: 0.22 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'reverb1', 'out')],
    mod: [{ from: 'pump', to: 'amp1.level', amount: 0.45 }],
  },

  {
    name: 'Talk Box Bass', play: 'mono', type: 'Bass', voices: 2, volume: 0.6,
    about: 'A bass that says "wow" on every note: the vowel filter opens from "oo" to "ah" and closes again. Play harder to open the mouth wider.',
    modules: [mod('osc', 'osc1', { wave: 'saw', octave: -1, level: 0.6 }), mod('osc', 'osc2', { wave: 'square', octave: -1, fine: 6, level: 0.4 }),
      mod('vowel', 'mouth', { vowel: 4, resonance: 9, shift: -4 }), mod('env', 'env1', { attack: 0.03, decay: 0.3, sustain: 0.35, release: 0.15, velocity: 0.8 }),
      mod('amp', 'amp1', { attack: 0.003, decay: 0.3, sustain: 0.85, release: 0.08 }), mod('drive', 'drive1', { amount: 0.3 })],
    audio: [{ from: 'osc1', to: 'mouth' }, { from: 'osc2', to: 'mouth' }, ...chain('mouth', 'drive1', 'amp1', 'out')],
    mod: [{ from: 'env1', to: 'mouth.vowel', amount: -4 }],
  },
  {
    name: 'Vowel Pad', type: 'Pad', voices: 8, volume: 0.2,
    about: 'A choir-like pad that slowly sings through the vowels (ah, eh, ee, oh, oo and back) over four bars, locked to the tempo.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 3, spread: 12, level: 0.6 }), mod('osc', 'osc2', { wave: 'pulse', pw: 0.35, octave: -1, level: 0.3 }),
      mod('vowel', 'mouth', { vowel: 2, resonance: 8, mix: 0.85 }), mod('lfo', 'lfo1', { wave: 'triangle', sync: '4/1' }),
      mod('amp', 'amp1', { attack: 0.6, decay: 1, sustain: 0.9, release: 1.5 }),
      mod('chorus', 'chorus1', { rate: 0.4, depth: 0.6, mix: 0.4 }), mod('reverb', 'reverb1', { type: 'hall', size: 3.5, mix: 0.3 })],
    audio: [{ from: 'osc1', to: 'mouth' }, { from: 'osc2', to: 'mouth' }, ...chain('mouth', 'amp1', 'chorus1', 'reverb1', 'out')],
    mod: [{ from: 'lfo1', to: 'mouth.vowel', amount: 2 }],
  },
  {
    name: 'Jet Filter Chords', type: 'Keys', voices: 10, volume: 0.45,
    about: 'Disco Filter Chords with a jet-plane flanger sweeping over them; the filter opens and closes over four bars. The mod wheel opens it further.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 3, spread: 12, level: 0.55 }), mod('osc', 'osc2', { wave: 'square', octave: -1, level: 0.25 }),
      mod('filter', 'filter1', { cutoff: 900, resonance: 6, keytrack: 0.4 }), mod('lfo', 'lfo1', { wave: 'triangle', sync: '4/1' }),
      mod('amp', 'amp1', { attack: 0.005, decay: 0.3, sustain: 1, release: 0.15 }),
      mod('flanger', 'flanger1', { rate: 0.12, depth: 0.8, feedback: 0.7, mix: 0.5 }), mod('compressor', 'comp1', { threshold: -20, ratio: 3, gain: 3 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'flanger1', 'comp1', 'out')],
    mod: [{ from: 'lfo1', to: 'filter1.cutoff', amount: 2000 }, { from: 'wheel', to: 'filter1.cutoff', amount: 3600 }],
  },
  {
    name: 'Phased String Machine', type: 'Strings', voices: 12, volume: 0.6,
    about: 'Lush 70s ensemble strings swirled by a slow phaser: the disco string-machine sound. Hold chords.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 4, spread: 14, level: 0.6 }), mod('osc', 'osc2', { wave: 'saw', octave: 1, unison: 2, spread: 10, level: 0.25 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 3200, resonance: 0.8, keytrack: 0.4 }),
      mod('amp', 'amp1', { attack: 0.25, decay: 1, sustain: 0.9, release: 0.9 }),
      mod('chorus', 'ensemble', { rate: 0.7, depth: 0.7, mix: 0.5 }), mod('phaser', 'phaser1', { rate: 0.15, depth: 0.8, feedback: 0.5, mix: 0.5 }),
      mod('reverb', 'reverb1', { type: 'hall', size: 3, mix: 0.25 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'ensemble', 'phaser1', 'reverb1', 'out')],
  },
  {
    name: 'Wah Funk Guitar', type: 'Pluck', voices: 6, volume: 1,
    about: 'A clean electric through an auto-wah: each note sweeps open, harder playing sweeps further. For choppy sixteenth-note rhythm parts.',
    modules: [mod('string', 'str', { excite: 'pick', position: 0.09, brightness: 0.7, decay: 3, highs: 1, release: 0.06, velocity: 0.7, level: 0.9 }),
      mod('filter', 'wah', { type: 'bandpass', slope: '12', cutoff: 450, resonance: 7, keytrack: 0.3 }),
      mod('env', 'env1', { attack: 0.015, decay: 0.22, sustain: 0.2, release: 0.1, velocity: 0.7 }),
      mod('shaper', 'amp', { curve: 'soft', drive: 3, tone: 6000, mix: 1, level: 1.3 }), mod('reverb', 'room1', { type: 'room', size: 0.8, mix: 0.1 })],
    audio: chain('str', 'wah', 'amp', 'room1', 'out'),
    mod: [{ from: 'env1', to: 'wah.cutoff', amount: 2600 }],
  },

  // ---- electro ----
  {
    name: 'Electro Fuzz Bass', play: 'mono', type: 'Bass', voices: 2, volume: 0.6,
    about: 'Detuned saws driven into distortion and a little bitcrush: aggressive and mid-heavy, made to cut through. The filter snaps open on each note.',
    modules: [mod('osc', 'osc1', { wave: 'saw', octave: -1, unison: 3, spread: 15, level: 0.6 }), mod('osc', 'osc2', { wave: 'square', octave: -1, level: 0.35 }),
      mod('filter', 'filter1', { cutoff: 650, resonance: 4, keytrack: 0.4 }), mod('env', 'env1', { attack: 0.002, decay: 0.2, sustain: 0.25, release: 0.08 }),
      mod('amp', 'amp1', { attack: 0.002, decay: 0.3, sustain: 0.9, release: 0.06 }),
      mod('shaper', 'dist1', { curve: 'hard', drive: 16, tone: 4500, mix: 1, level: 0.45 }), mod('crusher', 'crush1', { bits: 8, hold: 2, mix: 0.3 }),
      mod('eq', 'eq1', { low: 2, mid: 4, midfreq: 1200, high: -2 }), mod('compressor', 'comp1', { threshold: -18, ratio: 4, gain: 2 }), LIMIT()],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'dist1', 'crush1', 'eq1', 'comp1', 'limit1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 3000 }],
  },
  {
    name: 'Big Supersaw Lead', type: 'Lead', voices: 8, volume: 1,
    about: 'Seven detuned saws plus five more an octave up, spread wide: the huge festival lead. Synced ping-pong echoes.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 7, spread: 30, level: 0.6 }), mod('osc', 'osc2', { wave: 'saw', octave: 1, unison: 5, spread: 20, level: 0.25 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 5500, resonance: 1, keytrack: 0.4 }),
      mod('amp', 'amp1', { attack: 0.01, decay: 0.4, sustain: 0.9, release: 0.3, level: 1 }),
      mod('delay', 'delay1', { mode: 'ping-pong', sync: '1/8', feedback: 0.3, tone: 4500, mix: 0.2 }), mod('reverb', 'reverb1', { type: 'plate', size: 2, mix: 0.18 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'reverb1', 'out')],
  },

  // ---- disco punk ----
  {
    name: 'Disco Punk Bass', play: 'mono', type: 'Bass', voices: 2, volume: 0.75,
    about: 'A punchy analog bass for driving eighth-note lines: saw and square through a 24 dB filter that snaps shut, slightly driven. Play harder to open it.',
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.65 }), mod('osc', 'osc2', { wave: 'square', octave: -1, level: 0.4 }),
      mod('filter', 'filter1', { cutoff: 480, resonance: 3, keytrack: 0.5 }), mod('env', 'env1', { attack: 0.002, decay: 0.18, sustain: 0.1, release: 0.06 }),
      mod('amp', 'amp1', { attack: 0.002, decay: 0.3, sustain: 0.65, release: 0.06 }), mod('drive', 'drive1', { amount: 0.35 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'drive1', 'amp1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 2600 }, { from: 'vel', to: 'filter1.cutoff', amount: 1200 }],
  },
  {
    name: 'Dance Punk Kit', type: 'Drums', voices: 16, volume: 0.75,
    about: 'A dry, tight drum machine in a small room: punchy kick, cracking snare, bright open hats, a loud cowbell, tambourine (Ride pad) and shaker (Pedal hat pad).',
    modules: [{ ...mod('drums', 'drums1', { tone: 0.6 }), pads: kitPads({
      36: { name: 'Kick', t1Level: 1.3, t1Wave: 'sine', t1Pitch: 55, t1Sweep: 22, t1Bend: 0.025, t1Decay: 0.32, t2Level: 0.6, t2Wave: 'triangle', t2Pitch: 110, t2Sweep: 12, t2Bend: 0.015, t2Decay: 0.05, click: 0.5, drive: 0.15 },
      38: { name: 'Snare', t1Level: 0.55, t1Wave: 'triangle', t1Pitch: 200, t1Sweep: 4, t1Bend: 0.02, t1Decay: 0.09, nLevel: 0.9, nFilter: 'highpass', nFreq: 1800, nDecay: 0.17, click: 0.4, level: 0.8 },
      39: { name: 'Clap', nLevel: 1.4, nFilter: 'bandpass', nFreq: 1200, nQ: 1.5, nDecay: 0.22, nBursts: 4 },
      42: { name: 'Closed hat', nLevel: 0.55, nFilter: 'highpass', nFreq: 8000, nDecay: 0.05, t1Level: 0.3, t1Wave: 'metal', t1Pitch: 330, t1Decay: 0.045, choke: 1 },
      44: { name: 'Shaker', nLevel: 0.45, nFilter: 'bandpass', nFreq: 6500, nQ: 1, nDecay: 0.07, choke: 0 },
      46: { name: 'Open hat', nLevel: 0.5, nFilter: 'highpass', nFreq: 7500, nDecay: 0.45, t1Level: 0.3, t1Wave: 'metal', t1Pitch: 330, t1Decay: 0.4, choke: 1 },
      51: { name: 'Tambourine', t1Level: 0.35, t1Wave: 'metal', t1Pitch: 1100, t1Decay: 0.18, nLevel: 0.5, nFilter: 'highpass', nFreq: 6000, nDecay: 0.16, nBursts: 2, hp: 3000 },
      // A struck cowbell (COWBELL, above) with a burst of noise for the stick, not the 808's squares.
      56: { name: 'Cowbell', t1Level: 0, t2Level: 0, nLevel: 0.3, nFilter: 'bandpass', nFreq: 3200, nQ: 1, nDecay: 0.025, click: 0.35,
        lSound: { name: 'Struck cowbell', patch: COWBELL }, lLevel: 0.45, lNote: 74, lHold: 0.05, lDecay: 0.6, hp: 300, level: 1 },
    }) },
      // Gentle glue only: a faster, harder compressor (and a limiter) squashed each hit's strike and
      // swelled its ring back up, which made the cowbell and the whole kit sound pumped and synthetic.
      mod('compressor', 'comp1', { threshold: -12, ratio: 2, attack: 0.03, release: 0.2, gain: 1 }), mod('reverb', 'room1', { type: 'room', size: 0.6, predelay: 5, damping: 0.6, mix: 0.08 })],
    audio: chain('drums1', 'comp1', 'room1', 'out'),
  },
  {
    name: 'Jet Hats', type: 'Drums', voices: 16, volume: 0.75,
    about: 'Hats, shaker and tambourine through a slowly sweeping flanger: put them on a second drum track over Dance Punk Kit (or any kit) for that swooshing disco top end.',
    modules: [{ ...mod('drums', 'drums1', { tone: 0.6 }), pads: kitPads({
      42: { name: 'Closed hat', nLevel: 0.55, nFilter: 'highpass', nFreq: 8000, nDecay: 0.05, t1Level: 0.3, t1Wave: 'metal', t1Pitch: 330, t1Decay: 0.045, choke: 1 },
      44: { name: 'Shaker', nLevel: 0.45, nFilter: 'bandpass', nFreq: 6500, nQ: 1, nDecay: 0.07, choke: 0 },
      46: { name: 'Open hat', nLevel: 0.5, nFilter: 'highpass', nFreq: 7500, nDecay: 0.45, t1Level: 0.3, t1Wave: 'metal', t1Pitch: 330, t1Decay: 0.4, choke: 1 },
      51: { name: 'Tambourine', t1Level: 0.35, t1Wave: 'metal', t1Pitch: 1100, t1Decay: 0.18, nLevel: 0.5, nFilter: 'highpass', nFreq: 6000, nDecay: 0.16, nBursts: 2, hp: 3000 },
      49: { name: 'Crash', nLevel: 0.4, nFilter: 'highpass', nFreq: 4500, nDecay: 1.4, t1Level: 0.2, t1Wave: 'metal', t1Pitch: 280, t1Decay: 1.2 },
    }) },
      mod('flanger', 'flanger1', { rate: 0.1, depth: 0.85, feedback: 0.6, mix: 0.6 })],
    audio: chain('drums1', 'flanger1', 'out'),
  },
  {
    name: 'Sync Sequence', type: 'Pluck', voices: 8, volume: 0.53,
    about: 'A tearing, sync-like sweep on every note (a sharp resonant filter swept fast), for long repeating sequences. Echoes on the dotted eighth.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 2, spread: 6, level: 0.6 }), mod('osc', 'osc2', { wave: 'pulse', pw: 0.25, octave: 1, level: 0.2 }),
      mod('filter', 'filter1', { cutoff: 500, resonance: 14, keytrack: 0.6 }), mod('env', 'env1', { attack: 0.001, decay: 0.25, sustain: 0.15, release: 0.1 }),
      mod('amp', 'amp1', { attack: 0.002, decay: 0.3, sustain: 0.4, release: 0.1 }),
      mod('delay', 'delay1', { sync: '1/8.', feedback: 0.35, tone: 4000, mix: 0.22 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 4800 }, { from: 'vel', to: 'filter1.cutoff', amount: 1200 }],
  },
  {
    name: 'Noise Riser', type: 'FX', voices: 2, volume: 1,
    about: 'Hold a note for a build-up: noise sweeping up for about four seconds, growing louder and faster-pulsing. Let go to drop.',
    modules: [mod('noise', 'noise1', { level: 1 }), mod('filter', 'filter1', { type: 'bandpass', slope: '12', cutoff: 300, resonance: 2, keytrack: 0 }),
      mod('env', 'env1', { attack: 4, decay: 1, sustain: 1, release: 0.5 }),
      mod('amp', 'amp1', { attack: 3.5, decay: 1, sustain: 1, release: 0.6, level: 1 }),
      mod('tremolo', 'trem1', { sync: '1/16', depth: 0.35 }), mod('reverb', 'reverb1', { type: 'hall', size: 3, mix: 0.3 })],
    audio: [...chain('noise1', 'filter1', 'amp1', 'trem1', 'reverb1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 6000 }],
  },

  // ---- new wave ----
  {
    name: 'Sequenced Octave Bass', type: 'Bass', voices: 2, volume: 0.85,
    about: 'A short, punchy bass made for sixteenth-note sequences jumping between octaves: square and saw, a quick filter blip on each note.',
    modules: [mod('osc', 'osc1', { wave: 'square', level: 0.55 }), mod('osc', 'osc2', { wave: 'saw', fine: 5, level: 0.4 }),
      mod('filter', 'filter1', { cutoff: 1100, resonance: 2, keytrack: 0.6 }), mod('env', 'env1', { attack: 0.001, decay: 0.12, sustain: 0.1, release: 0.05 }),
      mod('amp', 'amp1', { attack: 0.002, decay: 0.15, sustain: 0.5, release: 0.05, level: 1 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 1800 }],
  },
  {
    name: 'Tape Choir', volume: 0.65, type: 'Pad', voices: 6,
    about: 'A breathy sampled-choir pad, like the early sampling keyboards: a grain cloud of a sung "ah" with a little tape wobble.',
    modules: [mod('granular', 'gr1', { file: 'factory/Vowel Ah (C4).wav', root: 60, position: 0.4, spread: 0.15, scan: 0.02, size: 0.18, density: 32, jitter: 5, width: 0.7, level: 0.9 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 3500, resonance: 0.8, keytrack: 0.3 }),
      mod('amp', 'amp1', { attack: 0.35, decay: 1, sustain: 0.9, release: 1.2, level: 0.8 }), COMP(),
      mod('delay', 'tape1', { mode: 'tape', time: 0.03, feedback: 0, wobble: 0.6, mix: 0.4 }), mod('reverb', 'reverb1', { type: 'hall', size: 3, mix: 0.3 })],
    audio: chain('gr1', 'filter1', 'amp1', 'comp1', 'tape1', 'reverb1', 'out'),
  },
  {
    name: 'Syndrum Kit', type: 'Drums', voices: 16, volume: 0.9,
    about: 'Electronic drums with big falling pitches, the early-80s pad kit: every tom pad sweeps down, the kick and snare too. A plate gives them space.',
    modules: [{ ...mod('drums', 'drums1', { tone: 0.5 }), pads: kitPads({
      36: { name: 'Kick', t1Level: 1.3, t1Wave: 'sine', t1Pitch: 50, t1Sweep: 19, t1Bend: 0.06, t1Decay: 0.5, t2Level: 0, click: 0.3 },
      38: { name: 'Syn snare', t1Level: 0.6, t1Wave: 'triangle', t1Pitch: 210, t1Sweep: 12, t1Bend: 0.08, t1Decay: 0.18, nLevel: 0.8, nFilter: 'highpass', nFreq: 1500, nDecay: 0.25 },
      41: { name: 'Syndrum low', t1Level: 1, t1Wave: 'sine', t1Pitch: 80, t1Sweep: 19, t1Bend: 0.3, t1Decay: 0.6, nLevel: 0.1, nFilter: 'lowpass', nFreq: 2000, nDecay: 0.05 },
      43: { name: 'Syndrum 2', t1Level: 1, t1Wave: 'sine', t1Pitch: 100, t1Sweep: 17, t1Bend: 0.28, t1Decay: 0.55, nLevel: 0.1, nFilter: 'lowpass', nFreq: 2000, nDecay: 0.05 },
      45: { name: 'Syndrum 3', t1Level: 1, t1Wave: 'sine', t1Pitch: 125, t1Sweep: 15, t1Bend: 0.25, t1Decay: 0.5, nLevel: 0.1, nFilter: 'lowpass', nFreq: 2200, nDecay: 0.05 },
      47: { name: 'Syndrum 4', t1Level: 1, t1Wave: 'sine', t1Pitch: 155, t1Sweep: 14, t1Bend: 0.22, t1Decay: 0.45, nLevel: 0.1, nFilter: 'lowpass', nFreq: 2500, nDecay: 0.05 },
      48: { name: 'Syndrum 5', t1Level: 1, t1Wave: 'triangle', t1Pitch: 190, t1Sweep: 12, t1Bend: 0.2, t1Decay: 0.4, nLevel: 0.1, nFilter: 'lowpass', nFreq: 2800, nDecay: 0.05 },
      50: { name: 'Syndrum high', t1Level: 1, t1Wave: 'triangle', t1Pitch: 240, t1Sweep: 12, t1Bend: 0.18, t1Decay: 0.35, nLevel: 0.1, nFilter: 'lowpass', nFreq: 3000, nDecay: 0.05 },
      56: { name: 'Zap', t1Level: 0.6, t1Wave: 'square', t1Pitch: 300, t1Sweep: 36, t1Bend: 0.12, t1Decay: 0.2, level: 0.6 },
    }) },
      mod('reverb', 'plate1', { type: 'plate', size: 1.8, predelay: 15, mix: 0.18 }), LIMIT()],
    audio: chain('drums1', 'plate1', 'limit1', 'out'),
  },
  {
    name: 'DMX Kit', type: 'Drums', voices: 16, volume: 0.45,
    about: 'Crunchy early-sampler drum machine: tight kick, snappy snare, crisp hats and claps, all through 8-bit grit and a short room.',
    modules: [{ ...mod('drums', 'drums1', { tone: 0.55 }), pads: kitPads({
      36: { name: 'Kick', t1Level: 1.3, t1Wave: 'sine', t1Pitch: 58, t1Sweep: 20, t1Bend: 0.03, t1Decay: 0.28, t2Level: 0.5, t2Wave: 'triangle', t2Pitch: 120, t2Sweep: 12, t2Bend: 0.01, t2Decay: 0.04, click: 0, level: 1.1 },
      38: { name: 'Snare', t1Level: 0.6, t1Wave: 'triangle', t1Pitch: 190, t1Sweep: 5, t1Bend: 0.02, t1Decay: 0.1, nLevel: 0.9, nFilter: 'highpass', nFreq: 2000, nDecay: 0.16, click: 0.35, level: 0.8 },
      39: { name: 'Claps', nLevel: 1.4, nFilter: 'bandpass', nFreq: 1300, nQ: 1.3, nDecay: 0.2, nBursts: 3 },
      42: { name: 'Closed hat', nLevel: 0.6, nFilter: 'highpass', nFreq: 8500, nDecay: 0.04, choke: 1 },
      46: { name: 'Open hat', nLevel: 0.5, nFilter: 'highpass', nFreq: 7500, nDecay: 0.32, choke: 1 },
    }) },
      mod('crusher', 'crush1', { bits: 8, hold: 2, mix: 0.8 }), mod('eq', 'eq1', { low: 2, high: 1 }),
      mod('reverb', 'room1', { type: 'room', size: 0.5, mix: 0.08 }), LIMIT()],
    audio: chain('drums1', 'crush1', 'eq1', 'room1', 'limit1', 'out'),
  },
  {
    name: 'High Melodic Bass', type: 'Bass', voices: 4, volume: 0.75,
    about: 'A picked electric bass played up high as a lead, with chorus: melodic lines an octave or two above where a bass usually sits.',
    modules: [mod('string', 'str', { excite: 'pick', position: 0.12, brightness: 0.62, decay: 4, highs: 0.9, release: 0.1, velocity: 0.7, level: 1 }),
      mod('eq', 'tone', { low: 1, mid: 3, midfreq: 900, high: -2 }), mod('chorus', 'chorus1', { rate: 0.5, depth: 0.6, mix: 0.5 }),
      mod('compressor', 'comp', { threshold: -26, ratio: 6, attack: 0.003, gain: 6 }), mod('reverb', 'room1', { type: 'room', size: 1, mix: 0.12 })],
    audio: chain('str', 'tone', 'chorus1', 'comp', 'room1', 'out'),
  },

  // ---- indie electronic: fuzz guitars, gliding leads, steel ----
  {
    name: 'Twin Fuzz Lead', play: 'legato', glide: 0.03, type: 'Lead', voices: 1, volume: 0.55,
    about: 'A fuzzed lead guitar, double-tracked (two strings a few cents apart): sustaining melodic lines that slide when you play legato. Dotted-eighth echoes.',
    modules: [mod('string', 'str', { excite: 'pick', position: 0.1, brightness: 0.75, decay: 12, highs: 3, strings: 2, detune: 9, release: 0.12, velocity: 0.6, level: 0.9 }),
      mod('shaper', 'fuzz1', { curve: 'tube', drive: 18, tone: 3800, mix: 1, level: 0.55 }), mod('eq', 'cab', { low: 1, mid: 3, midfreq: 1000, high: -6 }),
      mod('chorus', 'double', { rate: 0.3, depth: 0.3, mix: 0.3 }), mod('delay', 'echo', { sync: '1/8.', feedback: 0.25, mix: 0.18 }), mod('reverb', 'room', { type: 'plate', size: 1.6, mix: 0.15 })],
    audio: chain('str', 'fuzz1', 'cab', 'double', 'echo', 'room', 'out'),
  },
  {
    name: 'Glide Mono Lead', play: 'legato', glide: 0.12, type: 'Lead', voices: 2, volume: 0.75,
    about: 'A smooth, round mono lead with long slides between legato notes and vibrato that fades in on held notes.',
    modules: [mod('osc', 'osc1', { wave: 'triangle', level: 0.7 }), mod('osc', 'osc2', { wave: 'saw', fine: 4, level: 0.3 }),
      mod('filter', 'filter1', { cutoff: 2600, resonance: 2, keytrack: 0.6 }), mod('lfo', 'vib', { rate: 5.5, delay: 0.4 }),
      mod('amp', 'amp1', { attack: 0.01, decay: 0.3, sustain: 0.9, release: 0.2 }), mod('delay', 'delay1', { sync: '1/4', feedback: 0.25, mix: 0.15 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'out')],
    mod: [{ from: 'vib', to: 'osc1.pitch', amount: 25 }, { from: 'vib', to: 'osc2.pitch', amount: 25 }],
  },
  {
    name: 'Steel Pluck', type: 'Bell', voices: 10, volume: 0.6,
    about: 'A bright, ringing steel-drum-like pluck: a quick metallic strike settling into a sweet tone.',
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 1.6, attack: 0.001, decay: 0.9, sustain: 0, release: 0.4, velocity: 0.5, level: 0.75 }),
      mod('fmop', 'op2', { ratio: 2, fine: 12, attack: 0.001, decay: 0.12, sustain: 0.15, release: 0.2, velocity: 0.8, level: 0.7 }),
      mod('reverb', 'reverb1', { type: 'plate', size: 1.5, mix: 0.2 })],
    audio: [{ from: 'op2', to: 'op1' }, ...chain('op1', 'reverb1', 'out')],
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

  // ---- ambient and cinematic (after Vangelis, Eno, Budd, Boards of Canada, Stars of the Lid,
  // Hiroshi Yoshimura, Tangerine Dream, Jon Hopkins, Aphex Twin's ambient works) ----
  {
    name: 'CS Brass', type: 'Brass', voices: 8, volume: 0.4,
    about: 'The swelling polyphonic brass of the big 70s-80s polysynths (think Vangelis on a CS-80): two detuned layers that bloom open over a quarter second; play harder for brighter. Mod wheel = vibrato, pitch bend for slides. A long hall.',
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -7, level: 0.55 }), mod('osc', 'osc2', { wave: 'pulse', pw: 0.4, fine: 7, level: 0.45 }),
      mod('lfo', 'pwm', { wave: 'triangle', rate: 0.3 }), mod('lfo', 'vib', { rate: 5.2, depth: 0 }),
      mod('filter', 'filter1', { cutoff: 600, resonance: 2, keytrack: 0.5 }), mod('env', 'env1', { attack: 0.25, decay: 1.9, sustain: 0.6, release: 1.2 }),
      mod('amp', 'amp1', { attack: 0.25, decay: 1.9, sustain: 0.8, release: 1.2, velocity: 0.5 }),
      mod('chorus', 'chorus1', { rate: 0.4, depth: 0.4, mix: 0.25 }), mod('reverb', 'hall1', { type: 'hall', size: 6, predelay: 30, damping: 0.5, mix: 0.35 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'chorus1', 'hall1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 2400 }, { from: 'vel', to: 'filter1.cutoff', amount: 1500 }, { from: 'pwm', to: 'osc2.pw', amount: 0.15 },
      { from: 'vib', to: 'osc1.pitch', amount: 30 }, { from: 'vib', to: 'osc2.pitch', amount: 30 }, { from: 'wheel', to: 'vib.depth', amount: 1 }],
  },
  {
    name: 'CS Strings', type: 'Strings', voices: 12, volume: 0.55,
    about: 'Warm, wide polysynth strings with a gentle vibrato and a long hall: slow chords that hang in the air.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 4, spread: 14, level: 0.6 }), mod('lfo', 'vib', { rate: 5.5, delay: 0.5 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 3000, resonance: 0.7, keytrack: 0.4 }),
      mod('amp', 'amp1', { attack: 0.7, decay: 1, sustain: 0.9, release: 2.5 }),
      mod('chorus', 'ensemble', { rate: 0.6, depth: 0.7, mix: 0.6 }), mod('reverb', 'hall1', { type: 'hall', size: 7, predelay: 40, mix: 0.4 })],
    audio: chain('osc1', 'filter1', 'amp1', 'ensemble', 'hall1', 'out'),
    mod: [{ from: 'vib', to: 'osc1.pitch', amount: 6 }],
  },
  {
    name: 'Memory Bells', type: 'Bell', voices: 10, volume: 0.95,
    about: 'Soft, slightly metallic bell tones (a sine ring-modulated a little out of tune) ringing into a huge hall with slow echoes.',
    modules: [mod('osc', 'osc1', { wave: 'sine', level: 0.8 }), mod('ring', 'ring1', { ratio: 2.76, mix: 0.45 }),
      mod('amp', 'amp1', { attack: 0.003, decay: 3.5, sustain: 0, release: 3, velocity: 0.6 }),
      mod('delay', 'echo1', { sync: '1/4.', feedback: 0.35, tone: 3500, mix: 0.2 }), mod('reverb', 'hall1', { type: 'hall', size: 8, predelay: 30, mix: 0.45 })],
    audio: chain('osc1', 'ring1', 'amp1', 'echo1', 'hall1', 'out'),
  },
  withFx('Felt Piano', { name: 'Airport Piano', type: 'Keys', volume: 0.4, drop: 'room',
    about: 'A soft felt piano for slow, sparse phrases, the airport-ambient way: long echoes and a long, dark hall. Leave space between notes.',
    fx: [mod('delay', 'echo1', { mode: 'tape', sync: '1/2', feedback: 0.45, tone: 2500, wobble: 0.3, mix: 0.25 }), mod('reverb', 'hall1', { type: 'hall', size: 7, predelay: 40, damping: 0.6, mix: 0.45 })] }),
  withFx('Felt Piano', { name: 'Halo Piano', type: 'Keys', volume: 0.4, drop: 'room',
    about: 'Soft piano notes that bloom into a shimmering octave-up halo: one note at a time, and let it ring.',
    fx: [mod('shimmer', 'shimmer1', { size: 6, shimmer: 0.6, tone: 6000, mix: 0.45 })] }),
  {
    name: 'Warped Tape Pad', type: 'Pad', voices: 8, volume: 0.6,
    about: 'A warm, hazy pad that drifts out of tune like an old tape: slow, irregular wow plus a little flutter, tuned slightly flat, softly lo-fi.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 2, spread: 8, fine: -25, level: 0.5 }), mod('osc', 'osc2', { wave: 'triangle', fine: -20, level: 0.5 }),
      mod('lfo', 'wow', { wave: 'random', rate: 0.7 }), mod('lfo', 'flutter', { rate: 6.5 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 1800, resonance: 0.8, keytrack: 0.4 }),
      mod('amp', 'amp1', { attack: 0.4, decay: 1, sustain: 0.9, release: 1.5 }),
      mod('crusher', 'crush1', { bits: 12, hold: 2, mix: 0.25 }), mod('chorus', 'chorus1', { rate: 0.3, depth: 0.6, mix: 0.4 }),
      mod('delay', 'tape1', { mode: 'tape', time: 0.35, feedback: 0.3, tone: 2200, wobble: 0.6, mix: 0.25 }), mod('reverb', 'hall1', { type: 'hall', size: 4, mix: 0.25 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'crush1', 'chorus1', 'tape1', 'hall1', 'out')],
    mod: [{ from: 'wow', to: 'osc1.pitch', amount: 18 }, { from: 'wow', to: 'osc2.pitch', amount: 18 }, { from: 'flutter', to: 'osc1.pitch', amount: 3 }, { from: 'flutter', to: 'osc2.pitch', amount: 3 }],
  },
  {
    name: 'Nostalgic Lead', play: 'legato', glide: 0.06, type: 'Lead', voices: 2, volume: 0.7,
    about: 'A soft, wobbly lead like a melody on a worn cassette: hollow square and triangle, drifting slightly out of tune, with tape echo.',
    modules: [mod('osc', 'osc1', { wave: 'square', fine: -15, level: 0.45 }), mod('osc', 'osc2', { wave: 'triangle', octave: 1, fine: -10, level: 0.3 }),
      mod('lfo', 'wow', { wave: 'random', rate: 0.8 }), mod('lfo', 'flutter', { rate: 7 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 2200, resonance: 1, keytrack: 0.5 }),
      mod('amp', 'amp1', { attack: 0.02, decay: 0.4, sustain: 0.85, release: 0.3 }),
      mod('delay', 'tape1', { mode: 'tape', sync: '1/8.', feedback: 0.35, tone: 2000, wobble: 0.6, mix: 0.25 }), mod('reverb', 'room1', { type: 'room', size: 1.5, mix: 0.15 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'tape1', 'room1', 'out')],
    mod: [{ from: 'wow', to: 'osc1.pitch', amount: 14 }, { from: 'wow', to: 'osc2.pitch', amount: 14 }, { from: 'flutter', to: 'osc1.pitch', amount: 3 }, { from: 'flutter', to: 'osc2.pitch', amount: 3 }],
  },
  {
    name: 'Slow Swell Drone', type: 'Pad', voices: 6, volume: 0.34,
    about: 'Hold a chord and it fades in over six seconds and keeps slowly changing (the filter breathing over twenty seconds), blooming upward through a shimmer reverb. Lets go just as slowly.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 3, spread: 10, level: 0.5 }), mod('osc', 'osc2', { wave: 'sine', octave: -1, level: 0.5 }),
      mod('filter', 'filter1', { cutoff: 900, resonance: 2, keytrack: 0.3 }), mod('lfo', 'breath', { wave: 'triangle', rate: 0.05 }),
      mod('amp', 'amp1', { attack: 6, decay: 2, sustain: 1, release: 6 }),
      mod('shimmer', 'shimmer1', { size: 8, shimmer: 0.7, tone: 5000, mix: 0.5 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'shimmer1', 'out')],
    mod: [{ from: 'breath', to: 'filter1.cutoff', amount: 1200 }],
  },
  {
    name: 'Environmental Marimba', type: 'Bell', voices: 12, volume: 0.9,
    about: 'A soft digital marimba with a long, airy tail, the gentle FM mallets of 80s Japanese environmental music. Sparse, repeating figures.',
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 0.8, attack: 0.002, decay: 0.7, sustain: 0, release: 0.5, velocity: 0.5, level: 0.8 }),
      mod('fmop', 'op2', { ratio: 4, attack: 0.001, decay: 0.05, sustain: 0, release: 0.05, velocity: 0.8, level: 0.6 }),
      mod('delay', 'echo1', { sync: '1/8.', feedback: 0.3, tone: 3000, mix: 0.2 }), mod('reverb', 'hall1', { type: 'hall', size: 4.5, predelay: 25, mix: 0.35 })],
    audio: [{ from: 'op2', to: 'op1' }, ...chain('op1', 'echo1', 'hall1', 'out')],
  },
  {
    name: 'Berlin Sequence', type: 'Bass', voices: 4, volume: 1,
    about: 'A pulsing sequencer bass for long repeating patterns, the 70s Berlin-school way: a resonant filter blip on every note, the cutoff drifting slowly over about fifteen seconds, synced echoes.',
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.6 }), mod('osc', 'osc2', { wave: 'square', octave: -1, level: 0.35 }),
      mod('filter', 'filter1', { cutoff: 450, resonance: 8, keytrack: 0.5 }), mod('env', 'env1', { attack: 0.002, decay: 0.15, sustain: 0.05, release: 0.08 }),
      mod('lfo', 'drift', { wave: 'triangle', rate: 0.07 }),
      mod('amp', 'amp1', { attack: 0.002, decay: 0.2, sustain: 0.4, release: 0.08, level: 1 }),
      mod('delay', 'echo1', { mode: 'ping-pong', sync: '1/8.', feedback: 0.35, tone: 3500, mix: 0.25 }), mod('reverb', 'hall1', { type: 'hall', size: 3, mix: 0.18 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'echo1', 'hall1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 3000 }, { from: 'drift', to: 'filter1.cutoff', amount: 1800 }],
  },
  {
    name: 'Shimmer Wash', volume: 0.8, type: 'Pad', voices: 6,
    about: 'A slowly evolving grain cloud of glass bells through a shimmer reverb that climbs an octave each pass: a bright, weightless wash.',
    modules: [mod('granular', 'gr1', { file: 'factory/Glass Bell (C5).wav', root: 72, position: 0.3, spread: 0.5, scan: 0.03, size: 0.2, density: 25, jitter: 8, width: 1, level: 0.9 }),
      mod('amp', 'amp1', { attack: 1.5, decay: 1, sustain: 0.9, release: 3, level: 0.8 }), COMP(),
      mod('shimmer', 'shimmer1', { size: 8, shimmer: 0.75, tone: 7000, mix: 0.55 })],
    audio: chain('gr1', 'amp1', 'comp1', 'shimmer1', 'out'),
  },
  {
    name: 'Dark Drone', type: 'Pad', voices: 4, volume: 0.52,
    about: 'Low, slowly beating tones two octaves down, the filter breathing over twelve seconds, into a vast dark hall. Hold one or two low notes.',
    modules: [mod('osc', 'osc1', { wave: 'sine', octave: -2, fine: -3, level: 0.6 }), mod('osc', 'osc2', { wave: 'triangle', octave: -1, fine: 4, level: 0.4 }),
      mod('osc', 'osc3', { wave: 'saw', octave: -1, fine: -6, level: 0.15 }),
      mod('filter', 'filter1', { cutoff: 450, resonance: 3, keytrack: 0.2 }), mod('lfo', 'breath', { wave: 'triangle', rate: 0.08 }),
      mod('amp', 'amp1', { attack: 4, decay: 2, sustain: 1, release: 5 }),
      mod('reverb', 'hall1', { type: 'hall', size: 9, predelay: 50, damping: 0.7, mix: 0.5 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, { from: 'osc3', to: 'filter1' }, ...chain('filter1', 'amp1', 'hall1', 'out')],
    mod: [{ from: 'breath', to: 'filter1.cutoff', amount: 700 }],
  },
  // ---- self-playing: hold a key and tempo-synced LFOs play a pattern (they start with the note, so
  // play on the beat). Square LFOs on pitch make the steps: each adds or takes away half an interval,
  // and the oscillator is tuned up by half of all of them, so the lowest step is the key you hold. The
  // square LFO's flat parts sit at ±0.848, not ±1 (the browser scales the wave so its overshoot at the
  // edges peaks at 1; measured), so an amount of 708 moves the pitch ±600 cents, 413 ±350, 177 ±150. A
  // 'rise' LFO with a negative amount starts each step loud (or bright) and lets it fall.
  {
    name: 'Octave Hopper', play: 'mono', type: 'Bass', voices: 2, volume: 0.6,
    about: 'Hold one key: it plays eighth notes hopping between that note and the octave above, each one plucked by the filter, which also opens over every bar. Follows the song\'s tempo.',
    modules: [mod('osc', 'osc1', { wave: 'saw', octave: -1, semi: 6, level: 0.7 }), mod('osc', 'osc2', { wave: 'square', octave: -1, semi: 6, level: 0.3 }),
      mod('filter', 'filter1', { cutoff: 520, resonance: 5, keytrack: 0.4 }),
      mod('lfo', 'hop', { wave: 'square', sync: '1/4' }), mod('lfo', 'pluck', { wave: 'rise', sync: '1/8' }), mod('lfo', 'bar', { wave: 'rise', sync: '1/1' }),
      mod('drive', 'drive1', { amount: 0.3 }), mod('amp', 'amp1', { attack: 0.003, decay: 0.2, sustain: 1, release: 0.08, level: 0.5 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'drive1', 'amp1', 'out')],
    mod: [{ from: 'hop', to: 'osc1.pitch', amount: -708 }, { from: 'hop', to: 'osc2.pitch', amount: -708 },
      { from: 'pluck', to: 'filter1.cutoff', amount: -1500 }, { from: 'pluck', to: 'amp1.level', amount: -0.3 }, { from: 'bar', to: 'filter1.cutoff', amount: 900 }],
  },
  {
    name: 'Staircase Sequence', play: 'mono', type: 'Pluck', voices: 2, volume: 0.6,
    about: 'Hold one key for an eight-step sixteenth-note pattern up a minor seventh chord: root, octave, fifth, fifth above, then the same from the minor third and seventh. Three square LFOs make it (an octave, a fifth and a minor third): change their amounts for other chords. Follows the tempo.',
    modules: [mod('osc', 'osc1', { wave: 'pulse', pw: 0.35, semi: 11, level: 0.6 }), mod('osc', 'osc2', { wave: 'saw', semi: 11, fine: 7, level: 0.35 }),
      mod('filter', 'filter1', { cutoff: 900, resonance: 4, keytrack: 0.5 }),
      mod('lfo', 'octave', { wave: 'square', sync: '1/8' }), mod('lfo', 'fifth', { wave: 'square', sync: '1/4' }), mod('lfo', 'third', { wave: 'square', sync: '1/2' }),
      mod('lfo', 'pluck', { wave: 'rise', sync: '1/16' }),
      mod('amp', 'amp1', { attack: 0.003, decay: 0.2, sustain: 1, release: 0.1, level: 0.45 }),
      mod('delay', 'delay1', { mode: 'ping-pong', sync: '1/8.', feedback: 0.35, tone: 3500, mix: 0.22 }), mod('reverb', 'reverb1', { type: 'plate', size: 1.6, mix: 0.12 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'reverb1', 'out')],
    mod: [...['osc1', 'osc2'].flatMap(o => [{ from: 'octave', to: `${o}.pitch`, amount: -708 }, { from: 'fifth', to: `${o}.pitch`, amount: -413 }, { from: 'third', to: `${o}.pitch`, amount: -177 }]),
      { from: 'pluck', to: 'filter1.cutoff', amount: -1800 }, { from: 'pluck', to: 'amp1.level', amount: -0.35 }],
  },
  {
    name: 'Computer Room', play: 'mono', type: 'FX', voices: 2, volume: 0.7,
    about: 'Hold a key: a 1960s mainframe thinking aloud. A random pitch on every sixteenth, up to an octave either side of the key, in a four-bar pattern that repeats (a new one each time Ostinato starts). Follows the tempo.',
    modules: [mod('osc', 'osc1', { wave: 'square', level: 0.5 }), mod('osc', 'osc2', { wave: 'sine', octave: 1, level: 0.3 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 2600, resonance: 4, keytrack: 1 }),
      mod('lfo', 'think', { wave: 'random', sync: '1/16' }), mod('lfo', 'blip', { wave: 'rise', sync: '1/16' }),
      mod('amp', 'amp1', { attack: 0.002, decay: 0.2, sustain: 1, release: 0.05, level: 0.45 }),
      mod('delay', 'delay1', { mode: 'ping-pong', sync: '1/8.', feedback: 0.3, tone: 5000, mix: 0.2 }), mod('reverb', 'reverb1', { type: 'room', size: 0.8, mix: 0.15 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'reverb1', 'out')],
    mod: [{ from: 'think', to: 'osc1.pitch', amount: 1200 }, { from: 'think', to: 'osc2.pitch', amount: 1200 }, { from: 'think', to: 'filter1.cutoff', amount: 1200 },
      { from: 'blip', to: 'amp1.level', amount: -0.4 }],
  },
  {
    name: 'Polyrhythm Chord', type: 'Pluck', voices: 8, volume: 0.6,
    about: 'Each note is three plucked tones repeating at different speeds (eighths, eighth triplets and dotted sixteenths), so a held chord ripples and never quite repeats. Follows the tempo.',
    modules: [mod('osc', 'osc1', { wave: 'triangle', level: 0.3 }), mod('osc', 'osc2', { wave: 'saw', octave: 1, level: 0.14 }), mod('osc', 'osc3', { wave: 'pulse', pw: 0.3, octave: -1, level: 0.18 }),
      mod('lfo', 'eighths', { wave: 'rise', sync: '1/8' }), mod('lfo', 'triplets', { wave: 'rise', sync: '1/8t' }), mod('lfo', 'dotted', { wave: 'rise', sync: '1/16.' }),
      mod('filter', 'filter1', { slope: '12', cutoff: 2600, resonance: 1, keytrack: 0.6 }),
      mod('amp', 'amp1', { attack: 0.004, decay: 0.3, sustain: 1, release: 0.5, velocity: 0.5 }),
      mod('chorus', 'chorus1', { rate: 0.4, mix: 0.25 }), mod('reverb', 'reverb1', { type: 'hall', size: 2.8, mix: 0.25 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, { from: 'osc3', to: 'filter1' }, ...chain('filter1', 'amp1', 'chorus1', 'reverb1', 'out')],
    mod: [{ from: 'dotted', to: 'osc1.level', amount: -0.3 }, { from: 'triplets', to: 'osc2.level', amount: -0.14 }, { from: 'eighths', to: 'osc3.level', amount: -0.18 }],
  },
  {
    name: 'Bouncing Ball', type: 'FX', voices: 6, volume: 0.6,
    about: 'Each note is dropped: it bounces, faster and quieter, for about five seconds. Not tied to the tempo.',
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 1.2, attack: 0.001, decay: 6, sustain: 0, release: 0.3, velocity: 0.6, level: 0.8 }),
      mod('fmop', 'op2', { ratio: 2.76, attack: 0.001, decay: 0.6, sustain: 0.2, release: 0.2, level: 0.5 }),
      mod('lfo', 'bounce', { wave: 'rise', rate: 2.2 }), mod('env', 'faster', { attack: 5, decay: 1, sustain: 1, release: 0.3 }),
      mod('reverb', 'reverb1', { type: 'room', size: 0.9, mix: 0.2 })],
    audio: [{ from: 'op2', to: 'op1' }, ...chain('op1', 'reverb1', 'out')],
    mod: [{ from: 'bounce', to: 'op1.level', amount: -0.4 }, { from: 'bounce', to: 'op1.fm', amount: -1.2 }, { from: 'faster', to: 'bounce.rate', amount: 16 }],
  },
  {
    name: 'Gate Pad', type: 'Pad', voices: 8, volume: 0.55,
    about: 'A wide supersaw chopped in time: a sixteenth-note gate crossed with a slower one three sixteenths long, so held chords get a rolling accent pattern. Follows the tempo.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 5, spread: 22, level: 0.6 }), mod('osc', 'osc2', { wave: 'saw', octave: -1, level: 0.25 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 3200, resonance: 1.5, keytrack: 0.5 }),
      mod('lfo', 'gate', { wave: 'square', sync: '1/8' }), mod('lfo', 'accent', { wave: 'square', sync: '1/4.' }), mod('lfo', 'sweep', { wave: 'triangle', sync: '4/1' }),
      mod('amp', 'amp1', { attack: 0.01, decay: 0.3, sustain: 1, release: 0.4, velocity: 0.3, level: 0.4 }),
      mod('delay', 'delay1', { mode: 'ping-pong', sync: '1/8.', feedback: 0.3, tone: 4000, mix: 0.2 }), mod('reverb', 'reverb1', { type: 'hall', size: 2.5, mix: 0.2 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'reverb1', 'out')],
    mod: [{ from: 'gate', to: 'amp1.level', amount: 0.25 }, { from: 'accent', to: 'amp1.level', amount: 0.15 }, { from: 'sweep', to: 'filter1.cutoff', amount: 1400 }],
  },

  // ---- more granular, from the second set of factory samples ----
  {
    name: 'Frozen Piano', volume: 1, type: 'Pad', voices: 6,
    about: 'A piano chord stopped in time: grains creep through the first moments after the strike, so a key holds the chord (transposed) for as long as you like.',
    modules: [mod('granular', 'gr1', { file: 'factory/Piano Chord (C4).wav', root: 60, position: 0.06, spread: 0.05, scan: 0.03, size: 0.28, density: 28, jitter: 4, width: 0.9, level: 0.9 }),
      mod('amp', 'amp1', { attack: 0.5, decay: 1, sustain: 1, release: 3, level: 0.8 }), COMP(), mod('reverb', 'reverb1', { type: 'hall', size: 5, mix: 0.35 })],
    audio: chain('gr1', 'amp1', 'comp1', 'reverb1', 'out'),
  },
  {
    name: 'Bowed Cloud', volume: 1, type: 'Strings', voices: 6,
    about: 'Many overlapping slices of one bowed note, each slightly out of tune with the rest: a string section made from a single player.',
    modules: [mod('granular', 'gr1', { file: 'factory/Bowed Note (C3).wav', root: 48, position: 0.5, spread: 0.5, scan: 0.02, size: 0.22, density: 36, jitter: 9, width: 1, level: 0.9 }),
      mod('amp', 'amp1', { attack: 0.7, decay: 1, sustain: 1, release: 1.8, level: 0.8 }), COMP(),
      mod('chorus', 'chorus1', { rate: 0.3, depth: 0.4, mix: 0.25 }), mod('reverb', 'reverb1', { type: 'hall', size: 3.5, mix: 0.3 })],
    audio: chain('gr1', 'amp1', 'comp1', 'chorus1', 'reverb1', 'out'),
  },
  {
    name: 'Slow Motion Voice', volume: 1, type: 'Pad', voices: 6,
    about: 'A voice moving through its vowels (ah, eh, ee, oh, oo) at an eighth of its speed, whatever key you play.',
    modules: [mod('granular', 'gr1', { file: 'factory/Vowel Phrase (C3).wav', root: 48, position: 0.02, spread: 0.02, scan: 0.125, size: 0.12, density: 40, jitter: 5, width: 0.7, level: 0.9 }),
      mod('amp', 'amp1', { attack: 0.3, decay: 1, sustain: 1, release: 1.5, level: 0.8 }), COMP(), mod('reverb', 'reverb1', { type: 'hall', size: 3.5, mix: 0.3 })],
    audio: chain('gr1', 'amp1', 'comp1', 'reverb1', 'out'),
  },
  {
    name: 'Speech Shards', volume: 0.75, type: 'FX', voices: 4,
    about: 'The same voice broken into tiny pieces taken from anywhere in the phrase and thrown up to a fifth up or down: chattering, like a crowd of small robots.',
    modules: [mod('granular', 'gr1', { file: 'factory/Vowel Phrase (C3).wav', root: 48, position: 0.5, spread: 1, scan: 0, size: 0.045, density: 22, jitter: 700, width: 1, level: 1 }),
      mod('amp', 'amp1', { attack: 0.02, decay: 0.5, sustain: 1, release: 0.6, level: 0.8 }), COMP(),
      mod('delay', 'delay1', { mode: 'ping-pong', time: 0.23, feedback: 0.4, tone: 4000, mix: 0.3 }), mod('reverb', 'reverb1', { type: 'room', size: 1.2, mix: 0.18 })],
    audio: chain('gr1', 'amp1', 'comp1', 'delay1', 'reverb1', 'out'),
  },
  {
    name: 'Beat Dust', volume: 1, type: 'FX', voices: 4,
    about: 'A two-bar drum loop (100 bpm) in grains: every key plays it at the same speed but a different pitch, C4 as recorded. Position (on the mod wheel in the Sound Lab) moves where it starts; raise Spread to grind it to dust, or set Scan to 0 to hold one moment.',
    modules: [mod('granular', 'gr1', { file: 'factory/Drum Loop (100 bpm).wav', root: 60, position: 0, spread: 0.012, scan: 1, size: 0.07, density: 45, jitter: 0, width: 0.5, level: 1 }),
      mod('amp', 'amp1', { attack: 0.005, decay: 0.5, sustain: 1, release: 0.3, level: 0.8 }), mod('crusher', 'crush1', { bits: 10, hold: 3, mix: 0.4 }), mod('compressor', 'limit1', { threshold: -10, ratio: 12, attack: 0.001, release: 0.1, gain: 5 })],
    audio: chain('gr1', 'amp1', 'crush1', 'limit1', 'out'),
    cc: { 1: 'gr1.position' },
  },
  {
    name: 'Time Stretch Keys', volume: 1, type: 'Bell', voices: 6,
    about: 'A music-box phrase that plays at the same speed on every key, only higher or lower: play chords and the phrase harmonises with itself.',
    modules: [mod('granular', 'gr1', { file: 'factory/Music Box Phrase (C5).wav', root: 72, position: 0, spread: 0.004, scan: 1, size: 0.09, density: 40, jitter: 0, width: 0.6, level: 0.9 }),
      mod('amp', 'amp1', { attack: 0.01, decay: 1, sustain: 1, release: 1.5, level: 0.8 }), COMP(), mod('reverb', 'reverb1', { type: 'plate', size: 2.5, mix: 0.25 })],
    audio: chain('gr1', 'amp1', 'comp1', 'reverb1', 'out'),
  },
  {
    name: 'Vinyl Dust', volume: 1, type: 'FX', voices: 2,
    about: 'Record crackle and hiss for as long as you hold a key, never repeating the same way. Put it on its own track under a song; higher keys are brighter.',
    modules: [mod('granular', 'gr1', { file: 'factory/Vinyl Crackle.wav', root: 60, position: 0.5, spread: 1, scan: 0.3, size: 0.4, density: 8, jitter: 60, width: 1, level: 1 }),
      mod('amp', 'amp1', { attack: 0.2, decay: 1, sustain: 1, release: 0.8, velocity: 0.3, level: 0.8 }),
      mod('compressor', 'gain1', { threshold: 0, ratio: 1, gain: 9 })], // only its make-up gain: crackle is quiet (a working compressor made the pops louder)
    audio: chain('gr1', 'amp1', 'gain1', 'out'),
  },
].map(cleanPatch);

// ---- arpeggiated: sounds above with the arpeggiator switched on (hold a chord) ----
const arped = (base, name, type, arp, about, extra = {}) => cleanPatch({ ...JSON.parse(JSON.stringify([...STARTERS, ...MORE, ...KEYS].find(p => p.name === base))), name, type, arp, about, ...extra });
const ARPS = [
  arped('Saw Arp', 'Climbing Saws', 'Pluck', { mode: 'up', rate: '1/16', octaves: 2, gate: 0.5 }, 'Hold a chord: its notes run upward in sixteenths over two octaves, again and again. Arp (beside Play) sets the direction, speed, octaves and how short the notes are.'),
  arped('Glass Arp', 'Glass Rain', 'Bell', { mode: 'random', rate: '1/16', octaves: 3, gate: 0.4 }, 'Hold a chord: its notes fall at random across three octaves, a glassy pluck on every sixteenth with a ping-pong echo.'),
  arped('Dub Chord', 'Chord Pulse', 'Keys', { mode: 'chord', rate: '1/8.', octaves: 1, gate: 0.35 }, 'Hold a chord: it stabs again every dotted eighth, into the echo.', { volume: 0.5 }),
  arped('Square Bass', 'Rolling Bass', 'Bass', { mode: 'up-down', rate: '1/16', octaves: 2, gate: 0.7 }, 'Hold one note for octaves in sixteenths, or two or three for a bass line that rolls up and back down.'),
  arped('Nylon Pluck', 'Thumb and Fingers', 'Pluck', { mode: 'played', rate: '1/8t', octaves: 1, gate: 0.9 }, 'Hold a chord: it plays the notes in the order you pressed them, in triplets, like a picked guitar pattern. Press the bass note first.'),
];

// ---- more drum kits (Nov 2026) ----
// Sounds for pads: small patches the kit plays as a hit (a pad's Sound layer).
const hitSound = (name, modules, audio, mods = []) => cleanPatch({ name, type: 'Drums', voices: 4, volume: 1, modules, audio, mod: mods });
// The CR-78's Metallic Beat: its three square oscillators (6170, 5620 and 4080 Hz), played at B6
// + 56 cents an octave up so the lowest is 4080 Hz.
const METALLIC = hitSound('Metallic beat', [mod('osc', 'osc1', { wave: 'square', octave: 1, fine: 56, level: 0.4 }), mod('osc', 'osc2', { wave: 'square', octave: 1, semi: 6, fine: 10, level: 0.4 }),
  mod('osc', 'osc3', { wave: 'square', octave: 1, semi: 7, fine: 72, level: 0.4 }), mod('amp', 'amp1', { attack: 0.001, decay: 0.135, sustain: 0, release: 0.135, velocity: 1, level: 1 })],
  [{ from: 'osc1', to: 'amp1' }, { from: 'osc2', to: 'amp1' }, { from: 'osc3', to: 'amp1' }, { from: 'amp1', to: 'out' }]);
// The CR-78's guiro: a buzz (its multivibrator: 125 Hz, or 77 for the low one, set by the pad's
// note) through a resonance at 6.1 kHz, switched on for a step and off again.
const GUIRO78 = hitSound('CR-78 guiro', [mod('osc', 'osc1', { wave: 'pulse', pw: 0.15, level: 1 }), mod('filter', 'tank', { type: 'bandpass', slope: '12', cutoff: 6126, resonance: 2.5, keytrack: 0 }),
  mod('amp', 'amp1', { attack: 0.002, decay: 0.2, sustain: 1, release: 0.01, velocity: 1, level: 1 })], chain('osc1', 'tank', 'amp1', 'out'));

// Roland's CompuRhythm CR-78 (1978). From Roland's service notes as read by the schwung-cw-78 clone
// project (github.com/charlesvestal/schwung-cw-78, docs/CR78-CIRCUIT-ANALYSIS.md): the factory
// alignment table's frequencies and levels, and LC values from the schematic. The drums are
// ringing resonators with no pitch sweep (bass drum 62.5 Hz, snare 340, low conga 208, bongos 400
// and 600, rim shot 1480, claves 2630, cowbell 555 + 800); cymbal and tambourine are noise through
// tuned coils (9.1 and ~4.7 kHz); the guiro and Metallic Beat are above. Decays: the table gives a
// length per voice without saying how far down; the snare's scope note (0.7 V falling to 0.4 V in
// 20 ms) puts its 60 ms at about -15 dB, so every pad's Decay (the time to -66 dB) is 4.5 x the
// table's. ASSUMED, no number found: the bands of the snare's noise, hi-hat and maracas, and the
// cowbell's wave. The machine has no clap, open hat or toms; pads are named for what they play.
const CR78 = {
  name: 'CR-78 Kit', type: 'Drums', voices: 16, volume: 0.9,
  about: 'After Roland\'s CR-78 (1978), from its service notes: soft thudding bass drum, snare, rim shot, hi-hat, cymbal, maracas, claves, cowbell, bongos, low conga, tambourine, guiro (two pads, high and low) and the Metallic Beat. Dry and quiet-mannered, as the machine is. Its hi-hat, maracas and snare-noise tone are my estimates.',
  modules: [{ ...mod('drums', 'drums1', { tone: 0.5 }), pads: kitPads({
    36: { name: 'Bass drum', t1Level: 1, t1Wave: 'sine', t1Pitch: 62.5, t1Sweep: 0, t1Decay: 0.45, t2Level: 0, nLevel: 0, click: 0.05 },
    38: { name: 'Snare', t1Level: 0.6, t1Wave: 'sine', t1Pitch: 340, t1Sweep: 0, t1Decay: 0.27, t2Level: 0, nLevel: 0.5, nFilter: 'highpass', nFreq: 3000, nQ: 0.7, nDecay: 0.27, level: 0.78 },
    37: { name: 'Rim shot', level: 1.3, t1Level: 1.5, t1Wave: 'sine', t1Pitch: 1480, t1Sweep: 0, t1Decay: 0.023, t2Level: 0, nLevel: 0, click: 0.1 },
    39: { name: 'Tambourine', level: 1.15, t1Level: 0, nLevel: 1.5, nFilter: 'bandpass', nFreq: 4700, nQ: 5, nDecay: 1, nBursts: 1 },
    42: { name: 'Hi-hat', level: 1.23, t1Level: 0, nLevel: 0.6, nFilter: 'highpass', nFreq: 7000, nQ: 0.7, nDecay: 0.27, choke: 0 },
    44: { name: 'Maracas', level: 1.43, t1Level: 0, nLevel: 0.6, nFilter: 'highpass', nFreq: 6000, nQ: 0.7, nDecay: 0.09, choke: 0 },
    46: { name: 'Metallic beat', t1Level: 0, nLevel: 0, lSound: { name: 'Metallic beat', patch: METALLIC }, lLevel: 1, level: 0.67, lNote: 95, lHold: 0.02, lDecay: 2, choke: 0 },
    49: { name: 'Cymbal', level: 1.1, t1Level: 0, nLevel: 1.2, nFilter: 'bandpass', nFreq: 9098, nQ: 2, nDecay: 1.6 },
    51: { name: 'Claves', level: 0.75, t1Level: 0.5, t1Wave: 'sine', t1Pitch: 2630, t1Sweep: 0, t1Decay: 0.08, t2Level: 0, nLevel: 0 },
    56: { name: 'Cowbell', level: 0.47, t1Level: 0.3, t1Wave: 'square', t1Pitch: 555, t1Sweep: 0, t1Decay: 0.27, t2Level: 0.3, t2Wave: 'square', t2Pitch: 800, t2Sweep: 0, t2Decay: 0.27, hp: 500 },
    41: { name: 'Low conga', level: 0.91, t1Level: 0.8, t1Wave: 'sine', t1Pitch: 208, t1Sweep: 0, t1Decay: 0.68, nLevel: 0 },
    43: { name: 'Low bongo', level: 0.76, t1Level: 0.5, t1Wave: 'sine', t1Pitch: 400, t1Sweep: 0, t1Decay: 0.18, nLevel: 0 },
    45: { name: 'High bongo', level: 0.74, t1Level: 0.5, t1Wave: 'sine', t1Pitch: 600, t1Sweep: 0, t1Decay: 0.18, nLevel: 0 },
    47: { name: 'Guiro low', t1Level: 0, nLevel: 0, lSound: { name: 'CR-78 guiro', patch: GUIRO78 }, level: 0.8, lLevel: 1.5, lNote: 39, lHold: 0.11, lDecay: 0.5 },
    48: { name: 'Guiro high', t1Level: 0, nLevel: 0, lSound: { name: 'CR-78 guiro', patch: GUIRO78 }, level: 0.8, lLevel: 1.5, lNote: 47, lHold: 0.11, lDecay: 0.5 },
    50: { name: 'Tambourine soft', level: 1.15, t1Level: 0, nLevel: 0.75, nFilter: 'bandpass', nFreq: 4700, nQ: 5, nDecay: 0.7 },
  }) }],
  audio: [{ from: 'drums1', to: 'out' }],
};
// ---- Latin percussion ----
// Targets, where published numbers exist: congas at players' usual tunings (tumba D3 147 Hz, conga
// about G#3 208, quinto C#4 277) and bongos (hembra about 320, macho 587), each with the second
// membrane mode at 1.594 x (Rossing); maracas, cabasa, shaker and tambourine from Perry Cook's
// shaker models (STK Shakers.cpp: maracas a 3.2 kHz resonance about 570 Hz wide, 23 ms time
// constant; cabasa 3 kHz, very broad, 8 ms; shaker 5.5 kHz, broad, 23 ms; tambourine jingles
// 5.6 and 8.1 kHz); guiro resonances 2.5 and 4 kHz (the same models); the cowbell is the struck
// one above (587 + 845 Hz, Sound On Sound). ESTIMATES, no measurement found: how long the drums
// ring, the conga slap, timbales, claves (2.5 kHz), triangle and the guiro's ridge rate (70 a second).
const lcDrum = (name, f, decay, o = {}) => ({ name, t1Level: 1, t1Wave: 'sine', t1Pitch: f, t1Sweep: 1, t1Bend: 0.03, t1Decay: decay,
  t2Level: 0.25, t2Wave: 'sine', t2Pitch: Math.round(f * 1.594), t2Sweep: 1, t2Bend: 0.03, t2Decay: decay * 0.4,
  nLevel: 0.1, nFilter: 'lowpass', nFreq: 2500, nQ: 0.7, nDecay: 0.04, nBursts: 1, click: 0.15, choke: 0, hp: 20, ...o });
// A scrape: each ridge is a pulse (the pad's note sets how many a second: C#2 = 69) ringing the
// gourd's two resonances, with a little noise for the stick.
const GUIRO = hitSound('Guiro scrape', [mod('osc', 'osc1', { wave: 'pulse', pw: 0.1, level: 1 }), mod('noise', 'noise1', { level: 0.15 }),
  mod('filter', 'res1', { type: 'bandpass', slope: '12', cutoff: 2500, resonance: 6, keytrack: 0 }), mod('filter', 'res2', { type: 'bandpass', slope: '12', cutoff: 4000, resonance: 9.5, keytrack: 0 }),
  mod('amp', 'amp1', { attack: 0.03, decay: 0.3, sustain: 0.8, release: 0.02, velocity: 1, level: 1 })],
  [{ from: 'osc1', to: 'res1' }, { from: 'osc1', to: 'res2' }, { from: 'noise1', to: 'res1' }, { from: 'noise1', to: 'res2' }, { from: 'res1', to: 'amp1' }, { from: 'res2', to: 'amp1' }, { from: 'amp1', to: 'out' }]);
const LATIN = {
  name: 'Latin Percussion', type: 'Drums', voices: 16, volume: 0.8,
  about: 'Hand drums and shaken things, synthesized: three congas (tumba, conga, quinto) and a slap, two bongos, two timbales, claves, cowbell, guiro, maracas, cabasa, shaker, tambourine and triangle. Drum tunings and the shakers follow published numbers; how long the drums ring, the slap, timbales, claves and triangle are my estimates.',
  modules: [{ ...mod('drums', 'drums1', { tone: 0.5 }), pads: kitPads({
    36: lcDrum('Tumba', 147, 0.7),
    38: lcDrum('Conga', 208, 0.55),
    41: lcDrum('Quinto', 277, 0.45),
    39: { name: 'Conga slap', level: 1.5, t1Level: 0.5, t1Wave: 'triangle', t1Pitch: 420, t1Sweep: 2, t1Bend: 0.02, t1Decay: 0.08, t2Level: 0, nLevel: 1, nFilter: 'bandpass', nFreq: 2800, nQ: 0.8, nDecay: 0.06, nBursts: 1, click: 0.5 },
    43: lcDrum('Bongo low', 320, 0.25, { click: 0.25 }),
    45: lcDrum('Bongo high', 587, 0.18, { click: 0.25 }),
    47: lcDrum('Timbale low', 220, 0.5, { t1Sweep: 2, t1Bend: 0.04, t2Wave: 'triangle', t2Pitch: 470, t2Level: 0.2, t2Decay: 0.3, nLevel: 0.2, nFilter: 'highpass', nFreq: 3000, nDecay: 0.05, click: 0.4 }),
    48: lcDrum('Timbale high', 330, 0.4, { t1Sweep: 2, t1Bend: 0.04, t2Wave: 'triangle', t2Pitch: 705, t2Level: 0.2, t2Decay: 0.25, nLevel: 0.2, nFilter: 'highpass', nFreq: 3000, nDecay: 0.05, click: 0.4 }),
    37: { name: 'Claves', t1Level: 0.6, t1Wave: 'sine', t1Pitch: 2500, t1Sweep: 0, t1Decay: 0.09, t2Level: 0.12, t2Wave: 'sine', t2Pitch: 6900, t2Sweep: 0, t2Decay: 0.03, nLevel: 0, click: 0.1 },
    56: { name: 'Cowbell', t1Level: 0, t2Level: 0, nLevel: 0, lSound: { name: 'Struck cowbell', patch: COWBELL }, lLevel: 0.5, lNote: 74, lHold: 0.05, lDecay: 0.6, hp: 300 },
    50: { name: 'Guiro', t1Level: 0, nLevel: 0, lSound: { name: 'Guiro scrape', patch: GUIRO }, lLevel: 1.5, lNote: 37, lHold: 0.22, lDecay: 1, level: 1.5 },
    46: { name: 'Maracas', level: 1.5, t1Level: 0, nLevel: 1.5, nFilter: 'bandpass', nFreq: 3200, nQ: 5.6, nDecay: 0.175, nBursts: 1, choke: 0 },
    44: { name: 'Cabasa', level: 1.3, t1Level: 0, nLevel: 1.4, nFilter: 'bandpass', nFreq: 3000, nQ: 0.5, nDecay: 0.061, nBursts: 1, choke: 0 },
    42: { name: 'Shaker', level: 1.3, t1Level: 0, nLevel: 1.2, nFilter: 'bandpass', nFreq: 5500, nQ: 0.5, nDecay: 0.175, nBursts: 1, choke: 0 },
    49: { name: 'Tambourine', level: 1.4, t1Level: 0, nLevel: 1.2, nFilter: 'bandpass', nFreq: 6800, nQ: 1.2, nDecay: 0.2, nBursts: 2, click: 0.2 },
    51: { name: 'Triangle', t1Level: 0.35, t1Wave: 'sine', t1Pitch: 4350, t1Sweep: 0, t1Decay: 2.5, t2Level: 0.2, t2Wave: 'sine', t2Pitch: 6900, t2Sweep: 0, t2Decay: 1.5, nLevel: 0, click: 0.2 },
  }) }, mod('reverb', 'reverb1', { type: 'room', size: 0.6, mix: 0.08 })],
  audio: chain('drums1', 'reverb1', 'out'),
};

// ---- a quiet acoustic set, played with brushes ----
// Targets, where published numbers exist: toms at tune-bot's four-tom fundamentals (16" 73.4 Hz,
// 14" 98, 12" 124, 10" 147), each starting about 8% (1.3 semitones) sharp and settling within
// 0.2 s (measured on a 33 cm tom) with the second membrane mode at 1.594 x; a 20" bass drum at
// 66 Hz, falling two semitones, with its next partial about 1.86 x up (Sound On Sound; tune-bot);
// the snare's two lowest modes at 180 and 330 Hz (Rossing; SOS); cymbals after the published
// picture of a struck cymbal: energy near 700-1000 Hz in the first 20 ms, a 3-5 kHz shimmer for
// about a second, the highs dying first to leave a few hundred hertz. ESTIMATES, nothing found:
// every ring time, the snare wires' band, the brush tap and sweep, the rim click, hi-hats, ride bell.
const SWISH = hitSound('Brush sweep', [mod('noise', 'noise1', { level: 0.8 }), mod('filter', 'filter1', { type: 'bandpass', slope: '12', cutoff: 4200, resonance: 0.7, keytrack: 0 }),
  mod('amp', 'amp1', { attack: 0.09, decay: 0.3, sustain: 0, release: 0.12, velocity: 1, level: 1 })], chain('noise1', 'filter1', 'amp1', 'out'));
// A crash's wash: noise whose highs die first (a low-pass falling from about 9 kHz to 700 Hz over
// the ring), as a struck cymbal's do. Two decaying layers at fixed tones got brighter as they faded.
const WASH = hitSound('Cymbal wash', [mod('noise', 'noise1', { level: 0.9 }), mod('filter', 'filter1', { type: 'lowpass', slope: '12', cutoff: 700, resonance: 0.7, keytrack: 0 }),
  mod('env', 'close', { attack: 0.001, decay: 5, sustain: 0, release: 5 }), mod('amp', 'amp1', { attack: 0.004, decay: 6, sustain: 0, release: 6, velocity: 1, level: 1 })],
  chain('noise1', 'filter1', 'amp1', 'out'), [{ from: 'close', to: 'filter1.cutoff', amount: 4400 }]);
const bTom = (name, f, decay) => ({ name, t1Level: 1, t1Wave: 'sine', t1Pitch: f, t1Sweep: 1.3, t1Bend: 0.2, t1Decay: decay,
  t2Level: 0.3, t2Wave: 'sine', t2Pitch: Math.round(f * 1.594), t2Sweep: 1.3, t2Bend: 0.2, t2Decay: decay * 0.45,
  nLevel: 0.12, nFilter: 'lowpass', nFreq: 1500, nQ: 0.7, nDecay: 0.04, click: 0.2 });
const bSnare = (name, o = {}) => ({ name, t1Level: 0.35, t1Wave: 'sine', t1Pitch: 180, t1Sweep: 1, t1Bend: 0.03, t1Decay: 0.12, t2Level: 0.25, t2Wave: 'sine', t2Pitch: 330, t2Sweep: 1, t2Bend: 0.03, t2Decay: 0.08,
  nLevel: 0.8, nFilter: 'bandpass', nFreq: 4500, nQ: 0.6, nDecay: 0.22, nBursts: 1, click: 0.1, ...o });
const BRUSH = {
  name: 'Brush Kit', type: 'Drums', voices: 16, volume: 0.8,
  about: 'A quiet acoustic set played with brushes, synthesized: soft bass drum, brush taps and a sweep (Clap pad) on the snare, rim click, hi-hats, four toms, ride with its bell, crash. The drums\' pitches and the cymbals\' behaviour follow published numbers; the brush sounds, ring times and hi-hats are my estimates, so judge it by ear.',
  modules: [{ ...mod('drums', 'drums1', { tone: 0.5 }), pads: kitPads({
    36: { name: 'Bass drum', t1Level: 1.2, t1Wave: 'sine', t1Pitch: 66, t1Sweep: 2, t1Bend: 0.08, t1Decay: 0.5, t2Level: 0.35, t2Wave: 'sine', t2Pitch: 123, t2Sweep: 2, t2Bend: 0.08, t2Decay: 0.2,
      nLevel: 0.3, nFilter: 'lowpass', nFreq: 900, nQ: 0.7, nDecay: 0.05, click: 0.15 },
    38: bSnare('Brush tap'),
    56: bSnare('Ghost tap', { level: 0.45, nDecay: 0.14, click: 0 }),
    50: bSnare('Snare, stick', { level: 0.7, t1Level: 0.6, t2Level: 0.4, nLevel: 1.1, nFilter: 'highpass', nFreq: 2500, nQ: 0.7, nDecay: 0.2, click: 0.5 }),
    39: { name: 'Brush sweep', t1Level: 0, nLevel: 0, lSound: { name: 'Brush sweep', patch: SWISH }, lLevel: 1.2, lNote: 60, lHold: 0.25, lDecay: 1 },
    37: { name: 'Rim click', t1Level: 0.6, t1Wave: 'sine', t1Pitch: 780, t1Sweep: 0, t1Decay: 0.05, t2Level: 0.15, t2Wave: 'square', t2Pitch: 1850, t2Sweep: 0, t2Decay: 0.02, nLevel: 0, click: 0.5 },
    42: { name: 'Closed hat', level: 1.4, t1Level: 0.5, t1Wave: 'metal', t1Pitch: 400, t1Sweep: 0, t1Decay: 0.07, nLevel: 0.4, nFilter: 'highpass', nFreq: 6500, nDecay: 0.06, hp: 3000, choke: 1 },
    44: { name: 'Pedal hat', level: 1.4, t1Level: 0.35, t1Wave: 'metal', t1Pitch: 400, t1Sweep: 0, t1Decay: 0.045, nLevel: 0.3, nFilter: 'highpass', nFreq: 6000, nDecay: 0.04, click: 0.3, hp: 2500, choke: 1 },
    46: { name: 'Open hat', t1Level: 0.5, t1Wave: 'metal', t1Pitch: 400, t1Sweep: 0, t1Decay: 0.9, nLevel: 0.4, nFilter: 'highpass', nFreq: 6000, nDecay: 0.7, hp: 2500, choke: 1 },
    41: bTom('Floor tom', 73.4, 0.9), 43: bTom('Low tom', 98, 0.75), 45: bTom('Mid tom', 124, 0.6), 47: bTom('High tom', 147, 0.5),
    48: { name: 'Ride bell', t1Level: 0.5, t1Wave: 'metal', t1Pitch: 520, t1Sweep: 0, t1Decay: 3, t2Level: 0.12, t2Wave: 'sine', t2Pitch: 2100, t2Sweep: 0, t2Decay: 3, nLevel: 0, click: 0.3, hp: 600 },
    51: { name: 'Ride', t1Level: 0.35, t1Wave: 'metal', t1Pitch: 380, t1Sweep: 0, t1Decay: 4, t2Level: 0, nLevel: 0.3, nFilter: 'bandpass', nFreq: 4000, nQ: 0.5, nDecay: 2.5, click: 0.35, hp: 800 },
    49: { name: 'Crash', t1Level: 0.35, t1Wave: 'metal', t1Pitch: 300, t1Sweep: 0, t1Decay: 0.5, t2Level: 0, nLevel: 0, lSound: { name: 'Cymbal wash', patch: WASH }, lLevel: 1, level: 0.8, lNote: 60, lHold: 0.05, lDecay: 8, hp: 300 },
  }) }, mod('reverb', 'reverb1', { type: 'room', size: 0.7, mix: 0.12 })],
  audio: chain('drums1', 'reverb1', 'out'),
};

// ---- things on a kitchen table (not after any measurements: impressions) ----
const DROP = hitSound('Water drop', [mod('osc', 'osc1', { wave: 'sine', level: 0.8 }), mod('env', 'up', { attack: 0.05, decay: 0.05, sustain: 1, release: 0.05 }),
  mod('amp', 'amp1', { attack: 0.002, decay: 0.09, sustain: 0, release: 0.05, velocity: 1, level: 1 })], chain('osc1', 'amp1', 'out'), [{ from: 'up', to: 'osc1.pitch', amount: 1500 }]);
const ZIP = hitSound('Zip', [mod('osc', 'osc1', { wave: 'pulse', pw: 0.12, level: 0.8 }), mod('env', 'up', { attack: 0.16, decay: 0.05, sustain: 1, release: 0.05 }),
  mod('filter', 'filter1', { type: 'bandpass', slope: '12', cutoff: 3500, resonance: 2, keytrack: 0 }), mod('amp', 'amp1', { attack: 0.005, decay: 0.3, sustain: 0.8, release: 0.01, velocity: 1, level: 1 })],
  chain('osc1', 'filter1', 'amp1', 'out'), [{ from: 'up', to: 'osc1.pitch', amount: 1900 }]);
const FOUND = {
  name: 'Kitchen Table Kit', type: 'Drums', voices: 16, volume: 0.8,
  about: 'A kit of things within reach: a cardboard box for the kick, a book slapped shut for the snare, a pen click, torn paper, a matchbox, a jar of rice, keys, a pot lid, knocks on the table, a mug, a glass, a bottle blown across the top, a water drop, a tin can, a bowl and a zip. Impressions made from tones and noise, not recordings.',
  modules: [{ ...mod('drums', 'drums1', { tone: 0.5 }), pads: kitPads({
    36: { name: 'Box', t1Level: 1.3, t1Wave: 'sine', t1Pitch: 75, t1Sweep: 7, t1Bend: 0.03, t1Decay: 0.22, t2Level: 0, nLevel: 0.6, nFilter: 'lowpass', nFreq: 400, nQ: 0.7, nDecay: 0.08, click: 0.1 },
    37: { name: 'Pen click', t1Level: 0.3, t1Wave: 'square', t1Pitch: 3200, t1Sweep: 0, t1Decay: 0.012, t2Level: 0, nLevel: 0, click: 1, hp: 1500 },
    38: { name: 'Book', t1Level: 0.4, t1Wave: 'triangle', t1Pitch: 210, t1Sweep: 2, t1Bend: 0.02, t1Decay: 0.05, t2Level: 0, nLevel: 1.2, nFilter: 'bandpass', nFreq: 1100, nQ: 0.7, nDecay: 0.11, nBursts: 1, click: 0.5 },
    39: { name: 'Paper rip', t1Level: 0, nLevel: 0.9, nFilter: 'highpass', nFreq: 3500, nQ: 0.7, nDecay: 0.2, nBursts: 4 },
    42: { name: 'Matchbox', level: 1.4, t1Level: 0, nLevel: 0.9, nFilter: 'bandpass', nFreq: 4800, nQ: 1.5, nDecay: 0.05, nBursts: 2, choke: 0 },
    44: { name: 'Rice jar', level: 1.4, t1Level: 0, nLevel: 0.7, nFilter: 'bandpass', nFreq: 7000, nQ: 0.8, nDecay: 0.09, nBursts: 1, choke: 0 },
    46: { name: 'Keys', t1Level: 0.6, t1Wave: 'metal', t1Pitch: 1400, t1Sweep: 0, t1Decay: 0.5, t2Level: 0, nLevel: 0.2, nFilter: 'highpass', nFreq: 8000, nDecay: 0.2, nBursts: 3, hp: 4000, choke: 0 },
    49: { name: 'Pot lid', level: 0.75, t1Level: 0.6, t1Wave: 'metal', t1Pitch: 310, t1Sweep: 0, t1Decay: 1.8, t2Level: 0.15, t2Wave: 'sine', t2Pitch: 1240, t2Sweep: 0, t2Decay: 1.2, nLevel: 0, click: 0.3, hp: 300 },
    41: { name: 'Table knock', t1Level: 1, t1Wave: 'sine', t1Pitch: 140, t1Sweep: 3, t1Bend: 0.02, t1Decay: 0.12, t2Level: 0, nLevel: 0.3, nFilter: 'lowpass', nFreq: 900, nQ: 0.7, nDecay: 0.03, click: 0.4 },
    43: { name: 'Mug', t1Level: 0.5, t1Wave: 'sine', t1Pitch: 1180, t1Sweep: 0, t1Decay: 0.5, t2Level: 0.2, t2Wave: 'sine', t2Pitch: 2950, t2Sweep: 0, t2Decay: 0.25, nLevel: 0, click: 0.2 },
    45: { name: 'Glass', t1Level: 0.45, t1Wave: 'sine', t1Pitch: 2100, t1Sweep: 0, t1Decay: 1.1, t2Level: 0.15, t2Wave: 'sine', t2Pitch: 5400, t2Sweep: 0, t2Decay: 0.5, nLevel: 0, click: 0.15 },
    47: { name: 'Bottle', t1Level: 0.6, t1Wave: 'sine', t1Pitch: 330, t1Sweep: 0, t1Decay: 0.5, t2Level: 0, nLevel: 0.9, nFilter: 'bandpass', nFreq: 330, nQ: 8, nDecay: 0.4 },
    48: { name: 'Water drop', t1Level: 0, nLevel: 0, lSound: { name: 'Water drop', patch: DROP }, lLevel: 1, lNote: 84, lHold: 0.05, lDecay: 0.5 },
    50: { name: 'Tin can', t1Level: 0.3, t1Wave: 'square', t1Pitch: 720, t1Sweep: 0, t1Decay: 0.1, t2Level: 0.25, t2Wave: 'square', t2Pitch: 1130, t2Sweep: 0, t2Decay: 0.08, nLevel: 0.3, nFilter: 'bandpass', nFreq: 2600, nQ: 3, nDecay: 0.06, hp: 400 },
    51: { name: 'Bowl', t1Level: 0.5, t1Wave: 'sine', t1Pitch: 640, t1Sweep: 0, t1Decay: 1.4, t2Level: 0.2, t2Wave: 'sine', t2Pitch: 1790, t2Sweep: 0, t2Decay: 0.8, nLevel: 0, click: 0.15 },
    56: { name: 'Zip', t1Level: 0, t2Level: 0, nLevel: 0, lSound: { name: 'Zip', patch: ZIP }, lLevel: 1.2, lNote: 48, lHold: 0.18, lDecay: 1 },
  }) }],
  audio: [{ from: 'drums1', to: 'out' }],
};
const KITS = [CR78, LATIN, BRUSH, FOUND].map(cleanPatch);

// ---- strange things ----
// An endless rise or fall (a Shepard tone): six sines, each sweeping six octaves around the key
// and then jumping back, a sixth of a cycle after one another (the LFOs' Start at), so they're always
// an octave apart. Each is loudest in the middle of its sweep and silent at the ends (a raised
// cosine: six of them a sixth apart always add up to the same level), so it makes its jump unheard.
// (The first version swept seven sines one octave and jumped them all together, each landing where
// its neighbour had been: the jump takes the LFO some 20 ms, and all seven sliding down an octave
// at once made a pop.) Pitch amounts are × 1.18 because a rise LFO's ramp runs ±0.848 (see above).
const shepard = (name, dir, about) => {
  const N = 6, L = 0.2, ks = [...Array(N).keys()];
  return {
    name, type: 'FX', voices: 2, volume: 0.6, about,
    modules: [...ks.flatMap(k => [mod('osc', `osc${k + 1}`, { wave: 'sine', level: L / 2 }),
      mod('lfo', `sweep${k + 1}`, { wave: 'rise', rate: 0.02, phase: k / N }), mod('lfo', `fade${k + 1}`, { wave: 'sine', rate: 0.02, phase: (k / N + 0.75) % 1 })]),
      mod('amp', 'amp1', { attack: 0.6, decay: 1, sustain: 1, release: 1.5, velocity: 0.3 }),
      mod('chorus', 'chorus1', { rate: 0.2, depth: 0.3, mix: 0.2 }), mod('reverb', 'reverb1', { type: 'hall', size: 3.5, mix: 0.3 })],
    audio: [...ks.map(k => ({ from: `osc${k + 1}`, to: 'amp1' })), ...chain('amp1', 'chorus1', 'reverb1', 'out')],
    mod: ks.flatMap(k => [{ from: `sweep${k + 1}`, to: `osc${k + 1}.pitch`, amount: dir * 3600 * 1.18 }, { from: `fade${k + 1}`, to: `osc${k + 1}.level`, amount: L / 2 }]),
  };
};
// A bell after Jean-Claude Risset's (1969): eleven sine partials at his ratios, the low ones ringing
// longest, two pairs a hertz or two apart so the hum beats. [ratio, cents, length, level]
const RISSET = [[0.56, 0, 1, 1], [0.56, 12, 0.9, 0.67], [0.92, 0, 0.65, 1], [0.92, 12, 0.55, 1.8], [1.19, 0, 0.325, 2.67], [1.7, 0, 0.35, 1.67],
  [2, 0, 0.25, 1.46], [2.74, 0, 0.2, 1.33], [3, 0, 0.15, 1.33], [3.76, 0, 0.1, 1], [4.07, 0, 0.075, 1.33]];
const STRANGE = [
  shepard('Endless Riser', 1, 'A tone that climbs for as long as you hold it and never gets any higher (a Shepard tone): six sines an octave apart rising together, each fading out at the top and coming back in at the bottom. About eight seconds an octave; to change the speed, give all twelve LFOs the same new Rate.'),
  shepard('Endless Faller', -1, 'The same illusion going down: it sinks for ever and never arrives.'),
  {
    name: 'Big Arrival', type: 'FX', voices: 2, volume: 0.5,
    about: 'Hold one low note (around C3) for ten seconds: twenty-one saws start in a wavering cluster around it and slide apart into a huge chord five octaves wide, the filter opening as they arrive.',
    modules: [...[[-2, 0], [-1, 0], [0, 0], [0, 7], [1, 0], [1, 7], [2, 0]].map(([octave, semi], k) => mod('osc', `osc${k + 1}`, { wave: 'saw', octave, semi, unison: 3, spread: 14, level: 0.3 })),
      mod('env', 'gather', { attack: 0.001, decay: 5, sustain: 0, release: 5 }), mod('env', 'open', { attack: 7, decay: 1, sustain: 1, release: 3 }),
      mod('lfo', 'waver1', { wave: 'random', rate: 5, depth: 0 }), mod('lfo', 'waver2', { wave: 'random', rate: 3.3, depth: 0 }),
      mod('filter', 'filter1', { cutoff: 500, resonance: 1, keytrack: 0.3 }), mod('amp', 'amp1', { attack: 2.5, decay: 1, sustain: 1, release: 3, velocity: 0.2 }),
      mod('reverb', 'reverb1', { type: 'hall', size: 4, mix: 0.25 })],
    audio: [...[1, 2, 3, 4, 5, 6, 7].map(k => ({ from: `osc${k}`, to: 'filter1' })), ...chain('filter1', 'amp1', 'reverb1', 'out')],
    // Where each oscillator starts, in cents from where it ends: all within a few semitones of the key.
    mod: [...[2500, 1350, -150, -550, -1050, -1800, -2250].flatMap((cents, k) => [{ from: 'gather', to: `osc${k + 1}.pitch`, amount: cents },
      { from: k % 2 ? 'waver2' : 'waver1', to: `osc${k + 1}.pitch`, amount: 120 }]),
      { from: 'gather', to: 'waver1.depth', amount: 1 }, { from: 'gather', to: 'waver2.depth', amount: 1 }, { from: 'open', to: 'filter1.cutoff', amount: 4200 }],
  },
  {
    name: 'Dial-Up', type: 'FX', voices: 4, volume: 0.55,
    about: 'A modem trying to connect: warbling tones that jump about, bursts of hiss, all down a telephone line. Each key argues at its own pitch; hold several.',
    modules: [mod('osc', 'osc1', { wave: 'sine', level: 0.6 }), mod('osc', 'osc2', { wave: 'sine', octave: 1, semi: 7, level: 0.35 }), mod('noise', 'noise1', { level: 0.12 }),
      mod('lfo', 'warble', { wave: 'square', rate: 23 }), mod('lfo', 'jump1', { wave: 'random', rate: 2.6 }), mod('lfo', 'jump2', { wave: 'random', rate: 1.4 }), mod('lfo', 'hiss', { wave: 'random', rate: 0.9 }),
      mod('filter', 'filter1', { type: 'bandpass', slope: '12', cutoff: 1500, resonance: 0.8, keytrack: 0.3 }),
      mod('amp', 'amp1', { attack: 0.005, decay: 0.2, sustain: 1, release: 0.08, velocity: 0.2 }), mod('crusher', 'crush1', { bits: 8, hold: 5, mix: 1 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, { from: 'noise1', to: 'filter1' }, ...chain('filter1', 'amp1', 'crush1', 'out')],
    mod: [{ from: 'warble', to: 'osc1.pitch', amount: 140 }, { from: 'jump1', to: 'osc1.pitch', amount: 1300 }, { from: 'jump2', to: 'osc2.pitch', amount: 900 },
      { from: 'jump2', to: 'osc2.level', amount: 0.3 }, { from: 'hiss', to: 'noise1.level', amount: 0.2 }],
  },
  {
    name: 'Geiger Choir', type: 'FX', voices: 6, volume: 0.7,
    about: 'Clicks through a singing mouth. Low keys tick a few times a second, like a Geiger counter with a voice; each octave up doubles the rate, and the mod wheel speeds everything up until the clicks blur into a sung note.',
    // A saw six octaves below the key: C4 clicks about four times a second.
    modules: [mod('osc', 'osc1', { wave: 'saw', octave: -3, level: 1 }), mod('env', 'down', { attack: 0.001, decay: 1, sustain: 1, release: 2 }),
      mod('lfo', 'chance', { wave: 'random', rate: 6 }), mod('lfo', 'mouth', { wave: 'random', rate: 0.5 }),
      mod('vowel', 'vowel1', { vowel: 2, resonance: 16 }), mod('amp', 'amp1', { attack: 0.005, decay: 0.3, sustain: 1, release: 0.4, velocity: 0.3 }),
      LIMIT(), mod('reverb', 'reverb1', { type: 'hall', size: 3, mix: 0.35 })], // single clicks and a sung note are very different levels
    audio: chain('osc1', 'vowel1', 'amp1', 'limit1', 'reverb1', 'out'),
    mod: [{ from: 'down', to: 'osc1.pitch', amount: -3600 }, { from: 'chance', to: 'osc1.pitch', amount: 1400 }, { from: 'wheel', to: 'osc1.pitch', amount: 4800 }, { from: 'mouth', to: 'vowel1.vowel', amount: 2 }],
  },
  {
    name: 'Orbiting Bees', type: 'FX', voices: 6, volume: 0.6,
    about: 'A swarm for each note, circling your head (wear headphones). Seven detuned saws, ring-modulated and wavering; more notes, more swarms, each going round on its own path.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 7, spread: 80, level: 0.6 }), mod('lfo', 'dart', { wave: 'random', rate: 11 }), mod('lfo', 'drift', { wave: 'sine', rate: 0.35 }),
      mod('ring', 'ring1', { ratio: 0.5, fine: 30, mix: 0.6 }), mod('filter', 'filter1', { type: 'bandpass', slope: '12', cutoff: 1100, resonance: 2.5, keytrack: 1 }),
      mod('amp', 'amp1', { attack: 0.4, decay: 0.5, sustain: 1, release: 1.2, velocity: 0.3 }), mod('space', 'space1', { distance: 1.2, spread: 180, orbit: 0.35 }),
      mod('compressor', 'gain1', { threshold: 0, ratio: 1, gain: 11 })], // only its make-up gain: the swarm comes out of the filter and the distance quiet
    audio: chain('osc1', 'ring1', 'filter1', 'amp1', 'space1', 'gain1', 'out'),
    mod: [{ from: 'dart', to: 'osc1.pitch', amount: 70 }, { from: 'drift', to: 'osc1.pitch', amount: 45 }, { from: 'drift', to: 'filter1.cutoff', amount: 500 }],
  },
  {
    name: 'Singing Glass', type: 'Bell', voices: 6, volume: 0.6,
    about: 'A wet finger round the rim of a wine glass: a pure tone that swells in slowly and beats against itself, into a shimmer. Push the mod wheel up to freeze what\'s sounding into a drone, and play over it.',
    modules: [mod('osc', 'osc1', { wave: 'sine', level: 0.55 }), mod('osc', 'osc2', { wave: 'sine', fine: 5, level: 0.35 }), mod('osc', 'osc3', { wave: 'sine', octave: 1, semi: 2, fine: 40, level: 0.05 }),
      mod('noise', 'noise1', { level: 0.5 }), mod('filter', 'rim', { type: 'bandpass', slope: '12', cutoff: 524, resonance: 18, keytrack: 1 }),
      mod('lfo', 'finger', { wave: 'sine', rate: 3.7, delay: 1 }), mod('amp', 'amp1', { attack: 1.1, decay: 1, sustain: 1, release: 2.5, velocity: 0.4, level: 0.6 }),
      mod('freeze', 'freeze1', { size: 0.8 }), mod('shimmer', 'shimmer1', { size: 6, shimmer: 0.45, mix: 0.35 })],
    audio: [{ from: 'osc1', to: 'amp1' }, { from: 'osc2', to: 'amp1' }, { from: 'osc3', to: 'amp1' }, { from: 'noise1', to: 'rim' }, { from: 'rim', to: 'amp1' }, ...chain('amp1', 'freeze1', 'shimmer1', 'out')],
    mod: [{ from: 'finger', to: 'amp1.level', amount: 0.1 }, { from: 'wheel', to: 'freeze1.frozen', amount: 1 }],
  },
  {
    name: 'Risset Bells', type: 'Bell', voices: 6, volume: 0.6,
    about: 'A bell built from eleven pure tones that die away one by one, highest first, until only a slowly beating hum is left, fading over ten seconds or so (after Jean-Claude Risset, 1969). Let it ring.',
    modules: [...RISSET.map(([ratio, fine, len, level], k) => mod('fmop', `op${k + 1}`, { ratio, fine, attack: 0.002, decay: 10 * len, sustain: 0, release: 10 * len, velocity: 0.7, level: 0.1 * level })),
      mod('reverb', 'reverb1', { type: 'hall', size: 4, mix: 0.25 })],
    audio: [...RISSET.map((r, k) => ({ from: `op${k + 1}`, to: 'reverb1' })), { from: 'reverb1', to: 'out' }],
  },
  {
    name: 'Backwards Piano', volume: 1, type: 'Keys', voices: 6,
    about: 'A piano chord played backwards: it swells out of nothing for three seconds and ends on the strike (keep holding and, after a silence, it swells again). Press three seconds before you want it to land (five beats at 100 bpm).',
    modules: [mod('granular', 'gr1', { file: 'factory/Piano Chord (C4).wav', root: 60, position: 0.5, spread: 0.008, scan: -1, size: 0.1, density: 40, jitter: 0, width: 0.6, level: 1 }),
      mod('amp', 'amp1', { attack: 0.05, decay: 1, sustain: 1, release: 0.6, level: 0.8 }), COMP(),
      mod('delay', 'delay1', { mode: 'tape', time: 0.38, feedback: 0.3, wobble: 0.5, mix: 0.2 }), mod('reverb', 'reverb1', { type: 'hall', size: 3.5, mix: 0.25 })],
    audio: chain('gr1', 'amp1', 'comp1', 'delay1', 'reverb1', 'out'),
  },
].map(cleanPatch);

// ---- sounds built on the Resonator, the step sequences and the Grain delay (Nov 2026) ----
const based = name => JSON.parse(JSON.stringify([...STARTERS, ...MORE, ...KEYS].find(p => p.name === name)));
// A Resonator struck by its own Strike, then effects.
const struck = (name, type, about, res, { fx = [], volume = 0.7, voices = 8 } = {}) => ({
  name, type, about, voices, volume,
  modules: [mod('resonator', 'res1', res), ...fx],
  audio: chain('res1', ...fx.map(m => m.id), 'out'), mod: [],
});
const steps = (id, sync, values, extra = {}) => mod('seq', id, { sync, length: values.length, ...Object.fromEntries(values.map((v, k) => [`s${k + 1}`, v])), ...extra });
const NEWER = [
  struck('Glass Harp', 'Bell', 'Wine glasses tapped with a mallet: each note is a Resonator ringing with a glass\'s uneven partials, struck by its own Strike. Harder notes are brighter. Try its Shape, Damping and Spacing.',
    { shape: 'glass', strike: 0.7, decay: 5, damping: 0.12, bright: 0.45, position: 0.37, release: 2.5, width: 0.6, level: 1.6 }, { volume: 0.65, fx: [mod('reverb', 'reverb1', { type: 'hall', size: 3.5, mix: 0.3 })] }),
  struck('Rosewood Bars', 'Keys', 'A wooden-bar instrument somewhere between a marimba and a log drum: a Resonator shaped like a bar, heavily damped so only the low partials last.',
    { shape: 'bar', strike: 0.6, decay: 1.1, damping: 0.75, bright: 0.7, position: 0.5, release: 0.6, width: 0.4, level: 1.7 }, { volume: 0.42, fx: [mod('reverb', 'reverb1', { type: 'room', size: 1.2, mix: 0.18 })] }),
  struck('Tower Bell', 'Bell', 'A big bell with a bell\'s own partials (hum, prime, tierce, quint, nominal): low notes toll for half a minute. Play it low and slow; chords clash, as real bells do.',
    { shape: 'bell', strike: 0.5, octave: -1, decay: 14, damping: 0.18, bright: 0.75, position: 0.23, release: 8, width: 0.7, level: 1.8 }, { voices: 6, fx: [mod('reverb', 'reverb1', { type: 'hall', size: 5, mix: 0.3 })] }),
  struck('Steel Plate', 'Bell', 'A sheet of metal hit with a stick: a Resonator as a plate, its partials crowded and clangorous, with a little grit. Low notes are gongs, high ones are pans.',
    { shape: 'plate', strike: 0.5, decay: 4, damping: 0.25, bright: 0.85, position: 0.19, spacing: 1.08, release: 1.5, width: 0.9, level: 1.8 }, { volume: 0.75, fx: [mod('shaper', 'shaper1', { curve: 'tube', drive: 2, tone: 9000, mix: 0.5, level: 0.8 }), mod('reverb', 'reverb1', { type: 'plate', size: 2.2, mix: 0.25 })] }),
  {
    name: 'Bowed Plate', type: 'Pad', voices: 6, volume: 0.7,
    about: 'A metal plate stroked with a bow: noise fed steadily into a Resonator, so its partials swell and flicker instead of being struck. Slow to speak; the mod wheel squeezes the partials together.',
    modules: [mod('noise', 'noise1', { level: 0.25 }), mod('filter', 'filter1', { type: 'bandpass', slope: '12', cutoff: 900, resonance: 0.5, keytrack: 0.8 }),
      mod('amp', 'bow', { attack: 1.2, decay: 1, sustain: 1, release: 0.8, velocity: 0.4, level: 0.5 }),
      mod('resonator', 'res1', { shape: 'plate', strike: 0, decay: 3, damping: 0.3, bright: 0.6, position: 0.27, release: 3, width: 1, level: 1.3 }),
      mod('reverb', 'reverb1', { type: 'hall', size: 4.5, mix: 0.35 })],
    audio: chain('noise1', 'filter1', 'bow', 'res1', 'reverb1', 'out'),
    mod: [{ from: 'wheel', to: 'res1.pitch', amount: -200 }],
  },
  (() => {
    const kit = based('808 Kit');
    kit.modules.splice(1, 0, mod('resonator', 'res1', { shape: 'bell', strike: 0, tune: 'fixed', note: 48, decay: 3.5, damping: 0.35, bright: 0.6, release: 3.5, width: 0.9, mix: 0.45, level: 1 }));
    const next = kit.audio.filter(c => c.from === 'drums1').map(c => c.to);
    return { ...kit, name: 'Bell Tower Kit', volume: 0.5,
      about: 'The 808 Kit played inside a bell: every drum sets a Resonator ringing on one note (C3; change Fixed note to the key of your song). Kicks toll, hats shimmer. Mix on the Resonator is how much bell.',
      audio: [...kit.audio.filter(c => c.from !== 'drums1'), { from: 'drums1', to: 'res1' }, ...next.map(to => ({ from: 'res1', to }))] };
  })(),
  {
    name: 'Prepared Piano', type: 'Keys', voices: 12, volume: 0.5,
    about: 'The grand with bolts and rubber between its strings: each note also rings a short, clanging bar a fifth above it. Mix on the Resonator is how much hardware; its Semitones and Spacing change what\'s been put in the strings.',
    modules: [mod('piano', 'piano1', { release: 0.8 }), mod('resonator', 'res1', { shape: 'bar', strike: 0, semi: 7, decay: 0.7, damping: 0.2, bright: 0.9, position: 0.13, spacing: 0.8, release: 0.3, width: 0.5, mix: 0.5, level: 2 }),
      mod('reverb', 'reverb1', { type: 'room', size: 1.4, mix: 0.2 })],
    audio: chain('piano1', 'res1', 'reverb1', 'out'),
  },
  {
    name: 'Pocket Sequencer', type: 'Lead', voices: 4, volume: 0.5,
    about: 'Hold one key: a sixteen-step melody plays from it, in time with the song (start it on the beat). The tune is the Step sequence\'s sliders, a semitone a unit; change them while it plays. Glide slides between steps.',
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.5 }), mod('osc', 'osc2', { wave: 'square', octave: -1, level: 0.3 }),
      steps('tune', '1/16', [0, 0, 12, 0, 7, 0, 10, 12, 0, 3, 12, 0, 5, 7, -2, -5]), mod('lfo', 'pluck', { wave: 'rise', sync: '1/16' }),
      mod('filter', 'filter1', { cutoff: 2600, resonance: 4, keytrack: 0.4 }), mod('amp', 'amp1', { attack: 0.003, decay: 0.2, sustain: 1, release: 0.12, velocity: 0.4 }),
      mod('delay', 'delay1', { mode: 'ping-pong', sync: '1/8.', feedback: 0.3, mix: 0.18 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'out')],
    mod: [{ from: 'tune', to: 'osc1.pitch', amount: 1200 }, { from: 'tune', to: 'osc2.pitch', amount: 1200 }, { from: 'pluck', to: 'filter1.cutoff', amount: -2200 }],
  },
  {
    name: 'Five Against Eight', type: 'Bass', voices: 2, volume: 0.6,
    about: 'Hold a low key: an eight-step bass line whose filter follows a five-step pattern, so the bright notes fall somewhere new each bar and it only repeats after five. Two Step sequences of different lengths.',
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.6 }), mod('osc', 'osc2', { wave: 'pulse', pw: 0.3, octave: -1, level: 0.35 }),
      steps('line', '1/16', [0, 0, 12, 0, 0, 12, 0, 7]), steps('tone', '1/16', [12, -6, 3, -12, 6], { glide: 0.15 }), mod('lfo', 'pluck', { wave: 'rise', sync: '1/16' }),
      mod('filter', 'filter1', { cutoff: 700, resonance: 6, keytrack: 0.3 }), mod('drive', 'drive1', { amount: 0.3 }), mod('amp', 'amp1', { attack: 0.003, decay: 0.2, sustain: 1, release: 0.1, velocity: 0.4 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'drive1', 'amp1', 'out')],
    mod: [{ from: 'line', to: 'osc1.pitch', amount: 1200 }, { from: 'line', to: 'osc2.pitch', amount: 1200 }, { from: 'tone', to: 'filter1.cutoff', amount: 2400 }, { from: 'pluck', to: 'filter1.cutoff', amount: -1500 }],
  },
  {
    name: 'Robot Choir', type: 'Lead', voices: 6, volume: 0.45,
    about: 'Hold a chord and it sings a line of vowels in eighths, in time with the song: a Step sequence moving the Vowel filter (-6 = A, -3 = E, 0 = I, 3 = O, 6 = U). Rewrite the words with its sliders.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 3, spread: 12, level: 0.6 }), mod('osc', 'osc2', { wave: 'pulse', pw: 0.25, octave: -1, level: 0.3 }),
      steps('words', '1/8', [-6, 3, 0, -3, 6, 3, -6, 0], { glide: 0.35 }), mod('lfo', 'vib', { wave: 'sine', rate: 5.2, delay: 0.5 }),
      mod('vowel', 'vowel1', { vowel: 2, resonance: 12 }), mod('amp', 'amp1', { attack: 0.03, decay: 0.3, sustain: 1, release: 0.25, velocity: 0.4, level: 0.4 }),
      mod('chorus', 'chorus1', { mix: 0.3 }), mod('reverb', 'reverb1', { type: 'hall', size: 2.5, mix: 0.22 })],
    audio: [{ from: 'osc1', to: 'vowel1' }, { from: 'osc2', to: 'vowel1' }, ...chain('vowel1', 'amp1', 'chorus1', 'reverb1', 'out')],
    mod: [{ from: 'words', to: 'vowel1.vowel', amount: 4 }, { from: 'vib', to: 'osc1.pitch', amount: 12 }],
  },
  {
    name: 'Morse Pad', type: 'Pad', voices: 8, volume: 0.6,
    about: 'A warm pad chopped into a rhythm: a sixteen-step pattern of on and off (0 = on, -12 = off) on its level, in time with the song. Hold chords on the beat; redraw the rhythm with the steps.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 3, spread: 16, level: 0.5 }), mod('osc', 'osc2', { wave: 'triangle', octave: 1, fine: 6, level: 0.3 }),
      steps('rhythm', '1/16', [0, -12, 0, 0, -12, 0, -12, -12, 0, 0, -12, 0, -12, 0, 0, -12], { glide: 0.12 }),
      mod('filter', 'filter1', { cutoff: 2400, resonance: 1.5, keytrack: 0.4 }), mod('amp', 'amp1', { attack: 0.02, decay: 0.5, sustain: 1, release: 0.5, velocity: 0.3, level: 0.8 }),
      mod('delay', 'delay1', { mode: 'ping-pong', sync: '1/8.', feedback: 0.35, mix: 0.2 }), mod('reverb', 'reverb1', { type: 'hall', size: 3, mix: 0.2 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'delay1', 'reverb1', 'out')],
    mod: [{ from: 'rhythm', to: 'amp1.level', amount: 0.8 }],
  },
  {
    name: 'Dying Console', type: 'FX', voices: 6, volume: 0.7,
    arp: { mode: 'up', rate: '1/16', octaves: 2, gate: 0.6 },
    about: 'Hold a chord: a game console running out of battery. The arpeggio keeps going while a Global step sequence takes its bits away and gives them back, every bar.',
    modules: [mod('osc', 'osc1', { wave: 'square', level: 0.5 }), mod('amp', 'amp1', { attack: 0.002, decay: 0.12, sustain: 0.4, release: 0.08, velocity: 0.3 }),
      mod('crusher', 'crush1', { bits: 12, hold: 3, mix: 1 }),
      mod('gseq', 'battery', { sync: '1/8', length: 8, glide: 0.5, s1: 0, s2: -3, s3: -6, s4: -8, s5: -10, s6: -10, s7: -7, s8: -3 }),
      LIMIT(), mod('delay', 'delay1', { sync: '1/8.', feedback: 0.3, mix: 0.18 })],
    audio: chain('osc1', 'amp1', 'crush1', 'limit1', 'delay1', 'out'),
    mod: [{ from: 'battery', to: 'crush1.bits', amount: 12 }, { from: 'battery', to: 'crush1.hold', amount: -12 }],
  },
  (() => {
    const p = based('Grand Piano');
    return { ...p, name: 'Piano Snowfall', volume: 0.85,
      about: 'The grand, with every note breaking into flakes that drift upward: a Grain delay replays what you played in small pieces an octave higher, and feeds them round to climb again. Play slowly and leave room.',
      modules: [mod('piano', 'piano1'), mod('grains', 'grains1', { time: 0.3, scatter: 0.5, size: 0.14, density: 9, pitch: 12, jitter: 6, reverse: 0.3, feedback: 0.5, width: 1, mix: 0.4 }),
        mod('reverb', 'hall', { type: 'hall', size: 4, damping: 0.4, mix: 0.3 })],
      audio: chain('piano1', 'grains1', 'hall', 'out') };
  })(),
  (() => {
    const p = based('FM Bell');
    return { ...p, name: 'Scattered Bells', volume: 1,
      about: 'Bells whose ringing comes apart: a Grain delay throws pieces of each note back from anywhere in the last two seconds, most of them backwards. One note becomes a small crowd.',
      modules: [...p.modules.filter(m => m.type === 'fmop'), mod('grains', 'grains1', { time: 0.12, scatter: 1, size: 0.2, density: 14, pitch: 0, jitter: 8, reverse: 0.7, feedback: 0.35, width: 1, mix: 0.55 }),
        mod('reverb', 'reverb1', { size: 4, mix: 0.3 })],
      audio: [{ from: 'op2', to: 'op1' }, ...chain('op1', 'grains1', 'reverb1', 'out')] };
  })(),
  {
    name: 'Stair Echo', type: 'Pluck', voices: 8, volume: 1,
    about: 'A pluck whose echoes walk up a staircase: the echo is a Grain delay, and a Global step sequence moves its pitch up a fifth, then down a fifth (its steps are semitones). Each echo is shifted again, so they climb a fifth, then a ninth, as they fade. Play sparse notes in time.',
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.5 }), mod('osc', 'osc2', { wave: 'square', fine: 7, level: 0.25 }),
      mod('env', 'env1', { attack: 0.001, decay: 0.18, sustain: 0, release: 0.15 }), mod('filter', 'filter1', { cutoff: 600, resonance: 2, keytrack: 0.6 }),
      mod('amp', 'amp1', { attack: 0.002, decay: 0.35, sustain: 0, release: 0.2, velocity: 0.6 }),
      mod('grains', 'grains1', { sync: '1/8', scatter: 0, size: 0.11, density: 18, pitch: 0, feedback: 0.85, width: 0.7, mix: 0.45 }),
      mod('gseq', 'stairs', { sync: '1/4', length: 4, s1: 0, s2: 7, s3: 0, s4: -7 }), mod('reverb', 'reverb1', { type: 'room', size: 1.6, mix: 0.15 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'grains1', 'reverb1', 'out')],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 4200 }, { from: 'stairs', to: 'grains1.pitch', amount: 12 }],
  },
  {
    name: 'Held Cloud', type: 'Pad', voices: 8, volume: 0.9,
    about: 'A soft pad dissolved into a cloud of grains. Push the mod wheel up and the cloud is held: it goes on with what it has, and you can play new notes over it. Wheel down lets it go.',
    modules: [mod('osc', 'osc1', { wave: 'saw', unison: 3, spread: 14, level: 0.45 }), mod('osc', 'osc2', { wave: 'sine', octave: 1, level: 0.25 }),
      mod('filter', 'filter1', { cutoff: 1800, resonance: 1, keytrack: 0.5 }), mod('amp', 'amp1', { attack: 0.3, decay: 0.6, sustain: 0.9, release: 1.2, velocity: 0.3 }),
      mod('grains', 'grains1', { time: 0.2, scatter: 0.7, size: 0.28, density: 22, pitch: 0, jitter: 7, reverse: 0.4, feedback: 0.3, width: 1, mix: 0.7 }),
      mod('reverb', 'reverb1', { type: 'hall', size: 5, mix: 0.35 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, ...chain('filter1', 'amp1', 'grains1', 'reverb1', 'out')],
    mod: [{ from: 'wheel', to: 'grains1.hold', amount: 1 }],
  },
  {
    name: 'Tape Left in the Sun', type: 'Keys', voices: 16, volume: 0.7,
    about: 'A piano on a cassette that spent a summer on a dashboard: out of tune, dull, and its echo wavers in pitch as the tape drags. Slow chords suit it.',
    modules: [mod('piano', 'piano1', { hardness: 0.5, strike: 0.6, detune: 9, release: 1.2 }), mod('filter', 'dull', { slope: '12', cutoff: 3200, resonance: 0.4, keytrack: 0.3 }),
      mod('shaper', 'tape', { curve: 'tube', drive: 1.6, tone: 5000, mix: 0.6, level: 0.8 }),
      mod('delay', 'echo', { mode: 'tape', time: 0.31, feedback: 0.35, tone: 2200, wobble: 1, mix: 0.3 }),
      mod('glfo', 'drag', { wave: 'sine', rate: 0.37 }), mod('reverb', 'room', { type: 'room', size: 1.8, damping: 0.8, mix: 0.2 })],
    audio: chain('piano1', 'dull', 'tape', 'echo', 'room', 'out'),
    mod: [{ from: 'drag', to: 'echo.time', amount: 0.01 }],
  },
  {
    name: 'Ghost Piano', type: 'Keys', voices: 16, volume: 1,
    about: 'A piano you can\'t hear, only the rest of its strings answering: every note sets the strings an octave, a fifth and more above it ringing, and those are all that sound: a hollow, organ-like piano with no hammer in it that hangs for a few seconds after you let go. Low chords answer most.',
    // Pedal resonance with its dampers always up and no direct sound; a compressor used as plain
    // gain (threshold 0, ratio 1) brings the halo up to a playing level.
    modules: [mod('piano', 'piano1'), mod('resonance', 'pedal', { amount: 1, ring: 3, open: 'always', direct: 0 }),
      mod('compressor', 'gain1', { threshold: 0, ratio: 1, gain: 6 }), mod('reverb', 'hall', { type: 'hall', size: 5, damping: 0.35, mix: 0.35 })],
    audio: chain('piano1', 'pedal', 'gain1', 'hall', 'out'),
  },
  {
    name: 'Talking String', type: 'Pluck', voices: 8, volume: 0.6,
    about: 'A plucked string that says a word: each note opens through a Vowel filter from "ah" towards "oo", a jaw harp crossed with a sitar. Harder notes say more; the mod wheel changes the word.',
    modules: [mod('string', 'string1', { excite: 'pick', position: 0.08, brightness: 0.9, decay: 3.5, highs: 2.5, release: 0.25, velocity: 0.7, level: 1 }),
      mod('env', 'mouth', { attack: 0.001, decay: 0.35, sustain: 0, release: 0.2, velocity: 0.5 }),
      mod('vowel', 'vowel1', { vowel: 3.6, resonance: 9, mix: 0.9 }), mod('reverb', 'reverb1', { type: 'room', size: 1.5, mix: 0.18 })],
    audio: chain('string1', 'vowel1', 'reverb1', 'out'),
    mod: [{ from: 'mouth', to: 'vowel1.vowel', amount: -3.4 }, { from: 'wheel', to: 'vowel1.vowel', amount: -2 }],
  },
  {
    name: 'Acid Steps', type: 'Bass', voices: 1, volume: 0.6, play: 'legato',
    about: 'Hold a low key: a squelching sixteen-step bass line with slides, in time with the song. One Step sequence is the tune (semitones), another is the accents: which notes bark and which mutter. Change key without letting go and the line carries on. The mod wheel opens the filter.',
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.6 }),
      steps('line', '1/16', [0, 0, 12, 0, 0, 3, 0, 12, 0, -2, 0, 12, 7, 0, 10, 12], { glide: 0.25 }),
      steps('accent', '1/16', [8, -8, -8, 4, -8, 8, -8, -8, 4, -8, -8, 8, -8, 4, -8, 12]), mod('lfo', 'pluck', { wave: 'rise', sync: '1/16' }),
      mod('filter', 'filter1', { cutoff: 450, resonance: 15, keytrack: 0.3 }), mod('drive', 'drive1', { amount: 0.45 }),
      mod('amp', 'amp1', { attack: 0.003, decay: 0.2, sustain: 1, release: 0.08, velocity: 0.3, level: 0.6 }),
      mod('delay', 'delay1', { sync: '1/8.', feedback: 0.25, mix: 0.1 })],
    audio: chain('osc1', 'filter1', 'drive1', 'amp1', 'delay1', 'out'),
    mod: [{ from: 'line', to: 'osc1.pitch', amount: 1200 }, { from: 'accent', to: 'filter1.cutoff', amount: 1800 }, { from: 'accent', to: 'amp1.level', amount: 0.25 },
      { from: 'pluck', to: 'filter1.cutoff', amount: -1800 }, { from: 'wheel', to: 'filter1.cutoff', amount: 3600 }],
  },
  (() => {
    const kit = based('909 Kit');
    // The lows go round the mouth (a low-pass beside the Vowel filter), or the kick loses its body.
    kit.modules.splice(1, 0, mod('vowel', 'vowel1', { vowel: 2, resonance: 8, mix: 0.9 }), mod('filter', 'lows', { cutoff: 140, resonance: 0, keytrack: 0 }),
      mod('gseq', 'words', { sync: '1/16', length: 8, glide: 0.3, s1: -6, s2: 3, s3: 0, s4: 6, s5: -3, s6: -6, s7: 6, s8: 0 }));
    const next = kit.audio.filter(c => c.from === 'drums1').map(c => c.to);
    return { ...kit, name: 'Talking Drums', volume: 0.5,
      about: 'The 909 Kit with a mouth: every drum goes through a Vowel filter, and a Global step sequence changes the vowel each sixteenth, in time with the song (-6 = A, -3 = E, 0 = I, 3 = O, 6 = U), so the same hat says something different each time. Rewrite what it says with the steps; Mix on the Vowel filter is how much mouth. The kick\'s boom goes round the mouth, through the filter called lows.',
      audio: [...kit.audio.filter(c => c.from !== 'drums1'), { from: 'drums1', to: 'vowel1' }, { from: 'drums1', to: 'lows' }, ...next.flatMap(to => [{ from: 'vowel1', to }, { from: 'lows', to }])],
      mod: [...(kit.mod || []), { from: 'words', to: 'vowel1.vowel', amount: 4 }] };
  })(),
  {
    name: 'Reverse Bloom', type: 'Keys', voices: 16, volume: 0.85,
    about: 'The grand, and after each note its own echo played backwards: a Grain delay with every grain reversed, so the echoes swell up to where the hammer was, then a Shimmer reverb lifts them an octave. Play slowly; the bloom arrives about a second behind you (two beats at 120 bpm).',
    modules: [mod('piano', 'piano1'), mod('grains', 'grains1', { time: 0.45, scatter: 0.12, size: 0.4, density: 7, pitch: 0, jitter: 4, reverse: 1, feedback: 0.3, width: 1, mix: 0.5 }),
      mod('shimmer', 'shimmer1', { size: 5, shimmer: 0.45, tone: 5000, mix: 0.3 })],
    audio: chain('piano1', 'grains1', 'shimmer1', 'out'),
  },
  {
    name: 'Clockwork', type: 'Pluck', voices: 4, volume: 0.45,
    about: 'Hold a key: a wooden mechanism ticks out a tune by itself, in time with the song. A seven-note Step sequence tunes a small bar (a Resonator) while a five-step one decides which sixteenths strike it (0 = strike, -12 = rest), so it takes 35 steps to come round again. Rewrite either with its sliders.',
    modules: [mod('noise', 'noise1', { level: 0.5 }), mod('filter', 'filter1', { slope: '12', cutoff: 5000, resonance: 0.5, keytrack: 0.5 }),
      mod('lfo', 'pluck', { wave: 'rise', sync: '1/16' }), steps('tune', '1/16', [0, 7, 4, 12, 9, 2, -3]), steps('rhythm', '1/16', [0, 0, -12, 0, -12]),
      mod('amp', 'tick', { attack: 0.001, decay: 0.2, sustain: 1, release: 0.02, velocity: 0.5, level: 0.5 }),
      mod('amp', 'gate', { attack: 0.001, decay: 0.2, sustain: 1, release: 0.02, velocity: 0, level: 0.8 }),
      mod('resonator', 'res1', { shape: 'bar', strike: 0, decay: 0.3, damping: 0.5, bright: 0.7, position: 0.3, release: 0.3, width: 0.5, level: 1.6 }),
      mod('delay', 'delay1', { mode: 'ping-pong', sync: '1/8.', feedback: 0.25, mix: 0.12 }), mod('reverb', 'reverb1', { type: 'room', size: 1.4, mix: 0.2 })],
    audio: chain('noise1', 'filter1', 'tick', 'gate', 'res1', 'delay1', 'reverb1', 'out'),
    mod: [{ from: 'pluck', to: 'filter1.cutoff', amount: -4800 }, { from: 'pluck', to: 'tick.level', amount: -0.59 },
      { from: 'rhythm', to: 'gate.level', amount: 0.8 }, { from: 'tune', to: 'res1.pitch', amount: 1200 }],
  },
  (() => {
    const p = based('FM Bell');
    return { ...p, name: 'Stuck Bells', volume: 0.6,
      about: 'Bells on a record that skips: now and then a Stutter catches a slice of the ringing and repeats it before letting go. The mod wheel makes it stick more often; Size on the Stutter is how long the stuck piece is.',
      modules: [...p.modules.filter(m => m.type === 'fmop'), mod('stutter', 'stutter1', { size: 0.11, chance: 0.3, repeats: 5, mix: 1 }), mod('reverb', 'reverb1', { size: 4, mix: 0.3 })],
      audio: [{ from: 'op2', to: 'op1' }, ...chain('op1', 'stutter1', 'reverb1', 'out')],
      mod: [{ from: 'wheel', to: 'stutter1.chance', amount: 0.6 }] };
  })(),
  (() => {
    const p = based('B3 Jazz');
    Object.assign(p.modules.find(m => m.id === 'leslie').params, { wheel: 'off', inertia: 0.3, drive: 0.35 });
    return { ...p, name: 'Broken Leslie', type: 'Organ',
      about: 'A drawbar organ through a rotary speaker whose motor has a loose wire: a Global step sequence kicks the rotors fast and lets them fall back, in time with the song (12 = fast, 0 = slow), so chords lurch and wobble. Redraw the fault with its steps; Inertia on the Rotary is how heavy the rotors are.',
      modules: [...p.modules, mod('gseq', 'motor', { sync: '1/4', length: 8, s1: 0, s2: 0, s3: 12, s4: 12, s5: 0, s6: 12, s7: 0, s8: 0 })],
      mod: [...(p.mod || []), { from: 'motor', to: 'leslie.speed', amount: 1 }] };
  })(),
  (() => {
    const kit = based('909 Kit');
    kit.modules.splice(1, 0, mod('space', 'space1', { distance: 1.2, orbit: 0.3, orbits: 'together' }));
    const next = kit.audio.filter(c => c.from === 'drums1').map(c => c.to);
    return { ...kit, name: 'Beat Orbit', volume: 0.9,
      about: 'For headphones: the 909 Kit going round your head. Every drum lands wherever one slow circle has got to (3D space, Orbit starts: together), so the beat walks round you every three seconds or so, and long sounds (cymbals, toms) travel as they ring. Orbit is the speed.',
      audio: [...kit.audio.filter(c => c.from !== 'drums1'), { from: 'drums1', to: 'space1' }, ...next.map(to => ({ from: 'space1', to }))] };
  })(),
  {
    name: 'Three Against Four', type: 'Pluck', voices: 4, volume: 0.7,
    about: 'Hold a key: two small voices play at once, one fitting three notes where the other fits four, in time with the song, so they meet only at the start of every half bar. Each has its own Step sequence for its notes (semitones).',
    modules: [mod('osc', 'osc1', { wave: 'triangle', level: 0.6 }), mod('osc', 'osc2', { wave: 'triangle', octave: 1, level: 0.45 }),
      steps('three', '1/4t', [0, 7, 3]), steps('four', '1/8', [0, 10, 7, 3]),
      mod('lfo', 'pluck3', { wave: 'rise', sync: '1/4t' }), mod('lfo', 'pluck4', { wave: 'rise', sync: '1/8' }),
      mod('amp', 'amp3', { attack: 0.002, decay: 0.2, sustain: 1, release: 0.15, velocity: 0.4, level: 0.5 }),
      mod('amp', 'amp4', { attack: 0.002, decay: 0.2, sustain: 1, release: 0.15, velocity: 0.4, level: 0.5 }),
      mod('delay', 'delay1', { mode: 'ping-pong', sync: '1/8.', feedback: 0.3, mix: 0.15 }), mod('reverb', 'reverb1', { type: 'room', size: 1.6, mix: 0.2 })],
    audio: [...chain('osc1', 'amp3', 'delay1', 'reverb1', 'out'), ...chain('osc2', 'amp4', 'delay1')],
    mod: [{ from: 'three', to: 'osc1.pitch', amount: 1200 }, { from: 'four', to: 'osc2.pitch', amount: 1200 },
      { from: 'pluck3', to: 'amp3.level', amount: -0.59 }, { from: 'pluck4', to: 'amp4.level', amount: -0.59 }],
  },
  {
    name: 'Carousel', type: 'Organ', voices: 8, volume: 0.7,
    about: 'A fairground organ that has seen better summers. Hold a chord and it plays a waltz by itself, in time with the song: a bass note on one, the chord on two and three, all of it wavering slightly out of tune. Best in 3/4.',
    modules: [mod('organ', 'organ1', { bar1: 0, bar2: 0, bar3: 8, bar4: 8, bar5: 0, bar6: 5, bar7: 0, bar8: 6, bar9: 0, click: 0.5, level: 0.7 }),
      mod('osc', 'bass', { wave: 'triangle', octave: -1, level: 0.7 }),
      steps('pah', '1/4', [-12, 0, 0], { glide: 0.08 }), steps('oom', '1/4', [0, -12, -12], { glide: 0.08 }),
      mod('lfo', 'bounce', { wave: 'rise', sync: '1/4' }), mod('lfo', 'wow', { wave: 'sine', rate: 0.7 }),
      mod('amp', 'chord', { attack: 0.004, decay: 0.2, sustain: 1, release: 0.12, velocity: 0.2, level: 0.8 }),
      mod('amp', 'puff', { attack: 0.004, decay: 0.2, sustain: 1, release: 0.12, velocity: 0, level: 0.5 }),
      mod('amp', 'low', { attack: 0.004, decay: 0.2, sustain: 1, release: 0.12, velocity: 0.2, level: 0.8 }),
      mod('chorus', 'chorus1', { rate: 0.9, depth: 0.6, mix: 0.35 }), mod('delay', 'tape', { mode: 'tape', time: 0.09, feedback: 0.1, wobble: 1, mix: 0.25 }),
      mod('reverb', 'reverb1', { type: 'room', size: 1.8, mix: 0.22 })],
    audio: [...chain('organ1', 'chord', 'puff', 'chorus1', 'tape', 'reverb1', 'out'), ...chain('bass', 'low', 'chorus1')],
    mod: [{ from: 'pah', to: 'chord.level', amount: 0.8 }, { from: 'oom', to: 'low.level', amount: 0.8 }, { from: 'bounce', to: 'puff.level', amount: -0.45 },
      { from: 'wow', to: 'organ1.pitch', amount: 14 }, { from: 'wow', to: 'bass.pitch', amount: 14 }],
  },
  {
    name: 'Theremin Choir', type: 'Lead', voices: 1, volume: 0.6, play: 'legato', glide: 0.18,
    about: 'One voice that slides between notes like a theremin and sings "ah" through a Vowel filter, with a vibrato that arrives after a moment. Play it legato; the mod wheel closes the mouth from "ah" to "oo".',
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.35 }), mod('osc', 'osc2', { wave: 'sine', level: 0.5 }),
      mod('lfo', 'vib', { wave: 'sine', rate: 5.6, delay: 0.35 }),
      mod('vowel', 'vowel1', { vowel: 0.3, resonance: 7, mix: 0.85 }), mod('amp', 'amp1', { attack: 0.12, decay: 0.3, sustain: 1, release: 0.4, velocity: 0.4 }),
      mod('reverb', 'reverb1', { type: 'hall', size: 3.5, mix: 0.3 })],
    audio: [{ from: 'osc1', to: 'vowel1' }, { from: 'osc2', to: 'vowel1' }, ...chain('vowel1', 'amp1', 'reverb1', 'out')],
    mod: [{ from: 'vib', to: 'osc1.pitch', amount: 28 }, { from: 'vib', to: 'osc2.pitch', amount: 28 }, { from: 'wheel', to: 'vowel1.vowel', amount: 3.5 }],
  },
].map(cleanPatch);

export const FACTORY = [...STARTERS, ...MORE, ...KITS, ...ARPS, ...STRANGE, ...NEWER, ...KEYS.map(cleanPatch)];

// ---- collections: sounds that belong together (a genre, a set for one kind of track) ----
// Factory collections are below; yours are saved instruments of kind 'collection':
//   { format: 'mkxl-inst', version: 1, kind: 'collection', name: 'Collection: <title>', title, about?,
//     sounds: [{ name, mine }], modules: [], audio: [], mod: [] }
// (kept with your sounds so they're backed up and transferred with them; `name` is prefixed so a
// collection never replaces a sound of the same name). Sounds are referred to by name.
export const COLLECTIONS = [
  { title: 'French House', about: 'Filtered and flanged disco chords, talking robot leads and basses, vowel and string pads, a pumping supersaw and a punchy bass: loops that open and close.',
    sounds: ['Disco Filter Chords', 'Jet Filter Chords', 'Robot Talk Lead', 'Talk Box Bass', 'Vowel Pad', 'Robot Rock Riff', 'Pump Pad', 'Disco Punk Bass', 'Phased String Machine', 'Saw Arp', '909 Kit'] },
  { title: 'Electro', about: 'Distorted basses, huge supersaws and pumping pads over hard drum machines.',
    sounds: ['Electro Fuzz Bass', 'Big Supersaw Lead', 'Pump Pad', 'Robot Rock Riff', 'Blip Arp', '909 Kit', 'Glitch Kit'] },
  { title: 'Disco Punk', about: 'A dry drum machine with cowbell (and flanged hats on a second track), a driving analog bass, wah guitar, phased strings, sync-like sequences and noise build-ups.',
    sounds: ['Dance Punk Kit', 'Jet Hats', 'Disco Punk Bass', 'Wah Funk Guitar', 'Phased String Machine', 'Sync Sequence', 'Noise Riser', 'Saw Arp', 'Brass Stab'] },
  { title: 'New Wave', about: 'Sequenced octave basses, sampled-choir pads, syndrums and crunchy early drum machines; a high melodic bass as the lead.',
    sounds: ['Sequenced Octave Bass', 'High Melodic Bass', 'Tape Choir', 'String Ensemble', 'Glass Arp', 'Syndrum Kit', 'DMX Kit'] },
  { title: 'Indie Electronic', about: 'Fuzzed, double-tracked guitar leads, gliding mono synths and steel plucks over a booming 808.',
    sounds: ['Twin Fuzz Lead', 'Glide Mono Lead', 'Steel Pluck', 'Elastic Bass', 'Clean Electric', '808 Kit'] },
  { title: 'Odd-Meter Electronic', about: 'Skittering beats in 5/4 and other odd meters, rubbery bass and fast arpeggios.',
    sounds: ['Odd Step Kit', 'Elastic Bass', 'Rubber Arp', 'Glass Arp', 'Saw Arp', 'Blip Arp', 'Glitch Pad'] },
  { title: 'Hip-Hop & Lo-Fi', about: 'Long 808 booms, dusty drums and warm, worn keys.',
    sounds: ['808 Kit', 'Dusty Kit', 'Lo-Fi Kit', 'Sub Bass', 'Lo-Fi Keys', 'Tine Piano', 'Dub Chord'] },
  { title: 'Ambient & Textures', about: 'Slow swells, drones, shimmering washes, airport pianos and grain clouds: sounds that hang in the air.',
    sounds: ['Slow Swell Drone', 'Shimmer Wash', 'Dark Drone', 'Airport Piano', 'Halo Piano', 'Environmental Marimba', 'Grain Choir', 'Glass Cloud', 'Freeze Pad', 'Wind Grains', 'Slow Music Box', 'Dark Pad'] },
  { title: 'Cinematic Synths', about: 'The big polysynth film-score palette: swelling brass, warm strings, bells in a huge hall, choirs.',
    sounds: ['CS Brass', 'CS Strings', 'Memory Bells', 'Vowel Pad', 'Phased String Machine', 'Grain Choir', 'Dark Drone', 'Sub Bass'] },
  { title: 'Berlin School', about: 'Long pulsing sequences with slowly drifting filters, glassy arpeggios and string pads, the 70s German electronic way.',
    sounds: ['Berlin Sequence', 'Sync Sequence', 'Glass Arp', 'Saw Arp', 'CS Strings', 'Slow Swell Drone', 'Memory Bells'] },
  { title: 'Hazy Nostalgia', about: 'Warped, slightly out-of-tune tape pads and leads, worn keys and dusty drums.',
    sounds: ['Warped Tape Pad', 'Nostalgic Lead', 'Lo-Fi Keys', 'Tape Choir', 'Dusty Kit', 'Elastic Bass', 'Environmental Marimba'] },
  { title: 'Self-Playing', about: 'Hold a key or a chord and they play a pattern by themselves, in time with the song: arpeggios, hopping basses, a stepped sequence, random computer bleeps, rippling chords, a chopped pad, a bouncing ball.',
    sounds: ['Climbing Saws', 'Glass Rain', 'Chord Pulse', 'Rolling Bass', 'Thumb and Fingers', 'Saw Arp', 'Glass Arp', 'Blip Arp', 'Rubber Arp', 'Pocket Sequencer', 'Five Against Eight', 'Robot Choir', 'Morse Pad', 'Dying Console', 'Acid Steps', 'Clockwork', 'Three Against Four', 'Carousel', 'Octave Hopper', 'Staircase Sequence', 'Computer Room', 'Polyrhythm Chord', 'Gate Pad', 'Bouncing Ball', 'Pump Pad', 'Berlin Sequence'] },
  { title: 'Strange Things', about: 'Illusions and oddities: tones that rise for ever, a chord that gathers out of a cluster, a modem, clicks that sing, swarms round your head, a glass you can freeze, bells that turn into drones, a piano backwards.',
    sounds: ['Endless Riser', 'Endless Faller', 'Big Arrival', 'Dial-Up', 'Geiger Choir', 'Orbiting Bees', 'Singing Glass', 'Risset Bells', 'Backwards Piano', 'Computer Room', 'Bouncing Ball', 'Speech Shards', 'Broken Radio'] },
  { title: 'Struck, Stepped, Scattered', about: 'Sounds made with the Resonator (things that ring when struck: glasses, bars, bells, plates, a piano with bolts in it, a drum kit inside a bell), the Step sequence (melodies, rhythms and vowels that play themselves) and the Grain delay (notes that break into clouds).',
    sounds: ['Glass Harp', 'Rosewood Bars', 'Tower Bell', 'Steel Plate', 'Bowed Plate', 'Bell Tower Kit', 'Prepared Piano', 'Pocket Sequencer', 'Five Against Eight', 'Robot Choir', 'Morse Pad', 'Dying Console', 'Piano Snowfall', 'Scattered Bells', 'Stair Echo', 'Held Cloud', 'Tape Left in the Sun', 'Ghost Piano', 'Talking String', 'Acid Steps', 'Talking Drums', 'Reverse Bloom', 'Clockwork'] },
  { title: 'Things Gone Wrong', about: 'Machines misbehaving and voices that shouldn\'t exist: bells on a skipping record, a rotary speaker with a loose wire, a drum machine walking round your head, a fairground organ past its best, a singing theremin, two players who only agree twice a bar.',
    sounds: ['Stuck Bells', 'Broken Leslie', 'Beat Orbit', 'Three Against Four', 'Carousel', 'Theremin Choir', 'Talking Drums', 'Dying Console', 'Tape Left in the Sun', 'Ghost Piano', 'Broken Radio'] },
  { title: 'Grain Clouds', about: 'Recordings played as clouds of tiny grains: frozen pianos and choirs, slow-motion voices, a drum loop at any pitch, record crackle.',
    sounds: ['Frozen Piano', 'Bowed Cloud', 'Slow Motion Voice', 'Speech Shards', 'Beat Dust', 'Time Stretch Keys', 'Vinyl Dust', 'Grain Choir', 'Glass Cloud', 'Slow Music Box', 'Wind Grains', 'Crushed Grains', 'Shimmer Wash', 'Tape Choir'] },
].map(c => ({ ...c, factory: true, sounds: c.sounds.filter(n => FACTORY.some(p => p.name === n)).map(name => ({ name, mine: false })) }));

export const isCollection = p => p?.kind === 'collection';
// A collection as saved (title, up to 32 sounds, each named once).
export function collectionFile(title, sounds = [], about = '') {
  const t = String(title || 'Collection').trim().slice(0, 40) || 'Collection';
  const seen = new Set(), list = [];
  for (const s of sounds) { const k = `${!!s.mine}:${s.name}`; if (s?.name && !seen.has(k) && list.length < 32) { seen.add(k); list.push({ name: String(s.name).slice(0, 40), mine: !!s.mine }); } }
  return { format: 'mkxl-inst', version: 1, kind: 'collection', name: `Collection: ${t}`, title: t, ...(about ? { about: String(about).slice(0, 300) } : {}), sounds: list, modules: [], audio: [], mod: [] };
}
