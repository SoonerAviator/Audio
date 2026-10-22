import { Engine, LOOP } from './engine.js';
import { Knob } from './knob.js';
import { TRACKS, makeSample, normalize } from './kit.js';

const N = 8;
const STEPS = 16;
const PATTERNS = 8;
const PAT_SIZE = N * STEPS;
const MAX_CHAIN = 64;
const PAT_NAMES = 'ABCDEFGH';
const PAT_COLORS = ['#3dffa8', '#22d3ff', '#6b7bff', '#b46bff', '#ff5ad8', '#ff3b5c', '#ff8a1f', '#ffd23f'];
const VEL_LEVELS = [20, 36, 52, 68, 84, 100, 116, 127];
const WHITE = '#f4f6fa', RED = '#ff3b5c', AMBER = '#ffb020', GREEN = '#3dffa8';
const KEYS = ['q', 'w', 'e', 'r', 'a', 's', 'd', 'f'];
const STORE = 'pulse.v1';
const MAX_FILE_SEC = 30;
const $ = (id) => document.getElementById(id);

const engine = new Engine();
const state = loadState();
const samples = new Array(N);
const srcNames = new Array(N).fill('synth');

let sel = state.track;   // selected track: shown in step rows, editor, pads
let view = state.view;   // pattern shown (and edited)
let playing = false;
let recArm = false;
let sampling = -1;
let loop = { s: LOOP.EMPTY, bars: state.loopBars, len: 0, undo: false };
let loopPos = 0, loopBar = 0;
let meterL = 0, meterR = 0;
let curStep = -1;
let playPat = -1;        // pattern the engine is playing, from ticks
let queued = -1;         // pattern waiting for the bar line
let chainAt = 0;         // current chain entry (or start entry while stopped)
let jumpTo = -1;         // chain entry waiting for the bar line
let chainPage = 0;
let armed = null;        // 'copy' | 'clr' | null
let armTimer = 0;

