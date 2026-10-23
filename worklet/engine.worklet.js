/*
 * PULSE audio engine — runs entirely on the audio rendering thread.
 *
 * Design rules for this file (the hot path):
 *  - No allocation inside process(): every buffer is created in the constructor.
 *  - Voice state is struct-of-arrays in typed arrays, not objects.
 *  - The sequencer is clocked in samples, so steps land on the exact frame
 *    (no setTimeout / main-thread scheduling jitter).
 *  - Messages to the UI are small and infrequent (one per step, one meter
 *    packet every METER_EVERY blocks).
 */

const TRACKS = 8;
const STEPS = 16;
const PATTERNS = 8;
const PAT_SIZE = TRACKS * STEPS;
const MAX_CHAIN = 64;
const MAX_VOICES = 32;
const METER_EVERY = 8;          // blocks between meter/looper status packets
const RESTORE_CHUNK = 32768;    // samples per block when undoing an overdub
const KILL_LEVEL = 1e-4;        // voice is freed below this envelope level
const CLIP_T = 0.8;             // soft clip threshold
const SLOTS = 8;                // looper save slots
const FADE = 256;               // looper fade length in samples (start/stop/switch)
const EDGE = 64;                // fade at the recorded loop's seam

// Looper states (mirrored in js/engine.js). L_ARMED is no longer used: recording starts on press.
const L_EMPTY = 0, L_REC = 2, L_PLAY = 3, L_DUB = 4, L_STOP = 5;

