import { Engine, LOOP } from './engine.js';
import { Knob } from './knob.js';
import { TRACKS, makeSample, normalize } from './kit.js';

const N = 8;
const STEPS = 16;
const PATTERNS = 8;
const PAT_SIZE = N * STEPS;
const MAX_CHAIN = 64;
const PAT_NAMES = 'ABCDEFGH';
const KEYS = ['q', 'w', 'e', 'r', 'a', 's', 'd', 'f'];
const STORE = 'pulse.v1';
const MAX_FILE_SEC = 30;
const $ = (id) => document.getElementById(id);

const engine = new Engine();
const state = loadState();
const samples = new Array(N);
const srcNames = new Array(N).fill('synth');

let sel = 0;
let playing = false;
let recArm = false;
let sampling = -1;
let loop = { s: LOOP.EMPTY, bars: state.loopBars, len: 0, undo: false };
let loopPos = 0, loopBar = 0;
let meterL = 0, meterR = 0;
let curStep = -1;
let view = 0;          // pattern shown in the grid (and edited)
let playPat = -1;      // pattern the engine is playing, from ticks
let queued = -1;       // pattern waiting for the bar line
let chainAt = 0;       // current chain entry (or start entry while stopped)
let jumpTo = -1;       // chain entry waiting for the bar line
let clipboard = null;
let clearArmed = 0;

const ui = { pads: [], glows: [], rows: [], steps: [], phLeds: [], meter: [[], []], loopLeds: [], pats: [], chips: [] };
let knobs = {};

// ------------------------------------------------------------------ state

function defaultState() {
  const patterns = Array.from({ length: PATTERNS }, () => new Array(PAT_SIZE).fill(0));
  const put = (p, t, steps, v = 100) => steps.forEach((s) => (patterns[p][t * STEPS + s] = v));
  // A: main groove
  put(0, 0, [0, 8, 10]); put(0, 0, [0], 127);
  put(0, 1, [4, 12]);
  put(0, 2, [12], 80);
  put(0, 3, [0, 2, 4, 6, 8, 10, 12]); put(0, 3, [2, 6, 10], 70);
  put(0, 4, [14]);
  put(0, 7, [7, 15], 70);
  // B: fill
  put(1, 0, [0, 8]); put(1, 0, [0], 127);
  put(1, 1, [4, 10, 13, 14]); put(1, 1, [12, 15], 127);
  put(1, 3, [0, 2, 4, 6, 8]);
  put(1, 4, [10]);
  put(1, 5, [11, 13, 15], 90);
  return {
    bpm: 120, swing: 0, master: 0.8, loopGain: 1, loopBars: 2, loopSrc: 1,
    patterns, view: 0, chain: [0, 0, 0, 1], song: false,
    pads: TRACKS.map((t) => ({ gain: 0.8, pitch: 0, pan: 0, decay: 1, choke: t.choke || 0, mute: false })),
  };
}

function loadState() {
  const d = defaultState();
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (!s || !s.pads || s.pads.length !== N) return d;
    // v1 saved a single pattern; it becomes pattern A.
    if (s.pattern && !s.patterns) {
      s.patterns = d.patterns.map((p, i) => (i === 0 && s.pattern.length === PAT_SIZE ? s.pattern : new Array(PAT_SIZE).fill(0)));
      s.chain = [0];
      delete s.pattern;
    }
    const ok = Array.isArray(s.patterns) && s.patterns.length === PATTERNS && s.patterns.every((p) => p.length === PAT_SIZE);
    if (ok) {
      const st = { ...d, ...s };
      st.chain = (Array.isArray(st.chain) ? st.chain : []).filter((p) => p >= 0 && p < PATTERNS).slice(0, MAX_CHAIN);
      st.view = st.view >= 0 && st.view < PATTERNS ? st.view : 0;
      return st;
    }
  } catch { /* storage unavailable */ }
  return d;
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* ignore */ }
  }, 300);
}

// Decay knob 0..1 → seconds to -60 dB; 1 = off (play whole sample).
const decayTime = (v) => (v >= 1 ? 0 : 0.02 * Math.pow(100, v));

function sendPad(i) {
  const p = state.pads[i];
  engine.send({ t: 'pad', i, gain: p.gain, pitch: p.pitch, pan: p.pan, decay: decayTime(p.decay), choke: p.choke, mute: p.mute });
}

