// Minimal SVG knob: vertical drag (Shift = fine), wheel, double-click to reset.

const START = -135, SWEEP = 270;

function arc(a0, a1, r = 15) {
  const p = (a) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${20 + r * Math.cos(rad)} ${20 + r * Math.sin(rad)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}`;
}

export class Knob {
  // display: a larger knob that shows its value inside the dial, LCD-style.
  constructor(host, { label, min = 0, max = 1, value = 0, def = value, step = 0, bipolar = false, display = false, format, onChange }) {
    Object.assign(this, { min, max, def, step, bipolar, onChange });
    this.format = format || ((v) => v.toFixed(2));
    this.el = document.createElement('div');
    this.el.className = display ? 'knob display' : 'knob';
    this.el.innerHTML = `
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path class="k-trk" d="${arc(START, START + SWEEP)}"/>
        <path class="k-val"/>
        <circle class="k-cap" cx="20" cy="20" r="10"/>
        <line class="k-ind" x1="20" y1="20" x2="20" y2="12"/>
      </svg>
      <div class="k-v"></div>
      <div class="k-l">${label}</div>`;
    this.valPath = this.el.querySelector('.k-val');
    this.ind = this.el.querySelector('.k-ind');
    this.out = this.el.querySelector('.k-v');
    this.el.tabIndex = 0;
    host.appendChild(this.el);
    this.bind();
    this.set(value, false);
  }

  bind() {
    let y0 = 0, v0 = 0;
    const move = (e) => {
      const range = this.max - this.min;
      const scale = e.shiftKey ? 800 : 160;
      this.set(v0 + ((y0 - e.clientY) / scale) * range);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.el.classList.remove('active');
    };
    this.el.addEventListener('pointerdown', (e) => {
      if (this.disabled) return;
      e.preventDefault();
      y0 = e.clientY;
      v0 = this.value;
      this.el.classList.add('active');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.el.addEventListener('dblclick', () => !this.disabled && this.set(this.def));
    this.el.addEventListener('wheel', (e) => {
      if (this.disabled) return;
      e.preventDefault();
      const inc = this.step || (this.max - this.min) / 100;
      this.set(this.value + (e.deltaY < 0 ? inc : -inc));
    }, { passive: false });
    this.el.addEventListener('keydown', (e) => {
      if (this.disabled) return;
      const inc = this.step || (this.max - this.min) / 100;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { this.set(this.value + inc); e.preventDefault(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { this.set(this.value - inc); e.preventDefault(); }
    });
  }

  set(v, emit = true) {
    v = Math.min(this.max, Math.max(this.min, v));
    if (this.step) v = Math.round(v / this.step) * this.step;
    const changed = v !== this.value;
    this.value = v;
    const n = (v - this.min) / (this.max - this.min);
    const a = START + n * SWEEP;
    const from = this.bipolar ? 0 : START;
    this.valPath.setAttribute('d', a === from ? '' : arc(Math.min(from, a), Math.max(from, a)));
    this.ind.setAttribute('transform', `rotate(${a} 20 20)`);
    this.out.textContent = this.format(v);
    if (emit && changed && this.onChange) this.onChange(v);
  }

  setDisabled(d, title = '') {
    this.disabled = d;
    this.el.classList.toggle('disabled', d);
    this.el.title = title;
  }
}
