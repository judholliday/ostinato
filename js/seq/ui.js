// The sequencer page: draws the song, handles editing, and connects the engine to MIDI outputs
// and the test synth. No framework. `song` is what gets saved; `views` and `sel` are view state.
import { icon } from '../core/icons.js';
import * as M from './model.js';
import { Engine, LOOKAHEAD_MS } from './engine.js';
import * as synth from './testsynth.js';
import { demoSong } from './demo.js';
import { randomIdea } from './generate.js';
import { FACTORY } from '../lab/sounds.js';
import { STYLES, styleById } from './styles.js';
import { mutate, cross } from './breed.js';
import { writeMidi, renderSong as songToMidi } from './midifile.js';
import * as C from './capture.js';
import * as CH from './chords.js';
import { STARTER_TRACKS, addStarterTrack, keepLanes, putClip, guessClipRole, trackSound } from './putclip.js';
import { Mixer } from './mixer.js';
import { renderSongAudio, finish as finishRender, soundLength } from './songrender.js';
import { STOCK } from './stock.js';
import { portLabel, looksLikeSynthIn, looksLikeSynthOut } from '../core/midiports.js';
import { soundReporter } from '../core/sounding.js';
import { showAudioDelay } from '../core/audiodelay.js';
import { openSoundPicker } from '../core/soundpicker.js';
import { deviceForOut } from '../core/devices.js';
import { storage, placeOf, stemOf } from '../core/storage.js';
import { STATIC } from '../core/mode.js';
import { QWERTY, QWERTY_LABEL, attachQwerty, qwertyRange, setQwertyScale } from '../core/qwerty.js';
import { LabSynth, FxChain } from '../lab/engine.js';
import { rackOf, SYNC, MODULES } from '../lab/patch.js';
import { FACTORY_RACKS } from '../lab/racks.js';
import { Tap, cut, encodeWav } from '../rec/audio.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#ff6a2b', '#4fc28a', '#6aa9ff', '#c38bff', '#f3b33d', '#ff5fa2', '#3fd0d4', '#b5c94a'];

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('mkxl.seq.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('mkxl.seq.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

// ---------------------------------------------------------------------------------------------
// State

let song;
let fileName = null; // the file in data/sequences/ this song was loaded from or saved to
let dirty = false;
const prefs = { songOpen: true, chordsOpen: false, mixOpen: false, mode: 'loop', follow: true, soundFollows: true, keysIn: null, thru: true, clockOut: [], collapsed: [], click: 'rec', countIn: true, clickVol: 60, ...store.get('prefs', {}) };
const savePrefs = () => store.set('prefs', prefs);
let views = []; // per track: { pat (pattern shown), page, collapsed, kbdLow, lastNote }
let sel = { t: 0, i: 0, open: true };
let clipboard = null;
// The armed track (or null): only it takes notes from the keyboard (steps when stopped, the note
// pool when latched). Not saved: every session starts unarmed, so playing never overwrites by accident.
let armed = null;
const live = { pos: [], pattern: [], silent: [], poolNote: [], section: 0, bar: 0, bars: 0, barAt: 0 };
let midi = null;
let sysexOk = false; // SysEx is needed to send XL sounds

function syncViews() {
  while (views.length < song.tracks.length) {
    const ti = views.length;
    views.push({ pat: song.tracks[ti].pattern, page: 0, collapsed: !!prefs.collapsed[ti], roll: !!prefs.roll?.[ti], rollTop: null, rollLen: 2, rollSel: null, kbdLow: 36, lastNote: 48, ai: newAi(), ideas: newIdeas(), lib: newLib(), snd: newSnd(), feelOpen: false });
  }
  views.length = song.tracks.length;
  views.forEach((v, ti) => { v.page = Math.min(v.page, pages(ti) - 1); });
  if (sel.t >= song.tracks.length) sel = { t: 0, i: 0, open: sel.open };
}

const viewPattern = ti => song.tracks[ti].patterns[views[ti].pat];
const pageSize = ti => viewPattern(ti).length <= 16 ? 16 : 32;
const pages = ti => Math.ceil(viewPattern(ti).length / pageSize(ti));

// ---- undo, autosave ----
const undoStack = [], redoStack = [];
let snapshot = null, lastPush = 0, saveTimer = null;

// Call after every edit. Quick repeated edits (dragging a slider) share one undo step, and so do
// all the notes recorded in one run (coalesce: 'rec').
function changed({ coalesce = false } = {}) {
  const now = performance.now();
  if (coalesce === 'rec' ? !rec.pushed : !coalesce || now - lastPush > 800) {
    if (coalesce === 'rec') rec.pushed = true;
    undoStack.push(snapshot);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    lastPush = now;
  }
  snapshot = JSON.stringify(song);
  dirty = true;
  syncBacking();
  saveWorking();
  renderFileBar();
  postSeqState();
  syncFx();
}

function restore(json) {
  song = M.normalizeSong(JSON.parse(json));
  snapshot = json;
  dirty = true;
  syncViews();
  syncBacking();
  saveWorking();
  renderAll();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot); restore(redoStack.pop()); }

// The song being edited is kept in this browser, so a reload never loses work.
function saveWorking() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set('working', { song, fileName, dirty }), 300);
}

function load(raw, file, isDirty = false) {
  if (engine.playing) stop();
  song = M.normalizeSong(raw);
  fileName = file;
  dirty = isDirty;
  views = [];
  sel = { t: 0, i: 0, open: true };
  syncViews();
  snapshot = JSON.stringify(song);
  undoStack.length = redoStack.length = 0;
  liveSound = null;
  armed = null;
  saveWorking();
  renderAll();
}

// ---------------------------------------------------------------------------------------------
// MIDI and sound output

const outputs = () => midi ? [...midi.outputs.values()].filter(p => p.state !== 'disconnected') : [];
const inputs = () => midi ? [...midi.inputs.values()].filter(p => p.state !== 'disconnected') : [];
const outPort = name => outputs().find(p => p.name === name) || null;
let clockTargets = [];
const updateClockTargets = () => { clockTargets = outputs().filter(p => prefs.clockOut.includes(p.name)); };

function send(port, data, at) {
  try { port.send(data, at); } catch (e) { console.warn('MIDI send failed', port.name, e); }
}

const sounding = []; // MIDI notes the engine has started, so Stop can silence them
// Track volume → computer-sound gain: 0-100 fades in (100 = normal), 100-127 boosts up to 4×.
const gainOf = M.trackGain;
const sendVolume = (t, port = outPort(t.out)) => { if (port) send(port, [0xb0 | (t.ch - 1), 7, t.vol]); };
// A hardware track's pan, as CC 10 (64 = centre).
const sendPan = (t, port = outPort(t.out)) => { if (port) send(port, [0xb0 | (t.ch - 1), 10, Math.round(64 + (t.pan || 0) * 63)]); };

// The metronome rides on the engine's MIDI clock (24 pulses a quarter note), counted from each
// bar's start: a click per beat of the bar's meter (quarters in x/4, eighths in x/8), the first one
// accented.
let pulses = 0, barMeter = '4/4';
const beatMs = meter => 60000 / song.bpm * 4 / M.meterParts(meter).d;
const clickOn = () => prefs.click === 'on' || (prefs.click === 'rec' && (rec.on || !!perf));
const sink = {
  start(at) { pulses = 0; for (const p of clockTargets) send(p, [0xfa], at); },
  clock(at) {
    if (pulses % (96 / M.meterParts(barMeter).d) === 0 && clickOn()) synth.click(at, pulses === 0, prefs.clickVol / 100);
    pulses++;
    for (const p of clockTargets) send(p, [0xf8], at);
  },
  stop() {
    const now = performance.now();
    for (const p of clockTargets) send(p, [0xfc]);
    const channels = new Map();
    for (const s of sounding) {
      if (s.off > now) send(s.port, [0x80 | s.ch, s.note, 0]);
      channels.set(`${s.port.id}:${s.ch}`, s);
    }
    for (const s of channels.values()) send(s.port, [0xb0 | s.ch, 123, 0]); // All Notes Off
    sounding.length = 0;
    synth.stopAll();
    for (const l of labSynths.values()) l.synth.allOff(true);
    mixer?.reset();
  },
  // Song automation: computer tracks through their mixer strip; hardware as CC 7, CC 74 or the lane's CC.
  auto(ti, lane, v, at) {
    const t = song.tracks[ti];
    if (!t) return;
    if (t.out === M.COMPUTER) { if (lane.target !== 'cc') { fxFor(ti); mixerOf().automate(ti, lane.target, v, audioTime(at)); } return; }
    const port = outPort(t.out), cc = lane.target === 'level' ? 7 : lane.target === 'filter' ? 74 : lane.cc;
    if (port) send(port, [0xb0 | (t.ch - 1), cc, lane.target === 'level' ? Math.round(Math.min(127, t.vol) * v) : Math.round(v * 127)], at);
  },
  cc(ti, cc, value, at) {
    const t = song.tracks[ti], port = t.out === M.COMPUTER ? null : outPort(t.out);
    if (port) send(port, [0xb0 | (t.ch - 1), cc, value], at);
    logBacking('ccs', { ti, tick: r1(engine.tickAt(at)), cc, v: value });
  },
  note(ti, note, vel, at, dur) {
    if (skipRecorded(ti, note, at)) return;
    if (mixer && ducksAt(song.tracks[ti], note)) mixer.duckAt(audioTime(at));
    playNote(ti, note, vel, at, dur);
    logBacking('notes', { ti, tick: r1(engine.tickAt(at)), note, vel, len: r1(dur / engine.tickMs) });
  },
  // Visual updates happen when the sound does, not when it's scheduled.
  step(ti, pos, pattern, at, silent, notes) { later(at, () => showStep(ti, pos, pattern, silent, notes)); },
  bar(section, bar, at) {
    const meter = engine.meterNow(song);
    pulses = 0;
    barMeter = meter;
    later(at, () => { Object.assign(live, { section, bar, barAt: performance.now(), meter }); live.bars++; paintSong(); });
  },
};
const r1 = v => Math.round(v * 10) / 10;

// ---- Backing: what each playback run played, for Capture (a take keeps what it was played over) ----
// Each track gets an id for the run (`tid`), kept when tracks are added, removed or brought back by
// undo while playing (matched by name), so notes stay with their track. Messages:
//   run-start { run, song, tids }       at play: the song (a copy) and each track's id
//   run-song { run, song, tids }        tracks added or removed while playing
//   run-track { run, tid, tick, track } a track's sound, effects or volume changed while playing
//   run-notes { run, notes: [{ tid, tick, note, vel, len }], ccs: [{ tid, tick, cc, v }] }  every second
// Notes are what the engine actually played (after mute, chance, pools, feel, live edits); ticks are
// on the same timeline as `transport`. XL tracks carry the sound they play.
const backing = { notes: [], ccs: [], timer: null, tids: [], names: [], keys: [], nextTid: 1 };
function trackCopy(ti) {
  const t = JSON.parse(JSON.stringify(song.tracks[ti]));
  if (isXLOut(t.out) && !t.sound) { const x = soundOfTrack(ti); if (x) t.sound = { name: x.name, data: x.data }; }
  delete t.patterns; // the notes played are logged; the patterns aren't needed
  return t;
}
function backingSong() {
  const s = JSON.parse(JSON.stringify({ ...song, tracks: [] }));
  s.tracks = song.tracks.map((_, ti) => trackCopy(ti));
  return s;
}
// What makes a track sound the way it does (a change while playing is reported).
const soundKey = ti => { const t = song.tracks[ti], x = isXLOut(t.out) ? soundOfTrack(ti) : null; return JSON.stringify([t.out, t.ch, t.voice, t.vol, t.inst, t.fx, x?.data, t.program]); };
function logBacking(kind, e) {
  if (!engine.playing || !run) return;
  e.tid = backing.tids[e.ti];
  delete e.ti;
  if (e.tid) backing[kind].push(e);
}
function startBacking() {
  backing.notes = []; backing.ccs = [];
  backing.tids = song.tracks.map(() => backing.nextTid++);
  backing.names = song.tracks.map(t => t.name);
  backing.keys = song.tracks.map((_, ti) => soundKey(ti));
  soundChannel?.postMessage({ type: 'run-start', run, song: backingSong(), tids: backing.tids });
  clearInterval(backing.timer);
  backing.timer = setInterval(flushBacking, 1000);
}
// After every change (and undo): new track ids if tracks came or went, and sound changes.
function syncBacking() {
  if (!backing.timer || !engine.playing) return;
  if (song.tracks.length !== backing.names.length) {
    flushBacking(); // notes so far belong to the old layout
    const old = backing.names.map((n, i) => ({ n, id: backing.tids[i], key: backing.keys[i] }));
    const kept = song.tracks.map(t => { const k = old.findIndex(o => o.n === t.name); return k >= 0 ? old.splice(k, 1)[0] : null; });
    backing.tids = kept.map(o => o?.id ?? backing.nextTid++);
    backing.keys = kept.map((o, ti) => o?.key ?? soundKey(ti));
    soundChannel?.postMessage({ type: 'run-song', run, song: backingSong(), tids: backing.tids });
  }
  backing.names = song.tracks.map(t => t.name);
  checkSounds();
}
// Sound, effects or volume changed (edits, undo, the XL editor, the Sound Lab): reported with the
// tick from which notes use it (notes before were already sent with the old sound).
function checkSounds() {
  if (!backing.timer || !engine.playing || song.tracks.length !== backing.keys.length) return;
  const tick = r1(engine.tickAt(performance.now() + LOOKAHEAD_MS));
  song.tracks.forEach((_, ti) => {
    const key = soundKey(ti);
    if (key === backing.keys[ti]) return;
    backing.keys[ti] = key;
    soundChannel?.postMessage({ type: 'run-track', run, tid: backing.tids[ti], tick, track: trackCopy(ti) });
  });
}
function flushBacking() {
  checkSounds();
  if (!backing.notes.length && !backing.ccs.length) return;
  soundChannel?.postMessage({ type: 'run-notes', run, notes: backing.notes, ccs: backing.ccs });
  backing.notes = []; backing.ccs = [];
}
function endBacking() { clearInterval(backing.timer); backing.timer = null; flushBacking(); }

const later = (at, fn) => setTimeout(() => { if (engine.playing) fn(); }, Math.max(0, at - performance.now()));

// ---- Lab instruments: Computer tracks can play an instrument built in the Lab ----
let instruments = []; // saved in data/instruments/: [{ file, name, patch }]
let racks = []; // the built-in effect racks and the Sound Lab's saved ones (instruments with kind 'rack'): [{ file, name, rack, factory? }]
const factoryRacks = FACTORY_RACKS.map(r => ({ file: `factory:${r.name}`, name: r.name, rack: r.rack, about: r.about, factory: true }));
const labSynths = new Map(); // track index -> { synth, json }

async function refreshInstruments() {
  let all = [];
  try { all = await storage.list('instruments'); } catch { /* none */ }
  instruments = all.filter(x => !x.patch?.kind); // not racks or collections
  racks = [...all.filter(x => x.patch?.kind === 'rack').map(x => ({ file: x.file, name: x.name, rack: rackOf(x.patch) })).filter(x => x.rack.modules.length), ...factoryRacks];
  renderTracks();
  renderMixer();
}

// ---- Effect racks from the Sound Lab: an insert on a Computer track, and the song's master ----
// Each holds a copy of the rack (picking it again takes the saved version). Nothing is added for you.
const trackFx = new Map(); // track index -> { chain, json }
// The mix (mixer.js): each computer track's effects feed its strip (pan, duck, sends, meter).
let mixer = null;
function mixerOf() {
  if (!mixer) { mixer = new Mixer(synth.wake(), synth.output()); mixer.setMix(song.mix, song.bpm); }
  return mixer;
}
// The engine's time (performance.now() ms) on the test synth's audio clock.
const audioTime = at => { const ac = synth.context(); return ac.currentTime + Math.max(0, at - performance.now()) / 1000; };
// A note from the side-chain source ducks the others: on a drum track only its kicks.
const ducksAt = (t, note) => t.sidechain && (!isDrums(t) || note === 35 || note === 36);
// Where a Computer track's sound goes: its effects (straight through when none), then the master.
function fxFor(ti) {
  let f = trackFx.get(ti);
  if (!f) { f = { chain: new FxChain(synth.wake()), json: null }; f.chain.tempo = song.bpm; f.chain.output.connect(mixerOf().strip(ti).input); mixer.setTrack(ti, song.tracks[ti]); trackFx.set(ti, f); }
  const fx = song.tracks[ti]?.fx || null, json = JSON.stringify(fx);
  if (json !== f.json) { f.chain.set(fx); f.json = json; }
  return f.chain.input;
}
// After edits, undo and loading: the effects that exist follow the song (new ones wait for a note).
function syncFx() {
  synth.setMasterFx(song.masterFx);
  for (const ti of trackFx.keys()) fxFor(ti);
  // Tempo-synced LFOs, delays and tremolos follow the song's tempo.
  synth.setTempo(song.bpm);
  for (const f of trackFx.values()) f.chain.setTempo(song.bpm);
  for (const l of labSynths.values()) l.synth.setTempo(song.bpm);
  if (mixer) { mixer.setMix(song.mix, song.bpm); song.tracks.forEach((t, ti) => { if (t.out === M.COMPUTER) mixer.setTrack(ti, t); else if (mixer.strips.has(ti)) mixer.setTrack(ti, { duck: 0 }); }); }
}
const rackFx = (r, was) => M.cleanFx({ name: r.name, rack: r.rack, mix: was?.mix ?? 1 });
const sameRack = (fx, r) => !!r && JSON.stringify(fx.rack.modules) === JSON.stringify(r.rack.modules);
// The FX menu's options: none, your racks, and this copy when it's no longer (or not quite) saved.
function fxOptions(fx) {
  const saved = fx && racks.find(r => r.name === fx.name);
  const opt = r => `<option value="${esc(r.file)}"${saved === r && sameRack(fx, r) ? ' selected' : ''} title="${esc(r.about || r.rack.modules.map(e => MODULES[e.type]?.label).join(' → '))}">${esc(r.name)}${saved === r && !sameRack(fx, r) ? ` (${r.factory ? 'built-in' : 'saved'} version)` : ''}</option>`;
  const mine = racks.filter(r => !r.factory);
  return `<option value="">none</option>${mine.length ? `<optgroup label="Your racks">${mine.map(opt).join('')}</optgroup>` : ''}<optgroup label="Built in">${factoryRacks.map(opt).join('')}</optgroup>${
    fx && !(saved && sameRack(fx, saved)) ? `<option value="__copy" selected>${esc(fx.name)} (${saved ? 'this song\'s copy' : 'kept in this song'})</option>` : ''}`;
}
// Menu, bypass and mix for one rack slot; `act` prefixes the data-act names.
function fxHTML(fx, act, what, label = 'FX') {
  return `<label class="field" title="An effect rack from the Sound Lab on ${what} (save one there with Save effects as rack…). The song keeps its own copy.">${label} <select data-act="${act}">${fxOptions(fx)}</select></label>${fx
    ? `<button class="small ${fx.off ? 'ghost fx-off' : 'on'}" data-act="${act}-off" title="${fx.off ? 'Bypassed: click to hear the effects again' : 'On: click to bypass the effects'}">${fx.off ? 'Bypassed' : 'On'}</button>
       <label class="field" title="How much of the sound goes through the effects (the rest stays dry)">Mix <input type="range" class="fx-mix" data-act="${act}-mix" min="0" max="100" value="${Math.round(fx.mix * 100)}"></label>` : ''}`;
}
// A change in an FX menu: the picked rack, or none. Returns the new value.
function pickFx(value, was) {
  if (value === '__copy') return was;
  const r = racks.find(x => x.file === value);
  return r ? rackFx(r, was) : null;
}

// The Lab synth for a track, kept in step with the track's patch and volume.
function labFor(ti) {
  const t = song.tracks[ti];
  if (!t?.inst) return null;
  let l = labSynths.get(ti);
  if (!l) { l = { synth: new LabSynth(synth.wake(), fxFor(ti)), json: '' }; l.synth.tempo = song.bpm; labSynths.set(ti, l); }
  fxFor(ti);
  const json = JSON.stringify(t.inst.patch);
  if (json !== l.json) { l.synth.setPatch(t.inst.patch); l.json = json; }
  l.synth.setGain(gainOf(t));
  return l.synth;
}

// Plays one note on a track's output at a time in ms (performance.now() clock).
function playNote(ti, note, vel, at, dur) {
  const t = song.tracks[ti];
  if (t.out === M.COMPUTER && t.inst) { const l = labFor(ti); l.play(note, vel, l.atTime(at), dur / 1000); return; }
  if (t.out === M.COMPUTER) { synth.play(t.voice, note, vel, at, dur, gainOf(t), fxFor(ti)); return; }
  const port = outPort(t.out);
  if (!port) return;
  const ch = t.ch - 1;
  send(port, [0x90 | ch, note, vel], at);
  send(port, [0x80 | ch, note, 0], at + dur);
  const now = performance.now();
  while (sounding.length && sounding[0].off < now) sounding.shift();
  sounding.push({ port, ch, note, off: at + dur });
}

// Plays a key through the selected track's output; returns a function that stops it.
function noteNow(ti, note, vel) {
  const t = song.tracks[ti];
  if (t.out === M.COMPUTER && t.inst) { const l = labFor(ti); l.noteOn(note, vel); return () => l.noteOff(note); }
  if (t.out === M.COMPUTER) return synth.hold(t.voice, note, vel, gainOf(t), fxFor(ti));
  const port = outPort(t.out);
  if (!port) return () => {};
  const ch = t.ch - 1;
  send(port, [0x90 | ch, note, vel]);
  return () => send(port, [0x80 | ch, note, 0]);
}
function preview(ti, note) {
  const off = noteNow(ti, note, 100);
  setTimeout(off, 250);
}

// ---- Sounds: each XL track remembers its sound; other gear gets a Program Change ----

// The device (core/devices.js, e.g. the XL) a track's output plays, if it's one we know in depth:
// such tracks carry a whole sound, sent when playback starts. (Still called "XL tracks" here.)
const deviceOf = name => (name === M.COMPUTER ? null : deviceForOut(outPort(name), name));
const isXLOut = name => !!deviceOf(name);
// Sends a device sound ({ data }) to a track's output.
function sendDeviceSound(t, data) {
  const dev = deviceOf(t.out), port = outPort(t.out);
  if (dev && port && (!dev.needsSysex || sysexOk)) send(port, dev.soundMessage(t.ch - 1, data));
}

// The editor runs alongside (index.html) and tells us what sound it holds; we send it sounds to edit.
const soundChannel = 'BroadcastChannel' in window ? new BroadcastChannel('mkxl') : null;
let editorSound = null; // { name, data } in the microKORG XL editor now
const reportSound = soundReporter(soundChannel, 'sequencer');

// A track's sound as the Recorder keeps it with takes (core/sounding.js).
function soundOfTrack(ti) {
  const t = song.tracks[ti];
  if (!t) return null;
  if (t.out === M.COMPUTER) return t.inst ? { kind: 'lab', name: t.inst.name, patch: t.inst.patch } : { kind: 'voice', name: `${t.voice} (test voice)`, voice: t.voice };
  if (isXLOut(t.out)) { const x = t.sound || editorSound; return x ? { kind: 'xl', name: x.name, data: x.data } : null; }
  const port = outPort(t.out);
  return { kind: 'midi', name: `${port ? portLabel(port) : t.out} ch ${t.ch}${t.program !== null ? ` program ${t.program + 1}` : ''}`, out: t.out, ch: t.ch, program: t.program };
}
let liveSound = null; // the track whose sound is on the XL now: edits in the editor are saved to it
const sameSound = (a, b) => !!a && !!b && a.data.length === b.data.length && a.data.every((x, i) => x === b.data[i]);

if (soundChannel) soundChannel.onmessage = e => {
  if (e.data?.type === 'qwerty') {
    if (e.data.from === 'recorder' && prefs.keysIn === QWERTY && (onScreen() || view === 'capture')) {
      if (onScreen()) onQwerty(e.data.data, e.data.wall - performance.timeOrigin); else thruOnly(e.data.data, e.data.wall - performance.timeOrigin);
    }
    return;
  }
  if (onRecorderMessage(e.data || {})) return;
  if (e.data?.type === 'instruments-changed') { refreshInstruments(); return; }
  if (e.data?.type === 'instrument') {
    // A take's sound being edited in the Sound Lab (linked from Capture): its loop follows along.
    if (e.data.link && audition?.link === e.data.link && auditionLab) auditionLab.setPatch(e.data.patch);
    // An instrument being edited in the Lab: tracks using it (by name) follow along.
    const inst = M.cleanInst({ name: e.data.name, patch: e.data.patch });
    let any = false;
    song.tracks.forEach(t => { if (t.inst?.name === inst?.name && JSON.stringify(t.inst.patch) !== JSON.stringify(inst.patch)) { t.inst = inst; any = true; } });
    if (any) changed({ coalesce: true });
    return;
  }
  if (e.data?.type !== 'program') return;
  const sound = M.cleanSound(e.data);
  if (!sound) return;
  const first = !editorSound;
  editorSound = sound;
  const t = song.tracks[liveSound];
  if (t && isXLOut(t.out)) {
    if (!sameSound(t.sound, sound)) { t.sound = sound; changed({ coalesce: true }); renderTrack(liveSound); }
  } else if (first || song.tracks.some(x => isXLOut(x.out) && !x.sound)) renderTracks(); // "Use editor sound (NAME)"
};

// Sends a track's sound to the XL and shows it in the editor; it becomes the live sound.
function sendSound(ti, { show = true } = {}) {
  const t = song.tracks[ti], port = outPort(t.out);
  if (!t.sound) return;
  sendDeviceSound(t, t.sound.data);
  if (show) soundChannel?.postMessage({ type: 'show-program', name: t.sound.name, data: t.sound.data });
  editorSound = t.sound;
  const prev = liveSound;
  liveSound = ti;
  if (prev !== null && prev !== ti && song.tracks[prev]) renderTrack(prev);
  renderTrack(ti);
}

// At play: each XL gets one track's sound (it plays one at a time: the live track's, else the
// first audible XL track's). A track with no sound yet remembers the one the editor has.
// Other gear gets each track's Program Change.
function prepareSounds() {
  const done = new Set();
  const order = [liveSound, ...song.tracks.keys()].filter(i => i !== null && song.tracks[i]);
  for (const ti of order) {
    const t = song.tracks[ti];
    if (!isXLOut(t.out) || done.has(t.out) || !M.audible(song, ti)) continue;
    if (!t.sound && editorSound) { t.sound = { ...editorSound }; changed(); }
    if (!t.sound) continue;
    done.add(t.out);
    sendSound(ti);
  }
  for (const t of song.tracks) {
    if (t.out === M.COMPUTER) continue;
    if (t.vol !== 100) sendVolume(t); // left at 100, the instrument's own level is kept
    if (t.pan) sendPan(t);
    const port = outPort(t.out);
    if (port && t.program !== null && !isXLOut(t.out)) send(port, [0xc0 | (t.ch - 1), t.program]);
  }
}

const engine = new Engine({ song: () => song, now: () => performance.now(), pool: ti => poolNotes(ti), sink });

// A worker keeps time even when the tab is in the background (page timers get slowed there).
const ticker = new Worker(URL.createObjectURL(new Blob(
  ['let id; onmessage = e => { clearInterval(id); if (e.data) id = setInterval(() => postMessage(0), e.data); };'],
  { type: 'text/javascript' })));
ticker.onmessage = () => { engine.pump(); if (engine.anchor !== sentAnchor) postTransport(); };

