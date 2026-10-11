// The Lab page: build and play instruments made of modules (see patch.js), save them to
// data/instruments/, and share them with the sequencer. No framework.
import { MODULES, SOURCES, STARTERS, normalizePatch, copyPatch, defaultParams, newId, paramOf, formatValue, toSlider, fromSlider, defaultTarget } from './patch.js';
import { LabSynth } from './engine.js';
import { patchSVG, layout } from './patchview.js';
import { portLabel } from '../core/midiports.js';
import { storage, placeOf, stemOf } from '../core/storage.js';
import { STATIC } from '../core/mode.js';
import { attachQwerty, qwertyBase, setQwertyBase } from '../core/qwerty.js';

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
const prefs = { keysIn: null, base: 48, viewOpen: true, ...store.get('prefs', {}) };
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

// ---------------------------------------------------------------------------------------------
// State: the patch being edited, undo, the working copy kept in this browser

let patch;
let fileName = null;
let dirty = false;
let saved = []; // [{ file, name, patch }]
const undoStack = [], redoStack = [];
let snapshot = null, lastPush = 0, workTimer = null, shareTimer = null;
let learn = false, learnTarget = null;

const channel = 'BroadcastChannel' in window ? new BroadcastChannel('mkxl') : null;
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
  workTimer = setTimeout(() => store.set('working', { patch, fileName, dirty }), 300);
  // The sequencer plays this instrument on tracks that use it: send it every change.
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => channel?.postMessage({ type: 'instrument', name: patch.name, patch }), 120);
  renderFileBar();
}

function load(raw, file, isDirty = false) {
  const { patch: p, notes } = normalizePatch(raw);
  patch = p;
  fileName = file;
  dirty = isDirty;
  snapshot = JSON.stringify(patch);
  undoStack.length = redoStack.length = 0;
  synth.setPatch(patch);
  store.set('working', { patch, fileName, dirty });
  showNotes(notes);
  renderAll();
}
function restore(json) {
  patch = normalizePatch(JSON.parse(json)).patch;
  snapshot = json;
  dirty = true;
  synth.setPatch(patch);
  store.set('working', { patch, fileName, dirty });
  renderAll();
  channel?.postMessage({ type: 'instrument', name: patch.name, patch });
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
  renderOpen();
}

function renderFileBar() {
  const name = $('#inst-name');
  if (document.activeElement !== name) name.value = patch.name;
  $('#dirty').hidden = !dirty;
  $('#dirty').textContent = fileName ? 'unsaved changes' : 'not saved yet';
  $('#delete').disabled = !fileName;
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  if (document.activeElement !== $('#voices')) $('#voices').value = patch.voices;
  $('#volume').value = patch.volume;
  document.title = `${patch.name}${dirty ? ' •' : ''} · Lab · Ostinato`;
}

function renderOpen() {
  $('#open').innerHTML = `<option value="">Open…</option>`
    + (saved.length ? `<optgroup label="Your instruments">${saved.map(s => `<option value="file:${esc(s.file)}">${esc(s.name)}</option>`).join('')}</optgroup>` : '')
    + `<optgroup label="Start from">${STARTERS.map((s, i) => `<option value="starter:${i}">${esc(s.name)}</option>`).join('')}</optgroup>`;
}

