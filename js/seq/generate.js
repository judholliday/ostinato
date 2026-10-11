// Instant pattern ideas without the AI (the 🎲 button): rhythm rules plus the song's scale,
// shaped by the track's role. Every call gives a different idea; pass `rng` to repeat one.
import { SCALES, NOTE_NAMES, ROLES, cleanPattern } from './model.js';

// Small seedable random generator, so tests can repeat a result.
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// k hits spread as evenly as possible over n steps (Euclidean rhythm), rotated by `rot`.
// euclid(3, 8) is the tresillo: x..x..x.
export function euclid(k, n, rot = 0) {
  k = Math.max(0, Math.min(n, k));
  return Array.from({ length: n }, (_, i) => (((i + n - rot) % n) * k) % n < k);
}

const DENSITY = { sparse: 0.22, medium: 0.38, busy: 0.6 };

// Rhythm feels for one bar of n steps (16 = a bar of 16ths), as on/off per step. Which ones a
// roll can pick depends on the density; each also varies a little by itself.
const FEELS = {
  sparse: ['sparse', 'tresillo', 'offbeat', 'euclid', 'halfnotes'],
  medium: ['eighths', 'offbeat', 'tresillo', 'syncopated', 'gallop', 'euclid', 'anticipate'],
  busy: ['driving', 'gallop', 'syncopated', 'eighths', 'euclid', 'rolling'],
};
const FEEL_NAMES = { sparse: 'sparse', halfnotes: 'long notes', tresillo: '3-3-2', offbeat: 'offbeat', euclid: 'spread-out', eighths: 'eighth-note',
  syncopated: 'syncopated', gallop: 'galloping', anticipate: 'pushed', driving: 'driving 16th', rolling: 'rolling' };
function barRhythm(feel, n, d, rng) {
  const r = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const on = new Array(n).fill(false), q = n / 16; // q: steps per 16th, so feels fit other lengths
  const hit = i => { const k = Math.round(i * q); if (k < n) on[k] = true; };
  const beats = [0, 4, 8, 12];
  switch (feel) {
    case 'sparse': hit(0); for (let k = r(1, 2); k > 0; k--) hit(r(3, 15)); break;
    case 'halfnotes': hit(0); hit(8); if (rng() < 0.5) hit(r(10, 14)); break;
    case 'tresillo': [0, 3, 6, 8, 11, 14].forEach(i => { if (i < 8 || rng() < 0.75) hit(i); }); break;
    case 'offbeat': beats.forEach(b => hit(b + 2)); if (rng() < 0.6) hit(0); if (rng() < 0.3) hit(15); break;
    case 'eighths': for (let i = 0; i < 16; i += 2) if (i === 0 || rng() < 0.82) hit(i); if (rng() < 0.4) hit(r(0, 7) * 2 + 1); break;
    case 'syncopated': [0, 3, 6, 10, 12, 14].forEach(i => { if (i === 0 || rng() < 0.7) hit(i); }); if (rng() < 0.4) hit(r(0, 15)); break;
    case 'gallop': beats.forEach(b => { if (b === 0 || rng() < 0.85) { hit(b); hit(b + 2); hit(b + 3); } }); break;
    case 'anticipate': hit(0); hit(r(5, 7)); hit(r(9, 11)); hit(15); if (rng() < 0.5) hit(r(2, 4)); break;
    case 'driving': for (let i = 0; i < 16; i++) if (i % 4 === 0 || rng() < 0.85) hit(i); break;
    case 'rolling': for (let i = 0; i < 16; i++) if (i % 2 === 0 || rng() < 0.6) hit(i); break;
    default: { // euclid: an even spread at a density that varies roll to roll
      const k = Math.max(2, Math.round(n * d * (0.7 + rng() * 0.6)));
      return euclid(k, n, r(0, 3));
    }
  }
  return on;
}
// Bars of a feel, the last one with a little fill or a gap, so a long pattern doesn't loop
// a one-bar idea.
function phrase(feel, L, d, rng) {
  const bar = Math.min(16, L), first = barRhythm(feel, bar, d, rng), out = [];
  const bars = Math.ceil(L / bar);
  for (let b = 0; b < bars; b++) {
    let r = [...first];
    if (b === bars - 1 && bars > 1) {
      r = r.map((x, i) => (i >= bar - 4 ? (rng() < 0.35 ? !x : x) : x)); // a fill
    } else if (b > 0 && rng() < 0.3) r = barRhythm(feel, bar, d, rng); // sometimes a fresh bar in between
    out.push(...r);
  }
  const res = out.slice(0, L);
  if (!res.some(Boolean)) res[0] = true;
  return res;
}
// Where each role sits when the register is Auto, and the Low/Mid/High registers.
const AUTO_BASE = { bass: 36, lead: 60, chords: 57, pad: 55, arp: 60 };
const REGISTER = { low: 36, mid: 52, high: 67 };
// Chords are built from a seven-note scale; five- and six-note scales borrow their parent.
const HARMONY = { 'minor pentatonic': 'minor', 'major pentatonic': 'major', blues: 'minor' };
const PROGRESSIONS = {
  minor: [[0, 5, 2, 6], [0, 3, 4, 0], [0, 5, 3, 4], [0, 6, 5, 6], [0, 3, 0, 4], [0, 0, 5, 6]],
  major: [[0, 4, 5, 3], [0, 3, 4, 4], [1, 4, 0, 0], [0, 5, 3, 4], [0, 3, 0, 4], [5, 3, 0, 4]],
};
const DRUM = { kick: 36, snare: 38, clap: 39, rim: 37, hat: 42, open: 46, ride: 51, shaker: 70 };

