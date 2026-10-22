// Main-thread controller for the audio worklet. Thin: it only forwards
// commands and turns worklet events into DOM events.

export const LOOP = { EMPTY: 0, ARMED: 1, REC: 2, PLAY: 3, DUB: 4, STOP: 5 };

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.mic = null;
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
      processorOptions: { loopSeconds: 30, sampleSeconds: 10 },
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
      this.mic = this.ctx.createMediaStreamSource(stream);
      this.mic.connect(this.node);
      return true;
    } catch (err) {
      console.warn('Audio input unavailable:', err);
      return false;
    }
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
