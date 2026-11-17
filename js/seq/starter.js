// A starting song from a set of Sound Lab sounds ("New song" on a collection): a track for each
// sound, with a first part written for what that sound is. No DOM, so tests can run it.
//
// Two questions are answered here. What does each sound want to be played like? (`soundTraits`: a
// kit, something that plays itself from a held key, something slow to speak or long to ring, one
// note at a time, which octave it sounds in.) And how do they go together? (`starterSong`: one
// tempo, key and chord progression for everyone; one sound leads each job (the beat, the bass
// line, the held chords…) and a second sound of the same kind takes over in the B section rather
// than doubling it; parts are written over the home chord and follow the song's chord track, so
// changing the chords afterwards moves all of them.)
import * as M from './model.js';
import { randomIdea, seeded, euclid } from './generate.js';
import { commonProgressions } from './chords.js';

// ---- what a sound is ----
const TYPE_ROLE = { Drums: 'drums', Bass: 'bass', Pad: 'pad', Strings: 'pad', Keys: 'chords', Organ: 'chords', Brass: 'chords', Pluck: 'arp', Bell: 'arp', Lead: 'lead' };
const LONG_FX = ['spectral', 'shimmer', 'freeze', 'feedback', 'resonance'];

export function soundTraits(patch, type) {
  const mods = patch?.modules || [], has = t => mods.some(m => m.type === t && !m.off), of = t => mods.filter(m => m.type === t && !m.off);
  const wires = patch?.mod || [];
  const kit = has('drums');
  // Plays itself from a held key: the arpeggiator (wants a chord), a step sequence, or a
  // tempo-synced LFO stepping or plucking something (wants one long note).
  const stepped = of('seq').some(m => wires.some(c => c.from === m.id))
    || of('lfo').some(m => m.params.sync && m.params.sync !== 'off' && ['rise', 'square', 'saw', 'random'].includes(m.params.wave) && wires.some(c => c.from === m.id));
  const self = patch?.arp ? 'chord' : stepped ? 'note' : null;
  // How it speaks: the slowest Amp attack, and whether it holds while the key is down.
  const amps = of('amp');
  const attack = Math.max(0, ...amps.map(m => m.params.attack));
  const holds = amps.some(m => m.params.sustain >= 0.5) || has('organ') || of('lpg').some(m => m.params.trigger === 'while held')
    || (!amps.length && !has('lpg') && (has('osc') || has('noise') || has('granular')));
  // Rings long after the key: effects that hold or smear, big reverbs, clouds that feed themselves,
  // and struck things with long decays.
  const tail = LONG_FX.some(has) || of('reverb').some(m => m.params.size >= 4 && m.params.mix >= 0.3) || of('grains').some(m => m.params.feedback >= 0.4 || m.params.scatter >= 0.7)
    || of('resonator').some(m => m.params.decay >= 4) || of('fmop').some(m => m.params.sustain < 0.2 && m.params.decay >= 3) || of('delay').some(m => m.params.feedback >= 0.6);
  // The octave it sounds in against the key played: its sources' Octave settings, by level.
  let sum = 0, weight = 0;
  for (const m of mods) if (!m.off && Number.isFinite(m.params?.octave) && ['osc', 'string', 'piano', 'organ', 'resonator'].includes(m.type)) {
    const w = m.type === 'resonator' && m.params.tune === 'fixed' ? 0 : (m.params.level ?? 1) || 0.01;
    sum += m.params.octave * w; weight += w;
  }
  return {
    kit, self, tail, holds, slow: attack >= 0.15, mono: patch?.play === 'mono' || patch?.play === 'legato',
    wheel: wires.some(c => c.from === 'wheel'), octave: weight ? Math.round(sum / weight) : 0,
    role: kit ? 'drums' : TYPE_ROLE[type] || 'lead', spot: type === 'FX',
  };
}

// ---- moods: tempo, swing, the drum generator's density, how busy the pitched parts are ----
const MOODS = [
  { name: 'steady', bpm: [112, 124], swing: [50, 54], style: '', density: 'medium', scales: ['minor', 'dorian', 'major'] },
  { name: 'broken', bpm: [88, 100], swing: [56, 60], style: 'breaks', density: 'medium', scales: ['minor', 'dorian'] },
  { name: 'driving', bpm: [124, 134], swing: [50, 50], style: 'motorik', density: 'medium', scales: ['minor', 'mixolydian', 'major'] },
  { name: 'slow', bpm: [72, 86], swing: [50, 56], style: 'halftime', density: 'sparse', scales: ['minor', 'dorian', 'phrygian'] },
];
const ROOTS = [0, 2, 4, 5, 7, 9, 10];

