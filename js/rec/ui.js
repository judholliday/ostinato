// The Capture tab (recorder.html): keeps everything played for an hour (the chosen MIDI input, the
// computer keyboard on any page, the Sound Lab's on-screen keys),
// split into takes, and records performances with the sequencer. It makes no sound itself: the
// sequencer plays takes back on its selected track, and receives takes into patterns, through the
// shared BroadcastChannel('mkxl'):
//   from the sequencer:  transport { playing, anchor: { wall, tick, bpm }, run } · seq-state { track, mode, songBars, bpm }
//                        performance { state: 'start' | 'end', wall } · take-result { text, ok }
//                        sounding { wall, sound } (what the keyboard played on: core/sounding.js) · program (the XL editor's sound)
//   to the sequencer:    get-seq-state · audition-take { notes, sound, at, loopMs } · stop-audition
//                        take-to-track { items, fromBar, bpm, synced, ti, pattern, sound }
//                        set-tempo { bpm } · record-performance { bars, countIn } · stop-sequencer
//                        print-stem { ti, tail }  (answered by stem { state: 'start' | 'end', wall, ms })
import * as C from '../seq/capture.js';
import { TICKS_PER_BEAT } from '../seq/model.js';
import { writeMidi } from '../seq/midifile.js';
import { portLabel, looksLikeSynthOut, looksLikeSynthIn } from '../core/midiports.js';
import { soundKey } from '../core/sounding.js';
import { initEditor, wireEditor, openTake, openClip, editing, editorKey, refreshEditor, closeEditor, editorMessage } from './editor.js';
import { AudioIn, cut, encodeWav, findOnset } from './audio.js';
import { notesToSample, zonesFor, tidy, releaseTime, makeLoop, buildPatch, noteName } from './sampleinst.js';
import { storage, placeOf } from '../core/storage.js';
import { STATIC } from '../core/mode.js';
import { QWERTY, QWERTY_LABEL, attachQwerty } from '../core/qwerty.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`mkxl.rec.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`mkxl.rec.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};
function toast(text, kind = '') {
  const el = Object.assign(document.createElement('div'), { className: `toast ${kind}`, textContent: text });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}
const prefs = { midiIn: null, perfLen: 'song', countIn: true, perfAudio: false, audioIn: null, ...store.get('prefs', {}) };
// Per audio device: which input to record ('0', '1' or 'both') and its measured delay (ms).
prefs.devices ||= {};
const dev = () => (prefs.devices[prefs.audioIn] ||= {});
let monoDevice = false;
const savePrefs = () => store.set('prefs', prefs);
const channel = new BroadcastChannel('mkxl');

// ---------------------------------------------------------------------------------------------
// What the sequencer is doing

let transport = { playing: false, anchor: null, run: 0 };
let seq = null; // { track: { name, pattern, rate, mode, ch }, mode, songBars, bpm }
let perf = null; // the performance being recorded: { start, end }

// The sequencer's song position at a wall-clock time (ms since 1970), while it plays.
function tickAt(wall) {
  const a = transport.anchor;
  return a.tick + (wall - a.wall) / (60000 / (a.bpm * TICKS_PER_BEAT));
}

channel.onmessage = e => {
  const m = e.data || {};
  editorMessage(m);
  // The computer keyboard played on another page (or here, below): captured like a MIDI keyboard.
  // The computer keyboard (any page) and the Sound Lab's on-screen keys are always captured, as
  // well as the MIDI keyboard chosen under Capture from.
  if (m.type === 'qwerty' || m.type === 'played') { captureEvent(m.data, m.wall - performance.timeOrigin); return; }
  if (m.type === 'transport') {
    transport = m;
    // Bar 1 of a performance being recorded with audio: where its audio file starts.
    if (perfAudio && !perfAudio.t0 && m.playing && m.anchor) perfAudio.t0 = m.anchor.wall - m.anchor.tick * 60000 / (m.anchor.bpm * TICKS_PER_BEAT);
    renderPerf();
  } else if (m.type === 'stem') onStem(m);
  else if (m.type === 'own-level') { if (isOwn()) showLevel(m.peak); }
  else if (m.type === 'recordings-changed') refreshRecordings();
  else if (m.type === 'seq-state') { seq = m; renderPerf(); renderTakes(); refreshEditor(); }
  else if (m.type === 'sounding') noteSound(m);
  else if (m.type === 'program' && Array.isArray(m.data)) {
    const was = xlNow?.name;
    xlNow = { kind: 'xl', name: String(m.name || 'XL sound'), data: m.data };
    if (was !== xlNow.name && !smp.running) { if (smp.name === `XL ${was || 'Sound'}`) smp.name = ''; renderSamplePanel(); }
  }
  else if (m.type === 'clips-changed') refreshClips();
  else if (m.type === 'performance') {
    if (m.state === 'start') { perf = { start: m.wall, end: Infinity }; cap.ranges.push({ ...perf, kind: 'performance' }); }
    else if (perf) { cap.ranges.at(-1).end = m.wall; perf = null; finishPerfAudio(m.wall); }
    saveSoon();
    renderPerf();
    renderTakes();
  } else if (m.type === 'take-result') toast(m.text, m.ok ? 'ok' : '');
};

// ---------------------------------------------------------------------------------------------
// Capture: every note, pedal and the times they happened (see seq/capture.js)

