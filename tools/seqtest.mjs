// Offline checks for the sequencer model and timing engine: node tools/seqtest.mjs
// (also run by tools/selftest.mjs)
import assert from 'node:assert/strict';
import { autoValue, normalizeSong, newSong, newTrack, putStep, removeStep, stepAt, coverMap, maxLen, noteSteps, rollNotes, setRollNotes, mapNotes,
  poolOrder, inScale, snapToScale, addTrack, removeTrack, copyPattern, cleanPattern, guessRole, MAX_STEPS, laneValue } from '../js/seq/model.js';
import { Engine } from '../js/seq/engine.js';
import { parseProgression, commonProgressions } from '../js/seq/chords.js';
import { randomIdea, euclid, seeded } from '../js/seq/generate.js';
import { STOCK } from '../js/seq/stock.js';
import { writeMidi, readMidi, renderSong } from '../js/seq/midifile.js';
import { notesOf, splitTakes, estimateTempo, takeTicks, takeToPattern, takeMidiNotes, barsPerPattern } from '../js/seq/capture.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);

// ---- model ----
{
  const p = { length: 16, steps: [] };
  putStep(p, 4, { notes: [48], len: 8 });
  putStep(p, 0, { notes: [36], len: 10 }); // clipped so it doesn't hold over step 4
  assert.equal(stepAt(p, 0).len, 4);
  putStep(p, 6, { notes: [50] }); // inside the held note at 4: shortens it
  assert.equal(stepAt(p, 4).len, 2);
  assert.deepEqual(coverMap(p).slice(0, 8), [0, 0, 0, 0, 4, 4, 6, -1]);
  assert.equal(maxLen(p, 6), 10);
  assert.equal(maxLen(p, 2), 2);
  removeStep(p, 4);
  assert.equal(stepAt(p, 4), null);
  near(noteSteps({ i: 14, len: 4, gate: 50 }, 16), 1.5, 'note clipped at pattern end');
  const c = copyPattern(p);
  c.steps[0].notes.push(99);
  assert.deepEqual(stepAt(p, 0).notes, [36], 'copy is deep');
}
assert.deepEqual(poolOrder([64, 60, 67], 'played'), [64, 60, 67]);
assert.deepEqual(poolOrder([64, 60, 67], 'up'), [60, 64, 67]);
assert.deepEqual(poolOrder([64, 60, 67], 'down'), [67, 64, 60]);
assert.deepEqual(poolOrder([64, 60, 67, 72], 'updown'), [60, 64, 67, 72, 67, 64]);
const cMinor = { root: 0, type: 'minor' };
assert.ok(inScale(63, cMinor) && !inScale(64, cMinor));
assert.equal(snapToScale(64, cMinor), 63);
assert.equal(snapToScale(66, cMinor), 65);
assert.equal(snapToScale(61, { root: 2, type: 'major' }), 61); // C# is in D major

// normalizeSong repairs junk and keeps good data.
{
  const n = normalizeSong({
    name: 'x'.repeat(100), bpm: 999, swing: 10, scale: { root: 14, type: 'minor' },
    tracks: [{ name: 'B', ch: 40, rate: 'weird', mode: 'pool', patterns: { A: { length: 200, steps: [
      { i: 0, notes: [36, 36, 300, 40], vel: 0, gate: 500, len: 99 }, { i: 0, notes: [1] }, { i: 3, notes: [38] }, { i: -2 }] } } }],
    song: [{ bars: 0, play: ['Z'] }, { play: [null] }],
  });
  assert.equal(n.name.length, 60);
  assert.equal(n.bpm, 300); assert.equal(n.swing, 50); assert.equal(n.scale.root, 11);
  const t = n.tracks[0];
  assert.equal(t.ch, 16); assert.equal(t.rate, '1/16'); assert.equal(t.mode, 'pool');
  assert.equal(t.patterns.A.length, MAX_STEPS);
  assert.equal(t.patterns.A.steps.length, 2);
  assert.deepEqual(t.patterns.A.steps[0], { i: 0, notes: [36, 40], vel: 1, gate: 100, len: 3 });
  assert.deepEqual(t.patterns.B, { length: 16, steps: [] });
  assert.deepEqual(n.song, [{ bars: 1, play: ['A'] }, { bars: 4, play: [null] }]);
  assert.throws(() => normalizeSong({}));
  const withSound = normalizeSong({ tracks: [{ sound: { name: 'WARMBASS', data: Array(346).fill(7) }, program: 12 }, { sound: { data: [1, 2] }, program: 200 }] });
  assert.equal(withSound.tracks[0].sound.data.length, 346);
  assert.equal(withSound.tracks[0].program, 12);
  assert.equal(withSound.tracks[1].sound, null);
  assert.equal(withSound.tracks[1].program, null);
  // Effect racks on tracks and the master: copies kept, junk dropped, empty racks are none.
  const withFx = normalizeSong({ masterFx: { name: 'Glue', rack: { name: 'Glue', modules: [{ type: 'delay', params: {} }, { type: 'nope' }] }, mix: 3 },
    tracks: [{ fx: { name: 'Wide', rack: { modules: [{ type: 'chorus', params: { rate: 0.5 } }] }, off: true } }, { fx: { rack: { modules: [] } } }] });
  assert.equal(withFx.masterFx.rack.modules.length, 1);
  assert.equal(withFx.masterFx.mix, 1);
  assert.equal(withFx.tracks[0].fx.off, true);
  assert.equal(withFx.tracks[0].fx.rack.modules[0].params.rate, 0.5);
  assert.equal(withFx.tracks[1].fx, null);
  assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(withFx))), withFx, 'effect racks survive a round trip');
  const fresh = newSong();
  assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(fresh))), fresh, 'a new song survives a round trip');
  addTrack(fresh);
  assert.equal(fresh.song[0].play.length, 2);
  removeTrack(fresh, 0);
  assert.equal(fresh.tracks.length, 1); assert.equal(fresh.song[0].play.length, 1);
}

// AI answers: steps must fit the pattern's length; junk is dropped.
{
  const p = cleanPattern({ steps: [{ i: 2, notes: [40], vel: 90, gate: 50, len: 9 }, { i: 6, notes: [43] }, { i: 12, notes: [45] }, { i: 'x' }] },
    { length: 12, onlyBelow: 12 });
  assert.equal(p.length, 12);
  assert.deepEqual(p.steps.map(s => [s.i, s.len]), [[2, 4], [6, 1]]);
  assert.equal(guessRole(newTrack(0, { name: 'Kick + hats' })), 'drums');
  assert.equal(guessRole(newTrack(0, { name: 'Track 3', voice: 'Pad' })), 'pad');
  assert.equal(guessRole(newTrack(0, { name: 'Thing', mode: 'pool' })), 'arp');
}

// 🎲 ideas: every role, many lengths and seeds; valid steps, in the scale, inside the pattern.
assert.equal(euclid(3, 8).map(x => (x ? 'x' : '.')).join(''), 'x..x..x.');
for (const role of ['bass', 'lead', 'chords', 'pad', 'arp', 'drums']) {
  for (const [length, seed] of [[16, 1], [7, 2], [12, 3], [32, 4], [64, 5], [1, 6], [16, 7], [24, 8]]) {
    for (const density of ['sparse', 'medium', 'busy']) {
      for (const scale of [{ root: 9, type: 'dorian' }, { root: 2, type: 'minor pentatonic' }, null]) {
        const { pattern, summary } = randomIdea({ role, length, density, scale, rng: seeded(seed * 31 + length) });
        assert.ok(summary.startsWith('🎲'));
        assert.deepEqual(cleanPattern(pattern, { length, onlyBelow: length }), pattern, `${role} ${length} is already clean`);
        if (length >= 4 && role !== 'drums') assert.ok(pattern.steps.length > 0, `${role} ${length} ${density} has notes`);
        const notesOk = role === 'drums' || role === 'chords' || role === 'pad' || role === 'arp'
          ? true // chords and arps use the parent 7-note scale of a pentatonic
          : pattern.steps.every(s => s.notes.every(n => inScale(n, scale || { root: 0, type: 'minor' })));
        assert.ok(notesOk, `${role} notes in scale`);
      }
    }
  }
}
assert.ok(randomIdea({ role: 'bass', pool: true, length: 16, rng: seeded(1) }).pattern.steps.every(s => s.notes.length === 0));

