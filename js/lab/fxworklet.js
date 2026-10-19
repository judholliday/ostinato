// Things that work sample by sample, run in an AudioWorklet (one module per AudioContext, loaded
// on demand by ensureFx): the Bitcrusher, Stutter and Freeze effects (buildEffect in the engine)
// and the String voice (buildVoice).
const CODE = `
// Bitcrusher: fewer bits (coarser steps) and a lower sample rate (each sample held for 'hold').
class Crush extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'bits', defaultValue: 8, automationRate: 'k-rate' }, { name: 'hold', defaultValue: 1, automationRate: 'k-rate' }]; }
  constructor() { super(); this.n = []; this.v = []; }
  process([inp], [out], p) {
    const step = 2 / 2 ** Math.max(1, p.bits[0]), hold = Math.max(1, Math.round(p.hold[0]));
    for (let c = 0; c < out.length; c++) {
      const x = inp[c] || inp[0], y = out[c];
      if (!x) { y.fill(0); continue; }
      let n = this.n[c] || 0, v = this.v[c] || 0;
      for (let i = 0; i < y.length; i++) {
        if (n <= 0) { v = Math.round(x[i] / step) * step; n = hold; }
        n--;
        y[i] = v;
      }
      this.n[c] = n; this.v[c] = v;
    }
    return true;
  }
}
registerProcessor('ost-crush', Crush);

// A few seconds of the input, kept round and round, for Stutter and Freeze.
class Ring {
  constructor(secs) { this.len = Math.ceil(secs * sampleRate); this.b = [new Float32Array(this.len), new Float32Array(this.len)]; this.w = 0; }
  push(inp, n) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) this.b[c][this.w] = (inp[c] || inp[0])?.[i] || 0;
      this.w = (this.w + 1) % this.len;
    }
  }
  // The last 'n' samples written, before position 'back' samples ago.
  last(n, back = 0) {
    return this.b.map(ch => Float32Array.from({ length: n }, (_, i) => ch[((this.w - back - n + i) % this.len + this.len) % this.len]));
  }
}
const FADE = 96; // samples of fade at each join, so slices don't click

// Stutter: time is cut into slices of 'size'; at each slice, with probability 'chance', the slice
// that just played is repeated 'repeats' times instead of the input (a beat-repeat).
class Stutter extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'size', defaultValue: 0.125, automationRate: 'k-rate' }, { name: 'chance', defaultValue: 0.25, automationRate: 'k-rate' }, { name: 'repeats', defaultValue: 3, automationRate: 'k-rate' }]; }
  constructor() { super(); this.ring = new Ring(1.2); this.pos = 0; this.slice = null; this.left = 0; }
  process([inp], [out], p) {
    const n = out[0].length, size = Math.max(64, Math.round(Math.min(1, p.size[0]) * sampleRate));
    for (let i = 0; i < n; i++) {
      if (this.pos >= size) {
        this.pos = 0;
        if (this.left > 0) this.left--;
        else if (Math.random() < p.chance[0]) { this.slice = this.ring.last(size); this.left = Math.max(1, Math.round(p.repeats[0])); }
        else this.slice = null;
        if (!this.left) this.slice = null;
      }
      for (let c = 0; c < out.length; c++) {
        const x = (inp[c] || inp[0])?.[i] || 0;
        let y = x;
        if (this.slice) {
          const s = this.slice[c] || this.slice[0], k = this.pos;
          // Fade the repeat in and out at the slice's ends.
          const g = Math.min(1, k / FADE, (size - k) / FADE);
          y = s[k] * g + x * (1 - g);
        }
        out[c][i] = y;
      }
      this.pos++;
      // Record the input as it is, so repeats are of what was played.
      for (let c = 0; c < 2; c++) this.ring.b[c][this.ring.w] = (inp[c] || inp[0])?.[i] || 0;
      this.ring.w = (this.ring.w + 1) % this.ring.len;
    }
    return true;
  }
}
registerProcessor('ost-stutter', Stutter);

// Freeze: while 'frozen' is 1, the last 'size' seconds before it was switched on loop forever
// (their end crossfaded into their start); while 0, the input passes. 20 ms fades between.
class Freeze extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'frozen', defaultValue: 0, automationRate: 'k-rate' }, { name: 'size', defaultValue: 0.4, automationRate: 'k-rate' }]; }
  constructor() { super(); this.ring = new Ring(2.2); this.loop = null; this.pos = 0; this.g = 0; this.was = 0; }
  capture(size) {
    const n = Math.max(512, Math.round(Math.min(2, size) * sampleRate)), x = Math.round(n * 0.25);
    const raw = this.ring.last(n + x);
    // Equal-power crossfade: the end blends into the start, so the loop has no seam.
    this.loop = raw.map(ch => Float32Array.from({ length: n }, (_, i) => {
      if (i >= x) return ch[i + x];
      const t = i / x;
      return ch[i + x] * Math.sin(t * Math.PI / 2) + ch[i + n] * Math.cos(t * Math.PI / 2);
    }));
    this.pos = 0;
  }
  process([inp], [out], p) {
    const n = out[0].length, frozen = p.frozen[0] > 0.5, step = 1 / (0.02 * sampleRate);
    if (frozen && !this.was) this.capture(p.size[0]);
    this.was = frozen;
    for (let i = 0; i < n; i++) {
      this.g = Math.max(0, Math.min(1, this.g + (frozen ? step : -step)));
      for (let c = 0; c < out.length; c++) {
        const x = (inp[c] || inp[0])?.[i] || 0;
        const l = this.loop ? (this.loop[c] || this.loop[0])[this.pos] : 0;
        out[c][i] = x * (1 - this.g) + l * this.g;
      }
      if (this.loop) this.pos = (this.pos + 1) % this.loop[0].length;
      for (let c = 0; c < 2; c++) this.ring.b[c][this.ring.w] = (inp[c] || inp[0])?.[i] || 0;
      this.ring.w = (this.ring.w + 1) % this.ring.len;
    }
    return true;
  }
}
registerProcessor('ost-freeze', Freeze);

// String: a plucked, picked or struck string (Karplus-Strong waveguide). Per string: a delay line
// one period long; each pass through the loop goes through a fractional-delay allpass (exact
// tuning), up to 24 dispersion allpasses (stiffness: upper partials sharp, as on a piano,
// fitted per note), a one-pole low-pass (highs die first) and a gain that sets the decay time. The
// strings of a note share a bridge that couples them (two-stage decay).
// The excitation (the pluck or the hammer) is fed in at the note's start, with a comb at the
// strike position (striking at 1/n of the length mutes every n-th harmonic). One to three strings
// per note can be detuned against each other (a piano's unison chorus). 'damp' (set to 1 at
// release) brings in the damper: the decay becomes 'release' seconds.
// Options: { freq, start (s), vel (0-1), excite, position, brightness, decay, highs, keydecay, coupling, stiffness, knock,
// strings, detune (cents), release, velocity }. Params: detune (cents: pitch bend, glide), damp.
// A felt piano hammer striking the string, simulated (at twice the sample rate) to get the force
// it puts on the string over time: the hammer (mass M, moving at v0) compresses the felt, which
// pushes back with F = K × compression^p (felt stiffens the harder it's squeezed, so harder blows
// give shorter, sharper, brighter pulses); the force sends waves both ways along the string, and
// the wave reflected back from the near end (the agraffe) meets the hammer again, which is what
// throws it off the string (several bumps in the treble). Hammer masses, felt stiffness and string
// impedances are interpolated across the keyboard from Chaigne & Askenfelt's models of a grand
// (C2, C4, C7); the strike point moves from 1/8 of the string towards 1/14 in the top octaves
// (Conklin). Velocity sets the hammer's speed (about 0.5 m/s pianissimo to 5 m/s fortissimo),
// Brightness the felt's hardness. Returns the force as the velocity wave it sends down the string (in units of 2.5 m/s).
function hammerForce(freq, vel, o) {
  const key = 69 + 12 * Math.log2(freq / 440), at = (vals, lowest = 0) => { // interpolate C2-C4-C7 by note (log values)
    const note = Math.max(lowest, key), [n0, n1, n2] = [36, 60, 96], [a, b, c] = vals.map(Math.log);
    const t = note <= n1 ? (note - n0) / (n1 - n0) : (note - n1) / (n2 - n1);
    return Math.exp(note <= n1 ? a + (b - a) * t : b + (c - b) * t);
  };
  const strings = Math.max(1, Math.min(3, Math.round(o.strings || 1)) - (o.unacorda ? 1 : 0));
  const M = at([4.9e-3, 2.97e-3, 2.2e-3]), p = Math.min(3.5, Math.max(2, at([2.3, 2.5, 3.0])));
  // Una corda (the soft pedal) shifts the action so the hammer strikes one string fewer, with
  // felt that hasn't been packed hard by playing: softer.
  const K = at([4e8, 4.5e9, 1e12]) * 4 ** (2 * ((o.brightness ?? 0.6) - 0.6)) * (o.unacorda ? 0.5 : 1);
  const Z = at([3.0 * 2, 1.62 * 3, 1.47 * 3], 36) * strings / 3; // the strings' impedance, all struck together (a grand has 2 strings at C2, 3 above)
  const beta = Math.max(0.02, Math.min(0.5, (o.position ?? 0.125) * (key > 69 ? 0.57 ** Math.min(1, (key - 69) / 39) : 1)));
  const depth = o.velocity ?? 0.7, v0 = 5 * 10 ** (-VEL_RANGE * depth * (1 - vel));
  const sr2 = 2 * sampleRate, dt = 1 / sr2, P2 = sr2 / freq, Dl = Math.max(1, Math.round(beta * P2)), Dr = Math.max(1, Math.round((1 - beta) * P2));
  const max = Math.round(0.03 * sr2), outL = new Float64Array(max), outR = new Float64Array(max), F = new Float64Array(max);
  // Felt is hysteretic (Stulov): it pushes back harder while being squeezed than while recovering,
  // F = K (c^p + α d(c^p)/dt), so the pulse rises fast and falls slowly, and its spectrum has no
  // deep nulls (a symmetric pulse left a 20 dB hole around 2 kHz at C4).
  const alpha = globalThis.HYSTERESIS != null ? HYSTERESIS : at([3e-4, 3e-4, 1e-5]); // fitted to the Iowa grand (C2, C4; less up to C7)
  let yh = 0, vh = v0, ys = 0, n = 0, cp0 = 0;
  for (; n < max; n++) {
    const comp = yh - ys, cp = comp > 0 ? comp ** p : 0, f = comp > 0 ? Math.max(0, K * (cp + alpha * (cp - cp0) / dt)) : 0;
    cp0 = cp;
    const inL = n >= Dl ? -0.995 * outL[n - Dl] : 0, inR = n >= Dr ? -0.995 * outR[n - Dr] : 0;
    const vs = inL + inR + f / (2 * Z);
    outL[n] = inR + f / (2 * Z); outR[n] = inL + f / (2 * Z);
    F[n] = f;
    vh -= f / M * dt; yh += vh * dt; ys += vs * dt;
    if (n > 8 && f === 0 && yh < ys) break; // the hammer has left the string
  }
  const len = Math.max(2, Math.ceil(n / 2)), out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = (F[2 * i] + (F[2 * i + 1] || 0)) / 2 / (2 * Z) / 2.5;
  return Object.assign(out, { beta, period: Math.round(sampleRate / freq), contact: n / sr2, peak: Math.max(...F), speed: v0 });
}

// Inharmonicity: a stiff string's partials run sharp, f_k = k f0 √(1 + B k²). B for a concert
// grand, by note (Bank; Conklin): about 1e-4 around C2 (a little more in the lowest octave),
// 7.5e-4 at A#4, 1e-2 at the top; Stiffness 0.5 = this, each doubling of Stiffness = 4× B.
const B_POINTS = [[21, -3.6], [36, -4], [70, -3.12], [108, -2]]; // [note, log10 B]
function pianoB(note) {
  const pts = B_POINTS, i = Math.max(0, Math.min(pts.length - 2, pts.findIndex(q => q[0] > note) - 1));
  const [[n0, b0], [n1, b1]] = [pts[i], pts[i + 1]];
  return 10 ** (b0 + (b1 - b0) * Math.max(-0.5, Math.min(1.5, (note - n0) / (n1 - n0))));
}
// A first-order allpass's phase delay (samples) at ω, and a one-pole low-pass's.
const apDelay = (a, w) => 1 - 2 * Math.atan2(a * Math.sin(w), 1 + a * Math.cos(w)) / w;
const lpDelay = (b, w) => Math.atan2(b * Math.sin(w), 1 - b * Math.cos(w)) / w;
// The dispersion filter for a string: M identical first-order allpasses (Van Duyne & Smith), with
// M and their coefficient chosen so the loop's delay at each partial puts it where B says, over
// the partials up to 2.5 kHz (at least 3, at most 40; above that they're weak and short-lived): the error of
// each partial in cents, least squares, the lower partials weighted more (1/k). Uses as few
// stages as get within half a cent of the best (up to 16; 24 in the lowest octave, which still
// comes out up to ~10 cents off). Cached per pitch and B.
const dispCache = new Map();
function dispersion(f0, B) {
  const key = Math.round(f0 * 10) + '|' + B.toPrecision(3);
  if (dispCache.has(key)) return dispCache.get(key);
  const sr = sampleRate, loop = sr / f0, w = k => 2 * Math.PI * k * f0 * Math.sqrt((1 + B * k * k) / (1 + B)) / sr;
  const K = Math.min(40, Math.max(Math.min(3, Math.floor(sr * 0.4 / f0)), Math.floor(2500 / f0)));
  const ws = Array.from({ length: K + 1 }, (_, k) => w(k)), want = ws.map((x, k) => 2 * Math.PI * k / x), weight = ws.map((_, k) => 1 / k);
  let wsum = 0; for (let k = 2; k <= K; k++) wsum += weight[k];
  const maxM = f0 < 50 ? 24 : 16, fits = [{ M: 0, a: 0, e: Infinity }];
  // For each coefficient, one stage's delay at every partial; then every M at once (M stages = M × that).
  const tryA = a => {
    const d = ws.map((x, k) => (k ? apDelay(a, x) : 0));
    for (let M = 0; M <= maxM; M++) {
      if (M * d[1] > loop - 3) break;
      const base = loop - M * d[1]; // the fundamental tuned exactly
      let e = 0;
      for (let k = 2; k <= K; k++) e += weight[k] * (1731 * (base + M * d[k] - want[k]) / want[k]) ** 2; // cents², low partials count more
      e = Math.sqrt(e / (wsum || 1));
      if (!fits[M] || e < fits[M].e) fits[M] = { M, a: M ? a : 0, e };
    }
  };
  if (K >= 2) {
    for (let i = 0; i <= 120; i++) tryA(-0.98 * i / 120);
    for (const f of fits.slice(1)) if (f) for (let j = -8; j <= 8; j++) tryA(Math.max(-0.98, Math.min(0, f.a + j * 0.98 / 120 / 8)));
  } else fits[0].e = 0;
  const best = fits.reduce((x, y) => (y && y.e < x.e ? y : x));
  const pick = fits.find(q => q && q.e <= best.e + 0.5) || best;
  dispCache.set(key, pick);
  return pick;
}

// Decay across a grand's keyboard, as [Hz, value] points, interpolated (and extrapolated) on
// log-log axes by byPitch(). AFTER: how long the fundamental's aftersound rings (T60, s; Martin
// 1947). HIGHS: how long a 2 kHz partial's aftersound rings (T60, s): AFTER plus the loss that
// grows with frequency squared in Bensa et al.'s fits to a Yamaha C6 (2003: decay rate b1 + b3·ω²,
// b3 ≈ 2.9e-9 s at C2, 2.5e-9 at C4, 1.2e-8 at C7). PROMPT: how much faster the
// prompt sound decays than the aftersound (dB/s; Martin): about 3× through the bass and middle,
// the two merging above C5. Coupling 1 couples a note's strings by half of that, since the
// coupling also slows the strings' drift apart (measured: that matches Martin's curves best,
// within ~3 dB over 8 s from C2 to C5).
const AFTER = [[27.5, 22], [65.4, 19], [131, 16], [262, 14], [523, 10], [1047, 6], [2093, 2.5], [4186, 1]];
const HIGHS = [[65.4, 12], [261.6, 7.8], [2093, 1.6]];
const PROMPT = [[33, 2], [65.4, 3], [131, 9], [262, 27], [523, 18], [1047, 8], [2093, 4], [4186, 2]];
function byPitch(pts, f, clamp = false) {
  const x = Math.log(f), i = Math.max(0, Math.min(pts.length - 2, pts.findIndex(q => q[0] > f) - 1));
  const [[f0, v0], [f1, v1]] = [pts[i], pts[i + 1]];
  let t = (x - Math.log(f0)) / (Math.log(f1) - Math.log(f0));
  if (clamp) t = Math.max(0, Math.min(1, t));
  return Math.exp(Math.log(v0) + (Math.log(v1) - Math.log(v0)) * Math.max(-1.5, Math.min(2.5, t)));
}

const COMB_DEPTH = +(globalThis.COMB_DEPTH ?? 0.5); // how deep the strike point's dips are (1 = complete)
const HYSTERESIS = +(globalThis.HYSTERESIS ?? 0); // (an override for measuring; see hammerForce)
const RES_FEED = +(globalThis.RES_FEED ?? 7.5e-5); // Pedal resonance's input at Amount 1 (calibrated: see CLAUDE.md)
const STRIKE_NOISE = +(globalThis.STRIKE_NOISE ?? 0.1);
const VEL_RANGE = 1.7; // hammer speed 5 m/s × 10^(−VEL_RANGE × Velocity × (1 − vel)): fitted so pp → ff spans ~25 dB, as the Iowa recordings do
const PHANTOM = 5e-4; // the square's scale at Phantom 1: measured on C2, phantoms ~11 dB below partial 8 at fortissimo, ~27 dB at piano

class StringVoice extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'detune', defaultValue: 0, automationRate: 'k-rate' }, { name: 'damp', defaultValue: 0, automationRate: 'k-rate' }]; }
  constructor({ processorOptions: o }) {
    super();
    this.o = o;
    // A hammer lands 0-2.5 ms late, at random: the notes of a chord are never struck in the same
    // millisecond on a piano, and struck together their attacks (sharp since the soundboard's
    // direct part) added up to over 4× a single note's peak.
    this.startFrame = Math.round(o.start * sampleRate) + (o.excite === 'hammer' ? Math.round(Math.random() * 0.0025 * sampleRate) : 0);
    this.n = 0; // samples since the start
    this.quiet = 0;
    // Unison strings: tuned apart by Detune, each a little differently (at random), at different
    // strengths and struck a fraction of a millisecond apart, so they beat (the piano's living
    // sustain) without ever cancelling each other out.
    const count = Math.max(1, Math.min(3, Math.round(o.strings || 1)));
    const spread = count === 1 ? [0] : count === 2 ? [-0.5, 0.5] : [-1, 0.15, 1];
    const weight = count === 1 ? [1] : count === 2 ? [1, 0.7] : [1, 0.75, 0.55];
    // Every string of the note gets the same dispersion (they're tuned within a few cents).
    const key = 69 + 12 * Math.log2(o.freq / 440), stiff = Math.max(0, o.stiffness || 0);
    this.disp = stiff > 0 ? dispersion(o.freq, pianoB(key) * (2 * stiff) ** 2) : { M: 0, a: 0 };
    this.strings = spread.map((k, i) => Object.assign(this.makeString(o.freq * 2 ** (k * (o.detune || 0) * (0.7 + 0.6 * Math.random()) / 1200)),
      { weight: weight[i], delay: i ? Math.round(sampleRate * Math.random() * 0.0004) : 0,
        struck: !(o.unacorda && o.excite === 'hammer' && count > 1 && i === count - 1) })); // una corda: the last string only picks up the others' motion through the bridge
    this.wsum = weight.slice(0, count).reduce((a, b) => a + b, 0);
    this.excite = this.makeExcitation();
    this.lastDetune = 0;
    this.lastDamp = -1;
    this.cpl = 0;
    // Phantom partials (see process): the first longitudinal mode 4700 cents above the
    // fundamental (measured 4200-5200), a two-pole resonance with Q 60, only where it's heard (to C5).
    const fl = o.freq * 2 ** (4700 / 1200), r = Math.exp(-Math.PI * fl / 60 / sampleRate);
    this.ph = o.phantom > 0 && fl < sampleRate * 0.45 ? { k: o.phantom * PHANTOM, lk: o.freq < 530 ? 1 : 0, dc: 0, y1: 0, y2: 0,
      a1: -2 * r * Math.cos(2 * Math.PI * fl / sampleRate), a2: r * r, b0: (1 - r * r) * 24 } : null;
  }
  makeString(freq) {
    const size = Math.ceil(sampleRate / 20 * 8 / 7) + 8; // the longest loop, plus the damper's tap beyond it
    return { freq, buf: new Float32Array(size), w: 0, ap: 0, apIn: 0, disp: new Float64Array(24), dispIn: new Float64Array(24), lp: 0 };
  }
  // Loop settings for a string at its current pitch: delay length, allpass coefficients, low-pass
  // and gain. Decay rates are per second, whatever the pitch (a high string goes round its loop
  // many more times a second than a low one, so per-pass losses would make it die far sooner):
  // the fundamental fades 60 dB in Decay seconds, a partial at 2 kHz in Highs seconds, others in
  // between or beyond with the square of their frequency.
  tune(s, cents, damped) {
    const o = this.o, f = s.freq * 2 ** (cents / 1200), k = Math.max(0, Math.min(1, o.keydecay || 0));
    const stages = this.disp.M, c = this.disp.a; // the dispersion allpasses (stiffness)
    // How long the fundamental rings (Decay) and a partial at 2 kHz (Highs), at C4; Key → decay
    // scales both across the keyboard as on a grand (AFTER, HIGHS). The damper sets both to Damper.
    const tAfter = Math.max(0.05, o.decay || 3) * (byPitch(AFTER, f) / byPitch(AFTER, 261.6)) ** k;
    const tHigh = Math.max(0.02, o.highs ?? 1.5) * (byPitch(HIGHS, f) / byPitch(HIGHS, 261.6)) ** k;
    const r0 = 60 / tAfter; // dB per second at the fundamental (the damper is a separate filter: see damperFor)
    const extra = Math.max(0, 60 / tHigh - 60 / tAfter) / 2000 ** 2; // more per Hz², from the rate at 2 kHz
    const rate = F => r0 + extra * Math.max(0, F * F - f * f); // string losses grow with frequency squared (Chaigne & Askenfelt; Bensa); the fundamental's is r0
    const perPass = F => 10 ** (-rate(F) / (20 * f)); // the loop's gain at F for one pass
    const mag = (b, F) => { const w = 2 * Math.PI * F / sampleRate; return (1 - b) / Math.sqrt(1 - 2 * b * Math.cos(w) + b * b); };
    // A one-pole low-pass loses (in dB) about in proportion to frequency squared, like a string;
    // it's fitted to the rate at 3 kHz (or twice the fundamental, if higher): partials below that then
    // come out a little slower than the square law, above it faster (measured: within ~1.5× to 5 kHz).
    const Fr = Math.min(sampleRate * 0.4, Math.max(2 * f, 3000)), want = perPass(Fr) / perPass(f);
    let lo = 0, hi = 0.995;
    for (let i = 0; i < 40; i++) { const b = (lo + hi) / 2; if (mag(b, Fr) / mag(b, f) > want) lo = b; else hi = b; }
    const b = extra > 0 ? (lo + hi) / 2 : 0;
    // The delays inside the loop at the fundamental (low-pass and dispersion stages); the rest is
    // the delay line plus a fractional-delay allpass whose phase delay at f makes up the remainder
    // exactly (its fraction kept within 0.5…1.5, where it's well behaved).
    const w = 2 * Math.PI * f / sampleRate, inner = lpDelay(b, w) + stages * apDelay(c, w);
    const total = Math.max(2.1, sampleRate / f - inner);
    const N = Math.max(2, Math.floor(total - 0.5)), frac = total - N;
    let alo = -0.33, ahi = 0.33; // apDelay falls as the coefficient rises
    for (let k = 0; k < 30; k++) { const a = (alo + ahi) / 2; if (apDelay(a, w) > frac) alo = a; else ahi = a; }
    Object.assign(s, { N, a: (alo + ahi) / 2, stages, c, b, g: Math.min(0.99999, perPass(f) / mag(b, f)), damper: damped ? this.damperFor(f, N) : null });
  }
  // The damper: felt pressed on the string at 1/7 of its length. It stops most partials within
  // Damper seconds, but the ones with a node under it (every 7th) hardly move there and ring on
  // for a while (Bank): in the loop, the centre tap plus two taps D = period/7 either side, a
  // zero-phase filter 1 − α·(β + (1 − β)·sin²(ωD/2)): partials on the nodes keep only β of the
  // loss. α is set so the fundamental fades 60 dB in Damper seconds (most partials go faster);
  // at most 1, since above that the partials between the nodes would flip sign and ring on.
  damperFor(f, N) {
    const beta = 0.15, perPass = 10 ** (-60 / (20 * f * Math.max(0.01, this.o.release || 0.15)));
    const alpha = Math.min(1, (1 - perPass) / (beta + (1 - beta) * Math.sin(Math.PI / 7) ** 2)), D = Math.max(1, Math.min(N - 1, Math.round(sampleRate / f / 7)));
    return { D, c0: 1 - alpha * beta - alpha * (1 - beta) / 2, c1: alpha * (1 - beta) / 4 };
  }
  makeExcitation() {
    const o = this.o, sr = sampleRate, v = o.vel;
    const period = Math.round(sr / o.freq);
    const amp = (1 - (o.velocity ?? 0.7)) + (o.velocity ?? 0.7) * v ** 1.4;
    const bright = Math.min(1, (o.brightness ?? 0.6) * (0.55 + 0.45 * v));
    let ex;
    if (o.excite === 'hammer') {
      ex = hammerForce(o.freq, v, o);
    } else {
      // A pluck (finger: softer) or a pick (brighter): a period of noise through a low-pass.
      const k = o.excite === 'pick' ? 0.15 + 0.8 * bright : 0.05 + 0.5 * bright;
      let y = 0;
      ex = Float32Array.from({ length: period }, () => (y += k * ((Math.random() * 2 - 1) - y)));
      let mean = 0; for (const x of ex) mean += x / ex.length; for (let i = 0; i < ex.length; i++) ex[i] -= mean;
    }
    // The strike position: x[n] − x[n − position × period] (a comb).
    const P = Math.max(1, Math.round((o.excite === 'hammer' ? ex.beta : (o.position ?? 0.13)) * sr / o.freq));
    const out = new Float32Array(ex.length + P + 2 * Math.max(1, Math.round(0.015 * sr / o.freq)));
    // A hammer is a couple of centimetres wide (~3% of the string), so the strike point is a little
    // smeared: three taps around P instead of one. With one, every 8th partial was cut out entirely
    // (at C2 and C4 those fall at 2 and 4 kHz: 15-20 dB short of a real piano there).
    const W = o.excite === 'hammer' ? Math.max(1, Math.round(0.015 * sr / o.freq)) : 0;
    const rho = o.excite === 'hammer' ? COMB_DEPTH : 1;
    for (let i = 0; i < out.length; i++) out[i] = (ex[i] || 0) - rho * (W ? ((ex[i - P + W] || 0) + 2 * (ex[i - P] || 0) + (ex[i - P - W] || 0)) / 4 : (ex[i - P] || 0));
    let peak = 0; for (const x of out) peak = Math.max(peak, Math.abs(x));
    const k = o.excite === 'hammer' ? 1 : amp / (peak || 1); // a hammer's force already follows how hard it was struck
    for (let i = 0; i < out.length; i++) out[i] *= k;
    // The knock: the hammer's force also reaches the soundboard directly, not only through the
    // string (a soundboard turns it into the thud at the start of every piano note).
    this.force = ex.map(x => x * k * (o.knock || 0) * 0.4);
    // ...and the noise of the strike (felt on wire, the action): a few ms of noise above ~1.5 kHz,
    // as loud as the hammer is fast (so it stands out more in soft playing than the strings, whose
    // sound grows faster with speed). Fitted to the Iowa recordings' attacks (C4 pp: 4-8 kHz about
    // 50 dB under the note in its first 20 ms).
    if (o.excite === 'hammer' && o.knock > 0) {
      const len = Math.round(0.012 * sr), f = new Float32Array(Math.max(this.force.length, len)), c = Math.exp(-2 * Math.PI * 1500 / sr);
      f.set(this.force);
      let hp = 0, prev = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1; hp = c * (hp + w - prev); prev = w;
        f[i] += hp * Math.exp(-i / (0.003 * sr)) * ex.speed / 5 * o.knock * STRIKE_NOISE;
      }
      this.force = f;
    }
    return out;
  }
  process(inputs, [out], params) {
    const ch = out[0], frame0 = currentFrame, detune = params.detune[0], damped = params.damp[0] > 0.5;
    if (detune !== this.lastDetune || damped !== this.lastDamp) {
      this.strings.forEach(s => this.tune(s, detune, damped));
      this.lastDetune = detune; this.lastDamp = damped;
      // The bridge coupling: per pass round the loop, strings moving together lose (1 − n × cpl)
      // of their motion, which is Coupling × the prompt sound's extra decay for this note, per second.
      const n = this.strings.length, f = this.o.freq * 2 ** (detune / 1200), extra = (this.o.coupling || 0) * byPitch(PROMPT, f, true);
      this.cpl = n > 1 && !damped ? (1 - 10 ** (-extra / (20 * f))) / n : 0;
    }
    const scale = 1 / Math.sqrt(this.strings.length);
    let energy = 0;
    for (let i = 0; i < ch.length; i++) {
      if (frame0 + i < this.startFrame) { ch[i] = 0; continue; }
      const e = this.n < this.excite.length ? this.excite[this.n] : 0; // (strings struck later read it with their delay)
      this.n++;
      // Each string's loop: fractional delay, stiffness, damping and decay...
      let common = 0;
      for (const s of this.strings) {
        const size = s.buf.length;
        let x = s.buf[(s.w - s.N + size) % size];
        if (s.damper) { const d = s.damper; x = d.c0 * x + d.c1 * (s.buf[(s.w - s.N + d.D + size) % size] + s.buf[(s.w - s.N - d.D + 2 * size) % size]); }
        // fractional delay
        const y = s.a * x + s.apIn - s.a * s.ap; s.apIn = x; s.ap = y; x = y;
        // stiffness
        for (let k = 0; k < s.stages; k++) { const z = s.c * x + s.dispIn[k] - s.c * s.disp[k]; s.dispIn[k] = x; s.disp[k] = z; x = z; }
        // damping and decay
        s.lp = (1 - s.b) * x + s.b * s.lp;
        s.u = s.g * s.lp;
        common += s.u;
      }
      // ...then the bridge they share: it gives way a little under their combined pull and takes
      // that energy away (into the soundboard). Strings moving together lose it fast (the prompt
      // sound); once their slight detuning has moved them apart, little reaches the bridge and they
      // ring on (the aftersound).
      const loss = this.cpl * common;
      // Phantom partials: a string pulled sideways also stretches, and the stretch goes with the
      // square of its motion, so the bridge also gets sums and doubles of the partials (f_j + f_k,
      // 2 f_k), louder the harder it's played (fortissimo bass: ~10 dB below the partials). That
      // square (DC removed) goes out directly and through the string's first lengthwise mode, a
      // sharp resonance about 15 times the fundamental (Bank & Sujbert; Bank & Lehtonen 2010).
      let phantom = 0;
      if (this.ph) {
        const q = common * common, ph = this.ph;
        ph.dc += 0.0005 * (q - ph.dc);
        const x = q - ph.dc, y = ph.b0 * x - ph.a1 * ph.y1 - ph.a2 * ph.y2;
        ph.y2 = ph.y1; ph.y1 = y;
        phantom = ph.k * (x + ph.lk * y);
      }
      let sum = 0;
      for (const s of this.strings) {
        const size = s.buf.length;
        const ex = !s.struck ? 0 : s.delay ? (this.n - 1 >= s.delay ? this.excite[this.n - 1 - s.delay] || 0 : 0) : e;
        const v = s.u - loss + ex;
        s.buf[s.w] = v;
        s.w = (s.w + 1) % size;
        sum += v * s.weight;
      }
      ch[i] = sum / this.wsum * scale * Math.sqrt(this.strings.length) + phantom + (this.n <= this.force.length ? this.force[this.n - 1] : 0);
      energy += ch[i] * ch[i];
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    // Finished: once it has rung out (quiet for half a second after the excitation), let it go.
    if (this.n > this.excite.length + 64) this.quiet = energy / ch.length < 1e-10 ? this.quiet + ch.length : 0;
    return this.quiet < sampleRate * 0.5;
  }
}
registerProcessor('ost-string', StringVoice);

// Sympathetic strings: the rest of a piano's strings, which ring along when the sustain pedal
// lifts their dampers (the pedal's halo). One plain string loop per key from A0 to C8, fed a
// little of everything played (through the soundboard, in the real thing), ringing with a
// piano's decay times (AFTER) × Ring and a gentle loss of highs. With the pedal up their dampers
// are on and they fall silent within 0.1 s. Notes that are sounding are left out (that string is
// the note itself). Params: amount, ring, pedal (0/1), held0-3 (which notes are sounding, as bits:
// 22 notes each from A0; AudioParams, not port messages, which arrived too late in offline renders
// so every note's own string rang along as a bright, harmonic copy). Stereo: bass to the left,
// treble to the right, a little, as a piano is heard from the keyboard.
class Resonance extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'amount', defaultValue: 0.5, automationRate: 'k-rate' }, { name: 'ring', defaultValue: 1, automationRate: 'k-rate' }, { name: 'pedal', defaultValue: 0, automationRate: 'k-rate' }, ...[0, 1, 2, 3].map(i => ({ name: 'held' + i, defaultValue: 0, automationRate: 'k-rate' }))]; }
  constructor() {
    super();
    this.pedal = false;
    this.strings = [];
    for (let note = 21; note <= 108; note++) {
      // The loss low-pass (less of it up the keyboard, where the loop is short) delays the loop a
      // little: taken off the delay line, so each string stays in tune.
      const f = 440 * 2 ** ((note - 69) / 12), c = 0.45 * Math.min(1, 200 / f), w = 2 * Math.PI * f / sampleRate; // duller than a played string: they're heard through the board, not struck
      const len = sampleRate / f - lpDelay(c, w), N = Math.floor(len), mag = (1 - c) / Math.sqrt(1 - 2 * c * Math.cos(w) + c * c);
      this.strings.push({ note, f, N, frac: len - N, c, mag, buf: new Float32Array(N + 2), w: 0, lp: 0, g: 1, energy: 0, pan: (note - 21) / 87 });
    }
    this.lastRing = -1; this.lastPedal = null;
  }
  process([inp], [out], p) {
    const L = out[0], R = out[1] || out[0], n = L.length, x0 = inp[0], x1 = inp[1] || inp[0];
    const amount = p.amount[0] * RES_FEED, ring = p.ring[0];
    this.pedal = p.pedal[0] > 0.5;
    const held = [p.held0[0], p.held1[0], p.held2[0], p.held3[0]];
    if (ring !== this.lastRing || this.pedal !== this.lastPedal) {
      for (const s of this.strings) {
        const t60 = this.pedal ? byPitch(AFTER, s.f) * ring * 0.3 : 0.1; // shorter than a played string's aftersound, so a held pedal doesn't build a drone
        s.g = Math.min(0.99999, 10 ** (-60 / (20 * s.f * t60)) / s.mag); // per pass, at the fundamental; the low-pass takes more off the highs
      }
      this.lastRing = ring; this.lastPedal = this.pedal;
    }
    L.fill(0); if (R !== L) R.fill(0);
    if (!x0) return true;
    for (const s of this.strings) {
      const k = s.note - 21, open = this.pedal && !(Math.floor(held[Math.floor(k / 22)] / 2 ** (k % 22)) % 2);
      if (!open && s.energy < 1e-12) continue; // damped and silent
      const feed = open ? amount : 0, size = s.buf.length, gl = 1 - s.pan * 0.6, gr = 0.4 + s.pan * 0.6;
      let e = 0;
      for (let i = 0; i < n; i++) {
        // A delay of N + frac samples: linear interpolation between the two oldest.
        const a = s.buf[(s.w - s.N + size) % size], b = s.buf[(s.w - s.N - 1 + size) % size];
        const y = a + (b - a) * s.frac;
        s.lp = (1 - s.c) * y + s.c * s.lp;
        const v = s.g * (open ? s.lp : s.lp * 0.97) + feed * (x0[i] + x1[i]) * 0.5;
        s.buf[s.w] = v; s.w = (s.w + 1) % size;
        L[i] += v * gl; R[i] += v * gr;
        e += v * v;
      }
      s.energy = e / n;
    }
    return true;
  }
}
registerProcessor('ost-resonance', Resonance);
`;

export const WORKLET_FX = ['crusher', 'stutter', 'freeze', 'resonance'];
export const WORKLET_VOICES = ['string']; // voice modules that need the worklet
const loaded = new WeakMap(); // AudioContext -> Promise, then true once ready
export function ensureFx(ac) {
  if (!loaded.has(ac)) {
    const p = ac.audioWorklet.addModule(URL.createObjectURL(new Blob([CODE], { type: 'text/javascript' })))
      .then(() => { loaded.set(ac, true); return true; }, () => false);
    loaded.set(ac, p);
  }
  const v = loaded.get(ac);
  return v === true ? Promise.resolve(true) : v;
}
export const fxReady = ac => loaded.get(ac) === true;
