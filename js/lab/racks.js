// Built-in effect racks, mostly for the Sequencer's Master FX (the end of the chain, before the
// limiter), also offered in the Sound Lab's + Add module. Levels measured on the Demo song: each
// stays within about 1 dB of no rack, so choosing one compares its sound, not its loudness.
import { cleanRack, normalizePatch } from './patch.js';

const fx = (type, params, off) => ({ type, params, ...(off ? { off: true } : {}) });
const rack = (name, about, modules) => ({ name, about, rack: cleanRack({ name, modules }) });

export const FACTORY_RACKS = [
  rack('Glue', 'Gentle bus compression: holds the parts together without squashing them', [
    fx('compressor', { threshold: -20, ratio: 2, attack: 0.03, release: 0.25, gain: -3.5 }),
  ]),
  rack('Polish', 'A little more low end and air, a softer boxy middle, then light compression', [
    fx('eq', { low: 2, mid: -2, midfreq: 400, high: 3 }),
    fx('compressor', { threshold: -16, ratio: 2.5, attack: 0.02, release: 0.2, gain: -3.5 }),
  ]),
  rack('Warm Tape', 'Soft tube saturation with rounded highs, like mixing down to tape', [
    fx('shaper', { curve: 'tube', drive: 1.8, tone: 11000, mix: 1, level: 0.7 }),
    fx('eq', { low: 1.5, mid: 0, midfreq: 1000, high: -2 }),
  ]),
  rack('Wide', 'A slow, light chorus that spreads the mix across the speakers', [
    fx('chorus', { rate: 0.25, depth: 0.2, mix: 0.3 }),
  ]),
  rack('Room Glue', 'A short ambience that puts every part in the same room, then gentle compression', [
    fx('reverb', { type: 'ambience', size: 0.6, predelay: 5, damping: 0.6, mix: 0.15 }),
    fx('compressor', { threshold: -20, ratio: 2, attack: 0.03, release: 0.25, gain: -3 }),
  ]),
  rack('Lo-fi', 'Grainy bits, a lower sample rate and a dull top, like an old sampler', [
    fx('crusher', { bits: 9, hold: 3, mix: 0.6 }),
    fx('eq', { low: 1, mid: 1, midfreq: 1200, high: -8 }),
  ]),
];

// A rack's effects as a patch of kind 'rack' (chained, no sound of its own), as racks are saved.
export function rackPatch(name, effects) {
  const modules = effects.map((e, k) => ({ id: `fx${k + 1}`, type: e.type, params: { ...e.params }, ...(e.off ? { off: true } : {}) }));
  return normalizePatch({ name, kind: 'rack', type: 'FX', voices: 1, volume: 1, modules,
    audio: modules.map((m, k) => ({ from: m.id, to: modules[k + 1]?.id || 'out' })), mod: [], cc: {} }).patch;
}
