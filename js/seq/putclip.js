// Putting a take or clip into a song: into one of its tracks, or a new track made for it.
// Shared by the sequencer (the song it has open) and Capture (a saved song changed in its file,
// or a new song), so both do exactly the same thing. No DOM.
import * as M from './model.js';
import * as C from './capture.js';
import { FACTORY } from '../lab/sounds.js';
import { deviceForOut } from '../core/devices.js';

// + Add track: what each role starts with. Each role gets a fitting Ostinato Synth sound (Out =
// Computer), which you can change; the role sets the editor and the ideas it's offered.
export const STARTER_TRACKS = {
  drums: { voice: 'Drums', sound: 'Drum Kit', blurb: 'Drum lanes, beats and styles' },
  bass: { voice: 'Bass', sound: 'Sub Bass', blurb: 'Low notes and bass lines' },
  lead: { voice: 'Pluck', sound: 'Saw Lead', blurb: 'Melodies, riffs and hooks' },
  chords: { voice: 'Keys', sound: 'FM Electric Piano', blurb: 'Chords and stabs' },
  pad: { voice: 'Pad', sound: 'Soft Pad', blurb: 'Long held chords' },
  arp: { voice: 'Pluck', sound: 'Pluck Echo', mode: 'pool', blurb: 'A rhythm that plays through notes you hold' },
};
export const roleName = role => M.ROLES[role].replace(' / riff', '');

// A new track of a role with its starter sound, added to the song (null when it's full).
export function addStarterTrack(song, role, name) {
  const s = STARTER_TRACKS[role], patch = FACTORY.find(p => p.name === s.sound);
  return M.addTrack(song, { role, name: M.freeTrackName(song, name || roleName(role)), voice: s.voice, mode: s.mode || 'steps',
    inst: patch ? M.cleanInst({ name: patch.name, patch }) : null });
}

// What kind of output a track plays: 'computer', 'xl' (a device we know in depth) or 'midi'.
export const outKind = out => (out === M.COMPUTER ? 'computer' : deviceForOut(null, out) ? 'xl' : 'midi');
// Whether a track playing on `out` can take this sound.
export const soundFits = (sound, out) => !!sound && ((sound.kind === 'xl' && outKind(out) === 'xl')
  || ((sound.kind === 'lab' || sound.kind === 'voice') && out === M.COMPUTER));

// A guess at what a clip is, for a new track's role: chords if notes often start together, bass
// if it sits low, pad if notes are long, else a lead.
export function guessClipRole(items) {
  if (!items.length) return 'lead';
  const starts = new Map();
  for (const x of items) { const k = Math.round(x.pos / 12); starts.set(k, (starts.get(k) || 0) + 1); }
  const chordy = [...starts.values()].filter(n => n >= 3).length / starts.size;
  const notes = items.map(x => x.note).sort((a, b) => a - b), median = notes[notes.length >> 1];
  const avgLen = items.reduce((s, x) => s + x.len, 0) / items.length;
  if (chordy >= 0.4) return avgLen >= M.TICKS_PER_BAR / 2 ? 'pad' : 'chords';
  if (median < 48) return 'bass';
  return 'lead';
}

// A pattern replaced by an idea or a take keeps its controller lanes, fit (beats) and drum lane lengths.
export const keepLanes = (old, fresh) => {
  if (!old) return fresh;
  const o = M.copyPattern(old);
  return { ...fresh, ...(o.cc?.length && !fresh.cc ? { cc: o.cc } : {}), ...(o.beats && !fresh.beats ? { beats: o.beats } : {}),
    ...(o.laneLen && !fresh.laneLen ? { laneLen: o.laneLen } : {}) };
};

// Puts the notes into the song (changing it): track `ti`, or with `newRole` a new track of that
// role (named `name`). `sound` (core/sounding.js) goes onto the track when it fits; a new track
// with an XL sound plays on `xlOut` (the XL's port name) if given. Returns { ti, track, pattern,
// bars, gave, added } or { error }.
export function putClip(song, { items, fromBar = 0, ti, newRole = null, name = null, pattern = null, sound = null, xlOut = null }) {
  let t, added = false;
  if (newRole) {
    if (!STARTER_TRACKS[newRole] || newRole === 'arp') return { error: 'Choose what the new track is for.' };
    t = addStarterTrack(song, newRole, name);
    if (!t) return { error: `The song already has ${M.MAX_TRACKS} tracks.` };
    ti = song.tracks.length - 1;
    added = true;
    if (sound?.kind === 'xl' && xlOut) t.out = xlOut;
  } else {
    t = song.tracks[ti];
    if (!t) return { error: 'That track isn\'t in the song any more.' };
    if (t.mode === 'pool') return { error: `${t.name} is a note-pool track; choose a Steps track.` };
  }
  const pname = M.PATTERNS.includes(pattern) ? pattern : t.pattern;
  const pat = C.takeToPattern(items, M.RATES[t.rate], { fromBar });
  if (!pat.steps.length) {
    if (added) M.removeTrack(song, ti);
    return { error: 'No notes in those bars.' };
  }
  t.patterns[pname] = keepLanes(t.patterns[pname], pat);
  if (added) t.pattern = pname;
  const gave = giveSound(t, sound, added);
  const bars = pat.length / (M.TICKS_PER_BAR / M.RATES[t.rate]);
  return { ti, track: t, pattern: pname, bars, gave, added };
}