// A few tries so a roll never repeats the last rhythm (`avoid`: the `rhythm` of the previous idea).
export function randomIdea(opts) {
  let idea;
  for (let k = 0; k < 6; k++) {
    idea = makeIdea(opts);
    if (!opts.avoid || idea.rhythm !== opts.avoid) break;
  }
  return idea;
}

function makeIdea({ role, length = 16, scale = null, density = 'medium', register = 'auto', pool = false, rng = Math.random }) {
  const r = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = list => list[Math.floor(rng() * list.length)];
  const chance = p => rng() < p;
  const L = length;
  const d = DENSITY[density] ?? DENSITY.medium;
  const sc = scale && SCALES[scale.type] ? scale : { root: 0, type: 'minor' };
  const degrees = SCALES[sc.type];
  const harmony = SCALES[HARMONY[sc.type] || sc.type];
  const isMinor = harmony[2] === 3;

  // The scale's root at or just below the register's base note.
  const base = register !== 'auto' && REGISTER[register] ? REGISTER[register] : AUTO_BASE[role] ?? 60;
  const root = base - ((base - sc.root) % 12 + 12) % 12;
  const note = (deg, scaleDegrees = degrees) => {
    const n = scaleDegrees.length, oct = Math.floor(deg / n);
    return root + 12 * oct + scaleDegrees[((deg % n) + n) % n];
  };
  const chord = (deg, size = 3) => Array.from({ length: size }, (_, k) => note(deg + 2 * k, harmony));
  const accent = i => i % 4 === 0 ? r(105, 122) : i % 2 === 0 ? r(85, 100) : r(70, 92);

  const steps = [];
  const put = (i, notes, vel, gate, len = 1) => { if (i < L) steps.push({ i, notes, vel, gate, len }); };
  let what = '';

  // Note-pool tracks: rhythm only; the pool supplies the notes.
  if (pool) {
    const feel = pick(FEELS[density] || FEELS.medium), gate = pick([[25, 45], [40, 65], [70, 95]]);
    phrase(feel, L, d, rng).forEach((on, i) => { if (on) put(i, [], accent(i), r(...gate)); });
    return finish(`${FEEL_NAMES[feel]} rhythm, ${steps.length} hits`, 'Note-pool rhythm');
  }

  switch (role) {
    case 'drums': {
      const style = pick(density === 'sparse' ? ['four', 'broken', 'half'] : ['four', 'four', 'broken', 'boombap', 'half']);
      const hits = new Map(); // step -> { notes, vel }
      const add = (i, n, vel) => {
        if (i >= L) return;
        const h = hits.get(i) || { notes: [], vel: 0 };
        if (!h.notes.includes(n)) h.notes.push(n);
        h.vel = Math.max(h.vel, vel);
        hits.set(i, h);
      };
      const beat = Math.max(1, Math.round(L / 4)); // steps per beat (in a 16-step bar)
      if (style === 'four') for (let i = 0; i < L; i += beat) add(i, DRUM.kick, 118);
      else if (style === 'boombap') [0, 7, 10].forEach(i => add(i * L / 16 | 0, DRUM.kick, 115));
      else if (style === 'half') add(0, DRUM.kick, 118);
      else euclid(r(3, 5), L, r(0, 2)).forEach((on, i) => { if (on) add(i, DRUM.kick, 112); });
      const back = style === 'half' ? [Math.round(L / 2)] : [beat, 3 * beat];
      const snare = pick([DRUM.snare, DRUM.clap, DRUM.snare]);
      back.forEach(i => add(i, snare, 112));
      // Hats carry the groove.
      const hatEvery = density === 'busy' ? 1 : density === 'sparse' ? 4 : 2;
      for (let i = 0; i < L; i++) {
        const offbeat = density === 'sparse' ? i % beat === beat / 2 : i % hatEvery === 0;
        if (!offbeat) continue;
        const open = i % beat === beat / 2 && chance(style === 'four' ? 0.35 : 0.1);
        add(i, open ? DRUM.open : DRUM.hat, i % beat === 0 ? r(85, 100) : r(55, 85));
      }
      if (density !== 'sparse') for (let n = 0; n < r(0, 2); n++) add(r(1, L - 1), DRUM.snare, r(40, 60)); // ghosts
      if (density === 'busy' && chance(0.4)) for (let i = beat / 2; i < L; i += beat) add(i, DRUM.shaker, 70);
      for (const [i, h] of hits) put(i, h.notes.sort((a, b) => a - b), h.vel, r(25, 40));
      what = { four: 'four-on-the-floor kick', boombap: 'boom-bap kick', half: 'half-time', broken: 'broken kick' }[style]
        + (density === 'busy' ? ', 16th hats' : density === 'sparse' ? ', off-beat hats' : ', 8th hats');
      break;
    }
    case 'bass': {
      // A rhythm feel, a line style, and (over two bars or more) a chord progression whose roots
      // the line follows. Degrees are in the song's scale, so every note stays in key.
      const feel = pick(FEELS[density] || FEELS.medium);
      const rhythm = phrase(feel, L, d, rng);
      if (chance(0.85)) rhythm[0] = true;
      const n = degrees.length, octave = n, fifth = Math.min(4, n - 1);
      const bar = Math.min(16, L), bars = Math.ceil(L / bar);
      const prog = bars > 1 ? pick(PROGRESSIONS[isMinor ? 'minor' : 'major']).map(x => Math.round(x * n / 7)) : [0];
      const style = pick(['pedal', 'rootfifth', 'octaves', 'walk', 'riff', 'riff']);
      const riff = Array.from({ length: 8 }, () => pick([0, 0, 0, fifth, octave, 2, 1, n - 1, -1]));
      const legato = chance(0.35);
      let k = 0;
      rhythm.forEach((on, i) => {
        if (!on) return;
        const b = Math.floor(i / bar), chordRoot = prog[b % prog.length], pos = i % bar;
        const next = rhythm.findIndex((x, j) => j > i && x), room = (next < 0 ? L : next) - i;
        let deg;
        if (pos === 0 || style === 'pedal') deg = style === 'pedal' && pos !== 0 && chance(0.2) ? octave : 0;
        else if (style === 'rootfifth') deg = k % 2 ? fifth : 0;
        else if (style === 'octaves') deg = k % 2 ? octave : 0;
        else if (style === 'walk') {
          // Toward the next bar's root: step by step in the last notes of the bar.
          const target = prog[(b + 1) % prog.length] - chordRoot + (prog[(b + 1) % prog.length] < chordRoot ? n : 0);
          deg = pos >= bar - 4 ? Math.max(0, Math.min(target, Math.round(target * (pos - (bar - 5)) / 5))) : pick([0, 0, 2, fifth]);
        } else deg = riff[k % riff.length];
        k++;
        const len = room > 1 && (legato ? chance(0.7) : chance(0.15)) ? Math.min(room, legato ? room : 2) : 1;
        put(i, [note(chordRoot + deg)], accent(i), len > 1 ? r(85, 100) : legato ? r(70, 95) : r(30, 60), len);
      });
      const STYLE = { pedal: 'root pedal', rootfifth: 'root–fifth', octaves: 'octave bounce', walk: 'walking', riff: 'riff' };
      what = `${FEEL_NAMES[feel]} ${STYLE[style]} line${bars > 1 ? ` over ${prog.slice(0, Math.min(bars, 4)).map(x => NOTE_NAMES[note(x) % 12]).join(' – ')}` : ''}`;
      break;
    }
    case 'arp': {
      const every = density === 'busy' ? 1 : density === 'sparse' ? 3 : 2;
      const tones = [0, 2, 4, 6, 7].map(x => note(x, harmony)).filter(n => n <= root + 24);
      const order = pick(['up', 'down', 'updown']);
      const seq = order === 'up' ? tones : order === 'down' ? [...tones].reverse() : [...tones, ...tones.slice(1, -1).reverse()];
      let k = 0;
      for (let i = 0; i < L; i += every) put(i, [seq[k++ % seq.length]], accent(i), r(35, 60));
      what = `${order === 'updown' ? 'up-down' : order} arpeggio through a ${isMinor ? 'minor' : 'major'} 7th chord`;
      break;
    }
    case 'chords': case 'pad': {
      const prog = pick(PROGRESSIONS[isMinor ? 'minor' : 'major']);
      const count = L < 8 ? 1 : density === 'sparse' || L < 16 ? 2 : 4;
      const seg = Math.floor(L / count);
      const size = chance(0.5) ? 4 : 3;
      for (let c = 0; c < count; c++) {
        const notes = chord(prog[c % prog.length], size);
        const start = c * seg;
        if (role === 'pad') put(start, notes, r(70, 90), 100, c === count - 1 ? L - start : seg);
        else {
          const k = Math.max(1, Math.round(seg * d));
          euclid(k, seg, chance(0.5) ? 0 : r(1, 2)).forEach((on, j) => { if (on) put(start + j, notes, accent(start + j), r(30, 55)); });
        }
      }
      const names = prog.slice(0, count).map(x => chordName(note(x, harmony), chord(x)));
      what = `${role === 'pad' ? 'held' : 'stabbed'} ${names.join(' – ')}`;
      break;
    }
    default: { // lead / riff: a motif, repeated with a changed ending
      const M = L >= 16 ? L / 2 : L;
      const k = Math.max(2, Math.round(M * d * 1.1));
      const rhythm = chance(0.5) ? euclid(k, M, r(0, 2)) : phrase(pick(FEELS[density] || FEELS.medium), M, d, rng);
      let deg = r(0, 4);
      const motif = rhythm.map(on => {
        if (!on) return null;
        deg = Math.max(-2, Math.min(9, deg + pick([-2, -1, -1, 0, 1, 1, 2, 3])));
        return deg;
      });
      for (let i = 0; i < L; i++) {
        let m = motif[i % M];
        if (m === null) continue;
        if (i >= M && i % M >= M - 3 && chance(0.6)) m += pick([-2, -1, 1, 2]); // answer the phrase
        put(i, [note(m)], accent(i), r(45, 80));
      }
      what = `${M}-step motif, repeated with a new ending`;
    }
  }
  return finish(what);

  function finish(text, label = ROLES[role] || 'Lead / riff') {
    const keyName = `${NOTE_NAMES[sc.root]} ${sc.type}${scale ? '' : ' (no scale set)'}`;
    const pattern = cleanPattern({ steps }, { length: L, onlyBelow: L });
    return {
      summary: `🎲 ${label}: ${text}${role === 'drums' || pool ? '' : `, in ${keyName}`}.`,
      pattern, rhythm: pattern.steps.map(s => s.i).join(','),
    };
  }
}

// "Cm", "Ab", "Bdim" for a summary, from a root note and its triad.
function chordName(rootNote, notes) {
  const third = notes[1] - notes[0], fifth = notes[2] - notes[0];
  return NOTE_NAMES[rootNote % 12] + (fifth === 6 ? 'dim' : third === 3 ? 'm' : '');
}
