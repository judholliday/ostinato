// The Sequencer's mix for computer sounds (model.js: a track's pan, reverb, delay, duck, sidechain;
// the song's mix). Each track's sound, after its own effects, goes through a strip:
//   input → pan → duck (side-chain gain) → meter → out (the master)
//                                        ↘ reverb send → the shared reverb ↘
//                                        ↘ delay send  → the shared delay  → out
// The shared reverb and delay are fully wet (the dry sound comes from the strip). Ducking is
// scheduled at the side-chain source's notes (duckAt), not detected from its sound, so it lands
// exactly on the beat. Works on any AudioContext, live or offline (rendering the song). No DOM.
import { reverbImpulse } from '../lab/engine.js';
import { syncBeats } from '../lab/patch.js';

export class Mixer {
  constructor(ac, out) {
    this.ac = ac;
    this.out = out;
    this.strips = new Map(); // track index -> strip
    this.mix = null;
    this.bpm = 120;
    // Shared reverb
    this.revIn = ac.createGain();
    this.conv = ac.createConvolver();
    this.revIn.connect(this.conv).connect(out);
    // Shared delay: a feedback loop with a tone low-pass, the echoes alternating left and right
    this.dlyIn = ac.createGain();
    this.dl = ac.createDelay(4);
    this.fb = ac.createGain();
    this.tone = ac.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.Q.value = 0.5; // no resonant bump: an echo is never louder than what it echoes
    const pan = ac.createStereoPanner(); // the echoes sit a little to the right of the dry sound
    pan.pan.value = 0.3;
    this.dlyIn.connect(this.dl).connect(this.tone).connect(this.fb).connect(this.dl);
    this.tone.connect(pan).connect(out);
    this.revKey = '';
  }

  // The song's shared reverb and delay, and the tempo the delay locks to.
  setMix(mix, bpm = this.bpm) {
    this.mix = mix;
    this.bpm = bpm;
    const now = this.ac.currentTime;
    const key = `${mix.reverb.size}:${mix.reverb.damping}`;
    if (key !== this.revKey) {
      this.revKey = key;
      const ac = this.ac;
      this.conv.buffer = reverbImpulse(ac.sampleRate, { type: 'hall', size: mix.reverb.size, predelay: 20, damping: mix.reverb.damping },
        (chans, len) => { const b = ac.createBuffer(2, len, ac.sampleRate); chans.forEach((d, ch) => b.copyToChannel(d, ch)); return b; });
    }
    this.dl.delayTime.setTargetAtTime(Math.min(3.9, syncBeats(mix.delay.sync) * 60 / bpm), now, 0.02);
    this.fb.gain.setTargetAtTime(mix.delay.feedback, now, 0.02);
    this.tone.frequency.setTargetAtTime(mix.delay.tone, now, 0.02);
  }

  // Track ti's strip, made on first use. Its `input` is where the track's sound goes.
  strip(ti) {
    let s = this.strips.get(ti);
    if (s) return s;
    const ac = this.ac;
    s = { input: ac.createGain(), pan: ac.createStereoPanner(), duck: ac.createGain(), meter: ac.createAnalyser(), rev: ac.createGain(), dly: ac.createGain(), amount: 0 };
    s.meter.fftSize = 512;
    s.rev.gain.value = 0; s.dly.gain.value = 0;
    s.input.connect(s.pan).connect(s.duck).connect(this.out);
    s.duck.connect(s.meter);
    s.duck.connect(s.rev).connect(this.revIn);
    s.duck.connect(s.dly).connect(this.dlyIn);
    s.data = new Float32Array(s.meter.fftSize);
    this.strips.set(ti, s);
    return s;
  }

  // A track's pan, sends and duck amount (model.js track fields).
  setTrack(ti, t) {
    const s = this.strip(ti), now = this.ac.currentTime;
    s.pan.pan.setTargetAtTime(t.pan || 0, now, 0.01);
    s.rev.gain.setTargetAtTime(t.reverb || 0, now, 0.01);
    s.dly.gain.setTargetAtTime(t.delay || 0, now, 0.01);
    s.amount = t.duck || 0;
  }

  // The side-chain source played at audio time `t`: ducked tracks dip by their amount within ~5 ms
  // and come back over the song's release.
  duckAt(t) {
    const rel = this.mix?.release ?? 0.18;
    for (const s of this.strips.values()) {
      if (!(s.amount > 0)) continue;
      const g = s.duck.gain;
      g.cancelAndHoldAtTime(t);
      g.setTargetAtTime(1 - s.amount, t, 0.0015);
      g.setTargetAtTime(1, t + 0.012, rel / 3);
    }
  }
  // Back to full level at once (Stop).
  reset() {
    const now = this.ac.currentTime;
    for (const s of this.strips.values()) { s.duck.gain.cancelScheduledValues(now); s.duck.gain.setTargetAtTime(1, now, 0.01); }
  }

  // Each strip's peak level now (0-1+), for meters.
  levels() {
    const out = new Map();
    for (const [ti, s] of this.strips) {
      s.meter.getFloatTimeDomainData(s.data);
      let pk = 0;
      for (const x of s.data) pk = Math.max(pk, Math.abs(x));
      out.set(ti, pk);
    }
    return out;
  }
}
