// The spectrogram editor: a recording as a picture of its frequencies over time, which you paint
// on (erase, quieter, louder, smear) and hear before saving the result as a new recording. The
// original file is never changed. Opened from Capture's recordings and the Sound Lab's samplers.
//
//   openSpectroEditor({ file, onSaved(newFile) })
import { storage, audioBlob } from './storage.js';
import { stft, istft, brush, copySpec, dbAt, heat, rowHz } from './spectral.js';
import { encodeWav } from '../rec/audio.js';

const MAX_SECONDS = 60, ROWS = 360, LO = 30, RANGE = 72, MAX_UNDO = 12; // RANGE: dB shown below the loudest cell
const TOOLS = [
  ['erase', 'Erase', 'Paint out what\'s there (a note, a hum, a click)'],
  ['quieter', 'Quieter', '−12 dB where you paint, at full strength'],
  ['louder', 'Louder', '+12 dB where you paint, at full strength'],
  ['smear', 'Smear', 'Blur in time: transients wash out, notes ring on'],
];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let ac = null;
const ctx = () => (ac ||= new AudioContext());

let ed = null; // the open editor

export async function openSpectroEditor({ file, onSaved }) {
  closeEditor(true);
  const el = document.createElement('div');
  el.className = 'spectro';
  el.setAttribute('role', 'dialog');
  el.innerHTML = `<div class="spectro-box"><div class="spectro-head"><b>Spectrogram</b><span class="hint">${esc(file)}</span><span class="spacer"></span>
    <button class="ghost small" data-x title="Close (Esc)">✕</button></div><div class="spectro-body"><p class="hint">Loading…</p></div></div>`;
  document.body.append(el);
  ed = { el, file, onSaved, tool: 'erase', size: 18, strength: 0.8, undo: [], edited: false, player: null };
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  addEventListener('keydown', onKey, true);
  try {
    const blob = await audioBlob(file);
    const buf = await ctx().decodeAudioData(await blob.arrayBuffer());
    if (ed?.el !== el) return;
    const sr = buf.sampleRate, length = Math.min(buf.length, MAX_SECONDS * sr);
    const chans = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c).slice(0, length));
    Object.assign(ed, { sr, length, chans, cut: buf.length > length, specs: chans.map(x => stft(x)) });
    ed.hi = Math.min(20000, sr / 2);
    // Colours run from the recording's loudest cell down RANGE dB, so quiet recordings show too.
    let top = 0;
    for (const sp of ed.specs) for (let f = 0; f < sp.frames; f++) for (let k = 0; k < sp.bins; k++) top = Math.max(top, sp.re[f][k] ** 2 + sp.im[f][k] ** 2);
    ed.dbHi = 10 * Math.log10(top + 1e-18) - 20 * Math.log10(ed.specs[0].size / 4);
    ed.dbLo = ed.dbHi - RANGE;
    render();
  } catch (err) {
    el.querySelector('.spectro-body').innerHTML = `<p class="err">Couldn't open ${esc(file)}: ${esc(err.message || err)}</p>`;
  }
}

function closeEditor(force = false) {
  if (!ed) return;
  if (!force && ed.edited && !ed.saved && !confirm('Close without saving your edits?')) return;
  stop();
  ed.el.remove();
  removeEventListener('keydown', onKey, true);
  ed = null;
}

function render() {
  const { el, specs, sr, length } = ed, s = specs[0];
  el.querySelector('.spectro-body').innerHTML = `
    <div class="spectro-tools">
      <span class="seg-btn">${TOOLS.map(([id, label, help]) => `<button data-tool="${id}" class="${ed.tool === id ? 'on' : ''}" title="${esc(help)}">${label}</button>`).join('')}</span>
      <label class="field">Brush <input type="range" data-k="size" min="4" max="80" value="${ed.size}"></label>
      <label class="field">Strength <input type="range" data-k="strength" min="5" max="100" value="${Math.round(ed.strength * 100)}"></label>
      <span class="spacer"></span>
      <button class="ghost small" data-undo title="Undo the last stroke (⌘Z)" ${ed.undo.length ? '' : 'disabled'}>↶ Undo</button>
      <button class="ghost small" data-reset title="Back to the recording as it was" ${ed.edited ? '' : 'disabled'}>Reset</button>
    </div>
    <div class="spectro-view"><canvas class="spectro-c" width="${s.frames}" height="${ROWS}"></canvas><canvas class="spectro-o"></canvas>
      <div class="spectro-y">${[100, 1000, 10000].filter(f => f < ed.hi).map(f => `<span style="top:${yOf(f) * 100}%">${f >= 1000 ? `${f / 1000}k` : f}</span>`).join('')}</div></div>
    <div class="spectro-foot">
      <button class="small" data-play="edited" title="Hear it with your edits (Space)">▶ Edited</button>
      <button class="ghost small" data-play="orig" title="Hear the original">▶ Original</button>
      <button class="ghost small" data-stop>■ Stop</button>
      <span class="hint">${(length / sr).toFixed(2)} s${ed.cut ? ` (the first ${MAX_SECONDS} s of a longer recording)` : ''} · ${ed.chans.length === 2 ? 'stereo' : 'mono'} · low at the bottom, high at the top, brighter = louder</span>
      <span class="spacer"></span>
      <button class="accent small" data-save ${ed.edited ? '' : 'disabled'} title="Save the edited sound as a new recording (the original stays)">Save as new recording</button>
    </div>`;
  paint(0, s.frames - 1);
  const over = el.querySelector('.spectro-o');
  over.addEventListener('pointerdown', down);
  over.addEventListener('pointermove', hover);
  over.addEventListener('pointerleave', () => drawOverlay(null));
}

