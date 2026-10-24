// The Lab page: build and play instruments made of modules (see patch.js), save them to
// data/instruments/, and share them with the sequencer. No framework.
import { icon as uiIcon } from '../core/icons.js';
import { MODULES, MAX_MODULES, SOURCES, RACK_EFFECTS, MAX_RACK, cleanRack, rackOf, visibleParams, zoneFor, normalizePatch, copyPatch, defaultParams, newId, paramOf, formatValue, toSlider, fromSlider, defaultTarget } from './patch.js';
import { LabSynth } from './engine.js';
import { patchSVG, layout, shapePath, WAVE } from './patchview.js';
import { portLabel } from '../core/midiports.js';
import { storage, placeOf, stemOf, FACTORY_SAMPLES } from '../core/storage.js';
import { STATIC } from '../core/mode.js';
import { attachQwerty, qwertyBase, setQwertyBase } from '../core/qwerty.js';
import { soundReporter } from '../core/sounding.js';
import { showAudioDelay } from '../core/audiodelay.js';
import { FACTORY, TYPES, typeOf, COLLECTIONS, isCollection, collectionFile } from './sounds.js';
import { PAD_GROUPS, padParam, KIT_NOTES, DEFAULT_PADS, cleanPad, varyPad, padLength, padSoundKey } from './drums.js';
import { openSoundPicker } from '../core/soundpicker.js';
import { LabSynth as RenderSynth, fileBuffer } from './engine.js';
import { encodeWav } from '../rec/audio.js';
import { zonesFor, noteInName } from '../rec/sampleinst.js';
import { heat, rowHz } from '../core/spectral.js';
import { typeRank } from '../core/catalog.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const noteName = n => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`mkxl.lab.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`mkxl.lab.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};
function toast(text, kind = '') {
  const el = Object.assign(document.createElement('div'), { className: `toast ${kind}`, textContent: text });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}
const prefs = { keysIn: null, base: 48, viewOpen: true, libOpen: true, libBank: 'all', libType: '', libColl: '', audition: true, ...store.get('prefs', {}) };
const savePrefs = () => store.set('prefs', prefs);

// ---------------------------------------------------------------------------------------------
// Sound

const ac = new AudioContext({ latencyHint: 'interactive' });
const limiter = ac.createDynamicsCompressor();
limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
limiter.connect(ac.destination);
const synth = new LabSynth(ac, limiter);

function wake() {
  if (ac.state !== 'running') ac.resume().then(showAudio);
}
const showAudio = () => {
  const el = $('#audio-status');
  el.hidden = ac.state === 'running';
};
addEventListener('pointerdown', wake, true);
addEventListener('keydown', wake, true);
ac.onstatechange = showAudio;
showAudioDelay($('#audio-delay'), ac);

// ---------------------------------------------------------------------------------------------
// State: the patch being edited, undo, the working copy kept in this browser

let patch;
let fileName = null; // in My Sounds (data/instruments/), if it's one of yours
let factoryName = null; // else the factory sound it came from, if any
let dirty = false;
let saved = []; // [{ file, name, patch }]: My Sounds and saved effect racks (patch.kind 'rack')
const mySounds = () => saved.filter(x => !x.patch?.kind); // not racks or collections
const myRacks = () => saved.filter(x => x.patch?.kind === 'rack');
let recordings = []; // your audio recordings (data/audio/): impulse responses for the reverb
const undoStack = [], redoStack = [];
let snapshot = null, lastPush = 0, workTimer = null, shareTimer = null;
let learn = false, learnTarget = null;

const channel = 'BroadcastChannel' in window ? new BroadcastChannel('mkxl') : null;
const reportSound = soundReporter(channel, 'lab'); // so the Recorder's takes keep the instrument
// Instruments saved or imported elsewhere (Transfer) show up in Open.
if (channel) channel.onmessage = e => { if (e.data?.type === 'instruments-changed') refreshSaved(); };

function changed({ coalesce = false, rebuild = false } = {}) {
  const now = performance.now();
  if (!coalesce || now - lastPush > 800) {
    undoStack.push(snapshot);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    lastPush = now;
  }
  snapshot = JSON.stringify(patch);
  dirty = true;
  if (rebuild) synth.setPatch(patch);
  clearTimeout(workTimer);
  workTimer = setTimeout(() => store.set('working', { patch, fileName, factoryName, dirty }), 300);
  // The sequencer plays this instrument on tracks that use it: send it every change.
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => channel?.postMessage({ type: 'instrument', name: patch.name, patch, link: link?.id }), 120);
  renderFileBar();
}

function load(raw, file, isDirty = false, factory = null) {
  const { patch: p, notes } = normalizePatch(raw);
  patch = p;
  fileName = file;
  factoryName = file ? null : factory;
  dirty = isDirty;
  snapshot = JSON.stringify(patch);
  undoStack.length = redoStack.length = 0;
  synth.setPatch(patch);
  store.set('working', { patch, fileName, factoryName, dirty });
  showNotes(notes);
  renderAll();
}
function restore(json) {
  patch = normalizePatch(JSON.parse(json)).patch;
  snapshot = json;
  dirty = true;
  synth.setPatch(patch);
  store.set('working', { patch, fileName, factoryName, dirty });
  renderAll();
  channel?.postMessage({ type: 'instrument', name: patch.name, patch, link: link?.id });
}
const undo = () => { if (undoStack.length) { redoStack.push(snapshot); restore(undoStack.pop()); } };
const redo = () => { if (redoStack.length) { undoStack.push(snapshot); restore(redoStack.pop()); } };

function showNotes(notes) {
  const el = $('#notes');
  el.hidden = !notes.length;
  el.innerHTML = notes.map(esc).join('<br>');
}

// ---------------------------------------------------------------------------------------------
// Rendering

