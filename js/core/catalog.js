// Every sound Ostinato knows, across instruments, in one shape for the Sound Lab's library and the
// sound picker (core/soundpicker.js):
//   { key, instrument, name, type, bank, mine, sound }
// instrument: 'synth' (Ostinato Synth, the Lab's engine) or a device id ('xl'); sound: as in
// core/sounding.js ({ kind: 'lab', name, patch } or { kind: 'xl', name, data }).
// Types are one vocabulary for all instruments (XL types like "Pluck & Stab" become "Pluck").
import { FACTORY, typeOf } from '../lab/sounds.js';
import { storage } from './storage.js';
import { DEVICES } from './devices.js';
import { STATIC } from './mode.js';

export const INSTRUMENTS = [{ id: 'synth', name: 'Ostinato Synth' }, ...DEVICES.map(d => ({ id: d.id, name: d.name }))];
export const instrumentName = id => INSTRUMENTS.find(i => i.id === id)?.name || id;

export const TYPE_ORDER = ['Bass', 'Lead', 'Pad', 'Keys', 'Pluck', 'Bell', 'Strings', 'Brass', 'Organ', 'Synth', 'Arp', 'Drums', 'FX', 'Vocoder', 'Other'];
const XL_TYPES = { 'Bells & Mallets': 'Bell', 'Pluck & Stab': 'Pluck', 'Arp & Sequence': 'Arp', 'Drums & Hits': 'Drums', 'FX & Noise': 'FX' };
export const typeRank = t => (TYPE_ORDER.includes(t) ? TYPE_ORDER.indexOf(t) : TYPE_ORDER.length);

// Ostinato Synth's sounds: the factory bank and My Sounds (data/instruments/). Cheap; reload freely.
export async function synthSounds() {
  let mine = [];
  try { mine = await storage.list('instruments'); } catch { /* none */ }
  return [
    ...mine.map(x => ({ key: `synth:m:${x.file}`, instrument: 'synth', name: x.name, type: typeOf(x.patch), bank: 'My Sounds', mine: true,
      file: x.file, sound: { kind: 'lab', name: x.name, patch: x.patch } })),
    ...FACTORY.map(p => ({ key: `synth:f:${p.name}`, instrument: 'synth', name: p.name, type: typeOf(p), bank: 'Factory', mine: false,
      sound: { kind: 'lab', name: p.name, patch: p } })),
  ];
}

// A device's sounds (the XL's presets and My Sounds), loaded once per page; none in the travel
// version (they come from the server).
const deviceCache = new Map();
export function deviceSounds(id, { reload = false } = {}) {
  const dev = DEVICES.find(d => d.id === id);
  if (!dev?.sounds || STATIC) return Promise.resolve([]);
  if (reload) deviceCache.delete(id);
  if (!deviceCache.has(id)) {
    deviceCache.set(id, dev.sounds.load({ reload }).then(list => list.map(x => ({
      key: `${id}:${x.key}`, instrument: id, name: (x.name || '').trim() || '—', type: XL_TYPES[x.type] || x.type,
      bank: dev.sounds.bankLabel(x.bank), mine: x.bank === dev.sounds.MY_BANK, sound: { kind: id, name: (x.name || '').trim(), data: x.data },
    }))).catch(() => []));
  }
  return deviceCache.get(id);
}

// Which instruments can be heard right now: Ostinato Synth always, a device when its output is
// connected (`outputs`: the page's MIDI outputs).
export function availability(outputs = []) {
  const on = { synth: true };
  for (const d of DEVICES) on[d.id] = outputs.some(p => p.state !== 'disconnected' && d.isOut(p));
  return on;
}
