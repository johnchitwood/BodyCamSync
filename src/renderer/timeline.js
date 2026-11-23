'use strict';
// Multi-lane timeline: one lane per camera showing when it has footage and how loud it is.
(function () {
  let GUTTER = 150;
  const RULER = 24;
  const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function fmt(t, showMs = false) {
    t = Math.max(0, t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    const base = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    return showMs ? base + '.' + String(Math.floor((t % 1) * 1000)).padStart(3, '0') : base;
  }
  const rgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };

  class Timeline {
    constructor(canvas, engine, { onSelect } = {}) {
      this.c = canvas; this.ctx = canvas.getContext('2d');
      this.engine = engine; this.onSelect = onSelect || (() => {});
      this.cams = [];
      this.v0 = 0; this.v1 = 1;
      this.hover = null;
      this.dragging = false;
      this.scrollY = 0;
      this.dirty = true;
      this._dpr = window.devicePixelRatio || 1;

      new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
      canvas.addEventListener('pointerdown', (e) => this._down(e));
      canvas.addEventListener('pointermove', (e) => this._move(e));
      canvas.addEventListener('pointerleave', () => { if (!this.dragging) { this.hover = null; this.dirty = true; } });
      canvas.addEventListener('pointerup', (e) => this._up(e));
      canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
      canvas.addEventListener('dblclick', (e) => { if (e.offsetX > GUTTER) this.fit(); });
      engine.on('time', () => { this.dirty = true; this._follow(); });
      engine.on('active', () => { this.ensureVisible(); this.dirty = true; });
      engine.on('coverage', () => { this.dirty = true; });
      const loop = () => { if (this.dirty) { this.dirty = false; this.draw(); } requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }

    setCams(cams) {
      this.cams = cams;
      // the label column is as wide as the longest camera name (within limits)
      const ctx = this.ctx; ctx.save();
      ctx.font = '650 12px "Public Sans", system-ui, sans-serif';
      let w = 0; for (const c of cams) w = Math.max(w, ctx.measureText(c.shortLabel || c.label || '').width);
      ctx.restore();
      GUTTER = clamp(Math.ceil(w) + 56, 160, 300);
      this.fit();
    }
    setMarks(times) { this.marks = times || []; this.dirty = true; }
    fit() { this.v0 = 0; this.v1 = Math.max(1, this.engine.duration); this.dirty = true; }
    invalidate() { this.dirty = true; }

    resize() {
      const r = this.c.parentElement.getBoundingClientRect();
      this._dpr = window.devicePixelRatio || 1;
      this.w = Math.max(1, Math.floor(r.width)); this.h = Math.max(1, Math.floor(r.height));
      this.c.width = Math.floor(this.w * this._dpr); this.c.height = Math.floor(this.h * this._dpr);
      this.dirty = true;
    }

    t2x(t) { return GUTTER + ((t - this.v0) / (this.v1 - this.v0)) * (this.w - GUTTER - 12); }
    x2t(x) { return this.v0 + ((x - GUTTER) / (this.w - GUTTER - 12)) * (this.v1 - this.v0); }

    // Lanes get as tall as fit (20-34px). With many cameras they stop shrinking and the list scrolls.
    laneGeom() {
      const n = Math.max(1, this.cams.length);
      const viewH = Math.max(10, this.h - RULER - 6);
      const gap = 4;
      const lh = clamp(Math.floor((viewH - 4 - gap * (n - 1)) / n), 20, 34);
      const content = 4 + n * lh + (n - 1) * gap;
      const maxScroll = Math.max(0, content - viewH);
      this.scrollY = clamp(this.scrollY || 0, 0, maxScroll);
      return { lh, gap, top: RULER + 4, content, viewH, maxScroll };
    }

    ensureVisible() {
      const i = this.cams.findIndex((c) => c.id === this.engine.activeId);
      if (i < 0 || !this.h) return;
      const { lh, gap, viewH, maxScroll } = this.laneGeom();
      const y0 = 4 + i * (lh + gap), y1 = y0 + lh;
      if (y0 < this.scrollY) this.scrollY = y0 - 4;
      else if (y1 > this.scrollY + viewH) this.scrollY = y1 - viewH + 6;
      this.scrollY = clamp(this.scrollY, 0, maxScroll);
      this.dirty = true;
    }

    // height that shows every camera lane without scrolling
    fitHeight() {
      const n = Math.max(1, this.cams.length);
      return RULER + 6 + 4 + n * 26 + (n - 1) * 4;
    }

    _follow() {
      if (this.dragging || !this.engine.playing) return;
      const T = this.engine.T;
      const span = this.v1 - this.v0;
      if (span >= this.engine.duration - 0.01) return;
      if (T > this.v1 - span * 0.06 || T < this.v0) {
        this.v0 = clamp(T - span * 0.12, 0, Math.max(0, this.engine.duration - span));
        this.v1 = this.v0 + span;
      }
    }

    // ---- interaction ----
    _timeAt(e) { return clamp(this.x2t(e.offsetX), 0, this.engine.duration); }
    _laneAt(y) {
      const { lh, gap, top } = this.laneGeom();
      if (y < RULER) return -1;
      const i = Math.floor((y + this.scrollY - top) / (lh + gap));
      return i >= 0 && i < this.cams.length ? i : -1;
    }
    _down(e) {
      this.c.setPointerCapture(e.pointerId);
      if (e.offsetX < GUTTER) {
        const i = this._laneAt(e.offsetY);
        if (i >= 0) this.onSelect(this.cams[i].id);
        return;
      }
      this.dragging = true;
      this._wasPlaying = this.engine.playing;
      if (this._wasPlaying) this.engine.pause();
      this.engine.scrub(this._timeAt(e));
    }
    _move(e) {
      this.hover = e.offsetX >= GUTTER ? { x: e.offsetX, t: this._timeAt(e) } : null;
      this.dirty = true;
      if (this.dragging) this.engine.scrub(this._timeAt(e));
    }
    _up(e) {
      if (!this.dragging) return;
      this.dragging = false;
      this.engine.seek(this._timeAt(e), { precise: true });
      if (this._wasPlaying) this.engine.play();
    }
    _wheel(e) {
      e.preventDefault();
      const dur = Math.max(1, this.engine.duration);
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(e.deltaY * 0.01);
        const tc = this.x2t(e.offsetX);
        let span = clamp((this.v1 - this.v0) * f, 4, dur);
        const rel = (tc - this.v0) / (this.v1 - this.v0);
        this.v0 = clamp(tc - rel * span, 0, dur - span); this.v1 = this.v0 + span;
      } else {
        const { maxScroll } = this.laneGeom();
        const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (!horizontal && maxScroll > 0) {
          // many cameras: the wheel scrolls the lanes up and down
          this.scrollY = clamp(this.scrollY + e.deltaY, 0, maxScroll);
        } else {
          const span = this.v1 - this.v0;
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          this.v0 = clamp(this.v0 + d * (span / (this.w - GUTTER)), 0, Math.max(0, dur - span)); this.v1 = this.v0 + span;
        }
      }
      this.dirty = true;
    }

    // ---- drawing ----
    draw() {
      const ctx = this.ctx;
      const W = this.w, H = this.h;
      if (!W) return;
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // colours come from the navy "viewing room" tokens in the stylesheet
      const css = getComputedStyle(this.c);
      const tok = (n, d) => css.getPropertyValue(n).trim() || d;
      const line = tok('--line', '#34465c');
      const text3 = tok('--text-3', '#8b9bac');
      const text2 = tok('--text-2', '#b9c4cf');
      const text = tok('--text', '#eef1f4');
      const red = tok('--red', '#e07366');
      const surf3 = tok('--surface-3', '#344860');
      const left = GUTTER, right = W - 12;

      // ruler
      const pxPerSec = (right - left) / (this.v1 - this.v0);
      let step = STEPS.find((s) => s * pxPerSec >= 84) || STEPS[STEPS.length - 1];
      ctx.font = '500 11px "Public Sans", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = text3; ctx.strokeStyle = line; ctx.lineWidth = 1;
      const first = Math.ceil(this.v0 / step) * step;
      ctx.beginPath();
      for (let t = first; t <= this.v1 + 1e-6; t += step) {
        const x = Math.round(this.t2x(t)) + 0.5;
        ctx.moveTo(x, RULER - 6); ctx.lineTo(x, H);
      }
      ctx.stroke();
      for (let t = first; t <= this.v1 + 1e-6; t += step) {
        const x = this.t2x(t);
        if (x > left + 2 && x < right - 24) ctx.fillText(fmt(t, step < 1), x + 4, 11);
      }
      ctx.beginPath(); ctx.moveTo(left, RULER - 0.5); ctx.lineTo(W, RULER - 0.5); ctx.stroke();

      // lanes
      const geom = this.laneGeom();
      const { lh, gap, top } = geom;
      const activeId = this.engine.activeId;
      ctx.save(); ctx.beginPath(); ctx.rect(0, RULER, W, H - RULER); ctx.clip();
      this.cams.forEach((c, i) => {
        const y = top + i * (lh + gap) - this.scrollY;
        if (y + lh < RULER || y > H) return;
        const active = c.id === activeId;
        // label: the camera's lettered tab, then its name; the camera you are hearing has a red mark in the margin
        ctx.save(); ctx.beginPath(); ctx.rect(0, y, GUTTER - 8, lh); ctx.clip();
        if (active) { ctx.fillStyle = red; ctx.fillRect(0, y, 3, lh); }
        const th = Math.min(16, lh - 6), ty = y + (lh - th) / 2;
        ctx.globalAlpha = active ? 1 : 0.75;
        ctx.fillStyle = c.color; ctx.fillRect(12, ty, 18, th);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff'; ctx.font = '700 11px "Public Sans", system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(c.letter || '', 21, y + lh / 2 + 0.5);
        ctx.textAlign = 'left';
        ctx.fillStyle = active ? text : text2;
        ctx.font = `${active ? 650 : 500} 12px "Public Sans", system-ui, sans-serif`;
        ctx.fillText(c.shortLabel || c.label, 38, y + lh / 2 + 0.5);
        ctx.restore();

        // coverage
        const xs = clamp(this.t2x(c.start), left, right), xe = clamp(this.t2x(c.start + c.duration), left, right);
        if (xe > xs) {
          const tint = c.tint || c.color;
          ctx.fillStyle = rgba(tint, active ? 0.16 : 0.08);
          ctx.beginPath(); ctx.roundRect(xs, y, xe - xs, lh, 2); ctx.fill();
          // waveform
          const env = c.env || [];
          const hop = c.envHop || 0.5;
          ctx.fillStyle = rgba(tint, active ? 0.95 : 0.55);
          const mid = y + lh / 2;
          for (let x = Math.ceil(xs); x < xe; x++) {
            const t0 = this.x2t(x) - c.start, t1 = this.x2t(x + 1) - c.start;
            let i0 = Math.max(0, Math.floor(t0 / hop)), i1 = Math.min(env.length - 1, Math.floor(t1 / hop));
            let m = 0;
            for (let k = i0; k <= i1; k++) if (env[k] > m) m = env[k];
            const a = clamp((m / 255 - 0.22) / 0.72, 0, 1);
            const half = Math.max(0.5, a * (lh / 2 - 2));
            ctx.fillRect(x, mid - half, 1, half * 2);
          }
        }
      });
      ctx.restore();
      if (geom.maxScroll > 0) {
        const th = Math.max(24, (geom.viewH * geom.viewH) / geom.content);
        const ty = RULER + 3 + (geom.viewH - th) * (this.scrollY / geom.maxScroll);
        ctx.fillStyle = 'rgba(255,255,255,.2)'; ctx.beginPath(); ctx.roundRect(W - 6, ty, 3, th, 2); ctx.fill();
      }

      // search matches
      if (this.marks && this.marks.length) {
        ctx.fillStyle = '#f5d06a';
        for (const t of this.marks) {
          if (t < this.v0 || t > this.v1) continue;
          const x = Math.round(this.t2x(t));
          ctx.fillRect(x - 1, RULER - 10, 2, 9);
        }
      }

      // hover
      if (this.hover && !this.dragging) {
        ctx.strokeStyle = 'rgba(255,255,255,.18)';
        ctx.beginPath(); ctx.moveTo(Math.round(this.hover.x) + 0.5, RULER); ctx.lineTo(Math.round(this.hover.x) + 0.5, H); ctx.stroke();
        const label = fmt(this.hover.t, true);
        ctx.font = '500 11px "Public Sans", system-ui, sans-serif';
        const tw = ctx.measureText(label).width + 12;
        const bx = clamp(this.hover.x - tw / 2, left, W - tw - 4);
        ctx.fillStyle = surf3; ctx.beginPath(); ctx.roundRect(bx, 3, tw, 17, 2); ctx.fill();
        ctx.fillStyle = text; ctx.fillText(label, bx + 6, 12);
      }

      // playhead
      const px = this.t2x(this.engine.T);
      if (px >= left - 1 && px <= right + 1) {
        const x = Math.round(px) + 0.5;
        // the playhead is the margin rule: a red line with a flag on the ruler
        ctx.strokeStyle = red; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, RULER - 2); ctx.lineTo(x, H); ctx.stroke();
        ctx.fillStyle = red;
        ctx.beginPath(); ctx.moveTo(x - 6, RULER - 9); ctx.lineTo(x + 6, RULER - 9); ctx.lineTo(x + 6, RULER - 3); ctx.lineTo(x, RULER + 1); ctx.lineTo(x - 6, RULER - 3); ctx.closePath(); ctx.fill();
      }
    }
  }

  window.BCS = window.BCS || {};
  window.BCS.Timeline = Timeline;
  window.BCS.fmtTime = fmt;
})();