const modOf = id => patch.modules.find(m => m.id === id);
const sourceLabel = id => SOURCES[id]?.label || id;
const targetLabel = to => {
  const [id, key] = to.split('.'), m = modOf(id);
  return `${id} ${m ? (paramOf(m.type, key)?.label || key) : key}`.trim();
};
function amountText(to, v) {
  const [id, key] = to.split('.'), t = MODULES[modOf(id)?.type]?.targets[key];
  if (t?.unit === 'cents') return Math.abs(v) >= 1200 ? `${v > 0 ? '+' : ''}${(v / 1200).toFixed(1)} oct` : `${v > 0 ? '+' : ''}${Math.round(v)} c`;
  if (t?.unit === 'Hz') return `${v > 0 ? '+' : ''}${v.toFixed(1)} Hz`;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

function renderAll() {
  renderFileBar();
  renderModules();
  renderLibrary();
}

function renderFileBar() {
  const name = $('#inst-name');
  if (document.activeElement !== name) name.value = patch.name;
  $('#dirty').hidden = !dirty;
  $('#dirty').textContent = fileName || factoryName ? 'unsaved changes' : 'not saved yet';
  $('#origin').textContent = fileName ? '★ My Sounds' : factoryName ? 'Factory sound' : '';
  const play = patch.play || 'poly';
  document.querySelectorAll('#play-mode [data-play]').forEach(b => b.classList.toggle('on', b.dataset.play === play));
  $('#glide-field').hidden = play === 'poly';
  $('#voices').disabled = play !== 'poly';
  if (document.activeElement !== $('#glide')) $('#glide').value = Math.round(Math.sqrt((patch.glide || 0) / 2) * 1000);
  $('#glide-val').textContent = patch.glide ? `${Math.round(patch.glide * 1000)} ms` : 'off';
  $('#about').hidden = !patch.about;
  $('#about').textContent = patch.about || '';
  $('#save').textContent = fileName ? 'Save' : 'Save to My Sounds';
  $('#delete').hidden = !fileName;
  const type = typeOf(patch), types = TYPES.includes(type) ? TYPES : [...TYPES, type];
  if (document.activeElement !== $('#inst-type')) $('#inst-type').innerHTML = types.map(t => `<option ${t === type ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  if (document.activeElement !== $('#voices')) $('#voices').value = patch.voices;
  $('#volume').value = patch.volume;
  document.title = `${patch.name}${dirty ? ' •' : ''} · Sound Lab · Ostinato`;
}

// ---- the sound library: Ostinato Synth's sounds, factory and yours, grouped by type ----
// (Hardware sounds live with their instrument: the XL's in its editor under Instruments. The sound
// picker, core/soundpicker.js, is where every instrument's sounds meet.)

const BANKS = [['all', 'All'], ['mine', '★ Mine'], ['factory', 'Factory']];
const keyOf = e => e.key;
const currentKey = () => (fileName ? `synth:m:${fileName}` : factoryName ? `synth:f:${factoryName}` : '');
function libraryEntries() {
  return [...mySounds().map(x => ({ key: `synth:m:${x.file}`, file: x.file, name: x.name, type: typeOf(x.patch), mine: true, patch: x.patch })),
    ...FACTORY.map(p => ({ key: `synth:f:${p.name}`, name: p.name, type: typeOf(p), mine: false, patch: p }))];
}
// What the list shows: a collection (else the bank), search, then type.
function shownEntries() {
  const q = $('#lib-search').value.trim().toLowerCase(), coll = currentColl();
  const inBank = libraryEntries().filter(e => (coll ? inColl(coll, e) : prefs.libBank === 'all' || e.mine === (prefs.libBank === 'mine'))
    && (!q || `${e.name} ${e.type}`.toLowerCase().includes(q)));
  return { inBank, shown: inBank.filter(e => !prefs.libType || e.type === prefs.libType) };
}
function renderLibrary() {
  if (!patch) return;
  $('#lab-layout').classList.toggle('lib-hidden', !prefs.libOpen);
  $('#lib-show').hidden = prefs.libOpen;
  $('#lib-count').textContent = ` ${FACTORY.length} factory · ${mySounds().length} mine`;
  const coll = currentColl();
  if (prefs.libColl && !coll) prefs.libColl = ''; // deleted
  $('#lib-bank').innerHTML = BANKS.map(([v, l]) => `<button class="${!coll && prefs.libBank === v ? 'on' : ''}" data-bank="${v}">${l}</button>`).join('');
  renderCollections();
  const { inBank, shown } = shownEntries();
  const counts = new Map();
  for (const e of inBank) counts.set(e.type, (counts.get(e.type) || 0) + 1);
  const types = [...counts.keys()].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
  $('#lib-types').innerHTML = `<button class="chip${prefs.libType ? '' : ' on'}" data-type="">All</button>`
    + types.map(t => `<button class="chip${prefs.libType === t ? ' on' : ''}" data-type="${esc(t)}">${esc(t)} <span>${counts.get(t)}</span></button>`).join('');
  const cur = currentKey();
  const sorted = [...shown].sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.type.localeCompare(b.type) || (b.mine - a.mine) || a.name.localeCompare(b.name));
  const groups = new Map();
  for (const e of sorted) { if (!groups.has(e.type)) groups.set(e.type, []); groups.get(e.type).push(e); }
  $('#lib-list').innerHTML = shown.length ? [...groups].map(([type, list]) => `${prefs.libType ? '' : `<div class="lib-group">${esc(type)}</div>`}${list.map(e =>
    `<button class="lib-row${keyOf(e) === cur ? ' on' : ''}" data-key="${esc(keyOf(e))}" title="${e.mine ? 'One of your sounds' : 'A factory sound'}: click to open it">
      <span class="nm">${esc(e.name)}</span>${e.mine ? '<span class="mine">★</span>' : ''}</button>`).join('')}`).join('')
    : `<div class="hint lib-empty">${coll ? (coll.sounds.length ? 'No sounds match.' : 'This collection is empty: open a sound and use ☆ Collections (beside Save) to add it.') : prefs.libBank === 'mine' ? 'None of yours here yet. Open a sound, change it, and save it to My Sounds.' : 'No sounds match.'}</div>`;
  $('#lib-audition').checked = prefs.audition;
}

// ---- collections: sounds that belong together (sounds.js) ----
// Factory ones (by genre) and yours (saved instruments of kind 'collection'). Picking one shows only
// its sounds; ☆ Collections beside Save puts the open sound in yours or takes it out; New song
// starts a Sequencer song with a track for each sound.
const myCollections = () => saved.filter(x => isCollection(x.patch))
  .map(x => ({ key: `m:${x.file}`, file: x.file, title: x.patch.title || x.name, about: x.patch.about || '', sounds: x.patch.sounds || [], factory: false }));
const allCollections = () => [...COLLECTIONS.map(c => ({ ...c, key: `f:${c.title}` })), ...myCollections()];
const currentColl = () => (prefs.libColl ? allCollections().find(c => c.key === prefs.libColl) || null : null);
const inColl = (c, e) => c.sounds.some(s => s.name === e.name && !!s.mine === e.mine);
// The open sound as a collection member (null for a new sound not saved yet).
function currentMember() {
  if (fileName) { const x = mySounds().find(s => s.file === fileName); return x ? { name: x.name, mine: true } : null; }
  return factoryName ? { name: factoryName, mine: false } : null;
}
function renderCollections() {
  const colls = allCollections(), cur = prefs.libColl;
  $('#lib-colls').innerHTML = `<span class="hint">Collections</span>` + colls.map(c =>
    `<button class="chip${c.key === cur ? ' on' : ''}" data-coll="${esc(c.key)}" title="${esc(c.about || (c.factory ? '' : 'Your collection'))}">${c.factory ? '' : '★ '}${esc(c.title)} <span>${c.sounds.length}</span></button>`).join('');
  const c = currentColl(), bar = $('#lib-coll-bar');
  bar.hidden = !c;
  if (!c) return;
  bar.innerHTML = `${c.about ? `<p class="hint">${esc(c.about)}</p>` : ''}<div class="coll-acts">
    <button class="small" data-coll-act="song" title="Start a new song in the Sequencer with a track for each of these sounds (up to 8), each in the role that suits it">♪ New song from these</button>
    ${c.factory ? `<button class="ghost small" data-coll-act="copy" title="Make your own copy to change">Copy as mine</button>`
      : `<button class="ghost small" data-coll-act="rename">Rename</button><button class="ghost small" data-coll-act="delete" title="${STATIC ? 'Delete it' : 'Move it to data/instruments/deleted/'} (the sounds stay)">Delete</button>`}</div>`;
}
async function saveCollection(title, sounds, about, replaceFile = null) {
  const file = await storage.save('instruments', collectionFile(title, sounds, about));
  if (replaceFile && replaceFile !== file) await storage.remove('instruments', replaceFile).catch(() => {});
  await refreshSaved();
  return file;
}
async function collectionAction(act) {
  const c = currentColl();
  if (!c) return;
  try {
    if (act === 'song') {
      const sounds = c.sounds.map(s => libraryEntries().find(e => e.name === s.name && e.mine === !!s.mine)).filter(Boolean)
        .map(e => ({ name: e.name, type: e.type, patch: normalizePatch(e.patch).patch }));
      if (!sounds.length) { toast('This collection has no sounds yet.'); return; }
      channel?.postMessage({ type: 'new-song-from-sounds', title: c.title, sounds });
    } else if (act === 'copy') {
      const title = (prompt('Name your copy:', `${c.title} (mine)`) || '').trim();
      if (!title) return;
      const file = await saveCollection(title, c.sounds, c.about);
      prefs.libColl = `m:${file}`; savePrefs(); renderLibrary();
      toast(`Made your collection "${title}".`, 'ok');
    } else if (act === 'rename') {
      const title = (prompt('Rename the collection:', c.title) || '').trim();
      if (!title || title === c.title) return;
      const file = await saveCollection(title, c.sounds, c.about, c.file);
      prefs.libColl = `m:${file}`; savePrefs(); renderLibrary();
    } else if (act === 'delete') {
      if (!confirm(`Delete the collection "${c.title}"? Its sounds stay.`)) return;
      await storage.remove('instruments', c.file);
      prefs.libColl = ''; savePrefs();
      await refreshSaved();
    }
  } catch (err) { toast(`Couldn't change the collection: ${err.message}`, 'err'); }
}
// The ☆ Collections menu: your collections with the open sound ticked; tick to add, untick to remove.
function renderCollPop() {
  const pop = $('#coll-pop'), me = currentMember(), mine = myCollections();
  pop.innerHTML = !me ? '<p class="hint">Save this sound to My Sounds first, then add it to collections.</p>'
    : `<p class="hint">Put <b>${esc(me.name)}</b> in:</p>${mine.length ? mine.map(c => `<label><input type="checkbox" data-coll-file="${esc(c.file)}" ${inColl(c, me) ? 'checked' : ''}> ${esc(c.title)} <span class="hint">${c.sounds.length}</span></label>`).join('')
      : '<p class="hint">You have no collections yet.</p>'}
      <button class="small" data-coll-new>+ New collection with it…</button>`;
}
$('#coll-btn').onclick = () => { const pop = $('#coll-pop'); pop.hidden = !pop.hidden; if (!pop.hidden) renderCollPop(); };
document.addEventListener('pointerdown', e => { if (!e.target.closest('.coll-wrap')) $('#coll-pop').hidden = true; });
$('#coll-pop').addEventListener('change', async e => {
  const file = e.target.dataset.collFile, me = currentMember(), c = myCollections().find(x => x.file === file);
  if (!c || !me) return;
  const sounds = e.target.checked ? [...c.sounds, me] : c.sounds.filter(s => !(s.name === me.name && !!s.mine === me.mine));
  try { await saveCollection(c.title, sounds, c.about, c.file); renderCollPop(); toast(e.target.checked ? `Added to ${c.title}.` : `Taken out of ${c.title}.`, 'ok'); }
  catch (err) { toast(`Couldn't change the collection: ${err.message}`, 'err'); }
});
$('#coll-pop').addEventListener('click', async e => {
  if (!e.target.closest('[data-coll-new]')) return;
  const me = currentMember(), title = (prompt('Name the new collection:', '') || '').trim();
  if (!me || !title) return;
  try { const file = await saveCollection(title, [me]); renderCollPop(); toast(`Made the collection "${title}" with ${me.name}.`, 'ok'); prefs.libColl = `m:${file}`; savePrefs(); renderLibrary(); }
  catch (err) { toast(`Couldn't make the collection: ${err.message}`, 'err'); }
});
channel?.addEventListener('message', e => { if (e.data?.type === 'song-made') toast(e.data.text, e.data.ok ? 'ok' : 'err'); });

// ---- a take's sound, opened from Capture (✎ Edit sound) ----
// Changes made while linked carry `link`, so the take's loop plays them and Capture keeps them.
// Opening another sound from the library ends the link.
let link = null; // { id, title }
function renderLink() {
  const bar = $('#link-bar');
  bar.hidden = !link;
  if (link) bar.innerHTML = `<div>🔗 Editing the sound of <b>${esc(link.title)}</b> from Capture: its loop plays your changes.</div>
    <div class="link-actions"><button class="small" data-link="stop" title="Stop the loop playing in Capture">■ Stop loop</button>
    <button class="small" data-link="back">← Capture</button><button class="ghost small" data-link="end" title="Stop sending changes to Capture">Unlink</button></div>`;
}
function endLink() {
  if (!link) return;
  channel?.postMessage({ type: 'edit-ended', link: link.id });
  link = null;
  renderLink();
}
$('#link-bar').addEventListener('click', e => {
  const act = e.target.closest('[data-link]')?.dataset.link;
  if (act === 'stop') channel?.postMessage({ type: 'stop-audition' });
  else if (act === 'back') parent.postMessage({ type: 'switch-view', view: 'capture' }, location.origin);
  else if (act === 'end') endLink();
});
channel?.addEventListener('message', e => {
  const m = e.data || {};
  if (m.type === 'edit-ended' && link?.id === m.link) { link = null; renderLink(); }
  if (m.type !== 'edit-sound' || m.sound?.kind !== 'lab' || !discardOk()) return;
  // Your own sound of that name and settings: open it as itself, so Save updates it.
  const mine = mySounds().find(x => x.name === m.sound.name && JSON.stringify(normalizePatch(x.patch).patch) === JSON.stringify(normalizePatch(m.sound.patch).patch));
  const factory = !mine && FACTORY.find(p => p.name === m.sound.name);
  endLink();
  load(m.sound.patch, mine?.file || null, false, factory ? factory.name : null);
  link = { id: m.link, title: m.title || 'a take' };
  renderLink();
});

// Opening a sound from the library. Edits you haven't saved are only thrown away if you say so.
const discardOk = () => !dirty || confirm(`Discard unsaved changes to "${patch.name}"?`);
const previewOf = type => ({ note: type === 'Drums' ? 36 : type === 'Bass' ? 36 : 60, ms: ['Pad', 'Strings', 'FX', 'Organ'].includes(type) ? 1200 : 450 });
function openEntry(key, { audition = true } = {}) {
  const e = libraryEntries().find(x => keyOf(x) === key);
  if (!e) return;
  if (key !== currentKey() || dirty) {
    // Unsaved edits: ask in a bar on the page (a browser dialog blocks the page, or is ignored).
    if (dirty) { askUnsaved(e.name, () => { dirty = false; openEntry(key, { audition }); }); return; }
    endLink();
    if (e.mine) load(e.patch, e.file);
    else load(copyPatch(e.patch), null, false, e.name);
  }
  if (audition && prefs.audition) preview();
  renderLibrary();
  document.querySelector(`#lib-list [data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
}
function askUnsaved(next, go) {
  const bar = $('#unsaved-bar');
  bar.innerHTML = `<span><b>${esc(patch.name)}</b> has unsaved changes.</span>
    <button class="small accent" data-u="save">Save, then open ${esc(next)}</button>
    <button class="small" data-u="discard">Discard them and open ${esc(next)}</button>
    <button class="small ghost" data-u="cancel">Keep editing</button>`;
  bar.hidden = false;
  bar.onclick = async ev => {
    const u = ev.target.closest('[data-u]')?.dataset.u;
    if (!u) return;
    bar.hidden = true;
    if (u === 'save') { await save(); if (!dirty) go(); }
    else if (u === 'discard') go();
  };
}
// A short note to hear the sound: lower for basses, the kick and snare for drums, longer for pads.
let previewTimer = null;
function preview() {
  wake();
  const type = typeOf(patch), { ms } = previewOf(type);
  const notes = type === 'Drums' ? [36, 38] : [previewOf(type).note];
  clearTimeout(previewTimer);
  synth.allOff();
  notes.forEach((n, i) => setTimeout(() => synth.noteOn(n, 100, ac.currentTime), i * 220));
  scopeNote = notes[0];
  startScopes(); // the waveforms show it too
  previewTimer = setTimeout(() => notes.forEach(n => synth.noteOff(n, ac.currentTime)), ms + 220 * (notes.length - 1));
}

// A sound made elsewhere (Capture's Sample the XL): open it here once the list has it.
channel?.addEventListener('message', async e => {
  if (e.data?.type !== 'open-instrument') return;
  await refreshSaved();
  if (discardOk()) { dirty = false; openEntry(`synth:m:${e.data.file}`); }
});

$('#library').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.coll !== undefined) { prefs.libColl = prefs.libColl === b.dataset.coll ? '' : b.dataset.coll; prefs.libType = ''; savePrefs(); renderLibrary(); return; }
  if (b.dataset.collAct) { collectionAction(b.dataset.collAct); return; }
  if (b.dataset.bank) { prefs.libBank = b.dataset.bank; prefs.libColl = ''; prefs.libType = ''; savePrefs(); renderLibrary(); }
  else if (b.dataset.type !== undefined) { prefs.libType = b.dataset.type; savePrefs(); renderLibrary(); }
  else if (b.dataset.key) openEntry(b.dataset.key);
});
$('#lib-search').addEventListener('input', renderLibrary);
$('#lib-audition').onchange = e => { prefs.audition = e.target.checked; savePrefs(); };
$('#lib-hide').onclick = () => { prefs.libOpen = false; savePrefs(); renderLibrary(); };
$('#lib-show').onclick = () => { prefs.libOpen = true; savePrefs(); renderLibrary(); };
// ↑ ↓ step through the list (in the list or the search box), opening each sound.
for (const el of [$('#lib-list'), $('#lib-search')]) el.addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const rows = [...document.querySelectorAll('#lib-list .lib-row')];
  if (!rows.length) return;
  const at = rows.findIndex(r => r.classList.contains('on'));
  const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
  openEntry(next.dataset.key);
});
$('#new-sound').onclick = () => {
  if (!discardOk()) return;
  endLink();
  load({ ...copyPatch(FACTORY.find(p => p.name === 'Init')), name: 'New Sound' }, null, true);
  $('#inst-name').select();
};
$('#inst-type').onchange = e => { patch.type = e.target.value; changed(); renderLibrary(); };

// A choice of your recordings (data/audio/): samples, impulse responses. "Import audio…" adds one.
const fileOptions = v => {
  const files = recordings.map(r => r.file);
  if (v && !files.includes(v) && !FACTORY_SAMPLES.includes(v)) files.unshift(v);
  const opt = (f, label, missing = false) => `<option value="${esc(f)}" ${f === v ? 'selected' : ''}>${esc(label)}${missing ? ' (missing)' : ''}</option>`;
  return `<option value="">— choose a recording —</option>
    <optgroup label="${recordings.length ? 'Your recordings' : 'Your recordings (none yet)'}">${files.map(f => opt(f, f.replace(/\.wav$/i, ''), !recordings.some(r => r.file === f))).join('')}</optgroup>
    <optgroup label="Factory samples">${FACTORY_SAMPLES.map(f => opt(f, f.slice(8).replace(/\.wav$/i, ''))).join('')}</optgroup>`;
};
function fileHTML(spec, v, attrs, help = '') {
  return `<div class="prm prm-file"${help}><label>${spec.label}</label><select ${attrs}>${fileOptions(v)}</select>
    <button class="ghost small" data-act="import-audio" ${attrs.replace('data-act="', 'data-for="')} title="Bring a WAV, AIFF or MP3 from your computer into your recordings (${STATIC ? 'kept in this browser' : 'data/audio/'})">Import…</button></div>`;
}

function paramHTML(m, spec) {
  const v = m.params[spec.key], target = `${m.id}.${spec.key}`;
  const cc = Object.entries(patch.cc).find(([, t]) => t === target)?.[0];
  const help = spec.help ? ` title="${esc(spec.help)}"` : '';
  if (spec.kind === 'file') return fileHTML(spec, v, `data-act="file" data-id="${m.id}" data-key="${spec.key}"`, help);
  if (spec.kind === 'choice') return choiceHTML(spec, v, `data-act="choice" data-id="${m.id}" data-key="${spec.key}"`, help);
  return `<div class="prm${learn ? ' learnable' : ''}${learnTarget === target ? ' learning' : ''}" data-target="${target}"${help}>
    <label>${spec.label}</label>
    <input type="range" min="0" max="1000" step="1" value="${Math.round(toSlider(spec, v) * 1000)}" data-act="num" data-id="${m.id}" data-key="${spec.key}">
    <span class="val">${esc(formatValue(spec, v))}</span>${cc !== undefined ? `<span class="cc" title="Turned by knob CC ${cc}${learn ? ' (click to forget)' : ''}" data-act="unlearn" data-cc="${cc}">CC ${cc}</span>` : ''}
  </div>`;
}

// Where a module's audio can go: the output, or any module with an input that doesn't loop back.
function audioDestinations(from) {
  return ['out', ...patch.modules.map(m => m.id)].filter(to => to !== from && !patch.audio.some(c => c.from === from && c.to === to)
    && normalizePatch({ ...patch, audio: [...patch.audio, { from, to }] }).patch.audio.length > patch.audio.length);
}
function modTargets(from) {
  const list = [];
  for (const m of patch.modules) {
    for (const key of Object.keys(MODULES[m.type].targets)) {
      const to = `${m.id}.${key}`;
      if (m.id !== from && !patch.mod.some(c => c.from === from && c.to === to)) list.push(to);
    }
  }
  return list;
}

function routesHTML(from) {
  const spec = MODULES[modOf(from)?.type] || SOURCES[from];
  let html = '';
  if (spec.audioOut) {
    const outs = patch.audio.filter(c => c.from === from);
    const dests = audioDestinations(from);
    html += `<div class="route"><span class="route-h">Audio to</span>${outs.map(c =>
      `<span class="chip">${c.to === 'out' ? 'Output' : esc(c.to)}<button class="x" data-act="a-del" data-from="${from}" data-to="${c.to}" title="Disconnect">✕</button></span>`).join('')}
      ${dests.length ? `<select data-act="a-add" data-from="${from}"><option value="">+ connect to…</option>${dests.map(d => `<option value="${d}">${d === 'out' ? 'Output' : d}</option>`).join('')}</select>` : ''}
      ${!outs.length ? '<span class="warn-text">not connected</span>' : ''}</div>`;
  }
  if (spec.modOut || SOURCES[from]) {
    const rows = patch.mod.map((c, i) => [c, i]).filter(([c]) => c.from === from).map(([c, i]) => {
      const [id, key] = c.to.split('.'), t = MODULES[modOf(id).type].targets[key];
      const x = Math.round((c.amount - t.min) / (t.max - t.min) * 1000);
      return `<div class="mrow"><span class="mto">→ ${esc(targetLabel(c.to))}</span>
        <input type="range" min="0" max="1000" value="${x}" data-act="m-amt" data-i="${i}" title="How much (centre = none)">
        <span class="val">${amountText(c.to, c.amount)}</span>
        <button class="x" data-act="m-del" data-i="${i}" title="Remove">✕</button></div>`;
    }).join('');
    const targets = modTargets(from);
    html += `<div class="route mods"><span class="route-h">Modulates</span>${rows}
      ${targets.length ? `<select data-act="m-add" data-from="${from}"><option value="">+ add a target</option>${targets.map(t => `<option value="${t}">${esc(targetLabel(t))}</option>`).join('')}</select>` : ''}</div>`;
  }
  return html;
}

// ---- samples: the Sampler's waveform, importing audio files ----

// The sample drawn with what plays: dimmed outside start–end, the loop marked.
function drawSample(m) {
  const canvas = document.querySelector(`.sample-wave[data-id="${m.id}"]`);
  if (!canvas) return;
  const w = canvas.clientWidth, h = canvas.clientHeight, dpr = devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  // A multi-sample: the zone for the last note played, with its own loop.
  const z = m.zones?.length ? zoneFor(m.zones, scopeNote) : null;
  const p = z ? { ...m.params, file: z.file, ...(z.loopEnd > z.loopStart ? { loopStart: z.loopStart, loopEnd: z.loopEnd } : {}) } : m.params;
  const g = canvas.getContext('2d'), buf = synth.samples.get(p.file);
  g.scale(dpr, dpr);
  g.fillStyle = css('--muted');
  g.font = '11px system-ui';
  if (!p.file) { g.fillText('Choose a recording above, or Import… one.', 8, h / 2 + 4); return; }
  if (!buf) { g.fillText('Loading…', 8, h / 2 + 4); return; }
  const d = buf.getChannelData(0), loop = p.mode === 'loop', grains = m.type === 'granular';
  const a = grains ? 0 : p.start, b = grains || loop ? 1 : Math.max(p.end, p.start);
  if (loop) { g.fillStyle = css('--accent-soft'); g.fillRect(p.loopStart * w, 0, (p.loopEnd - p.loopStart) * w, h); }
  if (grains) { g.fillStyle = css('--accent-soft'); g.fillRect((p.position - p.spread / 2) * w, 0, Math.max(2, p.spread * w), h); }
  for (let x = 0; x < w; x++) {
    let lo = 0, hi = 0;
    for (let i = Math.floor(x / w * d.length); i < Math.floor((x + 1) / w * d.length); i++) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
    const f = x / w;
    g.fillStyle = f >= a && f <= b ? (css('--lcd-text') || css('--accent')) : css('--line');
    g.fillRect(x, h / 2 - hi * (h / 2 - 2), 1, Math.max(1, (hi - lo) * (h / 2 - 2)));
  }
  g.fillStyle = css('--text');
  for (const f of grains ? [p.position] : loop ? [a, p.loopStart, p.loopEnd] : [a, b]) g.fillRect(Math.round(f * w), 0, grains ? 2 : 1, h);
  g.fillStyle = css('--muted');
  g.fillText(`${buf.duration.toFixed(2)} s`, w - 44, h - 4);
}
synth.onSample = () => { for (const m of patch.modules) { if (m.type === 'sampler' || m.type === 'granular') drawSample(m); if (m.pads) drawPad(m); } };

// The note a recording plays: from its name when it says, like "Brass (C3)", else from its pitch
// (the clearest repeating period after the attack). null when it has no clear pitch.
const NOTE_RE = /\(([A-G])([#b]?)(-?\d)\)/;
function noteFromName(file) {
  const m = NOTE_RE.exec(file);
  if (!m) return null;
  const pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (+m[3] + 1) * 12 + pc;
}
function detectPitch(buf) {
  const sr = buf.sampleRate, x = buf.getChannelData(0);
  let peak = 0, at = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak) { peak = Math.abs(x[i]); at = i; }
  const s0 = Math.min(x.length - 1, at + Math.round(sr * 0.08)), W = Math.min(Math.round(sr * 0.2), x.length - s0 - Math.round(sr / 30));
  if (W < sr * 0.05) return null;
  const corr = L => { let c = 0, e1 = 0, e2 = 0; for (let i = s0; i < s0 + W; i++) { c += x[i] * x[i + L]; e1 += x[i] * x[i]; e2 += x[i + L] * x[i + L]; } return c / Math.sqrt(e1 * e2 + 1e-12); };
  const lags = [];
  for (let L = Math.round(sr / 2000); L < sr / 30; L++) lags.push([L, corr(L)]);
  const best = Math.max(...lags.map(l => l[1]));
  if (best < 0.8) return null;
  // The shortest period that correlates nearly as well (avoids landing an octave low).
  const [L] = lags.find(([, r], k) => r >= best * 0.95 && r >= (lags[k - 1]?.[1] ?? 0) && r >= (lags[k + 1]?.[1] ?? 0));
  return 69 + 12 * Math.log2(sr / L / 440);
}
async function setRootFrom(m, file) {
  let note = noteFromName(file), how = 'from its name';
  if (note === null) {
    const buf = synth.samples.get(file) || await fileBuffer(ac, file);
    const p = buf && detectPitch(buf);
    if (p === undefined || p === null) { toast('No clear pitch in that recording: set Root note to the key it should play at its own pitch.'); return; }
    note = Math.round(p);
    how = 'from its pitch';
  }
  if (!modOf(m.id) || m.params.root === note) return;
  m.params.root = note;
  synth.setPatch(patch);
  changed({ coalesce: true });
  renderModules();
  toast(`Root note set to ${noteName(note)} (${how}), so it plays in tune. Change it if it doesn't sound right.`);
}

// Import audio…: any file the browser can decode becomes a WAV in your recordings, then the
// setting that asked for it uses it.
const importInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg', hidden: true });
document.body.append(importInput);
let importFor = null;
async function importAudio(file, { quiet = false } = {}) {
  try {
    const buf = await ac.decodeAudioData(await file.arrayBuffer());
    const chans = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
    const saved = await storage.save('audio', encodeWav(chans, buf.sampleRate), file.name.replace(/\.[^.]+$/, ''));
    await refreshRecordings();
    channel?.postMessage({ type: 'recordings-changed' });
    if (!quiet) toast(`Imported ${file.name} (${buf.duration.toFixed(1)} s) into your recordings.`, 'ok');
    return saved;
  } catch (err) {
    toast(`Couldn't import ${file.name}: ${err.message || 'not an audio file this browser can read'}.`, 'err');
    return null;
  }
}
importInput.onchange = async () => {
  const file = importInput.files[0], f = importFor;
  importInput.value = '';
  if (!file || !f) return;
  const saved = await importAudio(file);
  if (!saved) return;
  const m = modOf(f.id);
  if (!m) return;
  if (f.act === 'pad-file') { m.pads[selPad(m)][f.key] = saved; padChanged(m); setTimeout(() => hitPad(selPad(m)), 300); }
  else { m.params[f.key] = saved; synth.setPatch(patch); changed(); if ('root' in m.params) setRootFrom(m, saved); }
  renderModules();
};

// Load multi-sample…: several recordings into a Sampler's zones. Each file goes into your
// recordings (as WAV), its note comes from its name or else its pitch, and the zones split the
// keyboard halfway between notes. With several files on one note (velocity layers), the first is used.
const multiInput = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: 'audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg', hidden: true });
document.body.append(multiInput);
let multiFor = null;
multiInput.onchange = async () => {
  const files = [...multiInput.files], id = multiFor;
  multiInput.value = '';
  if (!files.length || !modOf(id)) return;
  toast(`Loading ${files.length} recording${files.length > 1 ? 's' : ''}…`);
  const found = [], skipped = [];
  let byPitch = 0;
  for (const file of files) {
    let note = noteInName(file.name);
    const saved = await importAudio(file, { quiet: true });
    if (!saved) { skipped.push(`${file.name} (couldn't read it)`); continue; }
    if (note === null) {
      const buf = await fileBuffer(ac, saved), p = buf && detectPitch(buf);
      if (p === undefined || p === null) { skipped.push(`${file.name} (no note in its name, no clear pitch)`); continue; }
      note = Math.round(p);
      byPitch++;
    }
    if (found.some(f => f.root === note)) { skipped.push(`${file.name} (another file already plays ${noteName(note)})`); continue; }
    found.push({ root: note, file: saved });
  }
  const m = modOf(id);
  if (!m || !found.length) { toast(`Nothing loaded.${skipped.length ? ` Skipped: ${skipped.join('; ')}.` : ''}`, 'err'); return; }
  found.sort((a, b) => a.root - b.root);
  m.zones = zonesFor(found.map(f => f.root)).map((z, k) => ({ ...z, file: found[k].file, loopStart: 0, loopEnd: 0 }));
  synth.setPatch(patch);
  changed({ rebuild: true });
  renderModules();
  toast(`Loaded ${found.length} zone${found.length > 1 ? 's' : ''}, ${noteName(found[0].root)} to ${noteName(found.at(-1).root)}${byPitch ? ` (${byPitch} placed by their pitch)` : ''}.${skipped.length ? ` Skipped ${skipped.length}: ${skipped.slice(0, 4).join('; ')}${skipped.length > 4 ? '…' : ''}.` : ''} ⌘Z undoes.`, 'ok');
};

// ---- the kit editor (a Drum kit module's pads, drums.js) ----

const kitSel = {}; // module id -> the pad (note) being edited
let padClip = null; // a copied pad
let kitFrom = null; // module id whose "from another kit" list is open
const selPad = m => (KIT_NOTES.includes(+kitSel[m.id]) ? +kitSel[m.id] : 36);
function kitHTML(m) {
  const n = selPad(m), p = m.pads[n];
  // The grid reads like a pad controller: the first four pads on the bottom row.
  const rows = [12, 8, 4, 0].map(r => KIT_NOTES.slice(r, r + 4));
  const pspec = (spec, v) => spec.kind === 'sound'
    ? `<div class="prm prm-file"${spec.help ? ` title="${esc(spec.help)}"` : ''}><label>${spec.label}</label><span class="pad-sound">
        <button class="small${v ? '' : ' ghost'}" data-act="pad-sound" data-id="${m.id}" title="Choose an Ostinato Synth sound for this pad">${v ? esc(v.name) : 'Choose…'}</button>
        ${v ? `<button class="ghost small" data-act="pad-sound-off" data-id="${m.id}" title="No sound on this pad">✕</button>` : ''}</span></div>`
    : spec.kind === 'file' ? fileHTML(spec, v, `data-act="pad-file" data-id="${m.id}" data-key="${spec.key}"`, spec.help ? ` title="${esc(spec.help)}"` : '')
      + (v ? `<button class="ghost small" data-act="spectro" data-id="${m.id}" data-pad="1" title="See the sample as a spectrogram and paint on it; the edit is saved as a new recording, which this pad then plays">${uiIcon('spectro')} Spectrogram</button>` : '')
    : spec.kind === 'choice'
    ? `<div class="prm"><label>${spec.label}</label><span class="seg-btn">${spec.choices.map(c => `<button data-act="pad-choice" data-id="${m.id}" data-key="${spec.key}" data-v="${c}" class="${c === v ? 'on' : ''}">${c}</button>`).join('')}</span></div>`
    : `<div class="prm"${spec.help ? ` title="${esc(spec.help)}"` : ''}><label>${spec.label}</label>
        <input type="range" min="0" max="1000" step="1" value="${Math.round(toSlider(spec, v) * 1000)}" data-act="pad-num" data-id="${m.id}" data-key="${spec.key}">
        <span class="val">${esc(spec.key === 'choke' ? (v ? `group ${v}` : 'none') : formatValue(spec, v))}</span></div>`;
  const kits = kitFrom === m.id ? otherKits() : null;
  return `<div class="kit">
    <div class="pads">${rows.map(r => r.map(k => `<button class="pad${k === n ? ' on' : ''}" data-act="pad" data-id="${m.id}" data-n="${k}" title="${esc(m.pads[k].name)} (${noteName(k)}): click to edit and hear it">
      <b>${esc(m.pads[k].name)}</b><canvas class="pad-thumb" data-id="${m.id}" data-n="${k}" aria-hidden="true"></canvas><span>${noteName(k)}</span></button>`).join('')).join('')}</div>
    <div class="pad-edit">
      <div class="pad-head">
        <input class="pad-name" data-act="pad-name" data-id="${m.id}" value="${esc(p.name)}" maxlength="24" spellcheck="false" aria-label="Pad name">
        <span class="hint">${noteName(n)} · note ${n}</span><span class="spacer"></span>
        <button class="small" data-act="pad-play" data-id="${m.id}" title="Hear it (or click the pad)">▶</button>
        <button class="ghost small" data-act="pad-vary" data-id="${m.id}" data-amt="0.15" title="A small random variation (⌘Z undoes)">${icon('generate')} Vary</button>
        <button class="ghost small" data-act="pad-vary" data-id="${m.id}" data-amt="0.5" title="A bigger random change, sometimes a different wave or filter">${icon('generate')} Wild</button>
        <button class="ghost small" data-act="pad-reset" data-id="${m.id}" title="Back to the original kit's ${esc(DEFAULT_PADS[n]?.name || 'pad')}">↺ Reset</button>
        <button class="ghost small" data-act="pad-copy" data-id="${m.id}" title="Copy this pad">Copy</button>
        <button class="ghost small" data-act="pad-paste" data-id="${m.id}" ${padClip ? '' : 'disabled'} title="${padClip ? `Replace it with the copied ${esc(padClip.name)}` : 'Copy a pad first'}">Paste</button>
        <button class="ghost small" data-act="pad-bounce" data-id="${m.id}" title="Record this pad, all its layers, into one of your recordings and make the pad play just that (⌘Z undoes; the recording stays)">${uiIcon('bounce')} Bounce</button>
        <button class="${kitFrom === m.id ? '' : 'ghost '}small" data-act="pad-from" data-id="${m.id}" title="Take a pad from another kit for this one">From another kit…</button>
      </div>
      ${kits ? `<div class="kit-from">${kits.length ? kits.map((k, i) => `<div class="kf-kit"><b>${esc(k.name)}</b>${k.mine ? ' <span class="hint">★</span>' : ''}<span class="kf-pads">${KIT_NOTES.map(note =>
        `<button class="small ghost" data-act="pad-take" data-id="${m.id}" data-kit="${i}" data-n="${note}" title="Use ${esc(k.pads[note].name)} from ${esc(k.name)} for this pad">${esc(k.pads[note].name)}</button>`).join('')}</span></div>`).join('')
        : '<span class="hint">No other kits yet.</span>'}<div class="hint">Click a pad to put it here (⌘Z undoes).</div></div>` : ''}
      <canvas class="pad-wave" data-id="${m.id}" title="The pad's sound over time"></canvas>
      <div class="pad-groups">${PAD_GROUPS.map(g => `<div class="pad-group"><h4 title="${esc(g.help)}">${g.title}</h4>${g.params.map(spec => pspec(spec, p[spec.key])).join('')}</div>`).join('')}</div>
    </div>
  </div>`;
}
// Kits to take pads from: the factory kits and your own, but not this one.
function otherKits() {
  const kitOf = x => x.modules?.find(mm => mm.type === 'drums' && mm.pads);
  return [...FACTORY.map(p => ({ name: p.name, mine: false, mod: kitOf(p) })), ...mySounds().map(x => ({ name: x.name, mine: true, mod: kitOf(normalizePatch(x.patch).patch) }))]
    .filter(k => k.mod && !(k.name === patch.name)).map(k => ({ name: k.name, mine: k.mine, pads: k.mod.pads }));
}
// Plays one pad now (and shows it on the grid).
function hitPad(note) {
  wake();
  synth.noteOn(note, 110, ac.currentTime);
  setTimeout(() => synth.noteOff(note, ac.currentTime), 300);
  flashPad(note);
}
function flashPad(note) {
  document.querySelectorAll(`.pad[data-n="${note}"]`).forEach(b => { b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 150); });
}
// How long a pad sounds, its sample and sound included (as far as they've loaded).
function padSeconds(p, dk = 1) {
  const lsnd = p.lSound && p.lLevel > 0 ? synth.samples.get(padSoundKey(p))?.duration ?? p.lHold : 0;
  const smp = p.sFile && p.sLevel > 0 ? Math.max(0, (synth.samples.get(p.sFile)?.duration ?? 0) * (1 - p.sStart) / 2 ** (p.sTune / 12)) : 0;
  return Math.max(padLength(p, dk), Math.min(lsnd, p.lDecay * dk), Math.min(smp, p.sDecay * dk));
}
// ✎ Spectrogram on a sampler, granular module or pad sample: the edit is saved as a new recording
// and the module (or pad) switches to it (⌘Z goes back to the original).
async function openSpectro(m, pad) {
  const n = selPad(m), file = pad ? m.pads[n].sFile : m.params.file;
  if (!file) return;
  const { openSpectroEditor } = await import('../core/spectroedit.js');
  openSpectroEditor({ file, onSaved: async saved => {
    await refreshRecordings();
    if (pad) { m.pads[n].sFile = saved; padChanged(m); } else { m.params.file = saved; synth.setParam(m.id, 'file', saved); changed({ rebuild: true }); }
    renderModules();
    toast(`${pad ? m.pads[n].name : m.id} now plays ${saved}. ⌘Z goes back to ${file}.`, 'ok');
  } });
}
// Bounce: the pad, every layer, rendered into one of your recordings (at full velocity, without
// the kit's tune/decay/tone or the pad's pan and level, which stay on the pad), and the pad then
// plays just that. Undo brings the layers back; the recording stays.
async function bouncePad(m) {
  const n = selPad(m), p = m.pads[n];
  await synth.ready();
  const sr = ac.sampleRate, secs = Math.min(12, padSeconds(p) + 0.3);
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * secs), sr), r = new RenderSynth(ctx, ctx.destination);
  r.setPatch(normalizePatch({ name: 'pad', voices: 1, volume: 1, modules: [{ id: 'd', type: 'drums', params: { ...defaultParams('drums'), level: 1 },
    pads: { [n]: { ...p, pan: 0, level: 1 } } }], audio: [{ from: 'd', to: 'out' }] }).patch);
  await r.ready();
  r.noteOn(n, 127, 0);
  const buf = await ctx.startRendering(), chans = [buf.getChannelData(0), buf.getChannelData(1)];
  let end = 0, peak = 0;
  for (const d of chans) for (let i = 0; i < d.length; i++) { const x = Math.abs(d[i]); if (x > 1e-4) end = Math.max(end, i); peak = Math.max(peak, x); }
  if (!peak) { toast('That pad makes no sound, so there was nothing to bounce.', 'err'); return; }
  // Loud pads are scaled into the file and the pad's sample level makes up for it.
  const scale = peak > 0.99 ? 0.99 / peak : 1, len = Math.min(buf.length, end + Math.round(sr * 0.01));
  const out = chans.map(d => { const c = d.slice(0, len); for (let i = 0; i < c.length; i++) c[i] *= scale; return c; });
  let file;
  try { file = await storage.save('audio', encodeWav(out, sr), stemOf(`${patch.name} ${p.name}`)); } catch (err) { toast(`Couldn't save the bounce: ${err.message}`, 'err'); return; }
  m.pads[n] = cleanPad({ name: p.name, pan: p.pan, level: p.level, choke: p.choke, t1Level: 0, t2Level: 0, nLevel: 0, click: 0, drive: 0,
    sFile: file, sLevel: Math.min(1.5, 1 / scale), sTune: 0, sStart: 0, sDecay: 8 }, n);
  await refreshRecordings();
  channel?.postMessage({ type: 'recordings-changed' });
  padChanged(m, { play: true });
  renderModules();
  toast(`Bounced ${p.name} into ${file} (${(len / sr).toFixed(2)} s). ⌘Z brings its layers back.`, 'ok');
}
// The pad's sound drawn over time: rendered silently, as it would sound alone.
const padRenders = new Map();
function drawPad(m) {
  drawPadThumbs(m);
  const canvas = document.querySelector(`.pad-wave[data-id="${m.id}"]`);
  if (!canvas) return;
  const n = selPad(m), p = m.pads[n], kit = m.params;
  const secs = Math.min(3, padSeconds(p, kit.decay) + 0.1);
  const key = JSON.stringify([p, kit]);
  const sr = 22050, ctx = new OfflineAudioContext(1, Math.ceil(sr * secs), sr), r = new RenderSynth(ctx, ctx.destination);
  r.setPatch(normalizePatch({ name: 'pad', voices: 1, volume: 1, modules: [{ id: 'd', type: 'drums', params: kit, pads: { [n]: p } }], audio: [{ from: 'd', to: 'out' }] }).patch);
  padRenders.set(m.id, key);
  r.ready().then(() => { if (padRenders.get(m.id) === key) { r.noteOn(n, 110, 0); return ctx.startRendering(); } }).then(buf => {
    if (!buf) return;
    if (padRenders.get(m.id) !== key || !canvas.isConnected) return;
    const d = buf.getChannelData(0), w = canvas.clientWidth, h = canvas.clientHeight, dpr = devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    let peak = 0;
    for (const x of d) peak = Math.max(peak, Math.abs(x));
    const k = (h / 2 - 2) / Math.max(peak, 0.05);
    g.fillStyle = (css('--lcd-text') || css('--accent'));
    for (let x = 0; x < w; x++) {
      let lo = 0, hi = 0;
      for (let i = Math.floor(x / w * d.length); i < Math.floor((x + 1) / w * d.length); i++) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
      g.fillRect(x, h / 2 - hi * k, 1, Math.max(1, (hi - lo) * k));
    }
    g.fillStyle = css('--muted');
    g.font = '10px ui-monospace, monospace';
    g.fillText(`${secs.toFixed(2)} s`, w - 40, h - 4);
  });
}
// Each pad's sound as a small picture on the pad (rendered quietly at a low rate, kept until the
// pad or the kit's settings change).
const thumbCache = new Map();
function drawPadThumbs(m) {
  for (const canvas of document.querySelectorAll(`.pad-thumb[data-id="${m.id}"]`)) {
    const n = +canvas.dataset.n, p = m.pads[n];
    const key = JSON.stringify([p, m.params]);
    const paint = d => {
      if (!canvas.isConnected) return;
      const w = canvas.clientWidth, h = canvas.clientHeight, dpr = devicePixelRatio || 1;
      if (!w || !h) return;
      canvas.width = w * dpr; canvas.height = h * dpr;
      const g = canvas.getContext('2d');
      g.scale(dpr, dpr);
      let peak = 0;
      for (const x of d) peak = Math.max(peak, Math.abs(x));
      const k = (h / 2 - 1) / Math.max(peak, 0.05);
      g.fillStyle = css('--lcd-text') || css('--accent');
      for (let x = 0; x < w; x++) {
        let hi = 0;
        for (let i = Math.floor(x / w * d.length); i < Math.floor((x + 1) / w * d.length); i++) hi = Math.max(hi, Math.abs(d[i]));
        g.fillRect(x, h / 2 - hi * k, 1, Math.max(1, 2 * hi * k));
      }
    };
    const hit = thumbCache.get(`${m.id}|${n}`);
    if (hit?.key === key) { paint(hit.data); continue; }
    const sr = 8000, secs = Math.min(1.5, padSeconds(p, m.params.decay) + 0.05);
    const ctx = new OfflineAudioContext(1, Math.ceil(sr * secs), sr), r = new RenderSynth(ctx, ctx.destination);
    r.setPatch(normalizePatch({ name: 'pad', voices: 1, volume: 1, modules: [{ id: 'd', type: 'drums', params: m.params, pads: { [n]: p } }], audio: [{ from: 'd', to: 'out' }] }).patch);
    r.ready().then(() => { r.noteOn(n, 110, 0); return ctx.startRendering(); }).then(buf => {
      const data = buf.getChannelData(0);
      thumbCache.set(`${m.id}|${n}`, { key, data });
      paint(data);
    });
  }
}
const padRedraw = new Map();
function drawPadSoon(m) { clearTimeout(padRedraw.get(m.id)); padRedraw.set(m.id, setTimeout(() => drawPad(m), 120)); }
// A pad changed: the synth plays the new one at once, and it's one undo step per action.
function padChanged(m, { coalesce = false, play = false } = {}) {
  synth.setPatch(patch);
  changed({ coalesce });
  if (play) { const n = selPad(m); synth.ready().then(() => hitPad(n)); } // a pad's sound renders first
}

