// Prototype engine for a modal piano: one note = a sum of decaying sine "modes", each with its own
// frequency, decay rate, and level and phase per channel (fitted to recordings by fit.py).
// Each mode is a two-pole resonator per channel run freely from its starting state:
// y[n] = 2 r cos(w) y[n-1] - r^2 y[n-2], which is A r^n cos(w n + phase). Two multiplies a sample.
// processorOptions: { modes: Float64Array [f, decay (1/s), ampL, phaseL, ampR, phaseR] * n, start (s), gain,
//   ramp (s the modes take to fade in), stop (s: when the key is let go, if known), damp (s the damper takes to
//   bring the note down 60 dB; 0 = this note has no damper) }. A {release: seconds} message lets the key go live.
class Modal extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions, m = p.modes, n = m.length / 6, g = p.gain ?? 1;
    this.start = Math.round((p.start || 0) * sampleRate);
    this.c1 = new Float64Array(n); this.c2 = new Float64Array(n);
    this.s = new Float64Array(n * 4);            // y[n-1], y[n-2] for left, then right
    this.floor = new Float64Array(n);            // sample index after which the mode is inaudible
    let k = 0;
    for (let i = 0; i < n; i++) {
      const f = m[i * 6], d = m[i * 6 + 1];
      if (f >= 0.45 * sampleRate) continue;
      const w = 2 * Math.PI * f / sampleRate, r = Math.exp(-d / sampleRate);
      this.c1[k] = 2 * r * Math.cos(w); this.c2[k] = r * r;
      for (let ch = 0; ch < 2; ch++) {
        const A = 2 * g * m[i * 6 + 2 + ch * 2], ph = m[i * 6 + 3 + ch * 2];
        this.s[k * 4 + ch * 2] = A / r * Math.cos(ph - w);               // y[-1]
        this.s[k * 4 + ch * 2 + 1] = A / (r * r) * Math.cos(ph - 2 * w); // y[-2]
      }
      // drop the mode once it has fallen below -110 dBFS
      const a = 2 * g * Math.max(m[i * 6 + 2], m[i * 6 + 4]);
      this.floor[k] = a > 3e-6 ? Math.log(a / 3e-6) / d * sampleRate : 0;
      k++;
    }
    this.n = k; this.t = 0;
    this.ramp = Math.round((p.ramp || 0) * sampleRate);
    this.stop = p.stop != null ? Math.round(p.stop * sampleRate) : Infinity;
    this.dampK = p.damp > 0 ? Math.exp(-6.908 / (p.damp * sampleRate)) : 1;
    this.env = 1;
    this.port.onmessage = e => { if (e.data.release != null) this.stop = Math.round(e.data.release * sampleRate); };
  }
  process(_, outputs) {
    const L = outputs[0][0], R = outputs[0][1] || L, N = L.length;
    let from = 0;
    if (currentFrame + N <= this.start) return true;
    if (currentFrame < this.start) from = this.start - currentFrame;
    const { c1, c2, s } = this;
    let live = 0;
    for (let k = 0; k < this.n; k++) {
      if (this.t > this.floor[k]) continue;
      live++;
      const a = c1[k], b = c2[k];
      let l1 = s[k * 4], l2 = s[k * 4 + 1], r1 = s[k * 4 + 2], r2 = s[k * 4 + 3];
      for (let i = from; i < N; i++) {
        const l = a * l1 - b * l2; l2 = l1; l1 = l; L[i] += l;
        const r = a * r1 - b * r2; r2 = r1; r1 = r; R[i] += r;
      }
      s[k * 4] = l1; s[k * 4 + 1] = l2; s[k * 4 + 2] = r1; s[k * 4 + 3] = r2;
    }
    // the fade-in at the start, and the damper once the key is up
    if (this.t < this.ramp) for (let i = from, t = this.t; i < N && t < this.ramp; i++, t++) { const g = 0.5 - 0.5 * Math.cos(Math.PI * t / this.ramp); L[i] *= g; R[i] *= g; }
    if (currentFrame + N > this.stop && this.dampK < 1) {
      for (let i = Math.max(from, this.stop - currentFrame); i < N; i++) { L[i] *= this.env; R[i] *= this.env; this.env *= this.dampK; }
      if (this.env < 1e-5) return false;
    }
    this.t += N - from;
    return live > 0;
  }
}
registerProcessor('ost-modal-proto', Modal);
