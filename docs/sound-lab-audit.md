# Sound Lab audit: imitations of real instruments (Nov 2026)

The Grand Piano was rebuilt in Oct 2026 after it turned out to sound nothing like a piano: it had been built from general knowledge and only checked for internal consistency. This audit looks for the same gap in the other modules and factory sounds that imitate a real instrument or a classic device. It is read-only: no code was changed.

Method: the code was read, and what an imitation claims was compared with the published synthesis methods and measurements (sources inline). Where it was cheap, factory sounds were rendered offline in the page (`OfflineAudioContext` + `LabSynth`, editor-test server) and measured: band energies, harmonic levels, spectral peaks in the attack (first 46 ms) and later, zero-crossing pitch and RMS envelope after spin-up for the Rotary. To isolate the added parts, each sound was rendered with modules removed (reverb, rotary, drive).

The user's listening notes are treated as ground truth. The bare Drawbar organ module sounds the most like an organ of anything, so the B3 problems were looked for in what is added on top of it.

## Ranking

| # | Item | Claims to be | Gap (to the ear) | Main missing ingredients | Effort |
|---|---|---|---|---|---|
| 1 | **B3 Jazz / Gospel / Rock Drive / Ballad** (organ + Rotary) | Hammond B3 through a Leslie 122 | **Large, mostly in the Rotary** | Rotary's built-in amp clips everything (Drive 0.15 = tanh with small-signal gain 5: +8 dB, chords heavily intermodulated); a ~10 dB hole at the 800 Hz crossover; spin-up/down ~3× too slow and symmetric; one signal panned instead of two mic positions with cabinet reflections; no scanner vibrato/chorus; perfectly harmonic drawbars (no tonewheel tuning); percussion fires on every note and fades 2–3× too fast | S for the drive and crossover, M for the rest |
| 2 | **Church Organ** | Pipe organ, 16'–2' flue chorus | **Large** | No principal (diapason) tone: built from sine and triangle waves (a triangle has odd harmonics only, falling 12 dB/oct; a principal has a strong 2nd harmonic and falls ~6 dB/oct to about the 4th–5th); 16' as loud as the 8'; every harmonic and rank starts together on one 90 ms linear ramp (pipes speak over 20–50 periods, harmonics at different times, with a chiff); no pipe noise or ranks drifting against each other; the 7 s hall at mix 0.45 covers it all | M |
| 3 | **Combo Organ** | Vox Continental / Farfisa | **Large ("very buzzy")** | Raw square + sawtooth + sub square through a 3.8 kHz low-pass that key-tracks upward (5.4 kHz at C5): energy above 4 kHz is only −15 dB at C5. The real organs are square-wave dividers; the flute voices are filtered toward sines, and only the reed or bright tabs are unfiltered. There is no sawtooth in a Vox | S |
| 4 | **Tine Piano**, **FM Tine 80s** | Rhodes; DX7 E.PIANO 1 | **Large** | The tine's bell partial (the 13×/15× FM sidebands) is ~45 dB below the fundamental even in the first 46 ms, so it can't be heard. A Rhodes' timbre comes mainly from the pickup's nonlinearity and the tine's inharmonic overtones, and neither is modelled | S to make the tine audible; L for a pickup model |
| 5 | **Vibraphone** | Vibraphone | Medium–large | Partials at 1, 3, 5 (−38 dB); a vibe's bars are tuned 1 : 4 : 10. Decays ~7 dB/s at C3, where a real vibe rings ~30 s in the bass (≈2 dB/s) | S (additive modes) |
| 6 | **Wurly** | Wurlitzer 200A | Medium | Measured the richest and most plausible of the EPs (the shaper gives a reed-like harmonic series). Missing: the electrostatic pickup's dC/dt nonlinearity (bark that grows with amplitude and decays with it), the reed's inharmonic attack | M |
| 7 | **Marimba** | Marimba | Medium | 1 : 4 is there (−13 dB in the attack); the third mode (≈9.2–10×) is missing (−59 dB). Decay per mode not modelled (only two envelopes) | S |
| 8 | **Accordion** | Accordion, musette | Medium | Musette detune is 12 cents fixed across the keyboard; French musette is 18–25 c, and the detune in cents should shrink going up (a near-constant beat rate). Saw reeds instead of the peaky free-reed pressure wave; no bellows dynamics | S–M |
| 9 | **808 Kit metal (hats, cymbal)** | TR-808 | Small–medium | The six oscillators are right (205.3, 304.4, 369.6, 522.7, 540, 800 Hz). After them the 808 has two band-passes at ≈3.44 kHz and ≈7.1 kHz with separate envelopes and VCAs per band; here there is a single high-pass | S |
| 10 | **Reverb impulses** | Rooms, halls, plates | Small–medium | The decaying noise tail is an accepted method and dense enough. Missing: decay set per band (one sliding one-pole low-pass can't make the bass ring longer or roll the highs off steeply); early reflections are the same few spikes for every size; the two sides are uncorrelated from the first sample | M |
| 11 | Toy Piano, Granular | Toy piano; a texture tool | Small / n.a. | The toy piano's inharmonic 2.53× and 4.53× partials are plausible for metal rods (a clamped bar is 1 : 6.27 : 17.6, but toy pianos vary). Granular doesn't imitate an instrument, so it was skipped | — |

Already researched and measured, so not re-audited: Grand/Felt/Honky-Tonk pianos, Soundboard, Pedal resonance, String module instruments, the 808 Kit's non-metal pads, the Struck cowbell.

Note: the factory sound called **Drawbar Organ** (a starter) is four oscillators + chorus, not the Drawbar organ module. The user's praise is taken to mean the module; if they meant the starter, the conclusions about the B3 sounds still hold.

---

## 1. B3 sounds (organ + Rotary)

**What it is.** `organ()` in `js/lab/keys.js`: the Drawbar organ module (`click 0.35`, percussion where given), an optional tube Distortion (Gospel drive 2, Rock Drive 9), a Rotary (`depth 0.75, balance 0.55, drive 0.15, inertia 1`) and a room reverb at 0.14.

### 1a. The Rotary's amp clips every B3 sound (the biggest problem, and the cheapest) — fixed Nov 2026
`driveCurve()` (engine.js:85) is `tanh(k·x)/tanh(k)` with `k = 0.5 + 30·drive`. At the B3's "light" **Drive 0.15**, k = 5: the small-signal gain is ×5 (+14 dB) and anything above ~0.2 is clipped. Measured with the rotor stopped (depth 0), B3 Jazz (888000000 + 3rd perc) at 0.8 s, energy in the 800–2000 Hz band relative to the whole:

| | drive 0 | drive 0.15 |
|---|---|---|
| C4 alone | −51 / −86 dB | −23 / −24 dB |
| C–E–G | −33 / −33 dB | −16 / −16 dB |
| C3 + C–E–G–B | −26 / −28 dB | −17 / −15 dB |

888000000 at C4 is 65, 196 and 262 Hz (16', 5⅓', 8'); its only higher component, the 785 Hz percussion, has faded by 0.8 s. So at drive 0.15 everything in those bands is distortion. On a single 8' sine: third harmonic −48 dB, fifth −43 dB, gain +8 dB against no rotary. Chords make intermodulation products that aren't harmonics of any note, which is the "doesn't sound very good" of a clean jazz registration.

A real 122's tube amp overdrives only when the organ's expression pedal is pushed hard; the jazz and ballad sounds should be clean. Fix: make Drive 0 truly clean (unity gain), scale the curve so ~0.15 means a few percent THD at normal level, and default the Rotary's Drive to 0. Effort: S.

### 1b. A notch at the crossover — fixed Nov 2026
The Rotary splits at 800 Hz with one 2nd-order Butterworth low-pass and one high-pass and sums them. Those two sum to a notch at the crossover. Measured with depth 0 (sine levels in dB): 196 Hz −6.3, 392 Hz −7.7, **784 Hz −16.9, 831 Hz −14.0**, 1568 Hz −5.0, so about −10 dB around 800 Hz. That's G5's fundamental and the 2nd–4th harmonics of mid-keyboard notes. A real Leslie sums acoustically (horn and drum are different sources), and Pekonen et al. use 4th-order (Linkwitz-Riley-like) filters at 800 Hz [Pekonen, Pihlajamäki, Välimäki, DAFx 2011, https://dafx.de/paper-archive/2011/Papers/49_e.pdf; Henricksen 1981: 800 Hz, 12 dB/oct passive, https://dannychesnut.com/Music/Leslie/LeslieMystery.html]. Fix: Linkwitz-Riley 4th order (two cascaded Butterworths per side), which sums flat. Effort: S.

### 1c. Speed changes too slow and symmetric — fixed Nov 2026
Speeds are right: horn 0.8 / 6.7 Hz, drum 0.67 / 5.8 Hz vs ~48–50 / 400 rpm and 40 / 340 rpm [Wikipedia, Leslie speaker; forums.musicplayer.com/topic/84960]. But the inertia is a critically damped 2nd-order low-pass (Q 0.5, τ = Inertia = 1 s): 90% of a change takes 3.9 s for the horn and 11.7 s for the drum, the same up and down. Reported times (practitioner sources only; no peer-reviewed measurement found): horn up ~1–1.5 s, down ~1.5–2 s; drum up ~5 s, down ~7–7.5 s [mantor.info/leslie-page; two-notes.com/en/?p=106061; forums.musicplayer.com/topic/115116]. Herrera, Hanson & Abel (AES 127, 2009) use first-order dynamics with separate rise and fall constants. The fast/slow switch is the most played gesture on a B3: here the horn takes ~3× too long to arrive. Fix: first-order lag (or a slew) with separate up/down times, horn ~1.2/1.8 s, drum ~5/7 s. Effort: S.

### 1d. One signal panned, not a cabinet recorded in stereo — done Nov 2026
Each rotor is one sine LFO driving one delay (Doppler), one gain (AM) and one panner (cosine). Measured after spin-up: horn alone ±45 cents at fast, ±7.5 c at slow, AM 11 dB; drum ±15 c fast, AM 4.3 dB. Both channels have the same pitch wobble and AM; only the pan moves. Published:
- Doppler: a ~0.25 m horn at 400 rpm gives about ±53 c (derived from the 20-inch circle in nshos.com/LES4.htm); ±45 c is in range.
- The drum is a rotating scoop in front of a fixed woofer, so it's mostly AM between 200 and 800 Hz and little Doppler [Henricksen]. ±15 c is probably too much.
- Smith, Serafin, Abel & Berners [DAFx 2002, https://ccrma.stanford.edu/~jos/doppler/doppler.pdf] model it as one time-varying delay and filter per mic for the direct path and for each cabinet reflection, every one with its own Doppler. That spread of slightly different shifts is the Leslie's chorus. The horn's directivity is measured (their Fig. 7) and is frequency-dependent: highs are beamed more, so AM deepens with frequency. The horn's base also leaks unrotated sound.
- Pekonen's cheap model uses only ~0.9 dB of AM. No published single AM figure was found; 11 dB of broadband sinusoidal AM is likely too deep and too uniform.

Fix: per rotor, 2–4 delay taps (direct + reflections) per output channel with phase offsets (two mics 90°–180° apart), AM through a gentle frequency-dependent filter (a low-pass whose cutoff swings) rather than a broadband gain, the drum's Doppler cut. Effort: M.

### 1e. The organ module itself (fine on its own, but missing B3 traits)
These matter less than 1a–1d, since the user hears the bare module as an organ:
- **Tonewheel tuning:** every bar is an exact harmonic. On a B3 the 5⅓', 2⅔' and 1⅓' are ~1.4–2 c flat and the **1⅗' is ~14 c sharp** (a tempered major third), so registrations with the 1⅗' slowly beat [gear ratios: electricdruid.net/technical-aspects-of-the-hammond-organ; en.xen.wiki/w/Just_Hammond]. One PeriodicWave can't detune partials, so this needs separate oscillators for the off-ratio bars (2–4 extra per note). Effort: S–M.
- **Scanner vibrato/chorus (V1–3, C1–3):** a tapped LC delay line (~1 ms, 9 stages) scanned at ~6.9 Hz with a triangle-like sweep, chorus = mixed with the dry signal [Hammond-Leslie FAQ, theatreorgans.com/hammond/faq; stefanv.com/electronics/hammond_vibrato_mod.html]. C3 + slow Leslie is the classic jazz sound and isn't available. A global effect: modulated delay ≈1 ms, triangle 6.9 Hz, mix 0 or 0.5. Effort: S.
- **Percussion:** fires on every note. The real one is single-trigger: it only fires when all keys were up, so legato playing gets no percussion. It also takes the 1' contact (that drawbar goes silent) and at Normal volume drops the drawbars ~3 dB [FAQ; Hammond SK manual]. Decay here is τ 0.07 s / 0.2 s (−60 dB at 0.48 s / 1.4 s); published "fast about 1 s, normal about 4 s" (FAQ; an A-105 measured ~1 s and ~5 s). Even if those are times to inaudibility, ours are 2–3× short. Single-trigger needs voice-level knowledge of other held notes (the LabSynth knows). Effort: S.
- **Key click:** band-passed noise at 2.5 kHz, τ 3 ms, the same every note. On the organ the click is the nine busbar contacts closing at different times and bouncing over a few ms, so each harmonic switches on separately with bounces and the click takes the registration's colour [Moro, McPherson & Sandler, JASA 142(5):2808, 2017]. Fix: start each drawbar's partial at its own random 0–3 ms offset with a few on/off bounces (separate gains per bar, or a click buffer made from the registration). Effort: M.
- Leakage (a quiet bed of neighbouring wheels), 16' and 1' foldback, and the near-square low wheels are small refinements. Effort: S each.

### 1f. Drive (Gospel, Rock Drive)
A static tanh "tube" curve before the Rotary. A real Leslie's overdrive is in its own amp, after the preamp, and responds to the expression pedal. Once 1a is fixed, the drive here could live in the Rotary (one stage, level-dependent) rather than as a separate Distortion. Low priority until 1a–1d are done.

---

## 2. Church Organ

**What it is.** Oscillators: 16' sine 0.4, 8' triangle 0.45, 4' triangle 0.25, 2' sine 0.15, a quiet saw at the 2⅔' (0.06), wind noise 0.015, a 12 dB low-pass at 4 kHz, one Amp (attack 0.09 s linear), a 7 s hall at mix 0.45.

**Measured** (dry, C3/C4/C5, harmonics of the 16'): 16' 0 dB, 8' −1 dB, 4' −6 dB, 2' −9 dB, the 8' triangle's 3rd harmonic −15 to −22 dB, everything else below −30 dB. Above 1 kHz at C3: −30 dB. It's a flute/sine stack with the sub as loud as the unison.

**Published.** The core of a church organ is the principal chorus [Angster, *Acoustics Today* 2017, https://acousticstoday.org/wp-content/uploads/2021/08/Acoustics-of-Organ-Pipes-and-Future-Trends-in-the-Research-Judit-Angster-1.pdf; Pykett, colinpykett.org.uk/effect-of-organ-pipe-scale-on-harmonic-spectra.htm]:
- Principals have a strong 2nd partial, especially in the attack, and an Open Diapason's harmonics fall ~6 dB/oct up to about the 4th–5th, then ~23 dB/oct.
- Flutes are near-sines. Stopped pipes have a strong 3rd and 5th. Strings have more than 20 partials and a weak fundamental.
- Speech: steady level after 20–50 periods, 20–80% rise times of 36–182 ms for one pipe voiced different ways. Low pipes therefore speak slower in absolute time. Lower modes can sound briefly out of tune during the transient (the chiff). [Rioux thesis, articles.ircam.fr/textes/Rioux01b; Fletcher 1976; DAGA 2016]
- Broadband flue noise near the pipe's resonances forms the spectrum's floor.
- Pure-tuned mixtures beat against tempered unisons.

**Missing, ranked:**
1. A principal tone per rank: about 8–12 harmonics at −6 dB/oct with a strong 2nd. The Drawbar organ module's PeriodicWave approach would do it, one wave per rank.
2. Balance: 8' principal loudest, 16' well below it, 4' and 2' each a few dB down, plus a mixture.
3. Speech: rise over ~30 periods (key-tracked), the upper harmonics a little earlier or later than the fundamental, a short chiff (noise band-passed at a harmonic, or an overblown 2nd-mode blip).
4. Per-pipe detune of a few cents and a slow random wobble, and pipe noise shaped around the harmonics rather than one white floor.
5. Less reverb: once the dry sound is right, 0.45 wet will be too much.

Effort: M. One module ("Pipe rank": footage, tone family, speech time, chiff), or several PeriodicWave oscillators and envelopes in the patch.

---

## 3. Combo Organ ("very buzzy")

**What it is.** Square (8') 0.4 + sawtooth (4') 0.25 + square (16') 0.2, a 12 dB low-pass at 3.8 kHz with key tracking 0.5, vibrato 6.5 Hz ±14 c, an Amp, a room.

**Measured** (dry): harmonics fall only ~6 dB/oct up past the 16th (C4: harmonics 8–16 at −20 to −35 dB). Energy above 4 kHz is −31 dB at C3, −22 dB at C4 and −15 dB at C5. The filter opens upward (5.4 kHz at C5), so the high notes are the buzziest.

**Published.**
- Vox Continental: 12 top-octave oscillators divided down by flip-flops into square waves, drawbars 16', 8', 4' and IV (mixture), with the flute drawbar filtered and the reed drawbar unfiltered [Wikipedia, Vox Continental (Lenhoff & Robertson 2019); sandsoftwaresound.net]. There is no sawtooth.
- Farfisa: square waves through passive voice-tab filter networks; the vibrato FMs the master oscillator [bustedgear.com Farfisa dividers].
- Vibrato rates and filter cutoffs aren't published; the service schematics are the next source.

**Missing:**
1. Replace the sawtooth with squares (4' and the IV mixture: 2⅔', 2', 1⅗' or similar).
2. A flute voice that is the square through a low-pass a little above the fundamental, key-tracked at 1.0 (near-triangle or sine), with the bright reed only as an option.
3. A fixed treble roll-off that doesn't track up (the amp/speaker, ~3–5 kHz).
4. Optional: the divider's phase-locking between octaves (free here, since each oscillator starts at phase 0).

Effort: S (patch only).

---

## 4. Tine Piano and FM Tine 80s

**What they are.** FM operator pairs: a 1:1 carrier with a 1:1 modulator for the body, plus a ratio-14 "tine" operator (Tine Piano: into op1 at level 0.3, decay 0.09 s; FM Tine 80s: a separate 1:1 carrier "glass" with a ×14 modulator), then tremolo, chorus and reverb.

**Measured** (dry, C4/C5, first 46 ms): harmonics 1 (0 dB), 2 (−9), 3 (−24), 4 (−42), and the tine sidebands 13× and 15× at **−45 to −46 dB**. By 100–146 ms: −58 dB (80s) and −84 dB (Tine). The tine bell can't be heard under the fundamental. In the DX7 E.PIANO 1 (algorithm 5; one pair 1:1, one pair 1:14 [muzines.co.uk/articles/yamaha-dx7/4733]) the tine pair is plainly audible in the attack. The other operator values aren't sourced: read voice 11 of a ROM1A dump to get them.

**Published (Rhodes).**
- The tine plus tonebar form an asymmetric tuning fork; the tine's first overtone is several times f0 and inharmonic (the bell).
- The electromagnetic pickup's nonlinearity makes most of the timbre. Moving the tine's rest point toward the pickup axis lowers the fundamental and odd harmonics until the 2nd dominates. [Shear & Wright, NIME 2011, https://mat.ucsb.edu/Publications/Shear_Wright_NIME_2011.pdf]
- The tine tip moves nearly sinusoidally while the pickup output is complex. [Pfeifle & Bader, DAFx 2017, https://www.dafx17.eca.ed.ac.uk/papers/DAFx17_paper_79.pdf]
- The "bark" is the pickup saturating as the tine's amplitude grows, so it comes with loudness and fades as the note decays.

**Missing, ranked:**
1. An audible tine transient: an inharmonic partial (several × f0, key-tracked), −10 to −20 dB, decaying in tens of ms. A level/fm change gets the FM Tine 80s there; Tine Piano needs a separate partial, not FM sidebands.
2. A pickup nonlinearity applied per voice after a near-sine "tine": a waveshaper whose curve depends on an offset (the alignment), so the harmonics follow the note's amplitude and decay. That gives velocity bark without extra FM, and a mellower tail. A per-voice WaveShaper is cheap in Web Audio.
3. The tonebar's beating partial (several hundred to 1400 c from the tine [Muenster & Pfeifle, ISMA 2014]) and the tine moving in two planes: small refinements.

Effort: S for (1) as a patch change; M for a "tine + pickup" voice (an oscillator and a key-tracked asymmetric shaper per note, maybe a module option).

---

## 5. Vibraphone

**What it is.** FM, ratio 4 modulator into a 1:1 carrier (index ~0.35), decay 3.5 s, motor tremolo 5 Hz depth 0.4, plate.

**Measured.** Partials 1, 3 and 5 at −38 dB in the attack, −52 dB by 0.1 s; nothing at 4× or 10×. An FM ratio of 4 makes sidebands at |1 ± 4k| (3, 5, 7…), not 4. The fundamental falls 14 dB in 2 s at C3 (~7 dB/s).

**Published.** Vibraphone and marimba bars are tuned 1 : 4 : ~10 [Bork 1995; euphonics.org/3-3-marimbas-and-xylophones]. The upper modes decay faster than the fundamental. Sustain is ~30 s in the bass to ~6 s on top (vibesworkshop.com, practitioner). The motor turns 0–12 rev/s (Yamaha's driver: 30–145 rpm). Resonators reinforce the fundamental and can lengthen its decay. Decays per mode (Chaigne & Doutaut, JASA 1997) weren't accessible.

**Missing:**
1. Modes at 1, 4 and 10 (sines, or one PeriodicWave per mode with its own envelope), the 4th about −10 to −20 dB at the strike, both upper modes decaying several times faster.
2. Fundamental decay ~25 s at C3 falling to ~6 s on top (`keytrack` on the decay).
3. Tremolo as true AM of the resonated fundamental (deep, ~1–8 Hz, optional), with the upper modes less affected (they aren't resonated).
4. A soft mallet thump.

Effort: S (patch only with oscillators + envs; a "modal bar" module would also serve marimba, xylophone and glockenspiel).

---

## 6. Wurly

**What it is.** FM 1:1 pairs plus a ratio-3 "reed" transient, a tube shaper (drive 2.5, tone 4.5 kHz), AM 5.6 Hz, room.

**Measured.** A full harmonic series (C4 attack: h2 −7, h3 −20, h4 −30, h5 −27, h6 −30, h7 −37 dB; at 0.1 s h2 −8, h3 −24), decaying slowly. It's the most plausible of the three EPs.

**Published.** The reed's electrostatic pickup gives a current ∝ dC/dt [Pfeifle & Bader]: the waveform is a strongly nonlinear function of the reed's displacement, its harmonics grow with amplitude and fade as the note decays. The service manual's vibrato oscillator is 5.75 Hz (for the 200/203/206/207; the 200A uses an LDR tremolo).

**Missing:** level-dependent distortion per voice (the shared shaper distorts chords together, so they intermodulate); a short inharmonic reed onset; a slightly sharp attack pitch. Effort: M, shared with the Tine Piano's pickup work (a per-voice shaper).

---

## 7. Marimba

**Measured.** Partials 1 and 4.0 (−11 to −13 dB in the attack, −33 to −37 dB by 0.1 s); 9× and 11× FM sidebands at −58 dB; nothing at 10×. The fundamental falls 32 dB in 1 s at C3 and 72 dB in 1 s at C5.

**Published.** Measured marimba modes are 1, 3.92, 9.24, 16.27 [euphonics.org]; the resonator lengthens the fundamental.

**Missing:** the third mode at ≈9.2–10×, decaying fast; a longer low-register fundamental (C3 rings ~1–2 s on real bars). Effort: S, the same "modal bar" approach as the vibraphone (xylophone 1 : 3 : 6.2 would come free).

---

## 8. Accordion

**What it is.** Two sawtooths 12 cents apart plus a pulse an octave down, split through a band-pass "box" (1.4 kHz) and a low-pass, an Amp.

**Published.**
- Free-reed pressure waveforms are peaky (two peaks per cycle) and rich in harmonics [euphonics.org/11-6-free-reeds].
- Musette tunings (practitioner sources): dry ~0 c, swing ~4 c, American ~10 c, French musette 18–25 c. The beat rate is kept roughly constant, so the detune in cents shrinks going up (10 c at A4 ≈ 6.5 c at A5) [github.com/dan-vine/accordion-tuner; libertybellows.com].
- Three-reed musette is one reed in tune with one sharp and one flat (e.g. 435 / 440 / 445 Hz).
- The cassotto rounds off the upper harmonics.

**Missing:** wet detune (one reed flat, one sharp, ±8–12 c at A4, a constant beat in Hz); a pulse-like reed wave (a narrow pulse, or the saw through a formant); bellows: velocity, or better an expression CC, controlling level and brightness together. Effort: S–M (detune by note needs a key-tracked fine, which oscillators don't have yet).

---

## 9. 808 Kit metal (hats and cymbal)

**What it is.** The `metal` wave: six squares at the 808's ratios (1, 1.483, 1.8, 2.546, 2.63, 3.897 × 205.3 Hz), then one high-pass at `f · 2 · bright`.

**Published** [Werner, Abel & Smith, ICMC/SMC 2014, https://speech.di.uoa.gr/ICMC-SMC-2014/images/VOL_2/1453.pdf]. After the oscillators (frequencies match) come two band-passes at ≈3440 and ≈7100 Hz feeding three VCAs with their own envelopes and diode nonlinearities, then Sallen-Key high-passes (one resonant near 10.5 kHz) and a tone control that mainly cuts the top band. The hi-hat's own filter values and decay times weren't found; the service manual is the source.

**Missing:** the two band-passes and their separate envelopes (a short bright band over a longer lower one is the 808 cymbal's shape); the resonant top high-pass. Effort: S (pad model: a second filter and envelope for the metal layer).

---

## 10. Reverb impulses

**What they are.** `reverbImpulse()` (engine.js:104): noise through a one-pole low-pass whose cutoff slides from `bright` toward `loTo` over the decay, an exponential envelope reaching −60 dB at Size, a linear build-up, 5–6 early-reflection spikes per type (spread ±6–7% between sides), each side its own noise, energy-normalised.

**Published.**
- Schroeder: ≥1000 echoes/s in the tail (≥10,000/s for impulsive sounds), and a mode density ≥ 0.15·T60 modes per Hz [Smith, PASP, ccrma.stanford.edu/~jos/pasp].
- Exponentially decaying noise meets both, and the method is accepted; velvet noise sounds smooth from ~1500–2000 pulses/s.
- Highs must decay faster than lows, with T60 set per band (Jot's FDN absorbent filters) [dsprelated.com/dspbooks/pasp].
- Early reflections belong in a tapped delay that scales with the room; echoes 1–30 ms apart change the timbre, and more than 30–50 ms apart are heard as separate [Moorer 1979].

**Missing, ranked:**
1. Decay set per band. A sliding one-pole gives every moment a 6 dB/oct tilt rather than a T60(f): highs linger as a gentle slope, and the bass can't ring longer than the mids. Generate the tail per octave band, each with its own T60.
2. Early reflections scaled with Size and type, and more of them.
3. Some inter-channel correlation in the first ~20 ms.

These are noticeable on the Church Organ's 7 s hall and on sparse percussive sounds. Effort: M (offline IR generation only, no runtime cost).

---

## Done

- **Nov 2026, Rotary 1a–1c.** The amp is now tanh(g·x)/g with g = 2 × Drive: unity gain for quiet signals, with a curve spanning ±4 so chords aren't hard-clipped by the WaveShaper. 800–2000 Hz distortion on B3 Jazz at Drive 0.15: one note −56 dB, a triad −44 dB, a 5-note chord −39 dB (were −23, −16 and −17).
- The crossover is a Linkwitz-Riley at 800 Hz, flat within 0.2 dB from 98 Hz to 3.1 kHz. Web Audio's low-pass/high-pass Q is in dB, so a Butterworth is −3.01, not 0.707.
- Speeds change through a lag with separate up/down times: horn 90% in 1 s up and 1.5 s down, drum 4.5 s and 6.5 s.
- The B3 volumes were raised so chords are within ±1.4 dB of before; single notes are now 1–5 dB quieter than chords, as on a real organ.
- Before/after renders (a 5-note chord, and slow → fast → slow): `recordings/rotary/`.
- **Nov 2026, Rotary 1d.** Two mics at ±60°, each hearing every rotor along three paths: direct plus two cabinet reflections, each with its own delay, gain and (horn) beam low-pass at 5 kHz ±1 octave, plus a little unmoved horn leakage. Horn Doppler ±0.74 ms, measured ±50–60 c at fast, including the paths' interference; the drum has almost no Doppler and swings ~2.3 dB. The two sides' level swings now correlate −0.2 to −0.5, where before they were identical. Loudness within 1.4 dB.
- **Nov 2026, organ (part of 1e).**
  - Organ vibrato module (`scanner`): V1/V2/V3 measured ±8, ±12, ±24 c; C1–C3 mixed with dry at equal power. On by default (C3) in B3 Jazz, Gospel and Ballad.
  - Percussion is single-trigger: one envelope, started only when no key was held. A chord gets it on every note; a legato line's later notes are 14, 30 and 45 dB down. It decays 60 dB in ~1 s / ~4 s, sits 3 dB stronger against the drawbars, and takes over the 1' drawbar.
  - Loudness within 0.4 dB of before.
  - Not done: tempered tonewheel tuning, contact-bounce click, leakage, the scanner's low-pass, percussion bypassing the scanner.

## Recommended order of work

1. **Rotary fixes (1a, 1b, 1c)**: a clean Drive 0 and a sane curve, a Linkwitz-Riley crossover, first-order speed changes with separate up/down times. These are small changes in one function and should help all four B3 sounds at once. A/B WAVs: each B3 sound and a C–E–G–B chord before and after, plus the slow → fast switch.
2. **Combo Organ patch** (squares only, a filtered flute voice, a fixed roll-off): a patch change, and the user's "very buzzy" goes.
3. **Electric pianos (4)**: make the tine audible (patch); then a per-voice pickup nonlinearity, which serves the Wurly (6) as well.
4. **Rotary stereo (1d)**: direct and reflected taps per mic, frequency-dependent AM, less Doppler on the drum. Then the organ module's **scanner vibrato/chorus, single-trigger percussion with the 1' cancel and −3 dB, longer percussion decay, tempered 1⅗'/fifths, contact-bounce click (1e)**. Judge by ear after step 1 how much of this is needed.
5. **Church Organ (2)**: principal-toned ranks with speech transients and a chiff; then rebalance the reverb.
6. **Mallets (5, 7)**: modal bars (1 : 4 : 10 vibes, 1 : 3.9 : 9.2 marimba) with decay per mode and key-tracked sustain.
7. **Accordion (8)**, **808 metal (9)**, **reverb bands (10)**.

For each, follow the piano's routine: targets from the sources above, measure renders against them, and A/B WAVs for the user before calling it done. Gaps in the published data to fill when the time comes: measured Leslie spin times and AM depth, Hammond leakage levels and the key-click timings in Moro et al. 2017, combo-organ vibrato and filter values (service schematics), the DX7 E.PIANO 1 operator settings (ROM1A voice 11), decay per mallet mode (Chaigne & Doutaut 1997), and 808 hi-hat decay times (service manual).
