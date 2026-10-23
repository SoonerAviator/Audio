import { Engine, LOOP, LOOP_SLOTS } from './engine.js';
import { Knob } from './knob.js';
import { TRACKS, makeSample, normalize } from './kit.js';

const N = 8;
const STEPS = 16;
const PATTERNS = 8;
const PAT_SIZE = N * STEPS;
const MAX_CHAIN = 64;
const PAT_NAMES = 'ABCDEFGH';
const PAT_COLORS = ['#3dffa8', '#22d3ff', '#6b7bff', '#b46bff', '#ff5ad8', '#ff3b5c', '#ff8a1f', '#ffd23f'];
const VEL_LEVELS = [30, 46, 62, 78, 94, 110, 127];
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
let loop = { s: LOOP.EMPTY, bars: state.loopBars, slot: 0, has: 0, len: 0, sec: 0, undo: false, dubAfter: false };
let loopPick = false;    // looper row is showing the slot picker
let loopPickTimer = 0;
let loopClearArmed = 0;
let taps = [];
let loopPos = 0, loopBar = 0;
let meterL = 0, meterR = 0;
let curStep = -1;
let playPat = -1;        // pattern the engine is playing, from ticks
let queued = -1;         // pattern waiting for the bar line
let chainAt = 0;         // current chain entry (or start entry while stopped)
let jumpTo = -1;         // chain entry waiting for the bar line
let chainPage = 0;
let armed = null;        // 'copy' | 'clr' | null
let selOn = false;       // SELECT active: pads do their second function
let selLatched = false;  // tapped (latched) rather than held
let selUsed = false;     // a second function was used while SELECT was held
let selDownAt = 0;
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
  tap: '<path d="M8 21h8l-3-17h-2z"/><path d="M12 15l6-8"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  dub: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  drum: '<ellipse cx="12" cy="8" rx="8" ry="3"/><path d="M4 8v7c0 1.7 3.6 3 8 3s8-1.3 8-3V8"/>',
  phones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  help: '<path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><circle class="f" cx="12" cy="17.5" r="1.2"/>',
  solo: '<path class="f" d="M11 5L6 9H3v6h3l5 4z"/><path d="M15 12h6M18 9v6"/>',
  speaker: '<path class="f" d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  muted: '<path class="f" d="M11 5L6 9H3v6h3l5 4z"/><path d="M16 9l5 6M21 9l-5 6"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const dev = { select: null, dyn: null, top: [], help: null, left: [], right: [], steps: [], vel: [], chain: [], pats: [], loop: [], loopProg: null, pads: [], tools: [] };
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
    patterns, view: 0, chain: [0, 0, 0, 1], song: false, track: 0, vel: 110, latTrim: 0,
    dyn: true,   // pads follow touch pressure / contact size
    solo: -1,    // soloed track, or -1
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
      if (!VEL_LEVELS.includes(st.vel)) st.vel = 110;
      if (!(st.solo >= -1 && st.solo < N)) st.solo = -1;
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

// A track is silent when muted or when another track is soloed.
const silent = (i) => state.pads[i].mute || (state.solo >= 0 && state.solo !== i);