function setSample(i, data, name) {
  samples[i] = data;
  srcNames[i] = name;
  engine.send({ t: 'sample', i, data });
  if (i === sel) renderEditor();
}

// ------------------------------------------------------------------ pads

function buildPads() {
  const host = $('pads');
  TRACKS.forEach((t, i) => {
    const el = document.createElement('button');
    el.className = 'pad';
    el.style.setProperty('--c', t.color);
    el.innerHTML = `<div class="p-glow"></div><span class="p-name">${t.name}</span><span class="p-bar"></span><span class="p-key">${KEYS[i].toUpperCase()}</span>`;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); hitPad(i, e.shiftKey ? 127 : 110); });
    host.appendChild(el);
    ui.pads.push(el);
    ui.glows.push(el.firstChild);
  });
}

function hitPad(i, vel) {
  engine.send({ t: 'trig', i, v: vel, rec: recArm });
  flash(i, vel / 127);
  if (i !== sel) select(i);
}

function flash(i, amt = 1) {
  ui.glows[i].animate([{ opacity: 0.85 * amt }, { opacity: 0 }], { duration: 240, easing: 'cubic-bezier(.2,.7,.3,1)' });
}

// ------------------------------------------------------------------ sequencer

function buildSeq() {
  const host = $('seq');

  const ph = document.createElement('div');
  ph.className = 'seq-row ph-row';
  ph.innerHTML = '<div class="seq-head"></div><div class="steps"></div>';
  const phGroups = groups(ph.lastChild);
  for (let s = 0; s < STEPS; s++) ui.phLeds.push(phGroups[s >> 2].appendChild(document.createElement('span')));
  host.appendChild(ph);

  let paint = null;
  window.addEventListener('pointerup', () => (paint = null));

  TRACKS.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'seq-row';
    row.style.setProperty('--c', t.color);
    row.innerHTML = `<div class="seq-head"><button class="seq-name">${t.name}</button><button class="btn seq-mute" title="Mute">M</button></div><div class="steps"></div>`;
    row.querySelector('.seq-name').addEventListener('click', () => select(i));
    const mute = row.querySelector('.seq-mute');
    mute.addEventListener('click', () => {
      state.pads[i].mute = !state.pads[i].mute;
      renderMute(i);
      sendPad(i);
      save();
    });
    const grps = groups(row.querySelector('.steps'));
    const cells = [];
    for (let s = 0; s < STEPS; s++) {
      const c = document.createElement('button');
      c.className = 'stp';
      c.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        c.releasePointerCapture(e.pointerId);
        const v = state.patterns[view][i * STEPS + s] ? 0 : e.shiftKey ? 127 : 100;
        paint = { i, v };
        setStep(i, s, v);
      });
      c.addEventListener('pointerenter', (e) => {
        if (paint && paint.i === i && e.buttons) setStep(i, s, paint.v);
      });
      grps[s >> 2].appendChild(c);
      cells.push(c);
    }
    host.appendChild(row);
    ui.rows.push(row);
    ui.steps.push(cells);
    renderMute(i);
    for (let s = 0; s < STEPS; s++) renderStep(i, s);
  });
}

// Steps are laid out in four groups of four (one beat each).
function groups(host) {
  return Array.from({ length: STEPS / 4 }, () => {
    const g = document.createElement('div');
    g.className = 'grp';
    return host.appendChild(g);
  });
}

function setStep(i, s, v) {
  const pat = state.patterns[view];
  if (pat[i * STEPS + s] === v) return;
  pat[i * STEPS + s] = v;
  engine.send({ t: 'step', p: view, i, s, v });
  renderStep(i, s);
  renderPatterns();
  save();
}

function renderSteps() {
  for (let i = 0; i < N; i++) for (let s = 0; s < STEPS; s++) renderStep(i, s);
}

function renderStep(i, s) {
  const v = state.patterns[view][i * STEPS + s];
  const c = ui.steps[i][s];
  c.classList.toggle('on', v > 0 && v < 120);
  c.classList.toggle('acc', v >= 120);
}

function renderMute(i) {
  const m = state.pads[i].mute;
  ui.rows[i].classList.toggle('muted', m);
  ui.rows[i].querySelector('.seq-mute').classList.toggle('lit', m);
}

