"""Shared measurements for piano tones (real recordings and renders). numpy/scipy/soundfile.
Used by measure.py (compare a render with a recording) and fit.py (fit modes to a recording)."""
import numpy as np, soundfile as sf
from scipy import signal

import os
NOTE = {'C2': 36, 'C4': 60, 'C6': 84}
if os.environ.get('PIANO_NOTES'): NOTE = {a.split(':')[0]: int(a.split(':')[1]) for a in os.environ['PIANO_NOTES'].split(',')}   # e.g. G2:43,D3:50
def midi_hz(n): return 440.0 * 2 ** ((n - 69) / 12)

def load(path):
    x, sr = sf.read(path, always_2d=True, dtype='float64')
    return x, sr

def onset(x, sr, thresh_db=-34):
    """Index where the note starts: the first sample whose smoothed level comes within thresh_db of
    the peak level, moved back to where that rise began (the level 12 dB lower again)."""
    m = np.abs(x).max(axis=1) if x.ndim > 1 else np.abs(x)
    w = max(1, int(sr * 0.001))
    env = np.sqrt(signal.lfilter(np.ones(w) / w, [1], m ** 2))
    pk = env.max()
    i = int(np.argmax(env > pk * 10 ** (thresh_db / 20)))
    lo = pk * 10 ** ((thresh_db - 12) / 20)
    j = i
    while j > 0 and env[j] > lo and i - j < sr * 0.02: j -= 1
    return j

def highpass(x, sr, hz, order=4):
    sos = signal.butter(order, hz / (sr / 2), 'high', output='sos')
    return signal.sosfiltfilt(sos, x, axis=0)

def aligned(path, seconds=None, pre=0.0, f0=None):
    """A recording from its note's start. With f0, rumble below 0.6 f0 is filtered out first (the
    quiet Iowa recordings have more rumble than piano below 100 Hz)."""
    x, sr = load(path)
    if f0: x = highpass(x, sr, 0.6 * f0)
    i = max(0, onset(x, sr) - int(pre * sr))
    x = x[i:]
    if seconds: x = x[:int(seconds * sr)]
    return x, sr

def rms_db(x): return 10 * np.log10(np.mean(np.square(x)) + 1e-20)

def envelope_db(x, sr, win=0.02, hop=0.01):
    m = x.mean(axis=1) if x.ndim > 1 else x
    n, h = int(win * sr), int(hop * sr)
    t, v = [], []
    for s in range(0, len(m) - n, h):
        t.append((s + n / 2) / sr); v.append(rms_db(m[s:s + n]))
    return np.array(t), np.array(v)

def attack(x, sr):
    """Rise of the level from the start: ms to reach 10%, 50%, 90% and 100% of the peak of a 2 ms
    RMS envelope."""
    m = x.mean(axis=1) if x.ndim > 1 else x
    w = int(sr * 0.002)
    env = np.sqrt(signal.lfilter(np.ones(w) / w, [1], m[:int(sr * 0.25)] ** 2))
    pk = env.max(); ip = int(np.argmax(env))
    out = {}
    for f in (0.1, 0.5, 0.9):
        out[f] = 1000 * int(np.argmax(env >= f * pk)) / sr
    out[1.0] = 1000 * ip / sr
    return out

def spectrum(m, sr, t0, t1, pad=4):
    seg = m[int(t0 * sr):int(t1 * sr)]
    w = np.hanning(len(seg))
    n = 1 << int(np.ceil(np.log2(len(seg) * pad)))
    S = np.abs(np.fft.rfft(seg * w, n)) / (w.sum() / 2)
    return np.fft.rfftfreq(n, 1 / sr), S

def find_partials(m, sr, f0_guess, t0=0.03, t1=1.03, fmax=None, kmax=120):
    """Partial frequencies f_k = k f0 sqrt(1 + B k^2), found by following peaks up from the
    fundamental and refitting f0 and B as it goes. Returns f0, B, [(k, f, peak amplitude)]."""
    f, S = spectrum(m, sr, t0, t1)
    fmax = fmax or min(sr / 2 - 500, 16000)
    df = f[1] - f[0]
    f0, B = f0_guess, 0.0
    found = []
    def peak_near(fc, width):
        a, b = int((fc - width) / df), int((fc + width) / df) + 1
        a = max(a, 1); b = min(b, len(S) - 1)
        if b <= a: return None
        i = a + int(np.argmax(S[a:b]))
        if 0 < i < len(S) - 1:
            y0, y1, y2 = np.log(S[i - 1] + 1e-30), np.log(S[i] + 1e-30), np.log(S[i + 1] + 1e-30)
            d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 + 1e-30)
        else: d = 0
        return (i + d) * df, S[i]
    for k in range(1, kmax + 1):
        fc = k * f0 * np.sqrt(1 + B * k * k)
        if fc > fmax: break
        p = peak_near(fc, min(0.35 * f0, max(3.0, 0.02 * fc)))
        if p is None: continue
        found.append((k, p[0], p[1]))
        if len(found) >= 3:
            # refit f0, B on the stronger peaks so far: (f/k)^2 = f0^2 + f0^2 B k^2
            arr = np.array(found); top = arr[:, 2] > arr[:, 2].max() * 1e-3
            kk, ff = arr[top, 0], arr[top, 1]
            A = np.vstack([np.ones_like(kk), kk ** 2]).T
            c, *_ = np.linalg.lstsq(A, (ff / kk) ** 2, rcond=None)
            if c[0] > 0:
                f0n, Bn = np.sqrt(c[0]), max(0.0, c[1] / c[0])
                if abs(f0n / f0_guess - 1) < 0.03: f0, B = f0n, Bn
    return f0, B, found

def partial_levels(m, sr, partials, t0, t1):
    """Level (dB re full scale sine) of each partial in a time window, from a zero-padded spectrum
    (the peak within a few Hz of where the partial was found)."""
    f, S = spectrum(m, sr, t0, t1)
    df = f[1] - f[0]
    out = []
    for k, fk, _ in partials:
        w = max(2.5 / (t1 - t0), 0.004 * fk)
        a, b = max(1, int((fk - w) / df)), min(len(S) - 1, int((fk + w) / df) + 1)
        out.append(20 * np.log10(S[a:b].max() + 1e-12))
    return np.array(out)

def band_levels(m, sr, t0, t1, edges=(0, 125, 250, 500, 1000, 2000, 4000, 8000, 16000)):
    seg = m[int(t0 * sr):int(t1 * sr)]
    n = len(seg)
    P = np.abs(np.fft.rfft(seg * np.hanning(n))) ** 2
    f = np.fft.rfftfreq(n, 1 / sr)
    tot = np.sum(np.hanning(n) ** 2) * n / 2
    return np.array([10 * np.log10(P[(f >= a) & (f < b)].sum() / tot + 1e-20) for a, b in zip(edges[:-1], edges[1:])])

def centroid(m, sr, t0, t1):
    seg = m[int(t0 * sr):int(t1 * sr)]
    P = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
    f = np.fft.rfftfreq(len(seg), 1 / sr)
    return float((f * P).sum() / (P.sum() + 1e-30))