// A written root for a job: the scale's root nearest `target` as it should SOUND, moved by the
// sound's own octave setting (a bass whose oscillators are set an octave down is written higher).
const rootFor = (scale, target, traits) => target - (((target - scale.root) % 12) + 12) % 12 - 12 * traits.octave;

// A self-playing sound is held as a chord if it arpeggiates, or is the kind of sound chords are played on.
const holdsChord = tr => tr.self === 'chord' || tr.role === 'pad' || tr.role === 'chords';
const step = (i, notes, vel, gate, len = 1, more = {}) => ({ i, notes, vel, gate, len, ...more });
const shift = (pattern, by) => by ? { ...pattern, steps: pattern.steps.map(s => M.mapNotes ? M.mapNotes(s, n => n + by) : { ...s, notes: s.notes.map(n => n + by) }) } : pattern;

// ---- the parts ----
// Each returns { A, B? } patterns, written over the home chord (the chord track moves them).
function writers({ scale, mood, rng }) {
  const r = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)), pick = list => list[Math.floor(rng() * list.length)];
  const degs = M.SCALES[scale.type], third = degs[2], fifth = degs[4], seventh = degs[6];
  const triad = root => [root, root + third, root + fifth];
  const one = (tr, notes) => tr.mono ? [notes[notes.length - 1]] : notes;
  const pat = (length, steps) => M.cleanPattern({ length, steps });
  return {
    beat(tr) {
      const idea = () => randomIdea({ role: 'drums', length: 32, style: mood.style, density: mood.density, rng }).pattern;
      return { A: idea(), B: idea() };
    },
    // A second kit: a few hand-drum and bell hits spread unevenly, so it answers the beat instead of doubling it.
    perc(tr) {
      const pads = [[50, 47, 43], [56, 37], [48, 45, 41], [51, 44]][r(0, 3)];
      const make = (k, n, rot) => pat(n, euclid(k, n, rot).map((on, i) => on && step(i, [pads[(i * 7 + rot) % pads.length]], i % 4 === 0 ? r(85, 100) : r(55, 80), 30)).filter(Boolean));
      return { A: make(r(3, 5), 16, r(1, 3)), B: make(r(5, 7), 16, r(0, 3)) };
    },
    bass(tr) {
      const by = rootFor(scale, 43, tr) - rootFor(scale, 43, { octave: 0 });
      const idea = () => shift(randomIdea({ role: 'bass', length: 32, scale, density: mood.density, rng }).pattern, by);
      return { A: idea(), B: idea() };
    },
    // Held chords, a bar each (slow sounds get the whole bar; others let go a little early).
    pad(tr) {
      const root = rootFor(scale, 57, tr), chord = one(tr, [root - 12, ...triad(root)].slice(tr.slow ? 0 : 1));
      return { A: pat(16, [step(0, chord, 84, tr.slow ? 100 : 92, 16)]) };
    },
    // Stabs: a rhythm on the home chord.
    chords(tr) {
      const root = rootFor(scale, 60, tr), chord = one(tr, [...triad(root).slice(1), root + 12]);
      const shapes = mood.density === 'sparse' ? [[0, 10], [4, 12], [0, 6]] : [[0, 3, 6, 10], [2, 6, 10, 14], [0, 6, 8, 14], [4, 7, 12]];
      const make = hits => pat(16, hits.map((i, k) => step(i, chord, k ? r(72, 92) : r(92, 108), tr.holds ? 70 : 50, tr.holds && hits[k + 1] - i > 2 ? 2 : 1)));
      const a = pick(shapes), b = pick(shapes.filter(s => s !== a));
      return { A: make(a), B: make(b) };
    },
    // Plucks and bells: the chord's notes one at a time. Long-ringing ones get a few notes a bar.
    arp(tr) {
      const root = rootFor(scale, tr.tail ? 72 : 64, tr), notes = [root, root + third, root + fifth, root + 12, root + 12 + third];
      const every = tr.tail ? 8 : mood.density === 'sparse' ? 4 : 2, orders = [[0, 1, 2, 3, 2, 1], [0, 2, 1, 3], [3, 2, 1, 0, 1, 2], [0, 2, 4, 2, 3, 1]];
      const make = order => pat(32, Array.from({ length: 32 / every }, (_, k) => (tr.tail || rng() < 0.85) && step(k * every, [notes[order[k % order.length]]], k % (8 / Math.min(8, every)) ? r(68, 88) : r(92, 106), 60, 1)).filter(Boolean));
      const a = pick(orders);
      return { A: make(a), B: make(pick(orders.filter(o => o !== a))) };
    },
    lead(tr) {
      // The generator writes from the scale's root at or under middle C; a melody sits an octave above that, clear of the chords.
      const by = rootFor(scale, 72, tr) - rootFor(scale, 60, { octave: 0 });
      return { A: shift(randomIdea({ role: 'lead', length: 32, scale, density: 'sparse', rng }).pattern, by) };
    },
    // A sound that plays itself: hold a key (or a chord, for an arpeggiator) for the whole bar.
    held(tr, type) {
      const low = type === 'Bass', root = rootFor(scale, low ? 43 : tr.role === 'pad' ? 55 : 60, tr);
      const notes = holdsChord(tr) ? one(tr, triad(root)) : [root];
      return { A: pat(16, [step(0, notes, 92, 96, 16)]) };
    },
    // An effect or a very long sound: once every four bars.
    spot(tr) {
      const root = rootFor(scale, 60, tr);
      return { A: pat(64, [step(0, [root], 100, 90, tr.holds ? 32 : 2)]) };
    },
  };
}

