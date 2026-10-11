// The sound picker: a popover listing sounds from every instrument (core/catalog.js), the same way
// the Sound Lab's library does: search, instrument (playable now by default), type. Clicking a
// sound picks it but leaves the picker open, so you can step through sounds (↑ ↓) and hear each
// one; Esc, ✕ or a click outside closes it.
//
//   openSoundPicker({ anchor, title, current, isCurrent, extra, instruments, outputs, onPick })
//     current: the key of the sound in use, or isCurrent(entry) to find it among the sounds
//     extra: [{ label, items: [{ key, name, note?, sound }] }]   shown first (e.g. "As recorded")
//     instruments: which instruments to offer (ids; default all)
//     outputs(): the page's MIDI outputs, to tell which instruments can be heard
//     onPick(item): item is an extra item or a catalog entry ({ key, name, type, sound, ... })
import { synthSounds, deviceSounds, availability, typeRank, instrumentName, INSTRUMENTS } from './catalog.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_ROWS = 250;
let open = null; // { el, opts, entries, inst, type, q, current }

export function closeSoundPicker() {
  if (!open) return;
  open.el.remove();
  removeEventListener('pointerdown', outside, true);
  open = null;
}
const outside = e => { if (open && !open.el.contains(e.target) && !open.opts.anchor.contains(e.target)) closeSoundPicker(); };

export async function openSoundPicker(opts) {
  if (open?.opts.anchor === opts.anchor) { closeSoundPicker(); return; }
  closeSoundPicker();
  opts.anchor.scrollIntoView({ block: 'nearest' });
  const el = document.createElement('div');
  el.className = 'sound-picker';
  el.setAttribute('role', 'dialog');
  document.body.append(el);
  open = { el, opts, entries: null, inst: 'playable', type: '', q: '', current: opts.current };
  addEventListener('pointerdown', outside, true);
  render();
  place();
  const ids = opts.instruments || INSTRUMENTS.map(i => i.id);
  const lists = await Promise.all(ids.map(id => (id === 'synth' ? synthSounds() : deviceSounds(id))));
  if (!open || open.el !== el) return;
  open.entries = lists.flat();
  if (opts.isCurrent && !itemOf(open.current)) open.current = open.entries.find(opts.isCurrent)?.key ?? open.current;
  render();
  el.querySelector('.sp-search')?.focus();
}

