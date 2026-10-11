// Capture's take editor: a take or a saved clip on a timeline (a piano roll with bars and
// beats). Select a stretch (snapped to bars, beats or 16ths) and loop it on the sound it was played
// with or another one, pick and delete stray notes, then save it as a clip or put it into a
// sequencer track. The sequencer does the playing (audition-take); this page makes no sound.
//
// A clip (data/clips/<name>.json):
//   { format: 'mkxl-clip', version: 1, name, bpm, length, notes: [{ pos, len, note, vel }],
//     sound, source: { take }, created, modified }
// pos/len in ticks (96 a beat) from the clip's start; sound as in core/sounding.js (or null).
import * as C from '../seq/capture.js';
import { TICKS_PER_BEAT, TICKS_PER_BAR, PATTERNS, RATES } from '../seq/model.js';
import { writeMidi } from '../seq/midifile.js';
import { storage, placeOf } from '../core/storage.js';
import { openSoundPicker, closeSoundPicker } from '../core/soundpicker.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SNAPS = { bar: TICKS_PER_BAR, beat: TICKS_PER_BEAT, '1/16': TICKS_PER_BEAT / 4, off: 1 };
const ROW_H = 8, RULER_H = 20;
const r2 = v => Math.round(v * 100) / 100;

// env (from ui.js): { channel, toast, seq(), outputs(), takeBpm(take), setTakeBpm(id, bpm),
//   takeSound(take), download(bytes, name), clipsChanged() }
let env = null;
let ed = null; // what's open (see openTake / openClip)
export const editing = () => ed;
export function initEditor(e) { env = e; }

// ---- opening and closing ----

export function openTake(take) {
  const bpm = env.takeBpm(take);
  const d = new Date(take.start), p = n => String(n).padStart(2, '0');
  start({
    src: { kind: 'take', id: take.id }, name: `Take ${p(d.getHours())}${p(d.getMinutes())}`, bpm,
    free: !take.synced, notes: C.takeTicks(take, bpm).map(x => ({ ...x })), sound: env.takeSound(take),
    about: take.synced ? `played along at ${bpm} BPM` : 'played in free time',
  });
}
export function openClip(clip) {
  start({
    src: { kind: 'clip', file: clip.file }, name: clip.name, bpm: clip.bpm || 120, free: false,
    notes: clip.notes.map(n => ({ ...n })), sound: clip.sound || null, length: clip.length,
    source: clip.source, created: clip.created, about: 'saved clip',
  });
}
const endLink = () => { if (ed?.link) env.channel.postMessage({ type: 'edit-ended', link: ed.link }); };
function start(o) {
  stop();
  endLink();
  closeSoundPicker();
  ed = { ...o, pick: null, sel: null, picked: new Set(), undo: [], snap: 'beat', zoom: null, playing: null, put: false };
  render();
  $('#editor').scrollIntoView({ block: 'start' });
}
export function closeEditor() {
  stop();
  endLink();
  closeSoundPicker();
  ed = null;
  $('#editor').hidden = true;
  $('#editor').innerHTML = '';
}

// ---- the parts of it ----

const total = () => Math.max(TICKS_PER_BAR, Math.ceil(Math.max(ed.length || 0, ...ed.notes.map(n => n.pos + n.len)) / TICKS_PER_BAR) * TICKS_PER_BAR);
const range = () => (ed.sel ? [ed.sel.a, ed.sel.b] : [0, total()]);
const inRange = ([a, b]) => ed.notes.filter(n => n.pos >= a && n.pos < b);
const msPerTick = () => 60000 / (ed.bpm * TICKS_PER_BEAT);
const barsText = ticks => { const bars = ticks / TICKS_PER_BAR; return `${r2(bars)} bar${bars === 1 ? '' : 's'}`; };
const describeRange = ([a, b]) => {
  const B = TICKS_PER_BAR, at = t => `${Math.floor(t / B) + 1}.${Math.floor((t % B) / TICKS_PER_BEAT) + 1}${t % TICKS_PER_BEAT ? `+${t % TICKS_PER_BEAT}` : ''}`;
  if (a % B === 0 && b % B === 0) return b - a === B ? `bar ${a / B + 1}` : `bars ${a / B + 1}–${b / B}`;
  return `from ${at(a)} to ${at(b)} (bar.beat)`;
};