// Level, pan, sends and ducking per job (factory sounds are already at similar levels).
const MIX = {
  beat: { vol: 100 }, perc: { vol: 80, reverb: 0.12 }, bass: { vol: 98, duck: 0.3 }, pad: { vol: 74, duck: 0.25, reverb: 0.15 },
  chords: { vol: 82, reverb: 0.1 }, arp: { vol: 80, reverb: 0.15, delay: 0.12 }, lead: { vol: 88, reverb: 0.18, delay: 0.15 },
  held: { vol: 78, reverb: 0.1 }, spot: { vol: 84, reverb: 0.25 },
};
const FOLLOW = { bass: 'move', pad: 'fit', chords: 'fit', arp: 'fit', held: 'fit' };
const ORDER = ['beat', 'perc', 'bass', 'held', 'pad', 'chords', 'arp', 'lead', 'spot'];
const SAY = { beat: 'the beat', perc: 'percussion round it', bass: 'the bass line', pad: 'held chords', chords: 'chord stabs', arp: tr => tr.tail ? 'a few ringing notes a bar' : 'a picked figure', lead: 'a melody',
  held: tr => holdsChord(tr) ? 'a chord held each bar (it plays itself)' : 'one key held each bar (it plays itself)', spot: 'once every four bars' };

// sounds: [{ name, type, patch }]. Returns { song, notes: [one line per track], lost }.
export function starterSong({ title, sounds = [], seed = Date.now() }) {
  const rng = seeded(seed), r = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)), pick = list => list[Math.floor(rng() * list.length)];
  const all = sounds.map(s => ({ ...s, traits: soundTraits(s.patch, s.type) }));
  // The job each sound gets.
  const jobOf = s => s.traits.kit ? 'beat' : s.traits.self ? 'held' : s.traits.spot ? 'spot' : s.traits.role;
  for (const s of all) s.job = jobOf(s);
  let seenKit = false;
  for (const s of all) if (s.job === 'beat') { if (seenKit) s.job = 'perc'; seenKit = true; }
  // More sounds than tracks: a band is picked across the jobs (one of each first, then seconds…),
  // not the first eight in the list, which could be all kits or all pads.
  const chosen = [];
  for (let round = 0; chosen.length < Math.min(all.length, M.MAX_TRACKS) && round < all.length; round++) {
    for (const job of ORDER) { const s = all.filter(x => x.job === job)[round]; if (s && chosen.length < M.MAX_TRACKS) chosen.push(s); }
  }
  const list = chosen.sort((a, b) => ORDER.indexOf(a.job) - ORDER.indexOf(b.job) || all.indexOf(a) - all.indexOf(b));
  // A mood: slow if most of the pitched sounds are slow to speak or long to ring.
  const pitched = list.filter(s => !s.traits.kit), dreamy = pitched.filter(s => s.traits.slow || s.traits.tail).length;
  const mood = pitched.length && dreamy * 2 > pitched.length ? MOODS.find(m => m.name === 'slow') : pick(MOODS.filter(m => m.name !== 'slow'));
  const scale = { root: pick(ROOTS), type: pick(mood.scales) };
  const song = M.newSong();
  Object.assign(song, { name: String(title || 'Untitled').slice(0, 60), bpm: r(...mood.bpm), swing: r(...mood.swing), scale, tracks: [], song: [] });
  const progs = commonProgressions(scale).filter(p => !/7 \|.*7 \|.*7/.test(p.text) || p.text.split('|').length <= 4);
  const prog = pick(progs.filter(p => p.text.split('|').length === 4)) || progs[0];
  song.chords = prog.text;

  const write = writers({ scale, mood, rng }), notes = [], seen = {};
  const plays = []; // per track: which pattern in [intro, A, B, out]
  for (const s of list) {
    const nth = seen[s.job] = (seen[s.job] || 0) + 1, parts = write[s.job](s.traits, s.type);
    const mix = MIX[s.job], side = nth % 2 ? -1 : 1;
    const t = M.addTrack(song, { role: s.job === 'beat' || s.job === 'perc' ? 'drums' : s.job === 'held' || s.job === 'spot' ? s.traits.role : s.job,
      name: M.freeTrackName(song, s.name.slice(0, 24)), mode: 'steps', inst: M.cleanInst({ name: s.name, patch: s.patch }),
      vol: mix.vol, reverb: mix.reverb || 0, delay: mix.delay || 0, duck: mix.duck || 0, sidechain: s.job === 'beat',
      pan: ['perc', 'chords', 'arp', 'lead', 'held'].includes(s.job) && (seen[s.job] > 1 || s.job === 'perc' || s.job === 'arp') ? side * 0.25 : 0,
      follow: s.traits.kit || s.job === 'spot' || s.job === 'lead' ? null : s.job === 'held' ? (holdsChord(s.traits) ? 'fit' : 'move') : FOLLOW[s.job] });
    t.patterns.A = parts.A;
    t.patterns.B = parts.B || M.copyPattern(parts.A);
    // Who plays where: sounds that share a job take turns through the A, B and C sections instead
    // of doubling each other (the first has A, the second B, the third C, the fourth A again). A
    // sound alone in its job plays all three, except the melody and the effects, which wait for B.
    // Textures (the first pad, picked figure, self-playing sound and second kit) open and close the song.
    const group = list.filter(o => o.job === s.job), idx = nth - 1, late = s.job === 'lead' || s.job === 'spot';
    const turn = sec => late ? (group.length === 1 ? sec > 0 : sec === 1 + idx % 2) : group.length === 1 ? true : group.length === 2 ? (idx === 0 ? sec !== 1 : sec === 1) : idx % 3 === sec;
    const texture = ['pad', 'held', 'arp', 'perc'].includes(s.job) && idx === 0;
    const where = [0, 1, 2].filter(turn);
    plays.push({ intro: texture ? 'A' : null, A: turn(0) ? 'A' : null, B: turn(1) ? 'B' : null, C: turn(2) ? 'A' : null, out: texture || (s.job === 'bass' && idx === 0) ? 'A' : null });
    const when = where.length === 3 ? '' : `, in ${where.map(k => 'ABC'[k]).join(' and ')}`;
    notes.push(`${t.name}: ${typeof SAY[s.job] === 'function' ? SAY[s.job](s.traits) : SAY[s.job]}${when}${s.traits.wheel ? ' (its mod wheel does more)' : ''}`);
  }
  // With nothing to open on (no pad, pluck or second kit), the beat opens alone, or else the first track.
  if (!plays.some(p => p.intro)) { const k = Math.max(0, list.findIndex(o => o.job === 'beat')); plays[k].intro = 'A'; plays[k].out = 'A'; }
  song.song = [
    { name: 'Intro', bars: 4, play: plays.map(p => p.intro) },
    { name: 'A', bars: 8, play: plays.map(p => p.A) },
    { name: 'B', bars: 8, play: plays.map(p => p.B) },
    { name: 'C', bars: 8, play: plays.map(p => p.C) },
    { name: 'Out', bars: 4, play: plays.map(p => p.out) },
  ];
  const clean = M.normalizeSong(song);
  return { song: clean, notes, left: all.filter(x => !list.includes(x)).map(x => x.name), mood: mood.name, key: `${M.NOTE_NAMES[scale.root]} ${scale.type}`, chords: prog.text, lost: sounds.length - list.length };
}
