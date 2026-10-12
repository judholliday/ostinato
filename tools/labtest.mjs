// Offline checks for Lab patches: node tools/labtest.mjs (also run by tools/selftest.mjs)
import assert from 'node:assert/strict';
import { normalizePatch, cleanPatch, STARTERS, MODULES, toSlider, fromSlider, paramOf, formatValue, newId } from '../js/lab/patch.js';
import { FACTORY, TYPES, typeOf } from '../js/lab/sounds.js';

for (const s of FACTORY) {
  assert.deepEqual(normalizePatch(s).notes, [], `${s.name} is clean`);
  assert.ok(TYPES.includes(s.type), `${s.name} has a library type`);
}
assert.equal(new Set(FACTORY.map(s => s.name)).size, FACTORY.length, 'factory sound names are unique');
assert.equal(typeOf({ name: 'Wobble Bass', modules: [] }), 'Bass', 'type guessed from the name');
assert.equal(typeOf({ name: 'Thing', modules: [{ type: 'drums' }] }), 'Drums', 'type guessed from the modules');
assert.equal(normalizePatch({ ...STARTERS[0], type: ' Pad ' }).patch.type, 'Pad', 'type kept');
assert.deepEqual(cleanPatch(STARTERS[1]), STARTERS[1], 'normalizing twice changes nothing');

{
  const { patch, notes } = normalizePatch({
    name: '  Test  ', voices: 99, volume: 3,
    modules: [
      { id: 'osc1', type: 'osc', params: { wave: 'zigzag', octave: 9, fine: 12.4 } },
      { id: 'osc1', type: 'osc' }, // duplicate id: renamed
      { id: 'x', type: 'theremin' },
      { id: 'f', type: 'filter', params: { cutoff: 5 } },
      { id: 'amp1', type: 'amp' },
      { id: 'rev', type: 'reverb' },
      { id: 'e', type: 'env' },
    ],
    audio: [{ from: 'osc1', to: 'f' }, { from: 'f', to: 'amp1' }, { from: 'amp1', to: 'f' }, // loop
      { from: 'amp1', to: 'rev' }, { from: 'rev', to: 'f' }, // global -> voice
      { from: 'e', to: 'out' }, { from: 'rev', to: 'out' }],
    mod: [{ from: 'e', to: 'f.cutoff', amount: 99999 }, { from: 'vel', to: 'amp1.level', amount: 0.5 },
      { from: 'osc1', to: 'f.cutoff' }, { from: 'e', to: 'f.type' }],
    cc: { 74: 'f.cutoff', 75: 'f.type', 300: 'f.cutoff' },
  });
  assert.equal(patch.name, 'Test');
  assert.equal(patch.voices, 16);
  assert.equal(patch.volume, 1);
  assert.deepEqual(patch.modules.map(m => m.id), ['osc1', 'osc2', 'f', 'amp1', 'rev', 'e']);
  assert.deepEqual([patch.modules[0].params.wave, patch.modules[0].params.octave, patch.modules[0].params.fine], ['saw', 3, 12]);
  assert.equal(patch.modules[2].params.cutoff, 20);
  assert.deepEqual(patch.audio, [{ from: 'osc1', to: 'f' }, { from: 'f', to: 'amp1' }, { from: 'amp1', to: 'rev' }, { from: 'rev', to: 'out' }]);
  assert.deepEqual(patch.mod, [{ from: 'e', to: 'f.cutoff', amount: 9600 }, { from: 'vel', to: 'amp1.level', amount: 0.5 }]);
  assert.deepEqual(patch.cc, { 74: 'f.cutoff' });
  assert.ok(notes.some(n => n.includes('theremin')) && notes.some(n => n.includes('amp1 → f')));
  assert.throws(() => normalizePatch({ name: 'x' }));
  assert.ok(normalizePatch({ modules: [{ type: 'osc' }] }).notes.some(n => n.includes('output')));
}