function setPlayhead(s) {
  if (curStep >= 0) {
    ui.phLeds[curStep].classList.remove('on');
    for (let i = 0; i < N; i++) ui.steps[i][curStep].classList.remove('ph');
  }
  curStep = s;
  if (s < 0) return;
  ui.phLeds[s].classList.add('on');
  for (let i = 0; i < N; i++) ui.steps[i][s].classList.add('ph');
}

// ------------------------------------------------------------------ patterns / song

function buildPatterns() {
  const host = $('pats');
  for (let p = 0; p < PATTERNS; p++) {
    const b = document.createElement('button');
    b.className = 'btn pat';
    b.textContent = PAT_NAMES[p];
    b.title = `Pattern ${PAT_NAMES[p]} (${p + 1})`;
    b.addEventListener('click', () => pickPattern(p));
    host.appendChild(b);
    ui.pats.push(b);
  }

  $('patCopy').addEventListener('click', () => {
    clipboard = state.patterns[view].slice();
    $('patPaste').disabled = false;
  });
  $('patPaste').addEventListener('click', () => clipboard && writePattern(view, clipboard.slice()));
  $('patClear').addEventListener('click', () => {
    const btn = $('patClear');
    if (!clearArmed) {
      btn.textContent = 'SURE?';
      btn.classList.add('lit');
      btn.style.setProperty('--c', 'var(--red)');
      clearArmed = setTimeout(disarmClear, 2000);
      return;
    }
    disarmClear();
    writePattern(view, new Array(PAT_SIZE).fill(0));
  });

  $('songMode').addEventListener('click', toggleSong);
  $('chainAdd').addEventListener('click', () => {
    if (state.chain.length >= MAX_CHAIN) return;
    state.chain.push(view);
    sendChain();
    const c = $('chain');
    c.scrollLeft = c.scrollWidth;
  });
  $('chainDel').addEventListener('click', () => {
    if (!state.chain.length) return;
    state.chain.pop();
    if (chainAt >= state.chain.length) chainAt = 0;
    if (jumpTo >= state.chain.length) jumpTo = -1;
    sendChain();
  });
}

function disarmClear() {
  clearTimeout(clearArmed);
  clearArmed = 0;
  const btn = $('patClear');
  btn.textContent = 'CLEAR';
  btn.classList.remove('lit');
}

function writePattern(p, data) {
  state.patterns[p] = data;
  engine.send({ t: 'pattern', p, data: Uint8Array.from(data) });
  if (p === view) renderSteps();
  renderPatterns();
  save();
}

function songActive() {
  return state.song && state.chain.length > 0;
}

function pickPattern(p) {
  if (playing && songActive()) {
    // The song owns playback; this only changes what you're editing.
    setView(p);
    return;
  }
  engine.send({ t: 'patSel', p });
  if (!playing) setView(p);
  else { queued = p === playPat ? -1 : p; renderPatterns(); }
}

function setView(p) {
  view = p;
  state.view = p;
  renderSteps();
  renderPatterns();
  save();
}

function toggleSong() {
  state.song = !state.song;
  engine.send({ t: 'song', v: state.song });
  if (state.song && playing) jumpTo = 0;
  queued = -1;
  renderPatterns();
  renderChain();
  save();
}

function sendChain() {
  engine.send({ t: 'chain', data: Uint8Array.from(state.chain) });
  renderChain();
  save();
}

function renderPatterns() {
  for (let p = 0; p < PATTERNS; p++) {
    const b = ui.pats[p];
    b.classList.toggle('lit', p === view);
    b.classList.toggle('play', playing && p === playPat);
    b.classList.toggle('blink', p === queued);
    b.classList.toggle('full', state.patterns[p].some((v) => v > 0));
  }
}