function paramHTML(m, spec) {
  const v = m.params[spec.key], target = `${m.id}.${spec.key}`;
  const cc = Object.entries(patch.cc).find(([, t]) => t === target)?.[0];
  const help = spec.help ? ` title="${esc(spec.help)}"` : '';
  if (spec.kind === 'choice') {
    return `<div class="prm"${help}><label>${spec.label}</label><span class="seg-btn">${spec.choices.map(c =>
      `<button data-act="choice" data-id="${m.id}" data-key="${spec.key}" data-v="${esc(c)}" class="${c === v ? 'on' : ''}">${esc(c)}</button>`).join('')}</span></div>`;
  }
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

function renderModules() {
  // Cards follow the sound: left to right through the patch diagram, top to bottom within a
  // column; then the modulators.
  const { pos } = layout(patch);
  const at = id => pos.get(id) || { x: 1e9, y: 1e9 };
  const sound = patch.modules.filter(m => !MODULES[m.type].modOut).sort((a, b) => at(a.id).x - at(b.id).x || at(a.id).y - at(b.id).y);
  const movement = patch.modules.filter(m => MODULES[m.type].modOut);
  const card = m => {
    const spec = MODULES[m.type];
    return `<section class="card mod-${m.type}${spec.scope === 'global' ? ' global' : ''}${m.off ? ' is-off' : ''}" data-mod="${m.id}">
      <header title="${esc(spec.help)}"><button class="power-btn${m.off ? ' is-off' : ''}" data-act="power" data-id="${m.id}" title="${m.off ? 'Bypassed: click to switch it back on' : 'Bypass: switch it off without deleting, to hear the difference'}">⏻</button>
        <b>${spec.label}</b> <span class="mid">${m.id}</span>${spec.scope === 'global' ? '<span class="tag">effect</span>' : ''}${m.off ? '<span class="tag">off</span>' : ''}
        <span class="spacer"></span><button class="ghost small x" data-act="del" data-id="${m.id}" title="Remove this module">✕</button></header>
      <div class="prms">${spec.params.filter(p => !(m.type === 'osc' && p.key === 'pw' && m.params.wave !== 'pulse')).map(p => paramHTML(m, p)).join('')}</div>
      ${routesHTML(m.id)}
    </section>`;
  };
  const cards = [`<h3 class="group-h">Sound <span class="hint">in the order it flows, to the output</span></h3>`, ...sound.map(card),
    `<h3 class="group-h">Movement <span class="hint">envelopes, LFOs, how you play</span></h3>`, ...movement.map(card)];
  cards.push(`<section class="card sources"><header title="Modulation from how you play"><b>Velocity &amp; mod wheel</b></header>
    <div class="src-h">Velocity</div>${routesHTML('vel')}<div class="src-h">Mod wheel <span class="hint">(CC 1; the MPK mini's joystick pushed up)</span></div>${routesHTML('wheel')}</section>`);
  $('#modules').innerHTML = cards.join('');
  renderView();
  $('#add-module').innerHTML = `<option value="">+ Add module…</option>${Object.entries(MODULES).map(([type, s]) => `<option value="${type}">${s.label}${s.scope === 'global' ? ' (effect)' : ''} — ${esc(s.help)}</option>`).join('')}`;
  $('#learn').classList.toggle('on', learn);
}

// ---- the patch diagram ----

let viewSel = null; // what's selected: a cable { kind: 'audio' | 'mod', from, to }, or { kind: 'module', id }
let justDragged = false; // a drag ends with a click; ignore that one

function renderView() {
  const el = $('#patch-view');
  el.hidden = !prefs.viewOpen;
  $('#view-col').textContent = prefs.viewOpen ? '▾' : '▸';
  if (!prefs.viewOpen) return;
  if (viewSel?.kind === 'module' ? !(viewSel.id === 'out' || SOURCES[viewSel.id] || modOf(viewSel.id))
    : viewSel && !(viewSel.kind === 'audio' ? patch.audio : patch.mod).some(c => c.from === viewSel.from && c.to === viewSel.to)) viewSel = null;
  el.innerHTML = patchSVG(patch, { selected: viewSel }) + selOverlay();
  if (viewSel) placeOverlay();
}

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
      ${m ? `<button class="small ${m.off ? '' : 'ghost'}" data-act="power" data-id="${id}">${m.off ? '⏻ Turn on' : '⏻ Bypass'}</button>
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
function deleteSelected() {
  if (!viewSel || viewSel.kind === 'module') return; // cables only (a module has its own Remove)
  const list = viewSel.kind === 'audio' ? 'audio' : 'mod';
  patch[list] = patch[list].filter(c => !(c.from === viewSel.from && c.to === viewSel.to));
  viewSel = null;
  changed({ rebuild: true });
  renderModules();
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

$('#view-col').onclick = () => { prefs.viewOpen = !prefs.viewOpen; savePrefs(); renderView(); };
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
    case 'del': {
      const id = el.dataset.id;
      patch.modules = patch.modules.filter(m => m.id !== id);
      patch.audio = patch.audio.filter(c => c.from !== id && c.to !== id);
      patch.mod = patch.mod.filter(c => c.from !== id && !c.to.startsWith(`${id}.`));
      for (const [k, t] of Object.entries(patch.cc)) if (t.startsWith(`${id}.`)) delete patch.cc[k];
      if (viewSel?.id === id) viewSel = null;
      changed({ rebuild: true });
      renderModules();
      return true;
    }
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
function routeChange(el) {
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
  if (el.dataset.act === 'num') {
    const m = modOf(el.dataset.id), spec = paramOf(m.type, el.dataset.key), v = fromSlider(spec, +el.value / 1000);
    m.params[spec.key] = v;
    synth.setParam(m.id, spec.key, v);
    el.parentElement.querySelector('.val').textContent = formatValue(spec, v);
    changed({ coalesce: true });
  }
});

$('#modules').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  // Learning: clicking a setting picks it as the target for the next knob turned.
  const row = e.target.closest('.prm[data-target]');
  if (learn && row && el?.dataset.act !== 'unlearn') { learnTarget = row.dataset.target; renderModules(); return; }
  if (!el || routeClick(el)) return;
  switch (el.dataset.act) {
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

// A new module starts unconnected, with its panel open in the patch diagram: connect it there
// (or drag from its output dot).
$('#add-module').addEventListener('change', e => {
  const type = e.target.value;
  e.target.value = '';
  if (!type) return;
  const id = newId(patch, type);
  patch.modules.push({ id, type, params: defaultParams(type) });
  viewSel = { kind: 'module', id };
  changed({ rebuild: true });
  renderModules();
  if (!prefs.viewOpen) { prefs.viewOpen = true; savePrefs(); renderView(); }
  $('#patch-view').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  toast(`Added ${id}. Connect it in the panel beside it, or drag from its dot.`);
});

$('#inst-name').addEventListener('change', e => { patch.name = e.target.value.trim().slice(0, 40) || 'Untitled'; changed(); });
$('#voices').addEventListener('change', e => {
  patch.voices = Math.max(1, Math.min(16, Math.round(+e.target.value) || 8));
  synth.setPatch(patch);
  changed();
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

async function refreshSaved() {
  try { saved = await storage.list('instruments'); } catch { saved = []; }
  renderOpen();
}
const fileFor = name => `${stemOf(name)}.json`;

async function save() {
  await refreshSaved();
  const target = fileFor(patch.name);
  if (target !== fileName && saved.some(s => s.file === target) && !confirm(`An instrument already uses the file ${target}. Replace it?`)) return;
  try {
    const file = await storage.save('instruments', patch);
    fileName = file;
    dirty = false;
    store.set('working', { patch, fileName, dirty });
    renderFileBar();
    await refreshSaved();
    channel?.postMessage({ type: 'instruments-changed' });
    toast(`Saved to ${placeOf('instruments', file)}. It's now in the Sequencer's Sound list.`, 'ok');
  } catch (err) {
    toast(`Couldn't save: ${err.message}.${STATIC ? '' : ' Is serve.py running?'}`, 'err');
  }
}
const discardOk = () => !dirty || confirm(`Discard unsaved changes to "${patch.name}"?`);
$('#save').onclick = save;
$('#open').onchange = e => {
  const v = e.target.value;
  e.target.value = '';
  if (!v || !discardOk()) return;
  if (v.startsWith('starter:')) {
    const s = copyPatch(STARTERS[+v.slice(8)]);
    load(s, null, true);
  } else {
    const s = saved.find(x => x.file === v.slice(5));
    if (s) load(s.patch, s.file);
  }
};
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
  down.set(note, true);
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
  if (cc === 64) {
    sustain = v >= 64;
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
  midi.onstatechange = wireMidi;
  wireMidi();
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
  const up = () => { noteOff(n); removeEventListener('pointerup', up); };
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

// The host page switches views; nothing reloads.
document.querySelectorAll('.app-nav a[data-view]').forEach(a => a.addEventListener('click', e => {
  if (top === self) return;
  e.preventDefault();
  parent.postMessage({ type: 'switch-view', view: a.dataset.view }, location.origin);
}));

// ---------------------------------------------------------------------------------------------
// Start

{
  const w = store.get('working', null);
  let ok = false;
  if (w?.patch) { try { load(w.patch, w.fileName || null, !!w.dirty); ok = true; } catch { /* start fresh */ } }
  if (!ok) load(copyPatch(STARTERS[1]), null, true);
  renderKbd();
  showAudio();
  refreshSaved();
  initMidi();
}
