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
].map(cleanPatch);

export const FACTORY = [...STARTERS, ...MORE, ...KEYS.map(cleanPatch)];

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
].map(c => ({ ...c, factory: true, sounds: c.sounds.filter(n => FACTORY.some(p => p.name === n)).map(name => ({ name, mine: false })) }));

export const isCollection = p => p?.kind === 'collection';
// A collection as saved (title, up to 32 sounds, each named once).
export function collectionFile(title, sounds = [], about = '') {
  const t = String(title || 'Collection').trim().slice(0, 40) || 'Collection';
  const seen = new Set(), list = [];
  for (const s of sounds) { const k = `${!!s.mine}:${s.name}`; if (s?.name && !seen.has(k) && list.length < 32) { seen.add(k); list.push({ name: String(s.name).slice(0, 40), mine: !!s.mine }); } }
  return { format: 'mkxl-inst', version: 1, kind: 'collection', name: `Collection: ${t}`, title: t, ...(about ? { about: String(about).slice(0, 300) } : {}), sounds: list, modules: [], audio: [], mod: [] };
}
