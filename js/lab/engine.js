// Plays Lab patches (see patch.js) with Web Audio. Each note builds its own small graph of nodes
// from the patch's voice modules; the effects (global modules) are built once per instrument.
// Times are AudioContext seconds; atTime() converts from performance.now() milliseconds.
//
//   const synth = new LabSynth(audioContext, destinationNode);
//   synth.setPatch(patch);
//   synth.play(60, 100, synth.atTime(performance.now()), 0.5);   // or noteOn / noteOff
import { MODULES, isSource } from './patch.js';
import { ALIASES } from './drums.js';

const OSC_TYPES = { saw: 'sawtooth', square: 'square', triangle: 'triangle', sine: 'sine' };
const LFO_TYPES = { sine: 'sine', triangle: 'triangle', square: 'square', saw: 'sawtooth' };
const STEP = 128; // samples per step of the random LFO's buffer

// Shared buffers and curves, made once per AudioContext.
const shared = new WeakMap();
function assets(ac) {
  let a = shared.get(ac);
  if (a) return a;
  const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  // Pulse: a sawtooth plus an offset through a hard comparator; the offset sets the width.
  const comparator = new Float32Array(2048);
  for (let i = 0; i < comparator.length; i++) comparator[i] = i < comparator.length / 2 ? -1 : 1;
  // Random (sample & hold) LFO: a looped buffer of random steps, played at the LFO's rate.
  const steps = ac.createBuffer(1, 64 * STEP, ac.sampleRate), sd = steps.getChannelData(0);
  for (let k = 0; k < 64; k++) { const v = Math.random() * 2 - 1; sd.fill(v, k * STEP, (k + 1) * STEP); }
  const cosine = ac.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])); // for orbits
  a = { noise, comparator, steps, cosine, drives: new Map() };
  shared.set(ac, a);
  return a;
}
function driveCurve(ac, amount) {
  const cache = assets(ac).drives, key = Math.round(amount * 100);
  if (!cache.has(key)) {
    const k = 0.5 + key / 100 * 30, c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) { const x = i / (c.length - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    cache.set(key, c);
  }
  return cache.get(key);
}
// A reverb's impulse response, made up rather than recorded. After the pre-delay come a few early
// reflections (rooms and halls: the first echoes off nearby walls), then a dense tail that builds
// up and fades by 60 dB over `size` seconds, its highs dying away faster than its lows (damping).
// Each side gets its own noise, so it's wide. Every type comes out about equally loud.
const REVERBS = {
  room: { er: [[7, 0.7], [11, 0.55], [17, 0.5], [23, 0.4], [31, 0.35], [41, 0.25]], build: 0.01, bright: 9000 },
  hall: { er: [[15, 0.5], [27, 0.45], [38, 0.35], [53, 0.3], [71, 0.22]], build: 0.04, bright: 7000 },
  plate: { er: [], build: 0.002, bright: 13000 },
  ambience: { er: [[5, 0.8], [9, 0.6], [14, 0.5], [19, 0.4], [26, 0.3]], build: 0.004, bright: 8000, maxSize: 0.8 },
};
export function reverbImpulse(sampleRate, { type = 'hall', size = 2.5, predelay = 20, damping = 0.5 } = {}, makeBuffer) {
  const r = REVERBS[type] || REVERBS.hall, decay = Math.min(size, r.maxSize || size);
  const pre = Math.round(sampleRate * predelay / 1000), tail = Math.round(sampleRate * decay * 1.05);
  const len = pre + tail, chans = [new Float32Array(len), new Float32Array(len)];
  const loTo = 300 + (1 - damping) * (r.bright - 300); // where the highs end up by the end of the tail
  chans.forEach((d, ch) => {
    let lp = 0;
    for (let i = 0; i < tail; i++) {
      const t = i / sampleRate, env = 10 ** (-3 * t / decay) * Math.min(1, t / r.build);
      const fc = r.bright * (loTo / r.bright) ** Math.min(1, t / decay), a = Math.exp(-2 * Math.PI * fc / sampleRate);
      lp = (1 - a) * (Math.random() * 2 - 1) + a * lp;
      d[pre + i] = lp * env;
    }
    for (const [ms, g] of r.er) { // a slightly different spot on each side
      const at = pre + Math.round(sampleRate * (ms * (ch ? 1.07 : 0.94)) / 1000);
      if (at < len) d[at] += g * (ch ? -1 : 1) * 0.6;
    }
  });
  // The same energy for every type and size, so changing them doesn't jump in level.
  let e = 0;
  for (const d of chans) for (let i = 0; i < len; i++) e += d[i] * d[i];
  const k = 0.5 / Math.sqrt(e / sampleRate || 1); // about as loud as the old reverb at 2.5 s
  for (const d of chans) for (let i = 0; i < len; i++) d[i] *= k;
  return makeBuffer ? makeBuffer(chans, len) : chans;
}
function impulse(ac, params) {
  return reverbImpulse(ac.sampleRate, params, (chans, len) => {
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    chans.forEach((d, ch) => buf.copyToChannel(d, ch));
    return buf;
  });
}
// One of your recordings (data/audio/), decoded once per context: impulse responses, samples.
const fileIRs = new WeakMap();
export function fileBuffer(ac, file) {
  let m = fileIRs.get(ac);
  if (!m) fileIRs.set(ac, m = new Map());
  if (!m.has(file)) {
    m.set(file, import('../core/storage.js').then(({ storage }) => storage.get('audio', file))
      .then(blob => blob.arrayBuffer()).then(b => ac.decodeAudioData(b)).catch(() => { m.delete(file); return null; }));
  }
  return m.get(file);
}
// Soft saturation for the tape echo's feedback.
let tapeCurve = null;
const tapeSat = () => (tapeCurve ||= Float32Array.from({ length: 1024 }, (_, i) => Math.tanh(1.5 * (i / 1023 * 2 - 1)) / Math.tanh(1.5)));

const hz = (note, octave = 0, semi = 0) => 440 * 2 ** ((note - 69) / 12 + octave + semi / 12);
const rad = d => d * Math.PI / 180;
// Modulation amounts are in the target's units; pulse width is scaled to the comparator offset.
const modScale = key => (key === 'pw' ? 2 : 1);

// Attack-decay-sustain on an AudioParam from t0, up to `peak`.
function envOn(param, t0, p, peak = 1) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(peak, t0 + p.attack);
  param.setTargetAtTime(p.sustain * peak, t0 + p.attack, p.decay / 4);
}
function envOff(param, t, release) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t); else param.cancelScheduledValues(t);
  param.setTargetAtTime(0, t, release / 4);
}

