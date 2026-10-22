# Pulse

Drum machine, looper and sampler in the browser. No dependencies, no build step.

## Run

AudioWorklet needs a secure context, so serve the folder over `localhost`:

```sh
python3 -m http.server 8000   # or: npx http-server -p 8000
```

Open http://localhost:8000 and press the power button.

## Features (section 1)

- **Drum machine**: 8 tracks × 16 steps, synthesized default kit, accents (Shift+click), drag to paint, per-track mute, swing, live recording of pad hits quantized to the grid (REC).
- **Sampler**: per pad LEVEL / PITCH (±24 st) / PAN / DECAY, choke group (hats are pre-choked), load any audio file, or record from the mic straight onto a pad (auto-trimmed and normalized).
- **Looper**: bar-synced stereo looper, 1/2/4/8 bars, source = mic or the drum bus (resampling), overdub, exact undo of the last overdub, input monitoring.
- Pattern, tempo and pad settings persist in `localStorage`.

Keys: `Q W E R / A S D F` pads · `Space` play · `X` rec · `L` loop rec/dub/play · `K` loop stop · `U` undo.

## Architecture

```
js/app.js              UI: DOM, input, rendering. Never touches audio samples in real time.
js/engine.js           Main-thread controller: posts commands, delays step events to the
                       actual output time so lights match what you hear.
js/kit.js              Default drum sounds, synthesized at the context sample rate.
js/knob.js             SVG knob control.
worklet/engine.worklet.js   All DSP, on the audio thread.
```

All audio runs in a single `AudioWorkletProcessor`:

- **Sample-accurate sequencer**: the clock counts samples, and each step triggers at its exact frame offset inside the 128-sample block. No `setTimeout` or main-thread scheduling, so timing doesn't depend on UI load.
- **No allocation in `process()`**: voices are struct-of-arrays in preallocated typed arrays (32 voices, oldest is stolen). The looper, undo and sampler buffers are allocated once.
- **Fast paths**: integer read with no interpolation at pitch 0, linear interpolation otherwise. Voices are freed when their envelope drops below −80 dB.
- **Looper sync**: recording starts and ends on bar lines, and playback re-aligns to the bar grid every cycle, so it never drifts from the sequencer. Overdub undo stores a per-sample generation stamp, so only touched samples are restored, in chunks spread across blocks.
- Master soft clipper (only above −2 dB), so overloads stay musical instead of clipping hard.

## Known limits / next sections

- Tempo is locked while a loop exists (the loop isn't time-stretched).
- Pad samples are mono, and custom samples aren't saved across reloads yet.
- Ideas for later: multiple patterns/song chaining, per-pad filter, sample start/end editing, multi-track looper, IndexedDB sample storage, MIDI input, WASM DSP core if profiling calls for it.
