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
const MAX_VOICES = 32;
const METER_EVERY = 8;          // blocks between meter/looper status packets
const RESTORE_CHUNK = 32768;    // samples per block when undoing an overdub
const KILL_LEVEL = 1e-4;        // voice is freed below this envelope level
const CLIP_T = 0.8;             // soft clip threshold

// Looper states (mirrored in js/engine.js)
const L_EMPTY = 0, L_ARMED = 1, L_REC = 2, L_PLAY = 3, L_DUB = 4, L_STOP = 5;

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
    this.pattern = new Uint8Array(TRACKS * STEPS);
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
    this.lastStepAt = 0;
    this.recArm = false;

    // Looper (stereo). gen[] marks which samples the current overdub touched,
    // so undo restores exactly those without range bookkeeping or clears.
    this.loopL = new Float32Array(this.loopMax);
    this.loopR = new Float32Array(this.loopMax);
    this.undoL = new Float32Array(this.loopMax);
    this.undoR = new Float32Array(this.loopMax);
    this.gen = new Uint32Array(this.loopMax);
    this.session = 1;
    this.dubbed = false;
    this.lState = L_EMPTY;
    this.lLen = 0;
    this.lPos = 0;
    this.lBars = 2;
    this.lBar = 0;
    this.lSrc = 0;        // 0 = audio input, 1 = drum bus
    this.lGain = 1;
    this.restoreIdx = 0;
    this.restoreLeft = 0;

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
      case 'step': this.pattern[d.i * STEPS + d.s] = d.v; break;
      case 'pattern': this.pattern.set(d.data); break;
      case 'pad': this.setPad(d); break;
      case 'sample': this.samples[d.i] = d.data; break;
      case 'play': this.start(); break;
      case 'stop': this.stop(); break;
      case 'bpm':
        if (this.lState === L_EMPTY) { this.bpm = d.v; this.updateTempo(); }
        this.port.postMessage({ t: 'bpm', v: this.bpm });
        break;
      case 'swing': this.swing = d.v; break;
      case 'master': this.master = d.v; break;
      case 'recArm': this.recArm = !!d.v; break;
      case 'monitor': this.monitor = !!d.v; break;
      case 'loop': this.loopCmd(d.cmd); break;
      case 'loopBars': if (this.lState === L_EMPTY) this.lBars = d.v; this.postLoop(); break;
      case 'loopSrc': this.lSrc = d.v; break;
      case 'loopGain': this.lGain = d.v; break;
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

  // ---------------------------------------------------------------- transport

  start() {
    if (this.playing) return;
    this.playing = true;
    this.clock = 0;
    this.nextStep = 0;
    this.step = 0;
    this.lastStep = -1;
    this.skip.fill(-1);
    // Existing loop restarts on the first bar.
    if (this.lState >= L_PLAY) this.lBar = this.lBars;
    this.port.postMessage({ t: 'transport', v: true });
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    if (this.lState === L_REC || this.lState === L_ARMED) this.lState = L_EMPTY;
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
    let barAt = -1;
    while (this.nextStep < end) {
      const off = Math.max(0, Math.floor(this.nextStep - this.clock));
      const s = this.step;
      if (s === 0) barAt = off;
      let mask = 0;
      for (let t = 0; t < TRACKS; t++) {
        if (this.skip[t] === s) { this.skip[t] = -1; continue; }
        const vel = this.pattern[t * STEPS + s];
        if (vel && !this.mute[t] && this.samples[t]) { this.trigger(t, vel, off); mask |= 1 << t; }
      }
      this.port.postMessage({ t: 'tick', s, m: mask, f: currentFrame + off });
      this.lastStep = s;
      this.lastStepAt = this.nextStep;
      this.nextStep += this.spStep * (s & 1 ? 1 - this.swing : 1 + this.swing);
      this.step = (s + 1) % STEPS;
    }
    this.clock = end;
    return barAt;
  }

  // Quantize a live pad hit to the nearest step.
  liveRecord(i, vel) {
    if (!this.playing || !this.recArm) return;
    const toPrev = this.clock - this.lastStepAt;
    const toNext = this.nextStep - this.clock;
    let s;
    if (this.lastStep >= 0 && toPrev <= toNext) s = this.lastStep;
    else { s = this.step; this.skip[i] = s; } // already heard it; don't double-fire
    this.pattern[i * STEPS + s] = vel;
    this.port.postMessage({ t: 'pat', i, s, v: vel });
  }

  // ---------------------------------------------------------------- looper

  loopCmd(cmd) {
    const st = this.lState;
    if (cmd === 'rec') {
      if (st === L_EMPTY) {
        // Clamp bar count so the loop fits the buffer at this tempo.
        const maxBars = Math.max(1, Math.floor(this.loopMax / Math.ceil(this.barFrames())));
        if (this.lBars > maxBars) this.lBars = maxBars;
        this.lState = L_ARMED;
        this.start(); // recording always starts on a bar line
      } else if (st === L_ARMED) this.lState = L_EMPTY;
      else if (st === L_REC) this.lBars = this.lBar;          // close the loop at the next bar line
      else if (st === L_PLAY) this.beginDub();
      else if (st === L_DUB) this.lState = L_PLAY;
      else if (st === L_STOP) { this.lState = L_PLAY; this.start(); }
    } else if (cmd === 'stop') {
      if (st === L_PLAY || st === L_DUB) this.lState = L_STOP;
      else if (st === L_ARMED || st === L_REC) this.lState = L_EMPTY;
    } else if (cmd === 'clear') {
      this.lState = L_EMPTY;
      this.lLen = 0;
      this.restoreLeft = 0;
      this.dubbed = false;
    } else if (cmd === 'undo') {
      if (this.dubbed && this.restoreLeft === 0) {
        if (this.lState === L_DUB) this.lState = L_PLAY;
        this.restoreIdx = 0;
        this.restoreLeft = this.lLen;
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

  onBar() {
    const st = this.lState;
    if (st === L_ARMED) {
      this.lState = L_REC;
      this.lPos = 0;
      this.lBar = 1;
      this.dubbed = false;
      this.postLoop();
    } else if (st === L_REC) {
      if (this.lBar >= this.lBars) {
        this.lLen = this.lPos;
        this.lState = L_PLAY;
        this.lPos = 0;
        this.lBar = 1;
        this.postLoop();
      } else this.lBar++;
    } else if (st >= L_PLAY) {
      // Re-align to the bar grid each cycle so the loop never drifts.
      if (this.lBar >= this.lBars) { this.lPos = 0; this.lBar = 1; } else this.lBar++;
    }
  }

  loopSegment(L, R, inL, inR, a, b) {
    const st = this.lState;
    if (st === L_EMPTY || st === L_ARMED) return;
    const bl = this.loopL, br = this.loopR;
    const srcL = this.lSrc ? L : inL, srcR = this.lSrc ? R : inR;
    let pos = this.lPos;

    if (st === L_REC) {
      const max = this.loopMax;
      for (let i = a; i < b; i++) {
        if (pos >= max) { // safety: buffer full, close the loop here
          this.lLen = max; this.lState = L_PLAY; pos = 0; this.lBar = 1; this.postLoop();
          break;
        }
        bl[pos] = srcL[i];
        br[pos] = srcR[i];
        pos++;
      }
    } else if (st === L_DUB) {
      const len = this.lLen, g = this.lGain, ses = this.session;
      const ul = this.undoL, ur = this.undoR, gen = this.gen;
      for (let i = a; i < b; i++) {
        if (pos >= len) pos = 0;
        const sl = srcL[i], sr = srcR[i]; // read source before adding playback
        const ol = bl[pos], or = br[pos];
        if (gen[pos] !== ses) { ul[pos] = ol; ur[pos] = or; gen[pos] = ses; }
        bl[pos] = ol + sl;
        br[pos] = or + sr;
        L[i] += ol * g;
        R[i] += or * g;
        pos++;
      }
      this.dubbed = true;
    } else {
      const len = this.lLen;
      if (st === L_PLAY) {
        const g = this.lGain;
        for (let i = a; i < b; i++) {
          if (pos >= len) pos = 0;
          L[i] += bl[pos] * g;
          R[i] += br[pos] * g;
          pos++;
        }
      } else { // stopped: keep counting so it stays in sync
        pos += b - a;
        while (pos >= len) pos -= len;
      }
    }
    this.lPos = pos;
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
    this.port.postMessage({
      t: 'loop', s: this.lState, bars: this.lBars, len: this.lLen,
      undo: this.dubbed && this.restoreLeft === 0, sec: this.lLen / sampleRate,
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

    const barAt = this.playing ? this.runSequencer(n) : -1;
    this.renderVoices(L, R, n);

    if (this.playing && this.lState !== L_EMPTY) {
      if (barAt >= 0) {
        this.loopSegment(L, R, inL, inR, 0, barAt);
        this.onBar();
        this.loopSegment(L, R, inL, inR, barAt, n);
      } else this.loopSegment(L, R, inL, inR, 0, n);
    }
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
        lp: this.lLen ? this.lPos / this.lLen : (this.lState === L_REC ? this.lPos / (this.barFrames() * this.lBars) : 0),
        lb: this.lBar,
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
