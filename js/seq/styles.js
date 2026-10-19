// Drum styles for the 🎲 button and the AI: the rules that give a style its character, written as
// lane templates. Each roll picks one variant per lane and fills the "maybe" hits at random, so
// every idea differs while keeping the style. These describe a feel in general terms; none is a
// transcription of a record.
//
// A template is one character per step (it repeats to fill longer patterns):
//   X  accent      x  hit       o  ghost (quiet)
//   ?  maybe a hit              g  maybe a ghost
//   r  a ratchet (2–3 quick repeats; busy hats, rolls)
//   p  a hit that plays on half the passes at random (stored as the step's chance)
//   .  nothing
// A lane can also be a function (rng, steps) → template, for styles made by rule (glitch).
// `loops: { lane: [lengths] }`: that drum loops on its own length (one picked per roll), drifting
// against the rest (the pattern's laneLen); its template should be at least that long.
import { euclid } from './generate.js'; // (a circular import, fine: only called later)
import { drumStep } from './model.js';

const D = { kick: 36, rim: 37, snare: 38, clap: 39, hat: 42, pedal: 44, open: 46, crash: 49, ride: 51, bell: 56,
  tomLo: 41, tomFloor: 43, tomMid: 45, tomMid2: 47, tomHi: 48, tomHi2: 50 };
export const DRUM_NOTES = D;