// Inline SVG symbols for the function pads (24×24, stroked unless marked fill).
const ICONS = {
  play: '<path class="f" d="M8 5v14l11-7z"/>',
  stop: '<path class="f" d="M6 6h12v12H6z"/>',
  rec: '<circle class="f" cx="12" cy="12" r="6"/>',
  song: '<path d="M4 6h11M4 11h11M4 16h7"/><path class="f" d="M16 13v7l5-3.5z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  clr: '<path d="M6 6l12 12M18 6L6 18"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  loop: '<path d="M17 3l3 3-3 3"/><path d="M4 12v-2a4 4 0 0 1 4-4h12"/><path d="M7 21l-3-3 3-3"/><path d="M20 12v2a4 4 0 0 1-4 4H4"/>',
  speaker: '<path class="f" d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  muted: '<path class="f" d="M11 5L6 9H3v6h3l5 4z"/><path d="M16 9l5 6M21 9l-5 6"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const dev = { top: [], left: [], right: [], bottom: [], steps: [], vel: [], chain: [], pads: [], logo: null };
const ui = { meter: [[], []], loopLeds: [] };
const knobs = {};

// ------------------------------------------------------------------ state

function defaultState() {
  const patterns = Array.from({ length: PATTERNS }, () => new Array(PAT_SIZE).fill(0));
  const put = (p, t, steps, v = 100) => steps.forEach((s) => (patterns[p][t * STEPS + s] = v));
  // A: main groove
  put(0, 0, [0, 8, 10]); put(0, 0, [0], 127);
  put(0, 1, [4, 12]);
  put(0, 2, [12], 84);
  put(0, 3, [0, 2, 4, 6, 8, 10, 12]); put(0, 3, [2, 6, 10], 68);
  put(0, 4, [14]);
  put(0, 7, [7, 15], 68);
  // B: fill
  put(1, 0, [0, 8]); put(1, 0, [0], 127);
  put(1, 1, [4, 10, 13, 14]); put(1, 1, [12, 15], 127);
  put(1, 3, [0, 2, 4, 6, 8]);
  put(1, 4, [10]);
  put(1, 5, [11, 13, 15], 84);
  return {
    bpm: 120, swing: 0, master: 0.8, loopGain: 1, loopBars: 2, loopSrc: 1,
    patterns, view: 0, chain: [0, 0, 0, 1], song: false, track: 0, vel: 100,
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
      st.track = st.track >= 0 && st.track < N ? st.track : 0;
      if (!VEL_LEVELS.includes(st.vel)) st.vel = 100;
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
  if (i === sel && knobs.gain) renderEditor();
}

const songActive = () => state.song && state.chain.length > 0;
const hasNotes = (p) => state.patterns[p].some((v) => v > 0);

// ------------------------------------------------------------------ light helpers

function light(e, color, mode, ph = false) {
  e.style.setProperty('--c', color);
  e.classList.toggle('dim', mode === 'dim');
  e.classList.toggle('mid', mode === 'mid');
  e.classList.toggle('on', mode === 'on');
  e.classList.toggle('acc', mode === 'acc');
  e.classList.toggle('blink', mode === 'blink');
  if (e.classList.contains('pd')) e.classList.toggle('ph', ph);
}

function label(e, text) {
  let lb = e.querySelector('.lb');
  if (!text) { if (lb) lb.remove(); return; }
  if (!lb) { lb = document.createElement('span'); lb.className = 'lb'; e.appendChild(lb); }
  lb.textContent = text;
}

const velMode = (v) => (v >= 120 ? 'acc' : v >= 72 ? 'on' : 'mid');

function flashEl(e, amt = 1) {
  e.animate([{ filter: `brightness(${1 + 1.3 * amt})` }, { filter: 'brightness(1)' }], { duration: 220, easing: 'cubic-bezier(.2,.7,.3,1)' });
}

function flashTrack(t, amt = 1) {
  flashEl(dev.pads[t], amt);
  flashEl(dev.left[t], amt);
}

// ------------------------------------------------------------------ device

// Top-row round buttons, left to right.
const TOP = [
  { key: 'play', title: 'Play / Stop (Space)', fn: () => togglePlay() },
  { key: 'rec', title: 'Record pads into the pattern (X)', fn: () => toggleRec() },
  { key: 'song', title: 'Song mode (M)', fn: () => toggleSong() },
  { key: 'copy', title: 'Copy: arm, then tap a pattern to copy this one into it', fn: () => arm('copy') },
  { key: 'clr', title: 'Clear: arm, then tap a pattern, chain entry or track button', fn: () => arm('clr') },
  { key: 'prev', title: 'Previous chain page ([)', fn: () => pageChain(-1) },
  { key: 'next', title: 'Next chain page (])', fn: () => pageChain(1) },
  { key: 'loop', title: 'Looper record / overdub / play (L)', fn: () => loopPress() },
];

function buildDevice() {
  const g = document.createElement('div');
  g.className = 'lp';
  $('device').appendChild(g);
  // Logical 10×10 layout (0 and 9 are the edge rows/columns). The CSS grid has a thin
  // spacer track between the edges and the 8×8 core, so map logical → physical tracks.
  const phys = (i) => (i === 0 ? 1 : i === 9 ? 12 : i + 2);
  const at = (tag, cls, r, c, rs = 1, cs = 1) => {
    const e = document.createElement(tag);
    e.className = cls;
    e.style.gridRow = `${phys(r)} / span ${rs}`;
    e.style.gridColumn = `${phys(c)} / span ${cs}`;
    return g.appendChild(e);
  };
  const tap = (e, fn) => e.addEventListener('pointerdown', (ev) => { ev.preventDefault(); fn(ev); });

  TOP.forEach((t, c) => {
    dev.top[c] = at('button', 'pd fn', 0, c + 1);
    dev.top[c].title = t.title;
    tap(dev.top[c], t.fn);
  });
  dev.logo = at('div', 'logo', 0, 9);

  for (let r = 0; r < 8; r++) {
    dev.left[r] = at('button', 'pd trk', r + 1, 0);
    dev.left[r].innerHTML = `<span class="lb">${TRACKS[r].name}</span>`;
    dev.left[r].title = `Select ${TRACKS[r].name} (with CLR armed: clear its steps)`;
    tap(dev.left[r], () => pressTrack(r));
    dev.right[r] = at('button', 'pd fn mute', r + 1, 9);
    dev.right[r].title = `Mute ${TRACKS[r].name}`;
    tap(dev.right[r], () => toggleMute(r));
  }

  // Rows 1–2: steps of the selected track (drag paints).
  let paint = null;
  window.addEventListener('pointerup', () => (paint = null));
  for (let s = 0; s < STEPS; s++) {
    const e = at('button', 'pd', 1 + (s >> 3), 1 + (s & 7));
    e.title = `Step ${s + 1}`;
    e.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      if (e.hasPointerCapture(ev.pointerId)) e.releasePointerCapture(ev.pointerId); // let drags reach other steps
      const v = state.patterns[view][sel * STEPS + s] ? 0 : ev.shiftKey ? 127 : state.vel;
      paint = { v };
      setStep(sel, s, v);
    });
    e.addEventListener('pointerenter', (ev) => { if (paint && ev.buttons) setStep(sel, s, paint.v); });
    dev.steps.push(e);
  }

  // Row 3: velocity for new steps.
  VEL_LEVELS.forEach((v, c) => {
    const e = at('button', 'pd', 3, 1 + c);
    e.title = `Velocity ${v}`;
    tap(e, () => { state.vel = v; renderVel(); renderLcd(); save(); });
    dev.vel.push(e);
  });

  // Row 4: song chain, 8 entries per page.
  for (let c = 0; c < 8; c++) {
    const e = at('button', 'pd', 4, 1 + c);
    tap(e, () => pressChain(chainPage * 8 + c));
    dev.chain.push(e);
  }

  // Rows 5–8: drum pads, 2×2 cells each. Invisible sizers keep those rows square.
  for (let r = 5; r < 9; r++) at('div', 'sizer', r, 1);
  TRACKS.forEach((t, i) => {
    const e = at('button', 'pd pad', 5 + (i >> 2) * 2, 1 + (i & 3) * 2, 2, 2);
    e.innerHTML = `<span class="lb">${t.name}</span><span class="key">${KEYS[i].toUpperCase()}</span>`;
    e.title = `${t.name} (${KEYS[i].toUpperCase()})`;
    tap(e, (ev) => hitPad(i, ev.shiftKey ? 127 : 110));
    dev.pads.push(e);
  });

  for (let p = 0; p < PATTERNS; p++) {
    dev.bottom[p] = at('button', 'rb', 9, p + 1);
    dev.bottom[p].title = `Pattern ${PAT_NAMES[p]} (${p + 1})`;
    tap(dev.bottom[p], () => pressPattern(p));
  }
}