function place() {
  const { el, opts } = open, r = opts.anchor.getBoundingClientRect();
  const w = Math.min(420, innerWidth - 16), h = Math.min(520, innerHeight - 16);
  el.style.width = `${w}px`;
  el.style.maxHeight = `${h}px`;
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + 6 + h <= innerHeight ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px`;
}

function shown() {
  const on = availability(open.opts.outputs?.() || []), q = open.q.trim().toLowerCase();
  const inInst = (open.entries || []).filter(e => (open.inst === 'playable' ? on[e.instrument] : e.instrument === open.inst)
    && (!q || `${e.name} ${e.type} ${e.bank}`.toLowerCase().includes(q)));
  return { on, inInst, list: inInst.filter(e => !open.type || e.type === open.type) };
}

function render() {
  const { el, opts } = open, { on, inInst, list } = shown();
  const ids = [...new Set((open.entries || []).map(e => e.instrument))];
  const counts = new Map();
  for (const e of inInst) counts.set(e.type, (counts.get(e.type) || 0) + 1);
  const types = [...counts.keys()].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
  const q = open.q.trim().toLowerCase();
  const extra = (opts.extra || []).map(g => ({ ...g, items: g.items.filter(x => !q || `${x.name} ${x.note || ''}`.toLowerCase().includes(q)) })).filter(g => g.items.length);
  const row = (key, name, note, cls = '') => `<button class="sp-row${key === open.current ? ' on' : ''}${cls}" data-key="${esc(key)}"><span class="nm">${esc(name)}</span>${note ? `<span class="note">${esc(note)}</span>` : ''}</button>`;
  const sorted = [...list].sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.type.localeCompare(b.type) || (b.mine - a.mine) || a.name.localeCompare(b.name));
  let lastType = null;
  el.innerHTML = `
    <div class="sp-head"><b>${esc(opts.title || 'Choose a sound')}</b><span class="spacer"></span><button class="ghost small" data-close title="Close (Esc)">✕</button></div>
    <input class="sp-search" type="search" placeholder="Search sounds" value="${esc(open.q)}" spellcheck="false" autocomplete="off">
    ${ids.length > 1 || ids.some(id => !on[id]) ? `<div class="sp-chips">
      <button class="chip${open.inst === 'playable' ? ' on' : ''}" data-inst="playable">Playable now</button>
      ${ids.map(id => `<button class="chip${open.inst === id ? ' on' : ''}" data-inst="${id}">${esc(instrumentName(id))}${on[id] ? '' : ' · not connected'}</button>`).join('')}</div>` : ''}
    <div class="sp-chips"><button class="chip${open.type ? '' : ' on'}" data-type="">All</button>${types.map(t => `<button class="chip${open.type === t ? ' on' : ''}" data-type="${esc(t)}">${esc(t)} <span>${counts.get(t)}</span></button>`).join('')}</div>
    <div class="sp-list" tabindex="0">
      ${extra.map(g => `<div class="sp-group">${esc(g.label)}</div>${g.items.map(x => row(x.key, x.name, x.note)).join('')}`).join('')}
      ${open.entries === null ? '<div class="hint sp-empty">Loading sounds…</div>' : sorted.slice(0, MAX_ROWS).map(e => {
        const head = e.type !== lastType ? `<div class="sp-group">${esc(e.type)}</div>` : '';
        lastType = e.type;
        return head + row(e.key, e.name, `${e.mine ? '★ ' : ''}${ids.length > 1 ? `${instrumentName(e.instrument)} · ` : ''}${e.bank}`, on[e.instrument] ? '' : ' silent');
      }).join('')}
      ${list.length > MAX_ROWS ? `<div class="hint sp-empty">${list.length - MAX_ROWS} more: search or pick a type.</div>` : ''}
      ${open.entries && !list.length && !extra.length ? '<div class="hint sp-empty">No sounds match.</div>' : ''}
    </div>
    <div class="hint sp-foot">Click a sound to use it; ↑ ↓ step through. ${Object.entries(on).some(([id, v]) => !v && ids.includes(id)) ? 'Instruments that aren\'t connected are hidden under Playable now.' : ''}</div>`;
  el.querySelector('.sp-row.on')?.scrollIntoView({ block: 'nearest' });
}

function itemOf(key) {
  for (const g of open.opts.extra || []) { const x = g.items.find(i => i.key === key); if (x) return x; }
  return open.entries?.find(e => e.key === key) || null;
}
function pick(key) {
  const item = itemOf(key);
  if (!item) return;
  open.current = key;
  open.opts.onPick(item);
  if (!open) return; // onPick closed it
  open.el.querySelectorAll('.sp-row').forEach(r => r.classList.toggle('on', r.dataset.key === key));
  open.el.querySelector('.sp-row.on')?.scrollIntoView({ block: 'nearest' });
}

addEventListener('click', e => {
  if (!open || !open.el.contains(e.target)) return;
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.close !== undefined) closeSoundPicker();
  else if (b.dataset.inst) { open.inst = b.dataset.inst; open.type = ''; render(); }
  else if (b.dataset.type !== undefined) { open.type = b.dataset.type; render(); }
  else if (b.dataset.key) pick(b.dataset.key);
});
addEventListener('input', e => {
  if (!open || !e.target.matches('.sound-picker .sp-search')) return;
  open.q = e.target.value;
  const at = e.target.selectionStart;
  render();
  const s = open.el.querySelector('.sp-search');
  s.focus();
  s.setSelectionRange(at, at);
});
addEventListener('keydown', e => {
  if (!open) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSoundPicker(); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open.el.contains(e.target)) {
    e.preventDefault();
    const rows = [...open.el.querySelectorAll('.sp-row')];
    if (!rows.length) return;
    const at = rows.findIndex(r => r.classList.contains('on'));
    pick(rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))].dataset.key);
  }
}, true);
addEventListener('resize', () => { if (open) place(); });