const KEEP_MS = 60 * 60 * 1000, MAX_EVENTS = 20000;
const cap = { events: [], ranges: [], bpm: new Map(), est: new Map(), auditioning: null };
{
  // Takes used to be kept by the sequencer page; bring them over once.
  const old = localStorage.getItem('mkxl.seq.capture');
  if (old && !localStorage.getItem('mkxl.rec.capture')) { localStorage.setItem('mkxl.rec.capture', old); localStorage.removeItem('mkxl.seq.capture'); }
  cap.events = store.get('capture', []);
  cap.ranges = store.get('ranges', []).map(r => ({ ...r, end: r.end ?? Infinity }));
  // A performance left open by a reload ends at its last note.
  for (const r of cap.ranges) if (r.end === Infinity) r.end = cap.events.at(-1)?.t ?? r.start;
}
// The sounds takes were played on: pages report what the keyboard plays through (sounding); the
// log says from when each was in use. Kept beside the capture, for as long as it.
const snd = { byKey: store.get('sounds', {}), log: store.get('soundlog', []) }; // log: [{ t, k }]
let xlNow = null; // the XL editor's sound: what the XL's own keys play
let soundTimer = null;
function noteSound(m) {
  if (!m.sound?.kind) return;
  const k = soundKey(m.sound);
  snd.byKey[k] = m.sound;
  if (snd.log.at(-1)?.k !== k) snd.log.push({ t: m.wall, k });
  clearTimeout(soundTimer);
  soundTimer = setTimeout(saveSounds, 1500);
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; renderTakes(); }, 400);
}
function saveSounds() {
  // Forget sounds older than the oldest captured note (keeping the one in use then).
  const oldest = cap.events[0]?.t ?? Date.now();
  const first = Math.max(0, snd.log.findLastIndex(e => e.t <= oldest));
  snd.log = snd.log.slice(first).slice(-500);
  const used = new Set(snd.log.map(e => e.k));
  for (const k of Object.keys(snd.byKey)) if (!used.has(k)) delete snd.byKey[k];
  store.set('sounds', snd.byKey);
  store.set('soundlog', snd.log);
}
// A take's sound: the one in use when it started (reports can arrive just after the first note).
function takeSound(take) {
  let e = null;
  for (const x of snd.log) { if (x.t <= take.start + 500) e = x; else break; }
  e ||= snd.log.find(x => x.t <= take.end);
  if (e && snd.byKey[e.k]) return snd.byKey[e.k];
  const input = inputs().find(p => p.name === prefs.midiIn);
  return input && looksLikeSynthIn(input) ? xlNow : null;
}
const soundName = s => (!s ? '' : s.kind === 'xl' ? `${s.name} (XL)` : s.kind === 'lab' ? `${s.name} (Lab)` : s.name);

let saveTimer = null, renderTimer = null, endTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { store.set('capture', cap.events); store.set('ranges', cap.ranges.map(r => ({ ...r, end: r.end === Infinity ? null : r.end }))); }, 1000);
}

function captureEvent(d, at) {
  const type = d[0] & 0xf0;
  let e;
  if (type === 0x90 && d[2] > 0) e = { type: 'on', n: d[1], v: d[2] };
  else if (type === 0x80 || type === 0x90) e = { type: 'off', n: d[1], v: 0 };
  else if (type === 0xb0 && d[1] === 64) e = { type: 'ped', n: d[2] >= 64 ? 1 : 0, v: 0 };
  else return;
  e.t = Math.round(performance.timeOrigin + (at ?? performance.now()));
  if (transport.playing && transport.anchor) Object.assign(e, { tick: Math.round(tickAt(e.t) * 10) / 10, run: transport.run, bpm: transport.anchor.bpm });
  cap.events.push(e);
  const old = e.t - KEEP_MS;
  if (cap.events[0].t < old || cap.events.length > MAX_EVENTS) {
    cap.events = cap.events.filter(x => x.t >= old).slice(-MAX_EVENTS);
    cap.ranges = cap.ranges.filter(r => r.end >= old);
  }
  saveSoon();
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; renderTakes(); }, 400);
  clearTimeout(endTimer);
  endTimer = setTimeout(renderTakes, C.GAP_MS + 300); // the take is finished: show it as such
}

// Newest first. A take is still going (`live`) until the silence that ends it has passed.
const allTakes = () => C.splitTakes(C.notesOf(cap.events, Date.now()), C.GAP_MS, cap.ranges).reverse()
  .map(t => ({ ...t, live: t.open || (!t.kind && Date.now() - t.end < C.GAP_MS) })); // a performance ends when it stops
const findTake = id => allTakes().find(t => t.id === id);

// A take's tempo: the sequencer's when played along, else what you set, else a guess.
function takeBpm(take) {
  if (take.synced) return take.bpm;
  if (cap.bpm.has(take.id)) return cap.bpm.get(take.id);
  if (!take.live && cap.est.has(take.id)) return cap.est.get(take.id);
  const songBpm = seq?.bpm || 120, bpm = C.estimateTempo(take.notes, songBpm) ?? songBpm;
  if (!take.live) cap.est.set(take.id, bpm);
  return bpm;
}

// ---------------------------------------------------------------------------------------------
// Rendering