function renderDevice() {
  renderTop();
  renderSide();
  renderBottom();
  renderSteps();
  renderVel();
  renderChain();
  renderPads();
}

function renderTop() {
  const loopColor = { [LOOP.EMPTY]: RED, [LOOP.ARMED]: RED, [LOOP.REC]: RED, [LOOP.PLAY]: GREEN, [LOOP.DUB]: AMBER, [LOOP.STOP]: GREEN }[loop.s];
  const loopMode = loop.s === LOOP.ARMED ? 'blink' : loop.s === LOOP.EMPTY || loop.s === LOOP.STOP ? 'dim' : 'on';
  const maxPage = maxChainPage();
  const spec = {
    play: [playing ? 'stop' : 'play', GREEN, playing ? 'on' : 'dim'],
    rec: ['rec', RED, recArm ? 'on' : 'dim'],
    song: ['song', AMBER, state.song ? 'on' : 'dim'],
    copy: ['copy', WHITE, armed === 'copy' ? 'blink' : 'dim'],
    clr: ['clr', RED, armed === 'clr' ? 'blink' : 'dim'],
    prev: ['prev', WHITE, chainPage > 0 ? 'dim' : ''],
    next: ['next', WHITE, chainPage < maxPage ? 'dim' : ''],
    loop: ['loop', loopColor, loopMode],
  };
  TOP.forEach((t, c) => {
    const [ico, color, mode] = spec[t.key];
    const e = dev.top[c];
    if (e.dataset.ico !== ico) { e.innerHTML = icon(ico); e.dataset.ico = ico; }
    light(e, color, mode);
  });
}