// One drum hit from a kit pad (lab/drums.js): up to two tone layers swept down to their pitch,
// a noise layer (in bursts for claps), a click, then drive, pan and level. `kit` holds the Drum
// kit module's own settings, which apply to every pad (tune, decay, tone, level). Returns how long
// it lasts. Notes without a pad play a short blip at their pitch.
const METAL = [1, 1.483, 1.8, 2.546, 2.63, 3.897]; // the 808's six cymbal oscillators, as ratios
function drumHit(ac, a, note, vel, t0, kit, pads, out, src, keep, samples = new Map()) {
  const v = (vel / 127) ** 1.2, tune = 2 ** (kit.tune / 12), dk = kit.decay, bright = 0.5 + kit.tone;
  const p = pads?.[note] || pads?.[ALIASES[note]];
  let longest = 0;
  // The pad's output: drive → pan → level.
  let into = out;
  if (p) {
    const lvl = keep(ac.createGain()), pan = keep(ac.createStereoPanner());
    lvl.gain.value = p.level;
    pan.pan.value = p.pan;
    pan.connect(lvl).connect(out);
    into = pan;
    if (p.drive > 0) { const sh = keep(ac.createWaveShaper()); sh.curve = driveCurve(ac, p.drive); sh.oversample = '2x'; sh.connect(pan); into = sh; }
  }
  const envelope = (level, decay, delay = 0) => {
    const t = t0 + delay, d = decay * dk, g = keep(ac.createGain());
    g.gain.setValueAtTime(0, t0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * v, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0005, t + d);
    longest = Math.max(longest, delay + d + 0.05);
    g.connect(into);
    return g;
  };
  const toneLayer = (level, wave, pitch, sweep, bend, decay) => {
    if (!(level > 0)) return;
    const g = envelope(level, decay), f = pitch * tune;
    const oscs = wave === 'metal' ? METAL.map(r => r) : [1];
    let dest = g;
    if (wave === 'metal') { const hp = keep(ac.createBiquadFilter()); hp.type = 'highpass'; hp.frequency.value = Math.min(16000, f * 2 * bright); hp.connect(g); dest = hp; }
    for (const r of oscs) {
      const o = src(ac.createOscillator());
      o.type = wave === 'metal' ? 'square' : wave === 'saw' ? 'sawtooth' : wave;
      o.frequency.setValueAtTime(f * r * 2 ** (sweep / 12), t0);
      if (sweep > 0) o.frequency.exponentialRampToValueAtTime(f * r, t0 + bend * dk);
      const k = keep(ac.createGain());
      k.gain.value = 1 / oscs.length ** 0.5;
      o.connect(k).connect(dest);
    }
  };
  const noiseLayer = (level, type, freq, q, decay, delay = 0) => {
    const g = envelope(level, decay, delay), n = src(ac.createBufferSource()), fl = keep(ac.createBiquadFilter());
    n.buffer = a.noise;
    n.loop = true;
    n.loopStart = Math.random();
    fl.type = type;
    fl.frequency.value = Math.min(18000, freq * (type === 'lowpass' ? 1 : bright));
    fl.Q.value = q;
    n.connect(fl).connect(g);
  };
  if (!p) { toneLayer(0.6, 'triangle', hz(note) / tune, 0, 0.01, 0.15); return longest; }
  toneLayer(p.t1Level, p.t1Wave, p.t1Pitch, p.t1Sweep, p.t1Bend, p.t1Decay);
  toneLayer(p.t2Level, p.t2Wave, p.t2Pitch, p.t2Sweep, p.t2Bend, p.t2Decay);
  if (p.nLevel > 0) {
    // Bursts: quick short ones about 11 ms apart, the last with the full decay.
    for (let k = 0; k < p.nBursts; k++) {
      const last = k === p.nBursts - 1;
      noiseLayer(p.nLevel * (last && p.nBursts > 1 ? 0.75 : 1), p.nFilter, p.nFreq, p.nQ, last ? p.nDecay : 0.03, k * 0.011);
    }
  }
  if (p.click > 0) noiseLayer(p.click * bright, 'bandpass', 2500, 0.8, 0.015);
  // The sample: at its own pitch (plus the pad's and the kit's tuning), faded over its decay.
  const buf = p.sFile && p.sLevel > 0 && samples.get(p.sFile);
  if (buf) {
    const s = src(ac.createBufferSource()), rate = 2 ** (p.sTune / 12) * tune, from = Math.min(p.sStart, 0.999) * buf.duration;
    s.buffer = buf;
    s.playbackRate.value = rate;
    const natural = (buf.duration - from) / rate, d = Math.min(natural, p.sDecay * dk), g = keep(ac.createGain());
    g.gain.setValueAtTime(p.sLevel * v, t0);
    if (d < natural) g.gain.exponentialRampToValueAtTime(0.0005, t0 + d);
    s._start = [from];
    s.connect(g).connect(into);
    longest = Math.max(longest, d + 0.05);
  }
  return longest;
}