const ago = ms => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 10 ? 'just now' : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : 'an hour ago';
};
const clock = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const stamp = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`; };

function rollSVG(take) {
  const span = Math.max(1, take.end - take.start);
  const lo = Math.min(...take.notes.map(n => n.note)), hi = Math.max(...take.notes.map(n => n.note));
  const rows = Math.max(12, hi - lo + 1), top = hi + Math.floor((rows - (hi - lo + 1)) / 2);
  return `<svg class="roll" viewBox="0 0 1000 ${rows}" preserveAspectRatio="none" aria-hidden="true">${take.notes.map(n =>
    `<rect x="${((n.t - take.start) / span * 1000).toFixed(1)}" y="${top - n.note}" width="${Math.max(4, n.dur / span * 1000).toFixed(1)}" height="1"/>`).join('')}</svg>`;
}

function renderTakes() {
  countNews();
  const el = $('#takes');
  const takes = allTakes();
  const input = inputs().find(p => p.name === prefs.midiIn);
  $('#takes-sum').textContent = !prefs.midiIn || prefs.midiIn === QWERTY ? '· everything played on the computer keyboard (and the Sound Lab\'s keys) is kept for an hour; choose your MIDI keyboard under Capture from to keep that too'
    : `· everything played on ${prefs.midiIn === QWERTY ? '' : `${input ? portLabel(input) : prefs.midiIn} and `}the computer keyboard is kept for an hour`;
  if (el.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
  if (!takes.length) {
    el.innerHTML = '<div class="hint">Nothing yet. Play anything, in any view, with or without the sequencer, and it shows up here as a take.</div>';
    return;
  }
  el.innerHTML = takes.map(take => {
    const bpm = takeBpm(take), bars = C.takeBars(C.takeTicks(take, bpm)), sound = takeSound(take);
    const auditioning = cap.auditioning?.id === take.id;
    return `<div class="take${take.live ? ' live' : ''}${take.kind ? ' perf' : ''}" data-id="${take.id}">
      <div class="take-top"><button class="ghost play-take" data-act="play" title="${auditioning ? 'Stop' : `Play it on ${sound ? esc(soundName(sound)) : 'the sequencer\'s selected track'}`}">${auditioning ? '■' : '▶'}</button>
        <span class="roll-open" data-act="open" title="Open it in the editor">${rollSVG(take)}</span></div>
      <div class="take-info"><b>${take.live ? (take.kind ? 'Recording…' : 'Playing now…') : ago(take.end)}</b>
        · ${clock(take.end - take.start)} · ${take.notes.length} note${take.notes.length > 1 ? 's' : ''}
        · <span class="hint">${take.kind ? 'performance, ' : ''}${take.synced ? `played along at ${bpm} BPM` : 'free time'} · ${bars} bar${bars > 1 ? 's' : ''}</span></div>
      <div class="take-actions">
        <span class="take-sound hint" title="The sound it was played on">🔊 ${sound ? esc(soundName(sound)) : 'sound not known'}</span>
        <span class="spacer"></span>
        <button data-act="open" ${take.live ? 'disabled' : ''} title="See it all on a timeline: select part of it, loop it, save it as a clip or put it into a track">✎ Open</button>
        <button class="ghost" data-act="mid" title="Download this take as a MIDI file, as played (not quantized)">.mid</button>
        <button class="ghost small" data-act="del" title="Forget this take">✕</button>
      </div>
    </div>`;
  }).join('') + `<div class="hint">Open a take to pick out the part you want. <button class="ghost small" data-act="clear">Forget all</button></div>`;
}

// ---- clips: saved selections of takes (data/clips/, see editor.js) ----

let clips = [], clipPlaying = null;
async function refreshClips() {
  try { clips = await storage.list('clips'); } catch { clips = []; }
  renderClips();
}
function clipRoll(c) {
  const span = Math.max(1, c.length || 1), ns = c.notes.map(n => n.note);
  const lo = Math.min(...ns), hi = Math.max(...ns), rows = Math.max(12, hi - lo + 1), top = hi + Math.floor((rows - (hi - lo + 1)) / 2);
  return `<svg class="roll" viewBox="0 0 1000 ${rows}" preserveAspectRatio="none" aria-hidden="true">${c.notes.map(n =>
    `<rect x="${(n.pos / span * 1000).toFixed(1)}" y="${top - n.note}" width="${Math.max(4, n.len / span * 1000).toFixed(1)}" height="1"/>`).join('')}</svg>`;
}
function renderClips() {
  const el = $('#clips');
  if (!clips.length) { el.innerHTML = '<div class="hint">None yet. Open a take, select the part you want and save it as a clip.</div>'; return; }
  el.innerHTML = clips.map(c => {
    const bars = Math.round((c.length || 0) / (TICKS_PER_BEAT * 4) * 100) / 100;
    return `<div class="take clip" data-file="${esc(c.file)}">
      <div class="take-top"><button class="ghost play-take" data-act="play" title="${clipPlaying === c.file ? 'Stop' : `Play it on ${c.sound ? esc(soundName(c.sound)) : 'the sequencer\'s selected track'}`}">${clipPlaying === c.file ? '■' : '▶'}</button>
        <span class="roll-open" data-act="open" title="Open it in the editor">${clipRoll(c)}</span></div>
      <div class="take-info"><b>${esc(c.name)}</b> · ${bars} bar${bars === 1 ? '' : 's'} · ${c.bpm} BPM · ${c.notes.length} notes</div>
      <div class="take-actions"><span class="take-sound hint">🔊 ${c.sound ? esc(soundName(c.sound)) : 'no sound kept'}</span><span class="spacer"></span>
        <button data-act="open" title="Open it in the editor: loop it, trim it, rename it, put it into a track">✎ Open</button>
        <button class="ghost small" data-act="del" title="Remove this clip (moved to data/clips/deleted/)">✕</button></div>
    </div>`;
  }).join('');
}
$('#clips').addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'), c = clips.find(x => x.file === el?.closest('[data-file]')?.dataset.file);
  if (!c) return;
  if (el.dataset.act === 'open') openClip(c);
  else if (el.dataset.act === 'play') {
    channel.postMessage({ type: 'stop-audition' });
    clearTimeout(cap.auditionTimer);
    if (clipPlaying === c.file) clipPlaying = null;
    else {
      const ms = 60000 / (c.bpm * TICKS_PER_BEAT);
      channel.postMessage({ type: 'audition-take', sound: c.sound, notes: c.notes.map(n => ({ dt: n.pos * ms, dur: n.len * ms, note: n.note, vel: n.vel })) });
      clipPlaying = c.file;
      cap.auditionTimer = setTimeout(() => { clipPlaying = null; renderClips(); }, c.length * ms + 400);
    }
    renderClips();
  } else if (el.dataset.act === 'del') {
    if (!confirm(`Remove the clip "${c.name}"?`)) return;
    try { await storage.remove('clips', c.file); toast(`Removed "${c.name}".`); } catch (err) { toast(`Couldn't remove it: ${err.message}`, 'err'); }
    if (editing()?.src.file === c.file) closeEditor();
    refreshClips();
  }
});

