// Factory keyboard and string sounds for Ostinato Synth: electric and acoustic pianos, a tonewheel
// organ with drawbars, other classic keys and mallets, and guitars. Plain patches (sounds.js cleans them and
// adds them to the factory bank). No DOM here.
//
// These are synthesized, so they suggest the instruments rather than copy them. The pianos,
// harpsichord, clav and guitars use the String module (a physical model of a vibrating string);
// for the real thing, a Sampler with multi-sample zones of recordings is still the way.
import { defaultParams } from './patch.js';

const mod = (type, id, params = {}) => ({ id, type, params: { ...defaultParams(type), ...params } });
const chain = (...ids) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));
const into = (froms, to) => froms.map(from => ({ from, to }));

// ---- tonewheel organ ----
// A registration is nine digits 0-8 for the drawbars 16', 5 1/3', 8', 4', 2 2/3', 2', 1 3/5', 1 1/3', 1'
// (the Drawbar organ module), through a Rotary (the Leslie), optionally driven.
const FEET = ["16'", "5⅓'", "8'", "4'", "2⅔'", "2'", "1⅗'", "1⅓'", "1'"];
function organ({ name, reg, perc = null, drive = 0, leslie = 'slow', volume = 0.6 }) {
  const bars = Object.fromEntries([...reg].map((d, k) => [`bar${k + 1}`, +d]));
  const fx = [
    ...(drive ? [mod('shaper', 'tube', { curve: 'tube', drive, tone: 5500, mix: 1, level: 0.7 })] : []),
    mod('rotary', 'leslie', { speed: leslie, wheel: 'switches speed', inertia: 1, depth: 0.75, balance: 0.55, drive: 0.15, mix: 1 }),
    mod('reverb', 'room', { type: 'room', size: 1.4, damping: 0.6, mix: 0.14 }),
  ];
  return {
    name, type: 'Organ', voices: 12, volume,
    about: `Drawbars ${[...reg].join(' ')} (${FEET.join(' ')})${perc ? `, percussion on the ${perc.harmonic} harmonic, ${perc.fast ? 'fast' : 'slow'}` : ''}. Leslie ${leslie}${leslie === 'slow' ? ': push the mod wheel up to speed it up' : ''}.`,
    modules: [mod('organ', 'organ1', { ...bars, perc: perc ? perc.harmonic : 'off', percDecay: perc?.fast === false ? 'slow' : 'fast', click: 0.35, level: 0.8 }), ...fx],
    audio: chain('organ1', ...fx.map(m => m.id), 'out'),
  };
}