export class LabSynth {
  constructor(ac, destination = ac.destination) {
    this.ac = ac;
    this.out = ac.createGain();
    this.out.connect(destination);
    this.bus = ac.createGain(); // where voices and effects meet before the volume
    this.bus.connect(this.out);
    this.wheel = ac.createConstantSource();
    this.wheel.offset.value = 0;
    this.wheel.start();
    // Pitch bend, -1 to 1, scaled to cents for every oscillator.
    this.bend = ac.createConstantSource();
    this.bend.offset.value = 0;
    this.bendCents = ac.createGain();
    this.bendCents.gain.value = 200; // ± 2 semitones
    this.bend.connect(this.bendCents);
    this.bend.start();
    this.voices = [];
    this.globals = new Map();
    this.gain = 1;
    this.patch = null;
    this.scopes = null; // module id (or 'out') -> AnalyserNode, once enableScopes() is called
    this.samples = new Map(); // file -> AudioBuffer: the recordings the patch's samplers and pads use
    this.onSample = null; // called with a file name when it has loaded
  }

  // Loads every recording the patch uses, so notes can start them at once (a note played before
  // its sample has loaded is silent).
  loadSamples() {
    const files = new Set();
    for (const m of this.patch?.modules || []) {
      if ((m.type === 'sampler' || m.type === 'granular') && m.params.file) files.add(m.params.file);
      for (const p of Object.values(m.pads || {})) if (p.sFile) files.add(p.sFile);
    }
    for (const f of files) if (!this.samples.has(f)) {
      fileBuffer(this.ac, f).then(b => { if (b) { this.samples.set(f, b); this.onSample?.(f); } });
    }
  }

  // Taps for drawing waveforms: every audio module's output (all its notes summed) and the
  // instrument's output each feed an AnalyserNode. Off unless asked for (only the Lab page draws).
  enableScopes() {
    if (this.scopes) return;
    this.scopes = new Map();
    this.out.connect(this.scope('out'));
    if (this.patch) this.buildGlobals();
  }
  scope(id) {
    let a = this.scopes.get(id);
    if (!a) {
      a = this.ac.createAnalyser();
      a.fftSize = 8192;
      a.smoothingTimeConstant = id === 'out' ? 0.6 : 0;
      this.scopes.set(id, a);
    }
    return a;
  }
  // Is a note held right now (keys down, or sustained)?
  holding() { return this.voices.some(v => !v.released); }

  atTime(ms) { return Math.max(this.ac.currentTime, this.ac.currentTime + (ms - performance.now()) / 1000); }

  // A new patch: settings-only changes update sounding notes; new modules or connections rebuild
  // the effects and cut sounding notes short.
  setPatch(input) {
    const patch = JSON.parse(JSON.stringify(input)); // our own copy; change it with setParam / setMod
    // Settings marked `rebuild` (an oscillator's wave, a filter's slope...) change which nodes a note uses.
    const shape = p => JSON.stringify([p.modules.map(m => [m.id, m.type, !!m.off, ...MODULES[m.type].params.filter(x => x.rebuild).map(x => m.params[x.key])]), p.audio, p.mod.map(m => [m.from, m.to])]);
    const old = this.patch;
    this.patch = patch;
    this.loadSamples();
    if (old && shape(old) === shape(patch)) {
      for (const m of patch.modules) for (const [k, v] of Object.entries(m.params)) if (old.modules.find(x => x.id === m.id)?.params[k] !== v) this.applyParam(m.id, k, v);
      patch.mod.forEach((c, i) => { if (old.mod[i]?.amount !== c.amount) this.applyMod(c); });
      this.setVolume();
      return;
    }
    this.allOff(true);
    this.buildGlobals();
    this.setVolume();
  }

  setGain(g) { this.gain = g; this.setVolume(); }
  setVolume() { if (this.patch) this.out.gain.setTargetAtTime(this.patch.volume * this.gain, this.ac.currentTime, 0.02); }
  setWheel(v) { this.wheel.offset.setTargetAtTime(v, this.ac.currentTime, 0.01); }
  setBend(v) { this.bend.offset.setTargetAtTime(v, this.ac.currentTime, 0.005); }

  // One setting of one module, or one modulation amount, while notes sound.
  setParam(id, key, value) {
    const m = this.patch?.modules.find(x => x.id === id);
    if (!m) return;
    m.params[key] = value;
    this.applyParam(id, key, value);
  }
  setMod(index, amount) {
    const c = this.patch?.mod[index];
    if (!c) return;
    c.amount = amount;
    this.applyMod(c);
  }
  applyParam(id, key, value) {
    for (const v of this.voices) v.set[`${id}.${key}`]?.(value);
    this.globals.get(id)?.set[key]?.(value);
  }
  applyMod(c) { for (const v of this.voices) v.set[`mod:${c.from}>${c.to}`]?.(c.amount); }