function renderPerf() {
  const lens = [['song', seq?.mode === 'song' ? `The song (${seq.songBars} bars)` : 'The song sections'], ['4', '4 bars'], ['8', '8 bars'], ['16', '16 bars'], ['32', '32 bars'], ['open', 'Until I stop']];
  $('#perf-len').innerHTML = lens.map(([v, l]) => `<option value="${v}" ${v === prefs.perfLen ? 'selected' : ''}>${l}</option>`).join('');
  $('#perf-countin').checked = prefs.countIn;
  $('#perf-audio').checked = prefs.perfAudio;
  const go = $('#perf-go');
  go.textContent = perf ? '■ Stop' : '● Record';
  go.classList.toggle('on', !!perf);
  $('#perf-status').textContent = perf ? (transport.playing ? 'Recording with the sequencer. Everything you play now goes into one take.' : 'Counting in…')
    : '';
}

// ---------------------------------------------------------------------------------------------
// Actions

$('#takes').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'clear') {
    if (!confirm('Forget every captured take?')) return;
    cap.events = []; cap.ranges = []; saveSoon(); renderTakes();
    return;
  }
  const id = +el.closest('[data-id]')?.dataset.id, take = findTake(id);
  if (!take) return;
  const bpm = takeBpm(take);
  switch (el.dataset.act) {
    case 'play':
      if (cap.auditioning?.id === id) { channel.postMessage({ type: 'stop-audition' }); cap.auditioning = null; clearTimeout(cap.auditionTimer); }
      else {
        channel.postMessage({ type: 'audition-take', sound: takeSound(take), notes: take.notes.map(n => ({ dt: n.t - take.start, dur: n.dur, note: n.note, vel: n.vel })) });
        cap.auditioning = { id };
        clearTimeout(cap.auditionTimer);
        cap.auditionTimer = setTimeout(() => { cap.auditioning = null; renderTakes(); }, take.end - take.start + 300);
      }
      break;
    case 'open': if (!take.live) openTake(take); break;
    case 'mid':
      download(writeMidi({ name: 'Captured take', bpm, tracks: [{ name: 'Take', ch: seq?.track?.ch || 1, notes: C.takeMidiNotes(take, bpm) }] }), `Take ${stamp(take.start)}.mid`);
      break;
    case 'del':
      cap.events = cap.events.filter(x => x.t < take.start || x.t > take.end);
      cap.ranges = cap.ranges.filter(r => r.start !== take.id);
      saveSoon();
      break;
  }
  renderTakes();
});
function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$('#perf-len').onchange = e => { prefs.perfLen = e.target.value; savePrefs(); };
$('#perf-countin').onchange = e => { prefs.countIn = e.target.checked; savePrefs(); };
$('#perf-audio').onchange = e => { prefs.perfAudio = e.target.checked; savePrefs(); };
$('#perf-go').onclick = () => {
  if (perf) { channel.postMessage({ type: 'stop-sequencer' }); return; }
  const bars = prefs.perfLen === 'song' ? 'song' : prefs.perfLen === 'open' ? null : +prefs.perfLen;
  if (prefs.perfAudio && !audioReady()) { toast('Choose an audio input first (Audio in), or untick Record audio too.'); return; }
  if (prefs.perfAudio && !isOwn()) {
    audio.record();
    perfAudio = { t0: null };
  }
  channel.postMessage({ type: 'record-performance', bars, countIn: prefs.countIn, ownAudio: prefs.perfAudio && isOwn() });
};

addEventListener('keydown', e => { if (editorKey(e)) e.preventDefault(); });

// New takes while another tab shows: a count on the Capture tab (core/topbar.js) until you look.
let showing = false, seenTakes = null, news = 0;
const finishedTakes = () => allTakes().filter(t => !t.live).length;
function postNews() { channel.postMessage({ type: 'capture-news', count: news }); }
addEventListener('message', e => {
  if (e.origin !== location.origin || e.data?.type !== 'view') return;
  showing = e.data.view === 'capture';
  if (showing && news) { news = 0; postNews(); }
  seenTakes = finishedTakes();
});
parent.postMessage({ type: 'view-hello' }, location.origin);
function countNews() {
  const n = finishedTakes();
  if (seenTakes !== null && n > seenTakes && !showing) { news += n - seenTakes; postNews(); }
  seenTakes = n;
}

// ---------------------------------------------------------------------------------------------
// MIDI in

let midi = null;
const inputs = () => (midi ? [...midi.inputs.values()].filter(p => p.state !== 'disconnected') : []);
let ledTimer = null;
function onMidi(e) {
  const d = e.data;
  if ((d[0] & 0xf0) === 0x90 && d[2] > 0) {
    $('#led').className = 'keys-led ok';
    clearTimeout(ledTimer);
    ledTimer = setTimeout(() => { $('#led').className = 'keys-led'; }, 300);
  }
  captureEvent(d, e.timeStamp);
}
function wireMidi() {
  const ins = inputs();
  // Chosen for you (not by you): the computer keyboard when no MIDI keyboard was there. That
  // gives way to a real keyboard as soon as one is connected. (Old settings without the flag
  // count as chosen for you.)
  const auto = prefs.midiInAuto !== false;
  if (!prefs.midiIn || (prefs.midiIn !== QWERTY && !ins.some(p => p.name === prefs.midiIn)) || (prefs.midiIn === QWERTY && auto && ins.length)) {
    // What the sequencer listens to, else a controller keyboard (the MPK mini), else the first;
    // with no MIDI keyboard at all, the computer keyboard.
    const seqIn = (() => { try { return JSON.parse(localStorage.getItem('mkxl.seq.prefs'))?.keysIn; } catch { return null; } })();
    const guess = ins.find(p => p.name === seqIn) || ins.find(p => /mpk|akai/i.test(p.name)) || ins[0];
    const next = guess ? guess.name : QWERTY;
    if (next !== prefs.midiIn && prefs.midiIn) toast(`Capturing from ${guess ? portLabel(guess) : QWERTY_LABEL} now.`);
    prefs.midiIn = next;
    prefs.midiInAuto = true;
    savePrefs();
  }
  // Every input is listened to: the chosen one is captured; notes from another show a prompt.
  for (const p of ins) { p.onmidimessage = p.name === prefs.midiIn ? onMidi : e => otherNote(p, e); p.open?.().catch(() => {}); }
  $('#midi-in').innerHTML = `<option value="">— none —</option>${ins.map(p => `<option value="${esc(p.name)}">${esc(portLabel(p))}</option>`).join('')}`
    + `<option value="${QWERTY}">${QWERTY_LABEL}</option>`;
  $('#midi-in').value = prefs.midiIn || '';
  renderTakes();
  renderPerf();
}
async function initMidi() {
  if (new URLSearchParams(location.search).has('sim')) await import('../../tools/fakesynth.js');
  // Without Web MIDI (or with it blocked), the computer keyboard still works.
  if (!navigator.requestMIDIAccess) { wireMidi(); return; }
  try { midi = await navigator.requestMIDIAccess({ sysex: true }); } catch {
    try { midi = await navigator.requestMIDIAccess(); } catch { wireMidi(); return; }
  }
  midi.onstatechange = wireMidi;
  wireMidi();
}
$('#midi-in').onchange = e => { prefs.midiIn = e.target.value || null; prefs.midiInAuto = false; savePrefs(); $('#other-in').hidden = true; wireMidi(); };
// Notes from a keyboard Capture isn't listening to: offer to capture from it instead.
function otherNote(port, e) {
  if ((e.data[0] & 0xf0) !== 0x90 || !e.data[2]) return;
  const b = $('#other-in');
  b.hidden = false;
  b.dataset.port = port.name;
  b.textContent = `♪ Notes from ${portLabel(port)}: capture from it`;
  b.title = `You're playing ${portLabel(port)}, but Capture is listening to ${prefs.midiIn === QWERTY ? 'the computer keyboard' : prefs.midiIn || 'nothing'}. Click to capture from ${portLabel(port)}.`;
}
$('#other-in').onclick = e => {
  prefs.midiIn = e.target.dataset.port;
  prefs.midiInAuto = false;
  savePrefs();
  e.target.hidden = true;
  wireMidi();
  toast(`Capturing from ${$('#midi-in').selectedOptions[0]?.textContent || prefs.midiIn}.`, 'ok');
};


