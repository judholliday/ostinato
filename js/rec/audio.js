// Audio input for the Recorder: opens an audio interface input (e.g. the Scarlett 2i2) with no
// processing, taps the raw samples with an AudioWorklet, and keeps them while recording.
// Times: every block arrives with its frame number; `perfAt(frame)` converts to performance.now()
// milliseconds. The delay from a MIDI note leaving to its sound arriving here is measured
// separately (Measure delay) and applied when lining recordings up with the sequencer.

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; this.start = 0; }
  process(inputs) {
    const chans = inputs[0];
    if (!chans || !chans.length) return true;
    if (!this.buf.length) this.start = currentFrame;
    this.buf.push(chans.map(c => c.slice()));
    this.n += chans[0].length;
    if (this.n >= 2048) {
      const nch = Math.max(...this.buf.map(b => b.length));
      const out = Array.from({ length: nch }, (_, k) => {
        const a = new Float32Array(this.n);
        let o = 0;
        for (const b of this.buf) { a.set(b[k] || b[0], o); o += b[0].length; }
        return a;
      });
      this.port.postMessage({ frame: this.start, chans: out }, out.map(a => a.buffer));
      this.buf = []; this.n = 0;
    }
    return true;
  }
}
registerProcessor('mkxl-tap', Tap);`;

// Recording by time, not by arrival: blocks reach the page some time after they're played (a
// busy page can lag by seconds), so a recording keeps the blocks whose frames fall between its
// start and end, and finishing waits (up to 3 s) for the last of them to arrive.
function startRecording(src) {
  src.recording = { chunks: [], start: src.frameAt(performance.now()), end: Infinity };
}
function addChunk(src, frame, chans) {
  const len = chans[0].length, r = src.recording;
  src.latest = Math.max(src.latest || 0, frame + len);
  if (r && frame + len > r.start && frame < r.end) r.chunks.push({ frame, chans });
}
async function finishRecording(src) {
  const r = src.recording;
  if (!r) return null;
  r.end = src.frameAt(performance.now());
  for (let k = 0; k < 150 && (src.latest || 0) < r.end; k++) await new Promise(res => setTimeout(res, 20));
  src.recording = null;
  if (!r.chunks.length) return null;
  const nch = r.chunks[0].chans.length, total = r.end - r.start;
  const chans = Array.from({ length: nch }, () => new Float32Array(total));
  for (const c of r.chunks) {
    const at = c.frame - r.start, from = Math.max(0, -at), to = Math.min(c.chans[0].length, total - at);
    if (to > from) chans.forEach((a, k) => a.set((c.chans[k] || c.chans[0]).subarray(from, to), at + from));
  }
  return { frame: r.start, chans };
}

// The tap's worklet, added to an AudioContext once.
const added = new WeakMap();
function addWorklet(ac) {
  if (!added.has(ac)) added.set(ac, ac.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))));
  return added.get(ac);
}

// Records whatever comes out of `node` (e.g. a page's own mix), in stereo, the same way AudioIn
// records an input: record(), then finish() → { frame, chans }. onLevel(peak) on every block.
export class Tap {
  constructor(ac, node, { onLevel } = {}) {
    Object.assign(this, { ac, node, onLevel: onLevel || (() => {}), recording: null, ready: null });
  }
  start() {
    this.ready ||= addWorklet(this.ac).then(() => {
      this.tap = new AudioWorkletNode(this.ac, 'mkxl-tap', { numberOfOutputs: 1, channelCountMode: 'explicit', channelCount: 2 });
      const mute = this.ac.createGain();
      mute.gain.value = 0;
      this.node.connect(this.tap).connect(mute).connect(this.ac.destination);
      this.tap.port.onmessage = e => {
        const { frame, chans } = e.data, use = chans.length > 1 ? chans.slice(0, 2) : chans;
        let peak = 0;
        for (const c of use) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
        this.onLevel(peak);
        addChunk(this, frame, use);
      };
    });
    return this.ready;
  }
  record() { startRecording(this); }
  finish() { return finishRecording(this); } // async: { frame, chans } or null
  perfAt(frame) { return AudioIn.prototype.perfAt.call(this, frame); }
  frameAt(ms) { return AudioIn.prototype.frameAt.call(this, ms); }
  get sampleRate() { return this.ac.sampleRate; }
}

export class AudioIn {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel || (() => {});
    this.ac = null;
    this.stream = null;
    this.recording = null; // { chunks: [{ frame, chans }] }
    this.channel = 'both'; // 'both', or 0 / 1 for one input
  }

  get open() { return !!this.stream; }
  get sampleRate() { return this.ac?.sampleRate || 48000; }

  // The audio inputs this browser can see (names appear once permission is given).
  static async devices() {
    return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  }

  async start(deviceId) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: { ideal: 2 },
      echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (!this.ac) {
      this.ac = new AudioContext({ latencyHint: 'interactive' });
      await addWorklet(this.ac);
    }
    await this.ac.resume();
    this.src = this.ac.createMediaStreamSource(this.stream);
    this.tap = new AudioWorkletNode(this.ac, 'mkxl-tap', { numberOfOutputs: 1, channelCountMode: 'explicit', channelCount: 2 });
    const mute = this.ac.createGain();
    mute.gain.value = 0;
    this.src.connect(this.tap).connect(mute).connect(this.ac.destination); // keeps the tap running, silently
    this.tap.port.onmessage = e => this.onBlock(e.data);
    const s = this.stream.getAudioTracks()[0]?.getSettings() || {};
    return { channels: s.channelCount || 1, label: this.stream.getAudioTracks()[0]?.label || '' };
  }

  stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.src?.disconnect();
    this.tap?.disconnect();
    this.stream = this.src = this.tap = null;
  }

  onBlock({ frame, chans }) {
    const use = this.pick(chans);
    let peak = 0;
    for (const c of use) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
    this.onLevel(peak);
    addChunk(this, frame, use);
  }
  // The chosen input: one channel (mono), or both.
  pick(chans) {
    if (this.channel === 'both') return chans.length > 1 ? chans.slice(0, 2) : chans;
    return [chans[Math.min(this.channel, chans.length - 1)]];
  }

  // performance.now() ms of a frame (on the AudioContext's clock).
  perfAt(frame) {
    const ts = this.ac.getOutputTimestamp();
    return ts.performanceTime + (frame / this.ac.sampleRate - ts.contextTime) * 1000;
  }
  frameAt(perfMs) {
    const ts = this.ac.getOutputTimestamp();
    return Math.round((ts.contextTime + (perfMs - ts.performanceTime) / 1000) * this.ac.sampleRate);
  }

  record() { startRecording(this); }
  // Stops recording; resolves to { frame (of the first sample), chans: [Float32Array] }, or null.
  finish() { return finishRecording(this); }
}

// Cuts a recording to [fromFrame, fromFrame + length) (absolute frames), padding with silence.
export function cut(rec, fromFrame, length) {
  const start = fromFrame - rec.frame;
  return rec.chans.map(a => {
    const out = new Float32Array(Math.max(0, length));
    for (let i = 0; i < out.length; i++) { const j = start + i; out[i] = j >= 0 && j < a.length ? a[j] : 0; }
    return out;
  });
}

// 24-bit PCM WAV.
export function encodeWav(chans, sampleRate) {
  const n = chans[0].length, nch = chans.length, bytes = 3, block = nch * bytes;
  const buf = new ArrayBuffer(44 + n * block), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * block, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * block, true); v.setUint16(32, block, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, n * block, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < nch; k++) {
      const x = Math.max(-1, Math.min(1, chans[k][i])), s = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
      v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255);
      o += 3;
    }
  }
  return new Uint8Array(buf);
}

// The first moment (frame offset) the signal rises clearly above the noise before `from`.
export function findOnset(chans, from) {
  const a = chans[0];
  let noise = 0;
  for (let i = Math.max(0, from - 2400); i < from; i++) noise = Math.max(noise, Math.abs(a[i]));
  const threshold = Math.max(0.01, noise * 4);
  for (let i = from; i < a.length; i++) if (Math.abs(a[i]) > threshold) return i;
  return -1;
}