// Stock library patterns: whole bars, valid, in their stated key, unique names.
assert.ok(STOCK.length >= 40);
assert.equal(new Set(STOCK.map(p => p.id)).size, STOCK.length);
for (const p of STOCK) {
  assert.ok([16, 32, 64].includes(p.length), `${p.name}: length ${p.length}`);
  assert.deepEqual(cleanPattern(p, { length: p.length, onlyBelow: p.length }).steps, p.steps, `${p.name} is clean`);
  assert.ok(p.steps.length > 0, p.name);
  if (p.key) assert.ok(p.steps.every(s => s.notes.every(n => inScale(n, p.key))), `${p.name}: notes outside ${p.key.type}`);
  if (p.mode === 'pool') assert.ok(p.steps.every(s => !s.notes.length), p.name);
}

// ---- engine ----
// Runs the engine against a fake clock and records what it sends.
function run(song, { ms, mode = 'loop', pool = () => [] } = {}) {
  let t = 1000;
  const out = { notes: [], clocks: [], steps: [], bars: [] };
  const e = new Engine({
    song: () => song, now: () => t, pool, rng: () => 0,
    sink: {
      note: (ti, note, vel, at, dur) => out.notes.push({ ti, note, vel, at: at - 1040, dur }),
      clock: at => out.clocks.push(at - 1040),
      step: (ti, pos, pattern, at, silent) => out.steps.push({ ti, pos, pattern, silent }),
      bar: (section, bar) => out.bars.push([section, bar]),
    },
  });
  e.mode = mode;
  e.play();
  for (; t < 1000 + ms; t += 25) e.pump();
  e.stop();
  return out;
}

{
  // 120 BPM: a 16th is 125 ms; clock pulses every 125/6 ms.
  const song = newSong();
  const A = song.tracks[0].patterns.A;
  putStep(A, 0, { notes: [36], vel: 100, gate: 50, len: 1 });
  putStep(A, 4, { notes: [48, 51], vel: 90, gate: 100, len: 2 });
  const r = run(song, { ms: 2000 });
  const firstBar = r.notes.filter(n => n.at < 2000);
  assert.deepEqual(firstBar.map(n => [n.note, Math.round(n.at)]), [[36, 0], [48, 500], [51, 500]]);
  near(firstBar[0].dur, 62.5 - 2, '50% gate');
  near(firstBar[1].dur, 250 - 2, 'held two steps at 100%');
  assert.ok(r.notes.some(n => n.note === 36 && Math.round(n.at) === 2000), 'pattern loops after 16 steps');
  near(r.clocks[1] - r.clocks[0], 125 / 6, 'clock spacing');
  // Nothing is scheduled more than the look-ahead past the last pump.
  assert.ok(Math.max(...r.notes.map(n => n.at)) <= 2000 + 120 + 40);
}

{
  // Swing 75% pushes every second 16th by half a step.
  const song = newSong();
  song.swing = 75;
  const A = song.tracks[0].patterns.A;
  for (let i = 0; i < 4; i++) putStep(A, i, { notes: [60 + i] });
  const r = run(song, { ms: 600 });
  assert.deepEqual(r.notes.slice(0, 4).map(n => Math.round(n.at)), [0, 188, 250, 438]);
}

{
  // Odd lengths loop on their own; rates change step spacing.
  const song = newSong();
  addTrack(song);
  song.tracks[0].patterns.A = { length: 3, steps: [{ i: 0, notes: [40], vel: 100, gate: 50, len: 1 }] };
  song.tracks[1].rate = '1/8';
  putStep(song.tracks[1].patterns.A, 1, { notes: [70] });
  const r = run(song, { ms: 1100 });
  const times = ti => r.notes.filter(n => n.ti === ti && n.at < 1000).map(n => Math.round(n.at));
  assert.deepEqual(times(0), [0, 375, 750]);
  assert.deepEqual(times(1), [250]);
}

{
  // Song mode: sections switch patterns per track at bar lines, and null tracks stay silent.
  const song = newSong();
  addTrack(song);
  const [t0, t1] = song.tracks;
  putStep(t0.patterns.A, 0, { notes: [36] });
  putStep(t0.patterns.B, 0, { notes: [38] });
  putStep(t1.patterns.A, 0, { notes: [60] });
  song.song = [{ bars: 1, play: ['A', null] }, { bars: 2, play: ['B', 'A'] }];
  const r = run(song, { ms: 8100, mode: 'song' });
  const at = (ti) => r.notes.filter(n => n.ti === ti).map(n => [n.note, Math.round(n.at / 2000)]);
  assert.deepEqual(at(0), [[36, 0], [38, 1], [38, 2], [36, 3], [38, 4]]);
  assert.deepEqual(at(1), [[60, 1], [60, 2], [60, 4]]);
  assert.deepEqual(r.bars.slice(0, 4), [[0, 0], [1, 0], [1, 1], [0, 0]]);
}

{
  // Loop mode: a queued pattern switches at the next bar, not immediately.
  const song = newSong();
  const t = song.tracks[0];
  putStep(t.patterns.A, 0, { notes: [36] });
  putStep(t.patterns.A, 8, { notes: [36] });
  putStep(t.patterns.B, 0, { notes: [50] });
  let queued = false;
  const out = [];
  let now = 1000;
  const e = new Engine({ song: () => song, now: () => now, sink: { note: (ti, n, v, at) => out.push([n, Math.round(at - 1040)]) } });
  e.play();
  for (; now < 5100; now += 25) {
    if (!queued && now > 1600) { e.queue(0, 'B'); queued = true; }
    e.pump();
  }
  assert.deepEqual(out, [[36, 0], [36, 1000], [50, 2000], [50, 4000]]);
}

{
  // Note pool: each step that fires takes the next note; muted tracks send nothing.
  const song = newSong();
  const t = song.tracks[0];
  t.mode = 'pool';
  t.pool.order = 'up';
  for (const i of [0, 2, 3, 6]) putStep(t.patterns.A, i, { notes: [] });
  const r = run(song, { ms: 1000, pool: () => [67, 60, 63] });
  assert.deepEqual(r.notes.map(n => n.note), [60, 63, 67, 60]);
  t.mute = true;
  assert.equal(run(song, { ms: 1000, pool: () => [60] }).notes.length, 0);
  t.mute = false;
  assert.equal(run(song, { ms: 1000, pool: () => [] }).notes.length, 0, 'empty pool plays nothing');
}

{
  // Tempo changes apply from the next unscheduled note, without a jump.
  const song = newSong();
  for (let i = 0; i < 16; i++) putStep(song.tracks[0].patterns.A, i, { notes: [60] });
  let t = 1000;
  const at = [];
  const e = new Engine({ song: () => song, now: () => t, sink: { note: (ti, n, v, a) => at.push(a) } });
  e.play();
  for (; t < 1500; t += 25) e.pump();
  song.bpm = 60;
  for (; t < 3000; t += 25) e.pump();
  const gaps = at.slice(1).map((a, k) => Math.round(a - at[k]));
  assert.ok(gaps.slice(0, 3).every(g => g === 125), gaps.join());
  assert.ok(gaps.slice(-3).every(g => g === 250), gaps.join());
  // The change lands on the next clock pulse, so at most one gap is part old tempo, part new.
  assert.ok(gaps.filter(g => g !== 125 && g !== 250).length <= 1 && gaps.every(g => g >= 125 && g <= 250), gaps.join());
}


