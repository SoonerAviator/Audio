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

- **Grid** (8 wide × 11 tall): rows 1–2 are the 16 steps of the selected track (Shift-click for an accent, drag to paint). Row 3 sets the velocity for new steps, row 4 is the song chain (8 entries per page), row 5 holds patterns A–H, row 6 is the looper, rows 7–10 are the 8 drum pads, and row 11 holds the sample tools for the selected track: LOAD (audio file), SAMPLE (record from the mic; tap again to stop), RESET (built-in sound) and CHOKE.
- **Edge pads**: the top row holds symbol pads for play/stop, record (pad hits into the pattern, quantized), song, copy, clear, chain page ‹ ›, tap tempo, and **?** (opens the help popup with the grid guide and keyboard shortcuts). The left strip selects a track (labeled, in its color) and the right strip mutes it (speaker icon; amber when muted).
- **COPY / CLR** work like Launchpad's Duplicate and Delete: arm the button, then tap the target. COPY + pattern copies the pattern you're viewing into it. CLR + pattern, chain entry or track button clears that pattern, removes that chain entry, or clears that track's steps.
- **Patterns & song**: while playing, picking a pattern queues it for the next bar line. SONG mode plays the chain (up to 64 one-bar entries) and loops. Tap a chain entry to jump there on the next bar, or tap **+** to add the pattern you're editing.
- **Knob bar** (top, two rows): row 1 is TEMPO (the BPM knob doubles as the tempo display), SWING, MASTER and the looper's LEVEL and MIC TRIM; row 2 is the selected track's name, sample source and waveform with its LEVEL / PITCH (±24 st) / PAN / DECAY knobs in the track's colour. Mic recordings onto a track are auto-trimmed and normalized; hats are pre-choked.
- **Multi-touch**: every pad, step and knob tracks its own finger, so you can play several pads at once, hold one while tapping another, turn two knobs together, or paint steps with two fingers. Scrolling, zoom and long-press menus are disabled over the grid.
- **Lighting**: lit pads glow from the centre; hits bloom softly and fade; waiting states (queued pattern, armed COPY/CLR) pulse slowly instead of blinking.
- **Looper** (row 6), pedal-style: pad 1 records, then plays, then overdubs (one button), with a progress sweep; pad 2 stops; pad 3 opens the 8 save slots across the row (tap one to switch loops, in time); then undo, clear (tap twice), bars (1/2/4/8), source (mic or the drum bus) and mic monitoring. Recording starts the instant you press, even mid-bar, and stays locked to the beat. Mic recordings are shifted earlier by the measured audio round-trip latency; the MIC TRIM knob fine-tunes it.
- Patterns, chain, tempo and track settings persist in `localStorage`.

Keys: `Q W E R / A S D F` pads · `↑ ↓` track · `Space` play · `1`–`8` pattern · `M` song · `[ ]` chain page · `X` rec · `L` loop rec/play/dub · `K` loop stop · `U` loop undo · `Esc` disarm COPY/CLR or close the slot picker.

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
- **No allocation in `process()`**: voices are struct-of-arrays in preallocated typed arrays (32 voices, oldest is stolen). Undo and sampler buffers are allocated once; looper slot buffers arrive from the main thread.
- **Fast paths**: integer read with no interpolation at pitch 0, linear interpolation otherwise. Voices are freed when their envelope drops below −80 dB.
- **Pattern and song changes** happen inside the worklet at the bar line, between the last step of one bar and the first step of the next, so a switch never lands late. Each step event carries the playing pattern and chain position, and the UI follows them at the moment the bar is heard.
- **Looper sync**: the loop position is the transport clock modulo the loop length, so recording can begin on any sample and the loop still lines up with the bar grid, and switching slots lands in time. Slot buffers (30 s stereo each) are allocated on the main thread only when a slot is first used and transferred to the audio thread. Stops, clears and slot switches fade over 256 samples, and the recorded seam is softened, so nothing clicks. Overdub undo stores a per-sample generation stamp, so only touched samples are restored, in chunks spread across blocks.
- Master soft clipper (only above −2 dB), so overloads stay musical instead of clipping hard.

## Known limits / next sections

- Tempo is locked while any loop slot holds audio (loops aren't time-stretched).
- Loop slot audio isn't saved across reloads yet.
- Pad samples are mono, and custom samples aren't saved across reloads yet.
- Chain entries are one bar each; repeat an entry to hold a pattern longer.
- Ideas for later: per-pad filter, sample start/end editing, multi-track looper, IndexedDB sample storage, MIDI input, WASM DSP core if profiling calls for it.
