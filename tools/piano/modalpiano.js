// Prototype of the whole-keyboard modal piano (page side): loads the data build.py wrote and plays
// any note at any velocity. A note uses the nearest analysed note's modes, moved by at most a
// semitone; velocity scales each partial's starting level between the soft and loud recordings.
export class ModalPiano {
  constructor(ctx, dest, base = '/recordings/piano/modal/') { this.ctx = ctx; this.dest = dest; this.base = base; this.notes = new Map(); }
  async load(notes, { strike = true } = {}) {
    await this.ctx.audioWorklet.addModule('/tools/piano/modalworklet.js?' + Date.now());
    await Promise.all(notes.map(async n => {
      const r = await fetch(`${this.base}${n}.json?${Date.now()}`);
      if (!r.ok) return;
      const d = await r.json();
      const buf = async dyn => { const q = await fetch(`${this.base}${n}_${dyn}.wav`); return strike && q.ok ? this.ctx.decodeAudioData(await q.arrayBuffer()) : null; };
      d.ff = await buf('ff'); d.pp = d.rmsSoft != null ? await buf('pp') : null;
      this.notes.set(n, d);
    }));
    // a note recorded only loud borrows its neighbour's soft-to-loud differences
    const have = [...this.notes.keys()].sort((a, b) => a - b);
    for (const n of have) { const d = this.notes.get(n); if (d.rmsSoft == null) { const o = this.notes.get(have.find(m => this.notes.get(m).rmsSoft != null)); d.soft = o.soft; d.rmsSoft = d.rms + (o.rmsSoft - o.rms); d.rampSoft = d.ramp; d.pp = null; } }
    // Iowa's notes aren't evenly loud, nor evenly "pp": each note's level, and its soft-to-loud difference,
    // is moved to a straight line through all the notes (dB against key), at most 8 dB
    const line = (ys) => { const xs = have, n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
      const k = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0); return x => my + k * (x - mx); };
    const lv = line(have.map(n => this.notes.get(n).rms)), df = line(have.map(n => this.notes.get(n).rmsSoft - this.notes.get(n).rms));
    for (const d of this.notes.values()) {
      const clamp = v => Math.max(-8, Math.min(8, v));
      d.trim = 10 ** (clamp(lv(d.note) - d.rms) / 20);
      const move = clamp(df(d.note) - (d.rmsSoft - d.rms));
      d.soft = Object.fromEntries(Object.entries(d.soft).map(([k, v]) => [k, v + move])); d.rmsSoft += move; d.softTrim = 10 ** (move / 20);
    }
    for (const d of this.notes.values()) {
      // partials too quiet to measure in the soft recording: carry on the trend of the ones that were
      const ks = Object.keys(d.soft).map(Number), vs = ks.map(k => d.soft[k]);
      const mk = ks.reduce((a, b) => a + b, 0) / ks.length, mv = vs.reduce((a, b) => a + b, 0) / vs.length;
      let slope = ks.reduce((a, k, i) => a + (k - mk) * (vs[i] - mv), 0) / (ks.reduce((a, k) => a + (k - mk) ** 2, 0) || 1);
      slope = Math.min(0, slope);
      const kmax = Math.max(...ks), low = Math.min(...vs);
      d.softOf = k => d.soft[k] ?? Math.min(low, mv + slope * (Math.min(k, kmax * 2) - mk));
      d.cents = 1200 * Math.log2(d.f0 / (440 * 2 ** ((d.note - 69) / 12)));
    }
    this.have = have;
  }
  // which analysed note plays `note`, and the piano's own tuning there (between its neighbours')
  source(note) {
    const h = this.have; let s = h[0];
    for (const n of h) if (Math.abs(n - note) < Math.abs(s - note)) s = n;
    const lo = [...h].reverse().find(n => n <= note) ?? h[0], hi = h.find(n => n >= note) ?? h[h.length - 1];
    const cl = this.notes.get(lo).cents, ch = this.notes.get(hi).cents;
    const cents = hi === lo ? cl : cl + (ch - cl) * (note - lo) / (hi - lo);
    return { d: this.notes.get(s), f: 440 * 2 ** ((note - 69) / 12 + cents / 1200) };
  }
  play(note, vel, t, dur, { from = null, strike = 1 } = {}) {
    const { d, f } = from != null ? { d: this.notes.get(from), f: this.source(note).f } : this.source(note);
    const ratio = f / d.f0;
    const u = Math.max(-0.1, Math.min(1.7, Math.log(120 / Math.max(1, vel)) / Math.log(4)));   // 0 = the loud recording (velocity 120), 1 = the soft one (30)
    const modes = new Float64Array(d.modes.length * 6);
    d.modes.forEach((m, i) => { const g = 10 ** (u * d.softOf(m[6]) / 20); modes.set([m[0] * ratio, m[1], m[2] * g, m[3], m[4] * g, m[5]], i * 6); });
    const u1 = Math.max(0, Math.min(1, u));
    const damp = note > 88 ? 0 : 0.12 + 0.5 * Math.max(0, (72 - note) / 36);
    const node = new AudioWorkletNode(this.ctx, 'ost-modal-proto', { numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { modes, start: t, gain: d.trim, ramp: (d.ramp + (d.rampSoft - d.ramp) * u1) / 1000, stop: dur != null ? t + dur : null, damp } });
    node.connect(this.dest);
    // the strike: the loud and soft recordings' own, crossfaded; quieter still below the soft one
    const under = 10 ** (Math.max(0, u - 1) * (d.rmsSoft - d.rms) / 20), over = 10 ** (Math.min(0, u) * (d.rmsSoft - d.rms) / 20);
    for (const [buf, g] of [[d.ff, d.trim * (d.pp ? (1 - u1) * over : 10 ** (u * (d.rmsSoft - d.rms) / 20))], [d.pp, d.trim * d.softTrim * u1 * under]]) {
      if (!buf || g * strike <= 0) continue;
      const src = new AudioBufferSourceNode(this.ctx, { buffer: buf, playbackRate: ratio }), gn = new GainNode(this.ctx, { gain: g * strike });
      src.connect(gn).connect(this.dest); src.start(t);
    }
    return node;
  }
}
