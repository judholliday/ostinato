// The top bar every page shares: the view tabs (Sequencer · Sound Lab · Capture · Instruments),
// a badge on Capture when new takes are waiting there (⌥R goes to Capture and back), and
// ⇅ Transfer, which exports or imports your songs, Lab instruments, patterns and clips
// (core/transfer.js). The travel version has no Instruments tab (the XL editor needs the server).
import { STATIC } from './mode.js';
import { exportBundle, readBundle, importBundle } from './transfer.js';

export const VIEWS = [['sequencer', 'Sequencer'], ['lab', 'Sound Lab'], ['capture', 'Capture'], ['instruments', 'Instruments']];

const nav = document.querySelector('.app-nav');
if (nav && top !== self) {
  const here = nav.dataset.page;
  nav.innerHTML = VIEWS.filter(([v]) => !(STATIC && v === 'instruments')).map(([v, label]) =>
    `<a href="index.html#${v}" data-view="${v}"${v === here ? ' aria-current="page"' : ''}>${label}${v === 'capture' ? '<span class="nav-badge" hidden></span>' : ''}</a>`).join('');
  // Switching views: nothing reloads, so playback (and capture) carry on.
  nav.addEventListener('click', e => {
    const a = e.target.closest('a[data-view]');
    if (!a) return;
    e.preventDefault();
    parent.postMessage({ type: 'switch-view', view: a.dataset.view }, location.origin);
  });
  addEventListener('keydown', e => {
    if (e.altKey && e.code === 'KeyR') { e.preventDefault(); parent.postMessage({ type: 'switch-view', view: 'capture', toggle: true }, location.origin); }
  });
  // New takes since Capture was last looked at (posted by Capture, js/rec/ui.js).
  const badge = nav.querySelector('.nav-badge');
  const ch = 'BroadcastChannel' in window ? new BroadcastChannel('mkxl') : null;
  ch?.addEventListener('message', e => {
    if (e.data?.type !== 'capture-news' || !badge) return;
    badge.hidden = !e.data.count;
    badge.textContent = e.data.count;
    badge.title = `${e.data.count} new take${e.data.count > 1 ? 's' : ''}`;
  });

  const xfer = Object.assign(document.createElement('button'), { className: 'xfer-btn ghost', type: 'button', textContent: '⇅ Transfer',
    title: 'Move your songs, Lab instruments, patterns and clips between home and the travel version' });
  nav.after(xfer);

  // The Transfer dialog.
  const dlg = document.createElement('dialog');
  dlg.className = 'xfer-dialog';
  dlg.innerHTML = `
    <h3>⇅ Transfer</h3>
    <p>${STATIC
      ? 'This is the travel version: your work is kept in this browser. <b>Export</b> it to a file to bring home, and <b>Import</b> a file exported at home.'
      : 'Take your work with you: <b>Export</b> your songs, Lab instruments and saved patterns to a file and open it in the travel version. Back home, <b>Import</b> the file exported there.'}</p>
    <p class="hint">Songs and instruments replace ones with the same name; patterns and clips you already have aren't added twice. XL sounds and recordings aren't included.</p>
    <div class="xfer-row">
      <button class="accent" data-x="export">Export…</button>
      <label class="xfer-import"><input type="file" accept=".json,application/json" hidden> <span class="btn-like">Import…</span></label>
      <span class="spacer"></span>
      <button class="ghost" data-x="close">Close</button>
    </div>
    <p class="xfer-msg"></p>`;
  document.body.append(dlg);
  const msg = (text, kind = '') => { const el = dlg.querySelector('.xfer-msg'); el.textContent = text; el.className = `xfer-msg ${kind}`; };
  xfer.onclick = () => { msg(''); dlg.showModal(); };
  dlg.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'close' || e.target === dlg) dlg.close();
    if (x === 'export') {
      try {
        const { name, counts } = await exportBundle();
        const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
        msg(`Downloaded "${name}": ${n(counts.songs, 'song')}, ${n(counts.instruments, 'instrument')}, ${n(counts.patterns, 'pattern')}, ${n(counts.clips, 'clip')}.`, 'ok');
      } catch (err) { msg(`Couldn't export: ${err.message}`, 'err'); }
    }
  });
  dlg.querySelector('input[type=file]').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { bundle, summary: s } = await readBundle(file);
      const parts = [`${s.songs} song${s.songs === 1 ? '' : 's'}${s.songsReplacing ? ` (${s.songsReplacing} replacing ones with the same name)` : ''}`,
        `${s.instruments} instrument${s.instruments === 1 ? '' : 's'}${s.instrumentsReplacing ? ` (${s.instrumentsReplacing} replacing)` : ''}`,
        `${s.patterns} new pattern${s.patterns === 1 ? '' : 's'}${s.patternsSkipped ? ` (${s.patternsSkipped} already here)` : ''}`,
        `${s.clips} new clip${s.clips === 1 ? '' : 's'}${s.clipsSkipped ? ` (${s.clipsSkipped} already here)` : ''}`];
      if (!confirm(`Import ${parts.join(', ')}?`)) return;
      await importBundle(bundle);
      msg(`Imported ${parts.join(', ')}.`, 'ok');
    } catch (err) { msg(err.message, 'err'); }
  };
}