  // ---- effects ----
  buildGlobals() {
    for (const g of this.globals.values()) g.nodes.forEach(n => { try { n.stop?.(); } catch { /* not started */ } n.disconnect(); });
    this.globals.clear();
    const ac = this.ac, t = ac.currentTime;
    for (const m of this.patch.modules) {
      if (MODULES[m.type].scope !== 'global') continue;
      const p = m.params, input = ac.createGain(), output = ac.createGain(), dry = ac.createGain(), wet = ac.createGain();
      if (m.off) { // bypassed: straight through
        input.connect(output);
        this.globals.set(m.id, { input, output, nodes: [input, output], set: {} });
        continue;
      }
      input.connect(dry).connect(output);
      wet.connect(output);
      const g = { input, output, nodes: [input, output, dry, wet], set: {} };
      const now = () => this.patch.modules.find(x => x.id === m.id)?.params || m.params; // its settings as they are now
      const mix = (wetAmount, dryAmount = 1 - wetAmount) => { wet.gain.setTargetAtTime(wetAmount, ac.currentTime, 0.02); dry.gain.setTargetAtTime(dryAmount, ac.currentTime, 0.02); };
      if (m.type === 'chorus') {
        const lfo = ac.createOscillator(), depth = ac.createGain();
        lfo.frequency.value = p.rate;
        depth.gain.value = p.depth * 0.004;
        lfo.connect(depth);
        for (const [base, pan] of [[0.012, -0.7], [0.019, 0.7]]) {
          const d = ac.createDelay(0.1), panner = ac.createStereoPanner(), inv = ac.createGain();
          d.delayTime.value = base;
          panner.pan.value = pan;
          inv.gain.value = pan < 0 ? 1 : -1; // the two sides move opposite ways
          depth.connect(inv).connect(d.delayTime);
          input.connect(d).connect(panner).connect(wet);
          g.nodes.push(d, panner, inv);
        }
        lfo.start(t);
        g.nodes.push(lfo, depth);
        g.set = { rate: v => lfo.frequency.setTargetAtTime(v, ac.currentTime, 0.05), depth: v => depth.gain.setTargetAtTime(v * 0.004, ac.currentTime, 0.05), mix: v => mix(v, 1 - v * 0.5) };
        mix(p.mix, 1 - p.mix * 0.5);
      } else if (m.type === 'delay') {
        // Normal: one echo line. Ping-pong: two, crossing, one each side. Tape: one with a
        // wobbling time and a little saturation in the loop.
        const line = pan => {
          const d = ac.createDelay(2.5), tone = ac.createBiquadFilter(), fb = ac.createGain();
          d.delayTime.value = p.time;
          tone.type = 'lowpass';
          tone.frequency.value = p.tone;
          fb.gain.value = p.feedback;
          d.connect(tone).connect(fb);
          if (pan === null) tone.connect(wet);
          else { const pn = ac.createStereoPanner(); pn.pan.value = pan; tone.connect(pn).connect(wet); g.nodes.push(pn); }
          g.nodes.push(d, tone, fb);
          return { d, tone, fb };
        };
        const lines = p.mode === 'ping-pong' ? [line(-0.85), line(0.85)] : [line(null)];
        input.connect(lines[0].d);
        if (lines.length === 2) { lines[0].fb.connect(lines[1].d); lines[1].fb.connect(lines[0].d); }
        else if (p.mode === 'tape') {
          const sat = ac.createWaveShaper(), slow = ac.createOscillator(), fast = ac.createOscillator(), wob = ac.createGain();
          sat.curve = tapeSat();
          lines[0].fb.connect(sat).connect(lines[0].d);
          slow.frequency.value = 0.6; fast.frequency.value = 3.1;
          wob.gain.value = p.wobble * 0.004;
          slow.connect(wob); fast.connect(wob);
          wob.connect(lines[0].d.delayTime);
          slow.start(t); fast.start(t);
          g.nodes.push(sat, slow, fast, wob);
          g.set.wobble = v => wob.gain.setTargetAtTime(v * 0.004, ac.currentTime, 0.05);
        } else lines[0].fb.connect(lines[0].d);
        Object.assign(g.set, {
          time: v => lines.forEach(l => l.d.delayTime.setTargetAtTime(v, ac.currentTime, 0.05)),
          feedback: v => lines.forEach(l => l.fb.gain.setTargetAtTime(v, ac.currentTime, 0.02)),
          tone: v => lines.forEach(l => l.tone.frequency.setTargetAtTime(v, ac.currentTime, 0.02)),
          mix: v => mix(v, 1),
        });
        mix(p.mix, 1);
      } else if (m.type === 'reverb') {
        const conv = ac.createConvolver();
        // The response is remade (or the file loaded) a moment after its settings stop changing.
        let timer = null, made = 0;
        const remake = () => {
          const q = now(), n = ++made;
          if (q.type === 'file' && q.file) {
            fileBuffer(ac, q.file).then(buf => {
              if (n !== made) return;
              if (!buf) { conv.buffer = impulse(ac, { ...q, type: 'hall' }); return; }
              // The pre-delay goes in front of the file's own response.
              const pre = Math.round(ac.sampleRate * q.predelay / 1000), b = ac.createBuffer(2, buf.length + pre, ac.sampleRate);
              // Levelled like the made-up ones, so a loud recording doesn't jump out.
              let e = 0;
              for (let ch = 0; ch < buf.numberOfChannels; ch++) for (const x of buf.getChannelData(ch)) e += x * x;
              const k = 0.5 / Math.sqrt((e * 2 / buf.numberOfChannels) / ac.sampleRate || 1);
              for (let ch = 0; ch < 2; ch++) b.copyToChannel(buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1)).map(x => x * k), ch, pre);
              conv.buffer = b;
            });
          } else conv.buffer = impulse(ac, q.type === 'file' ? { ...q, type: 'hall' } : q);
        };
        remake();
        input.connect(conv).connect(wet);
        g.nodes.push(conv);
        const later = () => { clearTimeout(timer); timer = setTimeout(remake, 150); };
        g.set = { type: later, file: later, size: later, predelay: later, damping: later, mix: v => mix(v, 1 - v * 0.4) };
        mix(p.mix, 1 - p.mix * 0.4);
      } else if (m.type === 'phaser') {
        // Four all-pass filters swept together by an LFO; mixed with the dry sound they cut moving notches.
        const lfo = ac.createOscillator(), depth = ac.createGain(), fb = ac.createGain(), aps = [];
        for (let k = 0; k < 4; k++) { const f = ac.createBiquadFilter(); f.type = 'allpass'; f.frequency.value = 700; f.Q.value = 0.6; aps.push(f); }
        aps.reduce((a, b) => a.connect(b));
        input.connect(aps[0]);
        aps[3].connect(wet);
        aps[3].connect(fb).connect(aps[0]);
        fb.gain.value = p.feedback;
        lfo.frequency.value = p.rate;
        depth.gain.value = p.depth * 2400; // cents: up to ±2 octaves
        lfo.connect(depth);
        aps.forEach(f => depth.connect(f.detune));
        lfo.start(t);
        g.nodes.push(lfo, depth, fb, ...aps);
        g.set = { rate: v => lfo.frequency.setTargetAtTime(v, ac.currentTime, 0.05), depth: v => depth.gain.setTargetAtTime(v * 2400, ac.currentTime, 0.05),
          feedback: v => fb.gain.setTargetAtTime(v, ac.currentTime, 0.02), mix: v => mix(v, 1) };
        mix(p.mix, 1);
      } else if (m.type === 'flanger') {
        const d = ac.createDelay(0.05), lfo = ac.createOscillator(), depth = ac.createGain(), fb = ac.createGain();
        d.delayTime.value = 0.004;
        lfo.frequency.value = p.rate;
        depth.gain.value = p.depth * 0.0035;
        lfo.connect(depth).connect(d.delayTime);
        fb.gain.value = p.feedback;
        input.connect(d).connect(wet);
        d.connect(fb).connect(d);
        lfo.start(t);
        g.nodes.push(d, lfo, depth, fb);
        g.set = { rate: v => lfo.frequency.setTargetAtTime(v, ac.currentTime, 0.05), depth: v => depth.gain.setTargetAtTime(v * 0.0035, ac.currentTime, 0.05),
          feedback: v => fb.gain.setTargetAtTime(v, ac.currentTime, 0.02), mix: v => mix(v, 1) };
        mix(p.mix, 1);
      } else if (m.type === 'tremolo') {
        // The depth is shared between volume (pan 0) and left-right movement (pan 1).
        const vca = ac.createGain(), pn = ac.createStereoPanner(), lfo = ac.createOscillator(), vol = ac.createGain(), side = ac.createGain();
        const apply = () => {
          const q = now(), at = ac.currentTime;
          vca.gain.setTargetAtTime(1 - q.depth * (1 - q.pan) * 0.5, at, 0.02);
          vol.gain.setTargetAtTime(q.depth * (1 - q.pan) * 0.5, at, 0.02);
          side.gain.setTargetAtTime(q.depth * q.pan, at, 0.02);
        };
        lfo.frequency.value = p.rate;
        lfo.connect(vol).connect(vca.gain);
        lfo.connect(side).connect(pn.pan);
        input.connect(vca).connect(pn).connect(wet);
        lfo.start(t);
        apply();
        g.nodes.push(vca, pn, lfo, vol, side);
        g.set = { rate: v => lfo.frequency.setTargetAtTime(v, ac.currentTime, 0.05), depth: apply, pan: apply };
        mix(1, 0);
      } else if (m.type === 'eq') {
        const lo = ac.createBiquadFilter(), mid = ac.createBiquadFilter(), hi = ac.createBiquadFilter();
        lo.type = 'lowshelf'; lo.frequency.value = 120; lo.gain.value = p.low;
        mid.type = 'peaking'; mid.frequency.value = p.midfreq; mid.Q.value = 0.9; mid.gain.value = p.mid;
        hi.type = 'highshelf'; hi.frequency.value = 8000; hi.gain.value = p.high;
        input.connect(lo).connect(mid).connect(hi).connect(wet);
        g.nodes.push(lo, mid, hi);
        const to = (param, v) => param.setTargetAtTime(v, ac.currentTime, 0.02);
        g.set = { low: v => to(lo.gain, v), mid: v => to(mid.gain, v), midfreq: v => to(mid.frequency, v), high: v => to(hi.gain, v) };
        mix(1, 0);
      } else if (m.type === 'compressor') {
        const c = ac.createDynamicsCompressor(), make = ac.createGain();
        c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.attack.value = p.attack; c.release.value = p.release; c.knee.value = 6;
        make.gain.value = 10 ** (p.gain / 20);
        input.connect(c).connect(make).connect(wet);
        g.nodes.push(c, make);
        const to = (param, v) => param.setTargetAtTime(v, ac.currentTime, 0.02);
        g.set = { threshold: v => to(c.threshold, v), ratio: v => to(c.ratio, v), attack: v => to(c.attack, v), release: v => to(c.release, v),
          gain: v => to(make.gain, 10 ** (v / 20)) };
        mix(1, 0);
      }
      this.globals.set(m.id, g);
    }
    if (this.scopes) for (const [id, g] of this.globals) g.output.connect(this.scope(id));
    for (const c of this.patch.audio) {
      const from = this.globals.get(c.from);
      if (!from) continue;
      from.output.connect(c.to === 'out' ? this.bus : this.globals.get(c.to).input);
    }
  }

  // ---- notes ----
  noteOn(note, vel, t0 = this.ac.currentTime) {
    if (!this.patch) return null;
    for (const v of this.voices) if (v.note === note && !v.released) this.release(v, t0);
    const live = this.voices.filter(v => v.end > t0);
    if (live.length >= this.patch.voices) this.kill(live.find(v => v.released) || live[0], t0);
    const v = this.buildVoice(note, vel, t0);
    // Drum pads in a choke group cut each other off (an open hat stops when the closed one plays).
    if (v.choke) for (const o of this.voices) if (o.choke === v.choke && o.end > t0) this.kill(o, t0);
    this.voices.push(v);
    this.voices = this.voices.filter(x => x.end === Infinity || x.end > this.ac.currentTime - 0.1);
    return v;
  }
  noteOff(note, t = this.ac.currentTime) {
    for (const v of this.voices) if (v.note === note && !v.released) this.release(v, t);
  }
  play(note, vel, t0, dur) { const v = this.noteOn(note, vel, t0); if (v) this.release(v, t0 + dur); }

  // Fast fade on everything (Stop, or a rebuild).
  allOff(now = false) {
    const t = this.ac.currentTime;
    for (const v of this.voices) if (now || !v.released) this.kill(v, t);
  }

  // Quiet at once, echoes and reverb tails included: a quick fade, then fresh effects.
  silence() {
    this.allOff(true);
    if (!this.patch) return;
    const g = this.bus.gain, t = this.ac.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, 0.01);
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.buildGlobals();
      g.cancelScheduledValues(this.ac.currentTime);
      g.setValueAtTime(1, this.ac.currentTime);
    }, 80);
  }

  release(v, t) {
    if (v.released) return;
    v.released = true;
    for (const f of v.offs) f(t);
    v.stopAt(t + v.tail);
  }
  kill(v, t) {
    v.released = true;
    for (const e of v.exits) { e.gain.cancelScheduledValues(t); e.gain.setTargetAtTime(0, t, 0.006); }
    v.stopAt(t + 0.05);
  }

  buildVoice(note, vel, t0) {
    const ac = this.ac, patch = this.patch, a = assets(ac);
    const nodes = {}, sources = [], all = [], offs = [], set = {}, exits = [];
    const keep = n => { all.push(n); return n; };
    const src = n => { sources.push(n); return keep(n); };
    let tail = 0.02, gated = false, minEnd = 0, choke = 0;
    const stops = []; // called with the voice's end time (granular voices stop making grains) // gated: something shapes the note's end (an Amp, an FM operator...)
    for (const m of patch.modules) {
      const p = m.params;
      if (MODULES[m.type].scope !== 'voice') continue;
      if (m.off) {
        // Bypassed: a shaper (filter, drive, amp, ring, space) passes the sound straight through;
        // a source or a modulator is simply left out, so whatever it fed gets nothing from it.
        if (!isSource(m.type) && MODULES[m.type].audioIn && MODULES[m.type].audioOut) {
          const g = keep(ac.createGain());
          nodes[m.id] = { in: g, out: g, targets: {} };
        }
        continue;
      }
      if (m.type === 'osc') {
        const out = keep(ac.createGain());
        out.gain.value = p.level;
        const osc = src(ac.createOscillator());
        osc.frequency.value = hz(note, p.octave, p.semi);
        osc.detune.value = p.fine;
        this.bendCents.connect(osc.detune);
        const targets = { pitch: [osc.detune], level: [out.gain] };
        if (p.wave === 'pulse') {
          osc.type = 'sawtooth';
          const shaper = keep(ac.createWaveShaper()), offset = src(ac.createConstantSource());
          shaper.curve = a.comparator;
          shaper.oversample = '4x';
          offset.offset.value = 2 * p.pw - 1;
          osc.connect(shaper);
          offset.connect(shaper);
          shaper.connect(out);
          targets.pw = [offset.offset];
          set[`${m.id}.pw`] = v => offset.offset.setTargetAtTime(2 * v - 1, ac.currentTime, 0.01);
        } else {
          osc.type = OSC_TYPES[p.wave];
          osc.connect(out);
          targets.pw = [];
        }
        const retune = () => osc.frequency.setTargetAtTime(hz(note, m.params.octave, m.params.semi), ac.currentTime, 0.005);
        Object.assign(set, { [`${m.id}.octave`]: retune, [`${m.id}.semi`]: retune,
          [`${m.id}.fine`]: v => osc.detune.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.level`]: v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01) });
        nodes[m.id] = { out, targets };
      } else if (m.type === 'sampler') {
        // A recording at the note's pitch relative to the root, trimmed, looped or one-shot.
        const buf = this.samples.get(p.file), out = keep(ac.createGain());
        out.gain.value = p.level;
        if (buf) {
          const s = src(ac.createBufferSource()), dur = buf.duration;
          s.buffer = buf;
          s.playbackRate.value = 2 ** ((note - p.root + p.tune) / 12);
          s.detune.value = p.fine;
          this.bendCents.connect(s.detune);
          const from = Math.min(p.start, 0.999) * dur;
          if (p.mode === 'loop') {
            s.loop = true;
            s.loopStart = Math.min(p.loopStart, p.loopEnd - 0.001) * dur;
            s.loopEnd = Math.max(p.loopEnd, p.loopStart + 0.001) * dur;
            s._start = [from];
          } else {
            const len = Math.max(0.005, (Math.max(p.end, p.start + 0.001) - p.start) * dur);
            s._start = [from, len];
            if (p.mode === 'one-shot') { gated = true; minEnd = Math.max(minEnd, t0 + len / s.playbackRate.value); }
          }
          s.connect(out);
          set[`${m.id}.fine`] = v => s.detune.setTargetAtTime(v, ac.currentTime, 0.01);
          nodes[m.id] = { out, targets: { pitch: [s.detune], level: [out.gain] } };
        } else nodes[m.id] = { out, targets: { pitch: [], level: [out.gain] } };
        set[`${m.id}.level`] = v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01);
      } else if (m.type === 'granular') {
        // Grains: short windows of the recording, each with its own place, pitch and pan, made a
        // little ahead of time by a timer (all at once, for a few seconds, when rendering offline).
        // They read the module's settings as they are now, so moving a slider changes the cloud.
        const out = keep(ac.createGain()), buf = this.samples.get(p.file);
        out.gain.value = p.level;
        src(ac.createConstantSource()); // the voice's lifetime: grains come and go by themselves
        if (buf) {
          const now = () => this.patch.modules.find(x => x.id === m.id)?.params || p;
          const offline = typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext;
          let next = t0, until = Infinity;
          const grain = t => {
            const c = now(), dur = buf.duration, size = c.size;
            const rate = 2 ** ((note - c.root + c.tune) / 12 + (Math.random() * 2 - 1) * c.jitter / 1200);
            let pos = c.position + c.scan * (t - t0) / dur + (Math.random() - 0.5) * c.spread;
            pos = ((pos % 1) + 1) % 1;
            const offset = Math.min(pos * dur, Math.max(0, dur - size * rate));
            const s = ac.createBufferSource(), g = ac.createGain(), pn = ac.createStereoPanner();
            s.buffer = buf;
            s.playbackRate.value = rate;
            const amp = Math.min(1, 1 / Math.sqrt(Math.max(1, c.density * size)));
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(amp, t + size / 2);
            g.gain.linearRampToValueAtTime(0, t + size);
            pn.pan.value = (Math.random() * 2 - 1) * c.width;
            s.connect(g).connect(pn).connect(out);
            s.onended = () => { s.disconnect(); g.disconnect(); pn.disconnect(); };
            s.start(t, offset, size * rate);
          };
          const pump = () => {
            const horizon = offline ? t0 + 4 : ac.currentTime + 0.12;
            while (next < horizon && next < until) { grain(next); next += (1 / now().density) * (0.7 + Math.random() * 0.6); }
          };
          pump();
          if (!offline) {
            const timer = setInterval(pump, 30);
            stops.push(t => { until = t; setTimeout(() => clearInterval(timer), Math.max(0, (t - ac.currentTime) * 1000) + 60); });
          } else stops.push(t => { until = t; });
        }
        nodes[m.id] = { out, targets: { level: [out.gain] } };
        set[`${m.id}.level`] = v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01);
      } else if (m.type === 'noise') {
        const n = src(ac.createBufferSource()), out = keep(ac.createGain());
        n.buffer = a.noise;
        n.loop = true;
        n.loopStart = Math.random();
        out.gain.value = p.level;
        n.connect(out);
        set[`${m.id}.level`] = v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01);
        nodes[m.id] = { out, targets: { level: [out.gain] } };
      } else if (m.type === 'filter') {
        const f1 = keep(ac.createBiquadFilter()), f2 = p.slope === '24' ? keep(ac.createBiquadFilter()) : null;
        const fs = f2 ? [f1, f2] : [f1];
        const cutoff = () => Math.min(ac.sampleRate * 0.45, Math.max(20, m.params.cutoff * 2 ** ((note - 60) / 12 * m.params.keytrack)));
        for (const f of fs) { f.type = p.type; f.frequency.value = cutoff(); f.Q.value = 0.707; }
        f1.Q.value = p.resonance;
        if (f2) f1.connect(f2);
        Object.assign(set, {
          [`${m.id}.cutoff`]: () => fs.forEach(f => f.frequency.setTargetAtTime(cutoff(), ac.currentTime, 0.01)),
          [`${m.id}.keytrack`]: () => fs.forEach(f => f.frequency.setTargetAtTime(cutoff(), ac.currentTime, 0.01)),
          [`${m.id}.resonance`]: v => f1.Q.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.type`]: v => fs.forEach(f => { f.type = v; }),
        });
        nodes[m.id] = { in: f1, out: f2 || f1, targets: { cutoff: fs.map(f => f.detune), resonance: [f1.Q] } };
      } else if (m.type === 'drive') {
        const sh = keep(ac.createWaveShaper());
        sh.curve = driveCurve(ac, p.amount);
        sh.oversample = '2x';
        set[`${m.id}.amount`] = v => { sh.curve = driveCurve(ac, v); };
        nodes[m.id] = { in: sh, out: sh, targets: {} };
      } else if (m.type === 'amp') {
        gated = true;
        const env = keep(ac.createGain()), level = keep(ac.createGain());
        level.gain.value = p.level;
        env.connect(level);
        envOn(env.gain, t0, p, 1 - p.velocity + p.velocity * (vel / 127) ** 1.5);
        offs.push(t => envOff(env.gain, t, m.params.release));
        tail = Math.max(tail, p.release * 1.6);
        set[`${m.id}.level`] = v => level.gain.setTargetAtTime(v, ac.currentTime, 0.01);
        nodes[m.id] = { in: env, out: level, targets: { level: [level.gain] } };
      } else if (m.type === 'env') {
        const c = src(ac.createConstantSource());
        envOn(c.offset, t0, p);
        offs.push(t => envOff(c.offset, t, m.params.release));
        nodes[m.id] = { out: c, targets: {} };
      } else if (m.type === 'lfo') {
        const depth = keep(ac.createGain()), fade = keep(ac.createGain());
        let osc, rate, perHz = 1;
        if (p.wave === 'random') {
          // Stepped random: the step buffer played so that `rate` steps go by each second.
          osc = src(ac.createBufferSource());
          osc.buffer = a.steps;
          osc.loop = true;
          perHz = STEP / ac.sampleRate;
          osc.playbackRate.value = p.rate * perHz;
          rate = osc.playbackRate;
        } else {
          osc = src(ac.createOscillator());
          osc.type = LFO_TYPES[p.wave];
          osc.frequency.value = p.rate;
          rate = osc.frequency;
        }
        depth.gain.value = p.depth;
        fade.gain.setValueAtTime(p.delay > 0 ? 0 : 1, t0);
        if (p.delay > 0) fade.gain.linearRampToValueAtTime(1, t0 + p.delay);
        osc.connect(depth).connect(fade);
        Object.assign(set, { [`${m.id}.rate`]: v => rate.setTargetAtTime(v * perHz, ac.currentTime, 0.02),
          [`${m.id}.depth`]: v => depth.gain.setTargetAtTime(v, ac.currentTime, 0.02) });
        nodes[m.id] = { out: fade, targets: { rate: [rate], depth: [depth.gain] }, scales: { rate: perHz } };
      } else if (m.type === 'fmop') {
        // A sine at ratio × the note's pitch with its own envelope. Audio arriving at its input
        // moves its frequency: deviation = input × fm depth × its frequency (so depth ≈ FM index).
        gated = true;
        const f = () => hz(note) * m.params.ratio;
        const osc = src(ac.createOscillator()), fmIn = keep(ac.createGain()), env = keep(ac.createGain()), level = keep(ac.createGain());
        osc.type = 'sine';
        osc.frequency.value = f();
        osc.detune.value = p.fine;
        this.bendCents.connect(osc.detune);
        fmIn.gain.value = p.fm * f();
        fmIn.connect(osc.frequency);
        level.gain.value = p.level;
        osc.connect(env).connect(level);
        envOn(env.gain, t0, p, 1 - p.velocity + p.velocity * (vel / 127) ** 1.5);
        offs.push(t => envOff(env.gain, t, m.params.release));
        tail = Math.max(tail, p.release * 1.6);
        const retune = () => { osc.frequency.setTargetAtTime(f(), ac.currentTime, 0.005); fmIn.gain.setTargetAtTime(m.params.fm * f(), ac.currentTime, 0.01); };
        Object.assign(set, { [`${m.id}.ratio`]: retune, [`${m.id}.fm`]: retune,
          [`${m.id}.fine`]: v => osc.detune.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.level`]: v => level.gain.setTargetAtTime(v, ac.currentTime, 0.01) });
        nodes[m.id] = { in: fmIn, out: level, targets: { pitch: [osc.detune], level: [level.gain], fm: [fmIn.gain] }, scales: { fm: f() } };
      } else if (m.type === 'ring') {
        // The input multiplied by a sine at ratio × the note's pitch, mixed with the dry input.
        const input = keep(ac.createGain()), vca = keep(ac.createGain()), dry = keep(ac.createGain()), wet = keep(ac.createGain()), out = keep(ac.createGain());
        const car = src(ac.createOscillator());
        car.frequency.value = hz(note) * p.ratio;
        car.detune.value = p.fine;
        vca.gain.value = 0;
        car.connect(vca.gain);
        input.connect(vca).connect(wet).connect(out);
        input.connect(dry).connect(out);
        wet.gain.value = p.mix;
        dry.gain.value = 1 - p.mix;
        Object.assign(set, { [`${m.id}.ratio`]: v => car.frequency.setTargetAtTime(hz(note) * v, ac.currentTime, 0.01),
          [`${m.id}.fine`]: v => car.detune.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.mix`]: v => { wet.gain.setTargetAtTime(v, ac.currentTime, 0.01); dry.gain.setTargetAtTime(1 - v, ac.currentTime, 0.01); } });
        nodes[m.id] = { in: input, out, targets: { mix: [wet.gain] } };
      } else if (m.type === 'drums') {
        // One-shot drums on the General MIDI notes; a note-off doesn't cut them.
        gated = true;
        const out = keep(ac.createGain());
        out.gain.value = p.level;
        const len = drumHit(ac, a, note, vel, t0, p, m.pads, out, src, keep, this.samples);
        choke = (m.pads?.[note] || m.pads?.[ALIASES[note]])?.choke || 0;
        minEnd = Math.max(minEnd, t0 + len);
        nodes[m.id] = { out, targets: {} };
      } else if (m.type === 'space') {
        // Binaural (HRTF) placement on headphones. Spread scatters notes at random around the
        // listener; orbit circles them around the head.
        const pan = keep(ac.createPanner());
        pan.panningModel = 'HRTF';
        pan.distanceModel = 'inverse';
        pan.refDistance = 1;
        const az = rad(p.azimuth + (Math.random() * 2 - 1) * p.spread), el = rad(p.elevation), d = p.distance;
        pan.positionX.value = Math.sin(az) * Math.cos(el) * d;
        pan.positionY.value = Math.sin(el) * d;
        pan.positionZ.value = -Math.cos(az) * Math.cos(el) * d;
        if (p.orbit > 0) {
          const r = Math.cos(el) * d, orbiters = [];
          set[`${m.id}.orbit`] = v => orbiters.forEach(o => o.frequency.setTargetAtTime(Math.max(0.001, v), ac.currentTime, 0.05));
          for (const [param, wave, sign] of [[pan.positionX, 'sine', 1], [pan.positionZ, 'cosine', -1]]) {
            const o = src(ac.createOscillator()), g = keep(ac.createGain());
            if (wave === 'sine') o.type = 'sine'; else o.setPeriodicWave(a.cosine);
            o.frequency.value = p.orbit;
            g.gain.value = r * sign;
            param.value = 0;
            o.connect(g).connect(param);
            orbiters.push(o);
          }
        }
        nodes[m.id] = { in: pan, out: pan, targets: { x: [pan.positionX] } };
      }
    }
    // Velocity as a modulation source (0-1), only if used.
    if (patch.mod.some(c => c.from === 'vel')) {
      const c = src(ac.createConstantSource());
      c.offset.value = vel / 127;
      nodes.vel = { out: c };
    }
    nodes.wheel = { out: this.wheel };

    if (this.scopes) {
      for (const m of patch.modules) if (MODULES[m.type].audioOut && nodes[m.id]) nodes[m.id].out.connect(this.scope(m.id));
    }
    for (const c of patch.audio) {
      const from = nodes[c.from];
      if (!from) continue; // a global module: wired in buildGlobals
      if (c.to !== 'out' && nodes[c.to]) { from.out.connect(nodes[c.to].in); continue; }
      const dest = c.to === 'out' ? this.bus : this.globals.get(c.to)?.input;
      if (!dest) continue;
      const exit = keep(ac.createGain()); // lets a note be cut short without a click
      from.out.connect(exit).connect(dest);
      exits.push(exit);
    }
    for (const c of patch.mod) {
      const [tid, key] = c.to.split('.'), from = nodes[c.from], params = nodes[tid]?.targets[key];
      if (!from || !params?.length) continue;
      const g = keep(ac.createGain()), k = modScale(key) * (nodes[tid].scales?.[key] ?? 1);
      g.gain.value = c.amount * k;
      from.out.connect(g);
      params.forEach(pm => g.connect(pm));
      set[`mod:${c.from}>${c.to}`] = v => g.gain.setTargetAtTime(v * k, ac.currentTime, 0.01);
    }
    // Without an Amp module, a note simply stops when released (with a tiny fade).
    if (!gated) offs.push(t => exits.forEach(e => { e.gain.cancelScheduledValues(t); e.gain.setTargetAtTime(0, t, 0.008); }));
    for (const s of sources) s.start(t0, ...(s._start || [])); // samples start at their trim point
    const v = { note, released: false, offs, exits, set, tail, end: Infinity, choke };
    v.stopAt = t => {
      t = Math.max(t, minEnd); // one-shots (drums) play to their end
      v.end = t;
      for (const f of stops) f(t);
      for (const s of sources) { try { s.stop(t); } catch { /* already stopped */ } }
      if (sources[0]) sources[0].onended = () => {
        all.forEach(n => n.disconnect());
        for (const o of sources) if (o.detune) { try { this.bendCents.disconnect(o.detune); } catch { /* not connected */ } }
      };
    };
    return v;
  }
}
