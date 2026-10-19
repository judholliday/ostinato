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

// ---- Backing: what the sequencer played under a take (see PLAN.md / CLAUDE.md) ----
// A backing is { song, notes: [{ ti, pos, note, vel, len }], ccs: [{ ti, pos, cc, v }] }: the song as
// it was when playback started (its tracks give the sounds) and what each track played, in ticks
// from the clip's start.

// The sound a track of a backing song plays (core/sounding.js form).
export function trackSound(t) {
  if (!t) return null;
  if (t.out === M.COMPUTER) return t.inst ? { kind: 'lab', name: t.inst.name, patch: t.inst.patch } : { kind: 'voice', name: `${t.voice} (test voice)`, voice: t.voice };
  if (outKind(t.out) === 'xl') return t.sound ? { kind: 'xl', name: t.sound.name, data: t.sound.data } : null;
  return { kind: 'midi', name: `${t.out} ch ${t.ch}`, out: t.out, ch: t.ch, program: t.program };
}

// The part of a backing from tick a to c, moved to start at 0 (null if nothing plays there). Notes
// started before a are kept only if they're long (held chords and pads), cut to start at a.
export function backingSlice(b, a, c) {
  if (!b?.notes?.length) return null;
  const notes = [];
  for (const n of b.notes) {
    const end = n.pos + n.len;
    if (n.pos >= c || end <= a || (n.pos < a && n.len < M.TICKS_PER_BEAT)) continue;
    const pos = Math.max(n.pos, a);
    notes.push({ ti: n.ti, pos: r1(pos - a), note: n.note, vel: n.vel, len: r1(Math.min(end, c) - pos) });
  }
  if (!notes.length) return null;
  const ccs = [], before = new Map();
  for (const x of b.ccs || []) {
    if (x.pos < a) before.set(`${x.ti}:${x.cc}`, x);
    else if (x.pos < c) ccs.push({ ...x, pos: r1(x.pos - a) });
  }
  for (const x of before.values()) ccs.unshift({ ...x, pos: 0 });
  return { song: b.song, notes, ccs };
}
const r1 = v => Math.round(v * 10) / 10;

// Names of the backing's tracks that play something.
export function backingTracks(b) {
  const used = new Set((b?.notes || []).map(n => n.ti));
  return (b?.song?.tracks || []).filter((_, ti) => used.has(ti)).map(t => t.name);
}

// A new song that recreates the backing (each track that played, its notes made into patterns) plus
// the clip on a new track. Patterns hold up to MAX_STEPS steps, so long stretches are cut into
// chunks; chunks that repeat share a pattern, so a backing that loops needs few. Up to 4 different
// chunks fit per track (patterns A-D); `lost` names tracks that had more.
export function songFromBacking(backing, { name, bpm, length, items, newRole, trackName = null, sound = null, xlOut = null }) {
  const song = M.normalizeSong(JSON.parse(JSON.stringify(backing.song)));
  song.name = String(name || '').trim().slice(0, 60) || 'Untitled';
  song.bpm = Math.max(20, Math.min(300, Math.round(bpm || song.bpm)));
  const played = new Map();
  for (const n of backing.notes) {
    if (!song.tracks[n.ti]) continue;
    if (!played.has(n.ti)) played.set(n.ti, []);
    played.get(n.ti).push({ note: n.note, vel: n.vel, pos: n.pos, len: n.len });
  }
  const parts = [...played.keys()].sort((x, y) => x - y).map(ti => ({ track: song.tracks[ti], items: played.get(ti) }));
  song.tracks = parts.map(p => p.track);
  song.song = [{ bars: 1, play: song.tracks.map(() => 'A') }];
  const t = addStarterTrack(song, newRole, trackName);
  if (!t) return { error: `The backing already has ${M.MAX_TRACKS} tracks, so there's no room for yours.` };
  if (sound?.kind === 'xl' && xlOut) t.out = xlOut;
  const gave = giveSound(t, sound, true);
  parts.push({ track: t, items });
  for (const p of parts) Object.assign(p.track, { mode: 'steps', mute: false, solo: false, pattern: 'A' });

  const TPB = M.TICKS_PER_BAR, total = Math.max(TPB, Math.ceil(length / TPB) * TPB), bars = total / TPB;
  const chunk = Math.max(1, Math.min(...parts.map(p => C.barsPerPattern(M.RATES[p.track.rate]))));
  const n = Math.min(64, Math.ceil(bars / chunk)), lost = new Set();
  const plays = parts.map(p => {
    const rate = M.RATES[p.track.rate], letters = new Map();
    p.track.patterns = Object.fromEntries(M.PATTERNS.map(x => [x, M.newPattern()]));
    return Array.from({ length: n }, (_, k) => {
      const from = k * chunk * TPB, to = Math.min(total, from + chunk * TPB);
      const inChunk = p.items.filter(x => x.pos >= from && x.pos < to).map(x => ({ ...x, pos: x.pos - from, len: Math.min(x.len, to - x.pos) }));
      if (!inChunk.length) return null;
      const pat = M.cleanPattern({ ...C.takeToPattern(inChunk, rate), length: Math.round((to - from) / rate) });
      if (!pat.steps.length) return null;
      const key = JSON.stringify(pat);
      if (!letters.has(key)) {
        if (letters.size >= M.PATTERNS.length) { lost.add(p.track.name); return null; }
        const L = M.PATTERNS[letters.size];
        letters.set(key, L);
        p.track.patterns[L] = pat;
      }
      return letters.get(key);
    });
  });
  // One section per chunk; neighbours playing the same patterns become one longer section.
  song.song = [];
  for (let k = 0; k < n; k++) {
    const play = plays.map(x => x[k]), b = Math.min(chunk, bars - k * chunk), last = song.song.at(-1);
    if (last && b === chunk && last.bars % chunk === 0 && last.bars + b <= 64 && JSON.stringify(last.play) === JSON.stringify(play)) last.bars += b;
    else song.song.push({ bars: b, play });
  }
  if (bars > 64 * chunk) lost.add('everything after bar ' + 64 * chunk);
  return { song: M.normalizeSong(song), track: t, ti: song.tracks.length - 1, gave, lost: [...lost], backingTracks: parts.length - 1 };
}

// For audition-take: the backing's notes in ms, with each track's sound.
export function backingToPlay(b, msPerTick, from = 0, to = Infinity) {
  if (!b) return null;
  return { tracks: b.song.tracks, notes: b.notes.filter(n => n.pos >= from && n.pos < to)
    .map(n => ({ ti: n.ti, dt: (n.pos - from) * msPerTick, dur: Math.max(20, Math.min(n.len, to - n.pos) * msPerTick), note: n.note, vel: n.vel })),
    ccs: (b.ccs || []).filter(c => c.pos >= from && c.pos < to).map(c => ({ ti: c.ti, dt: (c.pos - from) * msPerTick, cc: c.cc, v: c.v })) };
}