// The sound to play it on (core/sounding.js): what was played (null: the sequencer's selected
// track), a sequencer track's sound, or any sound from the picker. `ed.pick` is the picker's item.
function chosenSound() {
  const p = ed.pick;
  if (!p || p.key === 'rec') return ed.sound;
  if (p.key.startsWith('track:')) return env.seq()?.tracks?.find(t => t.ti === +p.key.slice(6))?.sound || { kind: 'track', ti: +p.key.slice(6) };
  return p.sound;
}
const soundLabel = s => (!s ? 'not known' : s.kind === 'xl' ? `${s.name} (microKORG XL)` : s.kind === 'lab' ? `${s.name} (Ostinato Synth)` : s.name);
const choiceLabel = () => (!ed.pick || ed.pick.key === 'rec' ? `As played: ${ed.sound ? soundLabel(ed.sound) : 'the selected track'}`
  : `${soundLabel(chosenSound())}${ed.pick.key === 'edited' ? ', edited' : ''}`);
const editable = s => s?.kind === 'lab' || s?.kind === 'xl';

function pickSound(anchor) {
  const tracks = env.seq()?.tracks || [];
  openSoundPicker({
    anchor, title: 'Play it on…', current: ed.pick?.key || 'rec', outputs: env.outputs,
    extra: [{ label: 'Recorded', items: [{ key: 'rec', name: ed.sound ? `As played: ${ed.sound.name}` : 'As played (sound not known)', note: ed.sound ? soundLabel(ed.sound).replace(/^.*\(|\)$/g, '') : 'plays on the selected track' },
      ...(ed.edited ? [{ key: 'edited', name: `Edited: ${ed.edited.name}`, note: 'your changes in the Sound Lab', sound: ed.edited }] : [])] },
      ...(tracks.length ? [{ label: 'Sequencer tracks', items: tracks.map(t => ({ key: `track:${t.ti}`, name: t.name, note: t.soundName })) }] : [])],
    onPick(item) {
      if (!ed) return;
      ed.pick = item;
      ed.giveSound = undefined;
      const btn = document.querySelector('#ed-sound');
      if (btn) { btn.textContent = `🔊 ${choiceLabel()} ▾`; btn.title = choiceLabel(); }
      restart();
    },
  });
}

