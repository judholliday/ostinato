// The performance pad (the Mixer's Perform strip): an XY pad that bends the whole mix live while
// you hold it, and lets go when you do (or stays on with Hold). It sits at the very end of the
// computer's mix, after Master FX and before the limiter, so recordings of what Ostinato plays
// (Capture's "Ostinato (what it plays)") include it; it isn't part of the song, so ⤓ Render song
// and .mid export don't. One effect at a time:
//   filter  left of centre a low-pass closes (to 120 Hz at the edge), right of centre a high-pass
//           opens (to 6 kHz); the middle is open. Up = more resonance.
//   roll    the slice starting where you pressed repeats (ost-roll in fxworklet.js), its length
//           locked to the tempo: 1/2 at the left … 1/32 at the right. Up = repeats only, down =
//           repeats under the music.
//   echo    a delay throw: the mix goes into a tempo-synced echo while held; let go and the echoes
//           ring on and fade (Stop cuts them). Left to right = echo time (1/16 … 1/2), up = more
//           feedback (30-80%: at most ~16 s to fade 60 dB at 1/2 and 120 bpm).
import { syncBeats } from '../lab/patch.js';
import { ensureFx, fxReady } from '../lab/fxworklet.js';

export const PAD_MODES = ['filter', 'roll', 'echo'];
export const PAD_LABELS = { filter: 'Filter', roll: 'Roll', echo: 'Echo throw' };
export const PAD_HELP = {
  filter: 'Left: a low-pass closes. Right: a high-pass opens. The middle is open. Up: more resonance.',
  roll: 'Repeats the beat you press on. Left to right: 1/2 down to 1/32. Up: repeats only; down: repeats under the music.',
  echo: 'Sends the mix into an echo while you hold; the echoes ring on when you let go. Left to right: echo time. Up: more echoes.',
};
const ROLLS = ['1/2', '1/4', '1/8', '1/16', '1/16t', '1/32'];
const ECHOES = ['1/16', '1/8t', '1/8', '1/8.', '1/4', '1/4.', '1/2'];
const MID = 0.06; // half the filter's open zone in the middle
const zone = (list, x) => list[Math.min(list.length - 1, Math.floor(Math.max(0, x) * list.length))];
const clamp = x => Math.max(0, Math.min(1, x));