function renderModules() {
  $('#save-rack').hidden = !patch.modules.some(m => MODULES[m.type].scope === 'global');
  // Cards follow the sound: left to right through the patch diagram, top to bottom within a
  // column; then the modulators.
  const { pos } = layout(patch);
  const at = id => pos.get(id) || { x: 1e9, y: 1e9 };
  const sound = patch.modules.filter(m => !MODULES[m.type].modOut).sort((a, b) => at(a.id).x - at(b.id).x || at(a.id).y - at(b.id).y);
  const movement = patch.modules.filter(m => MODULES[m.type].modOut);
  const card = m => {
    const spec = MODULES[m.type];
    return `<section class="card mod-${m.type}${spec.scope === 'global' ? ' global' : ''}${m.off ? ' is-off' : ''}${m.pads ? ' kit-card' : ''}" data-mod="${m.id}">
      <header title="${esc(spec.help)}"><button class="power-btn${m.off ? ' is-off' : ''}" data-act="power" data-id="${m.id}" title="${m.off ? 'Bypassed: click to switch it back on' : 'Bypass: switch it off without deleting, to hear the difference'}">${uiIcon('power')}</button>
        <b>${spec.label}</b> <span class="mid">${m.id}</span>${spec.scope === 'global' ? '<span class="tag">effect</span>' : ''}${m.off ? '<span class="tag">off</span>' : ''}
        <span class="spacer"></span><button class="ghost small x" data-act="del" data-id="${m.id}" title="Remove this module">✕</button></header>
      <div class="prms">${visibleParams(m).filter(p => !(m.zones && (p.key === 'file' || p.key === 'root'))).map(p => paramHTML(m, p)).join('')}</div>
      ${m.zones ? `<div class="zones"><b>Multi-sample:</b> ${m.zones.length} recordings, ${noteName(m.zones[0].lo === 0 ? m.zones[0].root : m.zones[0].lo)}–${noteName(m.zones.at(-1).root)}${m.zones.some(z => z.loopEnd > z.loopStart) ? ', each with its own loop' : ''}.
        <span class="hint">Each note plays the nearest recording. The waveform shows the one for the last note played.</span>
        <button class="ghost small" data-act="zones-clear" data-id="${m.id}" title="Forget the zones and play one recording across the keyboard">Use one sample instead</button></div>` : ''}
      ${m.type === 'sampler' ? `<div class="spectro-row"><button class="ghost small" data-act="multi-import" data-id="${m.id}" title="Choose several recordings (e.g. a piano sample set, one file per note): each plays the keys around its note, found from its name (C4, F#2, piano_060…) or its pitch">Load multi-sample…</button></div>` : ''}
      ${(m.type === 'sampler' || m.type === 'granular') && m.params.file && !m.zones ? `<div class="spectro-row"><button class="ghost small" data-act="spectro" data-id="${m.id}" title="See ${esc(m.params.file)} as a spectrogram and paint on it; the edit is saved as a new recording, which this module then plays">${uiIcon('spectro')} Spectrogram</button></div>` : ''}
      ${m.pads ? kitHTML(m) : ''}
      ${m.rack ? rackHTML(m) : ''}
      ${m.type === 'sampler' || m.type === 'granular' ? `<canvas class="sample-wave" data-id="${m.id}" title="${m.type === 'granular' ? 'The recording: grains come from the marked part, around the position line' : 'The sample: the bright part plays (start to end), the marked part loops'}"></canvas>` : ''}
      ${routesHTML(m.id)}
    </section>`;
  };
  const cards = [`<h3 class="group-h">Sound <span class="hint">in the order it flows, to the output</span></h3>`, ...sound.map(card),
    `<h3 class="group-h">Movement <span class="hint">envelopes, LFOs, how you play</span></h3>`, ...movement.map(card)];
  cards.push(`<section class="card sources"><header title="Modulation from how you play"><b>Velocity &amp; mod wheel</b></header>
    <div class="src-h">Velocity</div>${routesHTML('vel')}<div class="src-h">Mod wheel <span class="hint">(CC 1; the MPK mini's joystick pushed up)</span></div>${routesHTML('wheel')}</section>`);
  $('#modules').innerHTML = cards.join('');
  for (const m of patch.modules) { if (m.pads) drawPad(m); if (m.type === 'sampler' || m.type === 'granular') drawSample(m); }
  renderView();
  $('#learn').classList.toggle('on', learn);
}