// steps: the template's length (16 = a 4/4 bar of 16ths); meter: shown when it isn't 4/4.
// bpm, swing and feel (a model.js FEEL_PRESETS name) are suggestions shown with the idea; the song's own
// settings are never changed.
export const STYLES = [
  { id: 'skitter', name: 'Skittering, broken', like: 'Kid A–era Radiohead, Four Tet', bpm: '100–130', steps: 16,
    about: 'Syncopated kick that avoids the downbeats after 1, snare on 2 and 4 with ghost notes around it, nervous 16th hats full of gaps and ratchets, stray rim clicks.',
    lanes: {
      kick: ['X.....x...X..?..', 'X..x......x.?...', 'X.....?..x..x...'],
      snare: ['....X..g.g..X...', '....X.....g.X..g'],
      hat: ['x?x.x?xrx?x.x?r?', 'xx?xx.xrx?xx.?xr', 'x.xrx?x.x?xrx.x?'],
      rim: ['..?.....?....?..', '.?.....?...?....'],
    } },
  { id: 'five', name: 'Five-beat loop', like: 'Radiohead’s odd-meter songs, Dave Brubeck', bpm: '120–190', steps: 20, meter: '5/4',
    about: 'A bar of five beats (20 sixteenths): handclaps that land off the beat, kick phrased 3+2, steady 8th hats.',
    lanes: {
      kick: ['X..x......X.....x...', 'X.....x...X..x......'],
      clap: ['....X.......X..X....', '...x....X.......X...'],
      hat: ['x.x.x.x?x.x.x.x?x.x.', 'x.x?x.x.x.x?x.x.x.xr'],
      rim: ['..g.......g.....g...'],
    } },
  { id: 'breaks', name: 'Dusty breakbeat', like: 'DJ Shadow, trip-hop, boom-bap', bpm: '85–98', swing: 58, feel: 'Laid back', steps: 16,
    about: 'A sampled-break feel: kick on 1 and a late kick before 3 or 4, cracking backbeat with ghost snares, loose 8th hats with an occasional open hat.',
    lanes: {
      kick: ['X.........X.....', 'X.x.......X..x..', 'X......x..X.....'],
      snare: ['....X..g.g..X..g', '....X.g...g.X.g.'],
      hat: ['x.x.x.x.x.x.x.x.', 'x.xxx.x.x.xxx.x?'],
      open: ['..............?.', '......?.........'],
    } },
  { id: 'halftime', name: 'Half-time, Berlin', like: 'Moderat, Apparat', bpm: '118–128', steps: 16,
    about: 'Half-time: one clap in the middle of the bar, a heavy kick that sometimes skips, rim and hat ticks on the off-beats for motion.',
    lanes: {
      kick: ['X.....?...X.....', 'X......x..?.....'],
      clap: ['........X.......'],
      rim: ['..x...x...x..?x.', '...x..?...x...x.'],
      hat: ['?.x.?.x.?.x.?.x.'],
      open: ['......?.......x.'],
    } },
  { id: 'twostep', name: 'Shuffled 2-step', like: 'Burial, UK garage', bpm: '130–138', swing: 62, feel: 'Laid back', steps: 16,
    about: 'Kicks that skip the expected beats, snare on 2 and 4, swung hats in shuffled pairs, rim ghosts. Needs heavy swing.',
    lanes: {
      kick: ['X.........x.....', 'X......?..X.....'],
      snare: ['....X.......X...'],
      rim: ['.g.....g..g...g.'],
      hat: ['..x...x?..x...x?', '..x.?.x...x.?.x.'],
    } },
  { id: 'motorik', name: 'Motorik', like: 'Neu!, Can, Stereolab', bpm: '125–150', steps: 16,
    about: 'The steady krautrock pulse: kick on 1 with pushes into the next beat, snare on 2 and 4, unbroken 8th hats. Hypnotic by repetition.',
    lanes: {
      kick: ['X...x.x.X...x.x.', 'X.x...x.X.x.....'],
      snare: ['....X.......X...'],
      hat: ['x.x.x.x.x.x.x.x.'],
    } },
  { id: 'footwork', name: 'Footwork', like: 'RP Boo, Jlin', bpm: '155–165', steps: 16, fill: false,
    about: 'Kicks in threes against the four-beat bar, a sparse clap, ratcheting hats and low toms answering the kick.',
    lanes: {
      kick: ['X..X..X...X..X..', 'X..X..x..X..X...'],
      clap: ['....?.......X...'],
      hat: ['x.x.xrx.x.x.xrx.', 'x.xrx.x.x.xrx.x.'],
      tomLo: ['......?.....?..?', '..?........?..?.'],
    } },
  { id: 'bell', name: '12/8 bell groove', like: 'Tony Allen, Afrobeat, Radiohead’s later grooves', bpm: '90–120 (dotted beat)', steps: 12, meter: '12/8',
    about: 'Twelve pulses per bar (try the 1/8T rate): the standard bell pattern over a kick on 1, snare ghosts and a backbeat on the third pulse group.',
    lanes: {
      bell: ['x.x.xx.x.x.x'],
      kick: ['X.....x..?..', 'X..?..X.....'],
      snare: ['g..g..X..g..', '...g..X...g.'],
      hat: ['x.?x.?x.?x.?'],
    } },
  { id: 'glitch', name: 'Glitch', like: 'Autechre, Aphex Twin', bpm: '90–160', steps: 16, fill: false,
    about: 'Euclidean lanes at odd rotations, ratchets, and chance hits that change every pass, so the beat keeps mutating while it loops.',
    lanes: {
      kick: (rng, n) => spread(euclid(3 + Math.floor(rng() * 3), n, Math.floor(rng() * 4)), 'X'),
      snare: (rng, n) => spread(euclid(2 + Math.floor(rng() * 2), n, 2 + Math.floor(rng() * 4)), 'x'),
      hat: (rng, n) => Array.from({ length: n }, () => 'xrp?..'[Math.floor(rng() * 6)]).join(''),
      rim: (rng, n) => spread(euclid(5, n, Math.floor(rng() * n)), 'p'),
    } },
  { id: 'poly', name: 'Polymeter', like: 'Steve Reich, Aphex Twin, Meshuggah', bpm: '100–140', steps: 16, fill: false,
    about: 'A steady kick and backbeat while the hats, rim and bell loop on odd lengths (3, 5, 7), so the groove shifts every bar and only lines up again after many bars.',
    loops: { hat: [5, 7], rim: [3, 5], bell: [7, 9] },
    lanes: {
      kick: ['X.....x...X.....', 'X.......X..x....'],
      snare: ['....X.......X...'],
      hat: ['x.xx?xx.x?xx.x.x', 'xx.x?x.xx?xx.x.x'],
      rim: ['..x.?..x..?.x...', '.x..x?.x..x.?...'],
      bell: ['x..x.?..x..x....', '..x..x?.....x...'],
    } },
  { id: 'jungle', name: 'Two-step jungle', like: 'drum & bass, Photek, Squarepusher', bpm: '165–176', steps: 32,
    about: 'Two bars of 16ths at a fast tempo: kick on 1 and the "and" of 3, snare on 2 and 4, chopped ghost snares and rolls.',
    lanes: {
      kick: ['X.........X.....X.x.......?.....', 'X.........x.....X......?..x.....'],
      snare: ['....X..g.g..X..g....X..g..g.Xgr.', '....X....g..X.g.....X..g.g..X...'],
      hat: ['x.x.x.x.x?x.x.x?x.x.x.x.x?x.xrx.'],
    } },
  { id: 'math', name: 'Math rock', like: 'Battles, Tortoise', bpm: '110–150', steps: 14, meter: '7/8',
    about: 'Seven 8th notes per bar (14 sixteenths), toms carrying the riff, snare displaced late in the bar.',
    lanes: {
      kick: ['X.....x...x...', 'X...x.....x...'],
      snare: ['......X.....?.', '........X...x.'],
      tomHi: ['x.?x..?.x.?..x', '.?x..x.?..x.?.'],
      tomFloor: ['..?.......?...'],
      hat: ['x.x.x.x.x.x.x.'],
    } },
  { id: 'dub', name: 'Dub techno steppers', like: 'Basic Channel, Rhythm & Sound', bpm: '115–125', steps: 16,
    about: 'Kick on every beat, open hat on every off-beat, a rimshot answering it, an occasional clap. Wants delay and reverb.',
    lanes: {
      kick: ['X...X...X...X...'],
      open: ['..x...x...x...x.'],
      rim: ['...?..?....?..p.', '.?....x.....?...'],
      clap: ['....?.......x...'],
    } },
  { id: 'wonky', name: 'Wonky hip-hop', like: 'J Dilla, Flying Lotus', bpm: '82–95', swing: 60, feel: 'Drunk (Dilla)', steps: 16,
    about: 'Lazy, off-kilter: kicks that wander around the beat, a firm backbeat, hats that drop out and double up.',
    lanes: {
      kick: ['X.....x.?.X...?.', 'X..?....x.X.....'],
      snare: ['....X.......X...'],
      hat: ['x.x.?.x.x.x.?.xx', 'x.?xx.x.x.?.x.xx'],
    } },
];
export const styleById = id => STYLES.find(s => s.id === id);

