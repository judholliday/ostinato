// The computer keyboard as a MIDI keyboard, for when there's no real one: A–K are white keys,
// W E T Y U O P black keys, Z / X move an octave down / up. Pages offer it as a MIDI in choice
// (QWERTY). Notes are handed to the page as MIDI bytes, and also posted on the shared channel
// ({ type: 'qwerty', data, wall, from }) so the Recorder can capture them, and so playing while
// the Recorder panel has the focus still reaches the page underneath.
//
// Physical key positions (event.code) are used, so it works the same on any keyboard layout.

export const QWERTY = '__qwerty';
export const QWERTY_LABEL = 'Computer keyboard (A–K)';

const KEYS = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };
const VELOCITY = 100;
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// The octave is shared by every page (and remembered): the note A plays.
export function qwertyBase() {
  try { const v = +localStorage.getItem('mkxl.qwerty.base'); return v >= 12 && v <= 96 ? v : 48; } catch { return 48; }
}
export function setQwertyBase(v) { try { localStorage.setItem('mkxl.qwerty.base', String(v)); } catch { /* storage unavailable */ } }
const setBase = setQwertyBase;
export const qwertyRange = () => { const b = qwertyBase(); return `${NAMES[b % 12]}${Math.floor(b / 12) - 1}–${NAMES[(b + 16) % 12]}${Math.floor((b + 16) / 12) - 1}`; };

// active(): whether keys should play now. onMessage(data, timeStamp): MIDI bytes for this page.
// from: this page's name, sent with the notes. onOctave(base): after Z / X.
export function attachQwerty({ active, onMessage, channel, from, onOctave }) {
  const down = new Map(); // code -> note
  const emit = (data, ts) => {
    onMessage?.(data, ts);
    channel?.postMessage({ type: 'qwerty', data, wall: performance.timeOrigin + ts, from });
  };
  const typing = t => t?.closest?.('input:not([type=range]):not([type=checkbox]), select, textarea, [contenteditable]');
  addEventListener('keydown', e => {
    if (!active() || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    if (e.code === 'KeyZ' || e.code === 'KeyX') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      const base = Math.max(12, Math.min(96, qwertyBase() + (e.code === 'KeyZ' ? -12 : 12)));
      setBase(base);
      onOctave?.(base);
      return;
    }
    if (!(e.code in KEYS)) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // the page's own shortcuts don't see note keys
    if (e.repeat || down.has(e.code)) return;
    const note = qwertyBase() + KEYS[e.code];
    down.set(e.code, note);
    emit([0x90, note, VELOCITY], e.timeStamp);
  }, true);
  addEventListener('keyup', e => {
    if (!down.has(e.code)) return;
    emit([0x80, down.get(e.code), 0], e.timeStamp);
    down.delete(e.code);
  }, true);
  // Leaving the page (or switching app) with keys held: let them go.
  addEventListener('blur', () => { for (const note of down.values()) emit([0x80, note, 0], performance.now()); down.clear(); });
}