function sendPad(i) {
  const p = state.pads[i];
  engine.send({ t: 'pad', i, gain: p.gain, pitch: p.pitch, pan: p.pan, decay: decayTime(p.decay), choke: p.choke, mute: silent(i) });
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

// A soft bloom from the pad's centre that fades out: the pad itself never changes.
function glow(e, amt = 1) {
  let g = e.querySelector('.glow');
  if (!g) { g = document.createElement('span'); g.className = 'glow'; e.prepend(g); }
  g.animate([{ opacity: Math.min(1, 0.9 * amt) }, { opacity: 0 }], { duration: 450, easing: 'cubic-bezier(.25,.6,.3,1)' });
}

function flashTrack(t, amt = 1) {
  glow(dev.pads[t], amt);
  glow(dev.left[t], amt * 0.7);
}

// ------------------------------------------------------------------ device

// Top-row round buttons, left to right.
const TOP = [
  { key: 'play', title: 'Play / Stop (Space). SELECT + PLAY: restart from bar 1', fn: () => (selOn ? restart() : togglePlay()) },
  { key: 'rec', title: 'Record pads into the pattern (X)', fn: () => toggleRec() },
  { key: 'song', title: 'Song mode (M)', fn: () => toggleSong() },
  { key: 'copy', title: 'Copy: arm, then tap a pattern to copy this one into it', fn: () => arm('copy') },
  { key: 'clr', title: 'Clear: arm, then tap a pattern, chain entry or track button', fn: () => arm('clr') },
  { key: 'prev', title: 'Previous chain page ([)', fn: () => pageChain(-1) },
  { key: 'next', title: 'Next chain page (])', fn: () => pageChain(1) },
  { key: 'tap', title: 'Tap tempo: tap in time to set the BPM', fn: () => tapTempo() },
];

function buildDevice() {
  const g = document.createElement('div');
  g.className = 'lp';
  $('device').appendChild(g);
  $('device').addEventListener('contextmenu', (e) => e.preventDefault()); // long-press on touch screens
  // Logical layout: row 0 is the function row, rows 1–11 the 8-wide core; columns 0 and 9
  // are the track/mute strips. The CSS grid has thin spacer tracks around the core,
  // so logical indices map to physical grid lines.
  const physR = (r) => (r === 0 ? 1 : r + 2);
  const physC = (c) => (c === 0 ? 1 : c === 9 ? 12 : c + 2);
  const at = (tag, cls, r, c, rs = 1, cs = 1) => {
    const e = document.createElement(tag);
    e.className = cls;
    e.style.gridRow = `${physR(r)} / span ${rs}`;
    e.style.gridColumn = `${physC(c)} / span ${cs}`;
    return g.appendChild(e);
  };
  const tap = (e, fn) => e.addEventListener('pointerdown', (ev) => { ev.preventDefault(); fn(ev); });

  TOP.forEach((t, c) => {
    dev.top[c] = at('button', 'pd fn', 0, c + 1);
    dev.top[c].title = t.title;
    tap(dev.top[c], t.fn);
  });
  // SELECT (top-left): hold, or tap to latch, for each pad's second function.
  dev.select = at('button', 'pd fn select-pad', 0, 0);
  dev.select.title = 'Select: hold, or tap to latch, for second functions';
  dev.select.innerHTML = '<span class="num">SEL</span>';
  dev.select.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (selLatched) { setSelect(false); return; }
    selDownAt = performance.now();
    selUsed = false;
    try { dev.select.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    setSelect(true);
  });
  const selUp = () => {
    if (!selOn || selLatched) return;
    // A quick tap with nothing pressed meanwhile latches; a hold acts while held.
    if (!selUsed && performance.now() - selDownAt < 350) { selLatched = true; renderSelect(); }
    else setSelect(false);
  };
  dev.select.addEventListener('pointerup', selUp);
  dev.select.addEventListener('pointercancel', selUp);
  dev.top[0].classList.add('sf'); // pads marked sf have a SELECT function

  dev.help = at('button', 'pd fn', 0, 9);
  dev.help.title = 'How the grid works';
  dev.help.innerHTML = icon('help');
  dev.help.addEventListener('click', () => $('help').showModal());

  // Track select / mute strips run the full height of the core.
  const leftStrip = at('div', 'strip', 1, 0, 11), rightStrip = at('div', 'strip', 1, 9, 11);
  for (let r = 0; r < 8; r++) {
    dev.left[r] = leftStrip.appendChild(document.createElement('button'));
    dev.left[r].className = 'pd trk sf';
    dev.left[r].innerHTML = `<span class="glow"></span><span class="lb">${TRACKS[r].name}</span>`;
    dev.left[r].title = `Select ${TRACKS[r].name} (with CLR armed: clear its steps)`;
    tap(dev.left[r], () => pressTrack(r));
    dev.right[r] = rightStrip.appendChild(document.createElement('button'));
    dev.right[r].className = 'pd fn mute sf';
    dev.right[r].title = `Mute ${TRACKS[r].name}`;
    tap(dev.right[r], () => toggleMute(r));
  }

  // Rows 1–2: steps of the selected track (drag paints).
  // One paint stroke per finger: pointerId → velocity being painted.
  const paint = new Map();
  const endPaint = (ev) => paint.delete(ev.pointerId);
  window.addEventListener('pointerup', endPaint);
  window.addEventListener('pointercancel', endPaint);
  for (let s = 0; s < STEPS; s++) {
    const e = at('button', 'pd sf', 1 + (s >> 3), 1 + (s & 7));
    e.title = `Step ${s + 1}`;
    e.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      if (e.hasPointerCapture(ev.pointerId)) e.releasePointerCapture(ev.pointerId); // let drags reach other steps
      const cur = state.patterns[view][sel * STEPS + s];
      const v = selOn ? (selUsed = true, state.vel) : cur ? 0 : ev.shiftKey ? 127 : state.vel;
      paint.set(ev.pointerId, v);
      setStep(sel, s, v);
    });
    e.addEventListener('pointerenter', (ev) => { if (paint.has(ev.pointerId)) setStep(sel, s, paint.get(ev.pointerId)); });
    dev.steps.push(e);
  }

  // Row 3: DYN switch, then the velocity bar (new steps, and pad hits without pressure).
  dev.dyn = at('button', 'pd fn', 3, 1);
  dev.dyn.innerHTML = '<span class="num">DYN</span>';
  tap(dev.dyn, () => { state.dyn = !state.dyn; renderVel(); save(); });
  VEL_LEVELS.forEach((v, c) => {
    const e = at('button', 'pd', 3, 2 + c);
    e.title = `Velocity ${v}`;
    tap(e, () => { state.vel = v; renderVel(); renderLcd(); save(); });
    dev.vel.push(e);
  });

  // Row 4: song chain, 8 entries per page.
  for (let c = 0; c < 8; c++) {
    const e = at('button', 'pd sf', 4, 1 + c);
    tap(e, () => pressChain(chainPage * 8 + c));
    dev.chain.push(e);
  }

  // Row 5: patterns A–H.
  for (let p = 0; p < PATTERNS; p++) {
    const e = at('button', 'pd sf', 5, 1 + p);
    e.title = `Pattern ${PAT_NAMES[p]} (${p + 1})`;
    tap(e, () => pressPattern(p));
    dev.pats.push(e);
  }

  // Row 6: looper.
  for (let c = 0; c < 8; c++) {
    const e = at('button', 'pd fn', 6, 1 + c);
    tap(e, () => pressLoop(c));
    dev.loop.push(e);
  }

  // Rows 7–10: drum pads, 2×2 cells each. Invisible sizers keep those rows square.
  for (let r = 7; r < 11; r++) at('div', 'sizer', r, 1);
  TRACKS.forEach((t, i) => {
    const e = at('button', 'pd pad sf', 7 + (i >> 2) * 2, 1 + (i & 3) * 2, 2, 2);
    e.innerHTML = `<span class="glow"></span><span class="lb">${t.name}</span><span class="key">${KEYS[i].toUpperCase()}</span>`;
    e.title = `${t.name} (${KEYS[i].toUpperCase()})`;
    tap(e, (ev) => {
      if (selOn) { selUsed = true; select(i); return; } // SELECT: pick the track silently
      hitPad(i, hitVelocity(ev));
    });
    dev.pads.push(e);
  });

  // Row 11: sample tools for the selected track, each 2 cells wide under a drum pad column.
  at('div', 'sizer', 11, 1);
  for (let k = 0; k < 4; k++) {
    const e = at('button', 'pd fn wide' + (k === 2 ? ' sf' : ''), 11, 1 + k * 2, 1, 2);
    tap(e, () => pressTool(k));
    dev.tools.push(e);
  }
}