{
  // positionAt: which step a key press at a given moment belongs to.
  const song = newSong();
  let t = 1000;
  const e = new Engine({ song: () => song, now: () => t });
  e.play(); // first step at 1040 ms; a 1/16 step at 120 BPM is 125 ms
  for (; t < 2000; t += 25) e.pump();
  const p = e.positionAt(0, 1040 + 125 * 5 + 30);
  assert.equal(p.pattern, 'A');
  near(p.step, 5.24, 'step at a time');
  near(e.positionAt(0, 1040 + 125 * 16 - 20).step, 15.84, 'wraps to the pattern');
  near(e.tickAt(1040 + 500), 96, 'tick at a time');
}


// ---- chance, ratchets, controller lanes ----
{
  const p = cleanPattern({ length: 8, steps: [{ i: 0, notes: [60], prob: 50, rat: 3 }, { i: 2, notes: [62], prob: 100, rat: 1 }, { i: 4, notes: [64], prob: 0, rat: 9 }],
    cc: [{ cc: 74, glide: 1, steps: [{ i: 0, v: 0 }, { i: 4, v: 200 }, { i: 9, v: 5 }] }, { cc: 74 }, { cc: 300 }] });
  assert.deepEqual(p.steps[0], { i: 0, notes: [60], vel: 100, gate: 60, len: 1, prob: 50, rat: 3 });
  assert.deepEqual(p.steps[1], { i: 2, notes: [62], vel: 100, gate: 60, len: 1 }, 'defaults are left out');
  assert.deepEqual([p.steps[2].prob, p.steps[2].rat], [1, 8]);
  assert.deepEqual(p.cc, [{ cc: 74, glide: true, steps: [{ i: 0, v: 0 }, { i: 4, v: 127 }, { i: 9, v: 5 }] }]);
  assert.equal(cleanPattern({ steps: [] }).cc, undefined);
  const c = copyPattern(p);
  c.cc[0].steps[0].v = 99;
  assert.equal(p.cc[0].steps[0].v, 0, 'copy is deep');

  const lane = { cc: 74, glide: false, steps: [{ i: 0, v: 0 }, { i: 4, v: 100 }] };
  assert.equal(laneValue(lane, 4, 8), 100);
  assert.equal(laneValue(lane, 2, 8), null, 'without glide, only set steps send');
  lane.glide = true;
  assert.equal(laneValue(lane, 2, 8), 50, 'halfway up');
  assert.equal(laneValue(lane, 6, 8), 50, 'and back down, wrapping to step 0');
  assert.equal(laneValue(lane, 7.5, 8), 13);
  assert.equal(laneValue({ cc: 1, glide: true, steps: [{ i: 3, v: 40 }] }, 0, 8), 40, 'one point holds');
  assert.equal(laneValue({ cc: 1, glide: true, steps: [{ i: 12, v: 40 }] }, 0, 8), null, 'points past the end are ignored');
}
{
  // Engine: a 50% step plays about half the time; ratchets split the note; lanes send CCs.
  const song = newSong();
  const t = song.tracks[0];
  t.patterns.A.length = 4;
  putStep(t.patterns.A, 0, { notes: [60], prob: 50 });
  putStep(t.patterns.A, 2, { notes: [62], len: 2, gate: 50, rat: 4 });
  t.patterns.A.cc = [{ cc: 74, glide: true, steps: [{ i: 0, v: 0 }, { i: 2, v: 80 }] }];
  let now = 0, rng = 0;
  const notes = [], ccs = [];
  const e = new Engine({ song: () => song, now: () => now, rng: () => (rng = (rng + 0.37) % 1),
    sink: { note: (ti, n, v, at, dur) => notes.push({ n, at: at - 40, dur }), cc: (ti, c, v, at) => ccs.push([c, v, at - 40]) } });
  e.play();
  for (; now < 8000; now += 25) e.pump(); // 16 loops of the 4-step pattern (500 ms each at 120 BPM)
  const c4 = notes.filter(x => x.n === 60).length;
  assert.ok(c4 >= 5 && c4 <= 11, `50% step played ${c4} of 16 times`);
  const rolls = notes.filter(x => x.n === 62 && x.at < 500).map(x => Math.round(x.at));
  assert.deepEqual(rolls, [250, 313, 375, 438], 'four repeats across two steps');
  near(notes.find(x => x.n === 62).dur, 62.5 * 0.5 - 2, 'gate applies to each repeat');
  const first = ccs.filter(x => x[2] < 500);
  assert.deepEqual(first.map(x => x[1]), [0, 10, 20, 30, 40, 50, 60, 70, 80, 70, 60, 50, 40, 30, 20, 10], 'glides up and back');
  assert.ok(first.every(x => x[0] === 74));
}

{
  // halt(): no new notes, but stop() afterwards still tells the sink.
  const song = newSong();
  for (let i = 0; i < 16; i++) putStep(song.tracks[0].patterns.A, i, { notes: [60] });
  let t = 0, notes = 0, stops = 0;
  const e = new Engine({ song: () => song, now: () => t, sink: { note: () => notes++, stop: () => stops++ } });
  e.play();
  for (; t < 500; t += 25) e.pump();
  e.halt();
  const n = notes;
  for (; t < 1500; t += 25) e.pump();
  assert.equal(notes, n, 'no notes after halt');
  e.stop();
  assert.equal(stops, 1, 'stop after halt still stops');
}

// ---- computer keyboard chords ----
{
  const { chordOn } = await import('../js/core/qwerty.js');
  assert.deepEqual(chordOn(48, null), [48, 52, 55], 'no scale: major');
  assert.deepEqual(chordOn(50, { root: 0, type: 'major' }), [50, 53, 57], 'D minor in C major');
  assert.deepEqual(chordOn(59, { root: 0, type: 'major' }), [59, 62, 65], 'B diminished, wrapping the octave');
  assert.deepEqual(chordOn(51, { root: 0, type: 'minor' }), [51, 55, 58], 'Eb major in C minor');
  assert.deepEqual(chordOn(49, { root: 0, type: 'major' }), [49, 53, 56], 'not in the scale: major');
}

// ---- MIDI files ----
{
  const bytes = writeMidi({ name: 'Test', bpm: 125, tracks: [
    { name: 'Bass', ch: 2, program: 5, notes: [{ tick: 0, dur: 48, note: 36, vel: 100 }, { tick: 48, dur: 48, note: 36, vel: 90 }] },
    { name: 'Lead', ch: 3, notes: [{ tick: 96, dur: 200, note: 72, vel: 127 }] }] });
  const m = readMidi(bytes);
  assert.equal(m.division, 96);
  assert.equal(m.tempo, 480000);
  assert.deepEqual(m.tracks.map(x => x.name), ['Test', 'Bass', 'Lead']);
  assert.deepEqual(m.tracks[1].notes, [{ tick: 0, note: 36, vel: 100, ch: 2, dur: 48 }, { tick: 48, note: 36, vel: 90, ch: 2, dur: 48 }],
    'a repeated note is not cut short');
  assert.equal(m.tracks[2].notes[0].dur, 200);
}
{
  // renderSong follows the sections, swing and note pools, and ignores mute.
  const song = newSong();
  song.swing = 75;
  const t = song.tracks[0];
  t.patterns.A.length = t.patterns.B.length = 4;
  putStep(t.patterns.A, 0, { notes: [36], len: 2, gate: 50 });
  putStep(t.patterns.A, 1, { notes: [38] });
  putStep(t.patterns.B, 0, { notes: [40] });
  t.mute = true;
  addTrack(song);
  const p = song.tracks[1];
  p.mode = 'pool'; p.pool.notes = [60, 64]; p.pool.order = 'up';
  putStep(p.patterns.A, 0, { notes: [] }); putStep(p.patterns.A, 8, { notes: [] });
  song.song = [{ bars: 1, play: ['A', 'A'] }, { bars: 1, play: ['B', null] }];
  const r = renderSong(song);
  assert.equal(r.bars, 2);
  const bass = r.tracks[0].notes;
  assert.equal(bass.filter(n => n.note === 36).length, 4, 'pattern A loops through bar 1');
  assert.deepEqual(bass.slice(0, 2).map(n => [n.tick, n.note]), [[0, 36], [36, 38]], 'swung 16th at 75%');
  assert.equal(bass[0].dur, 12, 'gate 50% of a step (step 1 cut the hold short)');
  assert.deepEqual(bass.filter(n => n.note === 40).map(n => n.tick), [384, 480, 576, 672], 'section 2 plays B');
  assert.deepEqual(r.tracks[1].notes.map(n => [n.tick, n.note]), [[0, 60], [192, 64]], 'pool walks up, silent in section 2');
  const back = readMidi(writeMidi(r));
  assert.equal(back.tracks.length, 3);
  // Controller lanes go into the file too.
  t.patterns.A.cc = [{ cc: 74, glide: false, steps: [{ i: 0, v: 10 }] }];
  const withCC = readMidi(writeMidi(renderSong(song)));
  assert.deepEqual(withCC.tracks[1].ccs.map(c => [c.tick, c.cc, c.v]), [[0, 74, 10], [96, 74, 10], [192, 74, 10], [288, 74, 10]]);
  assert.equal(back.tracks[1].notes.length, bass.length);
}

