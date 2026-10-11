// The computer keyboard as a MIDI keyboard, for when there's no real one:
//   A S D F G H J K L ; '   white keys        W E T Y U O P ]   black keys
//   Z / X                   octave down / up
//   Caps Lock               sustain pedal, following the Caps Lock light (on = held)
//   Tab                     chord mode: the left-hand keys (A W S E D F T G, C to G) play a chord an
//                           octave lower, in the song's scale (major chords without one); the rest
//                           stay single notes, for a melody
// Pages offer it as a MIDI in choice (QWERTY). Notes and the pedal (CC 64) are handed to the page
// as MIDI bytes, and also posted on the shared channel ({ type: 'qwerty', data, wall, from }) so
// the Recorder can capture them, and so playing while the Recorder panel has the focus still
// reaches the page underneath.
//
// Physical key positions (event.code) are used, so it works the same on any keyboard layout.

export const QWERTY = '__qwerty';
export const QWERTY_LABEL = 'Computer keyboard (A–K)';

const KEYS = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17, BracketRight: 18 };
const LEFT_HAND = new Set(['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG']);
const VELOCITY = 100, CHORD_VELOCITY = 80;
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// Scales as in seq/model.js (repeated here so this module stands alone).
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10], 'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'minor pentatonic': [0, 3, 5, 7, 10], 'major pentatonic': [0, 2, 4, 7, 9], blues: [0, 3, 5, 6, 7, 10] };

// Shared by every page (and remembered): the octave (the note A plays), chord mode, the song's scale.
const get = (k, d) => { try { const v = localStorage.getItem(`mkxl.qwerty.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(`mkxl.qwerty.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } };
export const qwertyBase = () => { const v = +get('base', 48); return v >= 12 && v <= 96 ? v : 48; };
export const setQwertyBase = v => put('base', v);
export const chordMode = () => !!get('chords', false);
// The sequencer tells us the song's scale ({ root, type } or null), for in-key chords.
export const setQwertyScale = scale => put('scale', scale);
const noteName = n => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
export const qwertyRange = () => `${noteName(qwertyBase())}–${noteName(qwertyBase() + 18)}`;

// A three-note chord on `root`: built from the song's scale (root, third, fifth of that degree),
// or a major chord when there's no scale or the root isn't in it.
export function chordOn(root, scale = get('scale', null)) {
  const steps = scale && SCALES[scale.type];
  if (steps) {
    const rel = ((root - scale.root) % 12 + 12) % 12, deg = steps.indexOf(rel);
    if (deg >= 0) {
      const at = k => { const d = deg + k, oct = Math.floor(d / steps.length); return root - rel + steps[d % steps.length] + 12 * oct; };
      return [root, at(2), at(4)];
    }
  }
  return [root, root + 4, root + 7];
}

// active(): whether keys should play now. onMessage(data, timeStamp): MIDI bytes for this page.
// from: this page's name, sent with the notes. onOctave(base), onMode(text): after Z / X, Tab.
export function attachQwerty({ active, onMessage, channel, from, onOctave, onMode }) {
  const down = new Map(); // code -> the notes it started
  let sustain = null; // the pedal as last sent (null: not yet known)
  const emit = (data, ts) => {
    onMessage?.(data, ts);
    channel?.postMessage({ type: 'qwerty', data, wall: performance.timeOrigin + ts, from });
  };
  // Caps Lock: whatever its light says, sent as the sustain pedal when it changes.
  const pedal = (e, force = false) => {
    if (!e.getModifierState) return;
    const on = e.getModifierState('CapsLock');
    if (on === sustain && !force) return;
    sustain = on;
    emit([0xb0, 64, on ? 127 : 0], e.timeStamp);
    if (e.code === 'CapsLock') onMode?.(on ? 'Sustain on (Caps Lock)' : 'Sustain off');
  };
  const typing = t => t?.closest?.('input:not([type=range]):not([type=checkbox]), select, textarea, [contenteditable]');
  addEventListener('keydown', e => {
    if (!active() || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    pedal(e, e.code === 'CapsLock');
    if (e.code === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      put('chords', !chordMode());
      onMode?.(chordMode() ? 'Chord mode: A–G play chords, the keys to the right play single notes (Tab to leave)' : 'Chord mode off');
      return;
    }
    if (e.code === 'KeyZ' || e.code === 'KeyX') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      setQwertyBase(Math.max(12, Math.min(96, qwertyBase() + (e.code === 'KeyZ' ? -12 : 12))));
      onOctave?.(qwertyBase());
      return;
    }
    if (!(e.code in KEYS)) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // the page's own shortcuts don't see note keys
    if (e.repeat || down.has(e.code)) return;
    const note = qwertyBase() + KEYS[e.code];
    const chord = chordMode() && LEFT_HAND.has(e.code);
    const notes = chord ? chordOn(note - 12) : [note];
    down.set(e.code, notes);
    for (const n of notes) if (n >= 0 && n <= 127) emit([0x90, n, chord ? CHORD_VELOCITY : VELOCITY], e.timeStamp);
  }, true);
  addEventListener('keyup', e => {
    if (active()) pedal(e, e.code === 'CapsLock');
    if (!down.has(e.code)) return;
    for (const n of down.get(e.code)) if (n >= 0 && n <= 127) emit([0x80, n, 0], e.timeStamp);
    down.delete(e.code);
  }, true);
  // Leaving the page (or switching app) with keys held: let them go.
  addEventListener('blur', () => {
    for (const notes of down.values()) for (const n of notes) emit([0x80, n, 0], performance.now());
    down.clear();
  });
}