// ---- the patch diagram ----

let viewSel = null; // what's selected: a cable { kind: 'audio' | 'mod', from, to }, or { kind: 'module', id }
let justDragged = false; // a drag ends with a click; ignore that one

function renderView() {
  const el = $('#patch-view');
  el.hidden = !prefs.viewOpen;
  $('#scope').hidden = !prefs.viewOpen;
  $('#view-col').textContent = prefs.viewOpen ? '▾' : '▸';
  if (!prefs.viewOpen) return;
  if (viewSel?.kind === 'module' ? !(viewSel.id === 'out' || SOURCES[viewSel.id] || modOf(viewSel.id))
    : viewSel && !(viewSel.kind === 'audio' ? patch.audio : patch.mod).some(c => c.from === viewSel.from && c.to === viewSel.to)) viewSel = null;
  el.innerHTML = patchSVG(patch, { selected: viewSel }) + selOverlay();
  if (viewSel) placeOverlay();
  restoreWaves();
}

const refreshShape = m => { if (MODULES[m.type].modOut) document.querySelector(`[data-box="${m.id}"] .shape`)?.setAttribute('d', shapePath(m)); };

// ---- waveforms: each box's output, and the instrument's wave and spectrum under the diagram ----
// Drawn while a note is held; when the notes are released the last picture stays (dimmed), so it
// can be looked at. Each box's trace is scaled to fit (it shows shape, not level). The traces show two cycles of the lowest held note, so they stand still.

synth.enableScopes();
const tbuf = new Float32Array(8192), fbuf = new Float32Array(4096);
let scopeRaf = 0, scopeNote = 60;
let held = { shape: '', waves: new Map() }; // the last picture, kept after the notes end
const waveShape = () => JSON.stringify([patch.audio, patch.modules.map(m => [m.id, !!m.off])]);
const noteHz = n => 440 * 2 ** ((n - 69) / 12);