// Rows are log frequency, LO at the bottom; `yOf` is a frequency's height from the top (0–1).
const yOf = f => Math.log(ed.hi / f) / Math.log(ed.hi / LO);

// Redraws frames f0–f1 of the picture (the louder channel at each cell).
function paint(f0, f1) {
  const c = ed.el.querySelector('.spectro-c'), g = c.getContext('2d'), s = ed.specs[0], binHz = ed.sr / s.size;
  f0 = Math.max(0, Math.floor(f0)); f1 = Math.min(s.frames - 1, Math.ceil(f1));
  const img = g.createImageData(f1 - f0 + 1, ROWS);
  const ranges = rowBins(binHz, s.bins);
  for (let f = f0; f <= f1; f++) {
    for (let r = 0; r < ROWS; r++) {
      const [b0, b1] = ranges[r];
      let db = -Infinity;
      for (const sp of ed.specs) for (let b = b0; b <= b1; b++) db = Math.max(db, dbAt(sp, f, b));
      const [R, G, B] = heat((db - ed.dbLo) / (ed.dbHi - ed.dbLo)), o = (r * (f1 - f0 + 1) + (f - f0)) * 4;
      img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, f0, 0);
}
let rowCache = null;
function rowBins(binHz, bins) {
  const key = `${binHz}|${ed.hi}`;
  if (rowCache?.key !== key) {
    rowCache = { key, rows: Array.from({ length: ROWS }, (_, r) => {
      const top = rowHz(r - 0.5, ROWS, LO, ed.hi), bottom = rowHz(r + 0.5, ROWS, LO, ed.hi);
      const b0 = Math.max(0, Math.floor(bottom / binHz)), b1 = Math.min(bins - 1, Math.max(b0, Math.ceil(top / binHz)));
      return [b0, b1];
    }) };
  }
  return rowCache.rows;
}

// ---- painting ----

function cellsAt(e) {
  const over = ed.el.querySelector('.spectro-o'), rect = over.getBoundingClientRect(), s = ed.specs[0];
  if (!rect.width || !rect.height) return { cells: [], f0: 0, f1: -1 }; // not on screen
  const fx = (e.clientX - rect.left) / rect.width * s.frames, ry = (e.clientY - rect.top) / rect.height * ROWS;
  const rf = ed.size / rect.width * s.frames, rr = ed.size / rect.height * ROWS;
  const ranges = rowBins(ed.sr / s.size, s.bins), cells = [];
  for (let f = Math.floor(fx - rf); f <= Math.ceil(fx + rf); f++) {
    for (let r = Math.max(0, Math.floor(ry - rr)); r <= Math.min(ROWS - 1, Math.ceil(ry + rr)); r++) {
      const d = Math.hypot((f - fx) / rf, (r - ry) / rr);
      if (d < 1) cells.push([f, ...ranges[r], Math.min(1, 2 * (1 - d))]); // soft edge
    }
  }
  return { cells, f0: fx - rf, f1: fx + rf };
}
function dab(e) {
  const { cells, f0, f1 } = cellsAt(e);
  for (const sp of ed.specs) brush(sp, ed.tool, cells, { strength: ed.strength * (ed.tool === 'smear' ? 0.5 : 0.35) });
  paint(f0 - 1, f1 + 1);
}
function down(e) {
  if (!ed?.specs) return;
  e.preventDefault();
  const over = e.currentTarget;
  over.setPointerCapture(e.pointerId);
  ed.undo.push(ed.specs.map(copySpec));
  if (ed.undo.length > MAX_UNDO) ed.undo.shift();
  dab(e);
  const move = ev => { dab(ev); drawOverlay(ev); };
  const up = () => {
    over.removeEventListener('pointermove', move);
    over.removeEventListener('pointerup', up);
    ed.edited = true;
    ed.saved = false;
    ed.el.querySelector('[data-save]').disabled = false;
    ed.el.querySelector('[data-undo]').disabled = false;
    ed.el.querySelector('[data-reset]').disabled = false;
  };
  over.addEventListener('pointermove', move);
  over.addEventListener('pointerup', up);
}
function hover(e) { drawOverlay(e); }
// The brush outline and the playhead.
function drawOverlay(e, at = ed?.playAt) {
  const o = ed?.el.querySelector('.spectro-o');
  if (!o) return;
  const r = o.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (o.width !== Math.round(r.width * dpr)) { o.width = Math.round(r.width * dpr); o.height = Math.round(r.height * dpr); }
  const g = o.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  if (e) { g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 1; g.beginPath(); g.arc(e.clientX - r.left, e.clientY - r.top, ed.size, 0, 2 * Math.PI); g.stroke(); ed.lastHover = e; }
  if (at != null) { const x = at / (ed.length / ed.sr) * r.width; g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, r.height); g.stroke(); }
}