// ---- capture ----
{
  const ev = (t, type, n, v = 100, extra = {}) => ({ t, type, n, v, ...extra });
  // Pedal holds released notes; a take ends after 4 s of silence.
  const events = [
    ev(0, 'on', 60), ev(100, 'ped', 1), ev(200, 'off', 60), ev(300, 'on', 64), ev(400, 'off', 64), ev(1000, 'ped', 0),
    ev(1200, 'on', 67), ev(1500, 'off', 67),
    ev(6000, 'on', 72), // second take, still held
  ];
  const notes = notesOf(events, 6500);
  assert.deepEqual(notes.map(n => [n.note, n.t, n.dur]), [[60, 0, 1000], [64, 300, 700], [67, 1200, 300], [72, 6000, 1]]);
  assert.ok(notes[3].open);
  const takes = splitTakes(notes);
  assert.equal(takes.length, 2);
  assert.equal(takes[0].end, 1500);
  assert.ok(!takes[0].synced && takes[1].open);

  // Free playing: tempo from the note starts, first note on beat 1.
  const bpm = 96, beat = 60000 / bpm;
  const riff = [0, 0.5, 1, 1.75, 2, 3, 3.5, 4, 4.5, 5, 5.75, 6, 7].map((b, k) => ev(b * beat + (k % 3) * 6, 'on', 48 + k % 5));
  const offs = riff.map(e => ev(e.t + beat * 0.4, 'off', e.n));
  const free = splitTakes(notesOf([...riff, ...offs].sort((a, b) => a.t - b.t)))[0];
  assert.equal(estimateTempo(free.notes, 120), 96);
  const items = takeTicks(free, 96);
  const pat = takeToPattern(items, 24);
  assert.equal(pat.length, 32, 'two bars of 16ths');
  assert.deepEqual(pat.steps.map(s => s.i), [0, 2, 4, 7, 8, 12, 14, 16, 18, 20, 23, 24, 28]);
  assert.deepEqual(pat.steps[0], { i: 0, notes: [48], vel: 100, gate: 60, len: 2 }, '0.4 beat = 1.6 steps');
  assert.equal(takeToPattern(items, 48, { fromBar: 1 }).steps[0].i, 0, 'from bar 2');
  assert.equal(barsPerPattern(24), 4);
  assert.equal(barsPerPattern(12), 2);

  // Played along with the sequencer: placed by its ticks, in the bar it was played in.
  const sync = (t, type, n, tick) => ev(t, type, n, 100, { tick, run: 1, bpm: 120 });
  const along = splitTakes(notesOf([sync(0, 'on', 60, 384 + 95), sync(100, 'off', 60, 384 + 120), sync(500, 'on', 62, 384 + 192), sync(600, 'off', 62, 384 + 216)]))[0];
  assert.ok(along.synced);
  assert.deepEqual(takeToPattern(takeTicks(along), 24).steps.map(s => [s.i, s.notes[0], s.len]), [[4, 60, 1], [8, 62, 1]]);
  assert.deepEqual(takeMidiNotes(along).map(n => n.tick), [95, 192]);
  // A performance range keeps a long rest inside one take.
  const perf = splitTakes(notesOf([ev(0, 'on', 60), ev(100, 'off', 60), ev(9000, 'on', 62), ev(9100, 'off', 62), ev(20000, 'on', 64), ev(20100, 'off', 64)]),
    4000, [{ start: -10, end: 9500, kind: 'performance' }]);
  assert.deepEqual(perf.map(t => [t.notes.length, t.kind]), [[2, 'performance'], [1, undefined]]);
  assert.equal(perf[0].id, -10);
  // Played across two runs: not synced.
  assert.ok(!splitTakes(notesOf([sync(0, 'on', 60, 10), { ...sync(50, 'on', 62, 10), run: 2 }]))[0].synced);
}

{
  // Drum styles: templates fit their length, every style makes clean patterns at any length and
  // density, and ghost notes keep their own velocity beside louder drums on the same step.
  const { STYLES, DRUM_NOTES } = await import('../js/seq/styles.js');
  const { cleanPattern, drumStep, velOf, copyPattern } = await import('../js/seq/model.js');
  const kit = new Set(Object.values(DRUM_NOTES));
  for (const st of STYLES) {
    for (const [lane, list] of Object.entries(st.lanes)) {
      assert.ok(DRUM_NOTES[lane], `${st.id}: ${lane} is a drum`);
      if (Array.isArray(list)) for (const t of list) assert.equal(t.length, st.steps, `${st.id} ${lane} template is ${st.steps} steps`);
    }
    for (const length of [12, 16, 20, 32, 64]) for (const density of ['sparse', 'medium', 'busy']) {
      const idea = randomIdea({ role: 'drums', style: st.id, length, density, rng: seeded(length * 7 + density.length) });
      assert.deepEqual(cleanPattern(idea.pattern), idea.pattern, `${st.id} at ${length} is clean`);
      assert.ok(idea.pattern.steps.length && idea.pattern.steps.every(x => x.i < length && x.notes.every(n => kit.has(n))), `${st.id} at ${length} fits`);
    }
  }
  assert.ok(randomIdea({ role: 'drums', style: 'any', rng: seeded(3) }).summary.startsWith('🎲 Drums:'), 'any style');
  const s = drumStep(4, [[42, 90], [38, 45]]);
  assert.deepEqual(s, { i: 4, notes: [38, 42], vel: 90, gate: 30, len: 1, nv: { 38: 45 } });
  assert.equal(velOf(s, 38), 45);
  assert.equal(velOf(s, 42), 90);
  assert.equal(drumStep(0, [[36, 100], [42, 100]]).nv, undefined, 'no nv when all agree');
  assert.deepEqual(cleanPattern({ steps: [{ i: 0, notes: [36, 42], vel: 100, nv: { 36: 100, 42: 300, 50: 20 } }] }).steps[0].nv, { 42: 127 }, 'nv cleaned');
  const copy = copyPattern({ length: 16, steps: [s] });
  copy.steps[0].nv[38] = 1;
  assert.equal(s.nv[38], 45, 'copies own their nv');
  // The engine plays each drum at its own velocity.
  const song = newSong();
  song.tracks[0].patterns.A = { length: 16, steps: [s] };
  const played = [];
  let now = 0;
  const eng = new Engine({ song: () => song, now: () => now, sink: { note: (ti, n, vel) => played.push([n, vel]) } });
  eng.play();
  now = 2000; eng.pump();
  assert.deepEqual(played.slice(0, 2).sort((a, b) => a[0] - b[0]), [[38, 45], [42, 90]], 'engine uses nv');
}