// `countIn` (true/false) overrides the Rec count-in setting (the Recorder's performances).
function play({ countIn: force, delay = 0, from } = {}) {
  if (engine.playing) return null;
  engine.from = from ?? loopSec ?? 0;
  engine.loopSection = loopSec;
  engine.jumpTo = null;
  synth.wake();
  updateClockTargets();
  engine.mode = prefs.mode;
  prepareSounds();
  run = Date.now();
  rec.pushed = false;
  startBacking();
  // Count-in: with Rec on, one bar of clicks (in the first bar's meter) before the first beat.
  const first = engine.mode === 'song' ? M.meterAt(song, engine.from) : song.meter, beats = M.meterParts(first).n, bm = beatMs(first);
  const countIn = (typeof force === 'boolean' ? force : rec.on && prefs.countIn) ? beats * bm : 0;
  const t0 = engine.play({ delay: countIn + delay });
  for (let k = 0; countIn && k < beats; k++) synth.click(t0 - countIn + k * bm, k === 0, prefs.clickVol / 100);
  Object.assign(live, { pos: [], pattern: [], silent: [], poolNote: [], section: 0, bar: 0, bars: 0, barAt: t0, startAt: t0, meter: first, countBeats: beats, countMs: bm });
  ticker.postMessage(25);
  $('#play').classList.add('playing');
  requestAnimationFrame(showPosition);
  postTransport();
  return { t0, countIn };
}

// Automation undone: strips back to their settings, hardware levels back to the track's (Stop, or
// leaving song mode, where automation doesn't play).
function resetAuto() {
  mixer?.reset();
  for (const l of song.auto || []) { const t = song.tracks[l.ti]; if (l.target === 'level' && t && t.out !== M.COMPUTER) sendVolume(t); }
}
function stop() {
  engine.stop();
  resetAuto();
  endBacking();
  ticker.postMessage(0);
  stopAudition();
  if (perf) {
    clearTimeout(perf.timer);
    soundChannel?.postMessage({ type: 'performance', state: 'end', wall: perf.endWall ?? Date.now() });
    if (perf.own && ownTap?.recording) {
      // The file starts exactly at bar 1 (the count-in isn't in it).
      const t0 = perf.t0, name = `Performance ${stamp(Date.now())} (Ostinato)`;
      ownTap.finish().then(r => {
        const from = ownTap.frameAt(t0);
        if (r) saveOwn(cut(r, from, r.frame + r.chans[0].length - from), name); else saveOwn(null);
      });
    }
    perf = null;
  }
  if (stem) { clearTimeout(stem.timer); stem.restore(); soundChannel?.postMessage({ type: 'stem', state: 'end' }); stem = null; }
  postTransport();
  $('#play').classList.remove('playing');
  $('#pos').textContent = '—';
  postPos('—');
  renderTracks();
  paintSong();
}

// The position for the other tabs' top bars (core/topbar.js), when it changes.
let lastPos = '';
function postPos(text) { if (text !== lastPos) { lastPos = text; soundChannel?.postMessage({ type: 'pos', text }); } }

function showPosition() {
  if (!engine.playing) return;
  if (performance.now() < live.startAt) {
    $('#pos').textContent = `count-in ${live.countBeats - Math.floor((live.startAt - performance.now()) / live.countMs)}`;
    requestAnimationFrame(showPosition);
    return;
  }
  const beat = Math.min(M.meterParts(live.meter).n, Math.floor((performance.now() - live.barAt) / beatMs(live.meter)) + 1);
  $('#pos').textContent = engine.mode === 'song'
    ? `§${live.section + 1} · bar ${live.bar + 1} · ${beat}`
    : `bar ${Math.max(1, live.bars)} · ${beat}`;
  postPos($('#pos').textContent);
  moveHead();
  requestAnimationFrame(showPosition);
}

function showStep(ti, pos, pattern, silent, notes) {
  const v = views[ti];
  if (!v) return;
  const switched = pattern !== live.pattern[ti] || silent !== live.silent[ti];
  live.pos[ti] = pos;
  live.pattern[ti] = pattern;
  live.silent[ti] = silent;
  if (notes.length && song.tracks[ti].mode === 'pool') live.poolNote[ti] = notes[0];
  let redraw = switched; // pattern buttons show which pattern is playing
  if (switched && !silent && (prefs.follow || engine.mode === 'loop') && v.pat !== pattern) { v.pat = pattern; v.page = 0; }
  if (prefs.follow && v.pat === pattern && !v.collapsed) {
    const page = Math.floor(pos / pageSize(ti));
    if (page !== v.page) { v.page = page; redraw = true; }
  }
  if (redraw) renderTrack(ti); else paintPlayhead(ti);
}

// ---- keys in: fill steps, set the note pool, play through ----
const held = []; // notes held on the keyboard (snapped to the scale), in the order pressed
const thru = new Map(); // key -> function that stops it
let entered = false; // notes were entered into a step since all keys were last released

// The sustain pedal (CC 64, or Caps Lock on the computer keyboard): released keys keep sounding
// (and recording) until it comes up.
let sustain = false;
const sustained = new Set();
function setSustain(on, at) {
  sustain = on;
  for (const l of labSynths.values()) l.synth.setPedal('sustain', on); // Pedal resonance hears it
  if (!on) { for (const key of sustained) releaseKey(key, at); sustained.clear(); }
}
function releaseKey(key, at) {
  thru.get(key)?.();
  thru.delete(key);
  if (rec.down.has(key)) recordUp(key, at);
}

function onKeys(data, at = performance.now()) {
  const type = data[0] & 0xf0;
  if (type === 0xb0 && data[1] === 64) { setSustain(data[2] >= 64, at); return; }
  if (type === 0xb0 && data[1] === 67) { for (const l of labSynths.values()) l.synth.setPedal('soft', data[2] >= 64); return; } // una corda
  if (type === 0xb0) { onCC(data[1], data[2], at); return; }
  if (type === 0x90 && data[2] > 0) keyDown(data[1], data[2], at);
  else if (type === 0x80 || type === 0x90) keyUp(data[1], at);
}

let poolHinted = false; // told once per session that the pool needs the track armed
function keyDown(key, vel, at) {
  if (sustained.delete(key)) releaseKey(key, at); // the same key again while sustained
  const n = M.snapToScale(key, song.scale);
  const fresh = held.length === 0;
  if (!held.includes(n)) held.push(n);
  const ti = sel.t, t = song.tracks[ti], v = views[ti];
  if (prefs.thru && !(t.mode === 'pool' && engine.playing)) { thru.get(key)?.(); thru.set(key, noteNow(ti, n, vel)); reportSound(soundOfTrack(ti)); }
  if (t.mode === 'pool') {
    if (t.pool.latch && armed === ti) {
      t.pool.notes = fresh ? [n] : [...t.pool.notes.filter(x => x !== n), n];
      changed({ coalesce: !fresh });
    } else if (t.pool.latch && !poolHinted) {
      poolHinted = true;
      toast(`To set ${t.name}'s note pool from your keyboard, arm the track first (✎ in its header, or double-click the header).`);
    }
    renderTrack(ti);
  } else if (rec.on && engine.playing) {
    recordDown(key, n, vel, at);
  } else if (!engine.playing && sel.open && armed === ti) {
    const pat = viewPattern(ti), s = M.stepAt(pat, sel.i);
    const notes = fresh || !s ? [n] : [...new Set([...s.notes, n])].sort((a, b) => a - b);
    M.putStep(pat, sel.i, { notes, vel });
    v.lastNote = n;
    entered = true;
    changed({ coalesce: !fresh });
    renderTrack(ti);
  }
}

function keyUp(key, at) {
  const n = M.snapToScale(key, song.scale);
  const k = held.indexOf(n);
  if (k >= 0) held.splice(k, 1);
  if (sustain) sustained.add(key); else releaseKey(key, at);
  if (held.length) return;
  const t = song.tracks[sel.t];
  if (entered) {
    // Step entry: once all keys are up, move on to the step after this note.
    entered = false;
    const pat = viewPattern(sel.t), s = M.stepAt(pat, sel.i);
    sel.i = (sel.i + (s ? s.len : 1)) % pat.length;
    const v = views[sel.t];
    v.page = Math.floor(sel.i / pageSize(sel.t));
    renderTrack(sel.t);
  } else if (t.mode === 'pool' && !t.pool.latch) renderTrack(sel.t);
}


// ---- recording: while playing with Rec on, keys played go into the selected track ----
// Notes are added to what's there (overdub), at the nearest step, held for as long as the key was.
const rec = { on: false, pushed: false, down: new Map(), longest: new Map(), skip: [] };

function setRec(on) {
  rec.on = on;
  rec.pushed = false;
  rec.down.clear();
  rec.longest.clear();
  $('#rec').classList.toggle('rec-on', on);
  postTransport();
  const t = song.tracks[sel.t];
  if (on && t.mode === 'pool') toast('Recording fills in Steps tracks. On a note-pool track, the keys you hold set the pool.');
  else if (on && !prefs.keysIn) toast('Choose your keyboard under MIDI in to record.');
  else if (on && !engine.playing) toast(`Rec is on: press Play and play your keyboard to record into ${t.name}.`);
}

function recordDown(key, n, vel, at) {
  const ti = sel.t, t = song.tracks[ti];
  if (t.mode !== 'steps') return;
  const p = engine.positionAt(ti, at);
  if (!p || engine.tickAt(at) < -M.RATES[t.rate] / 2) return; // during the count-in
  const pat = t.patterns[p.pattern], near = Math.round(p.step);
  const i = near % pat.length, s = M.stepAt(pat, i);
  M.putStep(pat, i, { notes: s ? [...new Set([...s.notes, n])].sort((a, b) => a - b) : [n],
    vel: s ? Math.max(s.vel, vel) : vel, gate: s ? s.gate : 90 });
  // Played just ahead of its step: if the engine hasn't scheduled that step yet it would play the
  // note again right after you did, so skip it this once.
  if (near > p.step) rec.skip.push({ ti, note: n, at: at + (near - p.step) * p.stepMs, within: p.stepMs * 0.6 });
  rec.down.set(key, { ti, pattern: p.pattern, i, n, at, stepMs: p.stepMs });
  views[ti].lastNote = n;
  changed({ coalesce: 'rec' });
  renderTrack(ti);
}

function recordUp(key, at) {
  const r = rec.down.get(key);
  rec.down.delete(key);
  const t = song.tracks[r.ti], pat = t?.patterns[r.pattern], s = pat && M.stepAt(pat, r.i);
  if (!s || !s.notes.includes(r.n)) return;
  // A chord's step is held as long as its longest key.
  const id = `${r.ti}:${r.pattern}:${r.i}:${s.notes.join()}`;
  const d = Math.max((at - r.at) / r.stepMs, rec.longest.get(id) || 0);
  rec.longest.set(id, d);
  const len = Math.max(1, Math.round(d));
  M.putStep(pat, r.i, { len, gate: Math.round(Math.min(1, Math.max(0.1, d - (len - 1))) * 100) });
  changed({ coalesce: 'rec' });
  renderTrack(r.ti);
}

function skipRecorded(ti, note, at) {
  const now = performance.now();
  rec.skip = rec.skip.filter(x => x.at > now - 1000);
  const k = rec.skip.findIndex(x => x.ti === ti && x.note === note && Math.abs(x.at - at) < x.within);
  if (k < 0) return false;
  rec.skip.splice(k, 1);
  return true;
}

// Without latch, the selected pool track plays only the keys being held.
function poolNotes(ti) {
  const t = song.tracks[ti];
  return !t.pool.latch && ti === sel.t ? held : t.pool.notes;
}

async function initMidi() {
  if (new URLSearchParams(location.search).has('sim')) await import('../../tools/fakesynth.js');
  if (!navigator.requestMIDIAccess) { status('No Web MIDI · computer sound only', 'warn'); renderPorts(); return; }
  try {
    midi = await navigator.requestMIDIAccess({ sysex: true });
    sysexOk = true;
  } catch {
    try { midi = await navigator.requestMIDIAccess(); } catch { /* blocked entirely */ }
    if (!midi) {
      status('MIDI blocked · computer sound only', 'err');
      renderPorts();
      toast('MIDI access was blocked. Allow MIDI for this page in Chrome\'s site settings and reload. The computer test sound still works.', 'err');
      return;
    }
    toast('SysEx is blocked, so XL sounds can\'t be sent with tracks. Notes still play.', 'err');
  }
  midi.onstatechange = () => { wireInputs(); renderPorts(); renderTracks(); };
  wireInputs();
  renderPorts();
  renderTracks();
}

const wired = new WeakSet();
function wireInputs() {
  for (const input of inputs()) {
    if (wired.has(input)) continue;
    wired.add(input);
    input.addEventListener('midimessage', e => {
      const d = e.data;
      if ((d[0] & 0xf0) === 0x90 && d[2] > 0) noteSeen(input, d[1]);
      if (input.name !== prefs.keysIn) return;
      // Only while the sequencer is on screen: keys played while auditioning in the microKORG XL editor
      // shouldn't fill in steps behind your back. On Capture they only sound.
      if (onScreen()) onKeys(d, e.timeStamp);
      else if (view === 'capture') thruOnly(d, e.timeStamp);
    });
    input.open?.().catch(() => {});
  }
}

const onScreen = () => !window.frameElement || !window.frameElement.hidden;
// Which view index.html shows. While it's Capture, keys play through the selected track (so what
// you play is heard, and captured with its sound) but don't change any pattern.
let view = 'sequencer';
addEventListener('message', e => { if (e.origin === location.origin && e.data?.type === 'view') view = e.data.view; });
parent.postMessage({ type: 'view-hello' }, location.origin);
function thruOnly(data, at) {
  const type = data[0] & 0xf0, key = data[1];
  if (type === 0xb0 && key === 64) setSustain(data[2] >= 64, at);
  else if (type === 0xb0 && key === 67) for (const l of labSynths.values()) l.synth.setPedal('soft', data[2] >= 64);
  else if (type === 0x90 && data[2] > 0) {
    if (sustained.delete(key)) releaseKey(key, at);
    if (!prefs.thru) return;
    thru.get(key)?.();
    thru.set(key, noteNow(sel.t, M.snapToScale(key, song.scale), data[2]));
    reportSound(soundOfTrack(sel.t));
  } else if (type === 0x80 || type === 0x90) { if (sustain) sustained.add(key); else releaseKey(key, at); }
}

// The computer keyboard as MIDI in (core/qwerty.js): typed here, or on the Capture tab.
const qwertyIn = { name: QWERTY };
const onQwerty = (d, ts) => { if ((d[0] & 0xf0) === 0x90) noteSeen(qwertyIn, d[1]); onKeys(d, ts); };
attachQwerty({ active: () => prefs.keysIn === QWERTY && onScreen(), onMessage: onQwerty, channel: soundChannel, from: 'sequencer',
  onOctave: () => { renderPorts(); toast(`Computer keyboard: ${qwertyRange()}`); }, onMode: text => toast(text) });

// The light next to MIDI in: green for notes on the chosen port; amber when notes arrive on a
// different port (so it's clear which one to choose).
let ledTimer = null, lastOther = null;
function noteSeen(input, note) {
  const chosen = input.name === prefs.keysIn, led = $('#keys-led');
  lastOther = chosen ? null : input.name;
  $('#keys-last').classList.toggle('fix', !chosen);
  led.className = `keys-led ${chosen ? 'ok' : 'other'}`;
  $('#keys-last').textContent = chosen ? M.noteName(note) : `${M.noteName(note)} from ${input.name}?`;
  const label = input.name === QWERTY ? QWERTY_LABEL : portLabel(input);
  led.title = chosen ? `Last note ${M.noteName(note)} from ${label}`
    : `A note arrived from ${label}, which isn't the MIDI in port. Click to use it.`;
  clearTimeout(ledTimer);
  ledTimer = setTimeout(() => { led.className = 'keys-led'; }, 400);
}

function status(text, kind = '') {
  const el = $('#midi-status');
  el.textContent = text;
  el.className = `status-pill ${kind}`;
}

function renderPorts() {
  const ins = inputs(), outs = outputs();
  // If the saved port isn't connected (unplugged, or a name saved from the simulator), use the
  // XL's keyboard, or else the first input.
  // With no MIDI keyboard at all, the computer keyboard plays.
  // The computer keyboard chosen for you (no MIDI keyboard was there) gives way to a real one when
  // it's connected; chosen by you, it stays. Old settings without the flag count as for you.
  const auto = prefs.keysInAuto !== false;
  if (!prefs.keysIn || (prefs.keysIn !== QWERTY && !ins.some(p => p.name === prefs.keysIn)) || (prefs.keysIn === QWERTY && auto && ins.length)) {
    const guess = ins.find(p => /mpk|akai/i.test(p.name)) || ins.find(looksLikeSynthIn) || ins[0];
    prefs.keysIn = guess ? guess.name : QWERTY;
    prefs.keysInAuto = true;
    savePrefs();
  }
  const keys = $('#keys-in');
  keys.innerHTML = `<option value="">— none —</option>` + ins.map(p => `<option value="${esc(p.name)}">${esc(portLabel(p))}</option>`).join('')
    + `<option value="${QWERTY}">${QWERTY_LABEL}</option>`
    + (prefs.keysIn && prefs.keysIn !== QWERTY && !ins.some(p => p.name === prefs.keysIn) ? `<option value="${esc(prefs.keysIn)}">${esc(prefs.keysIn)} (not connected)</option>` : '');
  keys.title = prefs.keysIn === QWERTY ? `A–K and W E T Y U O P play ${qwertyRange()}; Z / X change octave` : '';
  keys.value = prefs.keysIn || '';
  $('#clock-list').innerHTML = outs.length
    ? outs.map(p => `<label><input type="checkbox" value="${esc(p.name)}" ${prefs.clockOut.includes(p.name) ? 'checked' : ''}> ${esc(portLabel(p))}</label>`).join('')
      + `<span class="hint">Set the XL's Clock to Auto or Ext-USB to sync its arpeggiator.</span>`
    : '<span class="hint">No MIDI outputs.</span>';
  const on = outs.filter(p => prefs.clockOut.includes(p.name));
  $('#clock-sum').textContent = on.length ? `to ${on.map(p => portLabel(p).replace(/ \(.*\)$/, '')).join(', ')}` : 'off';
  updateClockTargets();
  if (midi) status(`MIDI: ${outs.length} output${outs.length === 1 ? '' : 's'}, ${ins.length} input${ins.length === 1 ? '' : 's'}`, outs.length ? 'ok' : 'warn');
}

// ---------------------------------------------------------------------------------------------
// Rendering

function renderAll() {
  renderTop();
  renderFileBar();
  renderSong();
  renderChords();
  renderMixer();
  renderTracks();
}