// What the pad does at (x, y) in a mode (0-1 each, y up), as numbers for the engine and text for the page.
export function padValues(mode, x, y) {
  x = clamp(x); y = clamp(y);
  if (mode === 'filter') {
    const res = -3.01 + y * 18; // low/high-pass Q is in dB in Web Audio; -3.01 = no peak
    if (x < 0.5 - MID) { const f = 120 * (20000 / 120) ** ((x) / (0.5 - MID)); return { lp: f, hp: 10, res, text: `Low-pass ${hz(f)}` }; }
    if (x > 0.5 + MID) { const f = 20 * (6000 / 20) ** ((x - 0.5 - MID) / (0.5 - MID)); return { lp: 20000, hp: f, res, text: `High-pass ${hz(f)}` }; }
    return { lp: 20000, hp: 10, res: -3.01, text: 'Open' };
  }
  if (mode === 'roll') { const r = zone(ROLLS, x); return { beats: syncBeats(r), mix: y, text: `Roll ${r}${y < 0.5 ? ' under the music' : ''}` }; }
  const e = zone(ECHOES, x), fb = 0.3 + 0.5 * y;
  return { beats: syncBeats(e), fb, text: `Echo ${e} · ${Math.round(fb * 100)}% feedback` };
}
const hz = f => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`);

export class PerfPad {
  // input → roll → low-pass → high-pass → output, and from the high-pass a send into the echo, whose
  // returns join the output. Everything is straight through until the pad is touched (a low-pass at
  // half the sample rate and a high-pass at 0 Hz pass sound unchanged).
  constructor(ac) {
    this.ac = ac; this.tempo = 120; this.mode = null;
    this.input = ac.createGain(); this.output = ac.createGain();
    this.lp = ac.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = this.open = ac.sampleRate / 2; this.lp.Q.value = -3.01;
    this.hp = ac.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 0; this.hp.Q.value = -3.01;
    this.send = ac.createGain(); this.send.gain.value = 0;
    this.delay = ac.createDelay(3);
    this.fb = ac.createGain(); this.fb.gain.value = 0.5;
    // The loop's filters must not resonate (Q in dB, -3.01 = no peak): with the default Q of 1 dB each
    // boosted near its corner, so at 82% feedback the echoes grew instead of dying (they rang for good,
    // held at full level by the limiter).
    const lo = ac.createBiquadFilter(); lo.type = 'highpass'; lo.frequency.value = 150; lo.Q.value = -3.01;
    const hi = ac.createBiquadFilter(); hi.type = 'lowpass'; hi.frequency.value = 4500; hi.Q.value = -3.01;
    this.input.connect(this.lp); // the roll goes in front once the worklet has loaded
    this.lp.connect(this.hp).connect(this.output);
    this.ret = ac.createGain();
    this.hp.connect(this.send).connect(this.delay).connect(lo).connect(hi).connect(this.ret).connect(this.output);
    hi.connect(this.fb).connect(this.delay);
    ensureFx(ac).then(ok => {
      if (!ok || !fxReady(ac)) return;
      this.roll = new AudioWorkletNode(ac, 'ost-roll', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.input.disconnect(); this.input.connect(this.roll).connect(this.lp);
    });
  }
  setTempo(bpm) { this.tempo = bpm || 120; if (this.mode) this.set(this.mode, this.x, this.y); }
  // How far to snap a press to the grid: `heard` = the tick being heard as the press came (what the
  // speakers play lags the audio clock by the output delay), `now` = the tick the audio clock is at.
  // The nearest line of the roll's grid (1/16, or the roll's length when shorter) to what was heard.
  gridBack(mode, x, y, heard, now, tickS) {
    if (mode !== 'roll') return null;
    const g = Math.min(24, Math.round(padValues(mode, x, y).beats * 96)), line = Math.round(heard / g) * g;
    return { back: (now - line) * tickS };
  }
  // Touch (or move on) the pad in `mode`. Another mode's effect lets go first. `grid` (only when
  // touching it, while the song plays): { back } = seconds since the beat line the press belongs to
  // (negative = that line is still to come), so a roll starts on the beat, not where the mouse landed.
  set(mode, x, y, grid) {
    if (this.mode && this.mode !== mode) this.release();
    const first = this.mode !== mode;
    this.mode = mode; this.x = x; this.y = y;
    const v = padValues(mode, x, y), t = this.ac.currentTime, beat = 60 / this.tempo;
    if (mode === 'filter') {
      this.lp.frequency.setTargetAtTime(v.lp >= 20000 ? this.open : v.lp, t, 0.02); this.hp.frequency.setTargetAtTime(v.hp <= 10 ? 0 : v.hp, t, 0.02);
      this.lp.Q.setTargetAtTime(v.res, t, 0.02); this.hp.Q.setTargetAtTime(v.res, t, 0.02);
    } else if (mode === 'roll' && this.roll) {
      const P = n => this.roll.parameters.get(n);
      P('size').setValueAtTime(v.beats * beat, t); P('mix').setValueAtTime(v.mix, t);
      if (first) {
        const back = grid?.back || 0, at = t + Math.max(0, -back);
        P('back').setValueAtTime(Math.max(0, back), at); P('on').setValueAtTime(1, at);
      }
    } else if (mode === 'echo') {
      this.delay.delayTime.setTargetAtTime(Math.min(2.9, v.beats * beat), t, 0.04);
      this.fb.gain.setTargetAtTime(v.fb, t, 0.02);
      this.send.gain.setTargetAtTime(1, t, 0.005);
    }
    return v;
  }
  // Let go: the filter opens again, the roll stops, the echo send closes (its echoes ring on).
  release() {
    const t = this.ac.currentTime, m = this.mode;
    this.mode = null;
    if (m === 'filter') {
      this.lp.frequency.setTargetAtTime(this.open, t, 0.04); this.hp.frequency.setTargetAtTime(0, t, 0.04);
      this.lp.Q.setTargetAtTime(-3.01, t, 0.04); this.hp.Q.setTargetAtTime(-3.01, t, 0.04);
    } else if (m === 'roll') { const on = this.roll?.parameters.get('on'); on?.cancelScheduledValues(t); on?.setValueAtTime(0, t); }
    else if (m === 'echo') this.send.gain.setTargetAtTime(0, t, 0.01);
  }
  // Stop: let go, and fade out the echoes still ringing (and a roll's repeats) instead of leaving them
  // to die away after the song has stopped.
  stop() {
    this.release();
    const t = this.ac.currentTime, wait = this.delay.delayTime.value + 0.1;
    for (const g of [this.ret.gain, this.fb.gain]) { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
    this.ret.gain.setTargetAtTime(0, t, 0.05);
    this.fb.gain.setTargetAtTime(0, t, 0.05);
    // Once the delay has emptied, back to normal for the next throw.
    this.ret.gain.setValueAtTime(1, t + wait);
    this.fb.gain.setValueAtTime(0.5, t + wait);
  }
}