// ---------------------------------------------------------------------------------------------
// Audio: the interface input (e.g. the Scarlett's input 2, where the XL is), recordings saved to
// data/audio/ through serve.py.

const audio = new AudioIn({ onLevel: showLevel });
// "Ostinato (what it plays)": the sequencer records its own mix (no microphone); we just steer it.
const OWN = '__own';
const isOwn = () => prefs.audioIn === OWN;
const audioReady = () => audio.open || isOwn();
let freeRec = null, perfAudio = null, stems = null, stemWait = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wallToPerf = wall => wall - performance.timeOrigin;
const latency = () => (prefs.audioIn ? dev().latency ?? 0 : 0);
const latencyUnknown = () => !prefs.audioIn || dev().latency === undefined;

let levelShown = 0, peakHold = 0, clipUntil = 0;
function showLevel(peak) {
  const now = performance.now();
  if (peak >= 0.98) clipUntil = now + 1500;
  peakHold = Math.max(peak, peakHold * 0.9);
  if (now - levelShown < 50) return;
  levelShown = now;
  const db = 20 * Math.log10(Math.max(peakHold, 1e-5)), x = Math.max(0, Math.min(1, (db + 60) / 60));
  const bar = $('#meter-bar');
  bar.style.width = `${x * 100}%`;
  bar.style.background = db > -1 ? 'var(--err)' : db > -6 ? 'var(--warn)' : 'var(--ok)';
  $('#meter-bar').parentElement.classList.toggle('clip', now < clipUntil);
  $('#meter-db').textContent = peakHold < 1e-4 ? 'silent' : `${db.toFixed(0)} dB${now < clipUntil ? ' · too loud!' : ''}`;
}

async function fillDevices() {
  let list = [];
  try { list = await AudioIn.devices(); } catch { /* no media devices */ }
  const named = list.some(d => d.label);
  const sel = $('#audio-in');
  sel.innerHTML = `<option value="">— off —</option><option value="${OWN}">Ostinato (what it plays)</option>` + (named
    ? list.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Audio input')}</option>`).join('')
    : `<option value="ask">Allow audio input…</option>`);
  sel.value = isOwn() ? OWN : prefs.audioIn && list.some(d => d.deviceId === prefs.audioIn) ? prefs.audioIn : '';
  showChannel();
  return list;
}

async function useAudio(id) {
  if (isOwn() && id !== OWN) channel.postMessage({ type: 'own-audio', cmd: 'monitor', on: false });
  if (!id) { audio.stop(); prefs.audioIn = null; savePrefs(); showLevel(0); renderAudio(); return; }
  if (id === OWN) {
    audio.stop();
    prefs.audioIn = OWN;
    savePrefs();
    channel.postMessage({ type: 'own-audio', cmd: 'monitor', on: true });
    await fillDevices();
    renderAudio();
    return;
  }
  try {
    if (id === 'ask') {
      // First time: ask for permission, then pick the Scarlett if there is one.
      await audio.start(null);
      const list = await fillDevices();
      const pick = list.find(d => /scarlett|focusrite|2i2/i.test(d.label)) || list[0];
      id = pick?.deviceId || null;
    }
    const info = await audio.start(id);
    prefs.audioIn = id;
    // A one-channel input (the Mac's microphone, a headset) records that channel; a new
    // interface starts on input 2 if it's a Scarlett (where the XL is), else input 1.
    monoDevice = info.channels < 2;
    if (monoDevice) dev().ch = '0';
    else {
      const label = (await AudioIn.devices()).find(d => d.deviceId === id)?.label || info.label;
      dev().ch ||= /scarlett|focusrite|2i2/i.test(label) ? '1' : '0';
    }
    savePrefs();
    audio.channel = dev().ch === 'both' ? 'both' : +dev().ch;
  } catch (err) {
    prefs.audioIn = null;
    savePrefs();
    toast(err.name === 'NotAllowedError'
      ? 'Chrome blocked the audio input. Allow the microphone for this site (the icon at the left of the address bar) and try again.'
      : `Couldn't open the audio input: ${err.message}`, 'err');
  }
  await fillDevices();
  renderAudio();
}
$('#audio-in').onchange = e => useAudio(e.target.value);
$('#audio-ch').onchange = e => {
  dev().ch = e.target.value;
  savePrefs();
  audio.channel = dev().ch === 'both' ? 'both' : +dev().ch;
};
function showChannel() {
  const sel = $('#audio-ch');
  sel.innerHTML = monoDevice ? '<option value="0">1 (mono)</option>'
    : '<option value="1">2 (right)</option><option value="0">1 (left)</option><option value="both">1 + 2 (stereo)</option>';
  sel.value = monoDevice ? '0' : (prefs.audioIn && dev().ch) || '1';
  sel.disabled = !prefs.audioIn || monoDevice || isOwn();
}