function renderDevice() {
  renderTop();
  renderSide();
  renderBottom();
  renderSteps();
  renderVel();
  renderChain();
  renderLoopRow();
  renderPads();
  renderTools();
  renderSelect();
}

function setSelect(on) {
  selOn = on;
  if (!on) selLatched = false;
  renderSelect();
}

function renderSelect() {
  light(dev.select, AMBER, selOn ? (selLatched ? 'acc' : 'on') : 'dim');
  $('device').classList.toggle('select', selOn);
  $('lcd').classList.toggle('hinting', selOn);
}

function renderTools() {
  const t = TRACKS[sel], p = state.pads[sel], rec = sampling >= 0;
  const spec = [
    ['folder', 'LOAD', 'dim', `Load an audio file onto ${t.name}`],
    [rec ? 'stop' : 'mic', rec ? 'STOP' : 'SAMPLE', rec ? 'blink' : 'dim', rec ? 'Stop recording' : `Record from the mic onto ${t.name}`],
    ['reset', 'RESET', 'dim', `Restore the built-in ${t.name} sound`],
    ['link', 'CHOKE', p.choke ? 'on' : 'dim', 'Choke: tracks with choke on cut each other off (like open and closed hi-hats)'],
  ];
  spec.forEach(([ico, name, mode, title], k) => {
    const e = dev.tools[k];
    content(e, ico + name, `${icon(ico)}<span class="lb">${name}</span>`);
    light(e, k === 1 && rec ? RED : t.color, mode);
    e.title = title;
  });
}