function renderSide() {
  for (let t = 0; t < N; t++) {
    const muted = state.pads[t].mute;
    light(dev.left[t], TRACKS[t].color, t === sel ? 'on' : muted ? '' : 'dim');
    const m = dev.right[t], ico = muted ? 'muted' : 'speaker';
    if (m.dataset.ico !== ico) { m.innerHTML = icon(ico); m.dataset.ico = ico; }
    light(m, muted ? AMBER : TRACKS[t].color, muted ? 'on' : 'dim');
  }
}

function renderBottom() {
  for (let p = 0; p < PATTERNS; p++) {
    const b = dev.bottom[p];
    b.textContent = PAT_NAMES[p];
    light(b, PAT_COLORS[p], p === queued ? 'blink' : p === view ? 'on' : hasNotes(p) ? 'dim' : '');
  }
}

function renderSteps() {
  const pat = state.patterns[view], color = TRACKS[sel].color, muted = state.pads[sel].mute;
  for (let s = 0; s < STEPS; s++) {
    const v = pat[sel * STEPS + s];
    const e = dev.steps[s];
    light(e, color, v ? (muted ? 'dim' : velMode(v)) : 'dim', s === curStep);
    e.classList.toggle('alt', !v && ((s >> 2) & 1) === 1);
  }
}

function renderVel() {
  VEL_LEVELS.forEach((v, c) => light(dev.vel[c], WHITE, v === state.vel ? 'on' : v < state.vel ? 'mid' : 'dim'));
}

function renderChain() {
  const len = state.chain.length;
  for (let c = 0; c < 8; c++) {
    const k = chainPage * 8 + c, e = dev.chain[c];
    if (k < len) {
      const p = state.chain[k];
      const cur = k === chainAt;
      light(e, PAT_COLORS[p], k === jumpTo ? 'blink' : cur && state.song ? 'acc' : cur ? 'on' : 'mid', cur && playing && songActive());
      label(e, PAT_NAMES[p]);
      e.title = `Bar ${k + 1}: pattern ${PAT_NAMES[p]}`;
    } else if (k === len && len < MAX_CHAIN) {
      light(e, AMBER, 'dim');
      label(e, '+');
      e.title = `Add pattern ${PAT_NAMES[view]} to the chain`;
    } else {
      light(e, WHITE, '');
      label(e, '');
      e.title = '';
    }
  }
}

function renderPads() {
  TRACKS.forEach((t, i) => light(dev.pads[i], t.color, i === sel ? 'on' : state.pads[i].mute ? 'dim' : 'mid'));
}

function setPlayhead(s) {
  const prev = curStep;
  curStep = s;
  if (prev >= 0) dev.steps[prev].classList.remove('ph');
  if (s >= 0) dev.steps[s].classList.add('ph');
}

function renderLcd() {
  $('lcdBpm').textContent = state.bpm;
  $('lcdPat').textContent = PAT_NAMES[view] + (songActive() ? ` · SONG ${chainAt + 1}/${state.chain.length}` : '');
  $('lcdTrk').textContent = TRACKS[sel].name + (state.pads[sel].mute ? ' (M)' : '');
  $('lcdVel').textContent = state.vel;
  $('lcdStep').textContent = curStep < 0 ? '--' : String(curStep + 1).padStart(2, '0');
  $('lcdLoop').textContent = LOOP_TEXT[loop.s][1].split(' ·')[0];
}

// ------------------------------------------------------------------ actions

function arm(mode) {
  clearTimeout(armTimer);
  armed = armed === mode ? null : mode;
  if (armed) armTimer = setTimeout(() => { armed = null; renderTop(); }, 5000);
  renderTop();
}