// ---- the chord track (chords.js does the music) ----
// The song's progression, typed or picked from common ones in the song's key, shown bar by bar
// (the chord playing now lit), and how each track follows it. Nothing follows until you say so.
const FOLLOW_OPTS = [['', 'Plays as written'], ['move', 'Moves with the chords'], ['fit', 'Fits to the chords']];
const POOL_FOLLOW = [['', 'Plays its pool'], ['move', 'Plays the chords']];
const followText = t => (t.mode === 'pool' ? 'plays the chords' : t.follow === 'fit' ? 'fits to the chords' : 'moves with the chords');
function chordBarsHTML(text = song.chords) {
  const { bars, errors } = CH.parseProgression(text);
  // Every bar is the same width and its chords share it, so a bar with two chords looks split.
  const beats = M.meterParts(song.meter).n, len = n => { const b = beats / n; return Number.isInteger(b) ? `${b} beat${b === 1 ? '' : 's'}` : `1/${n} bar`; };
  return (bars.length ? `<div class="chord-bars">${bars.map((b, bi) => `<div class="cbar${b.length > 1 ? ' split' : ''}"><span class="cbar-n">${bi + 1}</span>${b.map((c, si) =>
    `<button class="chord${c ? '' : ' nc'}" data-bar="${bi}" data-slot="${si}" title="${c ? `${esc(c.name)}: ${c.pcs.map(p => M.NOTE_NAMES[p]).join(' ')}` : 'No chord: following tracks play as written'}, ${len(b.length)}${c ? '. Click to hear it' : ''}">${c ? esc(c.name) : 'N.C.'}${b.length > 1 ? `<small>${len(b.length)}</small>` : ''}</button>`).join('')}</div>`).join('')}</div>
    <p class="hint">${bars.length} bar${bars.length === 1 ? '' : 's'} from bar 1, then round again (the same in Loop and Song mode).${bars.some(b => b.length > 1) ? ' Chords in one bar share it; put | before a chord to give it a bar of its own.' : ''}</p>`
    : '<p class="hint">No chords yet. Type a progression, or pick a common one.</p>')
    + (errors.length ? `<p class="hint warn">Not chords: ${errors.map(esc).join(', ')} (skipped). Try names like Am, F#m7, Bbmaj7, Csus4, D/F#.</p>` : '');
}
function renderChords() {
  const el = $('#chords'), following = song.tracks.filter(t => t.follow && !isDrums(t));
  el.hidden = !prefs.chordsOpen;
  $('#chords-col').textContent = prefs.chordsOpen ? '▾' : '▸';
  $('#chords-sum').textContent = prefs.chordsOpen ? '' : song.chords ? `${song.chords} · ${following.length ? following.map(t => t.name).join(', ') : 'no track'} follow${following.length === 1 ? 's' : ''}` : 'none';
  if (!prefs.chordsOpen) return;
  if (document.activeElement?.id === 'chord-text') return; // don't replace the box being typed in
  const key = song.scale ? M.scaleLabel(song.scale) : 'C major', ref = M.NOTE_NAMES[CH.referenceRoot(song, song.chords)];
  const tracks = song.tracks.map((t, ti) => isDrums(t) ? '' : `<label class="cfollow"><span class="dot" style="background:${COLORS[ti]}"></span>${esc(t.name)}
    <select data-act="follow" data-t="${ti}">${(t.mode === 'pool' ? POOL_FOLLOW : FOLLOW_OPTS).map(([v, l]) => `<option value="${v}" ${(t.mode === 'pool' ? (t.follow ? 'move' : '') : t.follow || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`).join('');
  el.innerHTML = `<div class="chord-edit">
      <input id="chord-text" data-act="chords" spellcheck="false" autocomplete="off" placeholder="e.g. Am | F | C | G  (| between bars)" value="${esc(song.chords)}"
        title="Bars separated by | ; chords in a bar share it (Am F = half a bar each); - holds the chord before; % repeats the bar before; N.C. = no chord">
      <select data-act="chords-common" title="Common progressions in the song's scale (set it in the top bar)"><option value="">Common in ${esc(key)}${song.scale ? '' : ' (no scale set)'}…</option>${
        CH.commonProgressions(song.scale).map(p => `<option value="${esc(p.text)}">${esc(p.name)}: ${esc(p.text.replaceAll(' | ', ' '))} · ${esc(p.numerals)}</option>`).join('')}</select>
      ${song.chords ? '<button class="ghost small" data-act="chords-clear">Clear</button>' : ''}
    </div>
    <div class="chord-show">${chordBarsHTML()}</div>
    <div class="chord-follow"><b>Tracks</b>${tracks || '<span class="hint">Only drum tracks: they never follow chords.</span>'}</div>
    <p class="hint"><b>Moves</b>: write the pattern in ${esc(ref)}; it follows each chord's root (basslines, riffs). <b>Fits</b>: notes go to the nearest chord note (chords, pads, melodies).${
      song.chords && !following.length ? ' <b>No track follows yet.</b>' : ''}</p>`;
  paintChords();
}
// Lights the chord playing now (about four times a second).
function paintChords() {
  const now = engine.playing && song.chords ? engine.chordFor(song, engine.tickAt(performance.now())) : null;
  $('#chord-now').textContent = now ? (now.chord ? now.chord.name : 'N.C.') : '';
  document.querySelectorAll('#chords .chord').forEach(b => b.classList.toggle('now', !!now && +b.dataset.bar === now.bar && +b.dataset.slot === now.slot));
}
setInterval(paintChords, 120);
// A chord clicked: heard on the selected track (or the first that isn't drums), around middle C.
function hearChord(c) {
  const ti = !isDrums(song.tracks[sel.t]) ? sel.t : song.tracks.findIndex(t => !isDrums(t));
  if (ti < 0 || !c) return;
  const stops = CH.chordPool(c, [60]).map(n => noteNow(ti, n, 90));
  setTimeout(() => stops.forEach(f => f?.()), 900);
}
$('#chords-col').onclick = () => { prefs.chordsOpen = !prefs.chordsOpen; savePrefs(); renderChords(); };
$('#chords').addEventListener('change', e => {
  const act = e.target.dataset.act;
  if (act === 'chords') { song.chords = M.cleanChords(e.target.value); changed(); e.target.blur(); renderChords(); renderSong(); }
  else if (act === 'chords-common' && e.target.value) { song.chords = e.target.value; changed(); renderChords(); renderSong(); }
  else if (act === 'follow') { const ti = +e.target.dataset.t; song.tracks[ti].follow = e.target.value || null; changed(); renderChords(); renderTrack(ti); }
});
$('#chords').addEventListener('keydown', e => { if (e.target.id === 'chord-text' && e.key === 'Enter') e.target.blur(); });
// While typing, the bars show what you've typed (the song changes when you press Enter or leave the box).
$('#chords').addEventListener('input', e => { if (e.target.id === 'chord-text') $('#chords .chord-show').innerHTML = chordBarsHTML(M.cleanChords(e.target.value)); });
$('#chords').addEventListener('click', e => {
  if (e.target.closest('[data-act="chords-clear"]')) { song.chords = ''; changed(); renderChords(); renderSong(); return; }
  const b = e.target.closest('button.chord');
  if (b) hearChord(CH.parseProgression(song.chords).bars[+b.dataset.bar]?.[+b.dataset.slot]);
});

// ---- the Mixer (mixer.js does the sound) ----
// One strip per track: level, pan, sends to the shared reverb and delay, how far it ducks when the
// side-chain source plays, which track that source is, mute and solo, and a meter. Hardware tracks
// get level and pan as CC 7 and CC 10; sends, ducking and meters are for computer sounds only.
// A master strip holds the shared reverb and delay and the duck release.
const pct = v => `${Math.round(v * 100)}%`;
const panText = v => (Math.abs(v) < 0.02 ? 'C' : `${Math.round(Math.abs(v) * 100)} ${v < 0 ? 'L' : 'R'}`);
function mixSlider(ti, key, label, v, min, max, step, text, help, disabled = false) {
  return `<label class="mx-row${disabled ? ' off' : ''}" title="${esc(help)}"><span>${label}</span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-mix="${key}" data-t="${ti}" ${disabled ? 'disabled' : ''}><b>${esc(text)}</b></label>`;
}
function renderMixer() {
  const el = $('#mixer');
  el.hidden = !prefs.mixOpen;
  $('#mix-col').textContent = prefs.mixOpen ? '▾' : '▸';
  const sc = song.tracks.find(t => t.sidechain);
  const mf = song.masterFx;
  $('#mix-sum').textContent = prefs.mixOpen ? '' : [sc && `${sc.name} ducks ${song.tracks.filter(t => t.duck > 0 && !t.sidechain).length} track(s)`, mf && `Master FX: ${mf.name}${mf.off ? ' (bypassed)' : ''}`].filter(Boolean).join(' · ');
  if (!prefs.mixOpen) return;
  if (el.contains(document.activeElement) && document.activeElement.type === 'range') return; // don't rebuild under a drag
  const m = song.mix;
  el.innerHTML = song.tracks.map((t, ti) => {
    const pc = t.out === M.COMPUTER, why = 'Computer sounds only: hardware plays through its own outputs';
    return `<div class="strip${t.mute ? ' muted' : ''}" data-t="${ti}">
      <div class="strip-name"><span class="dot" style="background:${COLORS[ti]}"></span>${esc(t.name)}</div>
      <div class="meter" title="${pc ? 'Level (peak)' : 'No meter for hardware'}"><i data-meter="${ti}"></i></div>
      ${mixSlider(ti, 'vol', 'Level', t.vol, 0, 127, 1, String(t.vol), 'Level (100 = as the sound was made); sent to hardware as CC 7')}
      ${mixSlider(ti, 'pan', 'Pan', t.pan, -1, 1, 0.01, panText(t.pan), 'Left to right; sent to hardware as CC 10')}
      ${mixSlider(ti, 'reverb', 'Reverb', t.reverb, 0, 1, 0.01, pct(t.reverb), pc ? 'How much goes to the shared reverb' : why, !pc)}
      ${mixSlider(ti, 'delay', 'Delay', t.delay, 0, 1, 0.01, pct(t.delay), pc ? 'How much goes to the shared delay' : why, !pc)}
      ${mixSlider(ti, 'duck', 'Duck', t.duck, 0, 1, 0.01, pct(t.duck), pc ? 'How far this track dips each time the side-chain source plays (its kicks, if it\'s a drum track)' : why, !pc || t.sidechain)}
      <div class="mx-btns">
        <label title="This track's notes duck the others (a drum track: its kicks only)"><input type="checkbox" data-mix="sidechain" data-t="${ti}" ${t.sidechain ? 'checked' : ''} ${pc ? '' : 'disabled'}> Side-chain</label>
        <button class="small${t.mute ? ' on' : ''}" data-mix="mute" data-t="${ti}">M</button><button class="small${t.solo ? ' on' : ''}" data-mix="solo" data-t="${ti}">S</button>
      </div>
    </div>`;
  }).join('') + `<div class="strip master">
      <div class="strip-name">Shared effects</div>
      ${mixSlider('m', 'revSize', 'Reverb', m.reverb.size, 0.3, 10, 0.1, `${m.reverb.size.toFixed(1)} s`, 'How long the shared reverb rings')}
      ${mixSlider('m', 'revDamp', 'Damping', m.reverb.damping, 0, 1, 0.01, pct(m.reverb.damping), 'How much faster its highs fade')}
      <label class="mx-row" title="The shared delay's echo time, locked to the tempo"><span>Delay</span><select data-mix="dlySync" data-t="m">${SYNC.filter(x => x !== 'off').map(x => `<option ${x === m.delay.sync ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      ${mixSlider('m', 'dlyFb', 'Echoes', m.delay.feedback, 0, 0.9, 0.01, pct(m.delay.feedback), 'How much each echo feeds the next')}
      ${mixSlider('m', 'dlyTone', 'Tone', m.delay.tone, 500, 16000, 100, `${Math.round(m.delay.tone / 100) / 10} kHz`, 'How bright the echoes are')}
      ${mixSlider('m', 'release', 'Release', m.release, 0.03, 1, 0.01, `${Math.round(m.release * 1000)} ms`, 'How long ducked tracks take to come back')}
    </div>${masterStrip()}`;
  startMeters();
}
// The last strip: Master FX, an effect rack on everything the computer plays (after the tracks, their
// sends and the shared effects; before the limiter). MIDI instruments play through their own outputs.
function masterStrip() {
  const fx = song.masterFx, chain = fx?.rack.modules.map(e => `<span class="${e.off ? 'off' : ''}">${esc(MODULES[e.type]?.label || e.type)}</span>`).join(' → ');
  return `<div class="strip master master-fx">
    <div class="strip-name" title="The end of the chain: every computer track, the shared reverb and delay, then these effects, then the limiter">Master FX</div>
    <label class="mx-row" title="An effect rack on the whole mix: a built-in one, or one you saved in the Sound Lab"><span>Rack</span><select data-act="mfx">${fxOptions(fx)}</select></label>
    ${fx ? `<div class="mfx-chain hint">${chain}</div>
    <label class="mx-row" title="How much of the mix goes through the rack (the rest stays dry)"><span>Mix</span><input type="range" data-act="mfx-mix" min="0" max="100" value="${Math.round(fx.mix * 100)}"><b>${Math.round(fx.mix * 100)}%</b></label>` : '<p class="hint">None. Pick a built-in rack, or build one in the Sound Lab.</p>'}
    <div class="mx-btns">
      ${fx ? `<button class="small ${fx.off ? 'ghost' : 'on'}" data-act="mfx-off" title="${fx.off ? 'Bypassed: click to hear the effects again' : 'On: click to bypass, to compare'}">${fx.off ? 'Bypassed' : 'On'}</button>` : ''}
      <button class="small" data-act="mfx-edit" title="Open these effects in the Sound Lab to change them, add or remove effects; the Sequencer plays your changes as you make them">${fx ? 'Edit' : 'Build'} in Sound Lab</button>
    </div>
  </div>`;
}
function setMix(el) {
  const k = el.dataset.mix, v = el.type === 'range' ? +el.value : el.value, m = song.mix;
  if (el.dataset.t === 'm') {
    if (k === 'revSize') m.reverb.size = v; else if (k === 'revDamp') m.reverb.damping = v;
    else if (k === 'dlySync') m.delay.sync = v; else if (k === 'dlyFb') m.delay.feedback = v;
    else if (k === 'dlyTone') m.delay.tone = v; else if (k === 'release') m.release = v;
  } else {
    const ti = +el.dataset.t, t = song.tracks[ti];
    if (k === 'sidechain') song.tracks.forEach((x, i) => { x.sidechain = i === ti && el.checked; });
    else t[k] = v;
    if (k === 'vol') { if (t.out === M.COMPUTER) labFor(ti); else sendVolume(t); }
    if (k === 'pan' && t.out !== M.COMPUTER) sendPan(t);
  }
  changed({ coalesce: true });
  syncFx();
  const b = el.closest('label')?.querySelector('b');
  if (b) b.textContent = k === 'pan' ? panText(v) : k === 'vol' ? String(v) : k === 'revSize' ? `${v.toFixed(1)} s` : k === 'dlyTone' ? `${Math.round(v / 100) / 10} kHz` : k === 'release' ? `${Math.round(v * 1000)} ms` : pct(v);
  if (k === 'sidechain') renderMixer();
}
$('#mixer').addEventListener('input', e => {
  if (e.target.dataset.mix) setMix(e.target);
  else if (e.target.dataset.act === 'mfx-mix' && song.masterFx) {
    song.masterFx.mix = +e.target.value / 100;
    e.target.closest('label').querySelector('b').textContent = `${e.target.value}%`;
    changed({ coalesce: true });
  }
});
$('#mixer').addEventListener('change', e => {
  if (e.target.dataset.mix && e.target.type !== 'range') setMix(e.target);
  else if (e.target.dataset.act === 'mfx') { song.masterFx = pickFx(e.target.value, song.masterFx); changed(); renderMixer(); }
});
$('#mixer').addEventListener('click', e => {
  const act = e.target.closest('button[data-act]')?.dataset.act;
  if (act === 'mfx-off' && song.masterFx) { if (song.masterFx.off) delete song.masterFx.off; else song.masterFx.off = true; changed(); renderMixer(); return; }
  if (act === 'mfx-edit') { editMasterFx(); return; }
  const b = e.target.closest('button[data-mix]');
  if (!b) return;
  const t = song.tracks[+b.dataset.t];
  if (b.dataset.mix === 'mute') edit(+b.dataset.t, () => { t.mute = !t.mute; });
  else { t.solo = !t.solo; changed(); }
  renderMixer(); renderTracks();
});
$('#mix-col').onclick = () => { prefs.mixOpen = !prefs.mixOpen; savePrefs(); renderMixer(); };
// Edit in Sound Lab: the Lab opens the master rack (or an empty one) linked to this song; every change
// there comes back as `rack-edit` and is heard at once, so you can tweak it while the song plays.
function editMasterFx() {
  const fx = song.masterFx;
  soundChannel?.postMessage({ type: 'edit-rack', link: 'master', song: song.name, name: fx?.name || `${song.name} master`, rack: fx?.rack || { name: 'Master', modules: [] } });
  parent.postMessage({ type: 'switch-view', view: 'lab' }, location.origin);
}
function onRackEdit(m) {
  if (m.link !== 'master') return;
  const was = song.masterFx;
  song.masterFx = M.cleanFx({ name: m.name, rack: { ...m.rack, name: m.name }, mix: was?.mix ?? 1, off: was?.off });
  changed({ coalesce: true });
  renderMixer();
}
// ⤓ Render song: the whole song offline (songrender.js) into Capture's Recordings, as one mix and,
// if asked, one file per computer track (stems: each with its own sends and ducking).
let rendering = false;
function renderBar(html) { const el = $('#render-bar'); el.hidden = !html; el.innerHTML = html || ''; }
$('#render-song').onclick = () => {
  if (rendering) return;
  const n = song.tracks.filter((t, ti) => t.out === M.COMPUTER && M.audible(song, ti)).length;
  renderBar(n ? `<span>Render "${esc(song.name)}" once through its sections:</span>
    <button class="small" data-render="mix">Mix</button>
    <button class="small" data-render="stems">Mix + stems (${n} track${n === 1 ? '' : 's'})</button>
    <button class="ghost small" data-render="cancel">Cancel</button>`
    : `<span>Nothing to render: only computer sounds can be rendered (hardware: Capture's Print stems).</span> <button class="ghost small" data-render="cancel">OK</button>`);
};
$('#render-bar').addEventListener('click', async e => {
  const k = e.target.closest('[data-render]')?.dataset.render;
  if (!k) return;
  if (k === 'cancel') { renderBar(''); return; }
  rendering = true;
  const t0 = performance.now(), base = `${stemOf(song.name)} ${stamp(Date.now())}`;
  try {
    const r = await renderSongAudio(song, { stems: k === 'stems', onProgress: what => renderBar(`<span>Rendering ${esc(what)}…</span>`) });
    renderBar('<span>Saving…</span>');
    const saved = [];
    const len = r.mix && soundLength(r.mix, r.sampleRate); // stems the mix's length, so they line up
    const save = async (chans, name) => { saved.push(await storage.save('audio', encodeWav(finishRender(chans, r.sampleRate, len || undefined), r.sampleRate), name)); };
    if (r.mix) await save(r.mix, `${base} (mix)`);
    for (const st of r.stems) await save(st.chans, `${base} (${stemOf(st.name)})`);
    soundChannel?.postMessage({ type: 'recordings-changed' });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    renderBar(`<span>Saved ${saved.length} file${saved.length === 1 ? '' : 's'} to Capture's Recordings (${Math.round(r.seconds)} s of song in ${secs} s).${
      r.missing.length ? ` Not included (hardware): ${esc(r.missing.join(', '))}; Capture's Print stems records those.` : ''}</span>
      <button class="ghost small" data-render="cancel">OK</button>`);
  } catch (err) {
    renderBar(`<span>Couldn't render: ${esc(err.message)}</span> <button class="ghost small" data-render="cancel">OK</button>`);
  } finally { rendering = false; }
});
// Meters: peak level in dB (-48 … 0), about 20 times a second while the mixer is open. (A timer, not
// animation frames: frames started while this tab's frame was hidden never came.)
let meterTimer = null;
function startMeters() {
  if (meterTimer) return;
  meterTimer = setInterval(() => {
    if (!prefs.mixOpen) { clearInterval(meterTimer); meterTimer = null; return; }
    if (!mixer || !onScreen()) return; // (no mixer until the first computer note)
    for (const [ti, pk] of mixer.levels()) {
      const i = document.querySelector(`#mixer [data-meter="${ti}"]`);
      if (!i) continue;
      const db = pk > 0 ? 20 * Math.log10(pk) : -99;
      i.style.width = `${Math.max(0, Math.min(100, (db + 48) / 48 * 100))}%`;
      i.classList.toggle('hot', db > -1);
    }
  }, 50);
}

function renderTop() {
  postSeqState();
  setQwertyScale(song.scale); // chord mode builds chords in the song's scale
  const setVal = (el, v) => { if (document.activeElement !== el) el.value = v; };
  setVal($('#bpm'), song.bpm);
  $('#meter').value = song.meter;
  setVal($('#swing'), song.swing);
  $('#swing-val').textContent = `${song.swing}%`;
  $('#scale-type').value = song.scale ? song.scale.type : '';
  $('#scale-root').value = song.scale ? song.scale.root : 0;
  $('#scale-root').disabled = !song.scale;
  document.querySelectorAll('#mode button').forEach(b => b.classList.toggle('on', b.dataset.m === prefs.mode));
  $('#follow').checked = prefs.follow;
  syncFx();
}

function renderFileBar() {
  const name = $('#song-name');
  if (document.activeElement !== name) name.value = song.name;
  $('#dirty').hidden = !dirty;
  $('#dirty').textContent = fileName ? 'unsaved changes' : 'not saved yet';
  $('#delete').disabled = !fileName;
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  document.title = `${song.name}${dirty ? ' •' : ''} · Ostinato`;
  postSeqState();
}

// ---- the arrangement timeline: the song's sections left to right, each as wide as its bars ----
// Rows: the sections (click one to edit it in the bar above), bar numbers, the chord on each bar
// (when there's a chord track), and each track's pattern per section (click to change it; faint
// marks show where a shorter pattern starts again). While the song plays a line shows where it is.
let songSel = 0; // the section shown in the section bar
let loopSec = null; // a section played over and over (Loop it), or null
const secStarts = () => { let a = 0; return song.song.map(s => { const at = a; a += s.bars; return at; }); };
function renderSong() {
  const el = $('#song');
  el.hidden = !prefs.songOpen;
  $('#song-col').textContent = prefs.songOpen ? '▾' : '▸';
  songSel = Math.min(songSel, song.song.length - 1);
  if (loopSec !== null && loopSec >= song.song.length) loopSec = null;
  engine.loopSection = loopSec;
  if (!prefs.songOpen) { paintSong(); return; }
  const starts = secStarts(), total = starts.at(-1) + song.song.at(-1).bars, sec = song.song[songSel];
  const bw = Math.max(26, Math.min(90, Math.floor(((el.clientWidth || 900) - 140) / total)));
  const col = b => b + 2, prog = song.chords ? CH.progression(song.chords).bars : [];
  const barOpts = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32].concat(sec.bars).filter((n, k, a) => a.indexOf(n) === k).sort((a, b) => a - b);
  const tools = `<div class="sec-tools">
      <b>Section ${songSel + 1}</b>
      <input data-act="sec-name" maxlength="24" spellcheck="false" placeholder="Name it (Intro, Verse…)" value="${esc(sec.name || '')}">
      <label class="field">Bars <select data-act="bars" data-sec="${songSel}">${barOpts.map(n => `<option ${n === sec.bars ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="field" title="This section's time signature, or the song's">Time <select data-act="sec-meter" data-sec="${songSel}" class="${sec.meter ? 'own' : ''}">
        <option value="">${esc(song.meter)}</option>${M.METERS.filter(m => m !== song.meter).map(m => `<option ${m === sec.meter ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <button class="small" data-act="sec-play" title="Play the song from this section (while playing: go there at the next bar)">▶ Play from here</button>
      <button class="small${loopSec === songSel ? ' on' : ''}" data-act="sec-loop" title="Play this section over and over, e.g. while working on it">⟳ Loop it</button>
      <button class="ghost small" data-act="sec-dup" title="Put a copy of this section after it">Duplicate</button>
      <button class="ghost small" data-act="sec-move" data-d="-1" ${songSel ? '' : 'disabled'} title="Move it earlier">◀</button><button class="ghost small" data-act="sec-move" data-d="1" ${songSel < song.song.length - 1 ? '' : 'disabled'} title="Move it later">▶</button>
      <button class="ghost small" data-act="del-sec" ${song.song.length > 1 ? '' : 'disabled'}>Remove</button>
      <span class="spacer"></span><button class="small" data-act="add-sec" title="Add a section at the end (a copy of the last one)">+ Section</button>
      <div class="sec-fills"><span class="hl" title="A track can play another pattern in this section's last bar, e.g. a drum fill into the next section (also when it's silent in the section)">Fill in the last bar</span>
        ${song.tracks.map((t, ti) => `<label class="field"><span class="dot" style="background:${COLORS[ti]}"></span>${esc(t.name)} <select data-act="sec-fill" data-t="${ti}">${options([['', '—'], ...M.PATTERNS.map(p => [p, p])], sec.fill?.[ti] || '')}</select></label>`).join('')}</div>
    </div>`;
  const secRow = song.song.map((x, i) => `<button class="tl-sec${i === songSel ? ' sel' : ''}${loopSec === i ? ' looping' : ''}" data-act="sec-pick" data-sec="${i}" style="grid-column:${col(starts[i])} / span ${x.bars}"
      title="${esc(x.name || `Section ${i + 1}`)}: ${x.bars} bar${x.bars > 1 ? 's' : ''}${x.meter ? ` of ${x.meter}` : ''}">${loopSec === i ? '⟳ ' : ''}${esc(x.name || `Section ${i + 1}`)}${x.meter ? ` <small>${x.meter}</small>` : ''}</button>`).join('');
  const barRow = Array.from({ length: total }, (_, b) => `<div class="tl-bar${starts.includes(b) ? ' first' : ''}" style="grid-column:${col(b)}">${b + 1}</div>`).join('');
  const chordRow = prog.length ? `<button class="tl-label" data-act="open-chords" title="The chord track (open it to change it)">Chords</button>` + Array.from({ length: total }, (_, b) => {
    const cs = prog[b % prog.length].map(c => (c ? c.name : 'N.C.'));
    return `<div class="tl-chord${starts.includes(b) ? ' first' : ''}" style="grid-column:${col(b)}" title="Bar ${b + 1}: ${esc(cs.join(' '))}">${esc(cs.join(' '))}</div>`;
  }).join('') : '';
  const trackRows = song.tracks.map((t, ti) => `<div class="tl-label"><span class="dot" style="background:${COLORS[ti]}"></span>${esc(t.name)}</div>` + song.song.map((x, i) => {
    const p = x.play[ti], pat = p && t.patterns[p];
    const per = pat ? M.spanOf(pat, M.RATES[t.rate]) / M.barTicks(M.meterAt(song, i)) : 0; // the pattern's length in bars
    const f = x.fill?.[ti], body = f ? x.bars - 1 : x.bars; // the fill takes the last bar
    const marks = per && per < body ? Array.from({ length: Math.min(64, Math.ceil(body / per) - 1) }, (_, k) => `<i style="left:${((k + 1) * per / x.bars) * 100}%"></i>`).join('') : '';
    return `<button class="tl-cell${p ? '' : ' rest'}${f ? ' has-fill' : ''}" data-act="cell" data-sec="${i}" data-t="${ti}" style="grid-column:${col(starts[i])} / span ${x.bars};--c:${COLORS[ti]}"
      title="${esc(t.name)} in ${esc(x.name || `section ${i + 1}`)}: ${p ? `pattern ${p}` : 'silent'}${f ? `, then fill ${f} in the last bar` : ''}. Click to change: A → B → C → D → silent">${marks}<span>${p || '–'}</span>${f ? `<b class="tl-fill" style="left:${((x.bars - 1) / x.bars) * 100}%">${f} fill</b>` : ''}</button>`;
  }).join('')).join('');
  el.innerHTML = `${tools}<div class="timeline-wrap"><div class="timeline" style="grid-template-columns:120px repeat(${total}, ${bw}px);--bw:${bw}px">
      <div class="tl-label">Sections</div>${secRow}<div class="tl-label hint">Bar</div>${barRow}${chordRow}${trackRows}${autoHTML(total, bw)}
      <div class="tl-head" id="tl-head" hidden></div></div></div>
    <div class="hint">Click a section to change it above, or a track's box to choose its pattern there (– = silent). Patterns shorter than their section repeat within it. A bar is ${barWords(song.meter)}${song.song.some(x => x.meter) ? ', or as its section says' : ''}. The song repeats from the top.</div>`;
  paintSong();
}

// Automation lanes: one row each, a line through its points across the whole song. Click to add a
// point (snapped to a quarter bar; ⇧ for anywhere), drag one to move it, right-click or ⌥-click to
// remove it. The add row picks a track and what to automate.
const AUTO_H = 44;
const autoPick = { ti: 0, target: 'filter', cc: 1 }; // what + Lane adds
const autoName = l => (l.target === 'cc' ? `CC ${l.cc}` : M.AUTO_TARGETS[l.target]);
const autoText = (l, v) => (l.target === 'filter' ? `${Math.round(60 * (20000 / 60) ** v)} Hz` : l.target === 'level' ? `${Math.round(v * 100)}%` : String(Math.round(v * 127)));
function autoHTML(total, bw) {
  const w = total * bw, rows = (song.auto || []).map((l, k) => {
    const t = song.tracks[l.ti], y = v => (1 - v) * (AUTO_H - 8) + 4, pts = l.points;
    const line = pts.length ? [[0, pts[0].v], ...pts.map(p => [p.at * bw, p.v]), [w, pts.at(-1).v]].map(([x, v]) => `${x.toFixed(1)},${y(v).toFixed(1)}`).join(' ') : '';
    return `<div class="tl-label auto-label" title="${esc(t.name)}: ${autoName(l)}"><span class="dot" style="background:${COLORS[l.ti]}"></span>${esc(t.name)} · ${autoName(l)}
        <button class="ghost small x" data-act="auto-del" data-k="${k}" title="Remove this lane">✕</button></div>
      <div class="tl-auto" data-k="${k}" style="grid-column:2 / span ${total};--c:${COLORS[l.ti]};height:${AUTO_H}px">
        <svg width="${w}" height="${AUTO_H}"><polyline points="${line}"/></svg>
        ${pts.map((p, j) => `<i class="ap" data-p="${j}" style="left:${p.at * bw}px;top:${y(p.v)}px" title="Bar ${Math.floor(p.at) + 1}${p.at % 1 ? ` + ${Math.round((p.at % 1) * 100)}%` : ''}: ${autoText(l, p.v)}"></i>`).join('')}
        ${pts.length ? '' : '<span class="hint">Click to add a point</span>'}
      </div>`;
  }).join('');
  const hw = ti => song.tracks[ti]?.out !== M.COMPUTER;
  const at = Math.min(song.tracks.length - 1, Math.max(0, autoPick.ti));
  return `${rows}<div class="tl-label">Automation</div><div class="auto-add" style="grid-column:2 / -1">
    <select data-act="auto-ti">${song.tracks.map((t, ti) => `<option value="${ti}" ${ti === at ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    <select data-act="auto-target">${Object.entries(M.AUTO_TARGETS).filter(([k]) => k !== 'cc' || hw(at)).map(([k, l]) => `<option value="${k}" ${k === autoPick.target ? 'selected' : ''}>${l}</option>`).join('')}</select>
    ${hw(at) && autoPick.target === 'cc' ? `<label class="field">CC <input type="number" data-act="auto-cc" min="1" max="119" value="${autoPick.cc}"></label>` : ''}
    <button class="small" data-act="auto-add" ${(song.auto || []).length >= M.MAX_AUTO ? 'disabled' : ''}>+ Lane</button>
    <span class="hint">Plays in Play song mode. Level rides the track's level; Filter sweeps a low-pass from closed to open (hardware: CC 7, CC 74).</span></div>`;
}
// Lights the playing section and moves the playhead (also called on every bar).
function paintSong() {
  const now = engine.playing && engine.mode === 'song' ? live.section : -1;
  document.querySelectorAll('#song .tl-sec').forEach(e => e.classList.toggle('now', +e.dataset.sec === now));
  const bars = song.song.reduce((n, x) => n + x.bars, 0);
  $('#song-sum').textContent = prefs.songOpen ? '' : `${song.song.length} sections · ${bars} bars`
    + (now >= 0 ? ` · playing ${song.song[now]?.name || `section ${now + 1}`}, bar ${live.bar + 1}/${song.song[now]?.bars}` : '');
  moveHead();
}
function moveHead() {
  const head = document.getElementById('tl-head');
  if (!head) return;
  const on = engine.playing && engine.mode === 'song' && performance.now() >= (live.startAt || 0) && song.song[live.section];
  head.hidden = !on;
  if (!on) return;
  const bw = parseFloat(head.parentElement.style.getPropertyValue('--bw')) || 40;
  const barMs = engine.tickMs * M.barTicks(live.meter || song.meter), into = Math.min(0.999, Math.max(0, (performance.now() - live.barAt) / barMs));
  head.style.left = `${120 + (secStarts()[live.section] + live.bar + into) * bw}px`;
}

// Drawing automation: click to add a point and drag it; drag a point to move it; right-click or
// ⌥-click one to remove it. One undo step per gesture.
$('#song').addEventListener('pointerdown', e => {
  const lane = e.target.closest('.tl-auto');
  if (!lane || e.button !== 0) return;
  e.preventDefault();
  const l = song.auto[+lane.dataset.k], r = lane.getBoundingClientRect();
  const bw = parseFloat(lane.closest('.timeline').style.getPropertyValue('--bw')) || 40, total = r.width / bw;
  const pos = ev => {
    let at = Math.max(0, Math.min(total, (ev.clientX - r.left) / bw));
    if (!ev.shiftKey) at = Math.round(at * 4) / 4;
    return { at, v: Math.round(Math.max(0, Math.min(1, 1 - (ev.clientY - r.top - 4) / (AUTO_H - 8))) * 1000) / 1000 };
  };
  const hit = e.target.closest('.ap');
  let p = hit && l.points[+hit.dataset.p];
  if (p && e.altKey) { l.points.splice(l.points.indexOf(p), 1); changed(); renderSong(); return; }
  if (!p) { p = pos(e); l.points.push(p); l.points.sort((a, b) => a.at - b.at); renderSong(); }
  const move = ev => { Object.assign(p, pos(ev)); l.points.sort((a, b) => a.at - b.at); renderSong(); };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); changed(); renderSong(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});
$('#song').addEventListener('contextmenu', e => {
  const hit = e.target.closest('.tl-auto .ap');
  if (!hit) return;
  e.preventDefault();
  song.auto[+hit.closest('.tl-auto').dataset.k].points.splice(+hit.dataset.p, 1);
  changed();
  renderSong();
});

// Play from a section in song mode (while playing: go there at the next bar).
function playFrom(i) {
  if (prefs.mode !== 'song') { prefs.mode = 'song'; savePrefs(); engine.setMode('song'); renderTop(); }
  if (engine.playing) engine.jumpTo = i;
  else play({ from: i });
}

function renderTracks() {
  postSeqState();
  syncViews();
  $('#tracks').innerHTML = song.tracks.map((_, ti) => trackHTML(ti)).join('');
  song.tracks.forEach((_, ti) => paintPlayhead(ti));
  $('#add-track').disabled = song.tracks.length >= M.MAX_TRACKS;
  renderMixer(); // names, mutes and tracks added or removed
}

function renderTrack(ti) {
  if (ti === sel.t) postSeqState();
  const el = document.getElementById(`trk-${ti}`);
  if (!el) return renderTracks();
  // Keep the cursor in a text box that's being typed in (redraws happen while playing).
  const focused = el.contains(document.activeElement) && document.activeElement.matches('input[type=text], input:not([type])')
    ? { act: document.activeElement.dataset.act, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  el.outerHTML = trackHTML(ti);
  paintPlayhead(ti);
  setTimeout(postSeqState); // the top bar's LCD shows the XL's track and the armed one (deduplicated; later, as this can run while the page loads)
  if (focused) {
    const input = document.querySelector(`#trk-${ti} [data-act="${focused.act}"]`);
    if (input && !input.disabled) { input.focus(); input.setSelectionRange(focused.start, focused.end); }
  }
}

function refreshGrid(ti) {
  const el = document.querySelector(`#trk-${ti} .grid-wrap`);
  if (el) { el.innerHTML = gridHTML(ti) + (views[ti].collapsed ? '' : ccHTML(ti)); paintPlayhead(ti); }
}

function trackHTML(ti) {
  const t = song.tracks[ti], v = views[ti];
  const editing = sel.t === ti && sel.open && !v.collapsed;
  const muted = !M.audible(song, ti);
  return `<section class="track${v.collapsed ? ' collapsed' : ''}${sel.t === ti ? ' selected' : ''}${muted ? ' muted' : ''}${armed === ti ? ' armed' : ''}" id="trk-${ti}" data-t="${ti}">
    <div class="track-head" data-act="head">${headHTML(ti)}</div>
    ${v.feelOpen && !v.collapsed ? feelHTML(ti) : ''}
    ${v.ai.open && !v.collapsed ? aiHTML(ti) : ''}
    ${v.lib.open && !v.collapsed ? libHTML(ti) : ''}
    ${v.snd.open && !v.collapsed ? sndHTML(ti) : ''}
    ${v.ideas.list.length && !v.collapsed ? ideasHTML(ti) : ''}
    ${editing ? editorHTML(ti) : ''}
    <div class="grid-wrap">${gridHTML(ti)}${v.collapsed ? '' : ccHTML(ti)}</div>
    ${t.mode === 'pool' ? poolHTML(ti) : ''}
  </section>`;
}

// A Computer track's sound, from the sound picker: an Ostinato Synth sound (factory or yours) or a
// test voice. Each pick is heard at once; picks while the picker is open are one undo step.
function pickTrackSound(ti, anchor) {
  const t = song.tracks[ti];
  openSoundPicker({
    anchor, title: `Sound for ${t.name}`, instruments: ['synth'], outputs,
    current: t.inst ? `inst:${t.inst.name}` : `voice:${t.voice}`,
    isCurrent: e => t.inst && e.name === t.inst.name && JSON.stringify(e.sound.patch) === JSON.stringify(t.inst.patch),
    extra: [{ label: 'Test voices', items: M.VOICES.map(v => ({ key: `voice:${v}`, name: v, note: 'simple test sound', sound: { kind: 'voice', voice: v } })) }],
    onPick(item) {
      const s = item.sound;
      edit(ti, () => { if (s.kind === 'voice') { t.voice = s.voice; t.inst = null; } else t.inst = M.cleanInst({ name: s.name, patch: s.patch }); }, { coalesce: true });
      synth.wake();
      preview(ti, !t.inst && t.voice === 'Drums' ? 36 : 48);
    },
  });
}

const options = (list, current) => list.map(([value, label]) =>
  `<option value="${esc(value)}" ${String(value) === String(current) ? 'selected' : ''}>${esc(label)}</option>`).join('');

function headHTML(ti) {
  const t = song.tracks[ti], v = views[ti], pat = viewPattern(ti);
  const outs = outputs();
  const outList = [[M.COMPUTER, 'Computer (test sound)'], ...outs.map(p => [p.name, portLabel(p)])];
  const missing = t.out !== M.COMPUTER && !outs.some(p => p.name === t.out);
  if (missing) outList.push([t.out, `${t.out} (not connected)`]);
  const queued = engine.queued.get(ti);
  const playingPat = engine.playing && !live.silent[ti] ? live.pattern[ti] : null;
  // The rest of the settings show on the selected track only, so headers stay short.
  const more = sel.t === ti && !v.collapsed;
  const device = t.out === M.COMPUTER ? 'Computer' : deviceOf(t.out)?.name || outList.find(o => o[0] === t.out)?.[1].replace(/ \(not connected\)$/, '') || t.out;
  const soundName = t.out === M.COMPUTER ? (t.inst ? t.inst.name : `${t.voice} (test voice)`) : isXLOut(t.out) ? (t.sound?.name || 'no sound kept') : t.program != null ? `program ${t.program + 1}` : '';
  return `
    <div class="th-row">
    <button class="ghost collapse" data-act="col" title="${v.collapsed ? 'Expand' : 'Collapse'}">${v.collapsed ? '▸' : '▾'}</button>
    <span class="track-name"><span class="dot" style="background:${COLORS[ti]}"></span><input data-act="name" value="${esc(t.name)}" maxlength="24" spellcheck="false" aria-label="Track name"></span>
    <select class="role-pick" data-act="role" title="What this track is for: Drums gets the drum-lane editor; the role also sets the ideas (🎲, AI, library) and the sounds it's offered">${options(Object.entries(M.ROLES), M.roleOf(t))}</select>
    <span class="hgrp"><span class="hl">Pattern</span><span class="pats">${M.PATTERNS.map(p => `<button data-act="pat" data-p="${p}"
      class="${v.pat === p ? 'on' : ''}${queued === p ? ' queued' : ''}${playingPat === p ? ' live' : ''}"
      title="${p === playingPat ? 'Playing' : queued === p ? 'Starts at the next bar' : `Show pattern ${p}`}">${p}</button>`).join('')}</span></span>
    <span class="hgrp head-extra-ideas"><span class="hl">Ideas</span>
      <button class="ghost" data-act="dice" title="Generate: an instant idea for pattern ${v.pat} (no AI). Click again for another.">${icon('generate')}</button>
      <button class="ghost" data-act="mutate" title="Mutate: a variation of pattern ${v.pat} as it is now (no AI). Click again for another.">${icon('mutate')}</button>
      <button class="${v.ai.open ? 'on' : 'ghost'} ai-btn" data-act="ai" title="Ask the AI to write patterns for this track">${icon('ai')}</button>
      <button class="${v.lib.open ? 'on' : 'ghost'} ai-btn" data-act="lib" title="Library: stock and saved patterns">${icon('library')}</button>
      <button class="ghost" data-act="star" title="Save pattern ${v.pat} to your library">${icon('save')}</button></span>
    <span class="spacer"></span>
    <button class="plays${missing ? ' missing' : ''}" data-act="plays" title="Where this track's notes go and its sound: click to choose ${t.out === M.COMPUTER ? 'another sound' : isXLOut(t.out) ? 'another XL sound (try them while it plays)' : 'its program'}">${icon('route')}<b>${esc(device)}</b>${t.out !== M.COMPUTER ? `<span class="dim">ch ${t.ch}</span>` : ''}${soundName ? `<span class="dim">·</span>${esc(soundName)}` : ''}${missing ? '<span class="dim">not connected</span>' : ''}</button>
    ${liveSound === ti ? '<span class="badge xl" title="This track\'s sound is the one on the microKORG XL now; edits in the XL editor are kept for it">on the XL now</span>' : ''}
    ${t.follow && !isDrums(t) && song.chords ? `<span class="badge follow" title="This track follows the chord track (Chords, above the Mixer)">♪ ${followText(t)}</span>` : ''}
    ${armed === ti ? `<span class="badge armed" title="Notes you play on your keyboard go into this track">${icon('arm')} armed: keys add notes here</span>` : ''}
    <span class="ms">
      <button data-act="arm" class="${armed === ti ? 'arm-on' : ''}" title="${armed === ti ? 'Armed: notes you play go into this track. Click to disarm.' : 'Arm: notes you play on your keyboard go into this track (steps when stopped, the note pool when latched). Double-click the track header to arm too.'}">${icon('arm')}</button>
      <button data-act="mute" class="${t.mute ? 'm-on' : ''}" title="Mute: silence this track">M</button>
      <button data-act="solo" class="${t.solo ? 's-on' : ''}" title="Solo: hear only soloed tracks">S</button>
    </span>
    </div>
    ${more ? `<div class="th-row th-more">
    <span class="hgrp"><span class="hl">Edit</span><span class="tools">
      <button class="ghost" data-act="copy" title="Copy pattern ${v.pat}">Copy</button>
      <button class="ghost" data-act="paste" title="Replace pattern ${v.pat} with the copied pattern" ${clipboard ? '' : 'disabled'}>Paste</button>
      <button class="ghost" data-act="clear" title="Remove every note in pattern ${v.pat}">Clear</button></span></span>
    <span class="hgrp"><span class="hl">Steps</span>
      <label class="field" title="Any length from 1 to ${M.MAX_STEPS} steps${M.stepsPerBar(song.meter, M.RATES[t.rate]) ? ` (one bar of ${song.meter} = ${M.stepsPerBar(song.meter, M.RATES[t.rate])})` : ''}">Length <input type="number" data-act="len" min="1" max="${M.MAX_STEPS}" value="${pat.length}"></label>
      <label class="field${pat.beats ? ' fit-on' : ''}" title="Spread the steps evenly over this many beats instead of one ${t.rate} each: 5 steps in 4 beats plays five against the other tracks' four (a polyrhythm); 3 in 2 is a triplet feel">Fit <select data-act="fit">
        <option value="">off</option>${Array.from({ length: 16 }, (_, k) => k + 1).map(b => `<option value="${b}"${pat.beats === b ? ' selected' : ''}>in ${b} beat${b > 1 ? 's' : ''}</option>`).join('')}</select></label>
      <label class="field" title="How long each step is">Rate <select data-act="rate">${options(Object.keys(M.RATES).map(r => [r, r]), t.rate)}</select></label>
      <label class="field${t.feel ? ' fit-on' : ''}" title="Humanise: move notes a little early or late and vary how hard they're played, at random or by drum (e.g. a lazy snare)">Feel <select data-act="feel">
        ${options([['Tight', 'tight'], ...Object.keys(M.FEEL_PRESETS).filter(k => k !== 'Tight').map(k => [k, k.toLowerCase()]), ...(t.feel && !t.feel.preset ? [['__custom', 'custom']] : [])], t.feel ? t.feel.preset || '__custom' : 'Tight')}</select></label>
      <button class="${v.feelOpen ? 'on' : 'ghost'} small" data-act="feel-edit" title="Adjust the feel: timing, velocity, and how early or late each drum plays">Adjust…</button>
      <span class="seg-btn">
        <button data-act="mode" data-m="steps" class="${t.mode === 'steps' ? 'on' : ''}" title="Each step plays its own notes">Steps</button>
        <button data-act="mode" data-m="pool" class="${t.mode === 'pool' ? 'on' : ''}" title="Steps set the rhythm; notes come from the pool">Note pool</button>
      </span>${hasRoll(ti) ? `<span class="seg-btn" title="How the pattern is shown: blocks (one per step) or a piano roll (pitch up the side, each note its own length)">
        <button data-act="view" data-v="blocks" class="${v.roll ? '' : 'on'}">Blocks</button>
        <button data-act="view" data-v="roll" class="${v.roll ? 'on' : ''}">Piano roll</button></span>` : ''}</span>
    <span class="hgrp"><span class="hl">Sound</span>
      <label class="field">Out <select data-act="out" class="${missing ? 'missing' : ''}">${options(outList, t.out)}</select></label>
      ${t.out === M.COMPUTER
        ? `<label class="field" title="An Ostinato Synth sound from the Sound Lab, or a simple test voice">Sound <button class="sound-btn-pick" data-act="pick-sound">${icon('keys')} ${esc(t.inst ? t.inst.name : `${t.voice} (test voice)`)} ▾</button></label>`
        + fxHTML(t.fx, 'fx', 'this track')
        : `<label class="field">Ch <select data-act="ch">${options(Array.from({ length: 16 }, (_, c) => [c + 1, c + 1]), t.ch)}</select></label>`}
      ${isXLOut(t.out) ? `<button class="ghost sound-btn${liveSound === ti ? ' live' : ''}" data-act="sound" title="${t.sound
          ? 'This track\'s XL sound, sent to the XL when playback starts. Click to send it now and edit it in the microKORG XL editor; your edits there are remembered.'
          : `Remember the sound the microKORG XL editor has now${editorSound ? ` (${esc(editorSound.name)})` : ''}`}">${icon('knob')} ${t.sound ? esc(t.sound.name || 'Sound') : `Use ${editorSound ? `“${esc(editorSound.name)}”` : 'editor sound'}`}</button>
        <button class="${v.snd.open ? 'on' : 'ghost'} small" data-act="snd" title="Try other XL sounds on this track while it plays">Browse</button>`
        : t.out !== M.COMPUTER ? `<label class="field" title="Program Change sent to this instrument when playback starts (and when you change it)">Prog
          <select data-act="prog"><option value="">—</option>${Array.from({ length: 128 }, (_, n) => `<option value="${n}" ${t.program === n ? 'selected' : ''}>${n + 1}</option>`).join('')}</select></label>` : ''}
      <label class="field" title="${t.out === M.COMPUTER ? 'Volume of this track\'s computer sound' : 'Volume, sent to the instrument as MIDI CC 7 (when you move it, and at play if not 100)'}">Vol
        <input type="range" class="vol" data-act="vol" min="0" max="127" value="${t.vol}"></label></span>
    <span class="spacer"></span>
    <button class="ghost small" data-act="del-track" title="Remove this track">${'✕'} Remove track</button>
    </div>` : ''}`;
}



// ---- Feel (humanise): a panel of sliders for the track's feel (model.js cleanFeel/feelNote) ----

function feelHTML(ti) {
  const t = song.tracks[ti], f = t.feel || { time: 0, vel: 0, shift: 0, push: {} };
  const row = (key, label, min, max, v, help, unit = 'ms') => `<label class="field feel-row" title="${esc(help)}">${label}
    <input type="range" data-act="feel-set" data-k="${key}" min="${min}" max="${max}" value="${v}"><span class="val">${v > 0 && min < 0 ? '+' : ''}${v}${unit ? ` ${unit}` : ''}</span></label>`;
  const drums = isDrums(t) ? lanesOf(ti) : [];
  return `<div class="ai-panel feel-panel">
    <div class="ai-row"><span class="ai-mark">Feel</span><span class="hint">Notes are moved and varied as they play; the pattern itself doesn't change. + is late, − is early.</span>
      <span class="spacer"></span><button class="ghost small x" data-act="feel-edit" title="Close">✕</button></div>
    <div class="ai-row feel-rows">
      ${row('time', 'Timing', 0, 40, f.time, 'Each note up to this much early or late, at random')}
      ${row('vel', 'Velocity', 0, 40, f.vel, 'Each note up to this much softer or harder, at random', '')}
      ${row('shift', 'Whole track', -60, 60, f.shift, 'Every note of this track this much early (−) or late (+): behind or ahead of the beat')}
    </div>
    ${drums.length ? `<div class="ai-row feel-rows">${drums.map(n => row(`push:${n}`, esc(laneName(ti, n)), -60, 60, f.push[n] || 0, `${laneName(ti, n)} always this much early (−) or late (+): a lazy snare, pushed hats…`)).join('')}</div>` : ''}
  </div>`;
}
function setFeel(ti, key, value) {
  const t = song.tracks[ti], f = t.feel ? { ...t.feel, push: { ...t.feel.push } } : { time: 0, vel: 0, shift: 0, push: {} };
  delete f.preset; // changed by hand: "custom"
  if (key.startsWith('push:')) f.push[key.slice(5)] = value; else f[key] = value;
  t.feel = M.cleanFeel(f);
}

// ---- Sound browser: try XL sounds on a track while it plays ----
// Clicking a sound sends it straight to the XL (nothing is saved); Use keeps it for the track;
// closing the browser puts the track's own sound back.

const newSnd = () => ({ open: false, q: '', type: 'auto', bank: 'all', trying: null });
let sounds = null; // loaded the first time a browser opens
// The sound library of a track's device (its sound types, bank names...).
const libOf = ti => deviceOf(song.tracks[ti].out)?.sounds || { ROLE_TYPES: {}, bankLabel: b => b, MY_BANK: '', load: async () => [] };

function sndItems(ti) {
  const t = song.tracks[ti], f = views[ti].snd, role = M.roleOf(t), { ROLE_TYPES, bankLabel, MY_BANK } = libOf(ti);
  const want = f.type === 'auto' ? ROLE_TYPES[role] || [] : f.type === 'all' ? null : [f.type];
  const q = f.q.trim().toLowerCase();
  return (sounds || []).filter(x => (!want || want.includes(x.type)) && (f.bank === 'all' || x.bank === f.bank)
    && (!q || `${x.name} ${x.type} ${bankLabel(x.bank)}`.toLowerCase().includes(q)))
    // Best-suited types first, then My Sounds, then the order of the files.
    .map((x, k) => ({ x, k, r: (want ? want.indexOf(x.type) : 0) * 2 + (x.bank === MY_BANK ? 0 : 1) }))
    .sort((a, b) => a.r - b.r || a.k - b.k).map(({ x }) => x);
}

function sndRows(ti) {
  const { bankLabel } = libOf(ti);
  if (!sounds) return '<div class="hint">Loading sounds…</div>';
  const items = sndItems(ti), f = views[ti].snd;
  if (!items.length) return '<div class="hint">Nothing matches. Try Type: All.</div>';
  return items.slice(0, 400).map(x => `<div class="lib-item snd-item${f.trying === x.key ? ' on' : ''}" data-act="snd-try" data-key="${esc(x.key)}" title="Send it to the XL to hear it">
    <span class="lib-name">${esc(x.name.trim() || '—')}</span>
    <span class="lib-meta">${esc(x.type)}</span>
    <span class="lib-meta">${esc(bankLabel(x.bank))}</span><span></span>
  </div>`).join('') + (items.length > 400 ? `<div class="hint">${items.length - 400} more: search to narrow it down.</div>` : '');
}

function sndHTML(ti) {
  const { bankLabel } = libOf(ti);
  const t = song.tracks[ti], f = views[ti].snd, role = M.roleOf(t);
  const types = [...new Set((sounds || []).map(x => x.type))].sort();
  const banks = [...new Set((sounds || []).map(x => x.bank))];
  const trying = f.trying && sounds?.find(x => x.key === f.trying);
  return `<div class="lib-panel snd-panel">
    <div class="ai-row">
      <span class="ai-mark">${icon('knob')} Sounds</span>
      <input class="ai-msg" data-act="snd-q" value="${esc(f.q)}" placeholder="Search sound names" spellcheck="false">
      <label class="field">Type <select data-act="snd-type">${options([['auto', `Suits ${M.ROLES[role] || role}`], ['all', 'All'], ...types.map(x => [x, x])], f.type)}</select></label>
      <label class="field">Bank <select data-act="snd-bank">${options([['all', 'All'], ...banks.map(b => [b, bankLabel(b)])], f.bank)}</select></label>
      <button class="ghost small x" data-act="snd" title="Close and go back to the track's own sound">✕</button>
    </div>
    <div class="lib-list" tabindex="0" data-act="snd-list">${sndRows(ti)}</div>
    <div class="ai-row">
      ${trying ? `<span>Trying <b>${esc(trying.name.trim())}</b></span>
        <button class="accent small" data-act="snd-use">Use for ${esc(t.name)}</button>
        <button class="ghost small" data-act="snd-back">Back to ${esc(t.sound?.name || 'the track\'s sound')}</button>` : ''}
      <span class="hint">${!sysexOk ? 'SysEx is blocked, so sounds can\'t be sent to the XL. ' : ''}Click a sound to hear it on the XL${engine.playing ? '' : ' (press Play to hear it with the song)'}; ↑ ↓ step through the list. Nothing changes until you click Use.</span>
    </div>
  </div>`;
}

// Sends sound data to a track's XL without keeping it.
function trySound(ti, x) {
  sendDeviceSound(song.tracks[ti], x.data);
  views[ti].snd.trying = x.key;
  renderTrack(ti);
  // Keep the list focused (so ↑ ↓ carry on) and the sound being tried in view.
  document.querySelector(`#trk-${ti} [data-act="snd-list"]`)?.focus({ preventScroll: true });
  document.querySelector(`#trk-${ti} .snd-item.on`)?.scrollIntoView({ block: 'nearest' });
}

// Puts the track's own sound back on the XL (closing the browser, or Back).
function endTrying(ti) {
  const f = views[ti].snd;
  if (!f.trying) return;
  f.trying = null;
  if (song.tracks[ti].sound) sendSound(ti, { show: false });
}

async function openSounds(ti) {
  views[ti].snd.open = true;
  renderTrack(ti);
  if (!sounds) {
    sounds = await libOf(ti).load().catch(() => []);
    if (!sounds.length) toast('No sounds found. Is serve.py running?', 'err');
    views.forEach((v, k) => { if (v.snd.open) renderTrack(k); });
  }
  document.querySelector(`#trk-${ti} [data-act="snd-q"]`)?.focus();
}

// ---- Controller lanes: a MIDI Control Change value per step, e.g. a filter sweep ----

// Common controller names. The XL's knobs send whatever its Global settings assign, so Learn
// (turn a knob on the synth) is the sure way to find one.
const CC_NAMES = { 1: 'Mod wheel', 2: 'Breath', 5: 'Portamento time', 7: 'Volume', 10: 'Pan', 11: 'Expression',
  71: 'Resonance', 72: 'Release', 73: 'Attack', 74: 'Cutoff', 75: 'Decay', 76: 'Vibrato rate', 77: 'Vibrato depth' };
const ccName = n => CC_NAMES[n] ? `CC ${n} · ${CC_NAMES[n]}` : `CC ${n}`;
const CC_LIST = [...Object.keys(CC_NAMES).map(Number), ...Array.from({ length: 120 }, (_, n) => n).filter(n => !CC_NAMES[n] && n !== 64 && n !== 0 && n !== 32)];
let learning = null; // { ti, l }: the lane waiting for a knob to be turned

function ccHTML(ti) {
  const t = song.tracks[ti], v = views[ti], pat = viewPattern(ti), lanes = pat.cc || [];
  const PS = pageSize(ti), start = v.page * PS, drums = isDrums(t);
  const cols = drums ? `76px repeat(${PS}, minmax(${PS > 16 ? 12 : 20}px, 1fr))` : `repeat(${PS}, minmax(${PS > 16 ? 18 : 30}px, 1fr))`;
  const rows = lanes.map((lane, l) => {
    const cells = Array.from({ length: PS }, (_, k) => {
      const i = start + k, set = lane.steps.find(x => x.i === i), shown = set ? set.v : lane.glide ? M.laneValue(lane, i, pat.length) : null;
      const cls = `cc-cell${i % 4 === 0 ? ' beat' : ''}${i >= pat.length ? ' beyond' : ''}${set ? ' set' : ''}`;
      return `<div class="${cls}" data-act="cc-cell" data-l="${l}" data-s="${i}" title="Step ${i + 1}${shown !== null ? `: ${shown}` : ''}">${
        shown !== null ? `<i style="height:${Math.round(shown / 127 * 100)}%"></i>` : ''}</div>`;
    }).join('');
    const isLearning = learning?.ti === ti && learning.l === l;
    return `<div class="cc-head">
        <select data-act="cc-num" data-l="${l}" title="Which controller this lane sends">${options(CC_LIST.map(n => [n, ccName(n)]), lane.cc)}</select>
        <button class="small ${isLearning ? 'on' : 'ghost'}" data-act="cc-learn" data-l="${l}" title="Turn a knob on your keyboard to use the controller it sends">${isLearning ? 'Turn a knob…' : 'Learn'}</button>
        <label class="field" title="Move smoothly from each value you set to the next, instead of jumping"><input type="checkbox" data-act="cc-glide" data-l="${l}" ${lane.glide ? 'checked' : ''}> Glide</label>
        <button class="ghost small" data-act="cc-del" data-l="${l}" title="Remove this lane">✕</button>
      </div>
      <div class="cc-row" style="grid-template-columns:${cols}">${drums ? '<div></div>' : ''}${cells}</div>`;
  }).join('');
  const room = lanes.length < M.MAX_CC_LANES;
  if (!lanes.length && sel.t !== ti) return '';
  return `<div class="cc-lanes">${rows}
    <div class="cc-tools">
      ${room ? `<button class="ghost small" data-act="cc-add" title="Send a MIDI controller (e.g. filter cutoff) from this pattern's steps">+ Controller lane</button>` : ''}
      ${lanes.length ? `<span class="hint">Click or drag in a lane to set values (higher = more); ⌥-drag to clear.${t.out === M.COMPUTER
        ? ' Lanes go to MIDI instruments; the computer sound ignores them.' : ''} With Rec on, turning a knob while playing records it.</span>` : ''}
    </div>
  </div>`;
}

// Sets or clears one lane value from a pointer position in a cell.
function setCC(ti, l, cell, y, clear) {
  const lane = viewPattern(ti).cc?.[l], i = +cell.dataset.s;
  if (!lane) return;
  lane.steps = lane.steps.filter(x => x.i !== i);
  if (!clear) {
    const r = cell.getBoundingClientRect();
    lane.steps.push({ i, v: Math.max(0, Math.min(127, Math.round((1 - (y - r.top) / r.height) * 127))) });
    lane.steps.sort((a, b) => a.i - b.i);
  }
}

// Knob turns from MIDI in: Learn picks up the controller; while recording they go into a lane.
function onCC(cc, value, at) {
  if (cc === 64 || cc === 0 || cc === 32 || cc >= 120) return; // pedal, bank select, channel modes
  if (learning) {
    const { ti, l } = learning, pat = viewPattern(ti), lane = pat.cc?.[l];
    learning = null;
    if (lane && !pat.cc.some(x => x !== lane && x.cc === cc)) { lane.cc = cc; changed(); toast(`Lane set to ${ccName(cc)}.`, 'ok'); }
    renderTrack(ti);
    return;
  }
  if (!rec.on || !engine.playing) return;
  const ti = sel.t, t = song.tracks[ti], p = engine.positionAt(ti, at);
  if (!p || engine.tickAt(at) < -M.RATES[t.rate] / 2) return;
  const pat = t.patterns[p.pattern];
  let lane = pat.cc?.find(x => x.cc === cc);
  if (!lane) {
    if ((pat.cc?.length || 0) >= M.MAX_CC_LANES) return;
    lane = { cc, glide: true, steps: [] };
    pat.cc = [...(pat.cc || []), lane];
  }
  const i = Math.round(p.step) % pat.length;
  lane.steps = [...lane.steps.filter(x => x.i !== i), { i, v: value }].sort((a, b) => a.i - b.i);
  changed({ coalesce: 'rec' });
  renderTrack(ti);
}

// ---- Drum tracks: a drum-machine grid (one row per drum) and a kit of pads in the step editor ----

const KIT = [[36, 'Kick'], [37, 'Rim'], [38, 'Snare'], [39, 'Clap'], [41, 'Low tom'], [45, 'Mid tom'], [48, 'High tom'],
  [42, 'Closed hat'], [44, 'Pedal hat'], [46, 'Open hat'], [49, 'Crash'], [51, 'Ride'], [56, 'Cowbell'], [70, 'Shaker'],
  [63, 'Conga'], [60, 'Bongo']];
const KIT_NAME = new Map(KIT);
const KIT_ORDER = KIT.map(([n]) => n);
const kitName = n => KIT_NAME.get(n) || M.drumName(n);
// A lane's name: the pad's own name when the track plays an Ostinato Synth kit (lab/drums.js).
const laneName = (ti, n) => song.tracks[ti]?.inst?.patch?.modules?.find(m => m.pads)?.pads?.[n]?.name || kitName(n);
const isDrums = t => t.mode === 'steps' && M.roleOf(t) === 'drums';

// Rows: the basic kit, every drum the pattern uses, and any the user added.
function lanesOf(ti) {
  const pat = viewPattern(ti), rows = new Set([36, 38, 39, 42, 46, ...(views[ti].lanes || [])]);
  for (const s of pat.steps) if (s.i < pat.length) s.notes.forEach(n => rows.add(n));
  const rank = n => (KIT_ORDER.includes(n) ? KIT_ORDER.indexOf(n) : 1000 + n);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

function lanesHTML(ti) {
  const v = views[ti], pat = viewPattern(ti);
  const PS = pageSize(ti), n = pages(ti), start = v.page * PS, end = start + PS;
  const at = new Map(pat.steps.map(s => [s.i, s]));
  const cols = Array.from({ length: PS }, (_, k) => start + k);
  const numbers = `<div></div>${cols.map(i => `<div class="lane-num${sel.t === ti && sel.i === i ? ' sel' : ''}${i >= pat.length ? ' beyond' : ''}"
    data-act="cell" data-s="${i}" title="Edit step ${i + 1}">${i + 1}</div>`).join('')}`;
  const own = note => (pat.laneLen?.[note] < pat.length ? pat.laneLen[note] : 0);
  const rows = lanesOf(ti).map(note => `<div class="lane-name" data-act="lane-name" data-n="${note}" title="Click to hear it"><span>${esc(laneName(ti, note))}</span>
      <select class="lane-len${own(note) ? ' on' : ''}" data-act="lane-len" data-n="${note}" title="Loop this drum on its own length, so it drifts against the rest (e.g. 7 against 16)">
        <option value="">${pat.length}</option>${Array.from({ length: Math.max(0, pat.length - 2) }, (_, k) => k + 2).reverse().map(n => `<option value="${n}"${own(note) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></div>`
    + cols.map(i => {
      const s = at.get(i), on = !!s && s.notes.includes(note), vel = on ? M.velOf(s, note) : 0;
      const cls = `lane-cell${i % 4 === 0 ? ' beat' : ''}${i >= pat.length || (own(note) && i >= own(note)) ? ' beyond' : ''}${on ? ' on' : ''}${vel >= 110 ? ' accent' : ''}${on && vel < 70 ? ' soft' : ''}${on && s.prob ? ' chance' : ''}`;
      return `<div class="${cls}" data-act="lane" data-n="${note}" data-s="${i}"${on && (s.prob || s.rat) ? ` title="${[s.prob && `${s.prob}% chance`, s.rat && `ratchet ×${s.rat}`].filter(Boolean).join(', ')}"` : ''}>${on && s.rat ? s.rat : ''}</div>`;
    }).join('')).join('');
  const shown = lanesOf(ti);
  const pager = n > 1 ? `<div class="pages">Steps ${Array.from({ length: n }, (_, k) =>
    `<button data-act="page" data-pg="${k}" class="${v.page === k ? 'on' : ''}">${k * PS + 1}–${Math.min(k * PS + PS, pat.length)}</button>`).join('')}</div>` : '';
  return `${pager}<div class="lanes" style="grid-template-columns:108px repeat(${PS}, minmax(${PS > 16 ? 12 : 20}px, 1fr))">${numbers}${rows}</div>
    <div class="lane-tools">
      <select data-act="lane-add">${options([['', '+ Add a drum…'], ...KIT.filter(([k]) => !shown.includes(k))], '')}</select>
      <span class="hint">Click or drag across cells to add or remove hits. ⇧-click a hit for an accent. Click a step number to edit that step (velocity, gate).</span>
    </div>`;
}

// Adds or removes one drum at one step. Steps hold all the drums that hit together.
function setHit(ti, i, note, on) {
  const pat = viewPattern(ti);
  if (i >= pat.length) return;
  const s = M.stepAt(pat, i);
  if (on) {
    if (!s) M.putStep(pat, i, { notes: [note], vel: 100, gate: 30 });
    else if (!s.notes.includes(note)) s.notes = [...s.notes, note].sort((a, b) => a - b);
  } else if (s) {
    s.notes = s.notes.filter(x => x !== note);
    if (!s.notes.length) M.removeStep(pat, i);
  }
}

function kitHTML(ti, isOn) {
  return `<div class="kit">${KIT.map(([note, name]) =>
    `<button class="pad${isOn(note) ? ' on' : ''}" data-act="key" data-n="${note}">${name}</button>`).join('')}</div>`;
}

function gridHTML(ti) {
  if (isDrums(song.tracks[ti]) && !views[ti].collapsed) return lanesHTML(ti);
  if (hasRoll(ti) && views[ti].roll && !views[ti].collapsed) return rollHTML(ti);
  const t = song.tracks[ti], v = views[ti], pat = viewPattern(ti);
  const PS = pageSize(ti), n = pages(ti), start = v.page * PS, end = start + PS;
  const cover = M.coverMap(pat);
  let cells = '', blocks = '';
  for (let i = start; i < end; i++) {
    const cls = `cell-bg${i % 4 === 0 ? ' beat' : ''}${i >= pat.length ? ' beyond' : ''}${sel.t === ti && sel.i === i && cover[i] < 0 ? ' sel' : ''}`;
    cells += `<div class="${cls}" style="grid-column:${i - start + 1}" data-act="cell" data-s="${i}"><span class="num">${i + 1}</span></div>`;
  }
  for (let i = start; i < Math.min(end, pat.length); i++) {
    const c = cover[i];
    if (c < 0 || (c !== i && i !== start)) continue; // empty, or drawn by the block it belongs to
    const s = M.stepAt(pat, c);
    const fullEnd = Math.min(c + s.len, pat.length), stop = Math.min(fullEnd, end), span = stop - i;
    const drums = M.roleOf(t) === 'drums';
    const label = t.mode === 'pool' ? '♪' : s.notes.length ? [...new Set(s.notes.map(drums ? M.drumName : M.noteName))].join(span > 1 ? ' ' : '<br>') : '—';
    blocks += `<div class="blk${c !== i ? ' cont' : ''}${span === 1 ? ' single' : ''}${s.prob ? ' chance' : ''}${sel.t === ti && sel.i === c ? ' sel' : ''}"
      style="grid-column:${i - start + 1} / span ${span}" data-act="blk" data-s="${c}">
      <span class="num">${c + 1}${s.len > 1 ? ` · ${s.len} steps` : ''}</span>
      ${s.prob || s.rat ? `<span class="badges">${s.prob ? `${s.prob}%` : ''}${s.prob && s.rat ? ' ' : ''}${s.rat ? `×${s.rat}` : ''}</span>` : ''}
      <span class="note"${s.notes.length > 1 && span === 1 && t.mode !== 'pool' ? ' style="font-size:10px;top:15px"' : ''}>${label}</span>
      <div class="vel" style="height:${Math.round(s.vel / 127 * 24)}px"></div>
      ${stop === fullEnd ? `<div class="gate" style="left:${(span - 1) / span * 100}%;width:${s.gate / span}%"></div>
        <div class="handle" title="Drag to hold the note longer or shorter"></div>` : ''}
    </div>`;
  }
  const pager = n > 1 ? `<div class="pages">Steps ${Array.from({ length: n }, (_, k) =>
    `<button data-act="page" data-pg="${k}" class="${v.page === k ? 'on' : ''}">${k * PS + 1}–${Math.min(k * PS + PS, pat.length)}</button>`).join('')}</div>` : '';
  return `${pager}<div class="steps${PS > 16 ? ' dense' : ''}" style="grid-template-columns:repeat(${PS}, minmax(${PS > 16 ? 18 : 30}px, 1fr))">${cells}${blocks}</div>`;
}

// ---- the piano roll (melodic Steps tracks) ----
// The pattern as separate notes (model.js rollNotes / setRollNotes): pitch up the side, steps across.
// Click empty space to add a note (drag to draw its length), drag a note to move it, drag its right
// edge to change its length, right-click or ⌥-click to remove it; the lane below sets velocity.
// With a note selected: ↑ ↓ move it a semitone (⇧ an octave), ← → a step, Delete removes it.
const ROLL_ROWS = 25;
const hasRoll = ti => { const t = song.tracks[ti]; return t.mode === 'steps' && !isDrums(t); };
function rollTop(ti) {
  const v = views[ti];
  if (v.rollTop === null) {
    const ns = M.rollNotes(viewPattern(ti)).map(x => x.note), mid = ns.length ? Math.round((Math.min(...ns) + Math.max(...ns)) / 2) : v.lastNote || 60;
    v.rollTop = Math.max(ROLL_ROWS - 1, Math.min(127, mid + 12));
  }
  return v.rollTop;
}
function rollHTML(ti) {
  const v = views[ti], pat = viewPattern(ti), PS = pageSize(ti), n = pages(ti), start = v.page * PS, end = start + PS;
  const top = rollTop(ti), bottom = top - ROLL_ROWS + 1, notes = M.rollNotes(pat);
  const rows = Array.from({ length: ROLL_ROWS }, (_, k) => top - k), black = m => [1, 3, 6, 8, 10].includes(m % 12);
  const above = notes.filter(x => x.note > top).length, below = notes.filter(x => x.note < bottom).length;
  const pct = x => `${(x / PS) * 100}%`, isSel = x => v.rollSel && v.rollSel.i === x.i && v.rollSel.note === x.note;
  const shown = notes.filter(x => x.i < end && x.i + x.len > start && x.note <= top && x.note >= bottom);
  const keys = rows.map(m => `<div class="rk${black(m) ? ' b' : ''}${M.inScale(m, song.scale) ? '' : ' out'}" data-act="roll-key" data-n="${m}" title="${M.noteName(m)}: click to hear it">${m % 12 === 0 || !black(m) && m === top ? M.noteName(m) : ''}</div>`).join('');
  const lanes = rows.map((m, k) => `<div class="rrow${black(m) ? ' b' : ''}${M.inScale(m, song.scale) ? '' : ' out'}${m % 12 === 0 ? ' c' : ''}" style="top:${(k / ROLL_ROWS) * 100}%"></div>`).join('');
  const cols = Array.from({ length: PS }, (_, k) => start + k).map((i, k) => `<div class="rcol${i % 4 === 0 ? ' beat' : ''}${i >= pat.length ? ' beyond' : ''}" data-s="${i}" style="left:${pct(k)};width:${pct(1)}"></div>`).join('');
  const blocks = shown.map(x => {
    const a = Math.max(x.i, start), b = Math.min(x.i + x.len, end, pat.length);
    return `<div class="rn${isSel(x) ? ' sel' : ''}${x.i < start ? ' cont' : ''}" data-i="${x.i}" data-n="${x.note}" title="${M.noteName(x.note)}, step ${x.i + 1}, ${x.len} step${x.len > 1 ? 's' : ''}, velocity ${x.vel}"
      style="left:${pct(a - start)};width:${pct(b - a)};top:${((top - x.note) / ROLL_ROWS) * 100}%;height:${100 / ROLL_ROWS}%;--v:${(0.35 + 0.65 * x.vel / 127).toFixed(2)}">${b - a >= 2 ? `<span>${M.noteName(x.note)}</span>` : ''}${x.i + x.len <= end ? '<i class="rh"></i>' : ''}</div>`;
  }).join('');
  const vels = notes.filter(x => x.i >= start && x.i < end).sort((a, b) => isSel(a) - isSel(b)).map(x =>
    `<div class="rv${isSel(x) ? ' sel' : ''}" style="left:${pct(x.i - start)};width:${pct(1)};height:${(x.vel / 127) * 100}%"></div>`).join('');
  const pager = n > 1 ? `<div class="pages">Steps ${Array.from({ length: n }, (_, k) =>
    `<button data-act="page" data-pg="${k}" class="${v.page === k ? 'on' : ''}">${k * PS + 1}–${Math.min(k * PS + PS, pat.length)}</button>`).join('')}</div>` : '';
  return `${pager}<div class="piano-roll" style="--c:${COLORS[ti]}">
    <div class="roll-side"><button class="ghost small" data-act="roll-scroll" data-d="12" title="Show higher notes (or scroll over the roll)">▲${above ? ` ${above}` : ''}</button>
      <div class="roll-keys" style="--rows:${ROLL_ROWS}">${keys}</div>
      <button class="ghost small" data-act="roll-scroll" data-d="-12" title="Show lower notes">▼${below ? ` ${below}` : ''}</button></div>
    <div class="roll-main">
      <div class="roll-grid" style="--rows:${ROLL_ROWS}">${lanes}${cols}${blocks}</div>
      <div class="roll-vel" title="Velocity: drag up or down on a note's bar (the selected note, or every note starting there)">${vels}</div>
    </div>
  </div>
  <div class="lane-tools"><label class="field" title="How long a new note is when you click (drag to draw it longer)">New notes <select data-act="roll-len">${options([1, 2, 3, 4, 6, 8, 12, 16].map(k => [k, `${k} step${k > 1 ? 's' : ''}`]), v.rollLen)}</select></label>
    <span class="hint">Click to add a note (drag to draw it longer), drag a note to move it, drag its end to change its length, right-click to remove it. Selected: ↑ ↓ ← → move it, Delete removes it.</span></div>`;
}
// A finished piano-roll gesture: one undo step, and redraw.
function rollCommit(ti) { changed(); renderTrack(ti); }
$('#tracks').addEventListener('pointerdown', e => {
  const grid = e.target.closest('.roll-grid');
  if (!grid || e.button !== 0) return;
  e.preventDefault();
  const ti = +trackEl(e).dataset.t, v = views[ti], pat = viewPattern(ti), PS = pageSize(ti), start = v.page * PS, top = rollTop(ti);
  const r = grid.getBoundingClientRect(), at = ev => ({ col: Math.floor((ev.clientX - r.left) / (r.width / PS)), row: Math.floor((ev.clientY - r.top) / (r.height / ROLL_ROWS)) });
  const notes = M.rollNotes(pat), el = e.target.closest('.rn'), p0 = at(e);
  let target = el && notes.find(x => x.i === +el.dataset.i && x.note === +el.dataset.n), mode = target ? (e.target.classList.contains('rh') ? 'resize' : 'move') : 'draw';
  if (target && e.altKey) { notes.splice(notes.indexOf(target), 1); M.setRollNotes(pat, notes); v.rollSel = null; rollCommit(ti); return; }
  if (!target) {
    const i = start + p0.col, note = top - p0.row;
    if (i >= pat.length || note < 0 || note > 127) return;
    target = { i, note, len: Math.min(v.rollLen, pat.length - i), vel: 100 };
    notes.push(target);
    M.setRollNotes(pat, notes);
  }
  const orig = { ...target };
  let moved = mode === 'draw';
  v.rollSel = { i: target.i, note: target.note };
  v.lastNote = target.note;
  preview(ti, target.note);
  refreshGrid(ti);
  const move = ev => {
    const p = at(ev);
    if (mode === 'move') {
      const i = Math.max(0, Math.min(pat.length - 1, orig.i + p.col - p0.col)), note = Math.max(0, Math.min(127, orig.note + p0.row - p.row));
      if (i === target.i && note === target.note) return;
      if (note !== target.note) preview(ti, note);
      Object.assign(target, { i, note, len: Math.min(orig.len, pat.length - i) });
    } else {
      const len = Math.max(1, Math.min(start + p.col - target.i + 1, pat.length - target.i));
      if (len === target.len) return;
      target.len = len;
    }
    moved = true;
    v.rollSel = { i: target.i, note: target.note };
    M.setRollNotes(pat, notes);
    refreshGrid(ti);
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (mode !== 'move' && moved) v.rollLen = target.len;
    if (moved) rollCommit(ti); else renderTrack(ti);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});
$('#tracks').addEventListener('contextmenu', e => {
  const el = e.target.closest('.roll-grid .rn');
  if (!el) return;
  e.preventDefault();
  const ti = +trackEl(e).dataset.t, pat = viewPattern(ti);
  M.setRollNotes(pat, M.rollNotes(pat).filter(x => !(x.i === +el.dataset.i && x.note === +el.dataset.n)));
  views[ti].rollSel = null;
  rollCommit(ti);
});
// Velocity: drag over the lane; each column's notes (or just the selected one) follow the pointer.
$('#tracks').addEventListener('pointerdown', e => {
  const lane = e.target.closest('.roll-vel');
  if (!lane) return;
  e.preventDefault();
  const ti = +trackEl(e).dataset.t, v = views[ti], pat = viewPattern(ti), PS = pageSize(ti), start = v.page * PS, r = lane.getBoundingClientRect();
  const set = ev => {
    const i = start + Math.floor((ev.clientX - r.left) / (r.width / PS)), vel = Math.max(1, Math.min(127, Math.round((1 - (ev.clientY - r.top) / r.height) * 127)));
    const notes = M.rollNotes(pat), here = notes.filter(x => x.i === i), only = here.find(x => v.rollSel?.i === i && v.rollSel.note === x.note);
    if (!here.length) return;
    for (const x of only ? [only] : here) x.vel = vel;
    M.setRollNotes(pat, notes);
    refreshGrid(ti);
  };
  set(e);
  const up = () => { removeEventListener('pointermove', set); removeEventListener('pointerup', up); rollCommit(ti); };
  addEventListener('pointermove', set);
  addEventListener('pointerup', up);
});
$('#tracks').addEventListener('wheel', e => {
  const grid = e.target.closest('.roll-grid, .roll-keys');
  if (!grid || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
  e.preventDefault();
  const ti = +trackEl(e).dataset.t, v = views[ti];
  v.rollTop = Math.max(ROLL_ROWS - 1, Math.min(127, rollTop(ti) + (e.deltaY < 0 ? 2 : -2)));
  refreshGrid(ti);
}, { passive: false });
$('#tracks').addEventListener('change', e => {
  if (e.target.dataset.act !== 'roll-len') return;
  views[+trackEl(e).dataset.t].rollLen = +e.target.value;
});
// Keys for the selected note in the piano roll. Returns true when it handled the key.
function rollKeys(e, ti) {
  const v = views[ti], pat = viewPattern(ti);
  if (!hasRoll(ti) || !v.roll || !v.rollSel) return false;
  const notes = M.rollNotes(pat), x = notes.find(n => n.i === v.rollSel.i && n.note === v.rollSel.note);
  if (!x) return false;
  const d = { ArrowUp: [0, e.shiftKey ? 12 : 1], ArrowDown: [0, e.shiftKey ? -12 : -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
  if (e.key === 'Delete' || e.key === 'Backspace') { notes.splice(notes.indexOf(x), 1); v.rollSel = null; }
  else if (e.key === 'Escape') { v.rollSel = null; renderTrack(ti); return true; }
  else if (d) {
    const i = x.i + d[0], note = x.note + d[1];
    if (i < 0 || i >= pat.length || note < 0 || note > 127) return true;
    Object.assign(x, { i, note, len: Math.min(x.len, pat.length - i) });
    v.rollSel = { i, note };
    if (d[1]) preview(ti, note);
    if (note > rollTop(ti) || note < rollTop(ti) - ROLL_ROWS + 1) v.rollTop = Math.max(ROLL_ROWS - 1, Math.min(127, note + 6));
  } else return false;
  e.preventDefault();
  M.setRollNotes(pat, notes);
  changed({ coalesce: true });
  renderTrack(ti);
  return true;
}

function keyboardHTML(ti, isOn, act) {
  const v = views[ti], keys = [];
  let white = 0;
  for (let n = v.kbdLow; n <= v.kbdLow + 36; n++) {
    const black = [1, 3, 6, 8, 10].includes(n % 12);
    const cls = `${black ? 'b' : 'w'}${isOn(n) ? ' on' : ''}${M.inScale(n, song.scale) ? '' : ' out'}`;
    if (black) keys.push(`<div class="${cls}" data-act="${act}" data-n="${n}" style="left:${white * 18 - 6}px" title="${M.noteName(n)}"></div>`);
    else { keys.push(`<div class="${cls}" data-act="${act}" data-n="${n}" title="${M.noteName(n)}">${n % 12 === 0 ? `<span class="lbl">${M.noteName(n)}</span>` : ''}</div>`); white++; }
  }
  return `<div class="kbd-row">
    <div class="oct"><button class="small" data-act="oct" data-d="12">Oct +</button><button class="small" data-act="oct" data-d="-12">Oct −</button></div>
    <div class="kbd">${keys.join('')}</div>
    <span class="hint">${act === 'pool-key' ? 'Click keys to choose the pool notes,<br>or play them on your keyboard.' : 'Click a key to set the note; click more for a chord.<br>Or play it on your keyboard.'}</span>
  </div>`;
}

function editorHTML(ti) {
  const t = song.tracks[ti], pat = viewPattern(ti), s = M.stepAt(pat, sel.i), pool = t.mode === 'pool';
  return `<div class="editor">
    <span class="title">Step ${sel.i + 1}</span>
    <label class="field"><input type="checkbox" data-act="e-on" ${s ? 'checked' : ''}> On</label>
    ${s ? `
      <label class="field" title="How many steps the note is held across">Hold <input type="number" data-act="e-len" min="1" max="${M.maxLen(pat, sel.i)}" value="${s.len}"> steps</label>
      <label class="field">Velocity <input type="range" data-act="e-vel" min="1" max="127" value="${s.vel}"> <span class="e-vel">${s.vel}</span></label>
      <label class="field" title="How much of its last step the note sounds for">Gate <input type="range" data-act="e-gate" min="1" max="100" value="${s.gate}"> <span class="e-gate">${s.gate}%</span></label>
      <label class="field" title="How often this step plays: below 100%, it's left out at random">Chance <select data-act="e-prob">${options(M.PROBS.map(p => [p, `${p}%`]), s.prob || 100)}</select></label>
      <label class="field" title="Repeat the note this many times across its length (a roll or stutter)">Ratchet <select data-act="e-rat">${options([[1, 'off'], [2, '×2'], [3, '×3'], [4, '×4'], [5, '×5'], [6, '×6'], [8, '×8']], s.rat || 1)}</select></label>`
    : `<span class="hint">Empty step. ${pool ? 'Click the step (or tick On) to make it fire.' : isDrums(t) ? 'Click a drum below, or hit a pad.' : armed === ti ? 'Click a key below or play one to add a note.' : 'Click a key below to add a note, or arm the track (✎) to play notes in.'}</span>`}
    <button class="ghost small x" data-act="e-close" title="Hide the editor (Esc)">✕</button>
    ${pool ? keyboardHTML(ti, n => t.pool.notes.includes(n), 'pool-key')
      : isDrums(t) ? kitHTML(ti, n => !!s && s.notes.includes(n))
      : keyboardHTML(ti, n => !!s && s.notes.includes(n), 'key')}
  </div>`;
}

function poolHTML(ti) {
  const t = song.tracks[ti];
  const notes = poolNotes(ti);
  const shown = notes.length ? M.poolOrder(notes, t.pool.order === 'random' ? 'up' : t.pool.order) : [];
  return `<div class="pool">
    <b>Note pool</b>
    <span class="chips">${shown.length ? [...new Set(shown)].map(n => `<span class="chip" data-n="${n}">${M.noteName(n)}</span>`).join('') : '<span class="hint">empty</span>'}</span>
    <label class="field">Order <select data-act="p-order">${options(Object.entries(M.ORDERS), t.pool.order)}</select></label>
    <label class="field" title="Keep playing the last notes after you let go"><input type="checkbox" data-act="p-latch" ${t.pool.latch ? 'checked' : ''}> Latch</label>
    <button class="ghost small" data-act="p-clear">Clear</button>
    <span class="hint">${armed === ti
      ? (t.pool.latch ? '<b>Armed:</b> play notes on your keyboard to set the pool (a new chord replaces it; keys added while holding join it).' : 'The pool is the keys you\'re holding (Latch keeps them after you let go).')
      : `<button class="small" data-act="arm" title="Notes you play on your keyboard go into this track">${icon('arm')} Arm</button> to set the pool from your keyboard, or click notes on the keyboard in the step editor.`}
      Steps set the rhythm: click a step to turn it on; each one that fires plays the next pool note.</span>
  </div>`;
}

// Moves the playhead highlight without redrawing.
function paintPlayhead(ti) {
  const el = document.getElementById(`trk-${ti}`);
  if (!el) return;
  el.querySelectorAll('.play, .playing, .cur').forEach(e => e.classList.remove('play', 'playing', 'cur'));
  if (!engine.playing || live.pos[ti] === undefined || live.silent[ti]) return;
  if (live.poolNote[ti] !== undefined) el.querySelector(`.chip[data-n="${live.poolNote[ti]}"]`)?.classList.add('cur');
  if (views[ti].pat !== live.pattern[ti]) return;
  const pos = live.pos[ti], cover = M.coverMap(viewPattern(ti));
  el.querySelectorAll(`.lane-cell[data-s="${pos}"], .lane-num[data-s="${pos}"], .rcol[data-s="${pos}"]`).forEach(c => c.classList.add('play'));
  if (cover[pos] >= 0) el.querySelector(`.blk[data-s="${cover[pos]}"]`)?.classList.add('playing');
  else el.querySelector(`.cell-bg[data-s="${pos}"]`)?.classList.add('play');
}

// ---------------------------------------------------------------------------------------------
// Ideas: patterns offered by 🎲, the AI or the library, to audition before keeping.
//
// Each track has one list. Adding to it plays the new idea at once; clicking a number swaps ideas
// (each swap is an undo step); Original puts back what was there before the first idea; Keep
// clears the list and leaves the pattern as it is; Put in copies the idea to another pattern.

const MAX_IDEAS = 12;
const newIdeas = () => ({ list: [], applied: -1, before: null, target: '' });

// `names`: the patterns these ideas fill. Ideas for the same patterns are added to the list;
// ideas for different ones start a new list.
function addIdeas(ti, names, fresh) {
  const t = song.tracks[ti], id = views[ti].ideas;
  const target = `${names.join()}|${t.mode}`;
  if (id.target === target && id.list.length) {
    const all = [...id.list, ...fresh], drop = Math.max(0, all.length - MAX_IDEAS);
    id.list = all.slice(drop);
    id.applied = id.applied >= drop ? id.applied - drop : -1;
  } else {
    id.list = fresh;
    id.before = { patterns: Object.fromEntries(names.map(n => [n, M.copyPattern(t.patterns[n])])), pool: [...t.pool.notes], rate: t.rate };
    id.applied = -1;
  }
  id.target = target;
  applyIdea(ti, id.list.length - fresh.length);
}

function applyIdea(ti, k) {
  const t = song.tracks[ti], v = views[ti], o = v.ideas.list[k];
  if (!o) return;
  // Lanes, fit and lane lengths come from the pattern as it was before the ideas, not from the idea heard last.
  for (const [name, p] of Object.entries(o.patterns)) t.patterns[name] = keepLanes(v.ideas.before?.patterns[name] || t.patterns[name], M.copyPattern(p));
  if (o.pool?.length && t.mode === 'pool') t.pool.notes = [...o.pool];
  t.rate = o.rate || v.ideas.before.rate;
  const names = Object.keys(o.patterns);
  if (names.length === 1 && v.pat !== names[0]) { v.pat = names[0]; v.page = 0; }
  v.ideas.applied = k;
  changed();
  renderTrack(ti);
}

function originalIdea(ti) {
  const t = song.tracks[ti], id = views[ti].ideas;
  if (!id.before || id.applied < 0) return;
  for (const [name, p] of Object.entries(id.before.patterns)) t.patterns[name] = M.copyPattern(p);
  t.pool.notes = [...id.before.pool];
  t.rate = id.before.rate;
  id.applied = -1;
  changed();
  renderTrack(ti);
}

function keepIdea(ti) {
  views[ti].ideas = newIdeas();
  renderTrack(ti);
}

// Copies the chosen idea into another pattern of this track (so several ideas can be kept).
function putIdea(ti, dest) {
  const t = song.tracks[ti], id = views[ti].ideas, o = id.list[id.applied];
  const src = o && Object.values(o.patterns);
  if (!src || src.length !== 1) return;
  t.patterns[dest] = M.copyPattern(src[0]);
  changed();
  renderTrack(ti);
  toast(`Idea ${id.applied + 1} copied to pattern ${dest}. Pick another idea for this pattern, or Keep.`, 'ok');
}

// 🧬: a variation of the pattern on screen, added as an idea (so Original and the other ideas stay).
function isDrumTrack(ti) { return isDrums(song.tracks[ti]); }
function mutateIdea(ti) {
  const t = song.tracks[ti], v = views[ti], name = v.pat, id = v.ideas;
  const from = id.target === `${name}|${t.mode}` && id.applied >= 0 ? `idea ${id.applied + 1}` : 'the pattern';
  const out = mutate(t.patterns[name], { drums: isDrumTrack(ti), scale: song.scale, amount: 0.18 });
  synth.wake();
  addIdeas(ti, [name], [{ summary: `🧬 From ${from}: ${out.what}.`, patterns: { [name]: out.pattern }, pool: null }]);
}
// ⚭: a child of the pattern on screen and another idea (k = -1: the original).
function crossIdea(ti, k) {
  const t = song.tracks[ti], v = views[ti], name = v.pat, id = v.ideas;
  const other = k < 0 ? id.before?.patterns[name] : id.list[k]?.patterns[name];
  if (!other) return;
  const out = cross(t.patterns[name], other, { drums: isDrumTrack(ti) });
  synth.wake();
  addIdeas(ti, [name], [{ summary: `⚭ Idea ${id.applied + 1} × ${k < 0 ? 'the original' : `idea ${k + 1}`}: ${out.what}.`, patterns: { [name]: out.pattern }, pool: null }]);
}

// 🎲: an instant random idea for the pattern on screen (no AI), using the AI panel's role,
// density and register.
function rollDice(ti) {
  const t = song.tracks[ti], v = views[ti], ai = v.ai;
  const role = ai.role === 'auto' ? M.roleOf(t) : ai.role;
  const idea = randomIdea({ role, length: viewPattern(ti).length, scale: song.scale, density: ai.density,
    register: ai.register, pool: t.mode === 'pool', style: ai.style, avoid: v.lastRhythm });
  v.lastRhythm = idea.rhythm; // the next roll won't repeat this rhythm
  synth.wake();
  addIdeas(ti, [v.pat], [{ summary: idea.summary, patterns: { [v.pat]: idea.pattern }, pool: null }]);
}

function ideasHTML(ti) {
  const v = views[ti], id = v.ideas;
  const names = id.target.split('|')[0].split(',');
  const single = names.length === 1;
  const cur = id.list[id.applied];
  return `<div class="ideas">
    <div class="ai-row">
      <span class="field">Ideas for ${single ? `pattern ${names[0]}` : `patterns ${names.join('–')}`}</span>
      <span class="picks">
        <button class="ai-pick${id.applied < 0 ? ' on' : ''}" data-act="idea-original" title="The pattern from before the first idea">Original</button>
        ${id.list.map((o, k) => `<button class="ai-pick${id.applied === k ? ' on' : ''}${o.summary.startsWith('🎲') ? ' dice' : ''}" data-act="idea-pick" data-k="${k}"
          title="${esc(o.summary)}">${k + 1}</button>`).join('')}
      </span>
      <span class="spacer"></span>
      ${single ? `<button class="ghost small" data-act="mutate" title="A variation of what you're hearing: a few hits or notes changed. Pick the ones you like and mutate again.">${icon('mutate')} Mutate</button>
        <label class="field" title="A child of what you're hearing and another idea: ${song.tracks[ti] && isDrumTrack(ti) ? 'each drum from one or the other' : 'half bars from each'}">${icon('cross')} Cross with
        <select data-act="idea-cross"><option value="">…</option>${id.applied >= 0 ? '<option value="-1">Original</option>' : ''}${id.list.map((o, k) => (k === id.applied ? '' : `<option value="${k}">Idea ${k + 1}</option>`)).join('')}</select></label>` : ''}
      ${single ? `<label class="field" title="Copy the idea you're hearing into another pattern of this track">Put in
        <select data-act="idea-put" ${cur ? '' : 'disabled'}><option value="">…</option>${M.PATTERNS.filter(p => p !== names[0]).map(p => `<option>${p}</option>`).join('')}</select></label>` : ''}
      <button class="accent small" data-act="idea-keep" title="Keep what's in the pattern now and clear this list">✓ Keep</button>
    </div>
    <div class="ai-summary">${cur ? `<b>Idea ${id.applied + 1}:</b> ${esc(cur.summary)}` : 'Hearing the original pattern. Click a number to hear an idea.'}</div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Library: stock patterns (js/seq/stock.js), the user's saved ones (data/my-patterns/ via serve.py)
// and Capture's clips (data/clips/), quantized to the track's step rate when used.

let myPatterns = [], clipItems = [];
async function loadClips() {
  try {
    clipItems = (await storage.list('clips')).filter(c => c.notes?.length).map(c => {
      const pattern = C.takeToPattern(c.notes, M.RATES['1/16']);
      return { ...pattern, id: `clip:${c.file}`, file: c.file, name: c.name, source: 'clip', role: guessClipRole(c.notes), mode: 'steps',
        tags: [c.sound?.name ? `played on ${c.sound.name}` : 'clip'], key: null, bpm: c.bpm, rate: '1/16', clip: c };
    });
  } catch { clipItems = []; }
  document.querySelectorAll('.lib-list').forEach(el => { el.innerHTML = libRows(+el.closest('[data-t]').dataset.t); });
}
async function loadMine() {
  try {
    myPatterns = (await storage.list('patterns')).map(p => ({
      ...p, ...M.cleanPattern(p), role: M.ROLES[p.role] ? p.role : 'lead', tags: Array.isArray(p.tags) ? p.tags : [],
      key: p.key && M.SCALES[p.key.type] ? p.key : null, rate: M.RATES[p.rate] ? p.rate : '1/16', mode: p.mode === 'pool' ? 'pool' : 'steps',
    }));
  } catch { myPatterns = []; }
  document.querySelectorAll('.lib-list').forEach(el => { el.innerHTML = libRows(+el.closest('[data-t]').dataset.t); });
}

const newLib = () => ({ open: false, q: '', role: 'auto', source: 'all' });

function libItems(ti) {
  const t = song.tracks[ti], lib = views[ti].lib;
  const q = lib.q.trim().toLowerCase();
  const from = { all: [...clipItems, ...myPatterns, ...STOCK], stock: STOCK, mine: myPatterns, clips: clipItems }[lib.source] || [];
  return from.filter(p => {
    // Clips' roles are guesses, so Auto shows them all (on Steps tracks).
    if (p.source === 'clip' && lib.role === 'auto') { if (t.mode === 'pool') return false; }
    else if (lib.role === 'auto') {
      if (t.mode === 'pool' ? p.mode !== 'pool' : p.mode === 'pool' || p.role !== M.roleOf(t)) return false;
    } else if (lib.role !== 'all' && p.role !== lib.role) return false;
    return !q || [p.name, p.role, M.ROLES[p.role], ...p.tags].join(' ').toLowerCase().includes(q);
  });
}

// A thin strip showing where the notes are: dark where one starts, light where it's held.
function miniHTML(p) {
  const cover = M.coverMap(p);
  return `<span class="mini" style="grid-template-columns:repeat(${p.length}, 1fr)">${cover.map((c, i) =>
    `<i class="${c === i ? 'on' : c >= 0 ? 'held' : ''}"></i>`).join('')}</span>`;
}

function libRows(ti) {
  const items = libItems(ti);
  if (!items.length) return `<div class="hint">Nothing matches. ${views[ti].lib.source === 'clips' ? (clipItems.length ? 'Try another search.' : 'No clips yet: keep takes as clips on the Capture tab.') : `Try Role: All${views[ti].lib.source === 'mine' ? ', or save patterns with ★' : ''}.`}</div>`;
  return items.map(p => `<div class="lib-item" data-act="lib-use" data-id="${esc(p.id)}" title="Try it in pattern ${views[ti].pat}">
    <span class="lib-name">${p.source === 'mine' ? '★ ' : p.source === 'clip' ? '🎞 ' : ''}${esc(p.name)}</span>
    <span class="lib-meta">${p.source === 'clip' ? 'clip' : esc(M.ROLES[p.role] || p.role)}${p.mode === 'pool' ? ' rhythm' : ''} · ${esc(p.tags.join(', ') || '—')} · ${p.length} steps${p.key ? ` · ${M.scaleLabel(p.key)}` : ''}${p.bpm ? ` · ~${p.bpm} BPM` : ''}</span>
    ${miniHTML(p)}
    ${p.source === 'mine' ? `<button class="ghost small" data-act="lib-del" data-file="${esc(p.file)}" title="Remove from your library">🗑</button>` : '<span></span>'}
  </div>`).join('');
}

function libHTML(ti) {
  const t = song.tracks[ti], lib = views[ti].lib;
  const auto = t.mode === 'pool' ? 'note-pool rhythms' : M.ROLES[M.roleOf(t)];
  return `<div class="lib-panel">
    <div class="ai-row">
      <span class="ai-mark">${icon('library')} Library</span>
      <input class="ai-msg" data-act="lib-q" value="${esc(lib.q)}" placeholder="Search names and styles (house, funk, acid…)" spellcheck="false">
      <label class="field">Role <select data-act="lib-role">${options([['auto', `Auto (${auto})`], ['all', 'All'], ...Object.entries(M.ROLES)], lib.role)}</select></label>
      <span class="seg-btn">${[['all', 'All'], ['stock', 'Stock'], ['mine', '★ Mine'], ['clips', '🎞 Clips']].map(([val, label]) =>
        `<button data-act="lib-source" data-val="${val}" class="${lib.source === val ? 'on' : ''}">${label}</button>`).join('')}</span>
      <button class="ghost small x" data-act="lib" title="Close">✕</button>
    </div>
    <div class="lib-list">${libRows(ti)}</div>
    <div class="hint">Click a pattern to hear it in pattern ${views[ti].pat}; it joins the ideas, so Original goes back. Notes are moved to the song's key${song.scale ? ` (${M.scaleLabel(song.scale)})` : ''}. ★ in the track header saves a pattern here; 🎞 Clips are the ones kept on the Capture tab, played as recorded (not moved to the key).</div>
  </div>`;
}

// Puts a library pattern into the ideas list, moved to the song's key.
function useLibrary(ti, id) {
  const p = [...clipItems, ...myPatterns, ...STOCK].find(x => x.id === id);
  if (!p) return;
  const t = song.tracks[ti], v = views[ti];
  if (p.source === 'clip') {
    // Quantized at the track's own step rate; the notes stay as played.
    const pattern = C.takeToPattern(p.clip.notes, M.RATES[t.rate]);
    synth.wake();
    addIdeas(ti, [v.pat], [{ summary: `🎞 ${p.name} (clip, ${p.clip.bpm} BPM)`, patterns: { [v.pat]: pattern }, pool: null, rate: t.rate }]);
    return;
  }
  const pattern = M.copyPattern(p);
  let note = '';
  if (p.key && song.scale && p.role !== 'drums') {
    const shift = ((song.scale.root - p.key.root) % 12 + 18) % 12 - 6; // nearest way up or down
    const snap = song.scale.type !== p.key.type;
    for (const s of pattern.steps) {
      M.mapNotes(s, n => { const m = Math.max(0, Math.min(127, n + shift)); return snap ? M.snapToScale(m, song.scale) : m; });
    }
    if (shift || snap) note = ` (moved from ${M.scaleLabel(p.key)} to ${M.scaleLabel(song.scale)})`;
  }
  // A rhythm on a steps track gets the track's last-used note so it isn't silent.
  if (t.mode === 'steps' && p.mode === 'pool') pattern.steps.forEach(s => { s.notes = [v.lastNote]; });
  synth.wake();
  addIdeas(ti, [v.pat], [{ summary: `📚 ${p.name}${note}`, patterns: { [v.pat]: pattern }, pool: p.pool || null, rate: p.rate }]);
}

async function starPattern(ti) {
  const t = song.tracks[ti], v = views[ti], pat = viewPattern(ti);
  const steps = pat.steps.filter(s => s.i < pat.length);
  if (!steps.length) { toast('This pattern is empty.'); return; }
  const name = (prompt('Save this pattern to your library as:', `${t.name} ${v.pat}`) || '').trim();
  if (!name) return;
  const role = v.ai.role === 'auto' ? M.roleOf(t) : v.ai.role;
  const pattern = { name, role, tags: [song.name].filter(n => n && n !== 'Untitled'), bpm: song.bpm, rate: t.rate, mode: t.mode,
    key: role === 'drums' ? null : song.scale, length: pat.length, steps, ...(t.mode === 'pool' ? { pool: t.pool.notes } : {}),
    ...(pat.beats ? { beats: pat.beats } : {}), ...(pat.laneLen ? { laneLen: pat.laneLen } : {}) };
  try {
    const file = await storage.save('patterns', pattern);
    toast(`★ Saved to your library (${placeOf('patterns', file)})`, 'ok');
    await loadMine();
  } catch (err) {
    toast(`Couldn't save: ${err.message}`, 'err');
  }
}

async function deleteMine(file) {
  const p = myPatterns.find(x => x.file === file);
  if (!p || !confirm(`Remove "${p.name}" from your library?${STATIC ? '' : ' (It\'s moved to data/my-patterns/deleted/.)'}`)) return;
  try { await storage.remove('patterns', file); } catch (err) { toast(`Couldn't remove: ${err.message}`, 'err'); }
  await loadMine();
}

// ---------------------------------------------------------------------------------------------
// AI patterns: Claude writes patterns for one track (serve.py /api/pattern)

let aiAvailable = false, aiProblem = 'Checking the AI provider…';
function checkAiStatus() {
  if (STATIC) { aiProblem = 'The AI isn\'t available in the travel version: it needs the editor\'s server at home.'; return; }
  fetch('api/status').then(r => r.json()).then(j => {
    aiAvailable = !!j.ai;
    aiProblem = j.ai ? '' : `${j.problem} (AI settings are in the microKORG XL editor's AI Designer tab.)`;
    renderTracks();
  }).catch(() => { aiProblem = 'The editor’s server isn’t running.'; });
}
checkAiStatus();

function newAi() {
  return { open: false, message: '', role: 'auto', density: 'medium', register: 'auto', style: 'any', from: 'new', scope: 'one',
    fit: true, n: 2, busy: false, started: 0, error: '', ctrl: null };
}

const AI_EXAMPLES = {
  bass: 'rolling acid bassline', lead: 'catchy 80s synth riff', chords: 'house piano stabs',
  pad: 'slow, dark pad progression', arp: 'driving trance arpeggio', drums: 'four-on-the-floor with offbeat hats',
};

// What the AI sees of a track: its settings and (when asked) its steps.
function trackForAi(t, names, withSteps) {
  return {
    name: t.name, role: M.ROLES[M.roleOf(t)], mode: t.mode === 'pool' ? 'note pool' : 'steps', rate: t.rate,
    sound: t.out === M.COMPUTER ? `computer test sound (${t.voice})` : t.out,
    ...(t.mode === 'pool' ? { pool: t.pool.notes, poolOrder: t.pool.order } : {}),
    patterns: Object.fromEntries(names.map(n => {
      const p = t.patterns[n], shape = { length: p.length, ...(p.beats ? { fittedIntoBeats: p.beats } : {}),
        ...(p.laneLen ? { drumsLoopingOnTheirOwnLength: p.laneLen } : {}) };
      return [n, withSteps ? { ...shape, steps: p.steps.filter(s => s.i < p.length) } : shape];
    })),
  };
}

// The chord track as the AI sees it (tools/pattern_prompt.md says what to do with each).
function chordsForAi(t) {
  const bars = CH.parseProgression(song.chords).bars.length, follows = t.follow && song.chords;
  const ref = CH.referenceRoot(song, song.chords), minor = song.scale && ['minor', 'dorian', 'phrygian', 'harmonic minor', 'minor pentatonic', 'blues'].includes(song.scale.type);
  return {
    progression: song.chords, bars,
    track: !follows ? 'plays as written' : t.mode === 'pool' ? 'plays the chords (its pool notes only set the register)' : t.follow === 'fit' ? 'fits to the chords' : 'moves with the chords',
    ...(follows && t.follow === 'move' && t.mode !== 'pool' ? { writeOver: song.scale ? `${M.NOTE_NAMES[ref]}${minor ? 'm' : ''}` : CH.parseProgression(song.chords).bars.flat().find(Boolean)?.name } : {}),
  };
}

// `surprise`: the AI panel's 🎲. Three varied ideas for the pattern on screen, ignoring the
// description, for when there's no particular idea in mind.
async function generate(ti, { surprise = false } = {}) {
  const t = song.tracks[ti], v = views[ti], ai = v.ai;
  if (ai.busy) return;
  ai.open = true;
  const names = surprise || ai.scope !== 'all' ? [v.pat] : [...M.PATTERNS];
  const from = surprise ? 'new' : ai.from, n = surprise ? 3 : ai.n;
  const listed = v.ideas.target === `${names.join()}|${t.mode}` ? v.ideas.list : [];
  const role = ai.role === 'auto' ? M.roleOf(t) : ai.role;
  const many = names.length > 1;
  const task = [
    from === 'vary' ? `Vary the current pattern${many ? 's' : ''} (shown in the context), keeping ${many ? 'their' : 'its'} identity.`
      : `Write new pattern${many ? 's' : ''} for the track "${t.name}".`,
    `Role: ${M.ROLES[role]}.`, `Density: ${ai.density}.`, `Register: ${ai.register}.`,
    role === 'drums' ? styleTask(ai.style, surprise) : '',
    t.mode === 'pool' ? 'This is a note-pool track: steps set only the rhythm (notes: []); also return the pool notes.' : '',
    many ? 'Fill all four: A main groove, B a variation of A, C a fill or build back to A, D a breakdown.' : '',
    ai.fit && song.tracks.length > 1 ? 'Fit with the other tracks shown.' : '',
    surprise ? 'These are quick ideas to audition: make the options clearly different from each other (rhythmic feel, contour, register or style) while still suiting the role.' : '',
    listed.length ? `Already suggested (do something different from these): ${listed.map(o => o.summary).join(' | ')}` : '',
  ].filter(Boolean).join(' ');
  const context = {
    bpm: song.bpm, swing: `${song.swing}%`,
    scale: song.scale ? M.scaleLabel(song.scale) : 'none set: choose a key that suits',
    timeSignature: song.meter, ...(M.stepsPerBar(song.meter, M.RATES[t.rate]) ? { stepsPerBar: M.stepsPerBar(song.meter, M.RATES[t.rate]) } : {}),
    track: trackForAi(t, names, from === 'vary'),
    ...(song.chords && role !== 'drums' ? { chords: chordsForAi(t) } : {}),
    ...(ai.fit ? { otherTracks: song.tracks.flatMap((o, oi) => oi === ti ? [] : [trackForAi(o, [views[oi].pat], true)]) } : {}),
  };
  Object.assign(ai, { busy: true, error: '', started: performance.now(), ctrl: new AbortController() });
  renderTrack(ti);
  const tick = setInterval(() => {
    const el = document.querySelector(`#trk-${ti} .ai-status`);
    if (el) el.textContent = `Writing… ${Math.round((performance.now() - ai.started) / 1000)}s`;
  }, 500);
  try {
    const r = await fetch('api/pattern', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ai.ctrl.signal,
      body: JSON.stringify({ message: surprise ? '' : ai.message, task, context, patterns: names, options: n, pool: t.mode === 'pool' }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    let out = null, buf = '';
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'error') throw new Error(ev.text);
        if (ev.type === 'result') out = ev.output;
      }
    }
    if (!out?.options?.length) throw new Error('No pattern came back.');
    // Each option is checked with the same rules as a loaded song, and must fit the pattern lengths.
    addIdeas(ti, names, out.options.map(o => ({
      summary: `✨ ${String(o.summary || '').slice(0, 300)}`,
      patterns: Object.fromEntries((o.patterns || []).filter(p => names.includes(p.name)).map(p => {
        const length = t.patterns[p.name].length;
        // Per-drum velocities come back as `vels` beside `notes`.
        const steps = (Array.isArray(p.steps) ? p.steps : []).map(x => (Array.isArray(x?.vels) && Array.isArray(x.notes)
          ? { ...x, nv: Object.fromEntries(x.notes.map((n, k) => [n, x.vels[k]]).filter(([, vv]) => vv)) } : x));
        return [p.name, M.cleanPattern({ steps }, { length, onlyBelow: length })];
      })),
      pool: Array.isArray(o.pool) ? o.pool.filter(n => Number.isInteger(n) && n >= 0 && n <= 127).slice(0, 8) : null,
    })));
  } catch (err) {
    if (err.name !== 'AbortError') ai.error = err.message;
  } finally {
    clearInterval(tick);
    Object.assign(ai, { busy: false, ctrl: null });
    renderTrack(ti);
  }
}

// What the AI is told about the drum style chosen in the panel.
function styleTask(id, surprise) {
  const st = styleById(id);
  if (st) return `Style: ${st.name}, in the spirit of ${st.like} (don't copy any record): ${st.about}${st.meter ? ` Meter ${st.meter}.` : ''}`;
  if (id === 'any') return `Style: unconventional rather than stock rock or house: draw on IDM, trip-hop, krautrock, post-rock, footwork, broken beat, Afrobeat or odd meters${surprise ? ', a different one per option' : ''}. Say which in the summary.`;
  return '';
}
const STYLE_OPTIONS = [['any', 'Any unusual style'], ['', 'Basic (rock, house, boom-bap)'], ...STYLES.map(st => [st.id, `${st.name}${st.meter ? ` (${st.meter})` : ''}`])];

function aiHTML(ti) {
  const t = song.tracks[ti], v = views[ti], ai = v.ai;
  const auto = M.roleOf(t), role = ai.role === 'auto' ? auto : ai.role;
  const seg = (key, list) => `<span class="seg-btn">${list.map(([val, label]) =>
    `<button data-act="ai-set" data-key="${key}" data-val="${val}" class="${ai[key] === val ? 'on' : ''}">${label}</button>`).join('')}</span>`;
  const off = aiAvailable ? '' : `disabled title="${esc(aiProblem)}"`;
  return `<div class="ai-panel">
    <div class="ai-row">
      <span class="ai-mark">${icon('ai')} AI</span>
      <input class="ai-msg" data-act="ai-msg" value="${esc(ai.message)}" maxlength="400" spellcheck="true"
        placeholder="Describe it, e.g. “${AI_EXAMPLES[role]}”" ${ai.busy ? 'disabled' : ''}>
      ${ai.busy
        ? `<span class="hint ai-status">Writing…</span><button class="ghost" data-act="ai-cancel">Cancel</button>`
        : `<button class="accent" data-act="ai-go" ${off}>Generate</button>
           <button data-act="ai-surprise" ${off || 'title="No idea in mind? Three varied AI ideas for this pattern, ignoring the description"'}>${icon('generate')} Surprise me</button>`}
      <button class="ghost small x" data-act="ai" title="Close">✕</button>
    </div>
    <div class="ai-row">
      <span class="field" title="Set in the track header">For a <b>${esc(M.ROLES[auto])}</b> track</span>
      <span class="field">Density ${seg('density', [['sparse', 'Sparse'], ['medium', 'Medium'], ['busy', 'Busy']])}</span>
      ${role === 'drums' ? `<label class="field" title="${esc(styleById(ai.style) ? `${styleById(ai.style).about} In the spirit of ${styleById(ai.style).like}.` : 'The kind of beat the AI and the 🎲 button make')}">Style <select data-act="ai-style">${options(STYLE_OPTIONS, ai.style)}</select></label>`
        : `<label class="field">Register <select data-act="ai-register">${options([['auto', 'Auto'], ['low', 'Low'], ['mid', 'Mid'], ['high', 'High']], ai.register)}</select></label>`}
      <span class="field">Start from ${seg('from', [['new', 'Scratch'], ['vary', 'Current pattern']])}</span>
      <span class="field">Fill ${seg('scope', [['one', `Pattern ${v.pat}`], ['all', 'A–D']])}</span>
      <label class="field" title="Show the AI the other tracks so this one fits with them"><input type="checkbox" data-act="ai-fit" ${ai.fit ? 'checked' : ''}> Fit other tracks</label>
      <label class="field">Options <select data-act="ai-n">${options([[1, 1], [2, 2], [3, 3]], ai.n)}</select></label>
    </div>
    <div class="hint">The track's role, the density and ${role === 'drums' ? 'style' : 'register'} also shape the instant 🎲 button in the track header.</div>
    ${role === 'drums' ? `<div class="hint">Drums use General MIDI note numbers (36 kick, 38 snare, 42 hat…): point this track at a drum machine, usually on channel 10.</div>` : ''}
    ${!aiAvailable ? `<div class="ai-error">${esc(aiProblem)}</div>` : ''}
    ${ai.error ? `<div class="ai-error">${esc(ai.error)}</div>` : ''}
  </div>`;
}


// ---------------------------------------------------------------------------------------------
// The Recorder panel (recorder.html) keeps what you play; it learns the tempo and position from
// us, and asks us to play takes, put them into tracks and record performances (see js/rec/ui.js).

let run = 0; // which playback run notes belong to
let sentAnchor = null, perf = null, stem = null, seqStateTimer = null, lastSeqState = '';

// The end of a recorded run: no new notes, but the last ones ring out for `tail` ms before Stop.
function endRun(run, tail) {
  if (!engine.playing) return;
  engine.halt();
  run.endWall = Date.now();
  run.timer = setTimeout(stop, tail);
}

function postTransport() {
  sentAnchor = engine.anchor;
  const a = engine.anchor;
  soundChannel?.postMessage({ type: 'transport', playing: engine.playing, rec: rec.on, run,
    anchor: a ? { wall: performance.timeOrigin + a.ms, tick: a.tick, bpm: a.bpm } : null });
}
// What the Recorder needs to show its "→ track" buttons; sent when it changes.
function postSeqState(force = false) {
  clearTimeout(seqStateTimer);
  seqStateTimer = setTimeout(() => {
    const t = song.tracks[sel.t], v = views[sel.t];
    if (!t || !v) return;
    const state = { type: 'seq-state', bpm: song.bpm, mode: prefs.mode, songBars: song.song.reduce((n, x) => n + x.bars, 0), songName: song.name,
      file: fileName, dirty, xlOut: xlOutName(),
      track: { name: t.name, pattern: v.pat, rate: t.rate, mode: t.mode, ch: t.ch },
      xlTrack: liveSound !== null ? song.tracks[liveSound]?.name || null : null, armed: armed !== null ? song.tracks[armed]?.name || null : null,
      xlTracks: song.tracks.map((x, ti) => ({ ti, name: x.name, ch: x.ch })).filter(x => isXLOut(song.tracks[x.ti].out)),
      // Every track, for the Recorder's sound menu and "put into a track".
      tracks: song.tracks.map((x, ti) => ({ ti, name: x.name, mode: x.mode, rate: x.rate, pattern: views[ti]?.pat || 'A', ch: x.ch,
        out: x.out === M.COMPUTER ? 'computer' : isXLOut(x.out) ? 'xl' : 'midi', soundName: soundOfTrack(ti)?.name || '' })) };
    const json = JSON.stringify(state);
    if (force || json !== lastSeqState) { lastSeqState = json; soundChannel?.postMessage(state); }
  }, force ? 0 : 150);
}

// Playing a take for the Recorder: on a track (`sound: { kind: 'track', ti }`, or the selected
// track when there's no sound) or on a sound kept with the take (core/sounding.js). Notes are
// scheduled in chunks so it can be stopped; `loopMs` repeats it. `at` is the wall-clock start.
let audition = null, auditionLab = null, auditionTempo = 120;
const backingLabs = new Map(), backingFx = new Map(); // backing track index -> LabSynth / FxChain, reused (they can't be disposed)
// Stopping cuts everything at once, including notes already scheduled a little ahead: Lab and test
// sounds are faded out now (with their echoes and reverb); MIDI can't be unscheduled, so All Notes Off goes now and again just
// after the last note that was already on its way.
function stopAudition() {
  if (!audition) return;
  clearInterval(audition.timer);
  auditionLab?.silence();
  for (const l of backingLabs.values()) l.silence();
  if (audition.ti !== undefined && !engine.playing) { labSynths.get(audition.ti)?.synth.silence(); synth.stopAll(); }
  if (audition.voice && !engine.playing) synth.stopAll();
  for (const { port, ch } of audition.ports) { send(port, [0xb0 | ch, 123, 0]); setTimeout(() => send(port, [0xb0 | ch, 123, 0]), 260); }
  audition = null;
}
// The XL port and channel to audition an XL sound on: an XL track's, else any XL output.
function auditionXL() {
  const t = song.tracks.find(x => isXLOut(x.out) && outPort(x.out));
  if (t) return { port: outPort(t.out), ch: t.ch - 1 };
  const port = outputs().find(looksLikeSynthOut);
  return port ? { port, ch: 1 } : null; // the XL's global channel is 2 here
}
function auditionPlayer(sound) {
  if (!sound || sound.kind === 'track') {
    const ti = song.tracks[sound?.ti] ? sound.ti : sel.t, t = song.tracks[ti], port = t.out === M.COMPUTER ? null : outPort(t.out);
    return { ti, port, ch: t.ch - 1, play: (n, v, at, dur) => playNote(ti, n, v, at, dur) };
  }
  if (sound.kind === 'lab') {
    auditionLab ||= new LabSynth(synth.wake(), synth.output());
    auditionLab.setTempo(auditionTempo);
    auditionLab.setPatch(sound.patch);
    return { play: (n, v, at, dur) => auditionLab.play(n, v, auditionLab.atTime(at), dur / 1000) };
  }
  if (sound.kind === 'voice') return { voice: true, play: (n, v, at, dur) => synth.play(sound.voice, n, v, at, dur, 1) };
  const dest = sound.kind === 'xl' ? auditionXL() : outPort(sound.out) && { port: outPort(sound.out), ch: (sound.ch || 1) - 1 };
  if (!dest) return null;
  if (sound.kind === 'xl') {
    const dev = deviceForOut(dest.port, dest.port.name);
    if (!dev || (dev.needsSysex && !sysexOk)) return null;
    send(dest.port, dev.soundMessage(dest.ch, sound.data));
    // The XL now holds this sound, not the live track's: the track's goes back at the next play.
    if (liveSound !== null) { const prev = liveSound; liveSound = null; renderTrack(prev); }
  } else if (sound.program !== null && sound.program !== undefined) send(dest.port, [0xc0 | dest.ch, sound.program]);
  return { port: dest.port, ch: dest.ch, play: (n, v, at, dur) => { send(dest.port, [0x90 | dest.ch, n, v], at); send(dest.port, [0x80 | dest.ch, n, 0], at + dur); } };
}
// A backing track (Capture: what the sequencer played under a take) as an audition player, from the
// track as it was then: its sound, effects and volume. A track whose sound changed while playing comes
// as several versions; a later version's `fromMs` is when it took over (an XL sound is sent then).
// Only one sound plays on the XL: if the take's own sound is an XL sound, backing XL tracks play
// their notes on it. `xl` tracks what was sent: { sent, own }.
function backingPlayer(t, k, xl) {
  const sound = trackSound(t);
  if (!sound) return null;
  if (t.out === M.COMPUTER) {
    if (!backingFx.has(k)) { const f = new FxChain(synth.wake()); f.tempo = auditionTempo; f.output.connect(synth.output()); backingFx.set(k, f); }
    const fx = backingFx.get(k);
    fx.set(t.fx || null);
    if (sound.kind === 'lab') {
      if (!backingLabs.has(k)) backingLabs.set(k, new LabSynth(synth.wake(), fx.input));
      const l = backingLabs.get(k);
      l.setTempo(auditionTempo);
      l.setPatch(sound.patch);
      l.setGain(gainOf(t));
      return { play: (n, v, at, dur) => l.play(n, v, l.atTime(at), dur / 1000) };
    }
    return { voice: true, play: (n, v, at, dur) => synth.play(sound.voice, n, v, at, dur, gainOf(t), fx.input) };
  }
  const dest = sound.kind === 'xl' ? auditionXL() : outPort(sound.out) && { port: outPort(sound.out) };
  if (!dest) return null;
  const ch = (t.ch || 1) - 1, port = dest.port;
  const p = { port, ch, play: (n, v, at, dur) => { send(port, [0x90 | ch, n, v], at); send(port, [0x80 | ch, n, 0], at + dur); },
    cc: (cc, v, at) => send(port, [0xb0 | ch, cc, v], at) };
  const load = at => {
    if (sound.kind === 'xl') {
      const dev = deviceForOut(port, port.name);
      if (xl.own || !dev || (dev.needsSysex && !sysexOk)) return;
      send(port, dev.soundMessage(ch, sound.data), at);
      xl.sent = true;
      if (liveSound !== null) { const prev = liveSound; liveSound = null; renderTrack(prev); }
    } else if (sound.program !== null && sound.program !== undefined) send(port, [0xc0 | ch, sound.program], at);
    send(port, [0xb0 | ch, 7, t.vol], at); // the track's volume
  };
  if (t.fromMs > 0) p.change = load; // takes over later: loaded then (and back at each loop)
  else { load(); p.wrap = load; }
  return p;
}
function auditionTake({ notes = [], sound = null, at = null, loopMs = 0, link = null, backing = null, bpm = null }) {
  stopAudition();
  synth.wake();
  // Tempo-synced settings follow the take's tempo.
  const tempo = auditionTempo = bpm || song.bpm;
  auditionLab?.setTempo(tempo);
  for (const l of backingLabs.values()) l.setTempo(tempo);
  for (const f of backingFx.values()) f.setTempo(tempo);
  const player = auditionPlayer(sound);
  if (!player) { soundChannel?.postMessage({ type: 'take-result', text: sound?.kind === 'xl' ? 'The microKORG XL isn\'t connected (or SysEx isn\'t allowed), so its sound can\'t be played.' : `${sound?.name || 'That sound'} isn't connected.` }); return; }
  const list = notes.map(n => ({ ...n, p: player }));
  const ports = player.port ? [{ port: player.port, ch: player.ch }] : [];
  let voice = player.voice, xlDelay = sound?.kind === 'xl';
  const wraps = [];
  if (backing?.notes?.length) {
    const xl = { sent: false, own: sound?.kind === 'xl' };
    const players = backing.tracks.map((t, ti) => (backing.notes.some(n => n.ti === ti) ? backingPlayer(t, ti, xl) : null));
    for (const n of backing.notes) if (players[n.ti]) list.push({ ...n, p: players[n.ti] });
    for (const c of backing.ccs || []) if (players[c.ti]?.cc) list.push({ ...c, dur: 0, p: players[c.ti] });
    players.forEach((p, ti) => {
      if (!p) return;
      if (p.port) ports.push({ port: p.port, ch: p.ch });
      if (p.voice) voice = true;
      if (p.change) list.push({ dt: Math.max(0, backing.tracks[ti].fromMs - 5), dur: 0, change: true, p });
      // Back to the first sound at each loop, if a later version of this track changed it.
      const t = backing.tracks[ti];
      if (p.wrap && backing.tracks.some(o => o !== t && o._part !== undefined && o._part === t._part && o.fromMs > 0)) wraps.push(p);
    });
    xlDelay ||= xl.sent;
  }
  list.sort((a, b) => a.dt - b.dt);
  // A sound sent to the XL needs a moment to load before the first note (150 ms wasn't enough).
  let base = Math.max(performance.now() + (xlDelay ? 400 : 60), at ? at - performance.timeOrigin : 0), k = 0;
  const pump = () => {
    const horizon = performance.now() + 200;
    for (;;) {
      if (k >= list.length) {
        if (!loopMs) { if (performance.now() > base + (list.at(-1)?.dt ?? 0) + (list.at(-1)?.dur ?? 0)) stopAudition(); return; }
        base += loopMs; k = 0;
        for (const p of wraps) p.wrap(base - 5); // sounds that changed during the loop go back
      }
      if (base + list[k].dt >= horizon) return;
      const n = list[k++];
      if (loopMs && n.dt >= loopMs) continue;
      if (n.change) n.p.change(base + n.dt);
      else if (n.cc !== undefined) n.p.cc(n.cc, n.v, base + n.dt);
      else n.p.play(n.note, n.vel, base + n.dt, loopMs ? Math.min(n.dur, loopMs - n.dt) : n.dur);
    }
  };
  audition = { timer: setInterval(pump, 50), ports, ti: player.ti, voice, link };
  if (!list.length) { stopAudition(); return; }
  pump();
}

// A take or clip into a pattern: the track and pattern the Recorder chose (else the selected
// ones), or a new track (`newRole`), optionally giving the track the clip's sound too. One undo step.
function takeToTrack({ items, fromBar = 0, bpm, synced, ti = sel.t, newRole = null, name = null, pattern = null, sound = null }) {
  const reply = (text, ok = false) => soundChannel?.postMessage({ type: 'take-result', text, ok });
  const r = putClip(song, { items, fromBar, ti, newRole, name, pattern: pattern || views[ti]?.pat, sound, xlOut: xlOutName() });
  if (r.error) { reply(r.error); return; }
  if (r.added) syncViews();
  if (sound?.kind === 'xl' && r.gave && liveSound === r.ti) liveSound = null;
  // Show where it went.
  sel = { t: r.ti, i: 0, open: true };
  views[r.ti].pat = r.pattern;
  views[r.ti].page = 0;
  changed();
  if (r.added) renderSong();
  renderTracks();
  postSeqState();
  reply(`Put ${r.bars} bar${r.bars > 1 ? 's' : ''} into ${r.added ? 'a new track, ' : ''}${r.track.name} pattern ${r.pattern}${r.gave}.`
    + (!synced && bpm !== song.bpm ? ` It was played at ${bpm} BPM; the song is at ${song.bpm}.` : ''), true);
}
// The Sound Lab's "New song from these" (a collection): a new song with a track for each sound (up
// to MAX_TRACKS), each on the computer with that sound, in the role its type suggests. Refused while
// this song has unsaved changes.
const ROLE_OF_TYPE = { Drums: 'drums', Bass: 'bass', Pad: 'pad', Strings: 'pad', Keys: 'chords', Organ: 'chords', Brass: 'chords' };
function songFromSounds({ title, sounds = [] }) {
  const reply = (text, ok = false) => soundChannel?.postMessage({ type: 'song-made', text, ok });
  if (dirty) { reply(`The Sequencer has unsaved changes to "${song.name}". Save them first, then try again.`); return; }
  const s = M.newSong();
  s.name = String(title || 'Untitled').slice(0, 60);
  s.tracks = [];
  s.song = [{ bars: 4, play: [] }];
  // Drums first, then bass, then the rest, as tracks are usually laid out.
  const order = { drums: 0, bass: 1, chords: 2, pad: 3, lead: 4 };
  const list = sounds.map(x => ({ ...x, role: ROLE_OF_TYPE[x.type] || 'lead' })).sort((a, b) => order[a.role] - order[b.role]).slice(0, M.MAX_TRACKS);
  for (const x of list) M.addTrack(s, { role: x.role, name: M.freeTrackName(s, x.name.slice(0, 24)), mode: 'steps', inst: M.cleanInst({ name: x.name, patch: x.patch }) });
  if (!s.tracks.length) { reply('No sounds to make tracks from.'); return; }
  load(s, null, true);
  parent.postMessage({ type: 'switch-view', view: 'sequencer' }, location.origin);
  reply(`Started "${s.name}" with ${s.tracks.length} tracks${sounds.length > list.length ? ` (the first ${list.length} sounds; a song has ${M.MAX_TRACKS} tracks at most)` : ''}.`, true);
}

// Capture put a clip into a saved song and asks to see it: opened unless that would lose changes.
async function openSongFor(file) {
  const reply = (text, ok = false) => soundChannel?.postMessage({ type: 'take-result', text, ok });
  if (dirty && file !== fileName) { reply(`The Sequencer has unsaved changes to "${song.name}". Save them first, then open the song again.`); return; }
  try { load(await storage.get('sequences', file), file); } catch (err) { reply(`Couldn't open ${file}: ${err.message}`); return; }
  refreshOpenList();
  reply(`Opened "${song.name}" in the Sequencer.`, true);
  parent.postMessage({ type: 'switch-view', view: 'sequencer' }, location.origin);
}
// The XL's output port name, for new tracks given an XL sound.
const xlOutName = () => song.tracks.find(x => isXLOut(x.out))?.out || outputs().find(looksLikeSynthOut)?.name || null;

// ---- Recording our own sound: the Recorder's Audio in "Ostinato (what it plays)" ----
// Everything this page plays (tracks, Lab instruments, keys played through), after the limiter;
// the metronome isn't in it. Saved as WAV like the Recorder's other recordings.
let ownTap = null, ownMonitor = false, ownPeak = 0, ownLevelAt = 0;
function ownAudio() {
  ownTap ||= new Tap(synth.wake(), synth.mixOutput(), { onLevel: p => {
    ownPeak = Math.max(ownPeak, p);
    const now = performance.now();
    if (ownMonitor && now - ownLevelAt > 80) { soundChannel?.postMessage({ type: 'own-level', peak: ownPeak }); ownPeak = 0; ownLevelAt = now; }
  } });
  return ownTap.start().then(() => ownTap);
}
const stamp = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`; };
async function saveOwn(chans, name) {
  const reply = (text, ok) => soundChannel?.postMessage({ type: 'take-result', text, ok });
  if (!chans?.[0]?.length) { reply('Nothing was recorded.'); return; }
  try {
    const file = await storage.save('audio', encodeWav(chans, ownTap.sampleRate), name);
    soundChannel?.postMessage({ type: 'recordings-changed' });
    reply(`Saved ${placeOf('audio', file)}`, true);
  } catch (err) { reply(`Couldn't save the recording: ${err.message}`); }
}
async function onOwnAudio(m) {
  if (m.cmd === 'monitor') { ownMonitor = !!m.on; if (ownMonitor) ownAudio(); }
  else if (m.cmd === 'start') { (await ownAudio()).record(); }
  else if (m.cmd === 'stop' && ownTap?.recording) { const name = `Recording ${stamp(Date.now())} (Ostinato)`; saveOwn((await ownTap.finish())?.chans, name); }
}

// A performance: count in, play, and stop after `bars` (or the song; null = until stopped).
// With ownAudio, our own sound is recorded too, from bar 1 to the end of the last notes.
async function recordPerformance({ bars, countIn, ownAudio: own }) {
  if (engine.playing) stop();
  if (own) (await ownAudio()).record();
  if (bars === 'song') {
    prefs.mode = 'song'; savePrefs(); engine.setMode('song'); renderTop(); paintSong();
    bars = song.song.reduce((n, x) => n + x.bars, 0);
  }
  perf = { timer: null, own: !!own };
  const started = play({ countIn });
  if (!started) return;
  const { t0, countIn: ci } = started;
  perf.t0 = t0;
  soundChannel?.postMessage({ type: 'performance', state: 'start', wall: performance.timeOrigin + t0 - ci - 250 });
  if (bars) perf.timer = setTimeout(() => endRun(perf, 1500), t0 - performance.now() + bars * M.barTicks(song.meter) * 60000 / (song.bpm * M.TICKS_PER_BEAT) + 30);
}

// A stem: one XL track of the song, solo, from bar 1 to the end, then `tail` seconds to ring out.
// Solo and mute are put back afterwards (and never become an undo step).
function printStem({ ti, tail = 2 }) {
  if (engine.playing) stop();
  if (!song.tracks[ti]) { soundChannel?.postMessage({ type: 'stem', state: 'end' }); return; }
  const saved = song.tracks.map(t => [t.mute, t.solo]), savedMode = prefs.mode;
  song.tracks.forEach((t, k) => { t.solo = k === ti; t.mute = false; });
  prefs.mode = 'song';
  engine.setMode('song');
  stem = { restore() {
    song.tracks.forEach((t, k) => { [t.mute, t.solo] = saved[k] || [t.mute, t.solo]; });
    prefs.mode = savedMode;
    engine.setMode(savedMode);
    renderTop(); renderTracks(); paintSong();
  } };
  renderTracks();
  // Half a second before bar 1, so the XL has loaded the track's sound.
  const started = play({ countIn: false, delay: 500 });
  if (!started) return;
  const ms = M.songTicks(song) * 60000 / (song.bpm * M.TICKS_PER_BEAT);
  soundChannel?.postMessage({ type: 'stem', state: 'start', wall: performance.timeOrigin + started.t0, ms, ti });
  stem.timer = setTimeout(() => endRun(stem, tail * 1000), started.t0 - performance.now() + ms + 30);
}

function onRecorderMessage(m) {
  switch (m.type) {
    case 'get-seq-state': postSeqState(true); postTransport(); return true;
    case 'audition-take': auditionTake(m); return true;
    case 'stop-audition': stopAudition(); return true;
    case 'take-to-track': takeToTrack(m); return true;
    case 'open-song': openSongFor(m.file); return true;
    case 'sequences-changed': refreshOpenList(); return true;
    case 'new-song-from-sounds': songFromSounds(m); return true;
    // Capture making an audio file: the master effects, and a track's settings if it plays on one.
    case 'rack-edit': onRackEdit(m); return true;
    case 'get-mix': soundChannel?.postMessage({ type: 'mix', masterFx: song.masterFx || null, track: song.tracks[m.ti] ? trackCopy(m.ti) : null }); return true;
    case 'clips-changed': loadClips(); return true;
    case 'set-tempo': song.bpm = Math.max(20, Math.min(300, Math.round(m.bpm))); changed(); renderTop(); postSeqState(); return true;
    case 'record-performance': recordPerformance(m); return true;
    case 'stop-sequencer': stop(); return true;
    // The transport in the other tabs' top bars.
    case 'transport-cmd':
      if (m.cmd === 'play' && !engine.playing) { synth.wake(); play(); } else if (m.cmd === 'stop') stop(); else if (m.cmd === 'rec') setRec(!rec.on);
      return true;
    case 'print-stem': printStem(m); return true;
    case 'own-audio': onOwnAudio(m); return true;
    case 'library-changed': refreshOpenList(); loadMine(); loadClips(); return true; // after an import
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Files to download

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const midName = name => `${name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'song'}.mid`;
$('#export').onclick = () => {
  const r = songToMidi(song);
  if (!r.tracks.some(t => t.notes.length)) { toast('The song has no notes to export.'); return; }
  download(writeMidi(r), midName(song.name));
  toast(`Exported ${r.bars} bars at ${r.bpm} BPM, one MIDI track per sequencer track. Drag the file into Ableton's Arrangement view.`, 'ok');
};

// ---------------------------------------------------------------------------------------------
// Editing

// A note-pool track's steps are only rhythm: clicking an empty step turns it on; clicking a step
// that's on selects it (to change its length, velocity…), and clicking it again turns it off.
function poolStep(ti, i, on) {
  const wasSel = sel.t === ti && sel.i === i;
  select(ti, i, sel.open || sel.t !== ti);
  if (!on) edit(ti, () => addNoteAt(ti, i));
  else if (wasSel) edit(ti, () => M.removeStep(viewPattern(ti), i));
}

function select(ti, i, open = true) {
  const prev = sel.t;
  sel = { t: ti, i, open };
  if (prev !== ti) postSeqState();
  if (prev !== ti && song.tracks[prev]) renderTrack(prev);
  renderTrack(ti);
  // Live switching: the XL plays the selected track's sound.
  const t = song.tracks[ti];
  if (prev !== ti && prefs.soundFollows && t.sound && isXLOut(t.out) && liveSound !== ti) sendSound(ti);
}

function edit(ti, fn, opts) {
  fn();
  changed(opts);
  renderTrack(ti);
}

function addNoteAt(ti, i) {
  const t = song.tracks[ti], v = views[ti];
  M.putStep(viewPattern(ti), i, { notes: t.mode === 'pool' ? [] : [v.lastNote] });
}

const trackEl = e => e.target.closest('[data-t]');

$('#tracks').addEventListener('click', e => {
  const el = e.target.closest('[data-act]'), tEl = trackEl(e);
  if (!el || !tEl) return;
  const ti = +tEl.dataset.t, t = song.tracks[ti], v = views[ti], pat = viewPattern(ti);
  const s = M.stepAt(pat, sel.i);
  switch (el.dataset.act) {
    case 'head':
      if (e.target === el || e.target.classList.contains('dot') || e.target.classList.contains('th-row')) select(ti, sel.t === ti ? sel.i : 0, sel.open);
      break;
    case 'plays': {
      // The track's sound: selects the track, then opens where its sound is chosen.
      if (sel.t !== ti) select(ti, 0, sel.open);
      const chip = () => document.querySelector(`#trk-${ti} [data-act="plays"]`);
      if (t.out === M.COMPUTER) pickTrackSound(ti, chip());
      else if (isXLOut(t.out)) { if (!v.snd.open) openSounds(ti); }
      else document.querySelector(`#trk-${ti} [data-act="${t.out !== M.COMPUTER && outPort(t.out) ? 'prog' : 'out'}"]`)?.focus();
      break;
    }
    case 'feel-edit': v.feelOpen = !v.feelOpen; renderTrack(ti); break;
    case 'col':
      v.collapsed = !v.collapsed;
      prefs.collapsed = views.map(x => x.collapsed); savePrefs();
      renderTrack(ti);
      break;
    case 'pat': {
      const p = el.dataset.p;
      if (prefs.mode === 'loop') {
        if (t.pattern !== p) { t.pattern = p; changed(); }
        if (engine.playing) {
          if (p === live.pattern[ti]) engine.queued.delete(ti); else engine.queue(ti, p);
          if (!prefs.follow) { v.pat = p; v.page = 0; }
        } else { v.pat = p; v.page = 0; }
      } else { v.pat = p; v.page = 0; }
      if (sel.t === ti) sel.i = Math.min(sel.i, viewPattern(ti).length - 1);
      renderTrack(ti);
      break;
    }
    case 'copy':
      clipboard = M.copyPattern(pat);
      toast(`Copied ${t.name} pattern ${v.pat}. Use Paste on any pattern.`);
      renderTracks();
      break;
    case 'paste': if (clipboard) edit(ti, () => { t.patterns[v.pat] = M.copyPattern(clipboard); }); break;
    case 'clear': edit(ti, () => { pat.steps = []; }); break;
    case 'mode': if (t.mode !== el.dataset.m) edit(ti, () => { t.mode = el.dataset.m; }); break;
    case 'view': v.roll = el.dataset.v === 'roll'; prefs.roll = { ...prefs.roll, [ti]: v.roll }; savePrefs(); renderTrack(ti); break;
    case 'roll-key': preview(ti, +el.dataset.n); break;
    case 'roll-scroll': v.rollTop = Math.max(ROLL_ROWS - 1, Math.min(127, rollTop(ti) + +el.dataset.d)); refreshGrid(ti); break;
    case 'mute': edit(ti, () => { t.mute = !t.mute; }); break;
    case 'fx-off': if (t.fx) edit(ti, () => { if (t.fx.off) delete t.fx.off; else t.fx.off = true; }); break;
    case 'arm': toggleArm(ti); break;
    case 'solo': t.solo = !t.solo; changed(); renderTracks(); break;
    case 'del-track':
      if (song.tracks.length <= 1) { toast('A song needs at least one track.'); break; }
      if (!confirm(`Remove the track "${t.name}"? (Undo can bring it back.)`)) break;
      M.removeTrack(song, ti);
      views.splice(ti, 1);
      liveSound = null;
      armed = armed === ti ? null : armed > ti ? armed - 1 : armed;
      if (sel.t >= ti && sel.t > 0) sel.t--;
      changed();
      renderSong(); renderTracks();
      break;
    case 'page': v.page = +el.dataset.pg; renderTrack(ti); break;
    case 'cell': case 'blk':
      if (e.target.classList.contains('handle')) break;
      if (t.mode === 'pool') { poolStep(ti, +el.dataset.s, el.dataset.act === 'blk'); break; }
      select(ti, +el.dataset.s);
      break;
    case 'e-on':
      edit(ti, () => { if (el.checked) addNoteAt(ti, sel.i); else M.removeStep(pat, sel.i); });
      break;
    case 'e-close': sel.open = false; renderTrack(ti); break;
    case 'oct': v.kbdLow = Math.max(0, Math.min(84, v.kbdLow + +el.dataset.d)); renderTrack(ti); break;
    case 'key': {
      const n = +el.dataset.n;
      v.lastNote = n;
      edit(ti, () => {
        if (!s) M.putStep(pat, sel.i, { notes: [n] });
        else if (s.notes.includes(n)) { s.notes = s.notes.filter(x => x !== n); if (!s.notes.length) M.removeStep(pat, sel.i); }
        else s.notes = [...s.notes, n].sort((a, b) => a - b);
      });
      if (M.stepAt(pat, sel.i)?.notes.includes(n)) preview(ti, n);
      break;
    }
    case 'pool-key': {
      const n = +el.dataset.n, has = t.pool.notes.includes(n);
      edit(ti, () => { t.pool.notes = has ? t.pool.notes.filter(x => x !== n) : [...t.pool.notes, n]; });
      if (!has) preview(ti, n);
      break;
    }
    case 'p-clear': edit(ti, () => { t.pool.notes = []; }); break;
    case 'ai':
      v.ai.open = !v.ai.open;
      if (v.ai.open) checkAiStatus(); // the provider may have changed in the microKORG XL editor
      renderTrack(ti);
      if (v.ai.open) document.querySelector(`#trk-${ti} .ai-msg`)?.focus();
      break;
    case 'ai-set': v.ai[el.dataset.key] = el.dataset.val; renderTrack(ti); break;
    case 'ai-go': synth.wake(); generate(ti); break;
    case 'ai-surprise': synth.wake(); generate(ti, { surprise: true }); break;
    case 'dice': rollDice(ti); break;
    case 'mutate': mutateIdea(ti); break;
    case 'lane-name': preview(ti, +el.dataset.n); break;
    case 'sound':
      if (t.sound) {
        sendSound(ti);
        if (top !== self) parent.postMessage({ type: 'switch-view', view: 'instruments' }, location.origin);
      } else if (editorSound) {
        t.sound = { ...editorSound };
        liveSound = ti;
        changed();
        renderTracks();
        toast(`${t.name} now uses ${t.sound.name || 'this sound'}. Changes you make in the microKORG XL editor are remembered for this track.`, 'ok');
      } else toast('Open a sound in the microKORG XL editor first.');
      break;
    case 'lib':
      v.lib.open = !v.lib.open;
      renderTrack(ti);
      if (v.lib.open) document.querySelector(`#trk-${ti} [data-act="lib-q"]`)?.focus();
      break;
    case 'lib-source': v.lib.source = el.dataset.val; renderTrack(ti); break;
    case 'pick-sound': pickTrackSound(ti, el); break;
    case 'snd':
      if (v.snd.open) { endTrying(ti); v.snd.open = false; renderTrack(ti); } else openSounds(ti);
      break;
    case 'snd-try': { const x = sounds?.find(y => y.key === el.dataset.key); if (x) trySound(ti, x); break; }
    case 'snd-back': endTrying(ti); renderTrack(ti); break;
    case 'snd-use': {
      const x = sounds?.find(y => y.key === v.snd.trying);
      if (!x) break;
      t.sound = { name: x.name.trim(), data: [...x.data] };
      v.snd.trying = null;
      v.snd.open = false;
      changed();
      sendSound(ti); // also shows it in the microKORG XL editor, where edits are kept for this track
      toast(`${t.name} now uses ${t.sound.name}.`, 'ok');
      break;
    }
    case 'lib-use': if (!e.target.closest('[data-act="lib-del"]')) useLibrary(ti, el.dataset.id); break;
    case 'lib-del': deleteMine(el.dataset.file); break;
    case 'star': starPattern(ti); break;
    case 'idea-pick': applyIdea(ti, +el.dataset.k); break;
    case 'idea-original': originalIdea(ti); break;
    case 'idea-keep': keepIdea(ti); break;
    case 'ai-cancel': v.ai.ctrl?.abort(); break;
    case 'cc-add': {
      const used = new Set((pat.cc || []).map(x => x.cc));
      const cc = [74, 71, 1, 11, 7, 10].find(n => !used.has(n)) ?? CC_LIST.find(n => !used.has(n));
      edit(ti, () => { pat.cc = [...(pat.cc || []), { cc, glide: false, steps: [] }]; });
      break;
    }
    case 'cc-del': edit(ti, () => { pat.cc.splice(+el.dataset.l, 1); if (!pat.cc.length) delete pat.cc; }); learning = null; break;
    case 'cc-learn': {
      const l = +el.dataset.l;
      learning = learning?.ti === ti && learning.l === l ? null : { ti, l };
      if (learning && !prefs.keysIn) toast('Choose your keyboard under MIDI in first.');
      renderTrack(ti);
      break;
    }
  }
});

$('#tracks').addEventListener('keydown', e => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest('.snd-panel')) {
    e.preventDefault();
    e.stopPropagation();
    const ti = +trackEl(e).dataset.t, items = sndItems(ti).slice(0, 400);
    if (!items.length) return;
    const k = items.findIndex(x => x.key === views[ti].snd.trying);
    trySound(ti, items[Math.max(0, Math.min(items.length - 1, k < 0 ? 0 : k + (e.key === 'ArrowDown' ? 1 : -1)))]);
    return;
  }
  if (e.target.dataset.act === 'ai-msg' && e.key === 'Enter') {
    e.preventDefault();
    const ti = +trackEl(e).dataset.t;
    synth.wake();
    generate(ti);
  }
});

function toggleArm(ti) {
  const prev = armed;
  armed = armed === ti ? null : ti;
  if (armed !== null && sel.t !== ti) select(ti, 0, true);
  else { if (armed !== null) sel.open = true; renderTrack(ti); }
  if (prev !== null && prev !== ti && song.tracks[prev]) renderTrack(prev);
  if (armed !== null) toast(`${song.tracks[ti].name} is armed: notes you play go into it.`);
}

$('#tracks').addEventListener('dblclick', e => {
  // Double-clicking the header (not a control in it) arms or disarms the track.
  const head = e.target.closest('.track-head');
  if (head && !e.target.closest('button, input, select, label, .pats')) { toggleArm(+trackEl(e).dataset.t); return; }
  const el = e.target.closest('[data-act="cell"], [data-act="blk"]'), tEl = trackEl(e);
  if (!el || !tEl || e.target.classList.contains('handle') || el.classList.contains('lane-num')) return;
  const ti = +tEl.dataset.t, i = +el.dataset.s;
  if (song.tracks[ti].mode === 'pool') return; // single clicks turn its steps on and off
  sel = { t: ti, i, open: sel.open || sel.t !== ti };
  edit(ti, () => { if (el.dataset.act === 'cell') addNoteAt(ti, i); else M.removeStep(viewPattern(ti), i); });
  if (el.dataset.act === 'cell' && song.tracks[ti].mode === 'steps') preview(ti, views[ti].lastNote);
});

// Inputs: 'input' for live sliders, 'change' for everything else.
$('#tracks').addEventListener('input', e => {
  const el = e.target, tEl = trackEl(e);
  if (tEl && el.dataset.act === 'ai-msg') { views[+tEl.dataset.t].ai.message = el.value; return; }
  if (tEl && el.dataset.act === 'vol') {
    const t = song.tracks[+tEl.dataset.t];
    t.vol = +el.value;
    if (t.out !== M.COMPUTER) sendVolume(t);
    changed({ coalesce: true });
    return;
  }
  if (tEl && el.dataset.act === 'feel-set') {
    const ti = +tEl.dataset.t;
    setFeel(ti, el.dataset.k, +el.value);
    const v = +el.value;
    el.parentElement.querySelector('.val').textContent = `${v > 0 && +el.min < 0 ? '+' : ''}${v}${el.dataset.k === 'vel' ? '' : ' ms'}`;
    changed({ coalesce: true });
    const sel = tEl.querySelector('[data-act="feel"]');
    if (sel && !sel.querySelector('[value="__custom"]')) sel.insertAdjacentHTML('beforeend', '<option value="__custom">custom</option>');
    if (sel) sel.value = song.tracks[ti].feel ? '__custom' : 'Tight';
    return;
  }
  if (tEl && el.dataset.act === 'fx-mix') {
    const t = song.tracks[+tEl.dataset.t];
    if (t.fx) { t.fx.mix = +el.value / 100; changed({ coalesce: true }); }
    return;
  }
  if (tEl && el.dataset.act === 'snd-q') {
    const ti = +tEl.dataset.t;
    views[ti].snd.q = el.value;
    tEl.querySelector('.snd-panel .lib-list').innerHTML = sndRows(ti);
    return;
  }
  if (tEl && el.dataset.act === 'lib-q') {
    const ti = +tEl.dataset.t;
    views[ti].lib.q = el.value;
    tEl.querySelector('.lib-list').innerHTML = libRows(ti);
    return;
  }
  if (!tEl || !['e-vel', 'e-gate'].includes(el.dataset.act)) return;
  const ti = +tEl.dataset.t, s = M.stepAt(viewPattern(ti), sel.i);
  if (!s) return;
  if (el.dataset.act === 'e-vel') { s.vel = +el.value; delete s.nv; tEl.querySelector('.e-vel').textContent = s.vel; }
  else { s.gate = +el.value; tEl.querySelector('.e-gate').textContent = `${s.gate}%`; }
  changed({ coalesce: true });
  refreshGrid(ti);
});

$('#tracks').addEventListener('change', e => {
  const el = e.target, tEl = trackEl(e);
  if (!tEl) return;
  const ti = +tEl.dataset.t, t = song.tracks[ti], v = views[ti], pat = viewPattern(ti);
  switch (el.dataset.act) {
    case 'name': t.name = el.value.trim().slice(0, 24) || `Track ${ti + 1}`; changed(); renderSong(); break;
    case 'len': edit(ti, () => {
      pat.length = Math.max(1, Math.min(M.MAX_STEPS, Math.round(+el.value) || 1));
      // Notes past the end are kept (hidden), so making a pattern longer again brings them back.
      v.page = Math.min(v.page, pages(ti) - 1);
      if (sel.t === ti) sel.i = Math.min(sel.i, pat.length - 1);
    }); break;
    case 'role': edit(ti, () => { t.role = el.value; }); break;
    case 'feel': if (el.value !== '__custom') edit(ti, () => { const p = M.FEEL_PRESETS[el.value]; t.feel = p ? M.cleanFeel({ ...p, preset: el.value }) : null; }); break;
    case 'fit': edit(ti, () => { if (el.value) pat.beats = +el.value; else delete pat.beats; }); break;
    case 'lane-len': edit(ti, () => {
      const n = +el.dataset.n, ll = { ...pat.laneLen };
      if (el.value) ll[n] = +el.value; else delete ll[n];
      if (Object.keys(ll).length) pat.laneLen = ll; else delete pat.laneLen;
    }); break;
    case 'out': edit(ti, () => { t.out = el.value; }); if (liveSound === ti && !isXLOut(t.out)) liveSound = null; break;
    case 'ch': edit(ti, () => { t.ch = +el.value; }); break;
    case 'fx': edit(ti, () => { t.fx = pickFx(el.value, t.fx); }); break;
    case 'prog': {
      edit(ti, () => { t.program = el.value === '' ? null : +el.value; });
      const port = outPort(t.out);
      if (port && t.program !== null) send(port, [0xc0 | (t.ch - 1), t.program]); // hear it right away
      break;
    }
    case 'rate': edit(ti, () => { t.rate = el.value; }); break;
    case 'e-len': {
      const s = M.stepAt(pat, sel.i);
      if (s) edit(ti, () => { s.len = Math.max(1, Math.min(M.maxLen(pat, sel.i), Math.round(+el.value) || 1)); });
      break;
    }
    case 'e-prob': case 'e-rat': {
      const s = M.stepAt(pat, sel.i), key = el.dataset.act === 'e-prob' ? 'prob' : 'rat', val = +el.value;
      if (s) edit(ti, () => { if (val === (key === 'prob' ? 100 : 1)) delete s[key]; else s[key] = val; });
      break;
    }
    case 'cc-num': {
      const lane = pat.cc?.[+el.dataset.l], n = +el.value;
      if (!lane) break;
      if (pat.cc.some(x => x !== lane && x.cc === n)) { toast(`This pattern already has a lane for ${ccName(n)}.`); renderTrack(ti); break; }
      edit(ti, () => { lane.cc = n; });
      break;
    }
    case 'cc-glide': { const lane = pat.cc?.[+el.dataset.l]; if (lane) edit(ti, () => { lane.glide = el.checked; }); break; }
    case 'p-order': edit(ti, () => { t.pool.order = el.value; }); break;
    case 'ai-role': v.ai.role = el.value; renderTrack(ti); break;
    case 'ai-register': v.ai.register = el.value; break;
    case 'ai-style': v.ai.style = el.value; renderTrack(ti); break;
    case 'ai-fit': v.ai.fit = el.checked; break;
    case 'ai-n': v.ai.n = +el.value; break;
    case 'idea-put': if (el.value) putIdea(ti, el.value); break;
    case 'idea-cross': if (el.value !== '') crossIdea(ti, +el.value); break;
    case 'lib-role': v.lib.role = el.value; renderTrack(ti); break;
    case 'snd-type': v.snd.type = el.value; renderTrack(ti); break;
    case 'snd-bank': v.snd.bank = el.value; renderTrack(ti); break;
    case 'lane-add': if (el.value) { v.lanes = [...(v.lanes || []), +el.value]; preview(ti, +el.value); renderTrack(ti); } break;
    case 'p-latch': edit(ti, () => { t.pool.latch = el.checked; }); break;
  }
});

// Drum grid: click or drag along a row to paint hits (or erase, if the first cell was on).
$('#tracks').addEventListener('pointerdown', e => {
  const cell = e.target.closest('.lane-cell');
  if (!cell) return;
  e.preventDefault();
  const ti = +trackEl(e).dataset.t, note = +cell.dataset.n, i = +cell.dataset.s;
  const s = M.stepAt(viewPattern(ti), i), on = !!s && s.notes.includes(note);
  if (e.shiftKey && on) { // accent (or not) this drum only
    const nv = { ...s.nv, [note]: M.velOf(s, note) >= 110 ? 100 : 120 };
    const next = M.drumStep(i, s.notes.map(n => [n, nv[n] ?? s.vel]));
    delete s.nv;
    Object.assign(s, { vel: next.vel, ...(next.nv ? { nv: next.nv } : {}) });
    changed(); refreshGrid(ti); return;
  }
  setHit(ti, i, note, !on);
  if (!on) preview(ti, note);
  refreshGrid(ti);
  const over = ev => {
    const c = ev.target.closest?.('.lane-cell');
    if (!c || +c.dataset.n !== note || +c.closest('[data-t]').dataset.t !== ti) return;
    const cs = M.stepAt(viewPattern(ti), +c.dataset.s);
    if ((!!cs && cs.notes.includes(note)) === !on) return;
    setHit(ti, +c.dataset.s, note, !on);
    refreshGrid(ti);
  };
  const up = () => {
    removeEventListener('pointerover', over);
    removeEventListener('pointerup', up);
    changed();
    renderTrack(ti);
  };
  addEventListener('pointerover', over);
  addEventListener('pointerup', up);
});

// Controller lanes: click or drag to draw values; ⌥ (Alt) clears.
$('#tracks').addEventListener('pointerdown', e => {
  const cell = e.target.closest('.cc-cell');
  if (!cell) return;
  e.preventDefault();
  const ti = +trackEl(e).dataset.t, l = +cell.dataset.l, clear = e.altKey;
  setCC(ti, l, cell, e.clientY, clear);
  refreshGrid(ti);
  const move = ev => {
    const c = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cc-cell');
    if (!c || +c.dataset.l !== l || +c.closest('[data-t]').dataset.t !== ti) return;
    setCC(ti, l, c, ev.clientY, clear);
    refreshGrid(ti);
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    changed();
    renderTrack(ti);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});

// Drag a note's right edge to change how long it's held.
$('#tracks').addEventListener('pointerdown', e => {
  if (!e.target.classList.contains('handle')) return;
  e.preventDefault();
  const blk = e.target.closest('.blk'), ti = +trackEl(e).dataset.t, si = +blk.dataset.s;
  const pat = viewPattern(ti), s = M.stepAt(pat, si), v = views[ti];
  const grid = blk.parentElement.getBoundingClientRect(), PS = pageSize(ti), limit = M.maxLen(pat, si);
  const before = s.len;
  sel = { t: ti, i: si, open: sel.open };
  const move = ev => {
    const col = Math.max(0, Math.min(PS - 1, Math.floor((ev.clientX - grid.left) / (grid.width / PS))));
    const len = Math.max(1, Math.min(v.page * PS + col - si + 1, limit));
    if (len !== s.len) { s.len = len; refreshGrid(ti); }
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (s.len !== before) changed();
    renderTrack(ti);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});

// Song grid
$('#song').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const i = +el.dataset.sec, n = song.song.length;
  switch (el.dataset.act) {
    case 'cell': {
      const order = [...M.PATTERNS, null], sec = song.song[i], ti = +el.dataset.t;
      sec.play[ti] = order[(order.indexOf(sec.play[ti]) + 1) % order.length];
      songSel = i;
      break;
    }
    case 'sec-pick': songSel = i; renderSong(); return;
    case 'sec-play': playFrom(songSel); return;
    case 'sec-loop':
      loopSec = loopSec === songSel ? null : songSel;
      engine.loopSection = loopSec;
      if (loopSec !== null) playFrom(loopSec);
      renderSong();
      return;
    case 'auto-add': {
      const t = song.tracks[autoPick.ti], target = autoPick.target === 'cc' && t.out === M.COMPUTER ? 'filter' : autoPick.target;
      const lane = { ti: autoPick.ti, target, ...(target === 'cc' ? { cc: autoPick.cc } : {}), points: [] };
      song.auto ||= [];
      if (song.auto.some(l => l.ti === lane.ti && l.target === lane.target && l.cc === lane.cc)) { toast(`${t.name} already has a ${autoName(lane)} lane.`); return; }
      song.auto.push(lane);
      if (prefs.mode !== 'song') toast('Automation plays in Play song mode.');
      break;
    }
    case 'auto-del': song.auto.splice(+el.dataset.k, 1); resetAuto(); break;
    case 'open-chords': prefs.chordsOpen = true; savePrefs(); renderChords(); $('#chords').scrollIntoView({ block: 'center', behavior: 'smooth' }); return;
    case 'add-sec': {
      const last = song.song.at(-1);
      song.song.push({ ...JSON.parse(JSON.stringify(last)), name: undefined });
      delete song.song.at(-1).name;
      songSel = song.song.length - 1;
      break;
    }
    case 'sec-dup': {
      const copy = JSON.parse(JSON.stringify(song.song[songSel]));
      song.song.splice(songSel + 1, 0, copy);
      if (loopSec !== null && loopSec > songSel) loopSec++;
      songSel++;
      break;
    }
    case 'sec-move': {
      const to = songSel + +el.dataset.d;
      if (to < 0 || to >= n) return;
      [song.song[songSel], song.song[to]] = [song.song[to], song.song[songSel]];
      if (loopSec === songSel) loopSec = to; else if (loopSec === to) loopSec = songSel;
      songSel = to;
      break;
    }
    case 'del-sec':
      if (n <= 1) return;
      song.song.splice(songSel, 1);
      if (loopSec === songSel) loopSec = null; else if (loopSec !== null && loopSec > songSel) loopSec--;
      songSel = Math.max(0, songSel - 1);
      break;
    default: return;
  }
  changed();
  renderSong();
});
$('#song').addEventListener('change', e => {
  const a = e.target.dataset.act;
  if (a === 'auto-ti' || a === 'auto-target' || a === 'auto-cc') {
    if (a === 'auto-ti') autoPick.ti = +e.target.value;
    else if (a === 'auto-target') autoPick.target = e.target.value;
    else autoPick.cc = Math.max(1, Math.min(119, Math.round(+e.target.value) || 1));
    renderSong();
    return;
  }
  if (e.target.dataset.act === 'sec-fill') {
    const sec = song.song[songSel], ti = +e.target.dataset.t;
    sec.fill ||= song.tracks.map(() => null);
    sec.fill[ti] = e.target.value || null;
    if (!sec.fill.some(Boolean)) delete sec.fill;
    changed();
    renderSong();
    return;
  }
  if (e.target.dataset.act === 'sec-name') {
    const sec = song.song[songSel], name = e.target.value.trim().slice(0, 24);
    if (name) sec.name = name; else delete sec.name;
    changed();
    renderSong();
    return;
  }
  if (e.target.dataset.act === 'sec-meter') {
    const sec = song.song[+e.target.dataset.sec];
    if (e.target.value) sec.meter = e.target.value; else delete sec.meter;
    changed();
    renderSong();
    return;
  }
  if (e.target.dataset.act !== 'bars') return;
  song.song[+e.target.dataset.sec].bars = +e.target.value;
  changed();
  renderSong();
});

// Top bar
$('#meter').innerHTML = M.METERS.map(m => `<option>${m}</option>`).join('');
$('#meter').addEventListener('change', e => {
  song.meter = e.target.value;
  // Sections that had the new song meter as their own don't need it any more.
  song.song.forEach(s => { if (s.meter === song.meter) delete s.meter; });
  changed();
  renderTop();
  renderSong();
  renderTracks();
  const t = song.tracks[sel.t], steps = M.stepsPerBar(song.meter, M.RATES[t.rate]);
  if (song.meter !== '4/4' && steps) toast(`A bar of ${song.meter} is ${steps} steps at ${t.rate}. Patterns keep their length: set Length to ${steps} (or a multiple) to fit the bar, or leave them to drift against it.`);
});
// "four beats", "seven eighth notes"
function barWords(m) {
  const { n, d } = M.meterParts(m), words = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];
  return d === 4 ? `${words[n]} beat${n === 1 ? '' : 's'}` : `${words[n]} eighth notes`;
}
$('#play').onclick = () => play();
$('#stop').onclick = stop;
$('#rec').onclick = () => setRec(!rec.on);
$('#bpm').addEventListener('input', e => {
  const v = Math.round(+e.target.value);
  if (v >= 20 && v <= 300) { song.bpm = v; changed({ coalesce: true }); }
});
$('#bpm').addEventListener('change', () => renderTop());
$('#swing').addEventListener('input', e => { song.swing = +e.target.value; $('#swing-val').textContent = `${song.swing}%`; changed({ coalesce: true }); });
$('#scale-root').innerHTML = options(M.NOTE_NAMES.map((n, i) => [i, n]), 0);
$('#scale-type').innerHTML = options([['', 'Off'], ...Object.keys(M.SCALES).map(s => [s, s])], '');
const setScale = () => {
  const type = $('#scale-type').value;
  song.scale = type ? { root: +$('#scale-root').value, type } : null;
  changed();
  renderTop();
  renderTracks();
};
$('#scale-root').onchange = setScale;
$('#scale-type').onchange = setScale;
document.querySelectorAll('#mode button').forEach(b => b.onclick = () => {
  prefs.mode = b.dataset.m; savePrefs();
  engine.setMode(prefs.mode);
  if (prefs.mode !== 'song') resetAuto();
  renderTop(); paintSong();
});
$('#follow').onchange = e => { prefs.follow = e.target.checked; savePrefs(); };
$('#sound-follows').checked = prefs.soundFollows;
$('#sound-follows').onchange = e => { prefs.soundFollows = e.target.checked; savePrefs(); };
// Open the Clock out menu towards whichever side has room (the top bar wraps on narrow windows).
$('#clock-out').addEventListener('toggle', () => {
  const r = $('#clock-out').getBoundingClientRect(), body = $('#clock-list');
  const rightward = r.right - 260 < 8;
  body.style.left = rightward ? '0' : 'auto';
  body.style.right = rightward ? 'auto' : '0';
});
$('#song-col').onclick = () => { prefs.songOpen = !prefs.songOpen; savePrefs(); renderSong(); };
$('#song').addEventListener('keydown', e => { if (e.target.dataset.act === 'sec-name' && e.key === 'Enter') e.target.blur(); });
let songResize = null; // bar widths follow the window
addEventListener('resize', () => { clearTimeout(songResize); songResize = setTimeout(renderSong, 150); });
$('#collapse-all').onclick = () => {
  const all = views.every(v => v.collapsed);
  views.forEach(v => { v.collapsed = !all; });
  prefs.collapsed = views.map(v => v.collapsed); savePrefs();
  $('#collapse-all').textContent = all ? 'Collapse all' : 'Expand all';
  renderTracks();
};
// + Add track: pick what it's for (STARTER_TRACKS in putclip.js).
function addTrackOf(role) {
  const s = STARTER_TRACKS[role], t = addStarterTrack(song, role);
  if (!t) { toast(`Up to ${M.MAX_TRACKS} tracks.`); return; }
  syncViews();
  sel = { t: song.tracks.length - 1, i: 0, open: true };
  changed();
  renderSong(); renderTracks();
  document.querySelector(`#trk-${song.tracks.length - 1}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  toast(`Added ${t.name}, playing ${s.sound} on the computer. Change its sound or Out on its second row.`);
}
$('#add-track-menu').innerHTML = Object.entries(STARTER_TRACKS).map(([role, s]) =>
  `<button role="menuitem" data-role="${role}"><b>${esc(M.ROLES[role])}</b><span>${esc(s.blurb)} · starts with ${esc(s.sound)}</span></button>`).join('');
$('#add-track').onclick = () => { $('#add-track-menu').hidden = !$('#add-track-menu').hidden; };
$('#add-track-menu').onclick = e => { const b = e.target.closest('[data-role]'); if (!b) return; $('#add-track-menu').hidden = true; addTrackOf(b.dataset.role); };
document.addEventListener('pointerdown', e => { if (!e.target.closest('.add-track-wrap')) $('#add-track-menu').hidden = true; });
$('#keys-in').onchange = e => { prefs.keysIn = e.target.value || null; prefs.keysInAuto = false; savePrefs(); held.length = 0; };
// Clicking the amber light (or its text) switches MIDI in to the port the notes came from.
for (const id of ['#keys-led', '#keys-last']) $(id).addEventListener('click', e => {
  if (!lastOther) return;
  e.preventDefault();
  prefs.keysIn = lastOther; prefs.keysInAuto = false; savePrefs();
  held.length = 0;
  lastOther = null;
  $('#keys-last').textContent = '';
  $('#keys-last').classList.remove('fix');
  renderPorts();
  toast(`MIDI in: ${$('#keys-in').selectedOptions[0]?.textContent}`, 'ok');
});
$('#thru').checked = prefs.thru;
showAudioDelay($('#audio-delay'), synth.context);
$('#thru').onchange = e => { prefs.thru = e.target.checked; savePrefs(); };
$('#clock-list').addEventListener('change', e => {
  prefs.clockOut = [...document.querySelectorAll('#clock-list input[value]:checked')].map(x => x.value);
  savePrefs();
  renderPorts();
});
document.addEventListener('click', e => {
  if (!e.target.closest('#clock-out')) $('#clock-out').open = false;
  if (!e.target.closest('#click-menu')) $('#click-menu').open = false;
});

// Metronome menu
const renderClick = () => {
  document.querySelectorAll('input[name=click]').forEach(r => { r.checked = r.value === prefs.click; });
  $('#count-in').checked = prefs.countIn;
  $('#click-vol').value = prefs.clickVol;
  $('#click-sum').textContent = { off: 'off', rec: 'rec', on: 'on' }[prefs.click];
  $('#click-menu summary').title = `Metronome: ${{ off: 'off', rec: 'clicks while recording', on: 'always clicks' }[prefs.click]}. Click for its settings.`;
  $('#click-menu').classList.toggle('on', prefs.click !== 'off');
};
$('#click-menu').addEventListener('change', e => {
  if (e.target.name === 'click') prefs.click = e.target.value;
  else if (e.target.id === 'count-in') prefs.countIn = e.target.checked;
  savePrefs();
  renderClick();
});
$('#click-vol').addEventListener('input', e => { prefs.clickVol = +e.target.value; savePrefs(); });
$('#click-vol').addEventListener('change', () => synth.click(performance.now() + 30, true, prefs.clickVol / 100));
renderClick();

// ---------------------------------------------------------------------------------------------
// Files: data/sequences/<name>.json at home, or this browser in the travel version (core/storage.js)

let saved = [];
async function refreshOpenList() {
  try { saved = await storage.list('sequences'); } catch { saved = []; }
  $('#open').innerHTML = `<option value="">Open…</option>`
    + saved.map(f => `<option value="${esc(f.file)}">${esc(f.name)}</option>`).join('')
    + `<option value="__demo">Demo song</option>`;
}

// Same rule as serve.py's safe_stem, so we can warn before replacing another song's file.
const fileFor = name => `${stemOf(name)}.json`;

async function save() {
  let name = song.name.trim();
  if (!name || name === 'Untitled') {
    name = (prompt('Name this song:', '') || '').trim();
    if (!name) return;
    song.name = name;
  }
  await refreshOpenList();
  const target = fileFor(name);
  if (target !== fileName && saved.some(f => f.file === target)
      && !confirm(`A saved song already uses the file ${target}. Replace it?`)) return;
  try {
    const file = await storage.save('sequences', song);
    fileName = file;
    dirty = false;
    saveWorking();
    renderFileBar();
    refreshOpenList();
    toast(`Saved to ${placeOf('sequences', file)}`, 'ok');
  } catch (err) {
    toast(`Couldn't save: ${err.message}.${STATIC ? '' : ' Is serve.py running?'}`, 'err');
  }
}

const discardOk = () => !dirty || confirm(`Discard unsaved changes to "${song.name}"?`);

$('#save').onclick = save;
$('#new').onclick = () => { if (discardOk()) load(M.newSong(), null); };
$('#open').onchange = async e => {
  const file = e.target.value;
  e.target.value = '';
  if (!file || !discardOk()) return;
  if (file === '__demo') { load(demoSong(), null); return; }
  try {
    load(await storage.get('sequences', file), file);
  } catch (err) {
    toast(`Couldn't open ${file}: ${err.message}`, 'err');
  }
};
$('#delete').onclick = async () => {
  if (!fileName || !confirm(`${STATIC ? 'Delete' : 'Move'} "${song.name}"${STATIC ? '' : ' to data/sequences/deleted/'}? It stays open here, unsaved.`)) return;
  try {
    await storage.remove('sequences', fileName);
    fileName = null;
    dirty = true;
    saveWorking();
    renderFileBar();
    refreshOpenList();
  } catch (err) {
    toast(`Couldn't delete: ${err.message}`, 'err');
  }
};
$('#song-name').addEventListener('change', e => {
  song.name = e.target.value.trim().slice(0, 60) || 'Untitled';
  changed();
});
$('#undo').onclick = undo;
$('#redo').onclick = redo;

// ---------------------------------------------------------------------------------------------
// Keyboard shortcuts

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (e.target.closest('input, select, textarea')) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod || e.altKey) return;
  const ti = sel.t, t = song.tracks[ti], pat = viewPattern(ti), s = M.stepAt(pat, sel.i);
  if (rollKeys(e, ti)) return;
  const cover = M.coverMap(pat);
  const go = i => {
    i = (i + pat.length) % pat.length;
    i = cover[i] >= 0 ? cover[i] : i;
    views[ti].page = Math.floor(i / pageSize(ti));
    select(ti, i, sel.open);
  };
  switch (e.key) {
    case ' ': e.preventDefault(); if (engine.playing) stop(); else play(); break;
    case 'r': case 'R': setRec(!rec.on); break;
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': {
      const n = +e.key - 1;
      if (song.tracks[n] && n !== ti) select(n, Math.min(sel.i, M.coverMap(viewPattern(n)).length - 1), sel.open);
      break;
    }
    case 'ArrowRight': e.preventDefault(); go(s ? s.i + s.len : sel.i + 1); break;
    case 'ArrowLeft': e.preventDefault(); go(sel.i - 1); break;
    case 'ArrowUp': case 'ArrowDown': {
      if (!s || t.mode === 'pool' || !s.notes.length) break;
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      if (s.notes.every(n => n + d >= 0 && n + d <= 127)) {
        edit(ti, () => { M.mapNotes(s, n => n + d); }, { coalesce: true });
        views[ti].lastNote = s.notes[0];
        preview(ti, s.notes.at(-1));
      }
      break;
    }
    case 'Enter': if (!s) { e.preventDefault(); sel.open = true; edit(ti, () => addNoteAt(ti, sel.i)); } break;
    case 'Backspace': case 'Delete': if (s) { e.preventDefault(); edit(ti, () => M.removeStep(pat, sel.i)); } break;
    case 'Escape': if (sel.open) { sel.open = false; renderTrack(ti); } break;
  }
});

// ---------------------------------------------------------------------------------------------
// Start

{
  const w = store.get('working', null);
  let ok = false;
  if (w?.song) {
    try { load(w.song, w.fileName || null, !!w.dirty); ok = true; } catch { /* fall back to the demo */ }
  }
  if (!ok) load(demoSong(), null);
  refreshOpenList();
  refreshInstruments();
  loadMine();
  loadClips();
  initMidi();
  soundChannel?.postMessage({ type: 'get-program' });
}