function renderAudio() {
  const on = audioReady();
  $('#audio-rec').disabled = !on || !!stems;
  $('#audio-rec').textContent = freeRec ? '■ Stop' : '● Record audio';
  $('#audio-rec').classList.toggle('on', !!freeRec);
  // Delay and stems are about the XL coming back in through an interface.
  $('#measure').disabled = !audio.open || !!freeRec || !!stems;
  $('#stems').disabled = !audio.open || !!freeRec;
  $('#stems').textContent = stems ? '■ Stop printing' : 'Print stems';
  const l = prefs.audioIn ? dev().latency : undefined;
  $('#latency').textContent = l === undefined ? 'delay not measured yet' : `delay ${l.toFixed(1)} ms`;
  showChannel();
  if (!on) $('#meter-db').textContent = 'off';
  else if (isOwn()) $('#meter-db').textContent = 'plays when Ostinato does';
}

async function saveWav(chans, name) {
  if (!chans?.[0]?.length) { toast('Nothing was recorded.'); return; }
  const wav = encodeWav(chans, audio.sampleRate);
  try {
    const file = await storage.save('audio', wav, name);
    toast(`Saved to ${placeOf('audio', file)}. It's in the Sound Lab's Sample menus (Sampler, Granular, drum pads) too.`, 'ok');
    channel.postMessage({ type: 'recordings-changed' }); // so the other tabs' menus list it
  } catch (err) {
    toast(`Couldn't save the recording: ${err.message}.${STATIC ? '' : ' Is serve.py running?'}`, 'err');
  }
  refreshRecordings();
}

// Free recording: from ● to ■.
$('#audio-rec').onclick = async () => {
  if (freeRec) {
    clearInterval(freeRec.timer);
    freeRec = null;
    $('#audio-time').textContent = '';
    renderAudio();
    if (isOwn()) { channel.postMessage({ type: 'own-audio', cmd: 'stop' }); return; } // the sequencer saves it
    const name = `Recording ${stamp(Date.now())}`, r = await audio.finish();
    if (r) saveWav(r.chans, name);
    return;
  }
  if (isOwn()) channel.postMessage({ type: 'own-audio', cmd: 'start' }); else audio.record();
  const start = performance.now();
  freeRec = { timer: setInterval(() => { $('#audio-time').textContent = `recording ${clock(performance.now() - start)}`; }, 250) };
  renderAudio();
};

// A performance with audio: the file starts at bar 1 (the delay applied) and runs to the end
// plus a moment for the last notes to fade.
function finishPerfAudio(endWall) {
  if (!perfAudio) return;
  const p = perfAudio;
  perfAudio = null;
  setTimeout(async () => {
    const r = await audio.finish();
    if (!r || !p.t0) return;
    const sr = audio.sampleRate, from = audio.frameAt(wallToPerf(p.t0) + latency());
    saveWav(cut(r, from, Math.round((endWall - p.t0 + 1500) / 1000 * sr)), `Performance ${stamp(p.t0)}`);
  }, 1600);
}

// Measure delay: one note to the XL, timed from leaving here to its sound arriving.
$('#measure').onclick = async () => {
  const out = midi && [...midi.outputs.values()].find(p => p.state !== 'disconnected' && looksLikeSynthOut(p));
  if (!out) { toast('The XL isn\'t connected (no SOUND port).'); return; }
  const ch = (seq?.xlTracks?.[0]?.ch || 2) - 1;
  $('#latency').textContent = 'measuring…';
  audio.record();
  const at = performance.now() + 400;
  out.send([0x90 | ch, 60, 120], at);
  out.send([0x80 | ch, 60, 0], at + 250);
  await sleep(1300);
  const r = await audio.finish();
  const onset = r ? findOnset(r.chans, audio.frameAt(at) - r.frame - Math.round(audio.sampleRate * 0.002)) : -1;
  const ms = onset < 0 ? NaN : audio.perfAt(r.frame + onset) - at;
  if (!(ms > 0 && ms < 300)) {
    toast('No clear note came back. Check the XL is on the chosen input and its sound starts quickly, then try again.', 'err');
  } else {
    dev().latency = Math.round(ms * 10) / 10;
    savePrefs();
    toast(`Delay ${dev().latency} ms for this input: recordings will be lined up by this much.`, 'ok');
  }
  renderAudio();
};

// ---- Sample the XL: its current sound, note by note, into a multi-sample Ostinato Synth sound ----