function renderTop() {
  light(dev.help, WHITE, 'dim');
  const maxPage = maxChainPage();
  const spec = {
    play: [playing ? 'stop' : 'play', GREEN, playing ? 'on' : 'dim'],
    rec: ['rec', RED, recArm ? 'on' : 'dim'],
    song: ['song', AMBER, state.song ? 'on' : 'dim'],
    copy: ['copy', WHITE, armed === 'copy' ? 'blink' : 'dim'],
    clr: ['clr', RED, armed === 'clr' ? 'blink' : 'dim'],
    prev: ['prev', WHITE, chainPage > 0 ? 'dim' : ''],
    next: ['next', WHITE, chainPage < maxPage ? 'dim' : ''],
    tap: ['tap', WHITE, knobs.bpm && knobs.bpm.disabled ? '' : 'dim'],
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
    const muted = state.pads[t].mute, off = silent(t), solo = state.solo === t;
    light(dev.left[t], TRACKS[t].color, t === sel ? 'on' : off ? '' : 'dim');
    const m = dev.right[t], ico = solo ? 'solo' : off ? 'muted' : 'speaker';
    content(m, ico, icon(ico));
    light(m, solo ? GREEN : muted ? AMBER : TRACKS[t].color, solo || muted ? 'on' : off ? '' : 'dim');
    m.title = solo ? `${TRACKS[t].name} is soloed (SELECT + this pad to unsolo)` : `Mute ${TRACKS[t].name} (SELECT + this pad: solo)`;
  }
}

// Pattern row (row 5).
function renderBottom() {
  for (let p = 0; p < PATTERNS; p++) {
    const e = dev.pats[p];
    light(e, PAT_COLORS[p], p === queued ? 'blink' : p === view ? 'on' : hasNotes(p) ? 'mid' : 'dim');
    label(e, PAT_NAMES[p]);
  }
}

// Swap a pad's inner markup only when it changes (keeps the DOM quiet on every render).
function content(e, key, html) {
  if (e.dataset.k === key) return;
  e.dataset.k = key;
  e.innerHTML = html;
}

