'use strict';
// Live captions: the transcript line being spoken right now, drawn over each camera's picture.
//
//  * Display only. Captions are an HTML layer on top of the video element. Nothing is burned into a
//    picture and no file (original or copy) is written; turning captions off removes the layer.
//  * Text comes from the transcript as it stands in the Transcript tab, so reviewer corrections,
//    splits and deletions show here too. Each camera shows only what its own microphone picked up.
//  * Speaker labels: a name appears only when a reviewer assigned that voice to a person. Voices the
//    machine grouped but nobody has confirmed are shown as "Speaker N" with an "unconfirmed" mark.
//  * Timing comes from whole transcript segments (whisper start/end), not single words, and is good
//    to about a second.
(function () {
  const C = () => window.BCS.ctx;
  const TX = () => window.BCS.transcript;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const lineT = (l) => l.cam.start + l.local;
  const LEAD = 0.1;   // show a line just before its start time
  const HANG = 0.6;   // keep it a moment after it ends so short lines can be read
  const MAX_LINES = 2;

  let indexed = null;      // the TR.allLines array the index was built from
  let byCam = new Map();   // camId -> lines sorted by start, plus the longest line length
  let lastHtml = new Map();

  function reindex(all) {
    indexed = all;
    byCam = new Map();
    for (const l of all || []) {
      if (l.deleted) continue;
      let e = byCam.get(l.camId);
      if (!e) { e = { lines: [], maxLen: 0 }; byCam.set(l.camId, e); }
      e.lines.push(l);
      if (l.len > e.maxLen) e.maxLen = l.len;
    }
    for (const e of byCam.values()) e.lines.sort((a, b) => lineT(a) - lineT(b));
  }

  // Lines from this camera that are being spoken at time T (on the camera's chosen microphone when
  // that microphone has a transcript; otherwise any of its microphones).
  function linesAt(cam, T) {
    const e = byCam.get(cam.id);
    if (!e || !e.lines.length) return [];
    const L = e.lines;
    let lo = 0, hi = L.length - 1, last = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (lineT(L[mid]) <= T + LEAD) { last = mid; lo = mid + 1; } else hi = mid - 1; }
    const out = [];
    for (let i = last; i >= 0; i--) {
      const l = L[i];
      if (T + LEAD - lineT(l) > e.maxLen + HANG) break;
      if (T < lineT(l) + l.len + HANG) out.push(l);
    }
    if (!out.length) return out;
    const tk = cam.track ? cam.track.index : null;
    const own = out.filter((l) => l.track === tk);
    const pick = own.length ? own : out;
    pick.sort((a, b) => lineT(a) - lineT(b));
    return pick.slice(-MAX_LINES);
  }

  function speakerHtml(l) {
    const S = C().S;
    if (!S.capSpeakers) return '';
    const TR = TX().TR;
    if (!Object.keys(TR.spk || {}).length) return ''; // speakers not detected for this case
    const p = l.person;
    if (!p) return `<span class="cc-who none" title="No speaker assigned">Unassigned</span>`;
    if (p.auto) {
      return `<span class="cc-who auto" style="--sp:${p.color}" title="Detected automatically from the sound of the voice. Not an identification. Name it in the Transcript tab once you have confirmed who it is.">${esc(p.label)}<em>unconfirmed</em></span>`;
    }
    return `<span class="cc-who named" style="--sp:${p.color}" title="Assigned by a reviewer in the Transcript tab">${esc(p.name || p.label)}</span>`;
  }

  function textHtml(l) {
    const words = l.w && l.w.length ? l.w : [[l.text, 1]];
    return words.map(([w, p]) => (p < 0.45 ? `<span class="lowc" title="Low confidence">${esc(w)}</span>` : esc(w))).join(' ');
  }

  function ensureLayer(cam) {
    if (!cam.tile) return null;
    let el = cam._ccEl;
    if (el && el.isConnected) return el;
    const view = cam.tile.querySelector('.tile-view');
    if (!view) return null;
    el = document.createElement('div');
    el.className = 'cc';
    el.setAttribute('aria-live', 'off');
    view.append(el);
    cam._ccEl = el;
    lastHtml.delete(cam.id);
    return el;
  }

  function shows(cam) {
    const S = C().S;
    if (!S.captions || S.captions === 'off' || !cam.visible || !cam.tile) return false;
    if (cam.tile.classList.contains('out')) return false;
    const focusThumb = cam.tile.closest('.stage') && cam.tile.closest('.stage').dataset.mode === 'focus' && !cam.tile.classList.contains('main');
    if (focusThumb) return false; // thumbnails are too small to read
    if (S.captions === 'active') return cam.id === S.engine.activeId;
    return true;
  }

  function update() {
    const S = C().S;
    if (!S || !S.cams) return;
    const TR = TX() && TX().TR;
    if (TR && TR.allLines !== indexed) reindex(TR.allLines);
    const T = S.engine.T;
    const stage = document.querySelector('#stage');
    if (stage) stage.dataset.ccSize = S.capSize || 'm';
    for (const c of S.cams) {
      const on = shows(c);
      const el = on ? ensureLayer(c) : c._ccEl;
      if (!el) continue;
      let html = '';
      if (on) html = linesAt(c, T).map((l) => `<div class="cc-line">${speakerHtml(l)}<span class="cc-text">${textHtml(l)}</span></div>`).join('');
      if (lastHtml.get(c.id) === html) continue;
      lastHtml.set(c.id, html);
      el.innerHTML = html;
      el.hidden = !html;
    }
  }

  function hasTranscript() {
    const TR = TX() && TX().TR;
    return !!(TR && TR.allLines && TR.allLines.length);
  }

  // Force a redraw on the next update (speaker names or settings changed).
  function refresh() { lastHtml = new Map(); indexed = null; update(); }

  function reset() { indexed = null; byCam = new Map(); lastHtml = new Map(); }

  window.BCS = window.BCS || {};
  window.BCS.captions = { update, refresh, reset, hasTranscript, linesAt: (cam, T) => { const TR = TX().TR; if (TR.allLines !== indexed) reindex(TR.allLines); return linesAt(cam, T); } };
})();