class PulseEngine extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.loopMax = Math.ceil((o.loopSeconds || 30) * sampleRate);
    this.sampMax = Math.ceil((o.sampleSeconds || 10) * sampleRate);

    // Pads / tracks
    this.samples = new Array(TRACKS).fill(null);
    this.gain = new Float32Array(TRACKS).fill(0.8);
    this.rate = new Float32Array(TRACKS).fill(1);
    this.panL = new Float32Array(TRACKS).fill(Math.SQRT1_2);
    this.panR = new Float32Array(TRACKS).fill(Math.SQRT1_2);
    this.decay = new Float32Array(TRACKS).fill(1);
    this.choke = new Uint8Array(TRACKS);
    this.mute = new Uint8Array(TRACKS);
    this.patterns = new Uint8Array(PATTERNS * PAT_SIZE);
    this.pat = 0;         // playing pattern
    this.queued = -1;     // pattern to switch to at the next bar line
    this.skip = new Int8Array(TRACKS).fill(-1); // one-shot step skip after live-record quantize
    this.chokeDec = Math.exp(-6.9 / (0.004 * sampleRate)); // ~4 ms to -60 dB

    // Voices
    this.vOn = new Uint8Array(MAX_VOICES);
    this.vTrk = new Uint8Array(MAX_VOICES);
    this.vPos = new Float64Array(MAX_VOICES);
    this.vRate = new Float32Array(MAX_VOICES);
    this.vL = new Float32Array(MAX_VOICES);
    this.vR = new Float32Array(MAX_VOICES);
    this.vEnv = new Float32Array(MAX_VOICES);
    this.vDec = new Float32Array(MAX_VOICES);
    this.vDelay = new Int32Array(MAX_VOICES);
    this.vAge = new Uint32Array(MAX_VOICES);
    this.age = 0;

    // Transport
    this.playing = false;
    this.bpm = 120;
    this.swing = 0;
    this.spStep = 0;
    this.updateTempo();
    this.clock = 0;       // frames since play
    this.nextStep = 0;    // frame (since play) of the next step
    this.step = 0;        // index of the next step to fire
    this.lastStep = -1;
    this.lastPat = 0;
    this.lastStepAt = 0;
    this.recArm = false;

    // Song: a chain of pattern indices, one bar each, looping.
    this.chain = new Uint8Array(MAX_CHAIN);
    this.chainLen = 0;
    this.chainPos = 0;
    this.jump = -1;       // chain entry to jump to at the next bar line
    this.song = false;

    // Looper: 8 save slots, one playing at a time. Slot buffers are allocated on the main
    // thread and transferred in ('slotBuf'), so nothing large is allocated here.
    // The play/record position is derived from the transport clock (clock mod loop length),
    // so recording can start the instant it's pressed and the loop still stays on the grid.
    // gen[] marks which samples the current overdub touched, so undo restores exactly those.
    this.slotL = new Array(SLOTS).fill(null);
    this.slotR = new Array(SLOTS).fill(null);
    this.slotBars = new Uint8Array(SLOTS);
    this.slotHas = new Uint8Array(SLOTS);
    this.slot = 0;
    this.loopL = null;
    this.loopR = null;
    this.undoL = new Float32Array(this.loopMax);
    this.undoR = new Float32Array(this.loopMax);
    this.gen = new Uint32Array(this.loopMax);
    this.session = 1;
    this.dubbed = false;
    this.lState = L_EMPTY;
    this.barsSetting = 2; // bar count for the next recording
    this.lBars = 2;       // bar count of the active slot
    this.lenF = 0;        // active loop length in frames (fractional, matches the bar grid)
    this.lSrc = 1;        // 0 = audio input, 1 = drum bus
    this.lGain = 1;
    this.latency = 0;     // input round-trip compensation in frames (audio input only)
    this.recCount = 0;
    this.recTotal = 0;
    this.dubAfter = false; // pressed again while recording: go straight into overdub
    this.ramp = 1;        // playback fade-in after start / slot switch
    this.tailL = null;    // fading-out copy of what was playing (stop / clear / switch)
    this.tailR = null;
    this.tailLenF = 0;
    this.tailPos = 0;
    this.tailLeft = 0;
    this.tailGain = 0;
    this.restoreIdx = 0;
    this.restoreLeft = 0;
    this.lp = 0;          // loop progress 0..1 for the UI
    this.lb = 0;          // current bar of the loop for the UI

    // Sampler recording
    this.sBuf = new Float32Array(this.sampMax);
    this.sLen = 0;
    this.sTrack = -1;

    // Output
    this.master = 0.8;
    this.monitor = false;
    this.zeros = new Float32Array(128);
    this.blocks = 0;
    this.peakL = 0;
    this.peakR = 0;

    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  updateTempo() {
    this.spStep = (sampleRate * 60) / this.bpm / 4; // 16th notes
  }

  barFrames() {
    return this.spStep * STEPS;
  }

  // ---------------------------------------------------------------- messages

  onMsg(d) {
    switch (d.t) {
      case 'trig': this.trigger(d.i, d.v, 0); if (d.rec) this.liveRecord(d.i, d.v); break;
      case 'step': this.patterns[d.p * PAT_SIZE + d.i * STEPS + d.s] = d.v; break;
      case 'pattern': this.patterns.set(d.data, d.p === undefined ? 0 : d.p * PAT_SIZE); break;
      case 'patSel': this.selectPattern(d.p); break;
      case 'chain':
        this.chainLen = Math.min(d.data.length, MAX_CHAIN);
        this.chain.set(d.data.subarray(0, this.chainLen));
        if (this.chainPos >= this.chainLen) this.chainPos = 0;
        if (this.jump >= this.chainLen) this.jump = -1;
        break;
      case 'song':
        this.song = !!d.v;
        if (this.song && this.playing) this.jump = 0; // start the song on the next bar
        break;
      case 'jump':
        if (d.i >= this.chainLen) break;
        if (this.playing) this.jump = d.i; else this.chainPos = d.i;
        break;
      case 'pad': this.setPad(d); break;
      case 'sample': this.samples[d.i] = d.data; break;
      case 'play': this.start(); break;
      case 'stop': this.stop(); break;
      case 'bpm':
        if (!this.anyLoop()) { this.bpm = d.v; this.updateTempo(); }
        this.port.postMessage({ t: 'bpm', v: this.bpm });
        break;
      case 'swing': this.swing = d.v; break;
      case 'master': this.master = d.v; break;
      case 'recArm': this.recArm = !!d.v; break;
      case 'monitor': this.monitor = !!d.v; break;
      case 'loop': this.loopCmd(d.cmd); break;
      case 'loopBars':
        this.barsSetting = d.v;
        if (this.lState === L_EMPTY) this.lBars = Math.min(d.v, this.maxBars());
        this.postLoop();
        break;
      case 'loopSrc': this.lSrc = d.v; break;
      case 'loopGain': this.lGain = d.v; break;
      case 'latency': this.latency = Math.max(0, d.v | 0); break;
      case 'slotBuf':
        this.slotL[d.i] = d.L;
        this.slotR[d.i] = d.R;
        if (d.i === this.slot) { this.loopL = d.L; this.loopR = d.R; }
        break;
      case 'slot': this.selectSlot(d.i); break;
      case 'sampRec': this.sTrack = d.i; this.sLen = 0; break;
      case 'sampStop': this.finishSampling(); break;
    }
  }

  setPad(d) {
    const i = d.i;
    if (d.gain !== undefined) this.gain[i] = d.gain;
    if (d.pitch !== undefined) this.rate[i] = Math.pow(2, d.pitch / 12);
    if (d.pan !== undefined) {
      const a = (d.pan + 1) * 0.25 * Math.PI; // equal-power
      this.panL[i] = Math.cos(a);
      this.panR[i] = Math.sin(a);
    }
    // decay: seconds to -60 dB, 0 = no envelope (play the whole sample)
    if (d.decay !== undefined) this.decay[i] = d.decay > 0 ? Math.exp(-6.9 / (d.decay * sampleRate)) : 1;
    if (d.choke !== undefined) this.choke[i] = d.choke;
    if (d.mute !== undefined) this.mute[i] = d.mute ? 1 : 0;
  }

  // ---------------------------------------------------------------- patterns

  songActive() {
    return this.song && this.chainLen > 0;
  }

  selectPattern(p) {
    if (this.playing) this.queued = p;
    else { this.pat = p; this.queued = -1; }
    this.port.postMessage({ t: 'patq', q: this.queued });
  }

  // Runs between the last step of a bar and the first step of the next.
  barEnd() {
    if (this.songActive()) {
      this.chainPos = this.jump >= 0 ? this.jump : (this.chainPos + 1) % this.chainLen;
      this.jump = -1;
      this.pat = this.chain[this.chainPos];
    } else if (this.queued >= 0) {
      this.pat = this.queued;
      this.queued = -1;
      this.port.postMessage({ t: 'patq', q: -1 });
    }
  }

  // ---------------------------------------------------------------- transport

  start() {
    if (this.playing) return;
    this.playing = true;
    this.clock = 0;
    this.nextStep = 0;
    this.step = 0;
    this.lastStep = -1;
    this.skip.fill(-1);
    if (this.songActive()) {
      this.pat = this.chain[this.chainPos];
      this.jump = -1;
    } else if (this.queued >= 0) {
      this.pat = this.queued;
      this.queued = -1;
      this.port.postMessage({ t: 'patq', q: -1 });
    }
    this.ramp = 0; // a loop picks up from bar 1 with a short fade-in
    this.port.postMessage({ t: 'transport', v: true });
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.chainPos = 0; // the song restarts from the top
    this.jump = -1;
    if (this.lState === L_PLAY || this.lState === L_DUB) this.fadeOut();
    if (this.lState === L_REC) this.lState = L_EMPTY;
    else if (this.lState === L_DUB) this.lState = L_PLAY;
    this.postLoop();
    this.port.postMessage({ t: 'transport', v: false });
  }

  // ---------------------------------------------------------------- voices

  trigger(t, vel, off) {
    if (!this.samples[t]) return;
    const cg = this.choke[t];
    let v = -1, oldest = 0xffffffff, oldestV = 0;
    for (let k = 0; k < MAX_VOICES; k++) {
      if (!this.vOn[k]) { if (v < 0) v = k; continue; }
      if (cg && this.choke[this.vTrk[k]] === cg) this.vDec[k] = this.chokeDec;
      if (this.vAge[k] < oldest) { oldest = this.vAge[k]; oldestV = k; }
    }
    if (v < 0) v = oldestV; // steal
    const vn = vel / 127;
    const g = this.gain[t] * vn * vn;
    this.vOn[v] = 1;
    this.vTrk[v] = t;
    this.vPos[v] = 0;
    this.vRate[v] = this.rate[t];
    this.vL[v] = g * this.panL[t];
    this.vR[v] = g * this.panR[t];
    this.vEnv[v] = 1;
    this.vDec[v] = this.decay[t];
    this.vDelay[v] = off;
    this.vAge[v] = ++this.age;
  }

  renderVoices(L, R, n) {
    for (let v = 0; v < MAX_VOICES; v++) {
      if (!this.vOn[v]) continue;
      const s = this.samples[this.vTrk[v]];
      if (!s) { this.vOn[v] = 0; continue; }
      const last = s.length - 1;
      const rate = this.vRate[v], dec = this.vDec[v];
      const gl = this.vL[v], gr = this.vR[v];
      let pos = this.vPos[v], env = this.vEnv[v];
      let i = this.vDelay[v];
      let alive = 1;
      this.vDelay[v] = 0;

      if (rate === 1) {
        // Fast path: integer read position, no interpolation.
        let p = pos | 0;
        for (; i < n; i++) {
          if (p > last || env < KILL_LEVEL) { alive = 0; break; }
          const a = s[p++] * env;
          L[i] += a * gl;
          R[i] += a * gr;
          env *= dec;
        }
        pos = p;
      } else {
        for (; i < n; i++) {
          const p = pos | 0;
          if (p >= last || env < KILL_LEVEL) { alive = 0; break; }
          const x0 = s[p];
          const a = (x0 + (s[p + 1] - x0) * (pos - p)) * env;
          L[i] += a * gl;
          R[i] += a * gr;
          env *= dec;
          pos += rate;
        }
      }
      this.vOn[v] = alive;
      this.vPos[v] = pos;
      this.vEnv[v] = env;
    }
  }

  // ---------------------------------------------------------------- sequencer

  runSequencer(n) {
    const end = this.clock + n;
    while (this.nextStep < end) {
      const off = Math.max(0, Math.floor(this.nextStep - this.clock));
      const s = this.step;
      const base = this.pat * PAT_SIZE;
      let mask = 0;
      for (let t = 0; t < TRACKS; t++) {
        if (this.skip[t] === s) { this.skip[t] = -1; continue; }
        const vel = this.patterns[base + t * STEPS + s];
        if (vel && !this.mute[t] && this.samples[t]) { this.trigger(t, vel, off); mask |= 1 << t; }
      }
      this.port.postMessage({
        t: 'tick', s, m: mask, f: currentFrame + off, p: this.pat, c: this.songActive() ? this.chainPos : -1,
      });
      this.lastStep = s;
      this.lastPat = this.pat;
      this.lastStepAt = this.nextStep;
      this.nextStep += this.spStep * (s & 1 ? 1 - this.swing : 1 + this.swing);
      this.step = (s + 1) % STEPS;
      if (this.step === 0) this.barEnd();
    }
    this.clock = end;
  }

  // Quantize a live pad hit to the nearest step.
  liveRecord(i, vel) {
    if (!this.playing || !this.recArm) return;
    const toPrev = this.clock - this.lastStepAt;
    const toNext = this.nextStep - this.clock;
    let s, p;
    if (this.lastStep >= 0 && toPrev <= toNext) { s = this.lastStep; p = this.lastPat; }
    else { s = this.step; p = this.pat; this.skip[i] = s; } // already heard it; don't double-fire
    this.patterns[p * PAT_SIZE + i * STEPS + s] = vel;
    this.port.postMessage({ t: 'pat', p, i, s, v: vel });
  }

  // ---------------------------------------------------------------- looper

  anyLoop() {
    if (this.lState === L_REC) return true;
    for (let i = 0; i < SLOTS; i++) if (this.slotHas[i]) return true;
    return false;
  }

  maxBars() {
    return Math.max(1, Math.floor(this.loopMax / Math.ceil(this.barFrames())));
  }

  posAt(frame) {
    return this.lenF > 0 ? frame % this.lenF : 0;
  }

  loopCmd(cmd) {
    const st = this.lState;
    if (cmd === 'rec') {
      if (!this.loopL) return;
      if (st === L_EMPTY) {
        this.lBars = Math.min(this.barsSetting, this.maxBars());
        this.lenF = this.lBars * this.barFrames();
        this.recTotal = Math.round(this.lenF);
        this.recCount = 0;
        this.dubAfter = false;
        this.dubbed = false;
        this.lState = L_REC;
        this.start(); // no-op while playing: recording starts now, wherever the bar is
      } else if (st === L_REC) this.dubAfter = !this.dubAfter;
      else if (st === L_PLAY) { if (this.playing) this.beginDub(); else this.start(); }
      else if (st === L_DUB) this.lState = L_PLAY;
      else if (st === L_STOP) { this.lState = L_PLAY; this.ramp = 0; this.start(); }
    } else if (cmd === 'stop') {
      if (st === L_PLAY || st === L_DUB) { this.fadeOut(); this.lState = L_STOP; }
      else if (st === L_REC) this.lState = L_EMPTY;
    } else if (cmd === 'clear') {
      if (st === L_PLAY || st === L_DUB) this.fadeOut();
      this.lState = L_EMPTY;
      this.slotHas[this.slot] = 0;
      this.slotBars[this.slot] = 0;
      this.lBars = Math.min(this.barsSetting, this.maxBars());
      this.restoreLeft = 0;
      this.dubbed = false;
    } else if (cmd === 'undo') {
      if (this.dubbed && this.restoreLeft === 0) {
        if (this.lState === L_DUB) this.lState = L_PLAY;
        this.restoreIdx = 0;
        this.restoreLeft = Math.ceil(this.lenF);
      }
    }
    this.postLoop();
  }

  beginDub() {
    if (this.restoreLeft > 0) return; // still undoing
    this.session++;
    this.dubbed = false;
    this.lState = L_DUB;
  }

  // Switch the active loop. Positions come from the clock, so the new loop lands in time.
  selectSlot(i) {
    if (i === this.slot || i < 0 || i >= SLOTS || this.restoreLeft > 0) return;
    const prev = this.lState;
    if (prev === L_PLAY || prev === L_DUB) this.fadeOut();
    this.slot = i;
    this.loopL = this.slotL[i];
    this.loopR = this.slotR[i];
    this.session++;
    this.dubbed = false;
    if (this.slotHas[i]) {
      this.lBars = this.slotBars[i];
      this.lenF = this.lBars * this.barFrames();
      this.lState = prev === L_STOP ? L_STOP : L_PLAY; // a stopped looper stays stopped
      this.ramp = 0;
    } else {
      this.lState = L_EMPTY;
      this.lBars = Math.min(this.barsSetting, this.maxBars());
    }
    this.postLoop();
  }

  // Keep what was playing sounding for FADE samples, ramping down, so cuts never click.
  fadeOut() {
    if (!this.loopL || this.lenF <= 0) return;
    this.tailL = this.loopL;
    this.tailR = this.loopR;
    this.tailLenF = this.lenF;
    this.tailPos = this.posAt(this.clock);
    this.tailLeft = FADE;
    this.tailGain = this.lGain * this.ramp;
  }

  runTail(L, R, n) {
    const tl = this.tailL, tr = this.tailR, lenF = this.tailLenF, g = this.tailGain / FADE;
    let p = this.tailPos, left = this.tailLeft;
    for (let i = 0; i < n && left > 0; i++, left--) {
      const k = p | 0;
      L[i] += tl[k] * g * left;
      R[i] += tr[k] * g * left;
      p += 1;
      if (p >= lenF) p -= lenF;
    }
    this.tailPos = p;
    this.tailLeft = left;
  }

  runLooper(L, R, inL, inR, n, clock0) {
    const st = this.lState, bl = this.loopL, br = this.loopR;
    if (!bl || st === L_EMPTY || st === L_STOP) return;
    const lenF = this.lenF;
    const useIn = this.lSrc === 0;
    const srcL = useIn ? inL : L, srcR = useIn ? inR : R;
    let p = clock0 % lenF;
    // Audio from the input arrives `latency` frames after it was played against what you heard,
    // so it's written that far back in the loop.
    let pw = p - (useIn ? this.latency % lenF : 0);
    if (pw < 0) pw += lenF;
    this.lb = Math.floor(p / this.barFrames()) + 1;

    if (st === L_REC) {
      const total = this.recTotal;
      let c = this.recCount;
      for (let i = 0; i < n; i++) {
        const edge = c < EDGE ? c / EDGE : total - c < EDGE ? (total - c) / EDGE : 1; // soften the seam
        const w = pw | 0;
        bl[w] = srcL[i] * edge;
        br[w] = srcR[i] * edge;
        pw += 1;
        if (pw >= lenF) pw -= lenF;
        if (++c >= total) {
          this.slotHas[this.slot] = 1;
          this.slotBars[this.slot] = this.lBars;
          if (this.dubAfter) this.beginDub(); else this.lState = L_PLAY;
          this.ramp = 1;
          this.postLoop();
          break;
        }
      }
      this.recCount = c;
      this.lp = c / total;
      return;
    }

    const g = this.lGain, step = 1 / FADE;
    let ramp = this.ramp;
    if (st === L_PLAY) {
      for (let i = 0; i < n; i++) {
        const k = p | 0, a = g * ramp;
        L[i] += bl[k] * a;
        R[i] += br[k] * a;
        if (ramp < 1) ramp = Math.min(1, ramp + step);
        p += 1;
        if (p >= lenF) p -= lenF;
      }
    } else { // L_DUB
      const ses = this.session, ul = this.undoL, ur = this.undoR, gen = this.gen;
      for (let i = 0; i < n; i++) {
        const k = p | 0, w = pw | 0, a = g * ramp;
        const sl = srcL[i], sr = srcR[i]; // read the source before playback is mixed in
        L[i] += bl[k] * a;
        R[i] += br[k] * a;
        if (gen[w] !== ses) { ul[w] = bl[w]; ur[w] = br[w]; gen[w] = ses; }
        bl[w] += sl;
        br[w] += sr;
        if (ramp < 1) ramp = Math.min(1, ramp + step);
        p += 1;
        if (p >= lenF) p -= lenF;
        pw += 1;
        if (pw >= lenF) pw -= lenF;
      }
      this.dubbed = true;
    }
    this.ramp = ramp;
    this.lp = p / lenF;
  }

  runRestore() {
    let k = Math.min(this.restoreLeft, RESTORE_CHUNK);
    let idx = this.restoreIdx;
    const ses = this.session, gen = this.gen;
    const bl = this.loopL, br = this.loopR, ul = this.undoL, ur = this.undoR;
    this.restoreLeft -= k;
    while (k-- > 0) {
      if (gen[idx] === ses) { bl[idx] = ul[idx]; br[idx] = ur[idx]; }
      idx++;
    }
    this.restoreIdx = idx;
    if (this.restoreLeft === 0) {
      this.session++; // invalidate marks
      this.dubbed = false;
      this.postLoop();
    }
  }

  postLoop() {
    let has = 0;
    for (let i = 0; i < SLOTS; i++) if (this.slotHas[i]) has |= 1 << i;
    const full = this.slotHas[this.slot] === 1;
    this.port.postMessage({
      t: 'loop', s: this.lState, bars: this.lBars, slot: this.slot, has, dubAfter: this.dubAfter,
      len: full ? Math.round(this.lenF) : 0, sec: full ? this.lenF / sampleRate : 0,
      undo: this.dubbed && this.restoreLeft === 0,
    });
  }

  // ---------------------------------------------------------------- sampler

  finishSampling() {
    if (this.sTrack < 0) return;
    const data = this.sBuf.slice(0, this.sLen);
    this.port.postMessage({ t: 'sampled', i: this.sTrack, data }, [data.buffer]);
    this.sTrack = -1;
  }

  // ---------------------------------------------------------------- process

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    if (this.zeros.length < n) this.zeros = new Float32Array(n);
    const inp = inputs[0];
    const inL = inp && inp.length ? inp[0] : this.zeros;
    const inR = inp && inp.length > 1 ? inp[1] : inL;

    L.fill(0);
    R.fill(0);

    // Sampler capture (mono)
    if (this.sTrack >= 0) {
      const room = this.sampMax - this.sLen;
      const k = n < room ? n : room;
      const buf = this.sBuf;
      for (let i = 0; i < k; i++) buf[this.sLen + i] = (inL[i] + inR[i]) * 0.5;
      this.sLen += k;
      if (this.sLen >= this.sampMax) this.finishSampling();
    }

    const clock0 = this.clock;
    if (this.playing) this.runSequencer(n);
    this.renderVoices(L, R, n);

    if (this.playing) this.runLooper(L, R, inL, inR, n, clock0);
    if (this.tailLeft > 0) this.runTail(L, R, n);
    if (this.restoreLeft > 0) this.runRestore();

    // Monitor, master gain, soft clip, peak
    const m = this.master, mon = this.monitor;
    let pl = this.peakL, pr = this.peakR;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (mon) { l += inL[i]; r += inR[i]; }
      l *= m; r *= m;
      let al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > CLIP_T) { al = CLIP_T + (1 - CLIP_T) * Math.tanh((al - CLIP_T) / (1 - CLIP_T)); l = l < 0 ? -al : al; }
      if (ar > CLIP_T) { ar = CLIP_T + (1 - CLIP_T) * Math.tanh((ar - CLIP_T) / (1 - CLIP_T)); r = r < 0 ? -ar : ar; }
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
      L[i] = l;
      if (R !== L) R[i] = r;
    }

    if (++this.blocks >= METER_EVERY) {
      this.port.postMessage({
        t: 'meter', l: pl, r: pr,
        lp: this.lp,
        lb: this.lb,
      });
      this.blocks = 0;
      pl = pr = 0;
    }
    this.peakL = pl;
    this.peakR = pr;
    return true;
  }
}

registerProcessor('pulse-engine', PulseEngine);
