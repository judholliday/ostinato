// Offline checks for Lab patches: node tools/labtest.mjs (also run by tools/selftest.mjs)
import assert from 'node:assert/strict';
import { normalizePatch, cleanPatch, STARTERS, MODULES, toSlider, fromSlider, paramOf, formatValue, newId, SYNC, syncBeats, VOWELS } from '../js/lab/patch.js';
import { FACTORY, TYPES, typeOf } from '../js/lab/sounds.js';
import { heardModules } from '../js/lab/patchview.js';

for (const s of FACTORY) {
  assert.deepEqual(normalizePatch(s).notes, [], `${s.name} is clean`);
  const heard = heardModules(s);
  for (const m of s.modules) assert.ok(heard.has(m.id), `${s.name}: ${m.id} can be heard (nothing dropped, e.g. an effect wired into a per-note module)`);
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
{
  // The arpeggiator: settings cleaned, and the order of notes for each mode.
  const { cleanArp, arpOrder } = await import('../js/lab/patch.js');
  assert.equal(cleanArp({ mode: 'sideways' }), null, 'unknown mode = off');
  assert.deepEqual(cleanArp({ mode: 'up', rate: '1/3', octaves: 9, gate: 7 }), { mode: 'up', rate: '1/16', octaves: 4, gate: 1 });
  assert.equal(normalizePatch({ ...STARTERS[0], arp: { mode: 'off' } }).patch.arp, undefined, 'off is not stored');
  assert.deepEqual(normalizePatch({ ...STARTERS[0], arp: { mode: 'down' } }).patch.arp, { mode: 'down', rate: '1/16', octaves: 1, gate: 0.6 });
  assert.equal(cleanArp({ mode: 'up', latch: true }).latch, true, 'latch kept');
  assert.ok(!('latch' in cleanArp({ mode: 'up', latch: 'yes' })), 'latch only when true');
  const held = [{ note: 64, vel: 90, seq: 0 }, { note: 60, vel: 100, seq: 1 }, { note: 67, vel: 80, seq: 2 }];
  const notes = (mode, octaves = 1) => arpOrder(held, { mode, octaves }).map(n => n.note);
  assert.deepEqual(notes('up'), [60, 64, 67]);
  assert.deepEqual(notes('down'), [67, 64, 60]);
  assert.deepEqual(notes('up-down'), [60, 64, 67, 64], 'the top and bottom notes aren\'t repeated');
  assert.deepEqual(notes('played'), [64, 60, 67]);
  assert.deepEqual(notes('up', 2), [60, 64, 67, 72, 76, 79]);
  assert.deepEqual(notes('up-down', 2), [60, 64, 67, 72, 76, 79, 76, 72, 67, 64]);
  assert.deepEqual(arpOrder([{ note: 120, vel: 1, seq: 0 }], { mode: 'up', octaves: 3 }).map(n => n.note), [120], 'no notes above 127');
  assert.equal(arpOrder(held, { mode: 'up', octaves: 1 })[0].vel, 100, 'each note keeps its velocity');
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
{
  // A pad's sound: a cleaned copy of another patch; a sound inside it can't carry pad sounds of its own.
  const inner = { name: 'Inner', modules: [{ id: 'd', type: 'drums', params: {}, pads: { 36: { lSound: { name: 'X', patch: STARTERS[0] } } } }], audio: [{ from: 'd', to: 'out' }] };
  const { patch } = normalizePatch({ modules: [{ id: 'd', type: 'drums', params: {}, pads: { 38: { lSound: { name: 'Inner', patch: inner }, lNote: 200 } } }], audio: [{ from: 'd', to: 'out' }] });
  const pad = patch.modules[0].pads[38];
  assert.equal(pad.lSound.name, 'Inner', 'pad sound kept');
  assert.equal(pad.lNote, 96, 'pad note clamped');
  assert.equal(pad.lSound.patch.modules[0].pads[36].lSound, null, 'no sounds inside a pad sound');
  assert.equal(patch.modules[0].pads[36].lSound, null, 'pads without a sound have none');
  assert.equal(normalizePatch({ modules: [{ type: 'drums', pads: { 38: { lSound: { patch: 'junk' } } } }] }).patch.modules[0].pads[38].lSound, null, 'a broken pad sound is dropped');
}
{
  // Effect racks: only effects inside (no racks in racks), cleaned settings, and a saved rack keeps its kind.
  const { cleanRack, MAX_RACK } = await import('../js/lab/patch.js');
  const r = cleanRack({ name: ' Space ', modules: [{ type: 'delay', params: { time: 99 } }, { type: 'osc' }, { type: 'rack' }, { type: 'reverb', off: 1 }] });
  assert.deepEqual(r.modules.map(m => m.type), ['delay', 'reverb']);
  assert.equal(r.name, 'Space');
  assert.equal(r.modules[0].params.time, 2, 'settings clamped');
  assert.equal(r.modules[1].off, true);
  assert.equal(cleanRack({ modules: Array(20).fill({ type: 'eq' }) }).modules.length, MAX_RACK);
  const { patch } = normalizePatch({ name: 'R', kind: 'rack', modules: [{ id: 'rack1', type: 'rack', params: { mix: 3 }, rack: r }], audio: [{ from: 'rack1', to: 'out' }] });
  assert.equal(patch.kind, 'rack');
  assert.equal(patch.modules[0].params.mix, 1);
  assert.equal(patch.modules[0].rack.modules.length, 2);
}
{
  // Play modes and glide; envelope key tracking and velocity settings.
  const base = { modules: [{ id: 'o', type: 'osc' }, { id: 'a', type: 'amp' }, { id: 'e', type: 'env' }], audio: [{ from: 'o', to: 'a' }, { from: 'a', to: 'out' }] };
  assert.deepEqual([normalizePatch({ ...base, play: 'legato', glide: 9 }).patch.play, normalizePatch({ ...base, play: 'legato', glide: 9 }).patch.glide], ['legato', 2]);
  const plain = normalizePatch({ ...base, play: 'poly', glide: 0 }).patch;
  assert.ok(!('play' in plain) && !('glide' in plain), 'poly and no glide are left out');
  assert.equal(normalizePatch({ ...base, play: 'nope' }).patch.play, undefined);
  const { patch } = normalizePatch(base);
  assert.deepEqual([patch.modules[1].params.keytrack, patch.modules[1].params.veltime, patch.modules[2].params.velocity], [0, 0, 0], 'new settings default to off');
  assert.ok(FACTORY.some(s => s.play === 'legato' && s.glide > 0) && FACTORY.some(s => s.modules.some(m => m.params.keytrack > 0 && m.type === 'amp')), 'factory sounds use them');
}
{
  // Effects can be modulated only from global sources (the wheel, a Global LFO).
  const raw = { modules: [{ id: 'o', type: 'organ' }, { id: 'r', type: 'rotary' }, { id: 'g', type: 'glfo' }, { id: 'l', type: 'lfo' }, { id: 'd', type: 'delay' }],
    audio: [{ from: 'o', to: 'r' }, { from: 'r', to: 'd' }, { from: 'd', to: 'out' }],
    mod: [{ from: 'g', to: 'd.mix', amount: 0.5 }, { from: 'wheel', to: 'r.speed', amount: 1 }, { from: 'l', to: 'd.mix', amount: 0.5 }, { from: 'l', to: 'o.pitch', amount: 20 }] };
  const { patch, notes } = normalizePatch(raw);
  assert.deepEqual(patch.mod.map(m => `${m.from}>${m.to}`), ['g>d.mix', 'wheel>r.speed', 'l>o.pitch']);
  assert.equal(notes.length, 1, 'the per-note LFO into an effect is left out, with a note');
  assert.deepEqual(['bar1', 'bar3', 'bar4', 'perc'].map(k => patch.modules[0].params[k]), [8, 8, 0, 'off'], 'organ defaults: 888000000');
  const { RACK_EFFECTS } = await import('../js/lab/patch.js');
  assert.ok(RACK_EFFECTS.includes('rotary') && !RACK_EFFECTS.includes('glfo'), 'the rotary can go in racks; the Global LFO can\'t');
}
{
  // Resonator shapes, step sequences and the Grain delay.
  const { resonatorRatios, RES_SHAPES, stepCurve, RACK_EFFECTS } = await import('../js/lab/patch.js');
  for (const s of RES_SHAPES) {
    const r = resonatorRatios(s);
    assert.ok(r.length >= 10 && r.every((v, i) => v > 0 && (!i || v > r[i - 1])), `${s}: partials rise`);
  }
  assert.deepEqual(resonatorRatios('tube', 3), [1, 3, 5]);
  assert.ok(Math.abs(resonatorRatios('bar', 2)[1] - 2.757) < 0.002, 'a free bar\'s second partial');
  assert.deepEqual([...stepCurve({ length: 2, glide: 0.5, s1: 12, s2: -12, s3: 5 }, 4)], [1, 1, 1, 0, -1, -1, -1, 0], 'steps hold, then slide to the next (the last to the first)');
  assert.equal(stepCurve({ length: 99, glide: 0 }, 2).length, 32, 'at most 16 steps');
  const raw = { modules: [{ id: 'n', type: 'noise' }, { id: 'r', type: 'resonator', params: { shape: 'gong', note: 500 } }, { id: 's', type: 'seq', params: { s1: 40, length: 3.4 } },
    { id: 'gs', type: 'gseq' }, { id: 'g', type: 'grains', params: { hold: 'maybe' } }],
    audio: [{ from: 'n', to: 'r' }, { from: 'r', to: 'g' }, { from: 'g', to: 'out' }],
    mod: [{ from: 's', to: 'r.pitch', amount: 1200 }, { from: 'gs', to: 'g.pitch', amount: 12 }, { from: 's', to: 'g.pitch', amount: 12 }, { from: 'gs', to: 'r.pitch', amount: 100 }] };
  const { patch, notes } = normalizePatch(raw);
  assert.deepEqual([patch.modules[1].params.shape, patch.modules[1].params.note, patch.modules[2].params.s1, patch.modules[2].params.length, patch.modules[4].params.hold], ['bar', 108, 12, 3, 'off']);
  assert.deepEqual(patch.mod.map(m => `${m.from}>${m.to}`), ['s>r.pitch', 'gs>g.pitch', 'gs>r.pitch'], 'a per-note step sequence can\'t move an effect; a global one can move anything');
  assert.equal(notes.length, 1);
  assert.ok(RACK_EFFECTS.includes('grains') && !RACK_EFFECTS.includes('gseq') && !RACK_EFFECTS.includes('resonator'));
}
{
  // The soundboard: finite, wide above 300 Hz, and its sides cancel in mono (left = mid + side,
  // right = mid − side).
  const { soundboardImpulse } = await import('../js/lab/engine.js');
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const [L, R] = soundboardImpulse(44100, { type: 'grand', width: 0.7 }, null, rnd);
  assert.ok(L.every(Number.isFinite) && R.every(Number.isFinite) && L.length === R.length, 'soundboard response is finite');
  let mid = 0, side = 0;
  for (let i = 0; i < L.length; i++) { mid += ((L[i] + R[i]) / 2) ** 2; side += ((L[i] - R[i]) / 2) ** 2; }
  assert.ok(side > 0.05 * mid && side < mid, 'the soundboard is wide but mostly in the middle');
}
{
  // The string worklet (run here with stand-ins for the AudioWorklet globals): the dispersion
  // filter puts a grand's partials where its inharmonicity says, and the hammer gets shorter and
  // stronger the harder it's played.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/lab/fxworklet.js', import.meta.url), 'utf8');
  const code = src.slice(src.indexOf('`') + 1, src.indexOf('`;'));
  const g = { sampleRate: 44100 };
  new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', 'out', code + '\nObject.assign(out, { dispersion, pianoB, hammerForce });')(44100, class { constructor() { this.port = {}; } }, (n, c) => { g[n] = c; }, g);
  for (const note of [36, 48, 60, 72, 84]) {
    const d = g.dispersion(440 * 2 ** ((note - 69) / 12), g.pianoB(note));
    assert.ok(d.M > 0 && d.e < 5, `note ${note}: partials within 5 cents rms of a grand's (${d.e.toFixed(2)}, ${d.M} stages)`);
  }
  const soft = g.hammerForce(261.6, 0.3, { strings: 3, velocity: 0.85 }), hard = g.hammerForce(261.6, 1, { strings: 3, velocity: 0.85 });
  assert.ok(hard.contact < soft.contact && hard.peak > 3 * soft.peak, 'harder hammer blows are shorter and stronger');
  assert.ok(soft.contact > 0.0012 && soft.contact < 0.003, 'C4 hammer contact about 1.5-2 ms');
  // Coupled strings: a fast prompt sound, then an aftersound decaying at the Decay setting's rate.
  const level = (opts, secs = 6) => {
    globalThis.currentFrame = 0;
    const v = new g['ost-string']({ processorOptions: { excite: 'hammer', position: 0.125, decay: 13.5, highs: 7.6, keydecay: 1, stiffness: 0.5, strings: 3, detune: 1, velocity: 0.85, freq: 261.6, start: 0, vel: 0.6, ...opts } });
    const out = [], ch = new Float32Array(128);
    for (let f = 0; f < 44100 * secs; f += 128) { globalThis.currentFrame = f; v.process([], [[ch]], { detune: [0], damp: [0] }); out.push(ch.reduce((a, x) => a + x * x, 0)); }
    const db = t => { const i = Math.round(t * 44100 / 128); let e = 0; for (let k = i; k < i + 34; k++) e += out[k]; return 10 * Math.log10(e); };
    return { early: db(0.05) - db(1), late: (db(3) - db(5.5)) / 2.5 };
  };
  // (Detuning and strike times are random per note: seeded here, and averaged over three notes.)
  const random = Math.random;
  let seed = 3; Math.random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const avg = opts => { const r = [0, 1, 2].map(() => level(opts)); return { early: r.reduce((a, x) => a + x.early, 0) / 3, late: r.reduce((a, x) => a + x.late, 0) / 3 }; };
  const loose = avg({ coupling: 0 }), coupled = avg({ coupling: 1 });
  // The damper stops the note: 30+ dB down 0.3 s after the key is let go (Damper 0.22 s).
  {
    globalThis.currentFrame = 0;
    const v = new g['ost-string']({ processorOptions: { excite: 'hammer', position: 0.125, decay: 13.5, highs: 7.6, stiffness: 0.5, strings: 3, detune: 1, coupling: 1, release: 0.22, velocity: 0.85, freq: 261.6, start: 0, vel: 0.6 } });
    const e = [], ch = new Float32Array(128);
    for (let f = 0; f < 44100 * 1.4; f += 128) { globalThis.currentFrame = f; v.process([], [[ch]], { detune: [0], damp: [f >= 44100 ? 1 : 0] }); e.push(ch.reduce((a, x) => a + x * x, 0)); }
    const db = t => 10 * Math.log10(e.slice(Math.round(t * 344.5), Math.round(t * 344.5) + 17).reduce((a, x) => a + x, 0));
    assert.ok(db(0.95) - db(1.3) > 30, `the damper stops the note (${(db(0.95) - db(1.3)).toFixed(1)} dB in 0.3 s)`);
  }
  // Una corda: a little quieter, not silent (the string that isn't struck picks up the others).
  {
    const peak = unacorda => { globalThis.currentFrame = 0; const v = new g['ost-string']({ processorOptions: { excite: 'hammer', decay: 13.5, strings: 3, detune: 1, coupling: 1, freq: 261.6, start: 0, vel: 0.6, unacorda } }); let m = 0; const ch = new Float32Array(128); for (let f = 0; f < 44100; f += 128) { globalThis.currentFrame = f; v.process([], [[ch]], { detune: [0], damp: [0] }); for (const x of ch) m = Math.max(m, Math.abs(x)); } return m; };
    const ratio = 20 * Math.log10(peak(true) / peak(false));
    assert.ok(ratio < 0.5 && ratio > -6, `una corda is a little quieter (${ratio.toFixed(1)} dB)`);
  }
  Math.random = random;
  // Pedal resonance: silent with the pedal up, ringing on after the input stops with it down.
  {
    const R = g['ost-resonance'];
    const run = (pedal, held = 0) => {
      const r = new R();
      const tone = Float32Array.from({ length: 128 }, (_, i) => Math.sin(2 * Math.PI * 261.6 * i / 44100) * 0.3), quiet = new Float32Array(128);
      const o0 = new Float32Array(128), o1 = new Float32Array(128); let after = 0;
      const prm = { amount: [0.5], ring: [1], pedal: [pedal], held0: [held], held1: [held], held2: [held], held3: [held] };
      for (let b = 0; b < 700; b++) { r.process([[b < 344 ? tone : quiet]], [[o0, o1]], prm); if (b > 400) after += o0.reduce((a, x) => a + x * x, 0); }
      return after;
    };
    assert.equal(run(0), 0, 'pedal up: the other strings are damped');
    assert.equal(run(1, 2 ** 22 - 1), 0, 'strings of notes that are sounding are left out (held bits)');
    assert.ok(run(1) > 0, 'pedal down: they ring on after the note');
  }
  assert.ok(coupled.early > loose.early + 2, `coupling makes the prompt sound fall faster (${coupled.early.toFixed(1)} vs ${loose.early.toFixed(1)} dB in 1 s)`);
  assert.ok(coupled.late > 2.5 && coupled.late < 9, `the aftersound decays near 60/13.5 = 4.4 dB/s (${coupled.late.toFixed(1)})`);
}
// Tempo sync note lengths (beats), and every choice parses; the vowel table is complete.
assert.deepEqual(['1/1', '1/4', '1/8.', '1/8t', '1/16', '4/1'].map(syncBeats), [4, 1, 0.75, 1 / 3, 0.25, 16]);
assert.ok(SYNC.every(v => v === 'off' || syncBeats(v) > 0) && syncBeats('off') === 0);
assert.ok(VOWELS.length === 5 && VOWELS.every(f => f.length === 3 && f[0] < f[1] && f[1] < f[2]));
// Old patches get the new settings' defaults (no unison, no sync).
{
  const p = cleanPatch({ name: 'Old', modules: [{ id: 'o', type: 'osc', params: { wave: 'saw' } }, { id: 'l', type: 'lfo', params: { rate: 3 } }], audio: [{ from: 'o', to: 'out' }], mod: [] });
  assert.deepEqual([p.modules[0].params.unison, p.modules[1].params.sync, p.modules[1].params.rate], [1, 'off', 3]);
}
{
  // The Piano module: its data (pianos/, made by tools/piano) is whole, a key press takes the nearest
  // fitted note at most a semitone and a half away, softer playing is quieter and duller, and the
  // worklet's resonators ring at the frequency, level and decay they're given.
  const { readFileSync, statSync } = await import('node:fs');
  const data = JSON.parse(readFileSync(new URL('../pianos/steinway-b.json', import.meta.url), 'utf8'));
  const frames = statSync(new URL('../pianos/steinway-b.strikes', import.meta.url)).size / 4;
  assert.equal(data.notes.length, 30);
  for (const d of data.notes) {
    assert.ok(d.modes.length % 7 === 0 && d.modes.length > 0 && d.modes.every(Number.isFinite), `piano note ${d.note}: modes`);
    assert.ok(Math.abs(1200 * Math.log2(d.f0 / (440 * 2 ** ((d.note - 69) / 12)))) < 60, `piano note ${d.note}: in tune`);
    for (const s of [d.ff, d.pp]) if (s) assert.ok(s[0] >= 0 && s[0] + s[1] <= frames && s[2] > 0, `piano note ${d.note}: strike inside the file`);
    assert.ok(d.ff && d.soft < -10 && d.soft > -40, `piano note ${d.note}: a loud strike, and soft is 10-40 dB quieter`);
  }
  const { pianoNote } = await import('../js/lab/engine.js');
  const piano = { notes: data.notes.map(d => ({ ...d, cents: 1200 * Math.log2(d.f0 / (440 * 2 ** ((d.note - 69) / 12))), count: d.modes.length / 7 })), strikes: new Map(data.notes.map(d => [d.note, { ff: {}, pp: d.pp ? {} : null }])) };
  const energy = v => { let e = 0, hi = 0; for (let i = 0; i < v.modes.length; i += 6) { const a = v.modes[i + 2] ** 2 + v.modes[i + 4] ** 2; e += a; if (v.modes[i] > 2000) hi += a; } return [e, hi / e]; };
  for (let note = 21; note <= 108; note++) {
    const v = pianoNote(piano, note, 100);
    assert.ok(Math.abs(Math.log2(v.ratio)) < 1.6 / 12, `key ${note}: moved ${(12 * Math.log2(v.ratio)).toFixed(2)} semitones`);
  }
  const loud = energy(pianoNote(piano, 60, 120)), soft = energy(pianoNote(piano, 60, 30));
  assert.ok(10 * Math.log10(loud[0] / soft[0]) > 15 && soft[1] < loud[1], 'played softly, middle C is over 15 dB quieter and has less above 2 kHz');
  assert.ok(pianoNote(piano, 60, 64).damper > 0 && pianoNote(piano, 96, 64).damper === 0, 'dampers up to E6, none in the top octaves');
  const felt = energy(pianoNote(piano, 60, 120, { hardness: 0.2 }));
  assert.ok(Math.abs(10 * Math.log10(felt[0] / loud[0])) < 6 && felt[1] < loud[1] / 2, 'a soft hammer: about as loud, under half as much above 2 kHz');
  const honky = pianoNote(piano, 60, 100, { detune: 14 }), plain = pianoNote(piano, 60, 100);
  assert.equal(honky.modes.length, plain.modes.length * 3, 'out of tune: three strings');
  assert.ok(Math.abs(1200 * Math.log2(honky.modes[0] / plain.modes[0])) > 5 && Math.abs(1200 * Math.log2(honky.modes[0] / plain.modes[0])) < 25, 'tuned 5-25 cents off');
  const src = readFileSync(new URL('../js/lab/fxworklet.js', import.meta.url), 'utf8');
  const g = {};
  globalThis.currentFrame = 0;
  new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', src.slice(src.indexOf('`') + 1, src.indexOf('`;')))(44100, class { constructor() { this.port = {}; } }, (n, c) => { g[n] = c; });
  const v = new g['ost-piano']({ processorOptions: { modes: new Float64Array([441, 3, 0.25, 0, 0.125, 0]), start: 0, ramp: 0, damper: 0.2 } });
  const L = new Float32Array(44100), R = new Float32Array(44100);
  const run = (from, to, damp) => { for (let f = from; f < to; f += 128) { globalThis.currentFrame = f; const l = new Float32Array(128), r = new Float32Array(128); v.process([], [[l, r]], { damp: [damp] }); L.set(l.subarray(0, Math.min(128, 44100 - f)), f); R.set(r.subarray(0, Math.min(128, 44100 - f)), f); } };
  run(0, 22016, 0); run(22016, 44100, 1);
  assert.ok(Math.abs(L[0] - 0.5) < 1e-6 && Math.abs(R[0] - 0.25) < 1e-6, 'a mode starts at twice its amplitude (cosine), per channel');
  assert.ok(Math.abs(L[4410] - 0.5 * Math.exp(-0.3) * Math.cos(2 * Math.PI * 441 * 0.1)) < 1e-4, 'and rings at its frequency and decay rate');
  let late = 0; for (let i = 39000; i < 44100; i++) late = Math.max(late, Math.abs(L[i]));
  assert.ok(late < 1e-4, 'the damper stops it (60 dB in its time)');
}
console.log(`ok — Lab patches (${FACTORY.length} factory sounds)`);