// Sliders: log settings map evenly in octaves, and round-trip.
{
  const cutoff = paramOf('filter', 'cutoff');
  assert.ok(Math.abs(toSlider(cutoff, 632.5) - 0.5) < 0.01, 'log midpoint');
  for (const x of [0, 0.25, 0.8, 1]) assert.ok(Math.abs(toSlider(cutoff, fromSlider(cutoff, x)) - x) < 1e-9);
  assert.equal(fromSlider(paramOf('osc', 'octave'), 0.6), 1, 'stepped');
  assert.equal(formatValue(cutoff, 2400), '2.40 kHz');
  assert.equal(formatValue(paramOf('amp', 'attack'), 0.005), '5 ms');
  assert.equal(newId({ modules: [{ id: 'osc1' }, { id: 'osc3' }] }, 'osc'), 'osc2');
}
for (const [type, spec] of Object.entries(MODULES)) {
  for (const p of spec.params) assert.ok(p.kind === 'choice' ? p.choices.includes(p.def) : p.kind === 'file' ? p.def === '' : p.def >= p.min && p.def <= p.max, `${type}.${p.key} default in range`);
}
{
  // Drum kits: every pad note filled in, values clamped, variations stay in range.
  const { cleanPads, cleanPad, varyPad, KIT_NOTES, PAD_PARAMS, DEFAULT_PADS } = await import('../js/lab/drums.js');
  assert.equal(KIT_NOTES.length, 16, '16 pads');
  assert.deepEqual(Object.keys(cleanPads({})).map(Number).sort(), [...KIT_NOTES].sort(), 'a kit has every pad');
  assert.deepEqual(cleanPads(DEFAULT_PADS), cleanPads(cleanPads(DEFAULT_PADS)), 'cleaning a kit twice changes nothing');
  assert.equal(cleanPad({ t1Pitch: 1e9, nBursts: 2.6, t1Wave: 'kazoo' }, 36).t1Pitch, 5000, 'pitch clamped');
  assert.equal(cleanPad({ nBursts: 2.6 }, 39).nBursts, 3, 'bursts are whole');
  assert.equal(cleanPad({ t1Wave: 'kazoo' }, 36).t1Wave, DEFAULT_PADS[36].t1Wave, 'unknown wave → the pad\'s own');
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const n of KIT_NOTES) for (const amt of [0.15, 0.5]) {
    const v = varyPad(DEFAULT_PADS[n], amt, rnd);
    for (const p of PAD_PARAMS) if (p.kind === 'num') assert.ok(v[p.key] >= p.min && v[p.key] <= p.max, `${n} ${p.key} in range after varying`);
    for (const k of ['t1Level', 't2Level', 'nLevel']) if (DEFAULT_PADS[n][k] === 0) assert.equal(v[k], 0, 'layers that are off stay off');
  }
  const kits = FACTORY.filter(s => s.modules.some(m => m.type === 'drums'));
  assert.ok(kits.length >= 3 && kits.every(k => Object.keys(k.modules.find(m => m.type === 'drums').pads).length === 16), 'factory kits have their pads');
}
{
  // Multi-sample zones: cleaned, sorted, and the right one picked for each note.
  const { cleanZones, zoneFor } = await import('../js/lab/patch.js');
  const z = cleanZones([{ file: 'b.wav', root: 60, lo: 58, hi: 63 }, { file: 'a.wav', root: 48, lo: 0, hi: 57, loopStart: 0.4, loopEnd: 2 }, { file: '' }, null]);
  assert.deepEqual(z.map(x => x.file), ['a.wav', 'b.wav'], 'zones sorted, junk dropped');
  assert.equal(z[0].loopEnd, 1, 'loop points clamped');
  assert.equal(zoneFor(z, 50).file, 'a.wav');
  assert.equal(zoneFor(z, 60).file, 'b.wav');
  assert.equal(zoneFor(z, 100).file, 'b.wav', 'past the last zone: the nearest');
  const { patch } = normalizePatch({ modules: [{ id: 'smp1', type: 'sampler', params: {}, zones: z }], audio: [{ from: 'smp1', to: 'out' }] });
  assert.equal(patch.modules[0].zones.length, 2, 'zones kept by normalizePatch');
}
console.log(`ok — Lab patches (${FACTORY.length} factory sounds)`);
