"""Fit every Iowa piano note on disk and write the modal piano's data.
  uv run --with numpy --with scipy --with soundfile python tools/piano/build.py [out_dir]
Per note (from the ff recording): modes [f, decay, ampL, phaseL, ampR, phaseR, partial number],
`ramp` (ms over which the modes fade in, chosen to leave the least behind in the first 60 ms),
`soft` (per partial number: how many dB quieter it starts in the pp recording: a piano is linear
after the hammer, so playing softer only changes each partial's starting level), and the strike:
what the modes leave of the first 0.35 s, for ff and for pp (WAV files)."""
import sys, json, os, glob, re
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from pianolib import *
import fit as F

NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
def note_of(name): return NAMES.index(name[:-1]) + 12 * (int(name[-1]) + 1)
RAMPS = (0, 0.5, 1, 2, 3, 5, 8, 12, 18, 25)
STRIKE = 0.35

def ramped(y, sr, ms):
    n = int(ms * sr / 1000)
    if n < 2: return y
    g = np.ones(len(y)); g[:n] = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    return y * g[:, None]

def one(path, note):
    r = F.fit_tone(path, note)
    sr, x = r['sr'], r['x']
    n = int(1.0 * sr)
    y = F.synth([(f, d, c) for f, d, c, k in r['modes']], sr, n)
    m = int(0.06 * sr)
    errs = [np.sum((x[:m] - ramped(y, sr, ms)[:m]) ** 2) for ms in RAMPS]
    ramp = RAMPS[int(np.argmin(errs))]
    res = (x[:n] - ramped(y, sr, ramp))[:int(STRIKE * sr)]
    nf = int(0.15 * sr); res[-nf:] *= (0.5 + 0.5 * np.cos(np.pi * np.arange(nf) / nf))[:, None]
    # each partial's level over the first second, both channels (power)
    lev = {}
    ps = r['partials']
    L = [partial_levels(x[:, ch], sr, ps, 0.03, 1.0) for ch in (0, 1)]
    fitted = {k for *_, k in r['modes']}
    for i, (k, fk, _) in enumerate(ps):
        if k in fitted: lev[k] = float(10 * np.log10((10 ** (L[0][i] / 10) + 10 ** (L[1][i] / 10)) / 2))
    r.update(ramp=ramp, res=res, lev=lev, rms1=rms_db(x[:n]), left=rms_db(res[:m]) - rms_db(x[:m]))
    return r

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'recordings/piano/modal'
    os.makedirs(out, exist_ok=True)
    files = {m.group(1): 1 for f in glob.glob('recordings/piano/iowa/Piano.ff.*.aiff') if (m := re.search(r'ff\.(\w+)\.aiff', f))}
    for name in sorted(files, key=note_of):
        note = note_of(name)
        if os.path.exists(f'{out}/{note}.json') and '--redo' not in sys.argv: continue
        ff = one(f'recordings/piano/iowa/Piano.ff.{name}.aiff', note)
        ppf = f'recordings/piano/iowa/Piano.pp.{name}.aiff'
        pp = one(ppf, note) if os.path.exists(ppf) else None
        soft = {}
        if pp:
            for k, l in ff['lev'].items():
                if k in pp['lev']: soft[k] = round(pp['lev'][k] - l, 2)
            sf.write(f'{out}/{note}_pp.wav', pp['res'], pp['sr'], subtype='PCM_16')
        sf.write(f'{out}/{note}_ff.wav', ff['res'], ff['sr'], subtype='PCM_16')
        json.dump({'note': note, 'name': name, 'f0': ff['f0'], 'B': ff['B'], 'ramp': ff['ramp'], 'rampSoft': pp['ramp'] if pp else None,
                   'rms': ff['rms1'], 'rmsSoft': pp['rms1'] if pp else None, 'soft': soft,
                   'modes': [[round(f, 4), round(d, 4), float(f'{abs(c[0]):.4g}'), round(float(np.angle(c[0])), 3), float(f'{abs(c[1]):.4g}'), round(float(np.angle(c[1])), 3), k] for f, d, c, k in ff['modes']]},
                  open(f'{out}/{note}.json', 'w'))
        print(f'{name:4s} {note:3d} f0 {ff["f0"]:8.2f} ({1200 * np.log2(ff["f0"] / midi_hz(note)):+5.1f} c) B {ff["B"]:.1e} modes {len(ff["modes"]):3d} ramp {ff["ramp"]:4} ms, first 60 ms left over {ff["left"]:5.1f} dB | '
              + (f'pp: {pp["rms1"] - ff["rms1"]:6.1f} dB, partials {len(soft)}, ramp {pp["ramp"]}, left {pp["left"]:5.1f}' if pp else 'no pp'), flush=True)
