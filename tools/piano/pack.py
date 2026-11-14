"""Pack the fitted notes (build.py's output) into the two files the Sound Lab's Piano module loads:
  pianos/steinway-b.json     per note: pitch, fade-in, soft-to-loud level, modes
                             [f, decay, ampL, phaseL, ampR, phaseR, dB quieter when soft] (flat)
  pianos/steinway-b.strikes  the strikes: 16-bit stereo 44.1 kHz, one after another, each at full scale
  uv run --with numpy --with scipy --with soundfile python tools/piano/pack.py
Iowa's notes aren't evenly loud, nor evenly "pp": each note's level and its soft-to-loud
difference are moved to a straight line through all the notes (dB against key), by at most 8 dB."""
import sys, json, os
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from pianolib import *
SRC, OUT = 'recordings/piano/modal', 'pianos'
notes = [json.load(open(f'{SRC}/{n}.json')) for n in range(21, 109, 3)]
have_soft = [d for d in notes if d['rmsSoft'] is not None]
for d in notes:
    if d['rmsSoft'] is None:                      # recorded only loud: borrow the nearest note's soft-to-loud differences
        o = min(have_soft, key=lambda q: abs(q['note'] - d['note']))
        d['soft'] = o['soft']; d['rmsSoft'] = d['rms'] + o['rmsSoft'] - o['rms']; d['rampSoft'] = d['ramp']
xs = np.array([d['note'] for d in notes])
lv = np.polyfit(xs, [d['rms'] for d in notes], 1); df = np.polyfit(xs, [d['rmsSoft'] - d['rms'] for d in notes], 1)
clamp = lambda v: float(max(-8, min(8, v)))
blob, out = [], []
for d in notes:
    n = d['note']
    trim = clamp(np.polyval(lv, n) - d['rms']); move = clamp(np.polyval(df, n) - (d['rmsSoft'] - d['rms']))
    g = 10 ** (trim / 20)
    soft = {int(k): v + move for k, v in d['soft'].items()}
    ks = np.array(sorted(soft)); vs = np.array([soft[k] for k in ks])
    slope = min(0.0, np.polyfit(ks, vs, 1)[0]) if len(ks) > 1 else 0.0
    soft_of = lambda k: soft.get(k, min(vs.min(), vs.mean() + slope * (min(k, ks.max() * 2) - ks.mean())))   # too quiet to measure when soft: carry on the trend
    modes = []
    for f, dec, aL, pL, aR, pR, k in d['modes']:
        modes += [round(f, 3), round(dec, 3), float(f'{aL * g:.4g}'), pL, float(f'{aR * g:.4g}'), pR, round(float(soft_of(k)), 1)]
    def strike(dyn, gain):
        p = f'{SRC}/{n}_{dyn}.wav'
        if not os.path.exists(p): return None
        x, sr = load(p); assert sr == 44100
        pk = np.abs(x).max(); start = sum(len(b) for b in blob) // 4
        blob.append(np.round(x / pk * 32767).astype('<i2').tobytes())
        return [start, len(x), float(f'{pk * gain:.5g}')]
    out.append({'note': n, 'f0': round(d['f0'], 4), 'ramp': d['ramp'], 'rampSoft': d['rampSoft'], 'soft': round(d['rmsSoft'] - d['rms'] + move, 2),
                'modes': modes, 'ff': strike('ff', g), 'pp': strike('pp', g * 10 ** (move / 20))})
os.makedirs(OUT, exist_ok=True)
json.dump({'about': 'Modes and strikes fitted to the University of Iowa Musical Instrument Samples piano (Steinway model B, recorded 2001; theremin.music.uiowa.edu/MIS.html). Made by tools/piano.',
           'rate': 44100, 'notes': out}, open(f'{OUT}/steinway-b.json', 'w'), separators=(',', ':'))
open(f'{OUT}/steinway-b.strikes', 'wb').write(b''.join(blob))
print(len(out), 'notes,', sum(len(o['modes']) // 7 for o in out), 'modes;', os.path.getsize(f'{OUT}/steinway-b.json') // 1024, 'kB +', os.path.getsize(f'{OUT}/steinway-b.strikes') // 1024, 'kB')