function disarm() {
  clearTimeout(armTimer);
  armed = null;
  renderTop();
}

function hitPad(i, vel) {
  engine.send({ t: 'trig', i, v: vel, rec: recArm });
  flashTrack(i, vel / 127);
  if (i !== sel) select(i);
}

function pressTrack(t) {
  if (armed === 'clr') {
    const pat = state.patterns[view].slice();
    pat.fill(0, t * STEPS, (t + 1) * STEPS);
    writePattern(view, pat);
    disarm();
    return;
  }
  select(t);
}

function select(t) {
  sel = t;
  state.track = t;
  renderSide();
  renderSteps();
  renderPads();
  renderEditor();
  renderLcd();
  save();
}

function toggleMute(t) {
  state.pads[t].mute = !state.pads[t].mute;
  sendPad(t);
  renderSide();
  renderPads();
  if (t === sel) { renderSteps(); renderLcd(); }
  save();
}

function setStep(i, s, v) {
  const pat = state.patterns[view];
  if (pat[i * STEPS + s] === v) return;
  pat[i * STEPS + s] = v;
  engine.send({ t: 'step', p: view, i, s, v });
  if (i === sel) renderSteps();
  renderBottom();
  save();
}

function writePattern(p, data) {
  state.patterns[p] = data;
  engine.send({ t: 'pattern', p, data: Uint8Array.from(data) });
  if (p === view) renderSteps();
  renderBottom();
  save();
}

function pressPattern(p) {
  if (armed === 'copy') {
    if (p !== view) writePattern(p, state.patterns[view].slice());
    disarm();
    pickPattern(p);
    return;
  }
  if (armed === 'clr') {
    writePattern(p, new Array(PAT_SIZE).fill(0));
    disarm();
    return;
  }
  pickPattern(p);
}

function pickPattern(p) {
  if (playing && songActive()) {
    // The song owns playback; this only changes what you're editing.
    setView(p);
    return;
  }
  engine.send({ t: 'patSel', p });
  if (!playing) setView(p);
  else { queued = p === playPat ? -1 : p; renderBottom(); }
}

function setView(p) {
  view = p;
  state.view = p;
  renderSteps();
  renderBottom();
  renderChain();
  renderLcd();
  save();
}

function toggleSong() {
  state.song = !state.song;
  engine.send({ t: 'song', v: state.song });
  if (state.song && playing) jumpTo = 0;
  queued = -1;
  renderTop();
  renderBottom();
  renderChain();
  renderLcd();
  save();
}

function maxChainPage() {
  return Math.floor(Math.min(state.chain.length, MAX_CHAIN - 1) / 8);
}

function pageChain(d) {
  chainPage = Math.max(0, Math.min(maxChainPage(), chainPage + d));
  renderTop();
  renderChain();
}

function sendChain() {
  engine.send({ t: 'chain', data: Uint8Array.from(state.chain) });
  chainPage = Math.min(chainPage, maxChainPage());
  renderTop();
  renderChain();
  renderLcd();
  save();
}