{
  // Breeding: mutations change something and stay clean; crosses take from both parents.
  const { mutate, cross } = await import('../js/seq/breed.js');
  const { cleanPattern, velOf } = await import('../js/seq/model.js');
  const a = randomIdea({ role: 'drums', style: 'breaks', rng: seeded(1) }).pattern, b = randomIdea({ role: 'drums', style: 'skitter', rng: seeded(2) }).pattern;
  for (let k = 0; k < 40; k++) {
    const rng = seeded(100 + k);
    const m = mutate(a, { drums: true, amount: 0.2, rng });
    assert.deepEqual(cleanPattern(m.pattern), m.pattern, 'mutation is clean');
    assert.notDeepEqual(m.pattern, a, `mutation ${k} changes something (${m.what})`);
    assert.ok(m.pattern.steps.some(s => s.i === 0 && s.notes.includes(36)), 'kick on 1 kept');
    const x = cross(a, b, { drums: true, rng });
    assert.deepEqual(cleanPattern(x.pattern), x.pattern, 'cross is clean');
    assert.match(x.what, /[1-9] lanes? from the first, [1-9] from the second/, `cross ${k} uses both (${x.what})`);
    const key = (p, i, n) => { const s = p.steps.find(z => z.i === i); return s?.notes.includes(n) ? velOf(s, n) : null; };
    for (const s of x.pattern.steps) for (const n of s.notes) assert.ok(key(a, s.i, n) === velOf(s, n) || key(b, s.i, n) === velOf(s, n), 'hits come from a parent');
  }
  const scale = { root: 0, type: 'minor' }, inScale = n => [0, 2, 3, 5, 7, 8, 10].includes(n % 12);
  const m1 = randomIdea({ role: 'bass', scale, rng: seeded(5) }).pattern, m2 = randomIdea({ role: 'bass', scale, rng: seeded(6) }).pattern;
  for (let k = 0; k < 20; k++) {
    const m = mutate(m1, { amount: 0.3, scale, rng: seeded(k) });
    assert.ok(m.pattern.steps.every(s => s.notes.every(inScale)), 'melodic mutations stay in the scale');
    const x = cross(m1, m2, { rng: seeded(k) });
    assert.deepEqual(cleanPattern(x.pattern), x.pattern);
  }
}

{
  // Polyrhythm: a pattern fitted into some beats spreads its steps evenly; a drum with its own
  // lane length keeps counting across the pattern's loops.
  const { cleanPattern, stepGroups, spanOf } = await import('../js/seq/model.js');
  assert.deepEqual(cleanPattern({ length: 5, beats: 4, laneLen: { 42: 3, x: 2, 36: 0 }, steps: [] }), { length: 5, steps: [], beats: 4, laneLen: { 42: 3 } });
  assert.equal(cleanPattern({ length: 5, beats: 40, steps: [] }).beats, 16);
  assert.equal(spanOf({ length: 5, beats: 4 }, 24), 384);
  assert.equal(spanOf({ length: 5 }, 24), 120);
  const pat = { length: 8, laneLen: { 42: 3 }, steps: [{ i: 0, notes: [36, 42], vel: 100, gate: 30, len: 1 }, { i: 4, notes: [38], vel: 100, gate: 30, len: 1 }] };
  const at = count => stepGroups(pat, count % 8, count).flatMap(g => g.notes).sort((a, b) => a - b);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(at), [[36, 42], [], [], [42], [38], [], [42], [], [36], [42]], 'hat every 3 steps, across the loop');

  const song = newSong();
  song.bpm = 120;
  song.tracks[0].rate = '1/16';
  song.tracks[0].patterns.A = { length: 5, beats: 4, steps: [0, 1, 2, 3, 4].map(i => ({ i, notes: [60 + i], vel: 100, gate: 50, len: 1 })) };
  const times = [];
  let now = 0;
  const eng = new Engine({ song: () => song, now: () => now, sink: { note: (ti, n, vel, t) => { if (ti === 0) times.push([n, t]); } } });
  eng.play();
  for (now = 0; now < 4200; now += 25) eng.pump();
  const t0 = times[0][1], beat = 500;
  const got = times.slice(0, 11).map(([n, t]) => [n, Math.round((t - t0) / beat * 96)]);
  assert.deepEqual(got, [[60, 0], [61, 77], [62, 154], [63, 230], [64, 307], [60, 384], [61, 461], [62, 538], [63, 614], [64, 691], [60, 768]], '5 in 4 beats');
}

{
  // Feel: cleaned (empty = null), presets valid, and the engine moves notes by it.
  const { cleanFeel, feelNote, FEEL_PRESETS } = await import('../js/seq/model.js');
  assert.equal(cleanFeel({ time: 0, vel: 0, shift: 0, push: { 38: 0 } }), null);
  assert.deepEqual(cleanFeel({ time: 99, vel: -3, shift: 70, push: { 38: 25.4, x: 3, 42: 0 }, preset: 'nope' }), { time: 40, vel: 0, shift: 60, push: { 38: 25 } });
  for (const [name, p] of Object.entries(FEEL_PRESETS)) if (p) assert.equal(cleanFeel({ ...p, preset: name }).preset, name, `${name} is clean`);
  assert.deepEqual(feelNote({ time: 0, vel: 0, shift: 10, push: { 38: 20 } }, 38, 100), { dt: 30, vel: 100 });
  for (let k = 0; k < 50; k++) { const f = feelNote({ time: 10, vel: 10, shift: 0, push: {} }, 36, 120); assert.ok(Math.abs(f.dt) <= 10 && f.vel >= 110 && f.vel <= 127); }
  const song = newSong();
  song.bpm = 120;
  song.tracks[0].feel = cleanFeel({ shift: 0, push: { 38: 25 } });
  song.tracks[0].patterns.A = { length: 16, steps: [{ i: 0, notes: [36, 38], vel: 100, gate: 30, len: 1 }] };
  const got = [];
  let now = 0;
  const eng = new Engine({ song: () => song, now: () => now, sink: { note: (ti, n, vel, t) => { if (ti === 0) got.push([n, t]); } } });
  eng.play();
  for (now = 0; now < 500; now += 25) eng.pump();
  const t36 = got.find(x => x[0] === 36)[1], t38 = got.find(x => x[0] === 38)[1];
  assert.equal(Math.round(t38 - t36), 25, 'the snare plays 25 ms late');
}

{
  // Time signatures: bar lengths, sections with their own meter, and the .mid file's events.
  const { barTicks, meterAt, songTicks, stepsPerBar, normalizeSong: norm } = await import('../js/seq/model.js');
  assert.equal(barTicks('4/4'), 384);
  assert.equal(barTicks('7/8'), 336);
  assert.equal(stepsPerBar('7/8', 24), 14);
  assert.equal(stepsPerBar('5/8', 48), 5);
  assert.equal(stepsPerBar('7/8', 96), null);
  const song = norm({ ...newSong(), meter: '7/8', song: [{ bars: 2, play: ['A'] }, { bars: 1, play: ['A'], meter: '4/4' }, { bars: 1, play: ['A'], meter: 'bogus' }] });
  assert.equal(song.meter, '7/8');
  assert.deepEqual(song.song.map((x, i) => meterAt(song, i)), ['7/8', '4/4', '7/8']);
  assert.equal(songTicks(song), 2 * 336 + 384 + 336);
  assert.equal(norm({ ...newSong(), meter: '9/7' }).meter, '4/4');
  // The engine's bars follow the meter (loop mode: the song's; song mode: each section's).
  song.bpm = 120;
  const bars = [];
  let now = 0;
  const eng = new Engine({ song: () => song, now: () => now, sink: { bar: (sec, bar, at) => bars.push(at) } });
  eng.mode = 'song';
  eng.play();
  for (now = 0; now < 9000; now += 25) eng.pump();
  const gaps = bars.slice(1, 5).map((t, k) => Math.round(t - bars[k]));
  assert.deepEqual(gaps, [1750, 1750, 2000, 1750], 'bars of 7/8, 7/8, 4/4, 7/8 at 120 BPM');
  // .mid export: a time signature at each change.
  const r = renderSong(song);
  assert.deepEqual(r.meters, [{ tick: 0, meter: '7/8' }, { tick: 672, meter: '4/4' }, { tick: 1056, meter: '7/8' }]);
  const bytes = writeMidi(r);
  const ts = [];
  for (let i = 0; i < bytes.length - 6; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0x58 && bytes[i + 2] === 4) ts.push([bytes[i + 3], bytes[i + 4]]);
  assert.deepEqual(ts, [[7, 3], [4, 2], [7, 3]]);
}

