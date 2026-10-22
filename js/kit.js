// Default kit, synthesized at the context sample rate (no sample files to load).

const TAU = Math.PI * 2;
const noise = () => Math.random() * 2 - 1;

function buf(sr, sec) {
  return new Float32Array(Math.floor(sr * sec));
}

// RBJ biquad, processed in place.
function biquad(x, type, f, q, sr) {
  const w = (TAU * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; } // band-pass
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  b0 /= a0; b1 /= a0; b2 /= a0;
  const k1 = a1 / a0, k2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - k1 * y1 - k2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

export function normalize(x, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  if (m > 0) { const g = peak / m; for (let i = 0; i < x.length; i++) x[i] *= g; }
  return x;
}

// Short fade-out so truncated tails never click.
function tail(x, sr, ms = 5) {
  const n = Math.min(x.length, Math.floor((sr * ms) / 1000));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
  return x;
}

function kick(sr) {
  const o = buf(sr, 0.6);
  let ph = 0;
  for (let i = 0; i < o.length; i++) {
    const t = i / sr;
    ph += (TAU * (45 + 110 * Math.exp(-t * 30))) / sr;
    const click = t < 0.003 ? noise() * 0.25 * (1 - t / 0.003) : 0;
    o[i] = Math.tanh(1.6 * (Math.sin(ph) * Math.exp(-t * 6.5) + click));
  }
  return o;
}

function snare(sr) {
  const o = buf(sr, 0.35), n = buf(sr, 0.35);
  for (let i = 0; i < n.length; i++) n[i] = noise();
  biquad(n, 'hp', 1200, 0.7, sr);
  for (let i = 0; i < o.length; i++) {
    const t = i / sr;
    const tone = (Math.sin(TAU * 185 * t) * 0.6 + Math.sin(TAU * 330 * t) * 0.4) * Math.exp(-t * 28);
    o[i] = tone * 0.8 + n[i] * Math.exp(-t * 16) * 0.7;
  }
  return o;
}

function clap(sr) {
  const o = buf(sr, 0.4);
  for (let i = 0; i < o.length; i++) o[i] = noise();
  biquad(o, 'bp', 1150, 1.1, sr);
  for (let i = 0; i < o.length; i++) {
    const t = i / sr;
    let e = 0;
    for (const d of [0, 0.011, 0.022]) if (t >= d) e = Math.max(e, Math.exp(-(t - d) * 230));
    if (t >= 0.031) e = Math.max(e, 0.85 * Math.exp(-(t - 0.031) * 14));
    o[i] *= e;
  }
  return o;
}

// 808-style metallic hat: six detuned squares through a high-pass.
function hat(sr, sec, rate) {
  const o = buf(sr, sec);
  const f = [205.3, 304.4, 369.6, 522.7, 540, 800];
  for (let i = 0; i < o.length; i++) {
    const t = i / sr;
    let s = 0;
    for (let k = 0; k < 6; k++) s += Math.sin(TAU * f[k] * 1.4 * t) > 0 ? 1 : -1;
    o[i] = s / 6 + noise() * 0.3;
  }
  biquad(o, 'bp', 9000, 0.8, sr);
  biquad(o, 'hp', 7000, 0.7, sr);
  for (let i = 0; i < o.length; i++) o[i] *= Math.exp((-i / sr) * rate);
  return o;
}

function tom(sr) {
  const o = buf(sr, 0.5);
  let ph = 0;
  for (let i = 0; i < o.length; i++) {
    const t = i / sr;
    ph += (TAU * (95 + 70 * Math.exp(-t * 18))) / sr;
    o[i] = Math.sin(ph) * Math.exp(-t * 9) + noise() * 0.04 * Math.exp(-t * 60);
  }
  return o;
}

function rim(sr) {
  const o = buf(sr, 0.08);
  for (let i = 0; i < o.length; i++) {
    const t = i / sr;
    o[i] = (Math.sin(TAU * 1700 * t) * 0.6 + Math.sin(TAU * 480 * t) * 0.5 + noise() * 0.3) * Math.exp(-t * 90);
  }
  return biquad(o, 'hp', 300, 0.7, sr);
}

function perc(sr) {
  const o = buf(sr, 0.45);
  for (let i = 0; i < o.length; i++) {
    const t = i / sr;
    const sq = (Math.sin(TAU * 540 * t) > 0 ? 1 : -1) + (Math.sin(TAU * 800 * t) > 0 ? 1 : -1);
    o[i] = sq * 0.5 * (0.7 * Math.exp(-t * 60) + 0.3 * Math.exp(-t * 9));
  }
  return biquad(o, 'bp', 2600, 1.2, sr);
}

export const TRACKS = [
  { name: 'KICK', color: '#ff3b5c', make: kick },
  { name: 'SNARE', color: '#ff8a1f', make: snare },
  { name: 'CLAP', color: '#ffd23f', make: clap },
  { name: 'C.HAT', color: '#3dffa8', make: (sr) => hat(sr, 0.12, 55), choke: 1 },
  { name: 'O.HAT', color: '#22d3ff', make: (sr) => hat(sr, 0.6, 7), choke: 1 },
  { name: 'TOM', color: '#6b7bff', make: tom },
  { name: 'RIM', color: '#b46bff', make: rim },
  { name: 'PERC', color: '#ff5ad8', make: perc },
];

export function makeSample(i, sr) {
  return normalize(tail(TRACKS[i].make(sr), sr));
}