// Gives a track the sound when it fits; says what it plays (for messages).
function giveSound(t, sound, added) {
  if (soundFits(sound, t.out)) {
    if (sound.kind === 'xl') { t.sound = M.cleanSound({ name: sound.name, data: sound.data }) || t.sound; return `, with the sound ${sound.name}`; }
    if (sound.kind === 'lab') { t.inst = M.cleanInst({ name: sound.name, patch: sound.patch }) || t.inst; return `, with the instrument ${sound.name}`; }
    t.inst = null; t.voice = sound.voice; return `, with the ${sound.voice} voice`;
  }
  return added ? `, playing ${t.inst?.name || t.voice} on the computer` : '';
}

// A new song holding just the clip, on a new track (see putClip).
export function songWithClip(songName, bpm, opts) {
  const song = M.newSong();
  song.name = String(songName || '').trim().slice(0, 60) || 'Untitled';
  song.bpm = Math.max(20, Math.min(300, Math.round(bpm || 120)));
  song.tracks = [];
  song.song = [{ bars: 4, play: [] }];
  const r = putClip(song, opts);
  if (r.error) return r;
  song.song[0].bars = Math.max(1, Math.min(64, Math.ceil(r.bars)));
  return { ...r, song };
}

// ---- Backing: what the sequencer played under a take (see CLAUDE.md, "Backing") ----
// A backing is { song, notes: [{ ti, pos, note, vel, len }], ccs: [{ ti, pos, cc, v }] }: the song as
// it was, and what each of its tracks played, in ticks from the clip's start. A track whose sound,
// effects or volume changed while playing appears once per version: each version's track has `_part`
// (the same for all versions of one track) and `_from` (the tick it took over; 0 = from the start).

// The sound a track of a backing song plays (core/sounding.js form).
export function trackSound(t) {
  if (!t) return null;
  if (t.out === M.COMPUTER) return t.inst ? { kind: 'lab', name: t.inst.name, patch: t.inst.patch } : { kind: 'voice', name: `${t.voice} (test voice)`, voice: t.voice };
  if (outKind(t.out) === 'xl') return t.sound ? { kind: 'xl', name: t.sound.name, data: t.sound.data } : null;
  return { kind: 'midi', name: `${t.out} ch ${t.ch}`, out: t.out, ch: t.ch, program: t.program };
}

const r1 = v => Math.round(v * 10) / 10;
// Whether a note belongs in the stretch a..c: started there, or a long note (held chords and pads)
// started earlier and still sounding (it's cut to start at a).
const inStretch = (n, a, c) => n.pos < c && n.pos + n.len > a && (n.pos >= a || n.len >= M.TICKS_PER_BEAT);
const cutTo = (n, a, c) => { const pos = Math.max(n.pos, a); return { pos: r1(pos - a), note: n.note, vel: n.vel, len: r1(Math.min(n.pos + n.len, c) - pos) }; };

// The backing from tick a to c of a run as Capture keeps it:
// { base (the song without tracks), parts: { tid: [{ pos, track }] } (versions in time order), order: [tid],
//   notes: [{ tid, pos, note, vel, len }], ccs: [{ tid, pos, cc, v }] }. Null if nothing played there.
export function runBacking(r, a, c) {
  const tracks = [], index = new Map();
  const tiOf = (tid, pos) => {
    const vs = r.parts?.[tid];
    if (!vs?.length) return -1;
    let k = 0;
    vs.forEach((v, i) => { if (v.pos <= pos) k = i; });
    const key = `${tid}:${k}`;
    if (!index.has(key)) { index.set(key, tracks.length); tracks.push({ ...vs[k].track, _part: tid, _from: r1(Math.max(0, vs[k].pos - a)) }); }
    return index.get(key);
  };
  const notes = [];
  for (const n of r.notes) {
    if (!inStretch(n, a, c)) continue;
    const ti = tiOf(n.tid, Math.max(n.pos, a));
    if (ti >= 0) notes.push({ ti, ...cutTo(n, a, c) });
  }
  if (!notes.length) return null;
  const heard = new Set([...index.keys()].map(k => k.split(':')[0])); // tracks that play here
  const ccs = ccsIn((r.ccs || []).filter(x => heard.has(String(x.tid))).map(x => ({ ...x, ti: tiOf(x.tid, Math.max(x.pos, a)) })), a, c);
  // Tracks in the song's order, versions in time order.
  const order = new Map((r.order || []).map((tid, i) => [tid, i]));
  const sorted = tracks.map((t, i) => ({ t, i })).sort((x, y) => (order.get(x.t._part) ?? 99) - (order.get(y.t._part) ?? 99) || x.t._from - y.t._from);
  const remap = new Map(sorted.map(({ i }, k) => [i, k]));
  return { song: { ...r.base, tracks: sorted.map(x => x.t) }, notes: notes.map(n => ({ ...n, ti: remap.get(n.ti) })), ccs: ccs.map(x => ({ ...x, ti: remap.get(x.ti) })) };
}
// Controllers in a..c, plus the value in force at a for each (track, controller).
function ccsIn(list, a, c) {
  const out = [], before = new Map();
  for (const x of list) {
    if (x.pos < a) before.set(`${x.ti}:${x.cc}`, x);
    else if (x.pos < c) out.push({ ti: x.ti, pos: r1(x.pos - a), cc: x.cc, v: x.v });
  }
  for (const x of before.values()) out.unshift({ ti: x.ti, pos: 0, cc: x.cc, v: x.v });
  return out;
}