{
  // Track roles: stored; songs without them get the old guess; renaming doesn't change a role.
  const { roleOf, freeTrackName, normalizeSong: norm, addTrack: add } = await import('../js/seq/model.js');
  const old = norm({ ...newSong(), tracks: [{ name: 'Kick + hats' }, { name: 'Thing', voice: 'Pad' }, { name: 'Lead', role: 'chords' }] });
  assert.deepEqual(old.tracks.map(t => t.role), ['drums', 'pad', 'chords']);
  old.tracks[0].name = 'Bass line';
  assert.equal(roleOf(old.tracks[0]), 'drums', 'renaming keeps the role');
  assert.equal(norm({ ...newSong(), tracks: [{ name: 'x', role: 'nope' }] }).tracks[0].role, 'lead');
  const song = newSong();
  assert.equal(freeTrackName(song, 'Bass'), 'Bass 2');
  const t = add(song, { role: 'arp', name: 'Arp', mode: 'pool' });
  assert.deepEqual([t.role, t.mode, song.song[0].play.length], ['arp', 'pool', 2]);
}

// A clip into a song: an existing track, a new track, a new song.
{
  const { putClip, songWithClip, guessClipRole } = await import('../js/seq/putclip.js');
  const items = [0, 96, 192, 288].map((pos, k) => ({ note: 60 + k, vel: 100, pos, len: 48 }));
  const song = normalizeSong(newSong());
  let r = putClip(song, { items, ti: 0, pattern: 'B' });
  assert.equal(r.error, undefined);
  assert.deepEqual([r.ti, r.pattern, r.added, song.tracks[0].patterns.B.steps.length], [0, 'B', false, 4]);
  r = putClip(song, { items, newRole: 'lead', name: 'Hook', sound: { kind: 'voice', name: 'Pad', voice: 'Pad' } });
  assert.deepEqual([r.ti, r.added, r.track.name, r.track.role, r.track.voice, r.track.inst, song.song[0].play.length], [1, true, 'Hook', 'lead', 'Pad', null, 2]);
  r = putClip(song, { items: [], newRole: 'bass' });
  assert.ok(r.error && song.tracks.length === 2, 'no notes: no track added');
  const n = songWithClip('Sketch', 97, { items, newRole: 'chords', sound: { kind: 'xl', name: 'X', data: [1] } });
  assert.deepEqual([n.song.name, n.song.bpm, n.song.tracks.length, n.song.song[0].play, n.song.song[0].bars], ['Sketch', 97, 1, ['A'], 1]);
  assert.equal(n.song.tracks[0].out, 'computer', 'no XL port: the starter sound on the computer');
  assert.ok(normalizeSong(JSON.parse(JSON.stringify(n.song))).tracks[0].patterns.A.steps.length === 4);
  assert.equal(guessClipRole([36, 38, 40].map((note, k) => ({ note, vel: 90, pos: k * 96, len: 48 }))), 'bass');
  assert.equal(guessClipRole([60, 64, 67, 62, 65, 69].map((note, k) => ({ note, vel: 90, pos: (k >> 1 >> 0) * 0 + (k < 3 ? 0 : 384), len: 96 }))), 'chords');
}

// Backing: slicing what the sequencer played, and a new song recreating it.
{
  const { backingSlice, songFromBacking, backingTracks } = await import('../js/seq/putclip.js');
  const base = normalizeSong(newSong());
  base.tracks[0].name = 'Bass';
  base.tracks.push(normalizeSong(newSong()).tracks[0]); base.tracks[1].name = 'Hats'; base.song[0].play.push('A');
  base.tracks.push(normalizeSong(newSong()).tracks[0]); base.tracks[2].name = 'Silent'; base.song[0].play.push('A');
  // A one-bar bass riff and hats on every 8th, looped for 8 bars from tick 384 (bar 2).
  const notes = [];
  for (let bar = 0; bar < 8; bar++) {
    const t0 = 384 + bar * 384;
    [0, 96, 192, 288].forEach((d, k) => notes.push({ ti: 0, pos: t0 + d, note: [36, 39, 43, 41][k], vel: 100, len: 48 }));
    for (let e = 0; e < 8; e++) notes.push({ ti: 1, pos: t0 + e * 48, note: 42, vel: 80, len: 12 });
  }
  notes.push({ ti: 0, pos: 300, note: 30, vel: 90, len: 30 }); // before the slice, short: dropped
  notes.push({ ti: 0, pos: 200, note: 31, vel: 90, len: 400 }); // before the slice, held: kept from 0
  const b = backingSlice({ song: base, notes, ccs: [{ ti: 0, pos: 100, cc: 74, v: 50 }, { ti: 0, pos: 500, cc: 74, v: 60 }] }, 384, 384 + 8 * 384);
  assert.equal(b.notes.filter(n => n.ti === 0 && n.note === 30).length, 0, 'short note before the slice dropped');
  const held = b.notes.find(n => n.note === 31);
  assert.deepEqual([held.pos, held.len], [0, 216], 'held note cut to start at 0');
  assert.deepEqual(b.ccs.map(c => [c.pos, c.v]), [[0, 50], [116, 60]], 'the controller value in force is kept');
  assert.deepEqual(backingTracks(b), ['Bass', 'Hats']);
  b.notes = b.notes.filter(n => n.note !== 31);
  const mine = [{ note: 72, vel: 100, pos: 0, len: 96 }, { note: 74, vel: 100, pos: 7 * 384, len: 96 }];
  const r = songFromBacking(b, { name: 'Jam', bpm: 110, length: 8 * 384, items: mine, newRole: 'lead', trackName: 'Me' });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.song.tracks.map(t => t.name), ['Bass', 'Hats', 'Me'], 'silent tracks left out, yours added');
  assert.equal(r.song.bpm, 110);
  // Two 4-bar chunks: the backing repeats (pattern A both times), the new part differs (A, B).
  assert.deepEqual(r.song.song.map(sec => [sec.bars, ...sec.play]), [[4, 'A', 'A', 'A'], [4, 'A', 'A', 'B']]);
  assert.equal(r.song.tracks[0].patterns.A.steps.length, 16, 'bass riff 4 bars');
  assert.equal(r.song.tracks[1].patterns.A.length, 64);
  assert.deepEqual(r.lost, []);
}