const smp = { lo: 36, hi: 84, step: 4, vel: 100, hold: 2.5, tail: 1.5, loop: true, name: '', running: null };
const xlOut = () => midi && [...midi.outputs.values()].find(p => p.state !== 'disconnected' && looksLikeSynthOut(p));
function renderSamplePanel() {
  const el = $('#sample-panel');
  if (el.hidden) return;
  if (smp.running) {
    el.innerHTML = `<div class="audio-row"><b>${esc(smp.running.status)}</b><span class="spacer"></span><button class="ghost small" data-smp="cancel">■ Stop</button></div>
      <div class="meter"><i style="width:${Math.round(smp.running.done / smp.running.total * 100)}%"></i></div>`;
    return;
  }
  const notes = notesToSample(smp.lo, smp.hi, smp.step), secs = notes.length * (smp.hold + smp.tail + 0.6);
  const keys = Array.from({ length: 73 }, (_, k) => k + 24);
  const noteSel = (key, v) => `<select data-smp="${key}">${keys.map(n => `<option value="${n}" ${n === v ? 'selected' : ''}>${noteName(n)}</option>`).join('')}</select>`;
  const ready = audio.open && !isOwn(), out = xlOut();
  smp.name ||= `XL ${xlNow?.name || 'Sound'}`.trim();
  el.innerHTML = `
    <div class="audio-row"><span>Sound on the XL now: <b>${esc(xlNow?.name || 'whatever it\'s set to')}</b></span>
      <span class="hint">Choose it in the Sound Lab or on the XL first. Arpeggiator off, ideally.</span></div>
    <div class="audio-row">
      <label class="field">Name <input data-smp="name" value="${esc(smp.name)}" maxlength="40"></label>
      <label class="field">From ${noteSel('lo', smp.lo)}</label><label class="field">to ${noteSel('hi', smp.hi)}</label>
      <label class="field" title="Fewer semitones apart: more recordings, each stretched less">every <select data-smp="step">${[2, 3, 4, 6, 12].map(n => `<option value="${n}" ${n === smp.step ? 'selected' : ''}>${n}</option>`).join('')}</select> semitones</label>
    </div>
    <div class="audio-row">
      <label class="field">Velocity <input type="number" data-smp="vel" min="1" max="127" value="${smp.vel}"></label>
      <label class="field" title="How long each key is held">Hold <input type="number" data-smp="hold" min="0.3" max="10" step="0.1" value="${smp.hold}"> s</label>
      <label class="field" title="How long to keep recording after the key goes up, for the release">Release <input type="number" data-smp="tail" min="0.2" max="8" step="0.1" value="${smp.tail}"> s</label>
      <label class="field" title="Find a smooth loop in each note's sustain, so notes can be held longer than they were recorded"><input type="checkbox" data-smp="loop" ${smp.loop ? 'checked' : ''}> Loop the sustain</label>
    </div>
    <div class="audio-row">
      <button class="rec-go" data-smp="go" ${ready && out ? '' : 'disabled'}>● Start sampling</button>
      <span class="hint">${!out ? 'The XL isn\'t connected (no SOUND port).' : !ready ? 'Choose your audio interface above (Audio in) and the input the XL is on.'
        : `${notes.length} notes (${notes.map(noteName).join(' ')}), about ${Math.ceil(secs / 60)} min. Play a note on the XL first and check the meter stays out of the red.`}</span>
      <span class="spacer"></span><button class="ghost small" data-smp="close">Close</button>
    </div>`;
}
$('#sample-xl').onclick = () => {
  const el = $('#sample-panel');
  el.hidden = !el.hidden;
  channel.postMessage({ type: 'get-program' }); // the XL editor says which sound the XL has
  renderSamplePanel();
};
$('#sample-panel').addEventListener('change', e => {
  const k = e.target.dataset.smp;
  if (!k) return;
  if (k === 'name') smp.name = e.target.value.trim().slice(0, 40);
  else if (k === 'loop') smp.loop = e.target.checked;
  else smp[k] = +e.target.value;
  if (smp.hi < smp.lo) [smp.lo, smp.hi] = [smp.hi, smp.lo];
  renderSamplePanel();
});
$('#sample-panel').addEventListener('click', e => {
  const k = e.target.closest('[data-smp]')?.dataset.smp;
  if (k === 'close') { $('#sample-panel').hidden = true; }
  else if (k === 'cancel' && smp.running) { smp.running.cancel = true; smp.running.status = 'Stopping after this note…'; renderSamplePanel(); }
  else if (k === 'go') sampleXL();
});

async function sampleXL() {
  const out = xlOut(), ch = (seq?.xlTracks?.[0]?.ch || 2) - 1, sr = audio.sampleRate;
  const notes = notesToSample(smp.lo, smp.hi, smp.step), name = smp.name || 'XL Sound';
  if (!out || !audio.open) return;
  channel.postMessage({ type: 'stop-sequencer' }); // nothing else playing while it records
  const run = smp.running = { cancel: false, done: 0, total: notes.length, status: 'Starting…' };
  renderSamplePanel();
  const takes = [];
  for (const note of notes) {
    if (run.cancel) break;
    run.status = `Recording ${noteName(note)} (${run.done + 1} of ${notes.length})…`;
    renderSamplePanel();
    audio.record();
    const at = performance.now() + 250;
    out.send([0x90 | ch, note, smp.vel], at);
    out.send([0x80 | ch, note, 0], at + smp.hold * 1000);
    await sleep(250 + (smp.hold + smp.tail) * 1000 + 150);
    const r = await audio.finish();
    // From when the note left (plus the measured delay back) to the end of its release.
    const clip = r && tidy(cut(r, audio.frameAt(at + latency()), Math.round((smp.hold + smp.tail) * sr)), Math.round(smp.hold * sr), sr);
    if (clip) takes.push({ note, ...clip });
    run.done++;
    await sleep(300); // let the last one ring out
  }
  out.send([0xb0 | ch, 123, 0]);
  if (!takes.length) { smp.running = null; renderSamplePanel(); toast('Nothing came back from the XL. Check it\'s on the chosen input and the meter moves when you play it.', 'err'); return; }

  // One gain for all, so the notes keep their levels relative to each other.
  const loudest = Math.max(...takes.map(t => t.peak));
  if (loudest > 0.98) toast('Some notes reached full level and may be clipped: turn the input gain down a little and sample again.', 'err');
  const gain = Math.min(0.9 / loudest, 10 ** (30 / 20));
  run.status = 'Saving…';
  renderSamplePanel();
  const zones = [], releases = [];
  try {
    for (const [k, z] of zonesFor(takes.map(t => t.note)).entries()) {
      const t = takes[k];
      t.chans.forEach(c => { for (let i = 0; i < c.length; i++) c[i] *= gain; });
      releases.push(releaseTime(t.chans, t.hold, sr));
      const loop = smp.loop ? makeLoop(t.chans, t.hold, sr) : null;
      const file = await storage.save('audio', encodeWav(t.chans, sr), `${name} ${noteName(t.note)}`);
      const len = t.chans[0].length;
      zones.push({ ...z, file, loopStart: loop ? loop.start / len : 0, loopEnd: loop ? loop.end / len : 0 });
    }
    releases.sort((a, b) => a - b);
    const patch = buildPatch({ name, zones, loop: smp.loop && zones.some(z => z.loopEnd > z.loopStart), release: releases[Math.floor(releases.length / 2)], type: 'Other' });
    const file = await storage.save('instruments', patch);
    refreshRecordings();
    channel.postMessage({ type: 'recordings-changed' });
    channel.postMessage({ type: 'instruments-changed' });
    smp.running = null;
    $('#sample-panel').hidden = true;
    toast(`Made "${name}" from ${zones.length} notes${run.cancel ? ' (stopped early)' : ''}: it's in the Sound Lab's My Sounds. Opening it…`, 'ok');
    channel.postMessage({ type: 'open-instrument', file });
    parent.postMessage({ type: 'switch-view', view: 'lab' }, location.origin);
  } catch (err) {
    smp.running = null;
    renderSamplePanel();
    toast(`Couldn't save the samples: ${err.message}`, 'err');
  }
}

