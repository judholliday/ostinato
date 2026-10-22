// Audio files from takes and clips (the take editor's ⤓ .wav): a part is a sound with the notes it
// plays. Parts on the computer (Ostinato Synth sounds and test voices) are rendered offline, with
// their track's effects and volume and the song's master effects, through the same limiter as the
// Sequencer; nothing is heard while it renders. Parts on hardware (the XL, other MIDI gear) can only
// be recorded as they play: ui.js does that through the audio input and mixes the two (mixInto).
import { LabSynth, FxChain } from '../lab/engine.js';
import { ensureFx } from '../lab/fxworklet.js';
import { renderVoice } from '../seq/testsynth.js';

// parts: [{ sound: { kind: 'lab', patch } | { kind: 'voice', voice }, fx, gain, notes: [{ t, dur, note, vel }] }]
// (times in seconds). Returns [left, right] Float32Arrays of `seconds` at sampleRate.
export async function renderComputer(parts, { seconds, sampleRate = 48000, masterFx = null }) {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate);
  await ensureFx(ctx); // effects that run in a worklet (bitcrusher, stutter, freeze)
  // As the Sequencer's mix: master → master effects → limiter.
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
  const mfx = new FxChain(ctx);
  mfx.set(masterFx);
  master.connect(mfx.input);
  mfx.output.connect(limiter).connect(ctx.destination);
  const synths = [];
  for (const p of parts) {
    const fx = new FxChain(ctx);
    fx.set(p.fx || null);
    fx.output.connect(master);
    if (p.sound.kind === 'lab') {
      const s = new LabSynth(ctx, fx.input);
      s.setPatch(p.sound.patch);
      s.out.gain.cancelScheduledValues(0);
      s.out.gain.value = s.patch.volume * (p.gain ?? 1);
      synths.push({ s, p });
    } else for (const n of p.notes) renderVoice(ctx, fx.input, p.sound.voice, n.note, n.vel, n.t, n.dur, p.gain ?? 1);
  }
  await Promise.all(synths.map(({ s }) => s.ready())); // samples, pad sounds, string worklets
  for (const { s, p } of synths) for (const n of p.notes) s.play(n.note, n.vel, n.t, n.dur);
  const buf = await ctx.startRendering();
  return [buf.getChannelData(0), buf.getChannelData(1)];
}

// Adds `src` (one or two channels) into `dst` (two channels) from frame 0.
export function mixInto(dst, src) {
  for (let ch = 0; ch < 2; ch++) {
    const s = src[Math.min(ch, src.length - 1)], d = dst[ch], n = Math.min(s.length, d.length);
    for (let i = 0; i < n; i++) d[i] += s[i];
  }
  return dst;
}

// The end of the sound: the last frame above -80 dB (after `from`), plus a short fade.
export function trimTail(chans, from, sampleRate) {
  let end = Math.min(from, chans[0].length);
  for (const d of chans) for (let i = d.length - 1; i > end; i--) if (Math.abs(d[i]) > 1e-4) { end = i; break; }
  const len = Math.min(chans[0].length, end + Math.round(0.05 * sampleRate)), fade = Math.min(len, Math.round(0.02 * sampleRate));
  return chans.map(d => { const c = d.slice(0, len); for (let i = 0; i < fade; i++) c[len - 1 - i] *= i / fade; return c; });
}