// Backing from a run: track ids, a sound change mid-run, overflow onto extra tracks, per-drum velocity.
{
  const { runBacking, backingSlice, songFromBacking, backingTracks } = await import('../js/seq/putclip.js');
  const t = (name, voice) => ({ ...normalizeSong(newSong()).tracks[0], name, voice });
  const r = { base: { name: 'Jam', bpm: 120, meter: '4/4' }, order: [7, 9],
    parts: { 7: [{ pos: 0, track: t('Keys', 'Keys') }, { pos: 768, track: t('Keys', 'Pad') }], 9: [{ pos: 0, track: t('Drums', 'Drums') }] },
    notes: [], ccs: [] };
  for (let bar = 0; bar < 4; bar++) r.notes.push({ tid: 7, pos: bar * 384, note: 60 + bar, vel: 100, len: 96 });
  r.notes.push({ tid: 9, pos: 0, note: 36, vel: 120, len: 10 }, { tid: 9, pos: 0, note: 42, vel: 50, len: 10 });
  const b = runBacking(r, 0, 4 * 384);
  assert.deepEqual(b.song.tracks.map(x => [x.name, x.voice, x._from]), [['Keys', 'Keys', 0], ['Keys', 'Pad', 768], ['Drums', 'Drums', 0]]);
  assert.deepEqual(backingTracks(b), ['Keys', 'Drums'], 'versions named once');
  assert.deepEqual(b.notes.filter(n => n.ti === 1).map(n => n.note), [62, 63], 'notes after the change use the new version');
  const late = backingSlice(b, 768, 4 * 384);
  assert.deepEqual(late.song.tracks.map(x => [x.voice, x._from]), [['Pad', 0]], 'a slice after the change has only the new sound');
  const s = songFromBacking(b, { name: 'X', bpm: 120, length: 4 * 384, items: [{ note: 72, vel: 90, pos: 0, len: 96 }], newRole: 'lead' });
  assert.deepEqual(s.song.tracks.map(x => x.name), ['Keys', 'Drums', 'Lead']);
  assert.deepEqual(s.soundChanges, ['Keys']);
  const kick = s.song.tracks[1].patterns.A.steps[0];
  assert.deepEqual([kick.vel, kick.nv], [120, { 42: 50 }], 'the quieter hat keeps its velocity');
  // Six different 4-bar chunks of bass: A-D on Bass, the rest on "Bass 2".
  const long = { base: r.base, order: [1], parts: { 1: [{ pos: 0, track: t('Bass', 'Bass') }] }, notes: [], ccs: [] };
  for (let k = 0; k < 6; k++) long.notes.push({ tid: 1, pos: k * 4 * 384, note: 36 + k, vel: 100, len: 96 });
  const L = songFromBacking(runBacking(long, 0, 24 * 384), { name: 'L', bpm: 120, length: 24 * 384, items: [{ note: 72, vel: 90, pos: 0, len: 96 }], newRole: 'lead' });
  assert.deepEqual(L.song.tracks.map(x => x.name), ['Bass', 'Bass 2', 'Lead']);
  assert.deepEqual(L.song.song.map(sec => sec.play.slice(0, 2).join(',')), ['A,', 'B,', 'C,', 'D,', ',A', ',B']);
  assert.deepEqual(L.lost, []);
}

// SysEx (an XL sound) survives writing and reading a .mid.
{
  const dump = [0xf0, 0x42, 0x31, 0x7e, 0x40, 1, 2, 3, 0xf7];
  const back = readMidi(writeMidi({ name: 'S', bpm: 120, tracks: [{ name: 'XL', ch: 2, sysex: [{ tick: 0, data: dump }], notes: [{ tick: 0, dur: 96, note: 60, vel: 100 }] }] }));
  assert.deepEqual(back.tracks[1].sysex, [{ tick: 0, data: dump }]);
  assert.equal(back.tracks[1].notes.length, 1);
}

// The mix: per-track settings with decimals kept, one side-chain source, song mix defaults.
{
  const m = normalizeSong({ tracks: [{ pan: -0.35, reverb: 0.4, delay: 2, duck: 0.6, sidechain: true }, { sidechain: true }], mix: { reverb: { size: 4.25 }, delay: { sync: '1/4', feedback: 0.5 }, release: 0.3 } });
  assert.deepEqual([m.tracks[0].pan, m.tracks[0].reverb, m.tracks[0].delay, m.tracks[0].duck], [-0.35, 0.4, 1, 0.6]);
  assert.deepEqual(m.tracks.map(t => t.sidechain), [true, false], 'one side-chain source');
  assert.deepEqual(m.mix, { reverb: { size: 4.25, damping: 0.5 }, delay: { sync: '1/4', feedback: 0.5, tone: 4000 }, release: 0.3 });
  assert.deepEqual(normalizeSong({ tracks: [{}] }).mix.delay.sync, '1/8.', 'defaults');
  assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(m))), m, 'mix survives a round trip');
}

// The chord track: tracks that follow it move, fit or arpeggiate; others play as written.
{
  const bar = (notes, len = 4) => ({ length: 16, steps: notes.map((n, k) => ({ i: k * len, notes: [].concat(n), vel: 100, gate: 80, len })) });
  const s = normalizeSong({
    bpm: 120, scale: { root: 0, type: 'major' }, chords: 'Am | F | C G | Zz',
    tracks: [
      { name: 'Bass', role: 'bass', follow: 'move', patterns: { A: bar([36, 36, 43, 36]) } },
      { name: 'Keys', role: 'chords', follow: 'fit', patterns: { A: { length: 16, steps: [{ i: 0, notes: [48, 52, 55], vel: 100, gate: 90, len: 16 }] } } },
      { name: 'Arp', mode: 'pool', follow: 'move', pool: { notes: [60, 64, 67], order: 'up' }, patterns: { A: bar([[], [], [], []]) } },
      { name: 'Lead', patterns: { A: bar([60]) } },
    ],
    song: [{ bars: 4, play: ['A', 'A', 'A', 'A'] }],
  });
  assert.deepEqual(parseProgression(s.chords).errors, ['Zz']);
  const r = renderSong(s), at = (ti, tick) => r.tracks[ti].notes.filter(n => n.tick === tick).map(n => n.note).sort((a, b) => a - b);
  assert.deepEqual([0, 96, 192, 384, 768, 960].map(t => at(0, t)), [[33], [33], [40], [41], [36], [38]], 'bass moves by scale steps (the shorter way): A, F, then C and G (its G moves to D)');
  assert.deepEqual([at(1, 0), at(1, 384), at(1, 768)], [[48, 52, 57], [48, 53, 57], [48, 52, 55]], 'keys fit to Am, F, C');
  assert.deepEqual([0, 96, 192, 288, 384].map(t => at(2, t)), [[57], [60], [64], [57], [69]], 'the pool arpeggiates the chord (Am from A3, then F from F4, carrying on its walk)');
  assert.deepEqual(at(3, 384), [60], 'tracks that don\'t follow play as written');
  // In song mode one progression runs across the sections, counted in bars (a 3/4 section gets one
  // chord per bar too), and starts again when the song does.
  const t = normalizeSong({ ...s, chords: 'Am | F | C | G', song: [{ bars: 2, play: ['A', null, null, null] }, { bars: 1, meter: '3/4', play: ['A', null, null, null] }] });
  const tn = renderSong(t).tracks[0].notes, bass = tick => tn.filter(n => n.tick === tick).map(n => n.note);
  assert.deepEqual([bass(0), bass(384), bass(768)], [[33], [41], [36]], 'Am, F, then C in section 2');
  assert.equal(normalizeSong({ ...t, song: [{ bars: 1, play: ['A'], chords: 'D' }] }).song[0].chords, undefined, 'sections have no chords of their own');
  assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(t))), t, 'chords survive a round trip');
  assert.equal(commonProgressions({ root: 9, type: 'minor' })[0].text, 'Am | F | C | G');
}