// The newest stretch of `an`'s signal starting at a rising zero crossing, `periods` cycles of hz long.
function grab(an, hz, periods) {
  an.getFloatTimeDomainData(tbuf);
  const N = tbuf.length, period = ac.sampleRate / hz, span = Math.min(N / 2, Math.round(period * periods));
  let start = N - span - 1;
  for (let i = start, stop = Math.max(1, start - period * 1.5); i > stop; i--) if (tbuf[i - 1] < 0 && tbuf[i] >= 0) { start = i; break; }
  return { start, span };
}
function tracePath(an, hz) {
  const { x, y, w, h } = WAVE, { start, span } = grab(an, hz, 2), n = Math.min(span, 160);
  // Scaled to fit, so a quiet signal's shape still shows (up to 4×; silence stays flat).
  let peak = 0;
  for (let i = start; i < start + span; i++) peak = Math.max(peak, Math.abs(tbuf[i]));
  const gain = 1 / Math.max(peak, 0.25);
  let d = '';
  for (let k = 0; k <= n; k++) {
    const v = tbuf[start + Math.floor((k / n) * (span - 1))] * gain;
    d += `${k ? 'L' : 'M'}${(x + (k / n) * w).toFixed(1)},${(y + h / 2 - v * h / 2).toFixed(1)}`;
  }
  return d;
}
function restoreWaves() {
  const view = $('#patch-view');
  view.classList.toggle('waves-held', !synth.holding());
  if (held.shape !== waveShape()) { held.waves.clear(); return; }
  for (const [id, d] of held.waves) view.querySelector(`[data-wave="${id}"]`)?.setAttribute('d', d);
}

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function fitCanvas(c) {
  const r = devicePixelRatio || 1, w = Math.round(c.clientWidth * r), h = Math.round(c.clientHeight * r);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.setTransform(r, 0, 0, r, 0, 0);
  g.clearRect(0, 0, c.clientWidth, c.clientHeight);
  return { g, w: c.clientWidth, h: c.clientHeight };
}
const SPEC_LO = 20, SPEC_HI = 20000, DB_LO = -110, DB_HI = -10;
function drawOutput(live) {
  const muted = css('--muted'), line = css('--line'), accent = css('--lcd-text') || css('--accent'); // drawn like an LCD (theme.css)
  // The wave: three cycles of the lowest held note.
  {
    const { g, w, h } = fitCanvas($('#scope-wave'));
    g.strokeStyle = line; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    if (live) {
      const { start, span } = grab(synth.scopes.get('out'), noteHz(scopeNote), 3), n = Math.min(span, w * 2);
      let peak = 0;
      for (let i = start; i < start + span; i++) peak = Math.max(peak, Math.abs(tbuf[i]));
      const gain = 1 / Math.max(peak, 0.1);
      g.strokeStyle = accent; g.lineWidth = 1.5; g.beginPath();
      for (let k = 0; k <= n; k++) {
        const v = tbuf[start + Math.floor((k / n) * (span - 1))] * gain;
        g[k ? 'lineTo' : 'moveTo']((k / n) * w, h / 2 - v * (h / 2 - 4));
      }
      g.stroke();
    } else { g.fillStyle = muted; g.font = '12px system-ui'; g.fillText('Play a note to see the sound', 10, 18); }
  }
  // Over time: a scrolling spectrogram (frequency up, time across, brighter = louder).
  if (prefs.specMode === 'time') { drawFall(live); return; }
  // The spectrum: how loud each frequency is (log frequency across, decibels up).
  {
    const { g, w, h } = fitCanvas($('#scope-spec'));
    const X = f => (Math.log(f / SPEC_LO) / Math.log(SPEC_HI / SPEC_LO)) * w;
    g.font = '10px ui-monospace, monospace'; g.fillStyle = muted; g.strokeStyle = line; g.lineWidth = 1;
    for (const [f, label] of [[100, '100'], [1000, '1k'], [10000, '10k']]) {
      g.beginPath(); g.moveTo(X(f), 0); g.lineTo(X(f), h); g.stroke(); g.fillText(label, X(f) + 3, h - 4);
    }
    if (!live) return;
    synth.scopes.get('out').getFloatFrequencyData(fbuf);
    const binHz = ac.sampleRate / 2 / fbuf.length, Y = db => h - ((Math.max(DB_LO, Math.min(DB_HI, db)) - DB_LO) / (DB_HI - DB_LO)) * h;
    g.beginPath(); g.moveTo(0, h);
    for (let px = 0; px <= w; px++) {
      // The loudest bin under each pixel, so narrow harmonics still show at the top.
      const f0 = SPEC_LO * (SPEC_HI / SPEC_LO) ** (px / w), f1 = SPEC_LO * (SPEC_HI / SPEC_LO) ** ((px + 1) / w);
      let db = -Infinity;
      for (let b = Math.floor(f0 / binHz); b <= Math.min(fbuf.length - 1, Math.ceil(f1 / binHz)); b++) db = Math.max(db, fbuf[b]);
      g.lineTo(px, Y(db));
    }
    g.lineTo(w, h); g.closePath();
    g.fillStyle = css('--accent-soft'); g.fill();
    g.strokeStyle = accent; g.lineWidth = 1.2; g.stroke();
  }
}

// The spectrogram scrolls 2 px per frame on its own canvas, which is copied onto the pane.
let fall = null, lastLive = 0;
function drawFall(live) {
  const c = $('#scope-spec'), r = devicePixelRatio || 1, W = Math.round(c.clientWidth * r), H = Math.round(c.clientHeight * r);
  if (!W || !H) return; // not on screen (the Lab's frame is hidden, or the pane is closed): drawn once it shows
  if (!fall || fall.width !== W || fall.height !== H) {
    const old = fall;
    fall = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const fg = fall.getContext('2d');
    fg.fillStyle = `rgb(${heat(0).join(',')})`;
    fg.fillRect(0, 0, W, H);
    if (old) fg.drawImage(old, 0, 0, W, H);
  }
  const fg = fall.getContext('2d');
  if (live) {
    synth.scopes.get('out').getFloatFrequencyData(fbuf);
    const step = Math.max(1, Math.round(2 * r)), binHz = ac.sampleRate / 2 / fbuf.length;
    fg.drawImage(fall, -step, 0);
    const col = fg.createImageData(step, H);
    for (let y = 0; y < H; y++) {
      // The loudest bin in this row's frequency range.
      const f0 = rowHz(y + 1, H + 1, SPEC_LO, SPEC_HI), f1 = rowHz(y, H + 1, SPEC_LO, SPEC_HI);
      let db = -Infinity;
      for (let b = Math.floor(f0 / binHz); b <= Math.min(fbuf.length - 1, Math.ceil(f1 / binHz)); b++) db = Math.max(db, fbuf[b]);
      const rgb = heat((db - DB_LO) / (DB_HI - DB_LO));
      for (let x = 0; x < step; x++) col.data.set([...rgb, 255], (y * step + x) * 4);
    }
    fg.putImageData(col, W - step, 0);
  }
  const { g, w, h } = fitCanvas(c);
  g.drawImage(fall, 0, 0, w, h);
  g.font = '10px ui-monospace, monospace'; g.fillStyle = 'rgba(255,255,255,.75)';
  for (const [f, label] of [[100, '100'], [1000, '1k'], [10000, '10k']]) g.fillText(label, 3, (Math.log(f / SPEC_HI) / Math.log(SPEC_LO / SPEC_HI)) * h - 2);
}
function setSpecMode(mode) {
  prefs.specMode = mode;
  savePrefs();
  document.querySelectorAll('[data-spec]').forEach(b => b.classList.toggle('on', b.dataset.spec === mode));
  $('#spec-hint').textContent = mode === 'time' ? 'over time, low to high' : 'bass to treble';
  drawOutput(false);
}
document.querySelectorAll('[data-spec]').forEach(b => b.addEventListener('click', () => setSpecMode(b.dataset.spec)));
setSpecMode(prefs.specMode || 'now');
// Resizing a canvas clears it, and the Lab often loads in a hidden frame (zero size): redraw the
// empty panes once they have a size (a held note redraws itself every frame).
new ResizeObserver(() => { if (prefs.viewOpen && !synth.holding()) drawOutput(false); }).observe($('#scope-spec'));

// The empty scope offers a note to look at; gone once anything has played.
$('#scope-try').onclick = () => preview();

function scopeFrame() {
  scopeRaf = 0;
  if (!prefs.viewOpen || !onScreen() || document.hidden) return;
  const live = synth.holding(), view = $('#patch-view');
  view.classList.toggle('waves-held', !live);
  if (live) { lastLive = performance.now(); $('#scope-try').hidden = true; }
  if (!live) {
    // The spectrogram keeps scrolling a little, to show release and echo tails.
    if (prefs.specMode === 'time' && performance.now() - lastLive < 3000) { drawFall(true); scopeRaf = requestAnimationFrame(scopeFrame); }
    return; // the last picture stays
  }
  if (down.size) scopeNote = Math.min(...down.keys());
  const hz = noteHz(scopeNote);
  held = { shape: waveShape(), waves: new Map() };
  for (const [id, an] of synth.scopes) {
    const path = view.querySelector(`[data-wave="${id}"]`);
    if (!path) continue;
    const d = tracePath(an, hz);
    path.setAttribute('d', d);
    held.waves.set(id, d);
  }
  drawOutput(true);
  scopeRaf = requestAnimationFrame(scopeFrame);
}
const startScopes = () => { if (!scopeRaf) scopeRaf = requestAnimationFrame(scopeFrame); };

// The box for a selected cable: what it connects, its amount (modulation), and remove.
function selOverlay() {
  if (!viewSel) return '';
  const name = id => (id === 'out' ? 'Output' : SOURCES[id]?.label || id);
  if (viewSel.kind === 'module') return modulePanel(viewSel.id);
  if (viewSel.kind === 'audio') {
    const fm = modOf(viewSel.to)?.type === 'fmop';
    return `<div class="view-pop"><span>${esc(name(viewSel.from))} → ${esc(name(viewSel.to))}${fm ? ' (FM)' : ''}</span>
      <button class="small" data-act="v-del">✕ Remove</button></div>`;
  }
  const i = patch.mod.findIndex(c => c.from === viewSel.from && c.to === viewSel.to), c = patch.mod[i];
  const [id, key] = c.to.split('.'), t = MODULES[modOf(id).type].targets[key];
  return `<div class="view-pop"><span>${esc(name(c.from))} → ${esc(targetLabel(c.to))}</span>
    <input type="range" min="0" max="1000" value="${Math.round((c.amount - t.min) / (t.max - t.min) * 1000)}" data-act="v-amt" data-i="${i}">
    <span class="val">${amountText(c.to, c.amount)}</span><button class="small" data-act="v-del">✕</button></div>`;
}
// A module's panel: everything connected to it (each with ✕), menus to connect it to more, bypass,
// its settings, remove.
function modulePanel(id) {
  const m = modOf(id), title = id === 'out' ? 'Output' : SOURCES[id]?.label || MODULES[m.type].label;
  const from = patch.audio.filter(c => c.to === id);
  const by = patch.mod.map((c, i) => [c, i]).filter(([c]) => c.to.startsWith(`${id}.`));
  const incoming = (from.length ? `<div class="route"><span class="route-h">${m?.type === 'fmop' ? 'FM from' : 'Audio from'}</span>${from.map(c =>
    `<span class="chip">${esc(c.from)}<button class="x" data-act="a-del" data-from="${c.from}" data-to="${c.to}" title="Disconnect">✕</button></span>`).join('')}</div>` : '')
    + (by.length ? `<div class="route mods"><span class="route-h">Modulated by</span>${by.map(([c, i]) =>
      `<div class="mrow"><span class="mto">${esc(c.from)} → ${esc(targetLabel(c.to))}</span><span></span><span class="val">${amountText(c.to, c.amount)}</span>
        <button class="x" data-act="m-del" data-i="${i}" title="Remove">✕</button></div>`).join('')}</div>` : '');
  return `<div class="view-pop mod-pop">
    <div class="mod-pop-h"><b>${esc(title)}</b>${m ? ` <span class="mid">${esc(id)}</span>` : ''}<span class="spacer"></span>
      ${m ? `<button class="small ${m.off ? '' : 'ghost'}" data-act="power" data-id="${id}">${uiIcon('power')} ${m.off ? 'Turn on' : 'Bypass'}</button>
        <button class="ghost small" data-act="goto" data-id="${id}" title="Show its settings">Settings ↓</button>
        <button class="ghost small" data-act="del" data-id="${id}" title="Remove this module">Remove</button>` : ''}
      <button class="ghost small" data-act="close" title="Close (Esc)">✕</button></div>
    ${incoming}${id === 'out' ? '' : routesHTML(id)}
    ${!incoming && id !== 'out' && !patch.audio.some(c => c.from === id) && !patch.mod.some(c => c.from === id) ? '<p class="hint">Not connected yet: choose where it goes below, or drag from its dot in the diagram.</p>' : ''}
  </div>`;
}

// Puts the overlay next to the selected cable (its middle) or module (below it).
function placeOverlay() {
  const pop = document.querySelector('#patch-view .view-pop'), view = $('#patch-view');
  if (!pop) return;
  const box = view.getBoundingClientRect();
  let x, y;
  if (viewSel.kind === 'module') {
    const b = view.querySelector(`[data-box="${viewSel.id}"] rect`)?.getBoundingClientRect();
    if (!b) return;
    x = b.left; y = b.bottom + 14;
  } else {
    const path = view.querySelector('.cable.sel .line');
    if (!path) return;
    const mid = path.getPointAtLength(path.getTotalLength() / 2), p = new DOMPoint(mid.x, mid.y).matrixTransform(path.ownerSVGElement.getScreenCTM());
    x = p.x - 80; y = p.y + 10;
  }
  pop.style.left = `${Math.max(4, Math.min(x - box.left + view.scrollLeft, view.scrollWidth - pop.offsetWidth - 4))}px`;
  pop.style.top = `${y - box.top + view.scrollTop}px`;
}
// Delete / Backspace: removes the selected cable or module (one undo step either way).
function deleteSelected() {
  if (!viewSel) return;
  if (viewSel.kind === 'module') { if (modOf(viewSel.id)) removeModule(viewSel.id); return; } // not Output, velocity, wheel
  const list = viewSel.kind === 'audio' ? 'audio' : 'mod';
  patch[list] = patch[list].filter(c => !(c.from === viewSel.from && c.to === viewSel.to));
  viewSel = null;
  changed({ rebuild: true });
  renderModules();
}
// A module and everything connected to it.
function removeModule(id) {
  patch.modules = patch.modules.filter(m => m.id !== id);
  patch.audio = patch.audio.filter(c => c.from !== id && c.to !== id);
  patch.mod = patch.mod.filter(c => c.from !== id && !c.to.startsWith(`${id}.`));
  for (const [k, t] of Object.entries(patch.cc)) if (t.startsWith(`${id}.`)) delete patch.cc[k];
  if (viewSel?.id === id) viewSel = null;
  changed({ rebuild: true });
  renderModules();
  toast(`Removed ${id}. Undo (⌘Z) brings it back.`);
}
function togglePower(id) {
  const m = modOf(id);
  if (!m) return;
  if (m.off) delete m.off; else m.off = true;
  changed({ rebuild: true });
  renderModules();
}

// Connects `from` (a module or a modulation source) to the module `to`. A modulation source
// with several possible targets on that module asks which one.
function connect(from, to, at) {
  if (!to || to === from) return;
  const fromMod = modOf(from), modSource = SOURCES[from] || (fromMod && MODULES[fromMod.type].modOut);
  if (!modSource) {
    if (!audioDestinations(from).includes(to)) { toast(to === 'out' || modOf(to) ? `${from} can't send audio to ${to === 'out' ? 'the output' : to} (it would loop, or it's already connected).` : 'Drop it on a module.'); return; }
    patch.audio.push({ from, to });
    changed({ rebuild: true });
    renderModules();
    return;
  }
  const keys = modOf(to) ? Object.keys(MODULES[modOf(to).type].targets).filter(k => !patch.mod.some(c => c.from === from && c.to === `${to}.${k}`)) : [];
  if (!keys.length) { toast(modOf(to) ? `Nothing on ${to} for ${from} to modulate.` : 'Drop it on a module.'); return; }
  const add = key => addMod(from, `${to}.${key}`);
  if (keys.length === 1) { add(keys[0]); return; }
  const menu = document.createElement('div');
  menu.className = 'view-menu';
  menu.innerHTML = `<span>${esc(from)} → ${esc(to)}:</span>${keys.map(k => `<button class="small" data-k="${k}">${esc(paramOf(modOf(to).type, k)?.label || k)}</button>`).join('')}<button class="ghost small" data-k="">Cancel</button>`;
  const box = $('#patch-view').getBoundingClientRect();
  menu.style.left = `${at.x - box.left + $('#patch-view').scrollLeft}px`;
  menu.style.top = `${at.y - box.top + $('#patch-view').scrollTop}px`;
  $('#patch-view').append(menu);
  menu.onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; menu.remove(); if (b.dataset.k) add(b.dataset.k); };
}
function addMod(from, to) {
  const [id, key] = to.split('.'), t = MODULES[modOf(id).type].targets[key];
  const amount = t.unit === 'cents' ? (key === 'pitch' ? 50 : 1200) : Math.round(t.max * 25) / 100;
  patch.mod.push({ from, to, amount });
  viewSel = { kind: 'mod', from, to };
  changed({ rebuild: true });
  renderModules();
}