// The part of a backing from tick a to c, moved to start at 0 (null if nothing plays there).
export function backingSlice(b, a, c) {
  if (!b?.notes?.length) return null;
  const tracks = b.song.tracks.map((t, ti) => ({ ...t, _part: t._part ?? `t${ti}`, _from: t._from ?? 0 }));
  // The tracks (or versions of them) that play something here.
  const used = new Set(b.notes.filter(n => inStretch(n, a, c)).map(n => n.ti));
  if (!used.size) return null;
  const order = [...used].sort((x, y) => x - y), remap = new Map(order.map((ti, k) => [ti, k]));
  const notes = b.notes.filter(n => used.has(n.ti) && inStretch(n, a, c)).map(n => ({ ti: remap.get(n.ti), ...cutTo(n, a, c) }));
  const ccs = ccsIn((b.ccs || []).filter(x => remap.has(x.ti)), a, c).map(x => ({ ...x, ti: remap.get(x.ti) }));
  return { song: { ...b.song, tracks: order.map(ti => ({ ...tracks[ti], _from: r1(Math.max(0, tracks[ti]._from - a)) })) }, notes, ccs };
}

// Names of the backing's tracks that play something (once per track, however many versions).
export function backingTracks(b) {
  const used = new Set((b?.notes || []).map(n => n.ti)), seen = new Set(), names = [];
  (b?.song?.tracks || []).forEach((t, ti) => {
    const part = t._part ?? ti;
    if (used.has(ti) && !seen.has(part)) { seen.add(part); names.push(t.name); }
  });
  return names;
}

// For audition-take: the backing's notes and controllers in ms, with its tracks (each version's
// `_from` in ms as `fromMs`, when it takes over).
export function backingToPlay(b, msPerTick, from = 0, to = Infinity) {
  if (!b) return null;
  return { tracks: b.song.tracks.map(t => ({ ...t, fromMs: Math.max(0, ((t._from ?? 0) - from) * msPerTick) })),
    notes: b.notes.filter(n => n.pos >= from && n.pos < to)
      .map(n => ({ ti: n.ti, dt: (n.pos - from) * msPerTick, dur: Math.max(20, Math.min(n.len, to - n.pos) * msPerTick), note: n.note, vel: n.vel })),
    ccs: (b.ccs || []).filter(c => c.pos >= from && c.pos < to).map(c => ({ ti: c.ti, dt: (c.pos - from) * msPerTick, cc: c.cc, v: c.v })) };
}

