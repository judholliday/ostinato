// The top bar every page shares: the view tabs (Sequencer · Sound Lab · Capture · Instruments),
// a badge on Capture when new takes are waiting there (⌥R goes to Capture and back), and
// ⇅ Transfer, which exports or imports your songs, Lab instruments, patterns and clips
// (core/transfer.js). The travel version has no Instruments tab (the XL editor needs the server).
import { icon, fillIcons } from './icons.js';
import { STATIC } from './mode.js';
import { exportBundle, readBundle, importBundle } from './transfer.js';

export const VIEWS = [['sequencer', 'Sequencer'], ['lab', 'Sound Lab'], ['capture', 'Capture'], ['instruments', 'Instruments']];

fillIcons(document); // <span data-icon> in the page's own HTML

// The sticky top bar's height, as --bar-h, so sticky panels below it (the Sound Lab's sound list)
// fit the rest of the window instead of running under the bar or off the bottom.
const bar = document.querySelector('.bar');
if (bar && 'ResizeObserver' in window) new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`)).observe(bar);

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

  const xfer = Object.assign(document.createElement('button'), { className: 'xfer-btn ghost', type: 'button', innerHTML: `${icon('transfer')} Transfer`,
    title: 'Move your songs, Lab instruments, patterns and clips between home and the travel version' });
  nav.after(xfer);

  // The LCD: what the sequencer is doing, which track your keys play, and the XL's sound, from
  // the messages the pages already send each other (asked for once at load).
  const lcd = Object.assign(document.createElement('div'), { className: 'lcd lcd-status', title: 'Playing or stopped, the track your keys go to, and the sound on the microKORG XL' });
  const st = { playing: false, bpm: null, mode: 'loop', track: null, pattern: null, xl: null, xlTrack: null, armed: null };
  const pad = (t, n) => String(t).toUpperCase().slice(0, n).padEnd(n);
  const show = () => {
    const top = `${st.playing ? '▶' : '■'} ${st.playing ? (st.mode === 'song' ? 'SONG' : `LOOP ${st.pattern || ''}`) : 'STOPPED'}`;
    // Keys go to the armed track (notes are added) or else play the selected one.
    const keys = st.armed ? `REC ▸ ${pad(st.armed, 10)}` : st.track ? `KEYS ▸ ${pad(st.track, 9)}` : 'KEYS ▸ –        ';
    const xl = STATIC ? '' : st.xlTrack ? `XL ▸ ${pad(st.xlTrack, 8)}` : st.xl ? `XL ▸ ${pad(st.xl, 8)}` : '';
    lcd.textContent = `${pad(top, 13)} ${st.bpm ? `${st.bpm} BPM` : ''}\n${keys} ${xl}`;
  };
  xfer.before(lcd);
  show();
  // Play, Stop, Rec and the position on every tab but the Sequencer (which has its own): they
  // drive the sequencer, so playback is never more than a click away.
  let tp = null;
  if (here !== 'sequencer' && ch) {
    tp = Object.assign(document.createElement('div'), { className: 'top-transport' });
    tp.innerHTML = `<button class="tkey" data-t="play" title="Play the sequencer"><i class="led"></i>${icon('play')}</button><button class="tkey" data-t="stop" title="Stop"><i class="led"></i>${icon('stop')}</button>
      <button class="tkey" data-t="rec" title="Record what you play on your MIDI keyboard into the sequencer's selected track (while playing)"><i class="led"></i>${icon('rec')}</button><span class="pos lcd-pos">—</span>`;
    tp.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) ch.postMessage({ type: 'transport-cmd', cmd: b.dataset.t }); });
    lcd.before(tp);
  }
  ch?.addEventListener('message', e => {
    const m = e.data;
    if (m?.type === 'transport') {
      st.playing = !!m.playing;
      if (m.anchor?.bpm) st.bpm = m.anchor.bpm;
      tp?.querySelector('[data-t="play"]').classList.toggle('playing', st.playing);
      tp?.querySelector('[data-t="rec"]').classList.toggle('rec-on', !!m.rec);
    } else if (m?.type === 'pos') { if (tp) tp.querySelector('.lcd-pos').textContent = m.text; return; }
    else if (m?.type === 'seq-state') Object.assign(st, { bpm: m.bpm, mode: m.mode, track: m.track?.name, pattern: m.track?.pattern, xlTrack: m.xlTrack, armed: m.armed });
    else if (m?.type === 'program' && m.name) st.xl = m.name;
    else return;
    show();
  });
  ch?.postMessage({ type: 'get-seq-state' });
  if (!STATIC) ch?.postMessage({ type: 'get-program' });

  // The Transfer dialog.
  const dlg = document.createElement('dialog');
  dlg.className = 'xfer-dialog';
  dlg.innerHTML = `
    <h3>${icon('transfer')} Transfer</h3>
    <p>${STATIC
      ? 'This is the travel version: your work is kept in this browser. <b>Export</b> it to a file to bring home, and <b>Import</b> a file exported at home.'
      : 'Take your work with you: <b>Export</b> your songs, Lab instruments, saved patterns and clips (with the recordings they use) to a file and open it in the travel version. Back home, <b>Import</b> the file exported there.'}</p>
    <p class="hint">Songs and instruments replace ones with the same name; patterns, clips and recordings you already have aren't added twice. Your other recordings and XL sounds (My Sounds) aren't included.</p>
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
        msg(`Downloaded "${name}": ${n(counts.songs, 'song')}, ${n(counts.instruments, 'instrument')}, ${n(counts.patterns, 'pattern')}, ${n(counts.clips, 'clip')}, ${n(counts.recordings, 'recording')} they use.`, 'ok');
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
        `${s.clips} new clip${s.clips === 1 ? '' : 's'}${s.clipsSkipped ? ` (${s.clipsSkipped} already here)` : ''}`,
        `${s.recordings} recording${s.recordings === 1 ? '' : 's'}${s.recordingsSkipped ? ` (${s.recordingsSkipped} already here)` : ''}`];
      if (!confirm(`Import ${parts.join(', ')}?`)) return;
      await importBundle(bundle);
      msg(`Imported ${parts.join(', ')}.`, 'ok');
    } catch (err) { msg(err.message, 'err'); }
  };
}
