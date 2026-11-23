'use strict';
// Playback engine: one shared clock, every camera slaved to it.
//
//  * All cameras' audio elements run continuously (silent unless active), so switching
//    the audible camera is a gain crossfade -- never a seek, never a gap.
//  * Video elements are muted and corrected against the clock every frame.
//  * Each camera has an offset (seconds on the shared timeline); local time = T - start.

(function () {
  const FRAME = 1 / 30;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  // Inactive cameras play at an inaudible (-80 dB) level rather than 0. A volume of exactly 0 lets the
  // browser skip the audio device, which changes how currentTime is reported and breaks cross-camera alignment.
  const SILENT = 0.0001;

  class Emitter {
    constructor() { this._l = {}; }
    on(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); return () => { this._l[ev] = this._l[ev].filter((f) => f !== fn); }; }
    emit(ev, p) { (this._l[ev] || []).forEach((f) => f(p)); }
  }

  class Engine extends Emitter {
    constructor() {
      super();
      this.cams = [];
      this.T = 0;
      this.duration = 0;
      this.playing = false;
      this.rate = 1;
      this.volume = 1;
      this.activeId = null;
      this.useProxies = false;
      this.stats = { audioSeeks: 0, slews: 0, slewTotal: 0, driftChecks: 0 };
      this._anchorPerf = 0;
      this._anchorT = 0;
      this._raf = 0;
      this._lastAudioCheck = 0;
      this._refBase = null;
      this._playStartPerf = 0;
      this._scrubTimer = 0;
      this._tick = this._tick.bind(this);
    }

    // ---- setup -------------------------------------------------------------
    load(cams) {
      this.dispose();
      this.cams = cams;
      for (const c of cams) {
        c.video = document.createElement('video');
        c.video.muted = true;
        c.video.playsInline = true;
        c.video.preload = 'auto';
        c.video.disablePictureInPicture = true;
        c.video.setAttribute('disableRemotePlayback', '');
        c.audio = null;
        this._setVideoSource(c);
        this._buildAudio(c);
      }
      this.recomputeDuration();
      this.setActive(cams[0] ? cams[0].id : null, { instant: true });
      this.seek(0);
    }

    dispose() {
      this.pause();
      for (const c of this.cams) {
        try { c.video.removeAttribute('src'); c.video.load(); } catch (_) { /* ignore */ }
        if (c.audio) { try { c.audio.removeAttribute('src'); c.audio.load(); } catch (_) { /* ignore */ } }
      }
      this.cams = [];
    }

    recomputeDuration() {
      this.duration = Math.max(0, ...this.cams.map((c) => c.start + c.duration));
    }

    _videoUrl(c) {
      const f = c.file;
      return this.useProxies && f.proxyUrl ? f.proxyUrl : f.url;
    }

    _setVideoSource(c) {
      const url = this._videoUrl(c);
      if (c._src === url) return;
      c._src = url;
      c.usingProxy = url !== c.file.url;
      c.video.src = url;
      c.video.load();
    }

    // Swap in newly available local copies without interrupting playback of the other cameras.
    updateSources() {
      for (const c of this.cams) {
        const url = this._videoUrl(c);
        if (c._src === url) continue;
        const v = c.video;
        v.pause();
        c._src = url;
        c.usingProxy = url !== c.file.url;
        v.src = url; v.load();
        v.addEventListener('loadeddata', () => {
          if (!this.covers(c) || c.visible === false) return;
          v.currentTime = this.local(c) + 0.001;
          if (this.playing) v.play().catch(() => {});
        }, { once: true });
      }
      this.emit('source');
    }

    _buildAudio(c) {
      const track = c.track;
      if (c.audio) { c.audio.pause(); c.audio.removeAttribute('src'); c.audio.load(); }
      if (!track || !track.url) { c.audio = null; return; }
      const a = new Audio();
      a.preload = 'auto';
      a.src = track.url;
      a.preservesPitch = true;
      a.volume = c.id === this.activeId ? this.volume : SILENT;
      c.audio = a;
    }

    // Short stepped fade (~30 ms): instant to the ear, no click.
    _fade(c, target) {
      if (!c.audio) return;
      clearInterval(c._fadeTimer);
      const a = c.audio;
      const from = a.volume;
      const steps = 8;
      let i = 0;
      c._fadeTimer = setInterval(() => {
        i++;
        a.volume = clamp(from + (target - from) * (i / steps), 0, 1);
        if (i >= steps) clearInterval(c._fadeTimer);
      }, 4);
    }

    setProxyMode(on) {
      this.useProxies = !!on;
      this.updateSources();
    }

    setTrack(camId, trackIndex) {
      const c = this._cam(camId); if (!c) return;
      c.track = c.group.tracks.find((t) => t.index === trackIndex) || c.track;
      const wasPlaying = this.playing; const t = this.T;
      this.pause();
      this._buildAudio(c);
      this.seek(t);
      if (wasPlaying) this.play();
    }

    setAngle(camId, angle) {
      const c = this._cam(camId); if (!c) return;
      const f = c.group.files.find((x) => x.angle === angle); if (!f) return;
      c.file = f; c.angle = angle; c.duration = f.duration;
      const wasPlaying = this.playing; const t = this.T;
      this.pause();
      this._setVideoSource(c);
      this.recomputeDuration();
      this.seek(t);
      if (wasPlaying) this.play();
      this.emit('layout');
    }

    setStart(camId, start) {
      const c = this._cam(camId); if (!c) return;
      c.start = start;
      this.recomputeDuration();
      this.seek(this.T, { precise: true });
    }

    _cam(id) { return this.cams.find((c) => c.id === id); }

    // ---- audible camera ---------------------------------------------------
    setActive(id, { instant = false } = {}) {
      if (id === this.activeId && !instant) return;
      this.activeId = id;
      for (const c of this.cams) {
        if (!c.audio) continue;
        const target = c.id === id ? this.volume : SILENT;
        if (instant) { clearInterval(c._fadeTimer); c.audio.volume = target; } else this._fade(c, target);
      }
      this.emit('active', id);
    }

    setVolume(v) {
      this.volume = clamp(v, 0, 1);
      const a = this._cam(this.activeId);
      if (a && a.audio) { clearInterval(a._fadeTimer); a.audio.volume = this.volume; }
    }

    // ---- transport --------------------------------------------------------
    local(c, T = this.T) { return T - c.start; }
    covers(c, T = this.T) { const l = T - c.start; return l >= 0 && l <= c.duration - 0.05; }

    async play() {
      if (this.playing) return;
      if (this.T >= this.duration - 0.05) this.seek(0);
      await this._settle();
      this.playing = true;
      this._anchorPerf = performance.now();
      this._anchorT = this.T;
      this._refBase = null; this._playStartPerf = performance.now();
      for (const c of this.cams) this._startMedia(c);
      this.emit('state', 'playing');
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(this._tick);
    }

    pause() {
      if (this.playing) { this.T = this._clock(); this.playing = false; }
      cancelAnimationFrame(this._raf);
      for (const c of this.cams) { c.video.pause(); if (c.audio) c.audio.pause(); c._running = false; }
      this._alignAll(true);
      this.emit('state', 'paused');
      this.emit('time', this.T);
    }

    toggle() { this.playing ? this.pause() : this.play(); }

    _clock() { return this._anchorT + ((performance.now() - this._anchorPerf) / 1000) * this.rate; }

    _startMedia(c) {
      const inCov = this.covers(c) && c.visible !== false;
      c.video.playbackRate = this.rate;
      if (c.audio) c.audio.playbackRate = this.rate;
      if (inCov) {
        const l = this.local(c);
        if (Math.abs(c.video.currentTime - l) > 0.05) c.video.currentTime = l;
        c.video.play().catch(() => {});
        if (c.audio) { if (Math.abs(c.audio.currentTime - l) > 0.02) c.audio.currentTime = l; c.audio.play().catch(() => {}); }
        c._running = true;
      } else { c.video.pause(); if (c.audio) c.audio.pause(); c._running = false; }
    }

    // wait for every in-coverage element to finish any pending seek so playback starts together
    _settle() {
      const waits = [];
      for (const c of this.cams) {
        if (!this.covers(c) || c.visible === false) continue;
        const l = this.local(c);
        c.video.currentTime = l;
        waits.push(this._whenSeeked(c.video, 1500));
        if (c.audio) { c.audio.currentTime = l; waits.push(this._whenSeeked(c.audio, 1500)); }
      }
      return Promise.all(waits);
    }
    _whenSeeked(el, timeout) {
      return new Promise((res) => {
        if (!el.seeking && el.readyState >= 3) return res();
        let done = false;
        const fin = () => { if (done) return; done = true; el.removeEventListener('seeked', fin); el.removeEventListener('canplay', fin); res(); };
        el.addEventListener('seeked', fin); el.addEventListener('canplay', fin);
        setTimeout(fin, timeout);
      });
    }

    seek(t, { precise = false } = {}) {
      this.T = clamp(t, 0, this.duration);
      if (this.playing) { this._anchorT = this.T; this._anchorPerf = performance.now(); this._refBase = null; this._playStartPerf = performance.now(); }
      if (precise || !this.playing) this._alignAll(!this.playing);
      else this._alignAll(false);
      this.emit('time', this.T);
    }

    // Throttled seek used while dragging the timeline.
    scrub(t) {
      this.T = clamp(t, 0, this.duration);
      this.emit('time', this.T);
      if (this._scrubTimer) return;
      this._scrubTimer = setTimeout(() => { this._scrubTimer = 0; this._alignAll(true); }, 45);
    }

    step(frames) {
      if (this.playing) this.pause();
      this.seek(this.T + frames * FRAME);
    }

    setRate(r) {
      this.rate = r;
      if (this.playing) { this._anchorT = this._clock(); this._anchorPerf = performance.now(); this._refBase = null; this._playStartPerf = performance.now(); }
      for (const c of this.cams) { c.video.playbackRate = r; if (c.audio) c.audio.playbackRate = r; }
      this.emit('rate', r);
    }

    // snap every element to the clock (used when paused / after seeks)
    _alignAll(hard) {
      for (const c of this.cams) {
        const cov = this.covers(c) && c.visible !== false;
        c.inCoverage = cov;
        if (!cov) { c.video.pause(); if (c.audio) c.audio.pause(); continue; }
        const l = this.local(c);
        // +1ms keeps the decoder on the frame whose timestamp is <= l (avoids landing one frame early)
        if (hard || Math.abs(c.video.currentTime - l) > 0.25) c.video.currentTime = l + 0.001;
        if (c.audio && (hard || Math.abs(c.audio.currentTime - l) > 0.1)) c.audio.currentTime = l;
      }
      this.emit('coverage');
    }

    // ---- per-frame drift control -----------------------------------------
    _tick(now) {
      if (!this.playing) return;
      const T = this._clock();
      this.T = T;
      if (T >= this.duration) { this.pause(); return; }
      let coverageChanged = false;
      const checkAudio = now - this._lastAudioCheck > 200;
      if (checkAudio) this._lastAudioCheck = now;
      for (const c of this.cams) {
        const cov = this.covers(c, T) && c.visible !== false;
        if (cov !== !!c.inCoverage) { c.inCoverage = cov; coverageChanged = true; if (cov) this._startMedia(c); else { c.video.pause(); if (c.audio) c.audio.pause(); c._running = false; } }
        if (!cov) continue;
        const l = T - c.start;
        const v = c.video;
        if (v.readyState >= 2) {
          const d = v.currentTime - l;
          if (Math.abs(d) > 0.25) { v.currentTime = l; v.playbackRate = this.rate; }
          else if (Math.abs(d) > 0.06) v.playbackRate = this.rate * (1 - clamp(d * 1.2, -0.08, 0.08));
          else if (Math.abs(d) < 0.025) v.playbackRate = this.rate;
        }
        if (v.paused && !v.ended) v.play().catch(() => {});
      }
      if (checkAudio) this._driftAudio(T);
      if (coverageChanged) this.emit('coverage');
      this.emit('time', T);
      this._raf = requestAnimationFrame(this._tick);
    }

    // Audio elements are kept aligned to EACH OTHER (that is what makes switching the audible
    // camera seamless). Browsers report currentTime in coarse steps, so the shared component is
    // removed before correcting: only the camera-to-camera difference is acted on.
    _driftAudio(T) {
      for (const c of this.cams) {
        if (c.audio && c.inCoverage && c.audio.paused && !c.audio.ended) c.audio.play().catch(() => {});
      }
      const act = this.cams.filter((c) => c.audio && c.inCoverage && !c.audio.paused);
      if (!act.length) return;
      this.stats.driftChecks++;
      const das = act.map((c) => c.audio.currentTime - (T - c.start));
      const sorted = [...das].sort((a, b) => a - b);
      const ref = sorted[Math.floor(sorted.length / 2)];

      // The audio device clock and the system clock run at slightly different speeds. Rather than
      // fight that with seeks, learn the steady offset once, then let the master clock slowly follow
      // the audio device. Cameras then never need a corrective jump, however long you play.
      if (this._refBase == null && performance.now() - this._playStartPerf > 1500 && Math.abs(ref) < 0.3) this._refBase = ref;
      let hardAll = false;
      if (this._refBase == null) hardAll = Math.abs(ref) > 0.3;
      else {
        const err = ref - this._refBase;
        if (Math.abs(err) > 0.15) hardAll = true;
        else if (Math.abs(err) > 0.002) { this._anchorT += err * 0.25; this._lastSlew = err; this.stats.slews++; this.stats.slewTotal += err * 0.25; }
      }
      act.forEach((c, i) => {
        const a = c.audio;
        const l = T - c.start;
        const rel = das[i] - ref;
        c._aAvg = c._aAvg == null ? rel : c._aAvg * 0.75 + rel * 0.25;
        if (hardAll) { a.currentTime = l + (this._refBase || 0); a.playbackRate = this.rate; c._aAvg = 0; this.stats.audioSeeks++; if (i === act.length - 1) this._refBase = null; this._playStartPerf = performance.now(); }
        else if (Math.abs(rel) > 0.05) { a.currentTime = l + ref; c._aAvg = 0; this.stats.audioSeeks++; }
        else if (Math.abs(c._aAvg) > 0.004) a.playbackRate = this.rate * (1 - clamp(c._aAvg * 0.3, -0.005, 0.005));
        else a.playbackRate = this.rate;
      });
    }

    // ---- measurement ------------------------------------------------------
    // Time how long each visible video takes to land on a frame after a seek.
    async benchmarkSeeks(count = 6) {
      // Uses hidden, separate video elements so what is on screen never jumps around.
      const results = [];
      for (const c of this.cams) {
        if (c.visible === false) continue;
        const v = document.createElement('video');
        v.muted = true; v.preload = 'auto';
        v.src = this._videoUrl(c);
        await new Promise((res) => { v.addEventListener('loadeddata', res, { once: true }); setTimeout(res, 10000); });
        const times = [];
        for (let i = 0; i < count; i++) {
          const l = 20 + Math.random() * Math.max(10, c.duration - 60);
          const ms = await new Promise((res) => {
            const t0 = performance.now();
            let done = false;
            const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); res(performance.now() - t0); };
            v.addEventListener('seeked', fin);
            v.currentTime = l;
            setTimeout(fin, 8000);
          });
          times.push(ms);
        }
        v.removeAttribute('src'); v.load();
        times.sort((a, b) => a - b);
        results.push({ id: c.id, label: c.label, median: times[Math.floor(times.length / 2)], worst: times[times.length - 1], times, proxy: this.useProxies && !!c.file.proxyUrl });
      }
      return results;
    }
  }

  window.BCS = window.BCS || {};
  window.BCS.Engine = Engine;
  window.BCS.FRAME = FRAME;
})();
