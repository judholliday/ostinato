"""Level-matched A/B listening files: the real recording, then each render, for each tone.
  uv run --with numpy --with scipy --with soundfile python tools/piano/ab.py out_dir name=pattern ...
Each tone is cut at its start, matched to the recording's level (RMS of the first 2 s) and the
whole group raised together so the recording peaks at -3 dBFS (the quiet ones are very quiet in
the files). 4 s each, half a second apart."""
import sys, os
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from pianolib import *
REAL = 'recordings/piano/iowa/Piano.{dyn}.{name}.aiff'
VEL = {'pp': 30, 'ff': 120}
SECS, GAP, SR = 4.0, 0.5, 44100

def clip(x, sr):
    n = int(SECS * sr); y = np.zeros((n, 2)); y[:min(n, len(x))] = x[:n]
    nf = int(0.3 * sr); y[-nf:] *= np.linspace(1, 0, nf)[:, None]
    return np.vstack([y, np.zeros((int(GAP * sr), 2))])

out = sys.argv[1]; cands = dict(a.split('=', 1) for a in sys.argv[2:])
os.makedirs(out, exist_ok=True)
runs = {c: [] for c in ['real', *cands]}
for name, note in NOTE.items():
    for dyn in os.environ.get('PIANO_DYNS', 'pp,ff').split(','):
        x, sr = aligned(REAL.format(dyn=dyn, name=name), 10, pre=0.01, f0=midi_hz(note))
        ref = rms_db(x.mean(axis=1)[:2 * sr]); up = 10 ** (-3 / 20) / np.abs(x[:int(SECS * sr)]).max()
        seq = [clip(x * up, sr)]; runs['real'].append(seq[0])
        for c, pat in cands.items():
            y, sr2 = aligned(pat.format(note=note, vel=VEL[dyn], dyn=dyn, name=name), 10, pre=0.01)
            g = 10 ** ((ref - rms_db(y.mean(axis=1)[:2 * sr2])) / 20) * up
            y = clip(y * g, sr2); pk = np.abs(y).max()
            if pk > 0.99: print(f'{name} {dyn} {c}: peak {pk:.2f} after matching, scaled down {20 * np.log10(0.99 / pk):.1f} dB'); y *= 0.99 / pk
            seq.append(y); runs[c].append(y)
        sf.write(f'{out}/{name}-{dyn}  real, {", ".join(cands)}.wav', np.vstack(seq), SR, subtype='PCM_24')
for i, (c, v) in enumerate(runs.items()):
    sf.write(f'{out}/all six tones - {i + 1} {c}.wav', np.vstack(v), SR, subtype='PCM_24')
