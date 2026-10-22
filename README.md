# Pulse

Drum machine, looper and sampler in the browser. No dependencies, no build step.

## Run

AudioWorklet needs a secure context, so serve the folder over `localhost`:

```sh
python3 -m http.server 8000   # or: npx http-server -p 8000
```

Open http://localhost:8000 and press the power button.

## Features

The UI is laid out like a Launchpad Pro: an 8×8 pad grid framed by function pads, set apart from the grid by a thin gap.

- **Grid**: rows 1–2 are the 16 steps of the selected track (Shift-click for an accent, drag to paint). Row 3 sets the velocity for new steps, row 4 is the song chain (8 entries per page), and the bottom half holds the 8 drum pads.
- **Edge pads**: the top row holds symbol pads for play/stop, record (pad hits into the pattern, quantized), song, copy, clear, chain page ‹ › and looper. The left column selects a track (labeled, in its color), the right column mutes it (speaker icon; amber when muted), and the round buttons along the bottom pick patterns A–H.
- **COPY / CLR** work like Launchpad's Duplicate and Delete: arm the button, then tap the target. COPY + pattern copies the pattern you're viewing into it. CLR + pattern, chain entry or track button clears that pattern, removes that chain entry, or clears that track's steps.
- **Patterns & song**: while playing, picking a pattern queues it for the next bar line. SONG mode plays the chain (up to 64 one-bar entries) and loops. Tap a chain entry to jump there on the next bar, or tap **+** to add the pattern you're editing.
- **Track editor** (right panel): LEVEL / PITCH (±24 st) / PAN / DECAY, choke group (hats are pre-choked), load an audio file, or record from the mic onto the track (auto-trimmed and normalized).
- **Looper** (left panel): bar-synced stereo looper, 1/2/4/8 bars, source = mic or the drum bus (resampling), overdub, exact undo of the last overdub, input monitoring.
- Patterns, chain, tempo and track settings persist in `localStorage`.

Keys: `Q W E R / A S D F` pads · `↑ ↓` track · `Space` play · `1`–`8` pattern · `M` song · `[ ]` chain page · `X` rec · `L` loop · `K` loop stop · `U` undo · `Esc` disarm COPY/CLR.

`mockups/launchpad-concepts.html` holds the three layouts that were considered (this is concept C).

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
- **Pattern and song changes** happen inside the worklet at the bar line, between the last step of one bar and the first step of the next, so a switch never lands late. Each step event carries the playing pattern and chain position, and the UI follows them at the moment the bar is heard.
- **Looper sync**: recording starts and ends on bar lines, and playback re-aligns to the bar grid every cycle, so it never drifts from the sequencer. Overdub undo stores a per-sample generation stamp, so only touched samples are restored, in chunks spread across blocks.
- Master soft clipper (only above −2 dB), so overloads stay musical instead of clipping hard.

## Known limits / next sections

- Tempo is locked while a loop exists (the loop isn't time-stretched).
- Pad samples are mono, and custom samples aren't saved across reloads yet.
- Chain entries are one bar each; repeat an entry to hold a pattern longer.
- Ideas for later: per-pad filter, sample start/end editing, multi-track looper, IndexedDB sample storage, MIDI input, WASM DSP core if profiling calls for it.
