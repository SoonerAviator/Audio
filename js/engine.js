// Main-thread controller for the audio worklet. Thin: it only forwards
// commands and turns worklet events into DOM events.

export const LOOP = { EMPTY: 0, REC: 2, PLAY: 3, DUB: 4, STOP: 5 };
export const LOOP_SECONDS = 30; // per looper slot
export const LOOP_SLOTS = 8;

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.mic = null;
    this.stream = null;
    this.slotReady = new Array(LOOP_SLOTS).fill(false);
    this.timed = []; // step events waiting for their output time
  }

  async start() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const url = new URL('../worklet/engine.worklet.js', import.meta.url);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } catch {
      // Some sandboxed hosts refuse worklet URLs but allow blob: modules.
      const src = await (await fetch(url)).text();
      await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    }
    this.node = new AudioWorkletNode(this.ctx, 'pulse-engine', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { loopSeconds: LOOP_SECONDS, sampleSeconds: 10 },
    });
    this.node.port.onmessage = (e) => this.onMsg(e.data);
    this.node.connect(this.ctx.destination);
    await this.ctx.resume();
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  send(msg, transfer) {
    this.node.port.postMessage(msg, transfer || []);
  }

  async enableInput() {
    if (this.mic) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 },
      });
      this.stream = stream;
      this.mic = this.ctx.createMediaStreamSource(stream);
      this.mic.connect(this.node);
      return true;
    } catch (err) {
      console.warn('Audio input unavailable:', err);
      return false;
    }
  }

  // Looper slot buffers are allocated here and moved (not copied) to the audio thread,
  // so the audio thread never allocates them. Only slots you actually use cost memory.
  ensureSlot(i) {
    if (this.slotReady[i]) return;
    const n = Math.ceil(LOOP_SECONDS * this.ctx.sampleRate);
    const L = new Float32Array(n), R = new Float32Array(n);
    this.send({ t: 'slotBuf', i, L, R }, [L.buffer, R.buffer]);
    this.slotReady[i] = true;
  }

  // Seconds between a sound leaving the speakers and the player's response reaching the
  // engine through the mic: output latency + input latency, as reported by the browser.
  roundTrip() {
    const ctx = this.ctx;
    let s = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    const track = this.stream && this.stream.getAudioTracks()[0];
    const set = track && track.getSettings ? track.getSettings() : {};
    if (typeof set.latency === 'number') s += set.latency;
    return s;
  }

  async decode(arrayBuffer) {
    const ab = await this.ctx.decodeAudioData(arrayBuffer);
    const out = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const ch = ab.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += ch[i];
    }
    if (ab.numberOfChannels > 1) for (let i = 0; i < out.length; i++) out[i] /= ab.numberOfChannels;
    return out;
  }

  // Context time of the sample currently leaving the speakers.
  now() {
    const ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    return this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
  }

  onMsg(d) {
    if (d.t === 'tick') {
      d.time = d.f / this.ctx.sampleRate;
      this.timed.push(d);
    } else {
      this.dispatchEvent(new CustomEvent(d.t, { detail: d }));
    }
  }

  // Called every animation frame: release step events whose audio is now audible.
  flush() {
    if (!this.timed.length) return;
    const now = this.now();
    let k = 0;
    while (k < this.timed.length && this.timed[k].time <= now) k++;
    if (!k) return;
    // Only the newest step matters for the playhead; every hit mask matters for lights.
    const batch = this.timed.splice(0, k);
    this.dispatchEvent(new CustomEvent('ticks', { detail: batch }));
  }

  clearTimed() {
    this.timed.length = 0;
  }
}
