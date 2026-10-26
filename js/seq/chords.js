// The chord track: a progression the song's tracks can follow. No DOM or MIDI here.
//
// A progression is typed like a lead sheet: bars separated by "|", chords in a bar by spaces (they
// share the bar equally), "-" continues the chord before it, "%" repeats the bar before, "N.C."
// (no chord) lets following tracks play as written. "Am | F | C G | E7" is four bars, the third
// half C, half G. The song's `chords` (one progression for the whole song) plays from bar 1 and
// loops: from where playback starts in loop mode, from the top of the song in song mode, carrying
// on across sections. It's counted in bars, so sections in other meters get one bar per bar.
//
// A track's `follow` says how it follows (absent = it doesn't):
//   'move'  the pattern moves with each chord's root, by scale steps when the song has a scale (a
//           bassline or riff written over the key's tonic chord keeps its shape on every chord)
//   'fit'   each step's notes go to the nearest notes of the chord, keeping their register (chords
//           and pads written as any chord become the current one, a melody stays on chord tones)
// Note-pool tracks that follow play the current chord's notes instead of their pool.
import { NOTE_NAMES, SCALES } from './model.js';

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Chord qualities: intervals above the root (stacked, not folded into an octave).
const QUALITIES = {
  '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], '-': [0, 3, 7], 5: [0, 7],
  6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], 'Δ': [0, 4, 7, 11], 'Δ7': [0, 4, 7, 11],
  m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], '-7': [0, 3, 7, 10], mmaj7: [0, 3, 7, 11], 'm(maj7)': [0, 3, 7, 11],
  dim: [0, 3, 6], o: [0, 3, 6], dim7: [0, 3, 6, 9], o7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], 'ø': [0, 3, 6, 10], 'ø7': [0, 3, 6, 10],
  aug: [0, 4, 8], '+': [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], '7sus4': [0, 5, 7, 10], '7sus': [0, 5, 7, 10],
  9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  11: [0, 4, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17], 13: [0, 4, 7, 10, 14, 21],
};
const pcOf = (letter, acc) => (PC[letter] + (acc === '#' || acc === '♯' ? 1 : acc === 'b' || acc === '♭' ? -1 : 0) + 12) % 12;
const mod12 = n => ((n % 12) + 12) % 12;