export const KEYS = [
  // ---- electric pianos ----
  {
    // A tine piano (the Rhodes kind): a sine-like tone with a bell "tine" at the attack, more bark
    // the harder you play, through a stereo tremolo.
    name: 'Tine Piano', about: 'Play harder for more bark (the tine bites). Stereo tremolo, like the suitcase models.', type: 'Keys', voices: 12, volume: 0.65,
    modules: [mod('fmop', 'op1', { keytrack: 0.5, veltime: 0.4, ratio: 1, fm: 0.6, attack: 0.002, decay: 3.2, sustain: 0.25, release: 0.5, velocity: 0.85, level: 0.75 }),
      mod('fmop', 'op2', { keytrack: 0.5, veltime: 0.4, ratio: 1, fine: 2, attack: 0.001, decay: 1.4, sustain: 0.15, release: 0.4, velocity: 1, level: 0.6 }),
      mod('fmop', 'tine', { ratio: 14, attack: 0.001, decay: 0.09, sustain: 0, release: 0.05, velocity: 1, level: 0.3 }),
      mod('tremolo', 'trem1', { rate: 4.2, depth: 0.45, pan: 1 }), mod('chorus', 'chorus1', { rate: 0.5, depth: 0.3, mix: 0.2 }),
      mod('reverb', 'room', { type: 'room', size: 1.2, damping: 0.6, mix: 0.15 })],
    audio: [{ from: 'op2', to: 'op1' }, { from: 'tine', to: 'op1' }, ...chain('op1', 'trem1', 'chorus1', 'room', 'out')],
    mod: [{ from: 'vel', to: 'op1.fm', amount: 1.6 }],
  },
  {
    // A reed piano (the Wurlitzer kind): reedier and more nasal, a little overdriven when played
    // hard, with its built-in volume vibrato.
    name: 'Wurly', about: 'Reedy and a little overdriven when played hard, with the built-in volume vibrato.', type: 'Keys', voices: 12, volume: 0.8,
    modules: [mod('fmop', 'op1', { keytrack: 0.5, veltime: 0.3, ratio: 1, fm: 1.1, attack: 0.002, decay: 1.6, sustain: 0.35, release: 0.25, velocity: 0.8, level: 0.7 }),
      mod('fmop', 'op2', { keytrack: 0.5, veltime: 0.3, ratio: 1, fine: -3, attack: 0.001, decay: 0.7, sustain: 0.3, release: 0.25, velocity: 1, level: 0.7 }),
      mod('fmop', 'reed', { ratio: 3, attack: 0.001, decay: 0.15, sustain: 0, release: 0.05, velocity: 1, level: 0.25 }),
      mod('shaper', 'bark', { curve: 'tube', drive: 2.5, tone: 4500, mix: 1, level: 0.7 }), mod('tremolo', 'vib', { rate: 5.6, depth: 0.3, pan: 0 }),
      mod('reverb', 'room', { type: 'room', size: 1, damping: 0.6, mix: 0.14 })],
    audio: [{ from: 'op2', to: 'op1' }, { from: 'reed', to: 'op1' }, ...chain('op1', 'bark', 'vib', 'room', 'out')],
    mod: [{ from: 'vel', to: 'op1.fm', amount: 1.4 }],
  },
  {
    // The bright 80s FM electric piano: glassy tine on top of a warm body, with chorus.
    name: 'FM Tine 80s', about: 'The glassy FM electric piano of 80s ballads and pop.', type: 'Keys', voices: 12, volume: 0.6,
    modules: [mod('fmop', 'body', { keytrack: 0.5, veltime: 0.3, ratio: 1, fm: 0.8, attack: 0.002, decay: 2.8, sustain: 0.2, release: 0.6, velocity: 0.8, level: 0.6 }),
      mod('fmop', 'bodyMod', { ratio: 1, attack: 0.001, decay: 1.6, sustain: 0.1, release: 0.5, velocity: 0.9, level: 0.5 }),
      mod('fmop', 'glass', { keytrack: 0.5, veltime: 0.3, ratio: 1, fine: 6, fm: 1.4, attack: 0.001, decay: 1.2, sustain: 0, release: 0.4, velocity: 1, level: 0.35 }),
      mod('fmop', 'glassMod', { ratio: 14, attack: 0.001, decay: 0.3, sustain: 0, release: 0.2, velocity: 1, level: 0.6 }),
      mod('chorus', 'chorus1', { rate: 0.7, depth: 0.5, mix: 0.4 }), mod('reverb', 'hall', { type: 'plate', size: 2, mix: 0.18 })],
    audio: [{ from: 'bodyMod', to: 'body' }, { from: 'glassMod', to: 'glass' }, { from: 'body', to: 'chorus1' }, { from: 'glass', to: 'chorus1' }, ...chain('chorus1', 'hall', 'out')],
  },

  // ---- acoustic-style pianos ----
  {
    // A soft upright with felt on the hammers: two strings per note struck softly, dark and close.
    name: 'Felt Piano', about: 'A soft, close upright with felt on the hammers (physical strings): play gently, use the sustain pedal.', type: 'Keys', voices: 14, volume: 0.35,
    modules: [mod('string', 'str', { excite: 'hammer', position: 0.2, brightness: 0.25, decay: 10, highs: 1.2, keydecay: 1, stiffness: 0.6, strings: 2, detune: 1.5, coupling: 1, phantom: 0.5, knock: 0.7, release: 0.35, velocity: 0.8, level: 0.9 }),
      mod('filter', 'felt', { slope: '12', cutoff: 2600, resonance: 0.3, keytrack: 0.6 }),
      mod('resonance', 'pedal', { amount: 0.4 }), mod('soundboard', 'board', { type: 'upright', tone: 1800 }), mod('reverb', 'room', { type: 'room', size: 1.6, damping: 0.7, mix: 0.25 })],
    audio: chain('str', 'felt', 'pedal', 'board', 'room', 'out'),
  },
  {
    // A grand piano from physical strings: three per note, tuned a hair apart and coupled at the
    // bridge (a fast prompt sound, then a long aftersound), struck by a felt hammer (simulated:
    // harder blows are shorter and much brighter), stiff strings whose upper partials run sharp as
    // on a real grand, decay times measured across a grand's keyboard, the hammer's knock, and a
    // soundboard that gives them the body, bloom and width of the instrument.
    name: 'Grand Piano', about: 'Physical strings struck by felt hammers, through a soundboard: play harder for a brighter, louder tone. The sustain pedal brings in the other strings\' halo; the soft pedal (CC 67) plays una corda.', type: 'Keys', voices: 16, volume: 0.48,
    modules: [mod('string', 'str', { excite: 'hammer', position: 0.125, brightness: 0.6, decay: 14, highs: 7.8, keydecay: 1, stiffness: 0.5, strings: 3, detune: 1, coupling: 1, phantom: 1, knock: 0.5, release: 0.22, velocity: 0.85, level: 0.9 }),
      mod('resonance', 'pedal'), mod('soundboard', 'board', { type: 'grand' }), mod('reverb', 'hall', { type: 'hall', size: 2.2, damping: 0.45, mix: 0.18 })],
    audio: chain('str', 'pedal', 'board', 'hall', 'out'),
  },
  {
    // An FM acoustic piano (the 80s digital kind): two detuned carrier pairs whose modulation
    // falls away after the strike (bright then mellow), a third ratio for the hammer's edge, a
    // short noise thump, and key tracking so high notes fade sooner.
    name: 'FM Piano', about: 'An FM piano, the 80s digital kind: bright strike, mellow sustain. Compare with Grand Piano (physical strings).', type: 'Keys', voices: 16, volume: 0.3,
    modules: [mod('fmop', 'car1', { ratio: 1, fm: 1.5, attack: 0.001, decay: 4.5, sustain: 0, release: 0.35, velocity: 0.75, level: 0.6, keytrack: 0.6, veltime: 0.2 }),
      mod('fmop', 'mod1', { ratio: 1, attack: 0.001, decay: 1.1, sustain: 0.12, release: 0.3, velocity: 1, level: 0.7, keytrack: 0.6 }),
      mod('fmop', 'car2', { ratio: 1, fine: 6, fm: 1.1, attack: 0.001, decay: 3.5, sustain: 0, release: 0.35, velocity: 0.75, level: 0.4, keytrack: 0.6 }),
      mod('fmop', 'mod2', { ratio: 3, attack: 0.001, decay: 0.45, sustain: 0, release: 0.2, velocity: 1, level: 0.6, keytrack: 0.5 }),
      mod('fmop', 'edge', { ratio: 7, attack: 0.001, decay: 0.04, sustain: 0, release: 0.03, velocity: 1, level: 0.25 }),
      mod('noise', 'thump', { level: 0 }), mod('env', 'thumpEnv', { attack: 0.001, decay: 0.02, sustain: 0, release: 0.02, velocity: 0.8 }),
      mod('filter', 'thumpTone', { type: 'bandpass', slope: '12', cutoff: 900, resonance: 1, keytrack: 0.5 }),
      mod('eq', 'body', { low: 2, mid: -1, midfreq: 600, high: 1 }), mod('reverb', 'hall', { type: 'hall', size: 2.2, damping: 0.45, mix: 0.18 })],
    audio: [{ from: 'mod1', to: 'car1' }, { from: 'edge', to: 'car1' }, { from: 'mod2', to: 'car2' }, { from: 'car1', to: 'body' }, { from: 'car2', to: 'body' },
      { from: 'thump', to: 'thumpTone' }, { from: 'thumpTone', to: 'body' }, ...chain('body', 'hall', 'out')],
    mod: [{ from: 'thumpEnv', to: 'thump.level', amount: 0.3 }, { from: 'vel', to: 'car1.fm', amount: 1.2 }],
  },
  {
    // A honky-tonk upright: three strings per note badly out of tune with each other.
    name: 'Honky-Tonk', about: 'Three strings per note out of tune with each other: saloon and ragtime.', type: 'Keys', voices: 12, volume: 0.35,
    modules: [mod('string', 'str', { excite: 'hammer', position: 0.1, brightness: 0.75, decay: 9, highs: 2.5, keydecay: 1, stiffness: 0.6, strings: 3, detune: 16, coupling: 0.5, phantom: 1, knock: 0.6, release: 0.2, velocity: 0.8, level: 0.9 }),
      mod('soundboard', 'board', { type: 'upright' }), mod('reverb', 'room', { type: 'room', size: 1, damping: 0.4, mix: 0.18 })],
    audio: chain('str', 'board', 'room', 'out'),
  },

  // ---- other keys ----
  {
    // A clavinet: a short string hit near its end (thin and funky), damped the moment you let go.
    name: 'Clavinet', about: 'Play short, funky and syncopated: the string stops the moment you let go. Velocity opens the filter.', type: 'Keys', voices: 10, volume: 0.75,
    modules: [mod('string', 'str', { excite: 'pick', position: 0.05, brightness: 0.85, decay: 1.6, highs: 0.19, strings: 1, release: 0.03, velocity: 0.8, level: 0.9 }),
      mod('filter', 'pickup', { slope: '12', cutoff: 1600, resonance: 4, keytrack: 0.7 }), mod('env', 'snap', { attack: 0.001, decay: 0.2, sustain: 0.35, release: 0.05, velocity: 0.6 }),
      mod('filter', 'thin', { type: 'highpass', slope: '12', cutoff: 160, resonance: 0.5, keytrack: 0 }),
      mod('phaser', 'phase', { rate: 0.4, depth: 0.4, feedback: 0.3, mix: 0.2 })],
    audio: chain('str', 'pickup', 'thin', 'phase', 'out'),
    mod: [{ from: 'snap', to: 'pickup.cutoff', amount: 3000 }],
  },
  {
    // A harpsichord: two plucked registers (8' and 4'), quills near the end of the string, no
    // dynamics, a damper that stops the note when you let go.
    name: 'Harpsichord', about: 'Plucked strings in two registers, 8\' and 4\'. No dynamics, like the real one.', type: 'Keys', voices: 14, volume: 0.44,
    modules: [mod('string', 'eight', { excite: 'pick', position: 0.08, brightness: 0.9, decay: 4, highs: 1.6, release: 0.25, velocity: 0.1, level: 0.8 }),
      mod('string', 'four', { excite: 'pick', octave: 1, position: 0.1, brightness: 0.85, decay: 3, highs: 1.1, release: 0.2, velocity: 0.1, level: 0.4 }),
      mod('filter', 'thin', { type: 'highpass', slope: '12', cutoff: 200, resonance: 0.5, keytrack: 0.4 }),
      mod('reverb', 'hall', { type: 'hall', size: 1.8, damping: 0.4, mix: 0.2 })],
    audio: [{ from: 'eight', to: 'thin' }, { from: 'four', to: 'thin' }, ...chain('thin', 'hall', 'out')],
  },

  // ---- guitars and other strings (physical strings) ----
  {
    name: 'Nylon Guitar', about: 'A classical guitar: plucked with the fingers, warm, with a wooden body.', type: 'Pluck', voices: 8, volume: 0.64,
    modules: [mod('string', 'str', { excite: 'pluck', position: 0.18, brightness: 0.5, decay: 5, highs: 0.71, release: 0.3, velocity: 0.75, level: 0.9 }),
      mod('eq', 'body', { low: 3, mid: 2, midfreq: 250, high: -2 }), mod('reverb', 'room', { type: 'room', size: 1.3, damping: 0.6, mix: 0.18 })],
    audio: chain('str', 'body', 'room', 'out'),
  },
  {
    name: 'Steel Guitar', about: 'A steel-string acoustic, played with a pick: bright and ringing.', type: 'Pluck', voices: 8, volume: 0.63,
    modules: [mod('string', 'str', { excite: 'pick', position: 0.12, brightness: 0.75, decay: 7, highs: 1.8, stiffness: 0.05, release: 0.4, velocity: 0.7, level: 0.9 }),
      mod('eq', 'body', { low: 2, mid: -1, midfreq: 500, high: 2 }), mod('chorus', 'width', { rate: 0.3, depth: 0.2, mix: 0.15 }),
      mod('reverb', 'room', { type: 'room', size: 1.4, mix: 0.18 })],
    audio: chain('str', 'body', 'width', 'room', 'out'),
  },
  {
    name: '12-String Guitar', about: 'Each note doubled an octave up (and the pairs slightly apart): shimmering strummed chords.', type: 'Pluck', voices: 12, volume: 0.7,
    modules: [mod('string', 'low', { excite: 'pick', position: 0.12, brightness: 0.7, decay: 5, highs: 1.2, strings: 2, detune: 5, release: 0.4, velocity: 0.7, level: 0.8 }),
      mod('string', 'high', { excite: 'pick', octave: 1, position: 0.14, brightness: 0.75, decay: 4, highs: 0.87, release: 0.35, velocity: 0.7, level: 0.45 }),
      mod('eq', 'body', { low: 1, high: 2 }), mod('reverb', 'room', { type: 'room', size: 1.5, mix: 0.2 })],
    audio: [{ from: 'low', to: 'body' }, { from: 'high', to: 'body' }, ...chain('body', 'room', 'out')],
  },
  {
    name: 'Clean Electric', about: 'A clean electric guitar with chorus and a slap of echo.', type: 'Pluck', voices: 8, volume: 0.8,
    modules: [mod('string', 'str', { excite: 'pick', position: 0.09, brightness: 0.65, decay: 5, highs: 1.1, release: 0.15, velocity: 0.7, level: 0.9 }),
      mod('filter', 'pickup', { slope: '12', cutoff: 3500, resonance: 1.5, keytrack: 0.3 }),
      mod('chorus', 'chorus1', { rate: 0.6, depth: 0.5, mix: 0.4 }), mod('delay', 'slap', { time: 0.11, feedback: 0.15, mix: 0.15 }), mod('reverb', 'spring', { type: 'plate', size: 1.4, mix: 0.15 })],
    audio: chain('str', 'pickup', 'chorus1', 'slap', 'spring', 'out'),
  },
  {
    name: 'Overdrive Guitar', about: 'A driven electric for riffs and solos: one note at a time, sliding between notes you play legato.', type: 'Lead', voices: 1, volume: 0.8,
    play: 'legato', glide: 0.03,
    modules: [mod('string', 'str', { excite: 'pick', position: 0.1, brightness: 0.75, decay: 12, highs: 3.5, release: 0.12, velocity: 0.6, level: 0.9 }),
      mod('shaper', 'amp', { curve: 'tube', drive: 14, tone: 4200, mix: 1, level: 0.6 }), mod('eq', 'cab', { low: 2, mid: 3, midfreq: 900, high: -6 }),
      mod('delay', 'echo', { time: 0.38, feedback: 0.25, mix: 0.15 }), mod('reverb', 'room', { type: 'room', size: 1.4, mix: 0.15 })],
    audio: chain('str', 'amp', 'cab', 'echo', 'room', 'out'),
  },
  {
    name: 'Harp', about: 'Plucked in the middle of the string, ringing long: arpeggios and glissandos.', type: 'Pluck', voices: 16, volume: 0.65,
    modules: [mod('string', 'str', { excite: 'pluck', position: 0.33, brightness: 0.45, decay: 7, highs: 1.5, release: 2.5, velocity: 0.75, level: 0.9 }),
      mod('reverb', 'hall', { type: 'hall', size: 3, mix: 0.3 })],
    audio: chain('str', 'hall', 'out'),
  },
  {
    name: 'Finger Bass', about: 'An electric bass played with the fingers: round, one note at a time.', type: 'Bass', voices: 1, volume: 0.6, play: 'mono',
    modules: [mod('string', 'str', { excite: 'pluck', octave: 0, position: 0.2, brightness: 0.45, decay: 3, highs: 0.26, release: 0.08, velocity: 0.7, level: 1 }),
      mod('eq', 'tone', { low: 3, mid: 1, midfreq: 700, high: -4 }), mod('compressor', 'comp', { threshold: -20, ratio: 4, gain: 4 })],
    audio: chain('str', 'tone', 'comp', 'out'),
  },

  // ---- organs ----
  organ({ name: 'B3 Jazz', reg: '888000000', perc: { harmonic: 'third', fast: true }, leslie: 'slow', volume: 0.6 }),
  organ({ name: 'B3 Gospel', reg: '888808008', leslie: 'fast', drive: 2, volume: 0.5 }),
  organ({ name: 'B3 Rock Drive', reg: '888800000', perc: { harmonic: 'second', fast: false }, leslie: 'slow', drive: 9, volume: 0.45 }),
  organ({ name: 'B3 Ballad', reg: '838000000', leslie: 'slow', volume: 0.7 }),
  {
    // A transistor combo organ (the 60s kind): bright, buzzy square and saw voices with vibrato.
    name: 'Combo Organ', about: '60s garage and ska organ, with vibrato.', type: 'Organ', voices: 10, volume: 0.45,
    modules: [mod('osc', 'flute', { wave: 'square', level: 0.4 }), mod('osc', 'reed', { wave: 'saw', octave: 1, level: 0.25 }), mod('osc', 'bass', { wave: 'square', octave: -1, level: 0.2 }),
      mod('lfo', 'vib', { rate: 6.5, depth: 1 }), mod('filter', 'tone', { slope: '12', cutoff: 3800, resonance: 1, keytrack: 0.5 }),
      mod('amp', 'amp1', { attack: 0.003, decay: 0.1, sustain: 1, release: 0.03, velocity: 0 }), mod('reverb', 'room', { type: 'room', size: 1.2, mix: 0.18 })],
    audio: [...into(['flute', 'reed', 'bass'], 'tone'), ...chain('tone', 'amp1', 'room', 'out')],
    mod: ['flute', 'reed', 'bass'].map(id => ({ from: 'vib', to: `${id}.pitch`, amount: 14 })),
  },
  {
    // A church pipe organ: flue pipes at 8', 4', 2' and a 16' bourdon, speaking slowly into a big room.
    name: 'Church Organ', about: 'Pipes at 16\', 8\', 4\' and 2\' in a big room. Hold chords; it speaks slowly.', type: 'Organ', voices: 12, volume: 0.5,
    modules: [mod('osc', 'p16', { wave: 'sine', octave: -1, level: 0.4 }), mod('osc', 'p8', { wave: 'triangle', level: 0.45 }),
      mod('osc', 'p4', { wave: 'triangle', octave: 1, level: 0.25 }), mod('osc', 'p2', { wave: 'sine', octave: 2, level: 0.15 }),
      mod('osc', 'mix', { wave: 'saw', octave: 1, semi: 7, level: 0.06 }),
      mod('noise', 'wind', { level: 0.015 }), mod('filter', 'tone', { slope: '12', cutoff: 4000, resonance: 0.5, keytrack: 0.4 }),
      mod('amp', 'amp1', { attack: 0.09, decay: 0.2, sustain: 1, release: 0.25, velocity: 0 }),
      mod('reverb', 'cathedral', { type: 'hall', size: 7, predelay: 40, damping: 0.4, mix: 0.45 })],
    audio: [...into(['p16', 'p8', 'p4', 'p2', 'mix', 'wind'], 'tone'), ...chain('tone', 'amp1', 'cathedral', 'out')],
  },
  {
    // An accordion: two reeds per note tuned slightly apart (the "musette" wobble), breathy.
    name: 'Accordion', about: 'Two reeds tuned apart (musette).', type: 'Organ', voices: 10, volume: 0.45,
    modules: [mod('osc', 'reed1', { wave: 'saw', level: 0.4 }), mod('osc', 'reed2', { wave: 'saw', fine: 12, level: 0.35 }), mod('osc', 'reed3', { wave: 'pulse', pw: 0.3, octave: -1, level: 0.2 }),
      mod('filter', 'box', { type: 'bandpass', slope: '12', cutoff: 1400, resonance: 1.2, keytrack: 0.6 }), mod('filter', 'tone', { slope: '12', cutoff: 3500, resonance: 0.5, keytrack: 0.4 }),
      mod('amp', 'amp1', { attack: 0.04, decay: 0.2, sustain: 0.9, release: 0.12, velocity: 0.5 }), mod('reverb', 'room', { type: 'room', size: 1, mix: 0.15 })],
    audio: [...into(['reed1', 'reed2', 'reed3'], 'box'), ...into(['reed1', 'reed2', 'reed3'], 'tone'), { from: 'box', to: 'amp1' }, { from: 'tone', to: 'amp1' }, ...chain('amp1', 'room', 'out')],
  },

  // ---- mallets ----
  {
    // A vibraphone: pure metal bars with a long ring and the motor's slow tremolo.
    name: 'Vibraphone', about: 'Long ringing bars with the motor tremolo; use the sustain pedal.', type: 'Bell', voices: 12, volume: 0.75,
    modules: [mod('fmop', 'bar', { keytrack: 0.4, ratio: 1, fm: 0.35, attack: 0.001, decay: 3.5, sustain: 0, release: 1.2, velocity: 0.8, level: 0.7 }),
      mod('fmop', 'barMod', { ratio: 4, attack: 0.001, decay: 0.25, sustain: 0, release: 0.2, velocity: 1, level: 0.6 }),
      mod('tremolo', 'motor', { rate: 5, depth: 0.4, pan: 0.3 }), mod('reverb', 'room', { type: 'plate', size: 2, mix: 0.22 })],
    audio: [{ from: 'barMod', to: 'bar' }, ...chain('bar', 'motor', 'room', 'out')],
  },
  {
    // A marimba: a woody knock with a short, hollow tone (the resonator tubes).
    name: 'Marimba', about: 'Woody and short: good for fast patterns.', type: 'Bell', voices: 12, volume: 0.6,
    modules: [mod('fmop', 'bar', { keytrack: 0.6, ratio: 1, fm: 0.5, attack: 0.001, decay: 0.7, sustain: 0, release: 0.3, velocity: 0.8, level: 0.75 }),
      mod('fmop', 'knock', { ratio: 10, attack: 0.001, decay: 0.03, sustain: 0, release: 0.02, velocity: 1, level: 0.7 }),
      mod('osc', 'tube', { wave: 'sine', octave: 2, level: 0 }), mod('env', 'tubeEnv', { attack: 0.001, decay: 0.12, sustain: 0, release: 0.05 }),
      mod('reverb', 'room', { type: 'room', size: 1.2, mix: 0.18 })],
    audio: [{ from: 'knock', to: 'bar' }, { from: 'bar', to: 'room' }, { from: 'tube', to: 'room' }, { from: 'room', to: 'out' }],
    mod: [{ from: 'tubeEnv', to: 'tube.level', amount: 0.25 }],
  },
  {
    // A toy piano: struck metal rods, bright, clangy and a little out of tune.
    name: 'Toy Piano', about: 'Clangy and slightly out of tune.', type: 'Bell', voices: 10, volume: 0.7,
    modules: [mod('fmop', 'rod', { keytrack: 0.5, ratio: 1, fm: 2.2, attack: 0.001, decay: 1.2, sustain: 0, release: 0.4, velocity: 0.7, level: 0.6 }),
      mod('fmop', 'rodMod', { ratio: 3.5, fine: 12, attack: 0.001, decay: 0.5, sustain: 0, release: 0.3, velocity: 1, level: 0.6 }),
      mod('filter', 'thin', { type: 'highpass', slope: '12', cutoff: 350, resonance: 0.5, keytrack: 0.3 }), mod('reverb', 'room', { type: 'room', size: 0.8, mix: 0.15 })],
    audio: [{ from: 'rodMod', to: 'rod' }, ...chain('rod', 'thin', 'room', 'out')],
  },
];
