// Moving your work between home and the travel version: one file with your songs, Lab
// instruments, saved patterns and Recorder clips, plus the recordings they use (samples, granular
// sources, drum pad samples, reverb impulses: any recording a song, sound or clip names). Export
// where you've been working, import where you're going. Songs and instruments replace ones of the
// same name; patterns and clips already there aren't added twice; a recording already there (same
// name and size) isn't added again, and one whose name is taken by a different recording is saved
// under a new name, with everything that uses it updated to match.
import { storage } from './storage.js';
import { STATIC } from './mode.js';

export async function exportBundle() {
  const [songs, instruments, patterns, clips] = await Promise.all(['sequences', 'instruments', 'patterns', 'clips'].map(k => storage.list(k).catch(() => [])));
  const bundle = {
    format: 'mkxl-bundle', version: 1, created: new Date().toISOString(), from: STATIC ? 'travel' : 'home',
    sequences: await Promise.all(songs.map(s => storage.get('sequences', s.file))),
    instruments: instruments.map(i => i.patch),
    patterns: patterns.map(({ id, file, source, ...p }) => p),
    clips: clips.map(({ file, ...c }) => c),
  };
  bundle.audio = await recordingsFor(bundle);
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const name = `Music ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { name, counts: { songs: bundle.sequences.length, instruments: bundle.instruments.length, patterns: bundle.patterns.length, clips: bundle.clips.length, recordings: bundle.audio.length } };
}

// Reads a bundle and says what importing it would do: { bundle, summary } (throws if it isn't one).
export async function readBundle(file) {
  let bundle;
  try { bundle = JSON.parse(await file.text()); } catch { throw new Error('That file isn\'t a music export.'); }
  if (bundle?.format !== 'mkxl-bundle') throw new Error('That file isn\'t a music export.');
  const [songs, instruments, patterns, clips] = await Promise.all(['sequences', 'instruments', 'patterns', 'clips'].map(k => storage.list(k).catch(() => [])));
  const names = list => new Set(list.map(x => String(x.name)));
  const songNames = names(songs), instNames = names(instruments);
  const same = (a, b) => a.name === b.name && JSON.stringify(a.steps) === JSON.stringify(b.steps);
  const newPatterns = (bundle.patterns || []).filter(p => !patterns.some(q => same(p, q)));
  const sameClip = (a, b) => a.name === b.name && JSON.stringify(a.notes) === JSON.stringify(b.notes);
  const newClips = (bundle.clips || []).filter(c => !clips.some(q => sameClip(c, q)));
  const have = await storage.list('audio').catch(() => []);
  const audio = bundle.audio || [], here = a => have.some(h => h.file === a.file && h.size === a.size);
  return {
    bundle: { ...bundle, patterns: newPatterns, clips: newClips },
    summary: {
      songs: (bundle.sequences || []).length, songsReplacing: (bundle.sequences || []).filter(s => songNames.has(s.name)).length,
      instruments: (bundle.instruments || []).length, instrumentsReplacing: (bundle.instruments || []).filter(i => instNames.has(i.name)).length,
      patterns: newPatterns.length, patternsSkipped: (bundle.patterns || []).length - newPatterns.length,
      clips: newClips.length, clipsSkipped: (bundle.clips || []).length - newClips.length,
      recordings: audio.filter(a => !here(a)).length, recordingsSkipped: audio.filter(here).length,
    },
  };
}

export async function importBundle(bundle) {
  bundle = await restoreRecordings(bundle);
  for (const s of bundle.sequences || []) await storage.save('sequences', s);
  for (const i of bundle.instruments || []) await storage.save('instruments', i);
  for (const p of bundle.patterns || []) await storage.save('patterns', p);
  for (const c of bundle.clips || []) await storage.save('clips', c);
  // Pages showing lists of these refresh themselves.
  const ch = new BroadcastChannel('mkxl');
  ch.postMessage({ type: 'library-changed' });
  ch.postMessage({ type: 'instruments-changed' });
  ch.postMessage({ type: 'clips-changed' });
  if (bundle.audio?.length) ch.postMessage({ type: 'recordings-changed' });
  ch.close();
}

// ---- recordings ----

// Every string in a value (patches nest deeply: sampler zones, drum pads, sounds inside pads, racks).
function strings(v, out = new Set()) {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) v.forEach(x => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out));
  return out;
}
// The recordings the bundle's songs, sounds and clips use: [{ file, size, data (base64 WAV) }].
// Factory samples ship with the app and aren't included.
async function recordingsFor(bundle) {
  const all = await storage.list('audio').catch(() => []);
  const used = strings([bundle.sequences, bundle.instruments, bundle.clips]);
  const out = [];
  for (const r of all.filter(r => used.has(r.file))) {
    try { out.push({ file: r.file, size: r.size, data: toBase64(await (await storage.get('audio', r.file)).arrayBuffer()) }); } catch { /* unreadable: left out */ }
  }
  return out;
}
// Saves the bundle's recordings that aren't here yet. A name already used by a different recording
// gets a new one, and every reference in the bundle is renamed to match. Returns the bundle to import.
async function restoreRecordings(bundle) {
  if (!bundle.audio?.length) return bundle;
  const have = await storage.list('audio').catch(() => []), renamed = new Map();
  for (const a of bundle.audio) {
    if (have.some(h => h.file === a.file && h.size === a.size)) continue;
    const saved = await storage.save('audio', fromBase64(a.data), a.file.replace(/\.wav$/i, ''));
    if (saved !== a.file) renamed.set(a.file, saved);
  }
  if (!renamed.size) return bundle;
  const fix = v => (typeof v === 'string' ? renamed.get(v) ?? v : Array.isArray(v) ? v.map(fix)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)])) : v);
  return { ...bundle, sequences: fix(bundle.sequences || []), instruments: fix(bundle.instruments || []), clips: fix(bundle.clips || []) };
}
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64), bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
