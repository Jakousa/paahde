# Audio levels and repeatable full-mix measurements

The project targets about **−23 LUFS integrated (±2)** for a representative mix at the default master volume
of **0.4**, with **true peak no higher than −1 dBTP**. Quiet exploration and ambience remain quieter than combat;
the target is not a requirement to make every background bed or short passage equally loud. Both volume controls
only attenuate their reference level (1.0).

The measurement definitions come from [ITU-R BS.1770-5](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I) and
[EBU R 128](https://tech.ebu.ch/docs/r/r128.pdf). The project's ±2 LU tolerance is its own working tolerance.
[EBU Tech 3343](https://tech.ebu.ch/docs/tech/tech3343.pdf) explains the distinction between programme loudness,
short-term variation and true-peak headroom. Our meter is FFmpeg's
[`ebur128` filter](https://ffmpeg.org/ffmpeg-filters.html#ebur128), with reconstructed true-peak measurement enabled.

## Running the measurement

Start Vite, then run the browser capture tool; no game server or graphics renderer is needed:

```sh
npx vite --host 127.0.0.1 --port 5179
node tools/audio-measure.mjs --base http://127.0.0.1:5179/ --out /tmp/paahde-audio
```

Chrome and FFmpeg must be installed. Pass `--chrome <path>` if Chrome is not at a usual location. The runner uses
an isolated browser profile, starts audio with an actual CDP mouse press, captures the real graph after the master
limiter and closes its own browser. System speaker output is muted; the recorded samples precede device volume.
Keep the source tree stable during a run, or serve Vite with `server.hmr: false` so edits do not reload a capture.

Defaults are four scenarios, each at master volume 0.4 and 1, with music volume 1. A fresh page and fixed random
seed are used for each capture. After 3.5 seconds of settling, the tool records 20 seconds of stereo float32 PCM.
It writes WAV files, the FFmpeg meter output and `report.json` with browser version, source revision, dirty-tree
status, voice/echo pressure and any browser errors. It also measures equal-duration concatenations of the chosen
scenarios; these are a comparison fixture, not a measured distribution of players' time.

```sh
# Isolate the actual source graphs to find what dominates a mix.
node tools/audio-measure.mjs --scenarios combat --volumes 0.4 --seconds 8 \
  --components 'music;shots;steps;booms;tells;drones;crawler' --out /tmp/paahde-components

# Measure an existing capture directly.
ffmpeg -i /tmp/paahde-audio/combat-0_4.wav -af ebur128=peak=true -f null -
```

Commas combine components; semicolons start separate captures. Valid components are `ambience`, `music`, `shots`,
`steps`, `booms`, `tells`, `drones` and `crawler`. `--seconds` accepts 1–60, and `--volumes` accepts values above
zero through one. Measurements with intentionally disabled components are diagnostic, not full mixes.

## Scenarios and results, 25 October 2026

The fixture stands at a fixed generated spawn. Exploration uses an 8 m/s regional wind and ambient music;
storm uses 23 m/s wind and the game's storm music policy (silence). Combat adds a local rifle shot every 0.4 s,
a walker footfall every 1.2 s at about 23 m, a blast every 2.7 s at about 36 m, a worm warning every 6 s at
about 38 m, one drone and epic music. Multiplayer adds three remote shooters at 25–65 m, three drones and storm
wind. The final combat captures also include a nearby crawler's 500 ms lunge warning every 5 s.

Measured with Chrome 156 on macOS, 48 kHz PCM and FFmpeg 9.0.2:

| Scenario | Default 0.4: LUFS | Default: dBTP | Reference 1: LUFS | Reference: dBTP |
| --- | ---: | ---: | ---: | ---: |
| Exploration | −35.0 | −15.9 | −27.2 | −7.9 |
| Storm | −37.0 | −26.3 | −29.1 | −18.1 |
| Combat, calibrated | −23.7 | −6.6 | −16.0 | −2.6 |
| Multiplayer, calibrated | −22.0 | −7.0 | −14.4 | −2.2 |

Exploration and storm were captured before the combat-only gain changes; their source levels are unchanged.
The reference-volume rows check peak headroom; the integrated loudness target applies at the default volume.
No browser/worklet errors were reported. AudioContext reported 5.33 ms base latency and 32 ms output latency on
this machine; these are device/context reports, not an end-to-end input-to-sound latency measurement.

Before calibration, the default combat and multiplayer mixes measured **−18.5 and −16.5 LUFS**. Isolating the
graphs identified continuous rifle fire (−19.6 LUFS alone) and repeated footfalls (−22.4) as the dominant sources;
music was −28.6, blasts −25.5 and drones −32.5. Shot gain changed from 0.75 to 0.3 and footfall gain from 1.4 to
0.7 (blasts use those footfalls). Music, ambience and warning levels were not boosted. These gains are in
`src/rifleSound.ts` and `src/guardianSound.ts`.

The first and calibrated capture sets are `/tmp/dadajam-audio-20261025` and
`/tmp/dadajam-audio-calibrated-20261025` on the review machine. They are local artifacts, not repository assets;
use the command above to regenerate them. The six-source isolation set is
`/tmp/dadajam-audio-components2-20261025`.

## Routing, headroom and budgets

`src/audio.ts` owns the master gain, compressor, finite-sample guard and final AudioWorklet limiter. The limiter
(`src/limiterKernel.mjs`) is stereo-linked, uses four-phase reconstruction to detect intersample peaks, looks
ahead about 4 ms and reserves a −1.5 dB ceiling. Pre-calibration stress captures at reference volume reached
**−1.5 dBTP**; the calibrated captures above stay lower. `tools/audio-limiter.test.mjs` also exercises impulses,
overload, non-finite input and quiet stereo preservation. If the worklet is unavailable, the compressor fallback
still plays audio, but that fallback is not covered by the measured ceiling; the capture tool rejects it.

Important one-shots use the protected warning bus and briefly attenuate competing effects, music and ambience.
Crawler lunge rattles and worm tells participate in that path. Shared desert/canyon reverb always returns to the
effects bus, even if the first sound in a context is a warning; its direct warning remains protected.

`src/audioBudget.ts` bounds transient voices and discrete echoes. Reservations for rifle/pistol shots, cannons,
fireworks, footfalls and crawler warnings follow their actual source lifetimes; echo reservations add their travel
delay. Keeping a completed half-second shot reserved for eight seconds falsely exhausted the budget: the original
multiplayer fixture reached 80 voices and dropped 28 reservations. The calibrated fixture peaked at **15 voices,
zero drops** (solo: 8). The fixture site produced no discrete rock echoes, so this is not an echo-saturation test.
Routing and source-lifetime regressions are checked in `tools/acoustics-routing.test.mjs` and
`tools/rifle-audio.test.mjs`; priority/expiry and shelter obstruction have separate audio tests.

## Limits of these numbers

These are scripted scenes using the game's actual sound entry points, not recordings of a complete multiplayer
session. They do not cover every boss attack, every distance/enclosure, a large simultaneous warning burst,
vehicle/teardown/water/UI sounds, real network timing or every audio device/browser. Source load timing and
real-time scheduling introduce small variations even with a fixed random seed. Eight-second isolated captures
identify dominant contributors; their loudness ranges are too short to characterize a whole play session.

For another sound or mix change, repeat these captures, inspect true peaks, and listen in representative play.
Add the affected encounter to the fixture when it could produce a new loudest combination. Preserve the quiet
desert and warning audibility instead of normalizing every scene independently to the same number.