$('#view-col').onclick = () => { prefs.viewOpen = !prefs.viewOpen; savePrefs(); renderView(); if (prefs.viewOpen && !synth.holding()) drawOutput(false); };
$('#patch-view').addEventListener('pointerdown', e => {
  const port = e.target.closest('.port');
  if (!port) return;
  e.preventDefault();
  const svg = port.ownerSVGElement, line = svg.querySelector('.drag-line'), from = port.dataset.port;
  const toSvg = (x, y) => new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
  const c = port.getBoundingClientRect(), start = toSvg(c.left + c.width / 2, c.top + c.height / 2);
  // Light up everywhere this can connect: audio ins for audio, setting dots for modulation.
  const isMod = port.classList.contains('mod');
  const valid = new Set(isMod ? modTargets(from) : audioDestinations(from));
  svg.classList.add(isMod ? 'dragging-mod' : 'dragging-audio');
  svg.querySelectorAll(isMod ? '.tdot' : '.in-port').forEach(d => d.classList.toggle('valid', valid.has(d.dataset.target || d.dataset.in)));
  const move = ev => { const p = toSvg(ev.clientX, ev.clientY); line.setAttribute('d', `M${start.x},${start.y} L${p.x},${p.y}`); };
  const up = ev => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    line.setAttribute('d', '');
    svg.classList.remove('dragging-mod', 'dragging-audio');
    svg.querySelectorAll('.valid').forEach(d => d.classList.remove('valid'));
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const dot = under?.closest('.tdot'), inPort = under?.closest('.in-port');
    if (isMod && dot) { if (valid.has(dot.dataset.target)) addMod(from, dot.dataset.target); else toast('Already connected there.'); return; }
    if (!isMod && inPort) { connect(from, inPort.dataset.in); return; }
    // Audio dropped on a setting's dot: settings are moved by modulators, not by sound.
    if (!isMod && dot) { toast(`${from} sends sound, which can't move a setting. To move ${dot.dataset.target.replace('.', '\'s ')}, drag from an LFO or envelope's blue dot (an LFO swings it back and forth).`); return; }
    const box = under?.closest('[data-box]')?.dataset.box;
    // Dropped on a box: modulation goes to its default setting (the ringed dot) if that's free.
    const def = isMod && modOf(box) && `${box}.${defaultTarget(modOf(box).type)}`;
    if (def && valid.has(def)) { addMod(from, def); return; }
    connect(from, box, { x: ev.clientX, y: ev.clientY });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});
$('#patch-view').addEventListener('click', e => {
  if (justDragged) return;
  const power = e.target.closest('[data-power]');
  if (power) { togglePower(power.dataset.power); return; }
  const actEl = e.target.closest('[data-act]'), act = actEl?.dataset.act;
  if (act === 'v-del') { deleteSelected(); return; }
  if (act === 'close') { viewSel = null; renderView(); return; }
  if (act === 'goto') {
    const card = document.querySelector(`[data-mod="${actEl.dataset.id}"]`);
    if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
    return;
  }
  if (actEl && e.target.closest('.mod-pop') && routeClick(actEl)) return;
  if (e.target.closest('.view-pop, .view-menu, .port')) return;
  const cable = e.target.closest('.cable');
  if (cable) { viewSel = { kind: cable.dataset.kind, from: cable.dataset.from, to: cable.dataset.to }; renderView(); return; }
  // A module (or the Output, velocity, the wheel): open its panel; clicking it again closes it.
  const box = e.target.closest('[data-box]')?.dataset.box;
  viewSel = box && !(viewSel?.kind === 'module' && viewSel.id === box) ? { kind: 'module', id: box } : null;
  renderView();
});
$('#patch-view').addEventListener('change', e => { if (e.target.closest('.mod-pop')) routeChange(e.target); });
$('#patch-view').addEventListener('input', e => {
  if (e.target.closest('.mod-pop') && routeInput(e.target)) return;
  if (e.target.dataset.act !== 'v-amt') return;
  const i = +e.target.dataset.i, c = patch.mod[i], [id, key] = c.to.split('.'), t = MODULES[modOf(id).type].targets[key];
  let v = t.min + +e.target.value / 1000 * (t.max - t.min);
  if (Math.abs(v) < (t.max - t.min) * 0.01) v = 0;
  c.amount = t.unit === 'cents' ? Math.round(v) : Math.round(v * 100) / 100;
  synth.setMod(i, c.amount);
  e.target.parentElement.querySelector('.val').textContent = amountText(c.to, c.amount);
  // Keep the card's slider in step.
  const cardRange = document.querySelector(`#modules [data-act="m-amt"][data-i="${i}"]`);
  if (cardRange) { cardRange.value = e.target.value; cardRange.parentElement.querySelector('.val').textContent = amountText(c.to, c.amount); }
  changed({ coalesce: true });
});

// ---------------------------------------------------------------------------------------------
// Editing

