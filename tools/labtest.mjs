// Offline checks for Lab patches: node tools/labtest.mjs (also run by tools/selftest.mjs)
import assert from 'node:assert/strict';
import { normalizePatch, cleanPatch, STARTERS, MODULES, toSlider, fromSlider, paramOf, formatValue, newId } from '../js/lab/patch.js';
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
console.log(`ok — Lab patches (${FACTORY.length} factory sounds)`);