// A new song that recreates the backing (each track that played, its notes made into patterns) plus
// the clip on a new track. A track's versions (its sound changed while playing) become one track
// with the sound it had at the start (`soundChanges` lists them). Patterns hold up to MAX_STEPS
// steps, so long stretches are cut into chunks; chunks that repeat share a pattern, so a backing
// that loops needs few. A track with more than 4 different chunks continues on extra tracks
// ("Bass 2"…) with the same sound; `lost` lists what still didn't fit (the 8-track limit).
export function songFromBacking(backing, { name, bpm, length, items, newRole, trackName = null, sound = null, xlOut = null }) {
  const src = backing.song;
  const song = M.normalizeSong({ ...JSON.parse(JSON.stringify(src)), tracks: [], song: [] });
  song.tracks = []; song.song = [];
  song.name = String(name || '').trim().slice(0, 60) || 'Untitled';
  song.bpm = Math.max(20, Math.min(300, Math.round(bpm || song.bpm)));
  // One part per original track: its first version's settings, all versions' notes.
  const parts = [], byPart = new Map(), soundChanges = [];
  src.tracks.forEach((t, ti) => {
    const key = t._part ?? `t${ti}`;
    if (!byPart.has(key)) {
      const clean = M.normalizeSong({ tracks: [{ ...t, patterns: undefined }], song: [] }).tracks[0];
      byPart.set(key, { track: clean, items: [], tis: [] });
      parts.push(byPart.get(key));
    } else if (!soundChanges.includes(t.name)) soundChanges.push(t.name);
    byPart.get(key).tis.push(ti);
  });
  for (const n of backing.notes) {
    const p = parts.find(x => x.tis.includes(n.ti));
    p?.items.push({ note: n.note, vel: n.vel, pos: n.pos, len: n.len });
  }
  const played = parts.filter(p => p.items.length);
  for (const p of played) Object.assign(p.track, { mode: 'steps', mute: false, solo: false, pattern: 'A' });

  // Yours, on a new track.
  const holder = { tracks: [], song: [{ bars: 1, play: [] }] };
  const mine = addStarterTrack({ ...holder, tracks: played.map(p => p.track) }, newRole, trackName);
  if (!mine) return { error: `The backing already has ${M.MAX_TRACKS} tracks, so there's no room for yours.` };
  if (sound?.kind === 'xl' && xlOut) mine.out = xlOut;
  const gave = giveSound(mine, sound, true);
  Object.assign(mine, { mode: 'steps', pattern: 'A' });
  const all = [...played, { track: mine, items, mine: true }];

  const TPB = M.TICKS_PER_BAR, total = Math.max(TPB, Math.ceil(length / TPB) * TPB), bars = total / TPB;
  const chunk = Math.max(1, Math.min(...all.map(p => C.barsPerPattern(M.RATES[p.track.rate]))));
  const n = Math.min(64, Math.ceil(bars / chunk)), lost = [];
  // Each part becomes one or more tracks ("lanes"), each with patterns A-D: lane = which group of 4
  // different chunks. plays[lane track][chunk] = the pattern it plays there (or null).
  const lanes = [];
  for (const p of all) {
    const rate = M.RATES[p.track.rate], letters = new Map(), mineLanes = [];
    const laneTrack = k => {
      while (mineLanes.length <= k) {
        const t = mineLanes.length ? { ...JSON.parse(JSON.stringify(p.track)), name: `${p.track.name} ${mineLanes.length + 1}` } : p.track;
        t.patterns = Object.fromEntries(M.PATTERNS.map(x => [x, M.newPattern()]));
        const lane = { track: t, play: Array(n).fill(null), mine: p.mine && !mineLanes.length };
        mineLanes.push(lane);
        lanes.push(lane);
      }
      return mineLanes[k];
    };
    laneTrack(0);
    for (let k = 0; k < n; k++) {
      const from = k * chunk * TPB, to = Math.min(total, from + chunk * TPB);
      const inChunk = p.items.filter(x => x.pos >= from && x.pos < to).map(x => ({ ...x, pos: x.pos - from, len: Math.min(x.len, to - x.pos) }));
      if (!inChunk.length) continue;
      const pat = M.cleanPattern({ ...C.takeToPattern(inChunk, rate), length: Math.round((to - from) / rate) });
      if (!pat.steps.length) continue;
      const key = JSON.stringify(pat);
      if (!letters.has(key)) letters.set(key, letters.size);
      const d = letters.get(key), lane = laneTrack(Math.floor(d / M.PATTERNS.length)), L = M.PATTERNS[d % M.PATTERNS.length];
      lane.track.patterns[L] = pat;
      lane.play[k] = L;
    }
  }
  // At most MAX_TRACKS tracks: yours first, then the backing's in order; extra lanes past that are lost.
  const keep = [lanes.find(l => l.mine), ...lanes.filter(l => !l.mine)].slice(0, M.MAX_TRACKS);
  for (const l of lanes) if (!keep.includes(l) && l.play.some(Boolean)) lost.push(l.track.name);
  const ordered = lanes.filter(l => keep.includes(l));
  song.tracks = ordered.map(l => l.track);
  // One section per chunk; neighbours playing the same patterns become one longer section.
  for (let k = 0; k < n; k++) {
    const play = ordered.map(l => l.play[k]), b = Math.min(chunk, bars - k * chunk), last = song.song.at(-1);
    if (last && b === chunk && last.bars % chunk === 0 && last.bars + b <= 64 && JSON.stringify(last.play) === JSON.stringify(play)) last.bars += b;
    else song.song.push({ bars: b, play });
  }
  if (bars > 64 * chunk) lost.push(`everything after bar ${64 * chunk}`);
  const out = M.normalizeSong(song), ti = out.tracks.findIndex(t => t.name === mine.name);
  return { song: out, track: out.tracks[ti], ti, gave, lost, soundChanges, backingTracks: played.length };
}
