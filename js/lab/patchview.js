// The Lab's patch diagram: modules as boxes, audio as solid cables flowing left to right into the
// output, modulation as dashed cables from envelopes, LFOs, velocity and the mod wheel below.
// Every box shows where it connects:
//   ● on the right    its audio output              ● on top     its modulation output (env, LFO)
//   ● on the left     its audio input (FM in, on an FM operator)
//   ● along the bottom the settings that can be modulated, labelled; the ringed one is where a
//                      modulation dropped on the box goes
// and a ⏻ that bypasses it. Laid out automatically (nothing about positions is saved). Returns
// SVG text; the page (ui.js) handles clicks and drags through the data- attributes.
import { MODULES, SOURCES, defaultTarget, formatAmount, paramOf } from './patch.js';

export const BOX_W = 140, BOX_H = 58;
const COL_W = BOX_W + 72, ROW_H = BOX_H + 34, PAD = 20;
const SHORT = { resonance: 'res', keytrack: 'key' };

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function layout(patch) {
  const byId = new Map(patch.modules.map(m => [m.id, m]));
  const isAudio = m => MODULES[m.type].audioOut || MODULES[m.type].audioIn;
  // Columns from the right: how many audio steps a module is from the output (the longest way).
  const dist = new Map([['out', 0]]);
  const far = (id, seen = new Set()) => {
    if (dist.has(id)) return dist.get(id);
    if (seen.has(id)) return -1;
    seen.add(id);
    let best = -1;
    for (const c of patch.audio) if (c.from === id) { const d = far(c.to, seen); if (d >= 0) best = Math.max(best, d + 1); }
    dist.set(id, best);
    return best;
  };
  const audio = patch.modules.filter(isAudio);
  audio.forEach(m => far(m.id));
  const maxD = Math.max(1, ...audio.map(m => dist.get(m.id)));
  const pos = new Map(), colRows = new Map();
  const place = (id, col) => {
    const row = colRows.get(col) || 0;
    colRows.set(col, row + 1);
    pos.set(id, { x: PAD + col * COL_W, y: PAD + row * ROW_H });
  };
  for (const m of audio) place(m.id, dist.get(m.id) < 0 ? 0 : maxD - dist.get(m.id)); // unconnected ones on the left
  place('out', maxD + 1);
  const rows = Math.max(...colRows.values());
  // Modulation sources in a band underneath, in the order they appear.
  const sources = [...patch.modules.filter(m => MODULES[m.type].modOut).map(m => m.id),
    ...Object.keys(SOURCES).filter(s => patch.mod.some(c => c.from === s))];
  const modY = PAD + rows * ROW_H + 30;
  sources.forEach((id, k) => pos.set(id, { x: PAD + k * (BOX_W + 20), y: modY }));
  const width = Math.max(PAD * 2 + (maxD + 2) * COL_W - 72, PAD * 2 + sources.length * (BOX_W + 20));
  const height = sources.length ? modY + BOX_H + PAD + 40 : PAD + rows * ROW_H + PAD;
  // Where each modulation target's dot is.
  const dots = new Map();
  for (const m of patch.modules) {
    const p = pos.get(m.id), keys = Object.keys(MODULES[m.type].targets);
    if (p) keys.forEach((k, i) => dots.set(`${m.id}.${k}`, { x: p.x + BOX_W * (i + 1) / (keys.length + 1), y: p.y + BOX_H }));
  }
  return { pos, width, height, byId, dots, sources: new Set(sources) };
}