// Looper row (row 6): either the controls or, while picking, the 8 save slots.
function renderLoopRow() {
  const has = (i) => (loop.has >> i) & 1;
  if (loopPick) {
    for (let i = 0; i < LOOP_SLOTS; i++) {
      const e = dev.loop[i];
      content(e, `slot${i}`, `<span class="num">${i + 1}</span>`);
      light(e, PAT_COLORS[i], i === loop.slot ? 'on' : has(i) ? 'mid' : 'dim');
      e.title = `Loop slot ${i + 1}${has(i) ? '' : ' (empty)'}`;
    }
    dev.loopProg = null;
    return;
  }
  const [e0, e1, e2, e3, e4, e5, e6, e7] = dev.loop;
  const st = loop.s;
  const main = {
    [LOOP.EMPTY]: ['rec', RED, 'dim', 'Record a loop (L): starts now'],
    [LOOP.REC]: ['rec', loop.dubAfter ? AMBER : RED, 'on', 'Recording: tap again to go straight into overdub'],
    [LOOP.PLAY]: ['play', GREEN, 'on', 'Playing: tap to overdub (L)'],
    [LOOP.DUB]: ['dub', AMBER, 'on', 'Overdubbing: tap to stop overdubbing (L)'],
    [LOOP.STOP]: ['play', GREEN, 'dim', 'Stopped: tap to play (L)'],
  }[st];
  content(e0, 'main-' + main[0], `<span class="prog"></span>${icon(main[0])}`);
  dev.loopProg = e0.querySelector('.prog');
  light(e0, main[1], main[2]);
  e0.title = main[3];

  content(e1, 'stop', icon('stop'));
  light(e1, WHITE, st === LOOP.REC || st === LOOP.PLAY || st === LOOP.DUB ? 'dim' : '');
  e1.title = 'Stop loop (K)';

  content(e2, `slot-${loop.slot}`, `<span class="num">${loop.slot + 1}<small>SLOT</small></span>`);
  light(e2, PAT_COLORS[loop.slot], has(loop.slot) ? 'mid' : 'dim');
  e2.title = 'Choose a loop slot';

  content(e3, 'undo', icon('undo'));
  light(e3, WHITE, loop.undo ? 'dim' : '');
  e3.title = 'Undo last overdub (U)';

  content(e4, 'clr', icon('clr'));
  light(e4, RED, loopClearArmed ? 'blink' : has(loop.slot) || st === LOOP.REC ? 'dim' : '');
  e4.title = 'Clear this slot (tap twice)';

  content(e5, `bars-${loop.bars}`, `<span class="num">${loop.bars}<small>BAR${loop.bars > 1 ? 'S' : ''}</small></span>`);
  light(e5, AMBER, st === LOOP.EMPTY ? 'dim' : 'mid');
  e5.title = st === LOOP.EMPTY ? 'Loop length: tap to cycle 1, 2, 4, 8 bars' : 'Loop length (clear the slot to change it)';

  const src = state.loopSrc === 0 ? 'mic' : 'drum';
  content(e6, 'src-' + src, icon(src));
  light(e6, WHITE, 'dim');
  e6.title = state.loopSrc === 0 ? 'Recording from the mic (tap for drums)' : 'Recording the drums (tap for mic)';

  content(e7, 'mon', icon('phones'));
  light(e7, GREEN, state.monitor ? 'on' : 'dim');
  e7.title = 'Hear the mic input';
}

function renderSteps() {
  const pat = state.patterns[view], color = TRACKS[sel].color, muted = silent(sel);
  for (let s = 0; s < STEPS; s++) {
    const v = pat[sel * STEPS + s];
    const e = dev.steps[s];
    light(e, color, v ? (muted ? 'dim' : velMode(v)) : 'dim', s === curStep);
    e.classList.toggle('alt', !v && ((s >> 2) & 1) === 1);
  }
}