// Connection controls, in the cards and in the diagram's module panel.
function routeInput(el) {
  if (el.dataset.act !== 'm-amt') return false;
  const i = +el.dataset.i, c = patch.mod[i], [id, key] = c.to.split('.'), t = MODULES[modOf(id).type].targets[key];
  let v = t.min + +el.value / 1000 * (t.max - t.min);
  if (Math.abs(v) < (t.max - t.min) * 0.01) v = 0; // snap to none in the middle
  c.amount = t.unit === 'cents' ? Math.round(v) : Math.round(v * 100) / 100;
  synth.setMod(i, c.amount);
  el.parentElement.querySelector('.val').textContent = amountText(c.to, c.amount);
  changed({ coalesce: true });
  return true;
}
function routeClick(el) {
  switch (el.dataset.act) {
    case 'power': togglePower(el.dataset.id); return true;
    case 'del': removeModule(el.dataset.id); return true;
    case 'a-del':
      patch.audio = patch.audio.filter(c => !(c.from === el.dataset.from && c.to === el.dataset.to));
      changed({ rebuild: true });
      renderModules();
      return true;
    case 'm-del':
      patch.mod.splice(+el.dataset.i, 1);
      changed({ rebuild: true });
      renderModules();
      return true;
  }
  return false;
}
// A choice: a row of buttons, or a menu when there are many (Sync's note lengths). Both carry the
// same data-act, so routeClick handles them (routeChange passes the menu's pick on).
function choiceHTML(spec, v, attrs, help) {
  if (spec.choices.length > 6) return `<div class="prm"${help}><label>${spec.label}</label><select ${attrs}>${spec.choices.map(c =>
    `<option value="${esc(c)}" ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`;
  return `<div class="prm"${help}><label>${spec.label}</label><span class="seg-btn">${spec.choices.map(c =>
    `<button ${attrs} data-v="${esc(c)}" class="${c === v ? 'on' : ''}">${esc(c)}</button>`).join('')}</span></div>`;
}

function routeChange(el) {
  if (el.tagName === 'SELECT' && (el.dataset.act === 'choice' || el.dataset.act === 'rack-choice')) { el.dataset.v = el.value; routeClick(el); return true; }
  if (el.dataset.act === 'rack-add' && el.value) {
    const m = modOf(el.dataset.id);
    m.rack.modules.push({ type: el.value, params: defaultParams(el.value) });
    changed({ rebuild: true });
    renderModules();
    return true;
  }
  if (el.dataset.act === 'rack-file') {
    const m = modOf(el.dataset.id), e = m.rack.modules[+el.dataset.k];
    e.params[el.dataset.key] = el.value;
    synth.setParam(m.id, `${el.dataset.k}.${el.dataset.key}`, el.value);
    changed();
    return true;
  }
  if (el.dataset.act === 'pad-file') {
    const m = modOf(el.dataset.id);
    m.pads[selPad(m)][el.dataset.key] = el.value;
    padChanged(m);
    setTimeout(() => hitPad(selPad(m)), 300); // once it has loaded
    drawPadSoon(m);
    return true;
  }
  if (el.dataset.act === 'pad-name') {
    const m = modOf(el.dataset.id);
    m.pads[selPad(m)].name = el.value.trim().slice(0, 24) || m.pads[selPad(m)].name;
    padChanged(m);
    renderModules();
    return true;
  }
  if (el.dataset.act === 'file') {
    const m = modOf(el.dataset.id);
    m.params[el.dataset.key] = el.value;
    synth.setParam(m.id, el.dataset.key, el.value);
    synth.loadSamples();
    changed();
    if ('root' in m.params && el.value) setRootFrom(m, el.value);
    if (m.type === 'sampler' || m.type === 'granular') drawSample(m);
    return true;
  }
  if (el.dataset.act === 'a-add' && el.value) {
    patch.audio.push({ from: el.dataset.from, to: el.value });
    changed({ rebuild: true });
    renderModules();
    return true;
  }
  if (el.dataset.act === 'm-add' && el.value) {
    const [id, key] = el.value.split('.'), t = MODULES[modOf(id).type].targets[key];
    // A gentle starting amount: a quarter of the way up.
    const amount = t.unit === 'cents' ? (key === 'pitch' ? 50 : 1200) : Math.round(t.max * 25) / 100;
    patch.mod.push({ from: el.dataset.from, to: el.value, amount });
    changed({ rebuild: true });
    renderModules();
    return true;
  }
  return false;
}

$('#modules').addEventListener('input', e => {
  const el = e.target;
  if (routeInput(el)) return;
  if (el.dataset.act === 'pad-num') {
    const m = modOf(el.dataset.id), spec = padParam(el.dataset.key), v = fromSlider(spec, +el.value / 1000);
    m.pads[selPad(m)][spec.key] = v;
    el.parentElement.querySelector('.val').textContent = spec.key === 'choke' ? (v ? `group ${v}` : 'none') : formatValue(spec, v);
    padChanged(m, { coalesce: true });
    drawPadSoon(m);
    return;
  }
  if (el.dataset.act === 'rack-num') {
    const m = modOf(el.dataset.id), k = +el.dataset.k, e = m.rack.modules[k], spec = paramOf(e.type, el.dataset.key), v = fromSlider(spec, +el.value / 1000);
    e.params[spec.key] = v;
    synth.setParam(m.id, `${k}.${spec.key}`, v);
    el.parentElement.querySelector('.val').textContent = formatValue(spec, v);
    changed({ coalesce: true });
    return;
  }
  if (el.dataset.act === 'num') {
    const m = modOf(el.dataset.id), spec = paramOf(m.type, el.dataset.key), v = fromSlider(spec, +el.value / 1000);
    m.params[spec.key] = v;
    synth.setParam(m.id, spec.key, v);
    refreshShape(m);
    if (m.pads) drawPadSoon(m); // the kit's Tune, Decay and Tone change every pad
    if (m.type === 'sampler' || m.type === 'granular') drawSample(m);
    el.parentElement.querySelector('.val').textContent = formatValue(spec, v);
    changed({ coalesce: true });
  }
});

$('#modules').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  // Learning: clicking a setting picks it as the target for the next knob turned.
  const row = e.target.closest('.prm[data-target]');
  if (learn && row && el?.dataset.act !== 'unlearn') { learnTarget = row.dataset.target; renderModules(); return; }
  if (!el || routeClick(el) || rackClick(el)) return;
  switch (el.dataset.act) {
    case 'zones-clear': {
      const m = modOf(el.dataset.id);
      if (!confirm('Forget the zones? It then plays one recording (the one for C4) across the keyboard. ⌘Z brings them back.')) break;
      const z = zoneFor(m.zones, 60);
      Object.assign(m.params, { file: z.file, root: z.root });
      delete m.zones;
      changed({ rebuild: true });
      renderModules();
      break;
    }
    case 'import-audio': importFor = { act: el.dataset.for, id: el.dataset.id, key: el.dataset.key }; importInput.click(); break;
    case 'multi-import': multiFor = el.dataset.id; multiInput.click(); break;
    case 'pad': { const m = modOf(el.dataset.id); kitSel[m.id] = +el.dataset.n; renderModules(); hitPad(+el.dataset.n); break; }
    case 'pad-play': hitPad(selPad(modOf(el.dataset.id))); break;
    case 'pad-choice': { const m = modOf(el.dataset.id); m.pads[selPad(m)][el.dataset.key] = el.dataset.v; padChanged(m, { play: true }); renderModules(); break; }
    case 'pad-vary': {
      const m = modOf(el.dataset.id), n = selPad(m);
      m.pads[n] = varyPad(m.pads[n], +el.dataset.amt);
      padChanged(m, { play: true });
      renderModules();
      break;
    }
    case 'pad-reset': { const m = modOf(el.dataset.id), n = selPad(m); m.pads[n] = cleanPad(DEFAULT_PADS[n], n); padChanged(m, { play: true }); renderModules(); break; }
    case 'pad-sound': {
      const m = modOf(el.dataset.id), n = selPad(m);
      openSoundPicker({ anchor: el, title: `Sound for ${m.pads[n].name}`, instruments: ['synth'], isCurrent: e => e.name === m.pads[n].lSound?.name,
        onPick: item => {
          if (!item.sound?.patch) return;
          const pad = m.pads[n];
          pad.lSound = { name: item.name, patch: normalizePatch(item.sound.patch, { nested: true }).patch };
          if (!(pad.lLevel > 0)) pad.lLevel = 1;
          el.textContent = item.name;
          el.classList.remove('ghost');
          padChanged(m, { play: true });
          drawPadSoon(m);
        } });
      break;
    }
    case 'pad-sound-off': { const m = modOf(el.dataset.id); m.pads[selPad(m)].lSound = null; padChanged(m, { play: true }); renderModules(); break; }
    case 'pad-bounce': bouncePad(modOf(el.dataset.id)); break;
    case 'spectro': openSpectro(modOf(el.dataset.id), !!el.dataset.pad); break;
    case 'pad-copy': { const m = modOf(el.dataset.id); padClip = { ...m.pads[selPad(m)] }; toast(`Copied ${padClip.name}.`); renderModules(); break; }
    case 'pad-paste': { const m = modOf(el.dataset.id); if (padClip) { m.pads[selPad(m)] = { ...padClip }; padChanged(m, { play: true }); renderModules(); } break; }
    case 'pad-from': { const id = el.dataset.id; kitFrom = kitFrom === id ? null : id; renderModules(); break; }
    case 'pad-take': {
      const m = modOf(el.dataset.id), k = otherKits()[+el.dataset.kit];
      if (k) { m.pads[selPad(m)] = { ...k.pads[+el.dataset.n] }; padChanged(m, { play: true }); renderModules(); }
      break;
    }
    case 'choice': {
      const m = modOf(el.dataset.id);
      m.params[el.dataset.key] = el.dataset.v;
      // Some settings (an oscillator's wave, a filter's slope...) change which nodes a note uses.
      const structural = !!paramOf(m.type, el.dataset.key)?.rebuild;
      if (!structural) synth.setParam(m.id, el.dataset.key, el.dataset.v);
      changed({ rebuild: structural });
      renderModules();
      break;
    }
    case 'unlearn':
      delete patch.cc[el.dataset.cc];
      changed();
      renderModules();
      break;
  }
});

$('#modules').addEventListener('change', e => routeChange(e.target));

// ---- adding modules: a picker of module types, grouped, each with a small picture ----

const PICKER_GROUPS = [
  ['Make sound', ['osc', 'string', 'organ', 'sampler', 'granular', 'noise', 'fmop', 'drums']],
  ['Shape it', ['filter', 'vowel', 'drive', 'ring', 'amp', 'space']],
  ['Move things', ['env', 'lfo', 'glfo']],
  ['Effects', ['soundboard', 'resonance', 'reverb', 'shimmer', 'delay', 'chorus', 'phaser', 'flanger', 'tremolo', 'eq', 'compressor', 'shaper', 'crusher', 'stutter', 'freeze', 'rotary']],
];
const ICONS = {
  osc: 'M2 17 L8 7 V17 L14 7 V17 L20 7 V17',
  sampler: 'M3 12 H5 M5 8 V16 M8 5 V19 M11 9 V15 M14 3 V21 M17 8 V16 M20 11 V13',
  granular: 'M5 6 h.01 M10 4 h.01 M15 7 h.01 M19 5 h.01 M4 12 h.01 M9 10 h.01 M13 13 h.01 M18 11 h.01 M6 18 h.01 M11 16 h.01 M16 19 h.01 M20 16 h.01',
  noise: 'M2 12 l2-5 l2 9 l2-7 l2 6 l2-8 l2 9 l2-4 l2 3 l2-6 l2 4',
  fmop: 'M2 12 C4 3 6 3 8 12 S11 21 12 12 S14 6 15 12 S17 16 18 12 S20 9 21 12',
  drums: 'M4 10 a8 3 0 1 0 16 0 a8 3 0 1 0 -16 0 M4 10 V16 a8 3 0 0 0 16 0 V10 M9 2 L12 8 M17 2 L14 8',
  filter: 'M2 9 H11 Q14 9 15 5 Q16 11 21 20',
  vowel: 'M3 12 Q12 3 21 12 Q12 21 3 12 Z M8 12 Q12 9 16 12 Q12 15 8 12',
  drive: 'M2 12 L5 6 H10 L14 18 H19 L22 12',
  ring: 'M12 3 a9 9 0 1 0 0.01 0 M7.5 7.5 L16.5 16.5 M16.5 7.5 L7.5 16.5',
  amp: 'M3 19 L21 5 V19 Z',
  space: 'M12 9 a3 3 0 1 0 0.01 0 M3 12 a9 4 0 1 0 18 0 a9 4 0 1 0 -18 0',
  env: 'M2 19 L6 5 L10 11 H16 L21 19',
  lfo: 'M2 12 C6 2 8 2 12 12 S18 22 22 12',
  chorus: 'M2 10 C6 3 8 3 12 10 S18 17 22 10 M2 14 C6 7 8 7 12 14 S18 21 22 14',
  delay: 'M4 5 V19 M9 8 V19 M14 11 V19 M19 14 V19',
  soundboard: 'M3 15 C7 9 17 9 21 15 Z M6 13 L18 6 M9 12 L20 8',
  resonance: 'M3 4 V20 M7 4 V20 M11 4 V20 M15 4 V20 M19 4 V20 M2 12 C6 9 8 15 12 12 S18 9 22 12',
  reverb: 'M5 11 V13 M8 7 a7 7 0 0 1 0 10 M12 4 a11 11 0 0 1 0 16 M16 2 a14 14 0 0 1 0 20',
  phaser: 'M2 12 C5 4 7 4 9 12 S13 20 15 12 S19 4 22 12 M6 3 V21 M17 3 V21',
  shimmer: 'M3 20 L8 14 L12 17 L17 8 L21 4 M17 4 H21 V8 M5 9 h.01 M9 6 h.01 M13 4 h.01',
  flanger: 'M2 8 L22 16 M2 16 L22 8 M2 12 H22',
  tremolo: 'M2 12 C3 6 5 6 6 12 S9 18 10 12 C11 9 12 9 13 12 S15 15 16 12 C17 11 18 11 19 12 S21 13 22 12',
  eq: 'M5 3 V21 M12 3 V21 M19 3 V21 M3 15 H7 M10 8 H14 M17 13 H21',
  compressor: 'M3 20 L10 9 L21 6 M3 4 V20 H21',
  shaper: 'M2 12 C5 12 6 5 9 5 H15 C18 5 19 19 22 19',
  string: 'M2 12 H5 M19 12 H22 M5 12 C8 4 16 20 19 12 M5 12 C8 18 16 6 19 12',
  organ: 'M4 3 V14 M7 3 V9 M10 3 V17 M13 3 V7 M16 3 V12 M19 3 V5 M3 20 H21',
  rotary: 'M12 12 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0 M12 4 V12 L17 15',
  glfo: 'M2 12 C5 4 8 4 11 12 S17 20 20 12 M2 21 H22',
  crusher: 'M2 18 H6 V13 H10 V8 H14 V13 H18 V6 H22',
  stutter: 'M3 6 V18 M8 6 V18 M13 6 V18 M3 12 H5 M8 12 H10 M13 12 H15 M18 9 L22 12 L18 15',
  freeze: 'M12 2 V22 M3.5 7 L20.5 17 M3.5 17 L20.5 7 M9 3.5 L12 6 L15 3.5 M9 20.5 L12 18 L15 20.5',
  rack: 'M3 5 H21 V19 H3 Z M3 10 H21 M3 14 H21 M6 7.5 h.01 M6 12 h.01 M6 16.5 h.01',
};
const icon = type => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[type] || ''}"/></svg>`;
const BLURBS = {
  osc: 'A tone at the note\'s pitch', string: 'Plucked or struck strings', organ: 'Drawbars, percussion, click', rotary: 'Spinning speaker (Leslie)', glfo: 'Moves effects, one for all notes', sampler: 'Plays a recording', granular: 'Clouds from a recording', noise: 'Breath, wind, hiss', fmop: 'Bells, e-pianos, FM basses', drums: 'A synthesized kit',
  filter: 'Darker or brighter', vowel: 'Makes it talk (A E I O U)', drive: 'Warmth to distortion', ring: 'Metallic, robotic', amp: 'Loudness over time', space: 'Around your head',
  env: 'A shape over each note', lfo: 'Swings a setting back and forth',
  chorus: 'Wider, thicker', delay: 'Echoes, ping-pong, tape', soundboard: 'A piano\'s body, for strings', resonance: 'The pedal\'s halo of strings', reverb: 'Room, hall, plate, or a recording',
  phaser: 'Swirling sweep', shimmer: 'Reverb that blooms upward', flanger: 'Jet-plane sweep', tremolo: 'Pulsing or panning', eq: 'Bass, middle, treble', compressor: 'Evens out the level',
  shaper: 'Saturation, clipping, folding', crusher: 'Fewer bits, lower rate', stutter: 'Repeats slices, glitchy', freeze: 'Holds a moment as a drone',
};

function openPicker(anchor) {
  const el = $('#add-picker');
  el.innerHTML = PICKER_GROUPS.map(([title, types]) => `<div class="pick-group"><h4>${title}</h4><div class="pick-grid">${
    types.filter(t => MODULES[t]).map(t => `<button class="pick mod-${t}" data-type="${t}" title="${esc(MODULES[t].help)}">${icon(t)}<b>${MODULES[t].label}</b><span>${BLURBS[t] || ''}</span></button>`).join('')
  }</div></div>`).join('') + `<div class="pick-group"><h4>Your effect racks</h4>${myRacks().length ? `<div class="pick-grid">${myRacks().map(x =>
    `<button class="pick mod-rack" data-rack="${esc(x.file)}" title="${esc(x.patch.modules.map(e => MODULES[e.type]?.label).join(' → '))}">${icon('rack')}<b>${esc(x.name)}</b><span>${esc(x.patch.modules.map(e => MODULES[e.type]?.label).join(' → '))}</span></button>`).join('')}</div>`
    : '<p class="hint">None yet. Build a chain of effects in any sound, then <b>Save effects as rack…</b> (under the module cards) to reuse it as one module.</p>'}</div>`
    + '<p class="hint">New modules start unconnected: connect them in the panel that opens, or drag from their dot.</p>';
  el.hidden = false;
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + 6 + h > innerHeight && r.top - 6 - h > 0 ? r.top - 6 - h : Math.min(r.bottom + 6, Math.max(8, innerHeight - h - 8))}px`;
  el.querySelector('.pick')?.focus();
}
const closePicker = () => { $('#add-picker').hidden = true; };
document.querySelectorAll('[data-picker]').forEach(b => b.addEventListener('click', () => {
  if ($('#add-picker').hidden) openPicker(b); else closePicker();
}));
document.addEventListener('pointerdown', e => { if (!e.target.closest('#add-picker, [data-picker]')) closePicker(); });
addEventListener('resize', closePicker);
$('#add-picker').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closePicker(); } });
$('#add-picker').addEventListener('click', e => {
  const r = e.target.closest('[data-rack]');
  if (r) { closePicker(); addRack(myRacks().find(x => x.file === r.dataset.rack)); return; }
  const b = e.target.closest('[data-type]');
  if (!b) return;
  closePicker();
  addModule(b.dataset.type);
});

// A new module starts unconnected, with its panel open in the patch diagram: connect it there
// (or drag from its output dot).
function addModule(type) {
  if (patch.modules.length >= MAX_MODULES) { toast(`An instrument can have up to ${MAX_MODULES} modules.`, 'err'); return; }
  const id = newId(patch, type);
  patch.modules.push({ id, type, params: defaultParams(type) });
  viewSel = { kind: 'module', id };
  changed({ rebuild: true });
  renderModules();
  if (!prefs.viewOpen) { prefs.viewOpen = true; savePrefs(); renderView(); }
  $('#patch-view').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  toast(`Added ${id}. Connect it in the panel beside it, or drag from its dot.`);
}

// ---- effect racks: a chain of effects saved on its own (a patch with kind 'rack') and used as
// one module in any sound ----

// A saved rack as a module, unconnected like any new module.
function addRack(item) {
  if (!item) return;
  if (patch.modules.length >= MAX_MODULES) { toast(`An instrument can have up to ${MAX_MODULES} modules.`, 'err'); return; }
  const id = newId(patch, 'rack');
  patch.modules.push({ id, type: 'rack', params: defaultParams('rack'), rack: rackOf(item.patch) });
  viewSel = { kind: 'module', id };
  changed({ rebuild: true });
  renderModules();
  if (!prefs.viewOpen) { prefs.viewOpen = true; savePrefs(); renderView(); }
  toast(`Added ${item.name} as ${id}. Connect a sound to it, and it to the output.`);
}
// The patch's effects in signal order (left to right in the diagram), racks opened up.
function effectChain() {
  const { pos } = layout(patch), x = id => pos.get(id)?.x ?? 1e9;
  return patch.modules.filter(m => MODULES[m.type].scope === 'global').sort((a, b) => x(a.id) - x(b.id))
    .flatMap(m => (m.type === 'rack' ? m.rack.modules : [{ type: m.type, params: m.params, ...(m.off ? { off: true } : {}) }]));
}
// Saves effects as a rack file: a patch with only those effects, chained, and kind 'rack'.
async function saveRack(effects, suggested) {
  if (!effects.length) { toast('There are no effects to save.', 'err'); return; }
  if (effects.length > MAX_RACK) { toast(`A rack holds up to ${MAX_RACK} effects; the first ${MAX_RACK} are saved.`); effects = effects.slice(0, MAX_RACK); }
  const name = (prompt(`Save ${effects.map(e => MODULES[e.type].label).join(' → ')} as a rack named:`, suggested) || '').trim().slice(0, 40);
  if (!name) return;
  await refreshSaved();
  const clash = saved.find(x => x.file === fileFor(name));
  if (clash && !confirm(clash.patch?.kind === 'rack' ? `Replace your rack ${clash.name}?` : `${clash.name} is one of your sounds. Replace it with this rack?`)) return;
  const modules = effects.map((e, k) => ({ id: `fx${k + 1}`, type: e.type, params: { ...e.params }, ...(e.off ? { off: true } : {}) }));
  const rack = normalizePatch({ name, kind: 'rack', type: 'FX', voices: 1, volume: 1, modules,
    audio: modules.map((m, k) => ({ from: m.id, to: modules[k + 1]?.id || 'out' })), mod: [], cc: {} }).patch;
  try {
    await storage.save('instruments', rack);
    await refreshSaved();
    toast(`Saved ${name} as an effect rack. Add it to any sound from + Add module → Your effect racks.`, 'ok');
  } catch (err) { toast(`Couldn't save the rack: ${err.message}`, 'err'); }
}
// Unpack: the rack's effects become separate modules in its place (Mix and Level are dropped:
// each effect keeps its own mix). Undo puts the rack back.
function unpackRack(m) {
  const fx = m.rack.modules;
  if (patch.modules.length - 1 + fx.length > MAX_MODULES) { toast(`That would make more than ${MAX_MODULES} modules.`, 'err'); return; }
  const ids = [];
  const at = patch.modules.indexOf(m);
  const fresh = fx.map(e => { const id = newId({ modules: [...patch.modules, ...ids.map(i => ({ id: i }))] }, e.type); ids.push(id); return { id, type: e.type, params: { ...e.params }, ...(e.off ? { off: true } : {}) }; });
  patch.modules.splice(at, 1, ...fresh);
  const ins = patch.audio.filter(c => c.to === m.id), outs = patch.audio.filter(c => c.from === m.id);
  patch.audio = patch.audio.filter(c => c.to !== m.id && c.from !== m.id);
  if (fresh.length) {
    patch.audio.push(...ins.map(c => ({ from: c.from, to: ids[0] })), ...ids.slice(1).map((id, k) => ({ from: ids[k], to: id })), ...outs.map(c => ({ from: ids.at(-1), to: c.to })));
  } else patch.audio.push(...ins.flatMap(i => outs.map(o => ({ from: i.from, to: o.to }))));
  patch.cc = Object.fromEntries(Object.entries(patch.cc).filter(([, t]) => !t.startsWith(`${m.id}.`)));
  viewSel = null;
  changed({ rebuild: true });
  renderModules();
  toast(`Unpacked ${m.rack.name} into ${ids.join(', ') || 'nothing'}.${m.params.mix < 1 || m.params.level !== 1 ? ' Its Mix and Level aren\'t kept.' : ''} ⌘Z puts the rack back.`);
}
function rackHTML(m) {
  const fx = m.rack.modules;
  const prm = (k, e, spec) => {
    const v = e.params[spec.key], a = `data-id="${m.id}" data-k="${k}" data-key="${spec.key}"`, help = spec.help ? ` title="${esc(spec.help)}"` : '';
    if (spec.kind === 'file') return fileHTML(spec, v, `data-act="rack-file" ${a}`, help);
    if (spec.kind === 'choice') return choiceHTML(spec, v, `data-act="rack-choice" ${a}`, help);
    return `<div class="prm"${help}><label>${spec.label}</label><input type="range" min="0" max="1000" step="1" value="${Math.round(toSlider(spec, v) * 1000)}" data-act="rack-num" ${a}>
      <span class="val">${esc(formatValue(spec, v))}</span></div>`;
  };
  return `<div class="rack">
    <div class="rack-head"><b>${esc(m.rack.name)}</b><span class="hint">${fx.length ? fx.map(e => MODULES[e.type].label).join(' → ') : 'empty'}</span><span class="spacer"></span>
      <button class="ghost small" data-act="rack-save" data-id="${m.id}" title="Save these effects as a rack (to update the saved one, keep its name)">Save rack…</button>
      <button class="ghost small" data-act="rack-unpack" data-id="${m.id}" title="Turn the rack back into separate modules, connected the same way">Unpack</button></div>
    ${fx.map((e, k) => `<div class="rack-fx${e.off ? ' is-off' : ''}">
      <div class="rack-fx-head"><button class="power-btn${e.off ? ' is-off' : ''}" data-act="rack-power" data-id="${m.id}" data-k="${k}" title="${e.off ? 'Bypassed: click to switch it back on' : 'Bypass this effect'}">${uiIcon('power')}</button>
        <b>${k + 1}. ${MODULES[e.type].label}</b><span class="spacer"></span>
        <button class="ghost small" data-act="rack-move" data-id="${m.id}" data-k="${k}" data-d="-1" ${k ? '' : 'disabled'} title="Earlier in the chain">↑</button>
        <button class="ghost small" data-act="rack-move" data-id="${m.id}" data-k="${k}" data-d="1" ${k < fx.length - 1 ? '' : 'disabled'} title="Later in the chain">↓</button>
        <button class="ghost small x" data-act="rack-del" data-id="${m.id}" data-k="${k}" title="Remove this effect from the rack">✕</button></div>
      <div class="prms">${visibleParams(e).map(spec => prm(k, e, spec)).join('')}</div></div>`).join('')}
    ${fx.length < MAX_RACK ? `<label class="field rack-add">Add an effect <select data-act="rack-add" data-id="${m.id}"><option value="">…</option>${RACK_EFFECTS.map(t => `<option value="${t}">${MODULES[t].label}</option>`).join('')}</select></label>` : ''}
  </div>`;
}
function rackClick(el) {
  const m = modOf(el.dataset.id), k = +el.dataset.k, e = m?.rack?.modules[k];
  switch (el.dataset.act) {
    case 'rack-save': saveRack(m.rack.modules, m.rack.name); return true;
    case 'rack-unpack': unpackRack(m); return true;
    case 'rack-power': if (e.off) delete e.off; else e.off = true; changed({ rebuild: true }); renderModules(); return true;
    case 'rack-del': m.rack.modules.splice(k, 1); changed({ rebuild: true }); renderModules(); return true;
    case 'rack-move': {
      const j = k + +el.dataset.d, list = m.rack.modules;
      if (j < 0 || j >= list.length) return true;
      [list[k], list[j]] = [list[j], list[k]];
      changed({ rebuild: true });
      renderModules();
      return true;
    }
    case 'rack-choice': {
      const spec = paramOf(e.type, el.dataset.key);
      e.params[spec.key] = el.dataset.v;
      if (spec.rebuild) changed({ rebuild: true }); else { synth.setParam(m.id, `${k}.${spec.key}`, el.dataset.v); changed(); }
      renderModules();
      return true;
    }
  }
  return false;
}
$('#save-rack').onclick = () => saveRack(effectChain(), `${patch.name} FX`);

