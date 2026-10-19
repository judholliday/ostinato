// Breeding ideas (the Ideas bar's 🧬 Mutate and ⚭ Cross): new patterns from ones you liked, so
// you can steer toward a beat or line by picking rather than editing cells. Pure functions.
//
// Drums are handled as lanes (one per drum note): mutating flips a few hits, shifts a lane by a
// step, adds a ratchet or a chance hit; crossing takes each lane from one parent or the other.
// Melodic patterns: mutating moves a few notes by a scale step and drops or repeats a few;
// crossing takes each half bar (or beat) from alternate parents.
import { SCALES, cleanPattern, drumStep, velOf } from './model.js';

const KICK = 36, BACKBEAT = new Set([38, 39, 40]);

// A drum pattern as lanes: note -> Map(step -> { vel, gate, prob?, rat? }).
function lanesOf(p) {
  const lanes = new Map();
  for (const s of p.steps) for (const n of s.notes) {
    if (!lanes.has(n)) lanes.set(n, new Map());
    lanes.get(n).set(s.i, { vel: velOf(s, n), gate: s.gate, ...(s.prob ? { prob: s.prob } : {}), ...(s.rat ? { rat: s.rat } : {}) });
  }
  return lanes;
}
function fromLanes(lanes, length) {
  const at = new Map();
  for (const [n, hits] of lanes) for (const [i, h] of hits) {
    if (i >= length) continue;
    if (!at.has(i)) at.set(i, []);
    at.get(i).push([n, h]);
  }
  const steps = [...at].map(([i, hs]) => {
    const fields = { gate: hs[0][1].gate };
    if (hs.every(([, h]) => h.prob)) fields.prob = Math.min(...hs.map(([, h]) => h.prob));
    if (hs.every(([, h]) => h.rat)) fields.rat = Math.max(...hs.map(([, h]) => h.rat));
    return drumStep(i, hs.map(([n, h]) => [n, h.vel]), fields);
  });
  return cleanPattern({ steps }, { length, onlyBelow: length });
}

// `amount`: 0.1 = a nudge, 0.3 = a clear change. Returns { pattern, what }; tries again if a roll
// happened to change nothing.
export function mutate(p, opts = {}) {
  let out;
  for (let k = 0; k < 8; k++) { out = mutateOnce(p, opts); if (out.what !== 'barely changed') break; }
  return { ...out, pattern: withShape(out.pattern, p) };
}
// A child keeps its parent's fit (beats) and drum lane lengths.
const withShape = (child, parent) => cleanPattern({ ...child, ...(parent.beats ? { beats: parent.beats } : {}), ...(parent.laneLen ? { laneLen: parent.laneLen } : {}) });
function mutateOnce(p, { drums = false, amount = 0.15, scale = null, rng = Math.random } = {}) {
  const r = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const L = p.length, changes = [];
  if (drums) {
    const lanes = lanesOf(p);
    for (const [n, hits] of lanes) {
      // Shift a decorative lane by a step now and then (never the kick or the backbeat).
      if (n !== KICK && !BACKBEAT.has(n) && rng() < amount * 0.5) {
        const dir = rng() < 0.5 ? 1 : -1, moved = new Map();
        for (const [i, h] of hits) moved.set((i + dir + L) % L, h);
        lanes.set(n, moved);
        changes.push('shifted a lane');
        continue;
      }
      const flip = Math.max(1, Math.round(L * amount * 0.25));
      for (let k = 0; k < flip; k++) {
        if (rng() > amount * 2) continue;
        const i = r(0, L - 1), cur = lanes.get(n);
        // Keep the anchors: the kick on step 0 and backbeat hits on the beat.
        if ((n === KICK && i === 0) || (BACKBEAT.has(n) && i % 4 === 0 && cur.has(i))) continue;
        if (cur.has(i)) { cur.delete(i); changes.push('dropped a hit'); }
        else { cur.set(i, { vel: BACKBEAT.has(n) ? r(38, 58) : r(60, 95), gate: 30 }); changes.push(BACKBEAT.has(n) ? 'added a ghost' : 'added a hit'); }
      }
    }
    // Sometimes a ratchet on a hat, or a hit that only plays on some passes.
    const hats = lanes.get(42) || lanes.get(44);
    if (hats?.size && rng() < amount * 2) { const i = [...hats.keys()][r(0, hats.size - 1)]; hats.get(i).rat = r(2, 3); changes.push('a ratchet'); }
    const decor = [...lanes].filter(([n]) => n !== KICK && !BACKBEAT.has(n));
    if (decor.length && rng() < amount * 1.5) {
      const [, hits] = decor[r(0, decor.length - 1)], keys = [...hits.keys()];
      if (keys.length) { hits.get(keys[r(0, keys.length - 1)]).prob = 50; changes.push('a chance hit'); }
    }
    return { pattern: fromLanes(lanes, L), what: summarize(changes) };
  }
  // Melodic: notes move by scale steps (or semitones with no scale); some drop out or repeat.
  const degrees = scale && SCALES[scale.type] ? SCALES[scale.type].map(d => (d + scale.root) % 12) : null;
  const move = (note, dir) => {
    for (let k = 1; k <= 12; k++) { const x = note + dir * k; if (!degrees || degrees.includes(((x % 12) + 12) % 12)) return x; }
    return note;
  };
  const steps = p.steps.map(s => ({ ...s, notes: [...s.notes] }));
  for (const s of steps) {
    if (!s.notes.length || rng() > amount) continue;
    const dir = rng() < 0.5 ? -1 : 1;
    if (s.notes.length === 1) s.notes = [move(s.notes[0], dir * (rng() < 0.75 ? 1 : 2))];
    else { const k = r(0, s.notes.length - 1); s.notes[k] = move(s.notes[k], dir); } // one voice of a chord
    changes.push('moved a note');
  }
  if (steps.length > 2 && rng() < amount * 2) { steps.splice(r(1, steps.length - 1), 1); changes.push('left a gap'); }
  if (steps.length && rng() < amount * 2) {
    const s = steps[r(0, steps.length - 1)], i = s.i + s.len;
    if (i < L && !steps.some(x => x.i === i)) { steps.push({ ...s, i, len: 1, notes: [...s.notes] }); changes.push('repeated a note'); }
  }
  return { pattern: cleanPattern({ steps, ...(p.cc ? { cc: p.cc } : {}) }, { length: L, onlyBelow: L }), what: summarize(changes) };
}