function renderChain() {
  const host = $('chain');
  if (ui.chips.length !== state.chain.length) {
    host.innerHTML = '';
    ui.chips = state.chain.map((_, k) => {
      const c = document.createElement('button');
      c.className = 'btn chip';
      c.addEventListener('click', () => jumpChain(k));
      return host.appendChild(c);
    });
  }
  state.chain.forEach((p, k) => {
    const c = ui.chips[k];
    c.textContent = PAT_NAMES[p];
    c.title = `Bar ${k + 1}: pattern ${PAT_NAMES[p]}`;
    c.classList.toggle('lit', k === chainAt);
    c.classList.toggle('blink', k === jumpTo);
  });
  host.classList.toggle('off', !state.song);
  $('songMode').classList.toggle('lit', state.song);
  const n = state.chain.length;
  $('songInfo').textContent = n ? `${n} BAR${n > 1 ? 'S' : ''}` : '';
  $('chainAdd').disabled = n >= MAX_CHAIN;
  $('chainDel').disabled = n === 0;
}

function jumpChain(k) {
  engine.send({ t: 'jump', i: k });
  if (playing && songActive()) jumpTo = k;
  else chainAt = k;
  renderChain();
}

// ------------------------------------------------------------------ editor

function buildEditor() {
  const host = $('padKnobs');
  const p = () => state.pads[sel];
  const upd = (key) => (v) => { p()[key] = v; sendPad(sel); save(); };
  knobs.gain = new Knob(host, { label: 'LEVEL', value: 0.8, def: 0.8, format: (v) => Math.round(v * 100), onChange: upd('gain') });
  knobs.pitch = new Knob(host, {
    label: 'PITCH', min: -24, max: 24, step: 1, value: 0, def: 0, bipolar: true,
    format: (v) => (v > 0 ? '+' : '') + v, onChange: upd('pitch'),
  });
  knobs.pan = new Knob(host, {
    label: 'PAN', min: -1, max: 1, value: 0, def: 0, bipolar: true,
    format: (v) => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)), onChange: upd('pan'),
  });
  knobs.decay = new Knob(host, {
    label: 'DECAY', value: 1, def: 1,
    format: (v) => (v >= 1 ? 'OFF' : decayTime(v) < 1 ? Math.round(decayTime(v) * 1000) + 'ms' : decayTime(v).toFixed(1) + 's'),
    onChange: upd('decay'),
  });

  $('choke').addEventListener('click', () => {
    p().choke = p().choke ? 0 : 1;
    sendPad(sel);
    renderEditor();
    save();
  });
  $('reset').addEventListener('click', () => setSample(sel, makeSample(sel, engine.sampleRate), 'synth'));
  $('load').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const i = sel;
    try {
      let data = await engine.decode(await f.arrayBuffer());
      const max = MAX_FILE_SEC * engine.sampleRate;
      if (data.length > max) data = data.slice(0, max);
      setSample(i, data, f.name);
    } catch {
      $('editSrc').textContent = 'could not decode file';
    }
  });
  $('sample').addEventListener('click', toggleSampling);
  window.addEventListener('resize', drawWave);
}

async function toggleSampling() {
  const btn = $('sample');
  if (sampling >= 0) {
    engine.send({ t: 'sampStop' });
    return;
  }
  if (!(await engine.enableInput())) {
    $('editSrc').textContent = 'mic unavailable · use LOAD';
    return;
  }
  sampling = sel;
  engine.send({ t: 'sampRec', i: sel });
  btn.classList.add('lit', 'blink');
  btn.textContent = 'STOP';
}

function onSampled({ i, data }) {
  sampling = -1;
  const btn = $('sample');
  btn.classList.remove('lit', 'blink');
  btn.textContent = 'SAMPLE';
  const trimmed = trimSilence(data);
  if (trimmed.length < engine.sampleRate * 0.01) {
    if (i === sel) $('editSrc').textContent = 'nothing recorded';
    return;
  }
  setSample(i, normalize(trimmed), 'mic take');
}

function trimSilence(x) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak < 1e-3) return new Float32Array(0);
  const on = peak * 0.06, off = peak * 0.01;
  let a = 0, b = x.length - 1;
  while (a < x.length && Math.abs(x[a]) < on) a++;
  while (b > a && Math.abs(x[b]) < off) b--;
  a = Math.max(0, a - Math.floor(engine.sampleRate * 0.004)); // keep the transient's lead-in
  const out = x.slice(a, b + 1);
  const fade = Math.min(out.length, Math.floor(engine.sampleRate * 0.005));
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out;
}

function select(i) {
  ui.pads[sel].classList.remove('sel');
  ui.rows[sel].classList.remove('sel');
  sel = i;
  ui.pads[i].classList.add('sel');
  ui.rows[i].classList.add('sel');
  renderEditor();
}