$('#inst-name').addEventListener('change', e => { patch.name = e.target.value.trim().slice(0, 40) || 'Untitled'; changed(); });
$('#voices').addEventListener('change', e => {
  patch.voices = Math.max(1, Math.min(16, Math.round(+e.target.value) || 8));
  synth.setPatch(patch);
  changed();
});
// Play mode and glide (glide's slider is squared: fine control of short glides).
$('#play-mode').addEventListener('click', e => {
  const b = e.target.closest('[data-play]');
  if (!b) return;
  if (b.dataset.play === 'poly') {
    delete patch.play;
    // Mono sounds often keep a voice count of 1 or 2 (unused while mono), which would leave
    // "Poly" playing one note at a time.
    if (patch.voices < 4) { toast(`Voices raised from ${patch.voices} to 8 so chords can sound (the Voices box beside Play).`); patch.voices = 8; }
  } else patch.play = b.dataset.play;
  synth.setPatch(patch);
  changed();
});
$('#glide').addEventListener('input', e => {
  const g = Math.round(2 * (+e.target.value / 1000) ** 2 * 1000) / 1000;
  if (g > 0) patch.glide = g; else delete patch.glide;
  synth.setPatch(patch);
  changed({ coalesce: true });
});
$('#volume').addEventListener('input', e => { patch.volume = +e.target.value; synth.setPatch(patch); changed({ coalesce: true }); });
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#panic').onclick = () => synth.allOff(true);
$('#learn').onclick = () => {
  learn = !learn;
  learnTarget = null;
  if (learn) toast('Click a setting\'s slider, then turn a knob on your controller.');
  renderModules();
};

// ---------------------------------------------------------------------------------------------
// Files: data/instruments/ at home, or this browser in the travel version (core/storage.js)

// Your recordings, for the Sample menus: the menus' options are updated in place (an open menu
// stays open), only when the list has changed.
async function refreshRecordings() {
  let list = [];
  try { list = await storage.list('audio'); } catch { /* none */ }
  if (list.map(r => r.file).join('|') === recordings.map(r => r.file).join('|')) return;
  recordings = list;
  document.querySelectorAll('select[data-act="file"], select[data-act="pad-file"]').forEach(sel => { sel.innerHTML = fileOptions(sel.value); });
}
channel?.addEventListener('message', e => { if (e.data?.type === 'recordings-changed') refreshRecordings(); });
// Tempo-synced LFOs and delays here follow the Sequencer's tempo.
channel?.addEventListener('message', e => { if (e.data?.type === 'seq-state' && e.data.bpm) synth.setTempo(e.data.bpm); });
channel?.postMessage({ type: 'get-seq-state' });
// Opening a Sample menu checks for new recordings first (made in another tab or window).
document.addEventListener('pointerdown', e => {
  if (e.target.closest('select[data-act="file"], select[data-act="pad-file"]')) refreshRecordings();
}, true);
async function refreshSaved() {
  try { saved = await storage.list('instruments'); } catch { saved = []; }
  renderLibrary();
}
const fileFor = name => `${stemOf(name)}.json`;

async function save() {
  await refreshSaved();
  const target = fileFor(patch.name);
  if (target !== fileName && saved.some(s => s.file === target) && !confirm(`An instrument already uses the file ${target}. Replace it?`)) return;
  try {
    const file = await storage.save('instruments', { ...patch, type: typeOf(patch) });
    fileName = file;
    factoryName = null;
    dirty = false;
    store.set('working', { patch, fileName, factoryName, dirty });
    renderFileBar();
    await refreshSaved();
    channel?.postMessage({ type: 'instruments-changed' });
    toast(`Saved to My Sounds (${placeOf('instruments', file)}). It's in the Sequencer's Sound list too.`, 'ok');
  } catch (err) {
    toast(`Couldn't save: ${err.message}.${STATIC ? '' : ' Is serve.py running?'}`, 'err');
  }
}
$('#save').onclick = save;
$('#delete').onclick = async () => {
  if (!fileName || !confirm(`${STATIC ? 'Delete' : 'Move'} "${patch.name}"${STATIC ? '' : ' to data/instruments/deleted/'}? It stays open here, unsaved.`)) return;
  try {
    await storage.remove('instruments', fileName);
    fileName = null;
    dirty = true;
    renderFileBar();
    await refreshSaved();
    channel?.postMessage({ type: 'instruments-changed' });
  } catch (err) { toast(`Couldn't delete: ${err.message}`, 'err'); }
};

// ---------------------------------------------------------------------------------------------
// Playing: MIDI in, the on-screen keyboard and the computer keyboard

const down = new Map(); // note -> source ('midi', 'kbd', 'key')
let sustain = false;
const sustained = new Set();

function noteOn(note, vel) {
  wake();
  sustained.delete(note);
  synth.noteOn(note, vel, ac.currentTime);
  reportSound({ kind: 'lab', name: patch.name, patch });
  down.set(note, true);
  scopeNote = note;
  startScopes();
  flashPad(note);
  for (const m of patch.modules) if (m.zones) drawSample(m);
  document.querySelector(`#kbd [data-n="${note}"]`)?.classList.add('on');
}
function noteOff(note) {
  if (!down.has(note)) return;
  down.delete(note);
  document.querySelector(`#kbd [data-n="${note}"]`)?.classList.remove('on');
  if (sustain) sustained.add(note); else synth.noteOff(note, ac.currentTime);
}

const onScreen = () => !window.frameElement || !window.frameElement.hidden;
let midi = null;
function onMidi(e) {
  const d = e.data, type = d[0] & 0xf0;
  if (type === 0x90 && d[2] > 0) flashLed();
  if (!onScreen()) return; // keys played in the other views aren't for the Lab
  if (type === 0x90 && d[2] > 0) noteOn(d[1], d[2]);
  else if (type === 0x80 || type === 0x90) noteOff(d[1]);
  else if (type === 0xe0) synth.setBend((((d[2] << 7) | d[1]) - 8192) / 8192);
  else if (type === 0xb0) onCC(d[1], d[2]);
}
function onCC(cc, v) {
  if (cc === 67) { synth.setPedal('soft', v >= 64); return; } // the soft pedal: una corda
  if (cc === 64) {
    sustain = v >= 64;
    synth.setPedal('sustain', sustain);
    if (!sustain) { for (const n of sustained) synth.noteOff(n, ac.currentTime); sustained.clear(); }
    return;
  }
  if (learn && learnTarget) {
    for (const [k, t] of Object.entries(patch.cc)) if (t === learnTarget) delete patch.cc[k];
    patch.cc[cc] = learnTarget;
    toast(`Knob CC ${cc} now turns ${targetLabel(learnTarget)}.`, 'ok');
    learnTarget = null;
    learn = false;
    changed();
    renderModules();
    return;
  }
  if (cc === 1) synth.setWheel(v / 127);
  const target = patch.cc[cc];
  if (!target) return;
  const [id, key] = target.split('.'), m = modOf(id), spec = m && paramOf(m.type, key);
  if (!spec) return;
  const val = fromSlider(spec, v / 127);
  m.params[key] = val;
  synth.setParam(id, key, val);
  refreshShape(m);
  const row = document.querySelector(`.prm[data-target="${target}"]`);
  if (row) { row.querySelector('input').value = Math.round(toSlider(spec, val) * 1000); row.querySelector('.val').textContent = formatValue(spec, val); }
  changed({ coalesce: true });
}
let ledTimer = null;
function flashLed() {
  const led = $('#keys-led');
  led.className = 'keys-led ok';
  clearTimeout(ledTimer);
  ledTimer = setTimeout(() => { led.className = 'keys-led'; }, 300);
}

const inputs = () => (midi ? [...midi.inputs.values()].filter(p => p.state !== 'disconnected') : []);
function wireMidi() {
  const ins = inputs();
  if (!prefs.keysIn || !ins.some(p => p.name === prefs.keysIn)) {
    // Prefer a controller keyboard (the MPK mini) over the XL's own ports.
    const guess = ins.find(p => /mpk|akai/i.test(p.name)) || ins.find(p => !/microKORG|SOUND|KBD|MIDI (IN|OUT)$/i.test(p.name)) || ins[0];
    if (guess) { prefs.keysIn = guess.name; savePrefs(); }
  }
  for (const p of ins) { p.onmidimessage = p.name === prefs.keysIn ? onMidi : null; if (p.name === prefs.keysIn) p.open?.().catch(() => {}); }
  $('#keys-in').innerHTML = `<option value="">— none —</option>${ins.map(p => `<option value="${esc(p.name)}">${esc(portLabel(p))}</option>`).join('')}`;
  $('#keys-in').value = prefs.keysIn || '';
}
async function initMidi() {
  if (new URLSearchParams(location.search).has('sim')) await import('../../tools/fakesynth.js');
  const blocked = why => {
    $('#keys-in').innerHTML = `<option value="">${why}</option>`;
    $('#keys-in').title = 'Allow MIDI for this site in Chrome (the icon at the left of the address bar), then reload';
  };
  if (!navigator.requestMIDIAccess) { blocked('No Web MIDI (use Chrome)'); return; }
  // Ask the way the editor and sequencer do (with SysEx), so the permission you already gave
  // them covers this page too; Chrome treats plain MIDI as a separate permission.
  try { midi = await navigator.requestMIDIAccess({ sysex: true }); } catch {
    try { midi = await navigator.requestMIDIAccess(); } catch {
      blocked('MIDI blocked');
      toast('Chrome blocked MIDI for the Lab. Allow MIDI for this site (the icon at the left of the address bar) and reload. The on-screen and computer keyboards still work.', 'err');
      return;
    }
  }
  midi.onstatechange = () => { wireMidi(); renderLibrary(); };
  wireMidi();
  renderLibrary();
}
$('#keys-in').onchange = e => { prefs.keysIn = e.target.value || null; savePrefs(); wireMidi(); };

// On-screen keyboard: two octaves from the base note.
function renderKbd() {
  const keys = [];
  let white = 0;
  const base = qwertyBase();
  for (let n = base; n <= base + 24; n++) {
    const black = [1, 3, 6, 8, 10].includes(n % 12);
    if (black) keys.push(`<div class="b" data-n="${n}" style="left:${white * 22 - 7}px"></div>`);
    else { keys.push(`<div class="w" data-n="${n}">${n % 12 === 0 ? `<span class="lbl">${noteName(n)}</span>` : ''}</div>`); white++; }
  }
  $('#kbd').innerHTML = keys.join('');
}
$('#kbd').addEventListener('pointerdown', e => {
  const k = e.target.closest('[data-n]');
  if (!k) return;
  const n = +k.dataset.n;
  noteOn(n, 100);
  // Capture keeps these too (MIDI and the computer keyboard reach it by themselves).
  const played = d => channel?.postMessage({ type: 'played', data: d, wall: performance.timeOrigin + performance.now() });
  played([0x90, n, 100]);
  const up = () => { noteOff(n); played([0x80, n, 0]); removeEventListener('pointerup', up); };
  addEventListener('pointerup', up);
});
$('#oct-up').onclick = () => { setQwertyBase(Math.min(96, qwertyBase() + 12)); renderKbd(); };
$('#oct-down').onclick = () => { setQwertyBase(Math.max(12, qwertyBase() - 12)); renderKbd(); };

// Shortcuts. (Note keys are the computer keyboard, below: they never reach these.)
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (e.target.closest?.('input:not([type=range]), select, textarea')) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod || e.altKey || e.repeat) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && viewSel) { e.preventDefault(); deleteSelected(); return; }
  if (e.key === 'Escape' && viewSel) { viewSel = null; renderView(); return; }
});

// The computer keyboard (core/qwerty.js): A–K and the row above, Z / X for octaves. Played here,
// or in the Recorder panel over the Lab; the Recorder captures it too.
const qwertyNote = d => {
  const type = d[0] & 0xf0;
  if (type === 0xb0) onCC(d[1], d[2]); // Caps Lock = the sustain pedal
  else if (type === 0x90 && d[2] > 0) noteOn(d[1], d[2]);
  else noteOff(d[1]);
};
attachQwerty({ active: onScreen, onMessage: qwertyNote, channel, from: 'lab', onOctave: renderKbd, onMode: text => toast(text) });
channel?.addEventListener('message', e => { if (e.data?.type === 'qwerty' && e.data.from === 'recorder' && onScreen()) qwertyNote(e.data.data); });

// ---------------------------------------------------------------------------------------------
// Start

{
  const w = store.get('working', null);
  let ok = false;
  if (w?.patch) { try { load(w.patch, w.fileName || null, !!w.dirty, w.factoryName || null); ok = true; } catch { /* start fresh */ } }
  if (!ok) { const first = FACTORY.find(p => p.name === 'Analog Brass'); load(copyPatch(first), null, false, first.name); }
  renderKbd();
  if (prefs.viewOpen) drawOutput(false);
  showAudio();
  refreshSaved();
  refreshRecordings();
  initMidi();
}