// The piano roll: notes as a list, each its own length, held notes carrying on under later ones.
{
  const pat = { length: 16, steps: [{ i: 0, notes: [], vel: 100, gate: 60, len: 1 }, { i: 4, notes: [60], vel: 90, gate: 50, len: 2, prob: 50 }] };
  setRollNotes(pat, [{ i: 0, note: 48, len: 16, vel: 100 }, { i: 0, note: 60, len: 2, vel: 70 }, { i: 4, note: 62, len: 2, vel: 90 }, { i: 8, note: 64, len: 4, vel: 110 },
    { i: 10, note: 64, len: 2, vel: 100 }, { i: 15, note: 67, len: 9, vel: 100 }]);
  assert.deepEqual(pat.steps[0], { i: 0, notes: [48, 60], vel: 100, gate: 100, len: 4, nv: { 60: 70 }, nl: { 48: 16, 60: 2 } }, 'a step for notes starting together; the lowest note\'s length is cut to the next step, kept in nl');
  assert.deepEqual(pat.steps[1], { i: 4, notes: [62], vel: 90, gate: 50, len: 2, prob: 50 }, 'an existing step keeps its gate and chance');
  assert.deepEqual(rollNotes(pat).map(x => [x.i, x.note, x.len]), [[0, 48, 16], [0, 60, 2], [4, 62, 2], [8, 64, 2], [10, 64, 2], [15, 67, 1]], 'same pitch cut short; lengths end at the pattern');
  assert.deepEqual(cleanPattern(JSON.parse(JSON.stringify(pat))), pat, 'survives cleaning');
  const s = normalizeSong({ bpm: 120, tracks: [{ name: 'Keys', patterns: { A: pat } }], song: [{ bars: 1, play: ['A'] }] });
  const notes = renderSong(s).tracks[0].notes;
  assert.deepEqual(notes.filter(n => n.tick === 0).map(n => [n.note, n.dur]).sort(), [[48, 384], [60, 48]], 'the held note sounds its whole length under the others');
  // A take: a held note with others starting under it keeps sounding.
  const tp = takeToPattern([{ pos: 0, len: 384, note: 48, vel: 100 }, { pos: 96, len: 48, note: 60, vel: 100 }, { pos: 192, len: 48, note: 62, vel: 100 }], 24);
  assert.deepEqual(rollNotes(tp).map(x => [x.i, x.note, x.len]), [[0, 48, 16], [4, 60, 2], [8, 62, 2]], 'a take keeps each note\'s length');
  const st = { i: 0, notes: [48, 60], vel: 100, len: 4, nv: { 60: 70 }, nl: { 48: 16 } };
  assert.deepEqual(mapNotes(st, n => n + 2), { i: 0, notes: [50, 62], vel: 100, len: 4, nv: { 62: 70 }, nl: { 50: 16 } }, 'transposing keeps per-note velocity and length');
}

// Song mode: start at a section, loop one, jump at the next bar; the chord track counts song bars.
{
  const one = n => ({ length: 16, steps: [{ i: 0, notes: [n], vel: 100, gate: 50, len: 1 }] });
  const song = normalizeSong({ bpm: 120, chords: 'C | D | E | F', tracks: [{ name: 'Lead', patterns: { A: one(60), B: one(62), C: one(64) } }],
    song: [{ bars: 1, play: ['A'], name: 'Intro' }, { bars: 2, play: ['B'] }, { bars: 1, play: ['C'] }] });
  assert.equal(song.song[0].name, 'Intro');
  const go = (setup, ms, act) => {
    let t = 1000;
    const out = [];
    const e = new Engine({ song: () => song, now: () => t, sink: { note: (ti, n, v, at) => out.push(n), bar: (sec) => out.push(`§${sec}`) } });
    e.mode = 'song';
    setup(e);
    e.play();
    for (; t < 1000 + ms; t += 25) { act?.(e, t); e.pump(); }
    return { out, e };
  };
  // Bars last 2 s at 120 BPM; a note on each bar's first step.
  assert.deepEqual(go(e => { e.from = 1; }, 7900).out.filter(x => typeof x === 'number'), [62, 62, 64, 60], 'from section 2: B, B, C, then the top');
  assert.deepEqual(go(e => { e.from = 1; e.loopSection = 1; }, 7900).out.filter(x => typeof x === 'number'), [62, 62, 62, 62], 'looping section 2');
  const j = go(() => {}, 5900, (e, t) => { if (t === 1500) e.jumpTo = 2; });
  assert.deepEqual(j.out.filter(x => typeof x === 'number'), [60, 64, 60], 'a jump waits for the next bar');
  const c = go(e => { e.from = 2; }, 1900);
  assert.equal(c.e.chordFor(song, 0).chord.name, 'F', 'starting at section 3 (bar 4) plays bar 4\'s chord');
}

// Fills: a track plays another pattern in its section's last bar, then the next section as usual.
{
  const one = n => ({ length: 16, steps: [{ i: 0, notes: [n], vel: 100, gate: 50, len: 1 }, { i: 8, notes: [n], vel: 100, gate: 50, len: 1 }] });
  const song = normalizeSong({ bpm: 120, tracks: [{ name: 'Drums', patterns: { A: one(36), C: one(38) } }, { name: 'Bass', patterns: { A: one(40), C: one(41) } }],
    song: [{ bars: 2, play: ['A', 'A'], fill: ['C', null] }, { bars: 1, play: ['A', null], fill: [null, 'C'] }, { bars: 1, play: ['A', 'A'], fill: 'x' }] });
  assert.deepEqual(song.song.map(s => s.fill), [['C', null], [null, 'C'], undefined]);
  const r = renderSong(song);
  assert.deepEqual(r.tracks[0].notes.map(n => n.note), [36, 36, 38, 38, 36, 36, 36, 36], 'the drums fill bar 2, then go on with A');
  assert.deepEqual(r.tracks[1].notes.map(n => n.note), [40, 40, 40, 40, 41, 41, 40, 40], 'a track silent in its section still plays its fill');
  const s2 = JSON.parse(JSON.stringify(song));
  s2.tracks.push(s2.tracks[0]); s2.song.forEach(s => { s.play.push('A'); s.fill?.push(null); });
  assert.deepEqual(normalizeSong(s2).song[0].fill, ['C', null, null], 'one entry per track');
}

// Automation: lanes across the song, sent every sixteenth when the value changes, as CCs in the .mid.
{
  const one = n => ({ length: 16, steps: [{ i: 0, notes: [n], vel: 100, gate: 50, len: 1 }] });
  const song = normalizeSong({ bpm: 120, tracks: [{ name: 'Pad', vol: 100, patterns: { A: one(60) } }, { name: 'Bass', patterns: { A: one(36) } }],
    song: [{ bars: 2, play: ['A', 'A'] }, { bars: 1, play: ['A', 'A'] }],
    auto: [{ ti: 0, target: 'filter', points: [{ at: 2, v: 1 }, { at: 0, v: 0 }] }, { ti: 0, target: 'level', points: [{ at: 0, v: 0.5 }] },
      { ti: 1, target: 'cc', cc: 1, points: [{ at: 1, v: 1 }] }, { ti: 5, target: 'level', points: [] }, { ti: 1, target: 'cc', cc: 'x', points: [] }] });
  assert.equal(song.auto.length, 3, 'lanes for missing tracks or bad CCs are dropped');
  assert.deepEqual(song.auto[0].points.map(p => p.at), [0, 2], 'points in order');
  assert.equal(autoValue(song.auto[0].points, 1), 0.5);
  assert.equal(autoValue(song.auto[0].points, 3), 1, 'holds after the last point');
  const r = renderSong(song), f = r.autos.filter(a => a.target === 'filter');
  assert.deepEqual([f[0].tick, f[0].v], [0, 0]);
  assert.ok(f.some(a => a.tick === 384 && Math.abs(a.v - 0.5) < 0.01), 'halfway at bar 2');
  assert.equal(f.at(-1).tick, 768, 'stops sending once it holds');
  assert.deepEqual(r.tracks[0].ccs.filter(c => c.cc === 7), [{ tick: 0, cc: 7, v: 50 }], 'level as CC 7 (× the track\'s level)');
  assert.ok(r.tracks[1].ccs.some(c => c.cc === 1 && c.v === 127), 'a CC lane');
  const s2 = JSON.parse(JSON.stringify(song));
  removeTrack(s2, 0);
  assert.deepEqual(s2.auto.map(l => [l.ti, l.target]), [[0, 'cc']], 'removing a track removes its lanes and renumbers the rest');
}

console.log('ok — sequencer model and engine');
