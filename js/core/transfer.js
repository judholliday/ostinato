// Moving your work between home and the travel version: one file with your songs, Lab
// instruments, saved patterns and Recorder clips. Export where you've been working, import where
// you're going. Songs and instruments replace ones of the same name; patterns and clips already
// there aren't added twice.
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
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const name = `Music ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { name, counts: { songs: bundle.sequences.length, instruments: bundle.instruments.length, patterns: bundle.patterns.length, clips: bundle.clips.length } };
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
  return {
    bundle: { ...bundle, patterns: newPatterns, clips: newClips },
    summary: {
      songs: (bundle.sequences || []).length, songsReplacing: (bundle.sequences || []).filter(s => songNames.has(s.name)).length,
      instruments: (bundle.instruments || []).length, instrumentsReplacing: (bundle.instruments || []).filter(i => instNames.has(i.name)).length,
      patterns: newPatterns.length, patternsSkipped: (bundle.patterns || []).length - newPatterns.length,
      clips: newClips.length, clipsSkipped: (bundle.clips || []).length - newClips.length,
    },
  };
}

export async function importBundle(bundle) {
  for (const s of bundle.sequences || []) await storage.save('sequences', s);
  for (const i of bundle.instruments || []) await storage.save('instruments', i);
  for (const p of bundle.patterns || []) await storage.save('patterns', p);
  for (const c of bundle.clips || []) await storage.save('clips', c);
  // Pages showing lists of these refresh themselves.
  const ch = new BroadcastChannel('mkxl');
  ch.postMessage({ type: 'library-changed' });
  ch.postMessage({ type: 'instruments-changed' });
  ch.postMessage({ type: 'clips-changed' });
  ch.close();
}
