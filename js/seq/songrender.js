// The Sequencer's ⤓ Render song: the whole song (its sections once through) as audio, rendered
// offline (faster than playing it, nothing heard). The notes come from midifile.js renderSong (the
// real engine on a fake clock, so swing, feel, chance and pools are as when it plays); computer
// tracks play them through the same chain as live: the track's sound (an Ostinato Synth sound or a
// test voice), its effects, its strip in the mix (mixer.js: pan, sends, ducking), then the master
// effects and the limiter. Hardware tracks (the XL, MIDI gear) can't be rendered: they're listed in
// `missing` (Capture's Print stems records them through an audio input).
import * as M from './model.js';
import { renderSong } from './midifile.js';
import { Mixer } from './mixer.js';
import { renderVoice } from './testsynth.js';
import { LabSynth, FxChain } from '../lab/engine.js';
import { ensureFx } from '../lab/fxworklet.js';

const LEAD = 0.05; // seconds of silence before bar 1

// Renders `tis` (track indexes) of the song with the full mix; returns [left, right] at sampleRate.
async function renderTracks(song, notes, tis, { seconds, sampleRate, heard, autos }) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  await ensureFx(ctx);
  const master = ctx.createGain();
  master.gain.value = 0.9; // as testsynth.js
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
  const mfx = new FxChain(ctx);
  mfx.tempo = song.bpm;
  mfx.set(song.masterFx);
  master.connect(mfx.input);
  mfx.output.connect(limiter).connect(ctx.destination);
  const mixer = new Mixer(ctx, master);
  mixer.setMix(song.mix, song.bpm);
  const tickS = 60 / (song.bpm * M.TICKS_PER_BEAT), at = tick => LEAD + tick * tickS;
  const synths = [];
  for (const ti of tis) {
    const t = song.tracks[ti], fx = new FxChain(ctx);
    fx.tempo = song.bpm;
    fx.set(t.fx);
    fx.output.connect(mixer.strip(ti).input);
    mixer.setTrack(ti, t);
    if (t.inst) {
      const s = new LabSynth(ctx, fx.input);
      s.tempo = song.bpm;
      s.setPatch(t.inst.patch);
      s.out.gain.cancelScheduledValues(0);
      s.out.gain.value = s.patch.volume * M.trackGain(t);
      synths.push({ s, ti });
    } else for (const n of notes[ti]) renderVoice(ctx, fx.input, t.voice, n.note, n.vel, at(n.tick), Math.max(0.02, n.dur * tickS), M.trackGain(t));
  }
  // Ducking at the side-chain source's notes (a drum track's kicks), also in the other tracks' stems
  // (as in the mix), but not when the source is muted (as when playing).
  const src = song.tracks.findIndex(t => t.sidechain);
  if (src >= 0 && heard[src]) {
    const drums = song.tracks[src].mode === 'steps' && M.roleOf(song.tracks[src]) === 'drums';
    for (const n of notes[src]) if (!drums || n.note === 35 || n.note === 36) mixer.duckAt(at(n.tick));
  }
  for (const a of autos) if (tis.includes(a.ti)) mixer.automate(a.ti, a.target, a.v, at(a.tick));
  await Promise.all(synths.map(({ s }) => s.ready()));
  for (const { s, ti } of synths) for (const n of notes[ti]) s.play(n.note, n.vel, at(n.tick), Math.max(0.02, n.dur * tickS));
  const buf = await ctx.startRendering();
  return [buf.getChannelData(0), buf.getChannelData(1)];
}

// The song as audio: { mix: [L, R] | null, stems: [{ ti, name, chans }], missing: [track names],
// sampleRate, seconds }. Muted tracks are left out (solo works as when playing).
export async function renderSongAudio(song, { mix = true, stems = false, sampleRate = 48000, tail = 4, onProgress } = {}) {
  const { tracks, autos } = renderSong(song);
  const notes = tracks.map(t => t.notes);
  const heard = song.tracks.map((_, ti) => M.audible(song, ti));
  const computer = song.tracks.map((t, ti) => ti).filter(ti => heard[ti] && song.tracks[ti].out === M.COMPUTER && notes[ti].length);
  const missing = song.tracks.filter((t, ti) => heard[ti] && t.out !== M.COMPUTER && notes[ti].length).map(t => t.name);
  const seconds = LEAD + M.songTicks(song) * 60 / (song.bpm * M.TICKS_PER_BEAT) + tail;
  const out = { mix: null, stems: [], missing, sampleRate, seconds };
  if (!computer.length) return out;
  if (mix) { onProgress?.('the mix'); out.mix = await renderTracks(song, notes, computer, { seconds, sampleRate, heard, autos }); }
  if (stems) for (const ti of computer) {
    onProgress?.(song.tracks[ti].name);
    out.stems.push({ ti, name: song.tracks[ti].name, chans: await renderTracks(song, notes, [ti], { seconds, sampleRate, heard, autos }) });
  }
  return out;
}

// The length that keeps everything up to the last sound, plus 50 ms.
export function soundLength(chans, sampleRate) {
  let end = 0;
  for (const d of chans) for (let i = d.length - 1; i > end; i--) if (Math.abs(d[i]) > 1e-4) { end = i; break; }
  return Math.min(chans[0].length, end + Math.round(0.05 * sampleRate));
}
// Cuts to `len` frames (stems all get the mix's length, so they line up), fades the last 20 ms and
// scales peaks under 0.99.
export function finish(chans, sampleRate, len = soundLength(chans, sampleRate)) {
  len = Math.min(len, chans[0].length);
  const fade = Math.min(len, Math.round(0.02 * sampleRate));
  const out = chans.map(d => d.slice(0, len));
  let peak = 0;
  for (const d of out) for (const x of d) peak = Math.max(peak, Math.abs(x));
  const k = peak > 0.99 ? 0.99 / peak : 1;
  for (const d of out) { for (let i = 0; i < len; i++) d[i] *= k; for (let i = 0; i < fade; i++) d[len - 1 - i] *= i / fade; }
  return out;
}