// A child of two patterns (the first one's length). Returns { pattern, what }.
export function cross(a, b, opts = {}) {
  const out = crossOnce(a, b, opts);
  return { ...out, pattern: withShape(out.pattern, a) };
}
function crossOnce(a, b, { drums = false, rng = Math.random } = {}) {
  const L = a.length;
  if (drums) {
    const la = lanesOf(a), lb = lanesOf(b), lanes = new Map(), from = [];
    for (const n of new Set([...la.keys(), ...lb.keys()])) {
      const pickB = la.has(n) && lb.has(n) ? rng() < 0.5 : !la.has(n);
      // A drum only one parent has comes along half the time.
      if (!(la.has(n) && lb.has(n)) && rng() < 0.5) continue;
      const src = pickB ? lb.get(n) : la.get(n);
      lanes.set(n, new Map([...src].filter(([i]) => i < L).map(([i, h]) => [i, { ...h }])));
      from.push(pickB ? 'b' : 'a');
    }
    // Something from each parent: if every lane came from one, a shared drum comes from the other.
    const shared = [...la.keys()].filter(n => lb.has(n)), side = new Set(from);
    if (side.size === 1 && shared.length) {
      const n = shared[Math.floor(rng() * shared.length)], useB = side.has('a');
      if (!lanes.has(n)) from.push(useB ? 'b' : 'a'); else from[[...lanes.keys()].indexOf(n)] = useB ? 'b' : 'a';
      lanes.set(n, new Map([...(useB ? lb : la).get(n)].filter(([i]) => i < L).map(([i, h]) => [i, { ...h }])));
    }
    if (!lanes.size) return { pattern: cleanPattern(a), what: 'the first parent' };
    const nb = from.filter(x => x === 'b').length;
    return { pattern: fromLanes(lanes, L), what: `${from.length - nb} lane${from.length - nb === 1 ? '' : 's'} from the first, ${nb} from the second` };
  }
  const seg = L >= 16 ? 8 : 4, steps = [];
  let first = rng() < 0.5;
  for (let start = 0; start < L; start += seg, first = !first) {
    const src = first ? a : b;
    for (const s of src.steps) if (s.i >= start && s.i < start + seg && s.i < L) steps.push({ ...s, notes: [...s.notes] });
  }
  return { pattern: cleanPattern({ steps }, { length: L, onlyBelow: L }), what: `alternating ${seg === 8 ? 'half bars' : 'beats'}` };
}

function summarize(changes) {
  if (!changes.length) return 'barely changed';
  const counts = new Map();
  for (const c of changes) counts.set(c, (counts.get(c) || 0) + 1);
  return [...counts].map(([c, k]) => `${c}${k > 1 ? ` ×${k}` : ''}`).join(', ');
}