const spread = (on, ch) => on.map(x => (x ? ch : '.')).join('');

// One idea in a style: { steps, what } (steps not yet cleaned). `density` thins or thickens the
// maybe-hits; long patterns end with a short fill (unless the style has fill: false).
export function styleSteps(style, { length = 16, density = 'medium', rng = Math.random }) {
  const r = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = list => list[Math.floor(rng() * list.length)];
  const P = { sparse: 0.55, medium: 1, busy: 1.5 }[density] ?? 1;
  const hits = new Map(); // step -> Map(note -> { vel, rat?, prob? })
  const add = (i, note, vel, o = {}) => {
    if (!hits.has(i)) hits.set(i, new Map());
    hits.get(i).set(note, { vel, ...o });
  };
  const laneLen = {};
  for (const [lane, list] of Object.entries(style.loops || {})) { const n = pick(list); if (n < length) laneLen[D[lane]] = n; }
  for (const [lane, list] of Object.entries(style.lanes)) {
    const tpl = typeof list === 'function' ? list(rng, style.steps) : pick(list);
    for (let i = 0; i < (laneLen[D[lane]] || length); i++) {
      const c = tpl[i % tpl.length], n = D[lane];
      if (c === 'X') add(i, n, r(110, 122));
      else if (c === 'x') add(i, n, r(84, 100));
      else if (c === 'o') add(i, n, r(40, 58));
      else if (c === '?') { if (rng() < Math.min(0.95, 0.5 * P)) add(i, n, r(78, 96)); }
      else if (c === 'g') { if (rng() < Math.min(0.9, 0.4 * P)) add(i, n, r(38, 56)); }
      else if (c === 'r') add(i, n, r(70, 90), density === 'sparse' ? {} : { rat: rng() < 0.3 ? 3 : 2 });
      else if (c === 'p') add(i, n, r(70, 95), { prob: 50 });
    }
  }
  // A fill at the end of a long pattern: toms down, or a snare roll that builds.
  if (style.fill !== false && length >= 2 * style.steps && length >= 24 && rng() < 0.7) {
    for (let i = length - 4; i < length; i++) hits.delete(i);
    const toms = rng() < 0.5, line = [D.tomHi, D.tomMid, D.tomFloor, D.tomLo];
    for (let k = 0; k < 4; k++) add(length - 4 + k, toms ? line[k] : D.snare, toms ? r(90, 110) : 60 + k * 15, !toms && k === 3 ? { rat: 2 } : {});
  }
  // Steps hold every drum hitting together, so a ratchet or a chance applies to the whole step:
  // only when every drum on it asked for one.
  const steps = [...hits].map(([i, h]) => {
    const o = [...h.values()], fields = { gate: r(25, 40) };
    if (o.every(x => x.rat)) fields.rat = Math.max(...o.map(x => x.rat));
    if (o.every(x => x.prob)) fields.prob = 50;
    return drumStep(i, [...h].map(([n, x]) => [n, x.vel]), fields);
  });
  if (!steps.length) steps.push({ i: 0, notes: [D.kick], vel: 110, gate: 30, len: 1 });
  const tips = [style.meter && `${style.meter}: best with ${style.steps}-step patterns${length % style.steps ? ` (this one has ${length})` : ''}`,
    `try ${style.bpm} BPM`, style.swing && `swing ${style.swing}%`, style.feel && `feel: ${style.feel.toLowerCase()}`].filter(Boolean).join(', ');
  const loops = Object.entries(laneLen).map(([n, len]) => `${Object.keys(D).find(k => D[k] === +n)} ${len}`);
  return { steps, ...(loops.length ? { laneLen } : {}),
    what: `${style.name.toLowerCase()} (${style.like})${loops.length ? `, looping ${loops.join(', ')} steps` : ''}; ${tips}` };
}