// "C#m7/G#" → { name, root (0-11), bass (0-11), ints: [0, 3, 7, 10], pcs: [1, 4, 8, 11] }, or null.
export function parseChord(text) {
  const m = /^([A-Ga-g])([#b♯♭]?)([^/]*)(?:\/([A-Ga-g])([#b♯♭]?))?$/.exec(String(text).trim());
  if (!m) return null;
  const ints = QUALITIES[m[3]];
  if (!ints) return null;
  const root = pcOf(m[1].toUpperCase(), m[2]);
  const bass = m[4] ? pcOf(m[4].toUpperCase(), m[5]) : root;
  return { name: String(text).trim(), root, bass, ints, pcs: [...new Set(ints.map(i => (root + i) % 12))] };
}

// The progression's bars: [[chord | null, …], …] (null = no chord). Returns { bars, errors }.
export function parseProgression(text) {
  const bars = [], errors = [];
  let last = null;
  for (const raw of String(text || '').split('|')) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    if (tokens.length === 1 && tokens[0] === '%') { if (bars.length) bars.push([...bars[bars.length - 1]]); continue; }
    const bar = [];
    for (const tk of tokens) {
      if (tk === '-' || tk === '/') { bar.push(last); continue; }
      if (/^n\.?c\.?$/i.test(tk)) { last = null; bar.push(null); continue; }
      const c = parseChord(tk);
      if (!c) { errors.push(tk); continue; }
      bar.push(c); last = c;
    }
    if (bar.length) bars.push(bar.slice(0, 8));
  }
  return { bars: bars.slice(0, 64), errors };
}

const parsed = new Map(); // text -> { bars, errors }, so the engine doesn't parse on every step
export function progression(text) {
  let p = parsed.get(text);
  if (!p) { p = parseProgression(text); if (parsed.size > 200) parsed.clear(); parsed.set(text, p); }
  return p;
}

// The chord in bar `n` (counted from 0 where the progression started; it loops), `frac` (0-1) of the
// way through that bar: { chord | null, bar (in the progression), slot } or null without one.
export function chordAt(text, n, frac = 0) {
  const { bars } = progression(text);
  if (!bars.length) return null;
  const bar = ((n % bars.length) + bars.length) % bars.length, slots = bars[bar];
  const slot = Math.min(slots.length - 1, Math.max(0, Math.floor(frac * slots.length)));
  return { chord: slots[slot], bar, slot };
}

// The note a 'move' track's patterns are written over: the scale's tonic, else the first chord's root.
export function referenceRoot(song, text) {
  if (song.scale) return song.scale.root;
  return progression(text).bars.flat().find(Boolean)?.root ?? 0;
}

// 'move': the note shifted from the reference root to the chord's root (its bass, for a slash chord:
// a bassline under C/E starts on E). With a scale and both roots
// in it, by scale steps (C E G over C becomes D F A over Dm in C major); otherwise by semitones.
// Shifts go the shorter way (at most half an octave), so the line stays in its register.
export function moveNote(note, chord, ref, scale) {
  const deg = scale && SCALES[scale.type], idx = pc => deg ? deg.indexOf(mod12(pc - scale.root)) : -1;
  const target = chord.bass, a = idx(ref), b = idx(target), n = deg?.length;
  if (deg && a >= 0 && b >= 0 && idx(note) >= 0) {
    let steps = b - a;
    if (steps > n / 2) steps -= n; else if (steps < -n / 2) steps += n;
    const i = idx(note), k = i + steps;
    return note - deg[i] + deg[((k % n) + n) % n] + 12 * Math.floor(k / n);
  }
  let d = mod12(target - ref);
  if (d > 6) d -= 12;
  return note + d;
}

// 'fit': the step's notes moved to the chord, each (from the lowest) to the nearest chord note not
// already taken, so a written chord becomes the nearest voicing of the current one.
export function fitNotes(notes, chord) {
  const sorted = [...notes].sort((a, b) => a - b), used = new Set(), out = new Map();
  const nearest = (n, pcs) => {
    let best = null;
    for (let d = 0; d <= 12 && best === null; d++) for (const c of [n - d, n + d]) if (best === null && pcs.includes(mod12(c)) && !used.has(c)) best = c;
    return best ?? n;
  };
  sorted.forEach(n => {
    const m = nearest(n, chord.pcs);
    used.add(m);
    out.set(n, m);
  });
  return out;
}

// A following note-pool track's notes: the chord from the root nearest the pool's lowest note (so
// it stays in the pool's register), over two octaves when the pool spans more than one.
export function chordPool(chord, pool) {
  const lo = pool.length ? Math.min(...pool) : 48, span = pool.length ? Math.max(...pool) - lo : 0;
  let d = mod12(chord.root - lo);
  if (d > 6) d -= 12;
  const root = lo + d;
  const one = chord.ints.map(i => root + i);
  if (chord.bass !== chord.root) one.unshift(root - mod12(chord.root - chord.bass));
  return span > 12 ? [...one, ...chord.ints.map(i => root + 12 + i)] : one;
}

// ---- progressions in a key ----

// Triads (or sevenths) on each degree of a seven-note scale; five- and six-note scales use their
// parent (minor pentatonic and blues → minor, major pentatonic → major).
const PARENT = { 'minor pentatonic': 'minor', 'major pentatonic': 'major', blues: 'minor' };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
function diatonic(scale, degree, sevenths = false) {
  // Harmonic minor: natural minor's chords, but a major V (the raised seventh is its point).
  const type = scale.type === 'harmonic minor' && degree !== 4 ? 'minor' : PARENT[scale.type] || scale.type, deg = SCALES[type];
  const at = k => deg[(degree + k) % 7] + 12 * Math.floor((degree + k) / 7);
  const ints = [0, 2, 4, ...(sevenths ? [6] : [])].map(k => at(k) - at(0));
  const name = Object.entries(QUALITIES).find(([q, v]) => ['', 'm', 'dim', 'aug', '7', 'maj7', 'm7', 'm7b5', 'mmaj7'].includes(q) && v.join() === ints.join())?.[0];
  return `${NOTE_NAMES[(scale.root + deg[degree]) % 12]}${name ?? ''}`;
}
// Common progressions as scale degrees (0 = the tonic), for major-like and minor-like keys.
const BLUES = ['12-bar blues', [0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7]]; // semitones, dominant sevenths
const COMMON = {
  dorian: [['Dorian vamp', [0, 3]], ['Dorian walk', [0, 1, 2, 1]], ['Dorian rise', [0, 6, 3, 3]], ['Minor loop', [0, 3, 6, 2]], BLUES],
  mixolydian: [['Mixolydian rock', [0, 6, 3, 0]], ['Mixolydian vamp', [0, 6]], ['Rock', [0, 3, 0, 4]], BLUES],
  phrygian: [['Phrygian vamp', [0, 1]], ['Phrygian descent', [0, 1, 6, 1]], ['Dark loop', [0, 5, 1, 0]]],
  major: [['Pop', [0, 4, 5, 3]], ['Fifties', [0, 5, 3, 4]], ['Sensitive', [5, 3, 0, 4]], ['Jazz ii–V–I', [1, 4, 0, 0], true], ['Rock', [0, 3, 0, 4]], ['Canon', [0, 4, 5, 2, 3, 0, 3, 4]], ['Two-chord', [0, 3]], BLUES],
  minor: [['Epic', [0, 5, 2, 6]], ['Andalusian', [0, 6, 5, 4]], ['Dark pop', [0, 5, 3, 4]], ['Minor loop', [0, 3, 6, 2]], ['Moody', [0, 0, 5, 5]], ['House', [0, 6, 5, 6], true], ['Two-chord', [0, 6]], BLUES],
};
const MINORISH = new Set(['minor', 'dorian', 'phrygian', 'harmonic minor', 'minor pentatonic', 'blues']);
// [{ name, text, numerals }] for the scale (C major when there's none).
export function commonProgressions(scale) {
  const sc = scale && SCALES[scale.type] ? scale : { root: 0, type: 'major' };
  const list = COMMON[sc.type] || COMMON[MINORISH.has(sc.type) ? 'minor' : 'major'];
  return list.map(([name, degs, sev]) => name === BLUES[0] ? {
    name, text: degs.map(d => `${NOTE_NAMES[(sc.root + d) % 12]}7`).join(' | '), numerals: 'I7–IV7–V7',
  } : {
    name, text: degs.map(d => diatonic(sc, d, sev)).join(' | '),
    numerals: degs.map(d => { const c = parseChord(diatonic(sc, d)); const r = ROMAN[d]; return c && c.ints[1] === 3 ? r.toLowerCase() + (c.ints[2] === 6 ? '°' : '') : r; }).join('–'),
  });
}