function renderEditor() {
  const t = TRACKS[sel], p = state.pads[sel];
  const ed = $('edit');
  ed.style.setProperty('--c', t.color);
  ed.style.setProperty('--kc', t.color);
  $('editName').textContent = t.name;
  $('editSrc').textContent = srcNames[sel];
  knobs.gain.set(p.gain, false);
  knobs.pitch.set(p.pitch, false);
  knobs.pan.set(p.pan, false);
  knobs.decay.set(p.decay, false);
  const ch = $('choke');
  ch.style.setProperty('--c', t.color);
  ch.classList.toggle('lit', !!p.choke);
  drawWave();
}

function drawWave() {
  const cv = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cv.clientWidth * dpr));
  const h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  const x = samples[sel];
  if (!x || !x.length) return;
  const mid = h / 2;
  g.fillStyle = TRACKS[sel].color;
  g.globalAlpha = 0.9;
  const per = x.length / w;
  for (let c = 0; c < w; c++) {
    let mn = 1, mx = -1;
    const a = Math.floor(c * per), b = Math.max(a + 1, Math.floor((c + 1) * per));
    for (let k = a; k < b && k < x.length; k++) { const v = x[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const y0 = mid - mx * mid * 0.92, y1 = mid - mn * mid * 0.92;
    g.fillRect(c, y0, 1, Math.max(1, y1 - y0));
  }
}

// ------------------------------------------------------------------ header

function buildHeader() {
  const host = $('globalKnobs');
  knobs.bpm = new Knob(host, {
    label: 'BPM', min: 60, max: 200, step: 1, value: state.bpm, def: 120, format: (v) => v,
    onChange: (v) => { state.bpm = v; engine.send({ t: 'bpm', v }); save(); },
  });
  knobs.swing = new Knob(host, {
    label: 'SWING', min: 0, max: 0.5, value: state.swing, def: 0, format: (v) => Math.round(50 + v * 50) + '%',
    onChange: (v) => { state.swing = v; engine.send({ t: 'swing', v }); save(); },
  });
  knobs.master = new Knob(host, {
    label: 'MASTER', value: state.master, def: 0.8, format: (v) => Math.round(v * 100),
    onChange: (v) => { state.master = v; engine.send({ t: 'master', v }); save(); },
  });

  $('play').addEventListener('click', togglePlay);
  $('rec').addEventListener('click', toggleRec);

  const m = $('meter');
  for (let r = 0; r < 2; r++) {
    const row = document.createElement('div');
    row.className = 'meter-row';
    for (let k = 0; k < 16; k++) {
      const led = document.createElement('span');
      led.className = 'led';
      led.style.setProperty('--lc', k < 11 ? 'var(--green)' : k < 14 ? 'var(--amber)' : 'var(--red)');
      row.appendChild(led);
      ui.meter[r].push(led);
    }
    m.appendChild(row);
  }
}

function togglePlay() {
  engine.send({ t: playing ? 'stop' : 'play' });
}

function toggleRec() {
  recArm = !recArm;
  $('rec').classList.toggle('lit', recArm);
  engine.send({ t: 'recArm', v: recArm });
}

function onTransport(v) {
  playing = v;
  $('play').classList.toggle('lit', v);
  if (!v) {
    engine.clearTimed();
    setPlayhead(-1);
    playPat = -1;
    queued = -1;
    jumpTo = -1;
    chainAt = 0;
    renderPatterns();
    renderChain();
    $('brandDot').classList.remove('on');
  }
}

function renderMeter() {
  const seg = (lvl) => {
    if (lvl <= 0) return 0;
    const db = 20 * Math.log10(lvl);
    return Math.max(0, Math.min(16, Math.ceil((db + 48) / 3)));
  };
  const lit = [seg(meterL), seg(meterR)];
  for (let r = 0; r < 2; r++) for (let k = 0; k < 16; k++) ui.meter[r][k].classList.toggle('on', k < lit[r]);
  meterL *= 0.82;
  meterR *= 0.82;
}

// ------------------------------------------------------------------ looper

const LOOP_TEXT = {
  [LOOP.EMPTY]: ['REC', 'EMPTY'],
  [LOOP.ARMED]: ['WAIT', 'ARMED · STARTS ON BAR'],
  [LOOP.REC]: ['REC', 'RECORDING'],
  [LOOP.PLAY]: ['PLAY', 'PLAYING · PRESS TO DUB'],
  [LOOP.DUB]: ['DUB', 'OVERDUBBING'],
  [LOOP.STOP]: ['STOP', 'STOPPED'],
};

function buildLooper() {
  const bars = $('loopBars');
  [1, 2, 4, 8].forEach((b) => {
    const el = document.createElement('button');
    el.className = 'btn';
    el.textContent = b;
    el.dataset.v = b;
    el.addEventListener('click', () => {
      state.loopBars = b;
      engine.send({ t: 'loopBars', v: b });
      save();
    });
    bars.appendChild(el);
  });
  const src = $('loopSrc');
  ['MIC', 'DRUMS'].forEach((name, v) => {
    const el = document.createElement('button');
    el.className = 'btn';
    el.textContent = name;
    el.dataset.v = v;
    el.addEventListener('click', () => {
      state.loopSrc = v;
      engine.send({ t: 'loopSrc', v });
      renderLooper();
      save();
    });
    src.appendChild(el);
  });

  new Knob($('loopKnobs'), {
    label: 'LOOP', value: state.loopGain, def: 1, format: (v) => Math.round(v * 100),
    onChange: (v) => { state.loopGain = v; engine.send({ t: 'loopGain', v }); save(); },
  }).el.style.setProperty('--kc', 'var(--green)');

  $('loopBtn').addEventListener('click', loopPress);
  $('loopStop').addEventListener('click', () => engine.send({ t: 'loop', cmd: 'stop' }));
  $('loopUndo').addEventListener('click', () => engine.send({ t: 'loop', cmd: 'undo' }));
  $('loopClear').addEventListener('click', () => engine.send({ t: 'loop', cmd: 'clear' }));
  $('monitor').addEventListener('click', async () => {
    const btn = $('monitor');
    const on = !btn.classList.contains('lit');
    if (on && !(await engine.enableInput())) return;
    btn.classList.toggle('lit', on);
    engine.send({ t: 'monitor', v: on });
  });
  renderLooper();
}

async function loopPress() {
  if (loop.s === LOOP.EMPTY && state.loopSrc === 0 && !(await engine.enableInput())) {
    $('loopState').textContent = 'MIC UNAVAILABLE · USE DRUMS SOURCE';
    return;
  }
  engine.send({ t: 'loop', cmd: 'rec' });
}

function renderLooper() {
  const [label, text] = LOOP_TEXT[loop.s];
  $('loopBtn').dataset.s = loop.s;
  $('loopLabel').textContent = label;
  $('loopState').textContent = 'LOOPER · ' + text + (loop.len ? ` · ${loop.sec.toFixed(1)}s` : '');
  const empty = loop.s === LOOP.EMPTY;
  for (const el of $('loopBars').children) {
    el.classList.toggle('lit', +el.dataset.v === loop.bars);
    el.disabled = !empty && +el.dataset.v !== loop.bars;
  }
  for (const el of $('loopSrc').children) el.classList.toggle('lit', +el.dataset.v === state.loopSrc);
  $('loopUndo').disabled = !loop.undo;
  $('loopStop').disabled = !(loop.s === LOOP.PLAY || loop.s === LOOP.DUB);
  $('loopClear').disabled = empty;
  knobs.bpm.setDisabled(!empty, empty ? '' : 'Clear the loop to change tempo');

  const leds = $('loopLeds');
  if (ui.loopLeds.length !== loop.bars) {
    leds.innerHTML = '';
    ui.loopLeds = Array.from({ length: loop.bars }, () => leds.appendChild(document.createElement('span')));
  }
  const color = getComputedStyle($('loopBtn')).getPropertyValue('--c');
  leds.style.setProperty('--lc', color);
}

function renderLoopProgress() {
  const active = playing && loop.s >= LOOP.REC;
  const C = 276.46;
  $('loopRing').style.strokeDashoffset = active ? C * (1 - loopPos) : C;
  for (let k = 0; k < ui.loopLeds.length; k++) ui.loopLeds[k].classList.toggle('on', active && k === loopBar - 1);
}

// ------------------------------------------------------------------ input

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    const pad = KEYS.indexOf(k);
    if (pad >= 0) { hitPad(pad, e.shiftKey ? 127 : 110); return; }
    if (k >= '1' && k <= '8') { pickPattern(+k - 1); return; }
    if (k === ' ') { e.preventDefault(); togglePlay(); }
    else if (k === 'm') toggleSong();
    else if (k === 'x') toggleRec();
    else if (k === 'l') loopPress();
    else if (k === 'k') engine.send({ t: 'loop', cmd: 'stop' });
    else if (k === 'u') engine.send({ t: 'loop', cmd: 'undo' });
  });
  // Browsers can suspend audio (tab switch, iOS interruptions); resume on interaction.
  const wake = () => engine.ctx && engine.ctx.state !== 'running' && engine.ctx.resume();
  window.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', wake);
}