// ---- hearing and saving ----

function rendered() { return ed.specs.map(sp => istft(sp, ed.length)); }
function play(which) {
  stop();
  const a = ctx(), chans = which === 'orig' ? ed.chans : rendered();
  const b = a.createBuffer(chans.length, ed.length, ed.sr);
  chans.forEach((d, c) => b.copyToChannel(d, c));
  const src = a.createBufferSource();
  src.buffer = b;
  src.connect(a.destination);
  a.resume();
  const t0 = a.currentTime + 0.02;
  src.start(t0);
  ed.player = src;
  const tick = () => {
    if (!ed || ed.player !== src) return;
    ed.playAt = a.currentTime - t0;
    if (ed.playAt > ed.length / ed.sr) { ed.playAt = null; drawOverlay(ed.lastHover); return; }
    drawOverlay(null);
    requestAnimationFrame(tick);
  };
  src.onended = () => { if (ed?.player === src) { ed.player = null; ed.playAt = null; drawOverlay(null); } };
  requestAnimationFrame(tick);
}
function stop() { try { ed?.player?.stop(); } catch { /* not started */ } if (ed) ed.player = null; }

async function save() {
  const name = (prompt('Save the edited sound as a new recording named:', `${ed.file.replace(/\.wav$/i, '')} (spectral)`) || '').trim();
  if (!name) return;
  const chans = rendered();
  // Louder edits can clip: scale the whole file down if so.
  let peak = 0;
  for (const d of chans) for (const x of d) peak = Math.max(peak, Math.abs(x));
  if (peak > 0.99) for (const d of chans) for (let i = 0; i < d.length; i++) d[i] *= 0.99 / peak;
  const btn = ed.el.querySelector('[data-save]');
  btn.disabled = true;
  try {
    const file = await storage.save('audio', encodeWav(chans, ed.sr), name);
    ed.saved = true;
    try { new BroadcastChannel('mkxl').postMessage({ type: 'recordings-changed' }); } catch { /* none */ }
    note(`Saved as ${file}${peak > 0.99 ? ' (turned down a little so it doesn\'t clip)' : ''}.`);
    ed.onSaved?.(file);
  } catch (err) {
    note(`Couldn't save: ${err.message}`, true);
    btn.disabled = false;
  }
}
function note(text, bad = false) {
  const foot = ed?.el.querySelector('.spectro-foot');
  if (!foot) return;
  foot.querySelector('.spectro-note')?.remove();
  foot.insertAdjacentHTML('beforeend', `<span class="spectro-note${bad ? ' err' : ''}">${esc(text)}</span>`);
}

function onClick(e) {
  const b = e.target.closest('button');
  if (e.target === ed.el) { closeEditor(); return; } // the backdrop
  if (!b) return;
  if (b.dataset.x !== undefined) closeEditor();
  else if (b.dataset.tool) { ed.tool = b.dataset.tool; ed.el.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x === b)); }
  else if (b.dataset.play) play(b.dataset.play);
  else if (b.dataset.stop !== undefined) stop();
  else if (b.dataset.undo !== undefined) undo();
  else if (b.dataset.reset !== undefined) { ed.undo.push(ed.specs.map(copySpec)); ed.specs = ed.chans.map(x => stft(x)); ed.edited = false; render(); }
  else if (b.dataset.save !== undefined) save();
}
function undo() {
  const prev = ed?.undo.pop();
  if (!prev) return;
  ed.specs = prev;
  paint(0, prev[0].frames - 1);
  ed.el.querySelector('[data-undo]').disabled = !ed.undo.length;
}
function onInput(e) {
  if (e.target.dataset.k === 'size') ed.size = +e.target.value;
  if (e.target.dataset.k === 'strength') ed.strength = +e.target.value / 100;
}
function onKey(e) {
  if (!ed) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEditor(); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.stopPropagation(); undo(); }
  else if (e.code === 'Space' && !e.target.closest?.('input, select, textarea')) { e.preventDefault(); e.stopPropagation(); if (ed.player) stop(); else play('edited'); }
  else return;
}