function render() {
  const el = $('#editor');
  el.hidden = false;
  const scroll = el.querySelector('.ed-roll')?.scrollLeft || 0;
  const r = range(), notes = inRange(r), song = env.seq();
  const playLabel = ed.playing ? '■ Stop' : ed.sel ? '▶ Loop selection' : '▶ Play all';
  el.innerHTML = `
    <div class="ed-head">
      <input id="ed-name" value="${esc(ed.name)}" maxlength="60" spellcheck="false" aria-label="Name" title="The name it's saved under">
      <span class="hint">${esc(ed.about)} · ${ed.notes.length} notes · ${barsText(total())}</span>
      <span class="spacer"></span>
      <button class="ghost small" data-ed="close" title="Close the editor">✕ Close</button>
    </div>
    <div class="ed-tools">
      <button class="rec-play${ed.playing ? ' on' : ''}" data-ed="play" title="Space">${playLabel}</button>
      <label class="field">Sound <button id="ed-sound" class="sound-btn-pick" data-ed="sound" title="${esc(choiceLabel())}. Saving a clip keeps the sound chosen here.">🔊 ${esc(choiceLabel())} ▾</button></label>
      <button class="ghost small" data-ed="edit-sound" ${editable(chosenSound()) ? '' : 'disabled'} title="${editable(chosenSound()) ? 'Open this sound in the Sound Lab and change it while this loops; it plays your changes, and a clip saved afterwards keeps them' : 'Pick an Ostinato Synth or XL sound to edit it'}">✎ Edit sound</button>
      <label class="field" title="${ed.free ? 'A guess from your playing. Changing it moves the bar lines, not the notes.' : ed.src.kind === 'take' ? 'The sequencer\'s tempo when you played it' : 'The clip\'s tempo'}">Tempo
        <input type="number" id="ed-bpm" min="40" max="240" value="${ed.bpm}" ${ed.src.kind === 'take' && !ed.free ? 'disabled' : ''}></label>
      ${song && song.bpm !== ed.bpm ? `<button class="ghost small" data-ed="tempo" title="Set the song's tempo to ${ed.bpm} BPM">Song to ${ed.bpm}</button>` : ''}
      <label class="field" title="What selections snap to">Snap <select id="ed-snap">${Object.keys(SNAPS).map(k => `<option ${k === ed.snap ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <span class="spacer"></span>
      <span class="zoom"><button class="ghost small" data-ed="zoom-out" title="Zoom out">−</button><button class="ghost small" data-ed="fit" title="Fit it all in">Fit</button><button class="ghost small" data-ed="zoom-in" title="Zoom in">+</button></span>
    </div>
    <div class="ed-roll"></div>
    <div class="ed-status hint">${ed.sel ? `Selected ${describeRange(r)} (${barsText(r[1] - r[0])}, ${notes.length} notes).` : 'Drag across the timeline to select a stretch; click a bar number to select that bar.'}
      ${ed.picked.size ? ` <b>${ed.picked.size} note${ed.picked.size > 1 ? 's' : ''} picked</b>: Delete removes ${ed.picked.size > 1 ? 'them' : 'it'}.` : ' Click notes to pick them.'}
      ${ed.undo.length ? '<button class="ghost small" data-ed="undo" title="⌘Z">↶ Undo</button>' : ''}
      ${ed.sel ? '<button class="ghost small" data-ed="all" title="Select nothing: everything is used">Clear selection</button>' : ''}</div>
    <div class="ed-actions">
      ${ed.src.kind === 'clip' ? `<button class="accent" data-ed="save" title="Save the whole clip (name, sound, tempo, removed notes)">Save</button>
        <button data-ed="save-new" title="Save ${ed.sel ? 'the selection' : 'it'} as another clip">Save ${ed.sel ? 'selection' : ''} as new clip</button>`
        : `<button class="accent" data-ed="save-new" title="Keep ${ed.sel ? 'the selection' : 'the whole take'} as a clip, with its sound">Save ${ed.sel ? 'selection' : 'take'} as clip</button>`}
      <button data-ed="put" ${song?.tracks?.length ? '' : 'disabled title="Open the Sequencer first"'}>→ Put into a track…</button>
      <button class="ghost" data-ed="mid" title="Download ${ed.sel ? 'the selection' : 'it'} as a MIDI file">.mid</button>
    </div>
    ${ed.put ? putForm(r) : ''}`;
  const roll = el.querySelector('.ed-roll');
  if (ed.zoom === null) ed.zoom = Math.max(8, Math.min(120, (roll.clientWidth - 16) / (total() / TICKS_PER_BEAT)));
  renderRoll();
  roll.scrollLeft = scroll;
}

// "Put into a track": which track and pattern, and whether the track gets the sound too.
function putForm([a, b]) {
  const tracks = env.seq()?.tracks || [];
  ed.putTi = tracks.some(t => t.ti === ed.putTi) ? ed.putTi : tracks.find(t => t.mode !== 'pool')?.ti ?? tracks[0]?.ti;
  const t = tracks.find(x => x.ti === ed.putTi);
  if (!t) return '';
  ed.putPat = PATTERNS.includes(ed.putPat) ? ed.putPat : t.pattern;
  const s = chosenSound(), fits = C.barsPerPattern(RATES[t.rate] || 24), bars = Math.ceil((b - a) / TICKS_PER_BAR);
  const ok = s && ((s.kind === 'xl' && t.out === 'xl') || ((s.kind === 'lab' || s.kind === 'voice') && t.out === 'computer'));
  if (ed.giveSound === undefined || !ok) ed.giveSound = !!ok;
  return `<div class="ed-put">
    <label class="field">Track <select id="put-track">${tracks.map(x => `<option value="${x.ti}" ${x.ti === t.ti ? 'selected' : ''} ${x.mode === 'pool' ? 'disabled' : ''}>${esc(x.name)}${x.mode === 'pool' ? ' (note pool)' : ''}</option>`).join('')}</select></label>
    <label class="field">Pattern <select id="put-pat">${PATTERNS.map(p => `<option ${p === ed.putPat ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label class="field" title="${ok ? `${esc(t.name)} plays ${esc(t.soundName || 'its own sound')} now` : 'Only an XL sound can go on an XL track, and a Lab instrument or test voice on a Computer track'}">
      <input type="checkbox" id="put-sound" ${ed.giveSound ? 'checked' : ''} ${ok ? '' : 'disabled'}> Give ${esc(t.name)} this sound${s ? ` (${esc(s.name)})` : ''}</label>
    <span class="hint">${barsText(b - a)} at ${t.rate} steps${bars > fits ? `; a pattern holds ${fits} bars, so only the first ${fits} go in` : ''}. Replaces pattern ${ed.putPat}; Undo in the sequencer brings it back.</span>
    <button class="accent" data-ed="put-go">Put in</button><button class="ghost small" data-ed="put-cancel">Cancel</button>
  </div>`;
}

function renderRoll() {
  const roll = $('#editor .ed-roll');
  if (!roll) return;
  const T = total(), px = ed.zoom / TICKS_PER_BEAT, W = Math.ceil(T * px) + 1;
  const ns = ed.notes.map(n => n.note);
  let lo = (ns.length ? Math.min(...ns) : 60) - 2, hi = (ns.length ? Math.max(...ns) : 60) + 2;
  while (hi - lo + 1 < 24) { hi++; if (hi - lo + 1 < 24) lo--; }
  const H = RULER_H + (hi - lo + 1) * ROW_H, y = n => RULER_H + (hi - n) * ROW_H;
  const parts = [];
  for (let n = lo; n <= hi; n++) {
    if ([1, 3, 6, 8, 10].includes(n % 12)) parts.push(`<rect class="blackkey" x="0" y="${y(n)}" width="${W}" height="${ROW_H}"/>`);
    if (n % 12 === 0) parts.push(`<line class="cline" x1="0" x2="${W}" y1="${y(n) + ROW_H}" y2="${y(n) + ROW_H}"/>`);
  }
  const fine = TICKS_PER_BEAT / 4 * px >= 7;
  for (let t = 0; t <= T; t += fine ? TICKS_PER_BEAT / 4 : TICKS_PER_BEAT) {
    const x = Math.round(t * px) + 0.5, cls = t % TICKS_PER_BAR === 0 ? 'barline' : t % TICKS_PER_BEAT === 0 ? 'beatline' : 'sixline';
    parts.push(`<line class="${cls}" x1="${x}" x2="${x}" y1="${cls === 'barline' ? 0 : RULER_H}" y2="${H}"/>`);
    if (t % TICKS_PER_BAR === 0 && t < T) parts.push(`<text class="barnum" x="${x + 4}" y="14">${t / TICKS_PER_BAR + 1}</text>`);
  }
  if (ed.sel) parts.push(`<rect class="selection" x="${ed.sel.a * px}" y="0" width="${(ed.sel.b - ed.sel.a) * px}" height="${H}"/>`);
  ed.notes.forEach((n, i) => {
    const out = ed.sel && (n.pos < ed.sel.a || n.pos >= ed.sel.b);
    parts.push(`<rect class="nt${ed.picked.has(n) ? ' picked' : ''}${out ? ' out' : ''}" data-i="${i}" x="${(n.pos * px).toFixed(1)}" y="${y(n.note) + 1}" width="${Math.max(3, n.len * px).toFixed(1)}" height="${ROW_H - 1}" rx="1.5" style="opacity:${(0.45 + 0.55 * n.vel / 127).toFixed(2)}"><title>${NOTE_NAMES[n.note % 12]}${Math.floor(n.note / 12) - 1} · velocity ${n.vel}</title></rect>`);
  });
  for (let n = lo; n <= hi; n++) if (n % 12 === 0) parts.push(`<text class="cname" x="3" y="${y(n) + ROW_H - 1}">C${n / 12 - 1}</text>`);
  parts.push(`<line id="ed-head" class="head" x1="-10" x2="-10" y1="0" y2="${H}"/>`);
  roll.innerHTML = `<svg width="${W}" height="${H}" data-px="${px}">${parts.join('')}</svg>`;
}

// ---- editing its sound in the Sound Lab ----
// The Sound Lab opens the sound as a working copy and tags every change with `link`; a loop
// playing now follows them (the sequencer matches the link), and here the edited sound becomes
// the one used (ed.edited, picked as 'edited'), so a clip saved afterwards keeps it.
function editSound() {
  const sound = chosenSound();
  if (!editable(sound)) return;
  ed.link = `capture-${Date.now()}`;
  ed.linkKind = sound.kind;
  env.channel.postMessage({ type: 'edit-sound', link: ed.link, sound, title: ed.name });
  parent.postMessage({ type: 'switch-view', view: 'lab' }, location.origin);
  if (ed.playing) play(); // so the loop carries the link
}
// Messages from the other pages that concern the open editor.
export function editorMessage(m) {
  if (!ed) return;
  const take = sound => {
    ed.edited = sound;
    ed.pick = { key: 'edited', sound };
    const btn = document.querySelector('#ed-sound');
    if (btn) { btn.textContent = `🔊 ${choiceLabel()} ▾`; btn.title = choiceLabel(); }
  };
  if (m.type === 'instrument' && ed.link && m.link === ed.link) take({ kind: 'lab', name: m.name, patch: m.patch });
  else if (m.type === 'program' && ed.link && ed.linkKind === 'xl' && Array.isArray(m.data)) take({ kind: 'xl', name: m.name, data: m.data });
  else if (m.type === 'edit-ended' && m.link === ed.link) ed.link = null;
  else if (m.type === 'stop-audition' && ed.playing) { ed.playing = null; render(); } // stopped from the Sound Lab
}

// ---- playing (on the sequencer page) ----

function play() {
  stop();
  const [a, b] = range(), ms = msPerTick();
  const notes = inRange([a, b]).map(n => ({ dt: (n.pos - a) * ms, dur: Math.max(20, Math.min(n.len, b - n.pos) * ms), note: n.note, vel: n.vel }));
  if (!notes.length) { env.toast('No notes there to play.'); return; }
  const at = performance.timeOrigin + performance.now() + 150;
  env.channel.postMessage({ type: 'audition-take', notes, sound: chosenSound(), at, loopMs: ed.sel ? (b - a) * ms : 0, link: ed.link || null });
  ed.playing = { at, a, b, ms, loop: !!ed.sel };
  requestAnimationFrame(head);
  render();
}
export function stop() {
  if (!ed?.playing) return;
  env.channel.postMessage({ type: 'stop-audition' });
  ed.playing = null;
  render();
}
function head() {
  const p = ed?.playing, line = document.getElementById('ed-head');
  if (!p || !line) return;
  let t = (performance.timeOrigin + performance.now() - p.at) / p.ms;
  if (p.loop) t = ((t % (p.b - p.a)) + (p.b - p.a)) % (p.b - p.a);
  else if (t > p.b - p.a) { stop(); return; }
  const x = (p.a + Math.max(0, t)) * +line.ownerSVGElement.dataset.px;
  line.setAttribute('x1', x); line.setAttribute('x2', x);
  requestAnimationFrame(head);
}
const restart = () => { if (ed.playing) play(); };

// ---- editing ----

function removePicked() {
  if (!ed.picked.size) return;
  ed.undo.push(ed.notes.map(n => n));
  ed.notes = ed.notes.filter(n => !ed.picked.has(n));
  ed.picked.clear();
  render();
  restart();
}
function undo() {
  if (!ed.undo.length) return;
  ed.notes = ed.undo.pop();
  ed.picked.clear();
  render();
  restart();
}

// The notes of the range as a clip ([a, b] → its own bar 1).
function clipOf([a, b], name) {
  const notes = inRange([a, b]).map(n => ({ pos: r2(n.pos - a), len: r2(Math.min(n.len, b - n.pos)), note: n.note, vel: n.vel }));
  const sound = chosenSound();
  return { format: 'mkxl-clip', version: 1, name, bpm: ed.bpm, length: b - a, notes, sound: sound?.kind === 'track' ? null : sound,
    source: ed.src.kind === 'take' ? { take: ed.src.id } : ed.source || null, ...(ed.created ? { created: ed.created } : {}) };
}
async function save(asNew) {
  const name = $('#ed-name').value.trim().slice(0, 60) || 'Clip';
  const whole = !asNew; // Save (a clip) keeps all of it; "as new" takes the selection
  const clip = clipOf(whole ? [0, total()] : range(), name);
  if (!clip.notes.length) { env.toast('No notes there to save.'); return; }
  if (whole && ed.src.kind === 'clip') clip.file = ed.src.file;
  else delete clip.created;
  try {
    const file = await storage.save('clips', clip);
    env.toast(`Saved the clip "${name}" (${placeOf('clips', file)}).`, 'ok');
    if (whole && ed.src.kind === 'clip') { ed.src.file = file; ed.name = name; }
    env.clipsChanged();
    render();
  } catch (err) { env.toast(`Couldn't save: ${err.message}`, 'err'); }
}

function putIn() {
  const [a, b] = range();
  const items = inRange([a, b]).map(n => ({ note: n.note, vel: n.vel, pos: n.pos - a, len: Math.min(n.len, b - n.pos) }));
  if (!items.length) { env.toast('No notes there.'); return; }
  env.channel.postMessage({ type: 'take-to-track', items, fromBar: 0, bpm: ed.bpm, synced: false, ti: ed.putTi, pattern: ed.putPat,
    sound: ed.giveSound ? chosenSound() : null });
  ed.put = false;
  render();
}

// ---- events (wired once by ui.js) ----

export function wireEditor() {
  const el = $('#editor');
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-ed]');
    if (!b || !ed) return;
    const zoomBy = k => { const roll = el.querySelector('.ed-roll'), mid = (roll.scrollLeft + roll.clientWidth / 2) / ed.zoom; ed.zoom = Math.max(4, Math.min(400, ed.zoom * k)); render(); roll.scrollLeft = mid * ed.zoom - roll.clientWidth / 2; };
    switch (b.dataset.ed) {
      case 'close': closeEditor(); break;
      case 'sound': pickSound(b); break;
      case 'edit-sound': editSound(); break;
      case 'play': if (ed.playing) stop(); else play(); break;
      case 'tempo': env.channel.postMessage({ type: 'set-tempo', bpm: ed.bpm }); break;
      case 'zoom-in': zoomBy(1.5); break;
      case 'zoom-out': zoomBy(1 / 1.5); break;
      case 'fit': ed.zoom = null; render(); break;
      case 'undo': undo(); break;
      case 'all': ed.sel = null; render(); restart(); break;
      case 'save': save(false); break;
      case 'save-new': save(true); break;
      case 'put': ed.put = !ed.put; render(); break;
      case 'put-cancel': ed.put = false; render(); break;
      case 'put-go': putIn(); break;
      case 'mid': {
        const [a, c] = range(), name = $('#ed-name').value.trim() || 'Clip';
        env.download(writeMidi({ name, bpm: ed.bpm, tracks: [{ name, ch: 1, notes: inRange([a, c]).map(n => ({ tick: n.pos - a, dur: Math.min(n.len, c - n.pos), note: n.note, vel: n.vel })) }] }), `${name}.mid`);
        break;
      }
    }
  });
  el.addEventListener('change', e => {
    if (!ed) return;
    const t = e.target;
    if (t.id === 'ed-name') ed.name = t.value.trim().slice(0, 60) || ed.name;
    else if (t.id === 'ed-snap') { ed.snap = t.value; render(); }
    else if (t.id === 'ed-bpm') {
      const v = Math.round(+t.value);
      if (!(v >= 40 && v <= 240) || v === ed.bpm) { render(); return; }
      if (ed.free) {
        // Played in free time: the notes stay where they were in time; the bar lines move.
        const k = v / ed.bpm;
        for (const n of new Set([...ed.notes, ...ed.undo.flat()])) { n.pos *= k; n.len *= k; }
        ed.sel = null;
        if (ed.src.kind === 'take') env.setTakeBpm(ed.src.id, v);
      }
      ed.bpm = v;
      render();
      restart();
    } else if (t.id === 'put-track') { ed.putTi = +t.value; ed.putPat = null; ed.giveSound = undefined; render(); }
    else if (t.id === 'put-pat') ed.putPat = t.value;
    else if (t.id === 'put-sound') ed.giveSound = t.checked;
  });
  // The timeline: drag to select (snapped), click a bar number for that bar, click notes to pick them.
  el.addEventListener('pointerdown', e => {
    const svg = e.target.closest('.ed-roll svg');
    if (!svg || !ed || e.button !== 0) return;
    const px = +svg.dataset.px, box = svg.getBoundingClientRect(), T = total();
    const tickAt = x => Math.max(0, Math.min(T, (x - box.left) / px));
    const unit = SNAPS[ed.snap];
    const snap = t => Math.max(0, Math.min(T, Math.round(t / unit) * unit));
    const noteEl = e.target.closest('[data-i]');
    if (noteEl) {
      const n = ed.notes[+noteEl.dataset.i];
      if (e.shiftKey || e.metaKey) { if (ed.picked.has(n)) ed.picked.delete(n); else ed.picked.add(n); }
      else if (ed.picked.has(n) && ed.picked.size === 1) ed.picked.clear();
      else ed.picked = new Set([n]);
      render();
      return;
    }
    e.preventDefault();
    const x0 = e.clientX, t0 = tickAt(e.clientX), onRuler = e.clientY - box.top < RULER_H;
    let moved = false;
    const move = ev => {
      if (!moved && Math.abs(ev.clientX - x0) < 4) return;
      moved = true;
      let a = snap(Math.min(t0, tickAt(ev.clientX))), b = snap(Math.max(t0, tickAt(ev.clientX)));
      if (b <= a) b = Math.min(T, a + unit);
      ed.sel = { a, b };
      renderRoll();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!moved) {
        if (onRuler) { const bar = Math.floor(t0 / TICKS_PER_BAR) * TICKS_PER_BAR; ed.sel = { a: bar, b: Math.min(T, bar + TICKS_PER_BAR) }; }
        else { ed.sel = null; ed.picked.clear(); }
      }
      render();
      restart();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

// Keys while the editor is open; true if used.
export function editorKey(e) {
  if (!ed || e.target.closest?.('input, select, textarea')) return false;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { undo(); return true; }
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key === ' ') { if (ed.playing) stop(); else play(); return true; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && ed.picked.size) { removePicked(); return true; }
  if (e.key === 'Escape' && (ed.sel || ed.picked.size)) { ed.sel = null; ed.picked.clear(); render(); restart(); return true; }
  return false;
}

// The seq-state or instrument list changed: refresh the menus (not while typing in them).
export function refreshEditor() {
  if (ed && !$('#editor').contains(document.activeElement)) render();
}