// ------------------------------------------------------------------ engine events

function bindEngine() {
  engine.addEventListener('ticks', (e) => {
    if (!playing) return;
    let mask = 0;
    const ev = e.detail[e.detail.length - 1];
    for (const d of e.detail) mask |= d.m;
    if (ev.p !== playPat) {
      // The engine switched patterns on this bar: follow it.
      playPat = ev.p;
      if (queued === ev.p) queued = -1;
      if (ev.p !== view) setView(ev.p); else renderPatterns();
    }
    if (ev.c >= 0 && ev.c !== chainAt) {
      chainAt = ev.c;
      if (jumpTo === ev.c) jumpTo = -1;
      renderChain();
    }
    setPlayhead(ev.s);
    $('brandDot').classList.toggle('on', ev.s % 4 === 0);
    const pat = state.patterns[ev.p];
    for (let i = 0; i < N; i++) if (mask & (1 << i)) flash(i, pat[i * STEPS + ev.s] / 127 || 0.8);
  });
  engine.addEventListener('transport', (e) => onTransport(e.detail.v));
  engine.addEventListener('bpm', (e) => { state.bpm = e.detail.v; knobs.bpm.set(e.detail.v, false); });
  engine.addEventListener('loop', (e) => { loop = e.detail; renderLooper(); });
  engine.addEventListener('meter', (e) => {
    const d = e.detail;
    meterL = Math.max(meterL, d.l);
    meterR = Math.max(meterR, d.r);
    loopPos = d.lp;
    loopBar = d.lb;
  });
  engine.addEventListener('pat', (e) => {
    const { p, i, s, v } = e.detail;
    state.patterns[p][i * STEPS + s] = v;
    if (p === view) renderStep(i, s);
    renderPatterns();
    save();
  });
  engine.addEventListener('sampled', (e) => onSampled(e.detail));
  engine.addEventListener('patq', (e) => { queued = e.detail.q; renderPatterns(); });
}