function pressChain(k) {
  const len = state.chain.length;
  if (armed === 'clr') {
    if (k < len) {
      state.chain.splice(k, 1);
      if (chainAt >= state.chain.length) chainAt = 0;
      jumpTo = -1;
      sendChain();
    }
    disarm();
    return;
  }
  if (k < len) {
    engine.send({ t: 'jump', i: k });
    if (playing && songActive()) jumpTo = k; else chainAt = k;
    renderChain();
    renderLcd();
  } else if (k === len && len < MAX_CHAIN) {
    state.chain.push(view);
    // When this page fills up, follow the "+" slot onto the next page.
    if ((len + 1) % 8 === 0) chainPage = maxChainPage();
    sendChain();
  }
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

// ------------------------------------------------------------------ tempo / meter

function buildTempo() {
  const host = $('globalKnobs');
  knobs.bpm = new Knob(host, {
    label: 'BPM', min: 60, max: 200, step: 1, value: state.bpm, def: 120, format: (v) => v,
    onChange: (v) => { state.bpm = v; engine.send({ t: 'bpm', v }); renderLcd(); save(); },
  });
  knobs.swing = new Knob(host, {
    label: 'SWING', min: 0, max: 0.5, value: state.swing, def: 0, format: (v) => Math.round(50 + v * 50) + '%',
    onChange: (v) => { state.swing = v; engine.send({ t: 'swing', v }); save(); },
  });
  knobs.master = new Knob(host, {
    label: 'MASTER', value: state.master, def: 0.8, format: (v) => Math.round(v * 100),
    onChange: (v) => { state.master = v; engine.send({ t: 'master', v }); save(); },
  });

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
  engine.send({ t: 'recArm', v: recArm });
  renderTop();
}

function onTransport(v) {
  playing = v;
  if (!v) {
    engine.clearTimed();
    setPlayhead(-1);
    $('brandDot').classList.remove('on');
    dev.logo.classList.remove('on');
    playPat = -1;
    queued = -1;
    jumpTo = -1;
    chainAt = 0;
  }
  renderTop();
  renderBottom();
  renderChain();
  renderLcd();
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
  const [text, longText] = LOOP_TEXT[loop.s];
  $('loopBtn').dataset.s = loop.s;
  $('loopLabel').textContent = text;
  $('loopState').textContent = longText + (loop.len ? ` · ${loop.sec.toFixed(1)}s` : '');
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
  leds.style.setProperty('--lc', getComputedStyle($('loopBtn')).getPropertyValue('--c'));
  if (dev.top.length) { renderTop(); renderLcd(); }
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
    if (k >= '1' && k <= '8') { pressPattern(+k - 1); return; }
    if (k === ' ') { e.preventDefault(); togglePlay(); }
    else if (k === 'arrowup') { e.preventDefault(); select((sel + N - 1) % N); }
    else if (k === 'arrowdown') { e.preventDefault(); select((sel + 1) % N); }
    else if (k === '[') pageChain(-1);
    else if (k === ']') pageChain(1);
    else if (k === 'm') toggleSong();
    else if (k === 'x') toggleRec();
    else if (k === 'l') loopPress();
    else if (k === 'k') engine.send({ t: 'loop', cmd: 'stop' });
    else if (k === 'u') engine.send({ t: 'loop', cmd: 'undo' });
    else if (k === 'escape') disarm();
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
      if (ev.p !== view) setView(ev.p); else renderBottom();
    }
    if (ev.c >= 0 && ev.c !== chainAt) {
      chainAt = ev.c;
      if (jumpTo === ev.c) jumpTo = -1;
      chainPage = Math.floor(chainAt / 8);
      renderTop();
      renderChain();
    }
    setPlayhead(ev.s);
    renderLcd();
    const beat = ev.s % 4 === 0;
    $('brandDot').classList.toggle('on', beat);
    dev.logo.classList.toggle('on', beat);
    const pat = state.patterns[ev.p];
    for (let i = 0; i < N; i++) if (mask & (1 << i)) flashTrack(i, pat[i * STEPS + ev.s] / 127 || 0.8);
  });
  engine.addEventListener('transport', (e) => onTransport(e.detail.v));
  engine.addEventListener('bpm', (e) => { state.bpm = e.detail.v; knobs.bpm.set(e.detail.v, false); renderLcd(); });
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
    if (p === view && i === sel) renderSteps();
    renderBottom();
    save();
  });
  engine.addEventListener('sampled', (e) => onSampled(e.detail));
  engine.addEventListener('patq', (e) => { queued = e.detail.q; renderBottom(); });
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

  buildTempo();
  buildDevice();
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
  engine.send({ t: 'patSel', p: view });
  for (let i = 0; i < N; i++) {
    sendPad(i);
    setSample(i, makeSample(i, sr), 'synth');
  }

  $('boot').hidden = true;
  $('app').hidden = false;
  renderDevice();
  renderEditor();
  renderLcd();
  requestAnimationFrame(frame);
}

$('power').addEventListener('click', boot);