// Selected: { kind: 'audio' | 'mod', from, to } or null.
export function patchSVG(patch, { selected = null } = {}) {
  const { pos, width, height, byId, dots, sources } = layout(patch);
  const label = id => (id === 'out' ? 'Output' : SOURCES[id]?.label || MODULES[byId.get(id)?.type]?.label || id);
  const cables = [];
  for (const c of patch.audio) {
    const a = pos.get(c.from), b = pos.get(c.to);
    if (!a || !b) continue;
    const x1 = a.x + BOX_W, y1 = a.y + BOX_H / 2, x2 = b.x, y2 = b.y + BOX_H / 2, dx = Math.max(30, (x2 - x1) / 2);
    const fm = byId.get(c.to)?.type === 'fmop', off = byId.get(c.from)?.off;
    const sel = selected?.kind === 'audio' && selected.from === c.from && selected.to === c.to;
    const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    cables.push(`<g class="cable audio${fm ? ' fm' : ''}${sel ? ' sel' : ''}${off ? ' off' : ''}" data-kind="audio" data-from="${c.from}" data-to="${c.to}">
      <path class="hit" d="${d}"/><path class="line" d="${d}"/>${fm ? `<text x="${x2 - 22}" y="${y2 - 6}" class="clabel">FM</text>` : ''}</g>`);
  }
  const perDot = new Map(); // how many labels are already under a dot
  patch.mod.forEach(c => {
    const [tid, key] = c.to.split('.'), a = pos.get(c.from), t = dots.get(c.to);
    if (!a || !t) return;
    const sel = selected?.kind === 'mod' && selected.from === c.from && selected.to === c.to;
    let d;
    if (sources.has(tid) && pos.get(tid).y === a.y) {
      // Between two boxes in the bottom row (the mod wheel opening an LFO): an arc underneath.
      const x1 = a.x + BOX_W / 2, y = a.y + BOX_H;
      d = `M${x1},${y} C${x1},${y + 40} ${t.x},${y + 40} ${t.x},${t.y}`;
    } else {
      const x1 = a.x + BOX_W / 2, y1 = a.y;
      d = `M${x1},${y1} C${x1},${y1 - 50} ${t.x},${t.y + 50} ${t.x},${t.y}`;
    }
    const n = perDot.get(c.to) || 0;
    perDot.set(c.to, n + 1);
    const off = byId.get(c.from)?.off || byId.get(tid)?.off;
    cables.push(`<g class="cable mod${sel ? ' sel' : ''}${c.amount === 0 || off ? ' off' : ''}" data-kind="mod" data-from="${c.from}" data-to="${c.to}">
      <path class="hit" d="${d}"/><path class="line" d="${d}"/>
      <text x="${t.x + 6}" y="${t.y + 14 + n * 11}" class="clabel amt">${esc(formatAmount(byId.get(tid).type, key, c.amount))}</text></g>`);
  });
  const boxes = [...pos].map(([id, p]) => {
    const m = byId.get(id), spec = m && MODULES[m.type];
    const kind = id === 'out' ? 'out' : SOURCES[id] || spec?.modOut ? 'src' : spec.scope === 'global' ? 'fx' : 'voice';
    const parts = [`<rect width="${BOX_W}" height="${BOX_H}" rx="8"/>`,
      `<text x="10" y="19" class="bname">${esc(label(id))}</text>`];
    if (m) {
      parts.push(`<text x="10" y="33" class="bid">${esc(id)}</text>`);
      parts.push(`<g class="power${m.off ? ' is-off' : ''}" data-power="${id}"><circle cx="${BOX_W - 14}" cy="14" r="9"/><text x="${BOX_W - 14}" y="18" text-anchor="middle">⏻</text>
        <title>${m.off ? 'Bypassed: click to switch it back on' : 'Click to bypass (switch off without deleting)'}</title></g>`);
    }
    // Audio in (left), audio out (right), modulation out (top).
    if (id === 'out' || spec?.audioIn) {
      const what = id === 'out' ? 'Output' : m.type === 'fmop' ? 'FM in: audio sent here bends this operator\'s pitch' : 'Audio in';
      const from = patch.audio.filter(c => c.to === id).map(c => c.from);
      parts.push(`<circle class="in-port" data-in="${id}" cx="0" cy="${BOX_H / 2}" r="6"><title>${esc(what)}${from.length ? `\n← ${from.join(', ')}` : ''}</title></circle>`);
    }
    if (spec?.audioOut) parts.push(`<circle class="port audio" data-port="${id}" cx="${BOX_W}" cy="${BOX_H / 2}" r="6"><title>Audio out: drag to a module's audio in</title></circle>`);
    if (kind === 'src') parts.push(`<circle class="port mod" data-port="${id}" cx="${BOX_W / 2}" cy="0" r="6"><title>Modulation out: drag to a setting (a dot along a module's bottom)</title></circle>`);
    // Modulatable settings along the bottom.
    if (m) {
      const keys = Object.keys(spec.targets), def = defaultTarget(m.type);
      keys.forEach((k, i) => {
        const x = BOX_W * (i + 1) / (keys.length + 1), to = `${id}.${k}`;
        const ins = patch.mod.filter(c => c.to === to).map(c => `\n← ${c.from}: ${formatAmount(m.type, k, c.amount)}`).join('');
        const name = paramOf(m.type, k)?.label || k;
        parts.push(`<text x="${x}" y="${BOX_H - 7}" class="tlabel" text-anchor="middle">${esc(SHORT[k] || k)}</text>
          <circle class="tdot${k === def ? ' default' : ''}${ins ? ' used' : ''}" data-target="${to}" cx="${x}" cy="${BOX_H}" r="5">
          <title>${esc(name)}${k === def ? ' (where modulation dropped on this module goes)' : ''}${ins || '\nnothing connected: drag an envelope, LFO, velocity or the wheel here'}</title></circle>`);
      });
    }
    return `<g class="box ${kind}${m?.off ? ' is-off' : ''}" data-box="${id}" transform="translate(${p.x},${p.y})">${parts.join('')}</g>`;
  }).join('');
  return `<svg class="patch-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Patch diagram">
    <g class="cables">${cables.join('')}</g>${boxes}<path class="drag-line" d=""/></svg>`;
}
