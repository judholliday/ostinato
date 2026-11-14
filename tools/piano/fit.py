"""Fit a piano tone as a sum of decaying sinusoids ("modes"), the data for a modal piano.
  uv run --with numpy --with scipy --with soundfile python tools/piano/fit.py
Method (the standard one for piano tones: Badeau/David's ESPRIT analysis, used for modal pianos by
Bank, Zambon & Fontana 2010): find the partials f_k = k f0 sqrt(1 + B k^2); shift each to 0 Hz and
low-pass it (a narrow band holding just that partial, both channels); fit that band with a few
complex exponentials by ESPRIT, which gives each one's exact frequency and decay rate; then the
levels and phases per channel by least squares. Two or three modes per partial is what a real
piano has (three strings, two directions of motion), and is what gives the fast-then-slow decay
and the slow beating. What the modes leave (the hammer's knock, noise) is kept as a short residual."""
import sys, json, os
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from pianolib import *

PRE = 0.1          # seconds kept before the note's start (to measure noise)
MAXT = 14.0        # seconds analysed
RES = 0.6          # seconds of residual kept

def bh4(n):
    k = np.arange(n) / (n - 1)
    return 0.35875 - 0.48829 * np.cos(2 * np.pi * k) + 0.14128 * np.cos(4 * np.pi * k) - 0.01168 * np.cos(6 * np.pi * k)

def band(x, sr, fk, tw):
    """One partial moved to 0 Hz and low-passed with a Blackman-Harris window tw seconds long
    (nulls every 4/tw Hz from +-4/tw out), then sampled 10/tw times a second."""
    n = int(tw * sr) | 1
    w = bh4(n); w /= w.sum()
    t = np.arange(len(x)) / sr
    z = x * np.exp(-2j * np.pi * fk * t)[:, None]
    hop = max(1, int(sr * tw / 10))
    out = np.stack([signal.fftconvolve(z[:, c], w, mode='same')[::hop] for c in range(x.shape[1])], axis=1)
    return out, sr / hop