function frame() {
  engine.flush();
  renderMeter();
  renderLoopProgress();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot

async function boot() {
  const btn = $('power');
  btn.disabled = true;
  try {
    await engine.start();
  } catch (err) {
    btn.disabled = false;
    $('boot').querySelector('p').textContent = 'Audio failed to start: ' + err.message;
    return;
  }
  const sr = engine.sampleRate;

  buildHeader();
  buildPads();
  buildPatterns();
  buildSeq();
  buildEditor();
  buildLooper();
  bindEngine();
  bindKeys();

  engine.send({ t: 'bpm', v: state.bpm });
  engine.send({ t: 'swing', v: state.swing });
  engine.send({ t: 'master', v: state.master });
  engine.send({ t: 'loopGain', v: state.loopGain });
  engine.send({ t: 'loopBars', v: state.loopBars });
  engine.send({ t: 'loopSrc', v: state.loopSrc });
  state.patterns.forEach((data, p) => engine.send({ t: 'pattern', p, data: Uint8Array.from(data) }));
  engine.send({ t: 'chain', data: Uint8Array.from(state.chain) });
  engine.send({ t: 'song', v: state.song });
  engine.send({ t: 'patSel', p: state.view });
  view = state.view;
  renderSteps();
  renderPatterns();
  renderChain();
  for (let i = 0; i < N; i++) {
    sendPad(i);
    setSample(i, makeSample(i, sr), 'synth');
  }

  $('boot').hidden = true;
  $('app').hidden = false;
  select(0);
  requestAnimationFrame(frame);
}

$('power').addEventListener('click', boot);
