"""Compare piano renders with the real recordings (University of Iowa MIS Steinway), note by note.
  uv run --with numpy --with scipy --with soundfile python tools/piano/measure.py name=pattern ...
where pattern is a path with {note} (MIDI number) and {dyn} ('pp'/'ff') or {vel}, e.g.
  grand='test-data/audio/pianoab_grand_{note}_{vel}.wav'
Each render is cut at its note's start and level-matched to the recording (RMS of the first 2 s)
before anything is compared, so the numbers are about tone and shape, not loudness."""
import sys, json
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from pianolib import *

REAL = 'recordings/piano/iowa/Piano.{dyn}.{name}.aiff'
VEL = {'pp': 30, 'ff': 120}
WINDOWS = [(0.03, 0.5), (0.5, 1.5), (2.0, 4.0)]
BANDS = (0, 125, 250, 500, 1000, 2000, 4000, 8000, 16000)

def analyse(x, sr, note, ref=None):
    """Measurements of one tone (already cut at its start). With ref (the recording's analysis),
    partial levels are read at the recording's partial frequencies scaled by this tone's f0."""
    m = x.mean(axis=1)
    f0, B, ps = find_partials(m, sr, midi_hz(note))
    out = {'f0': f0, 'B': B, 'attack': attack(x, sr), 'partials': ps}
    t, e = envelope_db(x, sr, 0.05, 0.025)
    out['level'] = {s: float(np.interp(s, t, e)) for s in (0.1, 0.25, 0.5, 1, 2, 4, 8)}
    out['plev'] = [partial_levels(m, sr, ps, a, b) for a, b in WINDOWS]
    out['bands'] = [band_levels(m, sr, a, b, BANDS) for a, b in WINDOWS]
    out['centroid'] = [centroid(m, sr, a, b) for a, b in WINDOWS]
    out['rms2'] = rms_db(m[:2 * sr])
    return out

def partial_error(real, cand, floor=50):
    """Mean |difference| in dB over the recording's partials within `floor` dB of its strongest,
    per window. Partials are matched by number; a missing or very weak partial counts as 10 dB
    below the floor, so one absent partial can't cost more than 60 dB."""
    errs = []
    kc = {k: i for i, (k, _, _) in enumerate(cand['partials'])}
    for w in range(len(WINDOWS)):
        lr = real['plev'][w]; top = lr.max(); d = []
        for i, (k, _, _) in enumerate(real['partials']):
            if lr[i] < top - floor: continue
            if k not in kc: d.append(abs(top - floor - 10 - lr[i])); continue
            d.append(abs(max(cand['plev'][w][kc[k]], top - floor - 10) - lr[i]))
        errs.append(float(np.mean(d)) if d else float('nan'))
    return errs

def main():
    cands = dict(a.split('=', 1) for a in sys.argv[1:])
    summary = {}
    for name, note in NOTE.items():
        res = {}
        for dyn in ('pp', 'ff'):
            x, sr = aligned(REAL.format(dyn=dyn, name=name), 10, f0=midi_hz(note))
            real = analyse(x, sr, note)
            print(f'\n=== {name} {dyn} ===   real: f0 {real["f0"]:.2f} Hz, B {real["B"]:.2e}')
            rows = [('real', real)]
            for cn, pat in cands.items():
                y, sr2 = aligned(pat.format(note=note, dyn=dyn, vel=VEL[dyn], name=name), 10)
                g = 10 ** ((real['rms2'] - rms_db(y.mean(axis=1)[:2 * sr2])) / 20)
                c = analyse(y * g, sr2, note); c['gain_db'] = 20 * np.log10(g)
                rows.append((cn, c))
            print(f'{"":10s} attack ms 10% 50% 90% peak | level dB re 0.1 s at 0.5 1 2 4 8 s        | centroid Hz 0-.5 .5-1.5 2-4 s | partial error dB (3 windows) | B')
            for cn, c in rows:
                a = c['attack']; l = c['level']
                pe = partial_error(real, c) if cn != 'real' else [0, 0, 0]
                print(f'{cn:10s} {a[0.1]:5.1f} {a[0.5]:5.1f} {a[0.9]:5.1f} {a[1.0]:5.1f}      | ' + ' '.join(f'{l[s] - l[0.1]:6.1f}' for s in (0.5, 1, 2, 4, 8)) +
                      f'   | {c["centroid"][0]:6.0f} {c["centroid"][1]:6.0f} {c["centroid"][2]:6.0f}      | {pe[0]:5.1f} {pe[1]:5.1f} {pe[2]:5.1f}            | {c["B"]:.1e}')
                summary.setdefault(cn, []).append(pe)
            print('   octave bands, first 0.5 s, dB (candidates: difference from real):  ' + ' '.join(f'{b:>6}' for b in BANDS[1:]))
            for cn, c in rows:
                fl = real['bands'][0].max() - 60   # bands more than 60 dB under the strongest: not compared
                v = c['bands'][0] if cn == 'real' else np.maximum(c['bands'][0], fl) - np.maximum(real['bands'][0], fl)
                print(f'   {cn:10s}' + ' ' * 56 + ' '.join('     .' if real['bands'][0][i] < fl and (cn == 'real' or abs(d) < 0.05) else f'{d:6.1f}' for i, d in enumerate(v)))
            res[dyn] = dict(rows)
        print(f'\n--- {name}: soft to loud (pp -> ff; renders: velocity {VEL["pp"]} -> {VEL["ff"]}) ---')
        for cn in res['ff']:
            lp, lf = res['pp'][cn], res['ff'][cn]
            dl = (lf['rms2'] - lf.get('gain_db', 0)) - (lp['rms2'] - lp.get('gain_db', 0))
            print(f'   {cn:10s} level +{dl:5.1f} dB, centroid x{lf["centroid"][0] / lp["centroid"][0]:.2f} ({lp["centroid"][0]:.0f} -> {lf["centroid"][0]:.0f} Hz)')
    print('\n=== mean partial-level error, dB (all six tones; windows 0.03-0.5 s, 0.5-1.5 s, 2-4 s) ===')
    for cn, v in summary.items():
        if cn != 'real': print(f'   {cn:10s} ' + ' '.join(f'{d:5.1f}' for d in np.nanmean(np.array(v), axis=0)))

main()