// Print stems: each XL track of the song, solo, from bar 1, one after another.
$('#stems').onclick = async () => {
  if (stems) { stems.cancel = true; channel.postMessage({ type: 'stop-sequencer' }); return; }
  const tracks = seq?.xlTracks || [];
  if (!tracks.length) { toast('The song has no tracks playing the XL.'); return; }
  if (latencyUnknown() && !confirm('The delay hasn\'t been measured, so the stems may be a few milliseconds late. Print anyway?')) return;
  stems = { cancel: false };
  renderAudio();
  const song = seq.songName || 'Song';
  for (let k = 0; k < tracks.length && !stems.cancel; k++) {
    const tr = tracks[k];
    $('#stems-status').textContent = `Recording ${tr.name} (${k + 1} of ${tracks.length})…`;
    audio.record();
    const res = await new Promise(resolve => { stemWait = { resolve }; channel.postMessage({ type: 'print-stem', ti: tr.ti, tail: 2 }); });
    const r = await audio.finish();
    if (stems.cancel || !r || !res.start) break;
    const sr = audio.sampleRate, from = audio.frameAt(wallToPerf(res.start) + latency());
    await saveWav(cut(r, from, Math.round((res.ms + 2000) / 1000 * sr)), `${song} - ${tr.name}`);
    await sleep(300);
  }
  $('#stems-status').textContent = stems.cancel ? 'Stopped.' : `Done: ${tracks.length} stem${tracks.length > 1 ? 's' : ''}, each starting at bar 1 at ${seq.bpm} BPM.`;
  stems = null;
  renderAudio();
};
function onStem(m) {
  if (!stemWait) return;
  if (m.state === 'start') Object.assign(stemWait, { start: m.wall, ms: m.ms });
  else { const w = stemWait; stemWait = null; w.resolve({ start: w.start, ms: w.ms }); }
}

async function refreshRecordings() {
  let list = [];
  try { list = await storage.list('audio'); } catch { /* server down */ }
  $('#recordings').innerHTML = list.length ? list.map(x => `<div class="recording" data-file="${esc(x.file)}">
      <span class="rname" title="${esc(x.file)}">${esc(x.name)}</span><span class="hint">${clock(x.seconds * 1000)} · ${(x.size / 1e6).toFixed(1)} MB</span>
      <a download="${esc(x.file)}" title="Download (or drag into Ableton)">⬇</a>
      <button class="ghost small" data-act="rdel" title="${STATIC ? 'Delete' : 'Move to data/audio/deleted/'}">✕</button>
      <audio controls preload="none"></audio>
    </div>`).join('') : '<div class="hint">No recordings yet.</div>';
  // Their addresses: files at home, or blobs kept in this browser.
  for (const el of $('#recordings').querySelectorAll('[data-file]')) {
    const url = await storage.audioUrl(el.dataset.file);
    el.querySelector('a').href = url;
    el.querySelector('audio').src = url;
  }
}
$('#recordings').addEventListener('click', async e => {
  if (e.target.dataset.act !== 'rdel') return;
  const file = e.target.closest('[data-file]').dataset.file;
  if (!confirm(STATIC ? `Delete "${file}"?` : `Move "${file}" to data/audio/deleted/?`)) return;
  await storage.remove('audio', file);
  refreshRecordings();
});

// Typing notes while the panel has the focus: captured here, and played by the page underneath.
attachQwerty({ active: () => prefs.midiIn === QWERTY, from: 'recorder', channel, onMode: text => toast(text),
  onMessage: (d, ts) => { captureEvent(d, ts); if ((d[0] & 0xf0) === 0x90 && d[2] > 0) { $('#led').className = 'keys-led ok'; clearTimeout(ledTimer); ledTimer = setTimeout(() => { $('#led').className = 'keys-led'; }, 300); } } });

// Keeps "2 min ago" current.
setInterval(() => { if (!document.hidden) renderTakes(); }, 15000);

if (STATIC) document.querySelector('#audio-sec .sub .hint').textContent = '· kept in this browser: download the ones you want to keep';
// The take editor (editor.js) and what it needs from here.
initEditor({
  channel, toast, download,
  seq: () => seq,
  outputs: () => (midi ? [...midi.outputs.values()] : []),
  takeBpm, setTakeBpm: (id, bpm) => { cap.bpm.set(id, bpm); renderTakes(); },
  takeSound,
  clipsChanged: () => { refreshClips(); channel.postMessage({ type: 'clips-changed' }); },
});
wireEditor();

renderTakes();
renderPerf();
refreshClips();
initMidi();
fillDevices().then(() => { if (prefs.audioIn) useAudio(prefs.audioIn); else if (STATIC) useAudio(OWN); else renderAudio(); });
refreshRecordings();
channel.postMessage({ type: 'get-seq-state' });