def esprit(Y, M, L=None):
    """Poles of M complex exponentials shared by the columns of Y (samples x channels)."""
    N = Y.shape[0]; L = L or min(N // 2, 240)
    H = np.hstack([np.lib.stride_tricks.sliding_window_view(Y[:, c], L).T for c in range(Y.shape[1])])
    U, s, _ = np.linalg.svd(H, full_matrices=False)
    Us = U[:, :M]
    return np.linalg.eigvals(np.linalg.pinv(Us[:-1]) @ Us[1:]), s

def amplitudes(Y, z):
    V = z[None, :] ** np.arange(Y.shape[0])[:, None]
    a, *_ = np.linalg.lstsq(V, Y, rcond=None)
    return a, V @ a

def fit_partial(x, sr, fk, f0, max_modes=4):
    tw = max(4 / f0, 0.04)
    Y, fd = band(x, sr, fk, tw)
    i0 = int(round((PRE + tw / 2) * fd))                     # the window is wholly inside the note
    mag = np.sqrt((np.abs(Y) ** 2).mean(axis=1))
    noise = np.sqrt((mag[:max(2, int((PRE - tw / 2) * fd))] ** 2).mean())
    # the tone ends where its smoothed level is last 8 dB over the noise (the first dip won't do:
    # strings beating against each other can dip to the noise and come back)
    sm = signal.lfilter(np.ones(8) / 8, [1], mag)
    above = np.nonzero(sm[i0:int((PRE + MAXT) * fd)] > noise * 2.5)[0]
    i1 = min(len(Y), i0 + (above[-1] + 1 if len(above) else 0))
    if i1 - i0 < max(24, 0.25 * fd): return [], None
    seg = Y[i0:i1]
    env = np.sqrt((np.abs(seg) ** 2).mean(axis=1))
    w = (signal.lfilter(np.ones(6) / 6, [1], env) + 2 * noise) ** -0.6   # weights: care for the quiet parts too, not only the loud start
    tt = np.arange(len(seg)) / fd
    wt = 1 / (tt + 0.1); wt /= wt.sum()                                  # errors count per octave of time, not per second
    def clean(z):
        d = -np.log(np.abs(z)) * fd
        df = np.angle(z) * fd / (2 * np.pi)
        return z[(d > 0.02) & (d < 120) & (np.abs(df) < 0.9 * (2 / tw))]
    def score(z):
        V = z[None, :] ** np.arange(len(seg))[:, None]
        a, *_ = np.linalg.lstsq(V * w[:, None], seg * w[:, None], rcond=None)
        model = V @ a
        em = 20 * np.log10(np.sqrt((np.abs(model) ** 2).mean(axis=1)) + noise)
        er = 20 * np.log10(env + noise)
        return float(np.sum(wt * np.abs(em - er))) + 0.35 * len(z), a, model   # each extra mode must buy 0.35 dB
    best = None
    for M in range(1, max_modes + 1):
        if len(seg) < 12 * M: break
        z = clean(esprit(seg, M)[0])
        if not len(z): continue
        err, a, model = score(z)
        # the loud start decides an ESPRIT fit; what it leaves of the late ring gets modes of its own
        half = len(seg) // 2
        if len(seg) - half > 40:
            z2 = clean(esprit((seg - model)[half:], 1)[0])
            if len(z2) and np.min(np.abs(z2[:, None] - z[None, :])) > 1e-4:
                e2, a2, m2 = score(np.concatenate([z, z2]))
                if e2 < err: z, err, a = np.concatenate([z, z2]), e2, a2
        if best is None or err < best[0]: best = (err, z, a)
    if best is None: return [], None
    _, z, a = best
    d = -np.log(np.abs(z)) * fd
    delta = np.angle(z) * fd / (2 * np.pi)
    # the fit's time 0 is sample i0 of a cut that starts PRE before the note; x(tau) = 2 Re{c e^{(-d + j 2 pi f) tau}}
    # from the note's start tau = 0, with c = a e^{(-d + j 2 pi delta)(PRE - i0/fd)} e^{j 2 pi fk PRE}
    modes = []
    for m in range(len(z)):
        c = a[m] * np.exp((-d[m] + 2j * np.pi * delta[m]) * (PRE - i0 / fd)) * np.exp(2j * np.pi * fk * PRE)
        modes.append((float(fk + delta[m]), float(d[m]), c))
    return modes, (i1 - i0) / fd

def synth(modes, sr, n, nch=2):
    t = np.arange(n) / sr
    y = np.zeros((n, nch))
    for f, d, c in modes:
        e = np.exp((-d + 2j * np.pi * f) * t)
        for ch in range(nch): y[:, ch] += 2 * np.real(c[ch] * e)
    return y

def fit_tone(path, note, kmax=140):
    f0n = midi_hz(note)
    x, sr = load(path)
    x = highpass(x, sr, min(0.6 * f0n, 60))
    on = onset(highpass(x, sr, 0.6 * f0n), sr)
    x = x[max(0, on - int(PRE * sr)):][:int((PRE + MAXT + 0.5) * sr)]
    if on < PRE * sr: x = np.vstack([np.zeros((int(PRE * sr) - on, 2)), x])
    m = x[int(PRE * sr):].mean(axis=1)
    f0, B, ps = find_partials(m, sr, f0n, kmax=kmax)
    modes = []
    for k, fk, _ in ps:
        ms, dur = fit_partial(x, sr, fk, f0)
        for f, d, c in ms: modes.append((f, d, c, k))
    return {'f0': f0, 'B': B, 'sr': sr, 'x': x[int(PRE * sr):], 'modes': modes, 'partials': ps}

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'recordings/piano/fit'
    os.makedirs(out, exist_ok=True)
    for name, note in NOTE.items():
        for dyn in ('ff', 'pp'):
            r = fit_tone(f'recordings/piano/iowa/Piano.{dyn}.{name}.aiff', note)
            sr, x = r['sr'], r['x']
            n = min(len(x), int(10 * sr))
            y = synth([(f, d, c) for f, d, c, k in r['modes']], sr, n)
            res = x[:n] - y
            def db(v): return 10 * np.log10(np.mean(v ** 2) + 1e-20)
            print(f'{name} {dyn}: f0 {r["f0"]:.2f} B {r["B"]:.2e} partials {len(r["partials"])} modes {len(r["modes"])}')
            for a, b in ((0, 0.02), (0.02, 0.1), (0.1, 0.5), (0.5, 2), (2, 5), (5, 10)):
                s = slice(int(a * sr), int(b * sr))
                print(f'   {a:5.2f}-{b:5.2f} s: tone {db(x[s]):6.1f} dB, model {db(y[s]):6.1f}, left over {db(res[s]):6.1f}')
            sf.write(f'{out}/{name}_{dyn}_model.wav', y, sr, subtype='PCM_24')
            sf.write(f'{out}/{name}_{dyn}_real.wav', x[:n], sr, subtype='PCM_24')
            nr = int(RES * sr); fade = np.ones(nr); nf = int(0.2 * sr); fade[-nf:] = 0.5 + 0.5 * np.cos(np.pi * np.arange(nf) / nf)
            sf.write(f'{out}/{name}_{dyn}_residual.wav', res[:nr] * fade[:, None], sr, subtype='PCM_24')
            json.dump({'note': note, 'dyn': dyn, 'f0': r['f0'], 'B': r['B'],
                       'modes': [[f, d, abs(c[0]), float(np.angle(c[0])), abs(c[1]), float(np.angle(c[1])), k] for f, d, c, k in r['modes']]},
                      open(f'{out}/{name}_{dyn}.json', 'w'))