function renderVel() {
  light(dev.dyn, AMBER, state.dyn ? 'on' : 'dim');
  dev.dyn.title = state.dyn
    ? 'DYN on: pads follow how hard you hit (where the device reports it). Tap to play every hit at the velocity bar level.'
    : 'DYN off: pads play at the velocity bar level. Tap to follow how hard you hit.';
  VEL_LEVELS.forEach((v, c) => {
    // A rising bar: levels up to the chosen one are softly lit, the chosen one glows.
    light(dev.vel[c], WHITE, v === state.vel ? 'on' : 'dim');
    dev.vel[c].classList.toggle('alt', v > state.vel);
  });
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
  TRACKS.forEach((t, i) => light(dev.pads[i], t.color, i === sel ? 'on' : silent(i) ? 'dim' : 'mid'));
}

function setPlayhead(s) {
  const prev = curStep;
  curStep = s;
  if (prev >= 0) dev.steps[prev].classList.remove('ph');
  if (s >= 0) dev.steps[s].classList.add('ph');
}

function renderLcd() {
  $('lcdPat').textContent = PAT_NAMES[view] + (songActive() ? ` · SONG ${chainAt + 1}/${state.chain.length}` : '');
  $('lcdTrk').textContent = TRACKS[sel].name + (state.solo === sel ? ' (S)' : silent(sel) ? ' (M)' : '');
  $('lcdVel').textContent = state.vel;
  $('lcdStep').textContent = curStep < 0 ? '--' : String(curStep + 1).padStart(2, '0');
  $('lcdLoop').textContent = `S${loop.slot + 1} ${LOOP_TEXT[loop.s]}` + ((loop.has >> loop.slot) & 1 ? ` ${loop.bars}B` : '');
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

// How hard a pad was hit, on devices that tell us: pen/touch pressure first, then finger
// contact size (a firmer hit flattens the fingertip), else a fixed 110. Both adapt to the
// range this device actually produces, so soft and hard stay usable on any screen.
const hitRange = { maxP: 0.6, minW: Infinity, maxW: 0 };
function hitVelocity(ev) {
  if (ev.shiftKey) return 127;
  if (!state.dyn) return state.vel;
  const p = ev.pressure;
  // Browsers report 0.5 (or 0/1) when there's no real pressure sensor.
  if (ev.pointerType !== 'mouse' && p > 0 && p !== 0.5 && p !== 1) {
    hitRange.maxP = Math.max(hitRange.maxP * 0.98, p, 0.3); // hardest recent hit = full velocity
    return Math.round(30 + 97 * Math.pow(Math.min(1, p / hitRange.maxP), 0.7));
  }
  const w = Math.max(ev.width || 0, ev.height || 0);
  if (ev.pointerType === 'touch' && w > 1) {
    hitRange.minW = Math.min(hitRange.minW, w);
    hitRange.maxW = Math.max(hitRange.maxW, w);
    const span = hitRange.maxW - hitRange.minW;
    if (span >= 4) return Math.round(40 + 87 * ((w - hitRange.minW) / span));
  }
  return state.vel; // no pressure info: use the velocity bar
}

function hitPad(i, vel) {
  $('lcdHit').textContent = vel;
  engine.send({ t: 'trig', i, v: vel, rec: recArm });
  flashTrack(i, vel / 127);
  if (i !== sel) select(i);
}

function pressTrack(t) {
  if (armed === 'clr' || selOn) {
    if (selOn) selUsed = true;
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
  if (selOn) {
    selUsed = true;
    state.solo = state.solo === t ? -1 : t;
    for (let i = 0; i < N; i++) sendPad(i);
  } else {
    state.pads[t].mute = !state.pads[t].mute;
    sendPad(t);
  }
  renderSide();
  renderPads();
  renderSteps();
  renderLcd();
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
  if (armed === 'copy' || selOn) {
    if (selOn) selUsed = true;
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
  if (armed === 'clr' || selOn) {
    if (selOn) selUsed = true;
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
  window.addEventListener('resize', drawWave);
  $('helpClose').addEventListener('click', () => $('help').close());
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').close(); }); // backdrop
}

function pressTool(k) {
  if (k === 0) $('file').click();
  else if (k === 1) toggleSampling();
  else if (k === 2 && selOn) { // SELECT + RESET: every track back to its built-in sound
    selUsed = true;
    for (let i = 0; i < N; i++) setSample(i, makeSample(i, engine.sampleRate), 'synth');
  }
  else if (k === 2) setSample(sel, makeSample(sel, engine.sampleRate), 'synth');
  else {
    state.pads[sel].choke = state.pads[sel].choke ? 0 : 1;
    sendPad(sel);
    renderTools();
    save();
  }
}

async function toggleSampling() {
  if (sampling >= 0) {
    engine.send({ t: 'sampStop' });
    return;
  }
  if (!engine.mic && !(await micOn())) {
    $('editSrc').textContent = 'mic unavailable · use LOAD';
    return;
  }
  sampling = sel;
  engine.send({ t: 'sampRec', i: sel });
  renderTools();
}

function onSampled({ i, data }) {
  sampling = -1;
  renderTools();
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
  const row = $('trackKnobs');
  row.style.setProperty('--c', t.color);
  row.style.setProperty('--kc', t.color);
  $('editName').textContent = t.name;
  $('editSrc').textContent = srcNames[sel];
  knobs.gain.set(p.gain, false);
  knobs.pitch.set(p.pitch, false);
  knobs.pan.set(p.pan, false);
  knobs.decay.set(p.decay, false);
  if (dev.tools.length) renderTools();
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
    label: 'BPM', min: 60, max: 200, step: 1, value: state.bpm, def: 120, display: true, format: (v) => v,
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

function restart() {
  selUsed = true;
  if (playing) engine.send({ t: 'stop' });
  engine.send({ t: 'play' });
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
  [LOOP.EMPTY]: 'EMPTY',
  [LOOP.REC]: 'REC',
  [LOOP.PLAY]: 'PLAY',
  [LOOP.DUB]: 'DUB',
  [LOOP.STOP]: 'STOP',
};

function buildLooper() {
  const host = $('loopKnobs');
  new Knob(host, {
    label: 'LEVEL', value: state.loopGain, def: 1, format: (v) => Math.round(v * 100),
    onChange: (v) => { state.loopGain = v; engine.send({ t: 'loopGain', v }); save(); },
  }).el.style.setProperty('--kc', 'var(--green)');
  knobs.trim = new Knob(host, {
    label: 'MIC TRIM', min: -30, max: 60, step: 1, value: state.latTrim, def: 0, bipolar: true,
    format: (v) => (v > 0 ? '+' : '') + v + 'ms',
    onChange: (v) => { state.latTrim = v; sendLatency(); save(); },
  });
  knobs.trim.el.style.setProperty('--kc', 'var(--green)');
  state.monitor = false;
  renderLooper();
}

// Tell the engine how far to pull mic recordings back to line up with what you heard.
function sendLatency() {
  const ms = Math.max(0, engine.roundTrip() * 1000 + state.latTrim);
  engine.send({ t: 'latency', v: Math.round((ms / 1000) * engine.sampleRate) });
  if (knobs.trim) knobs.trim.el.title = engine.mic
    ? `Mic recordings are shifted ${Math.round(ms)} ms earlier to make up for audio latency. Turn this if they still sound late or early.`
    : 'Mic latency compensation starts once the mic is on. Drum recordings need none.';
}

async function micOn() {
  if (!(await engine.enableInput())) return false;
  sendLatency();
  return true;
}

async function loopMain() {
  if (loop.s === LOOP.EMPTY && state.loopSrc === 0 && !engine.mic && !(await micOn())) {
    $('lcdLoop').textContent = 'NO MIC · USE DRUMS';
    return;
  }
  engine.send({ t: 'loop', cmd: 'rec' });
}

function closePicker() {
  clearTimeout(loopPickTimer);
  loopPick = false;
  renderLoopRow();
}

async function pressLoop(c) {
  if (loopPick) {
    if (c !== loop.slot) {
      engine.ensureSlot(c);
      engine.send({ t: 'slot', i: c });
    }
    closePicker();
    return;
  }
  if (c === 0) loopMain();
  else if (c === 1) engine.send({ t: 'loop', cmd: 'stop' });
  else if (c === 2) {
    loopPick = true;
    loopPickTimer = setTimeout(closePicker, 6000);
    renderLoopRow();
  } else if (c === 3) engine.send({ t: 'loop', cmd: 'undo' });
  else if (c === 4) {
    if (loopClearArmed) {
      clearTimeout(loopClearArmed);
      loopClearArmed = 0;
      engine.send({ t: 'loop', cmd: 'clear' });
    } else {
      loopClearArmed = setTimeout(() => { loopClearArmed = 0; renderLoopRow(); }, 3000);
    }
    renderLoopRow();
  } else if (c === 5) {
    if (loop.s !== LOOP.EMPTY) return;
    const opts = [1, 2, 4, 8];
    state.loopBars = opts[(opts.indexOf(loop.bars) + 1) % opts.length];
    engine.send({ t: 'loopBars', v: state.loopBars });
    save();
  } else if (c === 6) {
    state.loopSrc = state.loopSrc ? 0 : 1;
    engine.send({ t: 'loopSrc', v: state.loopSrc });
    if (state.loopSrc === 0 && !engine.mic) micOn();
    renderLoopRow();
    save();
  } else if (c === 7) {
    const on = !state.monitor;
    if (on && !engine.mic && !(await micOn())) return;
    state.monitor = on;
    engine.send({ t: 'monitor', v: on });
    renderLoopRow();
  }
}

function renderLooper() {
  const locked = loop.has !== 0 || loop.s === LOOP.REC;
  knobs.bpm.setDisabled(locked, locked ? 'Clear all loop slots to change tempo' : '');
  if (dev.loop.length) { renderLoopRow(); renderTop(); renderLcd(); }
}

function renderLoopProgress() {
  if (!dev.loopProg) return;
  const active = playing && (loop.s === LOOP.REC || loop.s === LOOP.PLAY || loop.s === LOOP.DUB);
  dev.loopProg.style.setProperty('--p', active ? loopPos.toFixed(3) : 0);
}

function tapTempo() {
  glow(dev.top[7]);
  if (knobs.bpm.disabled) return;
  const now = performance.now();
  taps = taps.filter((t) => now - t < 2000).slice(-4);
  taps.push(now);
  if (taps.length < 2) return;
  const beat = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  knobs.bpm.set(Math.round(Math.min(200, Math.max(60, 60000 / beat))));
}

// ------------------------------------------------------------------ input

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.target.tagName === 'INPUT' || $('help').open) return;
    const k = e.key.toLowerCase();
    const pad = KEYS.indexOf(k);
    if (pad >= 0) { hitPad(pad, e.shiftKey ? 127 : state.vel); return; }
    if (k >= '1' && k <= '8') { pressPattern(+k - 1); return; }
    if (k === ' ') { e.preventDefault(); togglePlay(); }
    else if (k === 'arrowup') { e.preventDefault(); select((sel + N - 1) % N); }
    else if (k === 'arrowdown') { e.preventDefault(); select((sel + 1) % N); }
    else if (k === '[') pageChain(-1);
    else if (k === ']') pageChain(1);
    else if (k === 'm') toggleSong();
    else if (k === 'x') toggleRec();
    else if (k === 'l') loopMain();
    else if (k === 'k') engine.send({ t: 'loop', cmd: 'stop' });
    else if (k === 'u') engine.send({ t: 'loop', cmd: 'undo' });
    else if (k === 'escape') { disarm(); if (loopPick) closePicker(); }
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
  engine.ensureSlot(0);
  sendLatency();
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
