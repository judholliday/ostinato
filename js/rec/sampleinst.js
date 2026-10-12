// Sampling a hardware synth (the XL) into an Ostinato Synth sound: play it note by note through
// MIDI, record each note from the audio input, and turn the recordings into a multi-sample
// Sampler (lab/patch.js zones). Capture's Audio section runs it (ui.js); this file has the parts
// that don't touch the page.

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const noteName = n => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

// The notes to record: from lo to hi every `step` semitones, always ending on hi.
export function notesToSample(lo, hi, step) {
  const out = [];
  for (let n = lo; n < hi; n += step) out.push(n);
  out.push(hi);
  return [...new Set(out)];
}

// Which keys each recording plays: up to halfway to its neighbours (the lowest and highest
// stretch to the ends of the keyboard).
export function zonesFor(roots) {
  return roots.map((root, k) => ({
    root,
    lo: k === 0 ? 0 : Math.floor((roots[k - 1] + root) / 2) + 1,
    hi: k === roots.length - 1 ? 127 : Math.floor((root + roots[k + 1]) / 2),
  }));
}

const peakOf = chans => { let p = 0; for (const c of chans) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i])); return p; };

// One note's recording, tidied: a little silence at the start trimmed (at most 50 ms: a slow
// attack is kept as it is), the silence at the end trimmed. `holdFrames`: when the key went up.
export function tidy(chans, holdFrames, sr) {
  const peak = peakOf(chans);
  if (peak < 1e-4) return null;
  let start = 0;
  const maxTrim = Math.round(sr * 0.05);
  while (start < maxTrim && chans.every(c => Math.abs(c[start]) < peak * 0.002)) start++;
  start = Math.max(0, start - Math.round(sr * 0.003));
  let end = chans[0].length;
  while (end > start + holdFrames && chans.every(c => Math.abs(c[end - 1]) < peak * 0.001)) end--;
  return { chans: chans.map(c => c.slice(start, end)), hold: holdFrames - start, peak };
}

// How long the sound takes to fade after the key goes up (to 40 dB below its level then), in
// seconds, for the Amp's release.
export function releaseTime(chans, hold, sr) {
  const a = chans[0], win = Math.round(sr * 0.02);
  const level = from => { let p = 0; for (let i = from; i < Math.min(a.length, from + win); i++) p = Math.max(p, Math.abs(a[i])); return p; };
  const at = level(Math.max(0, hold - win));
  if (at < 1e-4) return 0.1;
  for (let i = hold; i < a.length; i += win) if (level(i) < at * 0.01) return Math.max(0.03, (i - hold) / sr);
  return Math.max(0.03, (a.length - hold) / sr);
}

// A loop in the held part (between 45% and 92% of it) that repeats smoothly: it ends and starts
// on rising zero crossings, and the end is crossfaded into what comes before the start, so the
// jump back is seamless. Changes `chans` in place; returns { start, end } in frames, or null if
// the note is too short to loop.
export function makeLoop(chans, hold, sr) {
  const a = chans[0], lo = Math.round(hold * 0.45), hi = Math.round(hold * 0.92);
  if (hi - lo < sr * 0.25) return null;
  const rising = (from, dir) => { for (let i = from; i > 1 && i < a.length - 1; i += dir) if (a[i - 1] < 0 && a[i] >= 0) return i; return from; };
  const end = rising(hi, -1), start = rising(lo, 1);
  const F = Math.min(Math.round(sr * 0.08), Math.floor((end - start) / 3), start);
  if (end - start < sr * 0.15 || F < 32) return null;
  for (const c of chans) {
    for (let i = 0; i < F; i++) {
      const t = i / F, k = end - F + i;
      c[k] = c[k] * Math.cos(t * Math.PI / 2) + c[start - F + i] * Math.sin(t * Math.PI / 2);
    }
  }
  return { start, end };
}

// The Ostinato Synth sound: a Sampler with one zone per recording into an Amp.
export function buildPatch({ name, zones, loop, release, type }) {
  return {
    format: 'mkxl-inst', version: 1, name: name.slice(0, 40), type, voices: 8, volume: 0.8,
    modules: [
      { id: 'smp1', type: 'sampler', params: { file: zones[0].file, mode: loop ? 'loop' : 'keys', root: zones[0].root, start: 0, end: 1, loopStart: 0.3, loopEnd: 0.9, tune: 0, fine: 0, level: 1 }, zones },
      { id: 'amp1', type: 'amp', params: { attack: 0.003, decay: 0.3, sustain: 1, release: Math.min(10, Math.max(0.03, release)), velocity: 0.5, level: 0.9 } },
    ],
    audio: [{ from: 'smp1', to: 'amp1' }, { from: 'amp1', to: 'out' }],
    mod: [], cc: {},
  };
}
