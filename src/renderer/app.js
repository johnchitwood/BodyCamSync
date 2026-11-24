'use strict';
(function () {
  const { Engine, Timeline, icons: I, fmtTime, FRAME } = window.BCS;
  const bcs = window.bcs;
  const TX = () => window.BCS.transcript;
  const CC = () => window.BCS.captions;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Each camera is an exhibit tab: a letter (A, B, C…) on a muted marker colour. Letters can be cited in court.
  // `tab` colours carry white letters on paper and navy; `tint` is the lighter version used for waveforms on navy.
  const COLORS = ['#3f6fa3', '#9a6a0f', '#2f7f7a', '#8a4f8f', '#a5562b', '#5e7a2e', '#b0557a', '#6c6a8c'];
  const mixHex = (hex, t) => { const n = parseInt(hex.slice(1), 16); const m = (v) => Math.round(v + (255 - v) * t); return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => m(v).toString(16).padStart(2, '0')).join(''); };
  const letterOf = (i) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
  const ctab = (c, sm) => (c ? `<span class="ctab${sm ? ' sm' : ''}" style="--cam:${c.color}">${c.letter}</span>` : '');
  const KIND = { incar: 'In-car', bwc: 'Body cam', other: '' };

  const S = {
    project: null, engine: new Engine(), timeline: null, cams: [],
    mode: 'grid', tab: 'cameras', syncSel: null,
    proxy: {}, hash: { running: false, overall: 0, files: {} }, bench: null, useProxies: false,
  };

  // ---------- helpers ----------
  const bytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(0) + ' MB' : Math.round(n / 1e3) + ' KB');
  const hms = (t, ms = false) => {
    t = Math.max(0, t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return ms ? base + '.' + String(Math.floor((t % 1) * 1000)).padStart(3, '0') : base;
  };
  const signed = (t) => (t >= 0 ? '+' : '−') + hms(Math.abs(t), true);

  let toastTimer = 0, toastHide = 0;
  function hideToast() {
    const el = $('#toast'); clearTimeout(toastTimer);
    el.classList.add('leaving');
    toastHide = setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); }, 180);
  }
  // action: { label, fn } adds a button (e.g. Undo). Pressing its × dismisses it; it also fades on its own.
  function toast(msg, ms = 4200, action) {
    const el = $('#toast');
    clearTimeout(toastTimer); clearTimeout(toastHide);
    el.classList.remove('leaving');
    el.textContent = '';
    const t = document.createElement('span'); t.className = 'toast-msg'; t.textContent = msg; el.append(t);
    if (action) {
      const b = document.createElement('button'); b.className = 'toast-act'; b.textContent = action.label;
      b.onclick = () => { hideToast(); action.fn(); };
      el.append(b);
    }
    const x = document.createElement('button'); x.className = 'toast-x'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×'; x.onclick = hideToast;
    el.append(x);
    el.hidden = false;
    toastTimer = setTimeout(hideToast, ms);
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const throttle = (fn, ms) => { let t = 0, pend = false; return (...a) => { if (t) { pend = true; return; } fn(...a); t = setTimeout(() => { t = 0; if (pend) { pend = false; fn(...a); } }, ms); }; };

  // A long folder path reduced to its last few parts, written with the system's own separator.
  const shortPath = (p) => {
    const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length > 4 ? '…' + sep + parts.slice(-3).join(sep) : p;
  };
  const IS_MAC = bcs.platform === 'darwin';
  document.documentElement.dataset.platform = bcs.platform;
  window.BCS_KEYS = { mod: IS_MAC ? '⌘' : 'Ctrl+', shift: IS_MAC ? '⇧' : 'Shift' };
  function setView(v) {
    $('#app').dataset.view = v; renderTitlebar();
  }

  function renderTitlebar() {
    const v = $('#app').dataset.view;
    const title = $('#tb-title'); const actions = $('#tb-actions');
    actions.innerHTML = '';
    if (v === 'workspace' && S.project) {
      title.innerHTML = `<b>${esc(S.project.name)}</b> &nbsp;·&nbsp; ${S.cams.length} camera${S.cams.length === 1 ? '' : 's'}`;
      const st = document.createElement('span');
      st.className = 'tb-status'; st.id = 'tb-status'; st.hidden = true;
      const b = document.createElement('button');
      b.className = 'btn small ghost'; b.textContent = 'Open folder…';
      b.onclick = chooseFolder;
      const bf = document.createElement('button');
      bf.className = 'btn small ghost'; bf.textContent = 'Open files…';
      bf.onclick = chooseFiles;
      actions.append(st, bf, b);
      updateStatus();
    } else title.textContent = '';
  }

  // Quiet progress readout while local copies are being prepared in the background.
  function updateStatus() {
    const el = $('#tb-status'); if (!el) return;
    const list = S.cams.map((c) => (c.file.proxyUrl ? { state: 'done', pct: 1 } : S.proxy[`${c.id}_${c.angle}`])).filter(Boolean);
    const busy = list.some((p) => p.state === 'running' || p.state === 'queued');
    if (!busy) { el.hidden = true; return; }
    const pct = Math.round((list.reduce((a, p) => a + (p.state === 'done' ? 1 : p.pct || 0), 0) / S.cams.length) * 100);
    el.hidden = false;
    el.innerHTML = `<span class="spin"></span>Preparing local copies · ${pct}%`;
    el.title = 'Smaller copies are being made on this computer so seeking is instant. Your originals are not changed.';
  }

  function updateTags() {
    for (const c of S.cams) { const t = c.tile && $('.t-tag', c.tile); if (t) t.textContent = c.usingProxy ? 'Local copy' : ''; if (t) t.hidden = !c.usingProxy; }
  }

  // ---------- welcome ----------
  async function loadRecents() {
    const list = await bcs.invoke('recents:list');
    const box = $('#recents'); const el = $('#recents-list');
    box.hidden = !list.length;
    el.innerHTML = '';
    for (const r of list) {
      const row = document.createElement('div'); row.className = 'recent-row';
      const b = document.createElement('button');
      b.className = 'recent'; b.disabled = !r.exists;
      b.innerHTML = `<span style="color:var(--text-3)">${I.folder(18)}</span><span class="r-main"><div class="r-name">${esc(r.name)}</div><div class="r-path" title="${esc(r.folder)}">${esc(shortPath(r.folder))}</div></span><span class="r-meta">${r.cameras} camera${r.cameras === 1 ? '' : 's'} · ${bytes(r.cacheBytes || 0)} on this computer</span>`;
      b.onclick = () => openFolder(r.selection || r.folder);
      row.append(b);
      if ((r.proxyBytes || 0) > 2e8) {
        const f = document.createElement('button');
        f.className = 'btn small'; f.textContent = `Free up ${bytes(r.proxyBytes)}`;
        f.title = 'Removes the local video copies for this case. Your original files are not touched, and the copies can be rebuilt later.';
        f.onclick = () => {
          const box = document.createElement('span'); box.className = 'inline-confirm';
          box.innerHTML = `<span>Remove copies? Originals stay untouched.</span>`;
          const keep = document.createElement('button'); keep.className = 'btn small ghost'; keep.textContent = 'Keep';
          const go = document.createElement('button'); go.className = 'btn small primary'; go.textContent = `Remove ${bytes(r.proxyBytes)}`;
          keep.onclick = () => { box.replaceWith(f); f.focus(); };
          go.onclick = async () => { go.disabled = true; await bcs.invoke('proxy:remove', r.id); toast(`Freed ${bytes(r.proxyBytes)}`); loadRecents(); };
          box.append(keep, go); f.replaceWith(box); keep.focus();
        };
        row.append(f);
      }
      el.append(row);
    }
    const total = list.reduce((a, r) => a + (r.cacheBytes || 0), 0);
    const { free } = await bcs.invoke('disk:free');
    const note = document.createElement('div');
    note.className = 'hint'; note.style.margin = '12px 0 0';
    note.textContent = `Caches for these cases use ${bytes(total)} on this computer. ${bytes(free)} free.`;
    el.append(note);
    S.recentList = list; S.freeDisk = free;
    const reclaim = list.reduce((a, r) => a + (r.proxyBytes || 0) + (r.shrinkBytes || 0), 0);
    const fb = $('#free-btn');
    if (fb) { fb.textContent = reclaim > 2e8 ? `Free up space · ${bytes(reclaim)}` : 'Free up space…'; fb.onclick = () => { S.freeOpen = !S.freeOpen; renderFreePanel(); }; }
    renderFreePanel();
  }

  // ---- "Free up space": choose what to remove, across all cases ----
  // Only files the app made on this computer are ever removed. Originals, transcripts, speaker names and edits are untouched.
  function renderFreePanel() {
    const panel = $('#free-panel'); if (!panel) return;
    if (!S.freeOpen) { panel.hidden = true; panel.innerHTML = ''; return; }
    panel.hidden = false;

    // while audio is being shrunk, show progress instead of choices
    if (S.compacting) {
      const c = S.compact || { overall: 0, label: '' };
      panel.innerHTML = `<div class="card free"><h4>Shrinking audio copies…</h4>
        <div class="progress"><div id="cmp-bar" style="width:${Math.round(c.overall * 100)}%"></div></div>
        <div class="row" style="margin-top:10px"><span class="hint" id="cmp-label">${Math.round(c.overall * 100)}% ${c.label ? '· ' + esc(c.label) : ''}</span><button class="btn small" id="cmp-cancel">Stop</button></div>
        <p class="hint" style="margin:8px 0 0">The original videos are read once. Each audio copy is checked before the larger one is removed. You can stop at any time; nothing is lost.</p></div>`;
      $('#cmp-cancel').onclick = () => bcs.invoke('compact:cancel');
      return;
    }

    const list = (S.recentList || []).filter((r) => (r.proxyBytes || 0) > 2e8 || (r.audioBytes || 0) > 2e8 || (r.shrinkBytes || 0) > 1e8);
    if (!list.length) { panel.innerHTML = '<div class="card"><h4>Free up space</h4><p class="hint">Nothing sizeable to remove right now.</p></div>'; return; }
    S.freeSel = S.freeSel || {};
    for (const r of list) if (!S.freeSel[r.id]) S.freeSel[r.id] = { shrink: (r.shrinkBytes || 0) > 1e8, proxies: (r.proxyBytes || 0) > 2e8, audio: false };
    let h = `<div class="card free"><h4>Free up space</h4>
      <p class="hint">These are files the app made on this computer so cases open and play quickly. Your original videos, transcripts, speaker names and edits are never removed.</p>`;
    for (const r of list) {
      const s = S.freeSel[r.id];
      h += `<div class="free-case"><div class="free-name">${esc(r.name)}</div>
        ${(r.shrinkBytes || 0) > 1e8 ? `<label class="free-opt"><input type="checkbox" data-id="${r.id}" data-k="shrink" ${s.shrink && !s.audio ? 'checked' : ''} ${s.audio ? 'disabled' : ''}><span>Shrink audio copies <em>(recommended: swaps the large lossless copies for the original audio track, copied unchanged. Reads the videos once, a few minutes)</em></span><b>saves ${bytes(r.shrinkBytes)}</b></label>` : ''}
        ${(r.proxyBytes || 0) > 2e8 ? `<label class="free-opt"><input type="checkbox" data-id="${r.id}" data-k="proxies" ${s.proxies ? 'checked' : ''}><span>Local video copies</span><b>${bytes(r.proxyBytes)}</b></label>` : ''}
        ${(r.audioBytes || 0) > 2e8 ? `<label class="free-opt"><input type="checkbox" data-id="${r.id}" data-k="audio" ${s.audio ? 'checked' : ''}><span>Remove all prepared audio <em>(re-made the next time you open this case, a few minutes)</em></span><b>${bytes(r.audioBytes)}</b></label>` : ''}</div>`;
    }
    h += `<div class="free-foot"><span class="hint" id="free-total"></span><span class="grow"></span><button class="btn small ghost" id="free-cancel">Cancel</button><button class="btn small primary" id="free-go">Free up</button></div></div>`;
    panel.innerHTML = h;
    const parts = (r) => { const s = S.freeSel[r.id]; return { shrink: s.shrink && !s.audio ? r.shrinkBytes || 0 : 0, proxies: s.proxies ? r.proxyBytes || 0 : 0, audio: s.audio ? r.audioBytes || 0 : 0 }; };
    const total = () => list.reduce((a, r) => { const p = parts(r); return a + p.shrink + p.proxies + p.audio; }, 0);
    const upd = () => { const t = total(); $('#free-total').textContent = t ? `Frees about ${bytes(t)}` : 'Nothing selected'; $('#free-go').disabled = !t; };
    $$('input[type=checkbox]', panel).forEach((cb) => { cb.onchange = () => { S.freeSel[cb.dataset.id][cb.dataset.k] = cb.checked; if (cb.dataset.k === 'audio') renderFreePanel(); else upd(); }; });
    $('#free-cancel').onclick = () => { S.freeOpen = false; renderFreePanel(); };
    $('#free-go').onclick = () => {
      const t = total(); if (!t) return;
      const chosen = list.filter((r) => { const p = parts(r); return p.shrink || p.proxies || p.audio; });
      const shrinkIds = chosen.filter((r) => parts(r).shrink).map((r) => r.id);
      const foot = $('.free-foot', panel);
      foot.classList.add('confirming');
      foot.innerHTML = `<span class="hint">Free about ${bytes(t)} across ${chosen.length} case${chosen.length === 1 ? '' : 's'}? Your original videos, transcripts, names and edits are not touched.${shrinkIds.length ? ' Shrinking reads the originals once, so keep the drive connected.' : ''}</span><span class="grow"></span><button class="btn small ghost" id="free-back">Back</button><button class="btn small primary" id="free-yes">Yes, free up</button>`;
      $('#free-back').onclick = () => renderFreePanel();
      $('#free-yes').onclick = () => { $('#free-yes').disabled = true; $('#free-back').disabled = true; run(chosen, shrinkIds); };
      $('#free-back').focus();
    };
    const run = async (chosen, shrinkIds) => {
      let freedNow = 0;
      for (const r of chosen) { const s = S.freeSel[r.id]; const p = parts(r); if (p.proxies || p.audio) { await bcs.invoke('cache:clear', r.id, { proxies: !!p.proxies, audio: !!p.audio }); freedNow += p.proxies + p.audio; } }
      S.freedNow = freedNow;
      if (shrinkIds.length) { S.compacting = true; S.compact = { overall: 0, label: '' }; renderFreePanel(); bcs.invoke('compact:start', shrinkIds); return; }
      S.freeOpen = false; S.freeSel = null;
      toast(`Freed about ${bytes(freedNow)}`);
      loadRecents();
    };
    upd();
  }

  bcs.on('compact:progress', (m) => {
    S.compact = Object.assign(S.compact || {}, { overall: m.overall != null ? m.overall : (S.compact || {}).overall || 0, label: m.label != null ? m.label : (S.compact || {}).label });
    if (m.state === 'running') {
      const bar = $('#cmp-bar'); if (bar) bar.style.width = Math.round(S.compact.overall * 100) + '%';
      const lb = $('#cmp-label'); if (lb) lb.textContent = `${Math.round(S.compact.overall * 100)}%${S.compact.label ? ' · ' + S.compact.label : ''}`;
      return;
    }
    // finished, stopped, or failed
    S.compacting = false; S.freeOpen = false; S.freeSel = null;
    const total = (S.freedNow || 0) + (m.freed || 0);
    const note = (m.skipped && m.skipped.length) ? ` ${m.skipped.length} item${m.skipped.length === 1 ? ' was' : 's were'} left as they were.` : '';
    if (m.state === 'finished') toast(`Freed about ${bytes(total)}.${note}`, 9000);
    else if (m.state === 'cancelled') toast(`Stopped. Freed about ${bytes(total)} so far.${note}`, 8000);
    else toast(`Shrinking stopped: ${m.error || 'unknown error'}. Freed about ${bytes(total)}.`, 9000);
    S.freedNow = 0;
    loadRecents();
  });

  async function chooseFolder() {
    const f = await bcs.invoke('dialog:openFolder');
    if (f) openFolder(f);
  }
  async function chooseFiles() {
    const f = await bcs.invoke('dialog:openFiles');
    if (f && f.length) openFolder(f);
  }

  function initWelcome() {
    $('#drop-icon').innerHTML = I.folderLarge(30);
    $('#assure-icon').innerHTML = I.shield(15);
    const drop = $('#drop');
    drop.onclick = chooseFolder;
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseFolder(); } };
    const pf = $('#pick-files'); if (pf) pf.onclick = (e) => { e.stopPropagation(); chooseFiles(); };
    ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if ($('#app').dataset.view === 'welcome') drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget) return; drop.classList.remove('over'); }));
    document.addEventListener('drop', (e) => {
      if ($('#app').dataset.view !== 'welcome') return;
      // a dropped folder opens as a folder; dropped files open as just those files
      const paths = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((f) => bcs.pathForFile(f)).filter(Boolean);
      if (paths.length) openFolder(paths.length === 1 ? paths[0] : paths);
    });
    bcs.on('menu:open', chooseFolder);
    bcs.on('menu:openFiles', chooseFiles);
    loadRecents();
  }

  // ---------- processing ----------
  const STEP_ORDER = ['scan', 'audio', 'sync'];
  function setStep(phase, label, pct, detail) {
    const idx = STEP_ORDER.indexOf(phase);
    $$('.step').forEach((el) => {
      const i = STEP_ORDER.indexOf(el.dataset.step);
      el.classList.toggle('active', i === idx);
      el.classList.toggle('done', i < idx || phase === 'done');
      if (i === idx) $('.step-detail', el).textContent = detail || '';
      else if (i < idx || phase === 'done') $('.step-detail', el).textContent = 'Done';
    });
    $('#proc-bar').style.width = Math.round((pct || 0) * 100) + '%';
  }

  async function openFolder(folder, opts = {}) {
    if (S.compacting) { toast('Audio copies are being shrunk. Let it finish, or stop it first.', 5000); return; }
    $('#proc-name').textContent = Array.isArray(folder) ? `${folder.length} selected files` : folder.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ');
    $('#proc-error').hidden = true; $('#proc-back').hidden = true;
    $$('.step').forEach((el) => { el.classList.remove('active', 'done'); $('.step-detail', el).textContent = ''; });
    $('#proc-bar').style.width = '0%';
    setView('processing');
    const off = bcs.on('analysis:progress', (m) => setStep(m.phase, m.label, m.pct, m.detail));
    const r = await bcs.invoke('project:open', folder, opts);
    off();
    if (!r.ok) {
      $('#proc-error').hidden = false; $('#proc-error').textContent = r.error;
      $('#proc-back').hidden = false; $('#proc-back').onclick = () => { setView('welcome'); loadRecents(); };
      return;
    }
    enterWorkspace(r.project);
  }

  // ---------- workspace ----------
  // Short, distinguishing labels for files that don't follow a known naming pattern: drop every part the
  // files all share (dates, common words) and keep what tells them apart.
  function shortNames(names) {
    const toks = names.map((n) => n.replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/Stream[_\s-]*(\d+)/i, 'S$1').split(/[_\s-]+/).filter(Boolean));
    const df = new Map();
    toks.forEach((t) => new Set(t).forEach((x) => df.set(x, (df.get(x) || 0) + 1)));
    const out = toks.map((t, i) => {
      const seen = new Set(), keep = [];
      for (const x of t) {
        if (seen.has(x)) continue; seen.add(x);
        if (names.length > 1 && df.get(x) === names.length) continue;
        if (/^\d{8}$/.test(x)) continue;
        keep.push(/^\d{4}$/.test(x) ? x.slice(0, 2) + ':' + x.slice(2) : x);
      }
      const s = keep.join(' ') || names[i];
      return s.length > 40 ? s.slice(0, 39) + '…' : s;
    });
    const count = new Map();
    return out.map((s) => { const k = (count.get(s) || 0) + 1; count.set(s, k); return out.filter((x) => x === s).length > 1 ? `${s} #${k}` : s; });
  }

  function buildCams(project) {
    const prefs = project.prefs || {};
    const plain = project.groups.filter((g) => !g.officer);
    const shorts = new Map();
    if (plain.length) shortNames(plain.map((g) => g.files[0].name)).forEach((s, k) => shorts.set(plain[k].id, s));
    return project.groups.map((g, i) => {
      const angle = (prefs.angle && prefs.angle[g.id]) || g.files[0].angle;
      const file = g.files.find((f) => f.angle === angle) || g.files[0];
      const usable = g.tracks.filter((t) => !t.silent);
      const track = usable.find((t) => t.index === (prefs.track && prefs.track[g.id])) || usable[0] || null;
      const last = g.officer ? g.officer.split(' ').slice(-1)[0] : '';
      return {
        id: g.id, group: g, color: COLORS[i % COLORS.length], tint: mixHex(COLORS[i % COLORS.length], 0.5), letter: letterOf(i),
        label: g.label, shortLabel: [last, (KIND[g.kind] || '').toLowerCase()].filter(Boolean).join(' ') || shorts.get(g.id) || g.files[0].name,
        start: g.start + ((project.nudges || {})[g.id] || 0),
        duration: file.duration, file, angle, track,
        env: track ? track.env : [], envHop: track ? track.envHop : 0.5,
        visible: !(prefs.visible && prefs.visible[g.id] === false),
      };
    });
  }

  const savePrefs = debounce(() => {
    if (!S.project) return;
    const prefs = { visible: {}, angle: {}, track: {}, mode: S.mode, active: S.engine.activeId, proxies: S.useProxies, autoProxies: S.autoProxies, captions: S.captions, capSpeakers: S.capSpeakers, capSize: S.capSize };
    for (const c of S.cams) { prefs.visible[c.id] = c.visible !== false; prefs.angle[c.id] = c.angle; if (c.track) prefs.track[c.id] = c.track.index; }
    S.project.prefs = prefs;
    bcs.invoke('project:setPrefs', S.project.id, prefs);
  }, 400);

  function enterWorkspace(project) {
    S.project = project;
    S.cams = buildCams(project);
    const prefs = project.prefs || {};
    S.mode = prefs.mode || 'grid';
    S.useProxies = prefs.proxies !== false;
    S.autoProxies = prefs.autoProxies !== false;
    // Captions are off unless the reviewer turned them on for this case.
    S.captions = ['off', 'active', 'all'].includes(prefs.captions) ? prefs.captions : 'off';
    S.capSpeakers = prefs.capSpeakers !== false;
    S.capSize = ['s', 'm', 'l'].includes(prefs.capSize) ? prefs.capSize : 'm';
    S.proxy = {};
    S.engine.useProxies = S.useProxies;
    S.engine.load(S.cams);
    const active = S.cams.find((c) => c.id === prefs.active && c.visible) || S.cams.find((c) => c.visible) || S.cams[0];
    S.engine.setActive(active.id, { instant: true });
    S.syncSel = active.id;
    // start at the first moment any camera has footage and sound
    buildStage();
    setView('workspace');
    if (!S.timeline) S.timeline = new Timeline($('#timeline'), S.engine, { onSelect: selectCam });
    S.timeline.resize();
    S.timeline.setCams(S.cams);
    layoutStage();
    selectTab(S.tab);
    updateTransport();
    S.engine.seek(0);
    loadRecents();
    updateTags();
    S.engine.on('source', updateTags);
    TX().reset();
    CC().reset();
    TX().load().then(() => { if (S.tab === 'transcript' || S.tab === 'playback') renderPanel(); CC().refresh(); updateTransport(); });
    if (!S._trWired) { S._trWired = true; S.engine.on('time', throttle(() => TX().markNow(false), 250)); }
    // Make local copies in the background (they make seeking instant), and measure seek speed meanwhile.
    if (S.autoProxies) setTimeout(() => { if (S.project === project) maybeAutoProxies(); }, 2500);
    setTimeout(autoBenchmark, 1800);
  }

  // ---- stage -----------------------------------------------------------
  function buildStage() {
    const stage = $('#stage');
    stage.innerHTML = '';
    for (const c of S.cams) {
      const t = document.createElement('div');
      t.className = 'tile'; t.dataset.cam = c.id; t.style.setProperty('--cam', c.color);
      // Labels sit in a caption bar below the picture so they never cover burned-in footage metadata.
      const view = document.createElement('div'); view.className = 'tile-view';
      view.append(c.video);
      const empty = document.createElement('div'); empty.className = 'tile-empty';
      empty.innerHTML = `<b>No footage at this moment</b><span class="mono t-empty"></span>`;
      view.append(empty);
      const cap = document.createElement('div'); cap.className = 'tile-cap';
      cap.innerHTML = `<span class="cap-l">${ctab(c)}<span class="t-label">${esc(c.shortLabel)}</span><span class="tag t-tag" hidden title="This picture is a smaller copy kept on this computer. The original file is unchanged."></span></span><span class="cap-r"><span class="mono t-time"></span><span class="spk">${I.speaker(13)}</span></span>`;
      t.append(view, cap);
      t.addEventListener('click', () => selectCam(c.id));
      t.addEventListener('dblclick', () => { selectCam(c.id); setMode(S.mode === 'grid' ? 'focus' : 'grid'); });
      c.tile = t;
      c.video.addEventListener('waiting', () => { if (S.engine.playing) t.classList.add('loading'); });
      ['playing', 'canplay', 'seeked', 'pause'].forEach((ev) => c.video.addEventListener(ev, () => t.classList.remove('loading')));
      stage.append(t);
    }
  }

  function layoutStage() {
    const stage = $('#stage');
    if (!S.cams.every((c) => c.tile)) return;
    const vis = S.cams.filter((c) => c.visible);
    for (const c of S.cams) { c.tile.classList.toggle('hidden', !c.visible); c.tile.classList.toggle('active', c.id === S.engine.activeId); c.tile.classList.remove('main'); }
    stage.style.gridTemplateColumns = ''; stage.style.gridTemplateRows = '';
    const n = vis.length;
    if (!n) return;
    if (S.mode === 'focus' && n > 1) {
      const main = vis.find((c) => c.id === S.engine.activeId) || vis[0];
      const rest = vis.filter((c) => c !== main);
      stage.style.gridTemplateRows = 'minmax(0, 1fr) 118px';
      stage.style.gridTemplateColumns = `repeat(${rest.length}, minmax(0, 208px)) minmax(0, 1fr)`;
      main.tile.classList.add('main'); main.tile.style.gridColumn = '1 / -1'; main.tile.style.gridRow = '1';
      rest.forEach((c, i) => { c.tile.style.gridColumn = `${i + 1}`; c.tile.style.gridRow = '2'; });
    } else {
      const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
      const rows = Math.ceil(n / cols);
      stage.style.gridTemplateColumns = `repeat(${cols * 2}, minmax(0, 1fr))`;
      stage.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
      vis.forEach((c, i) => {
        const r = Math.floor(i / cols);
        const inRow = Math.min(cols, n - r * cols);
        const startCol = 1 + (cols - inRow) + (i % cols) * 2;
        c.tile.style.gridColumn = `${startCol} / span 2`; c.tile.style.gridRow = `${r + 1}`;
      });
    }
    stage.dataset.mode = S.mode === 'focus' && n > 1 ? 'focus' : 'grid';
    $$('#mode-seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
  }

  function setMode(m) { S.mode = m; layoutStage(); savePrefs(); CC().update(); }

  // ---- captions ----------------------------------------------------------
  // Remembers the last "on" choice so the button and the C key restore it.
  function setCaptions(mode) {
    S.captions = mode;
    if (mode !== 'off') S._capLast = mode;
    updateTransport(); savePrefs(); CC().refresh();
    if (S.tab === 'playback') renderPanel();
  }
  function toggleCaptions() {
    if (S.captions && S.captions !== 'off') { setCaptions('off'); return; }
    setCaptions(S._capLast || 'active');
    if (!CC().hasTranscript()) toast('Captions come from the transcript. This case has none yet: make one in the Transcript tab.', 7000);
  }

  function selectCam(id) {
    const c = S.cams.find((x) => x.id === id);
    if (!c) return;
    if (!c.visible) { c.visible = true; S.engine.seek(S.engine.T, { precise: true }); }
    S.engine.setActive(id);
    S.syncSel = id;
    layoutStage();
    renderPanel();
    S.timeline && S.timeline.invalidate();
    savePrefs();
  }

  function toggleVisible(id) {
    const c = S.cams.find((x) => x.id === id);
    if (!c) return;
    const visCount = S.cams.filter((x) => x.visible).length;
    if (c.visible && visCount === 1) return;
    c.visible = !c.visible;
    if (!c.visible && S.engine.activeId === id) { const nx = S.cams.find((x) => x.visible); if (nx) S.engine.setActive(nx.id); }
    if (c.visible) S.engine.seek(S.engine.T, { precise: true });
    else { c.video.pause(); if (c.audio) c.audio.pause(); }
    layoutStage(); renderPanel(); savePrefs();
  }

  // ---- transport ---------------------------------------------------------
  function updateTransport() {
    $('#btn-play').innerHTML = S.engine.playing ? I.pause(18) : I.play(18);
    $('#btn-back').innerHTML = I.frameBack(16);
    $('#btn-fwd').innerHTML = I.frameFwd(16);
    $$('#mode-seg button').forEach((b) => { b.innerHTML = b.dataset.mode === 'grid' ? I.grid(15) : I.focus(15); b.classList.toggle('on', b.dataset.mode === S.mode); });
    const v = S.engine.volume;
    $('#vol-icon').innerHTML = v === 0 ? I.mute(16) : v < 0.5 ? I.speakerLow(16) : I.speaker(16);
    const cc = $('#btn-cc');
    if (cc) {
      cc.innerHTML = I.captions(16);
      const on = S.captions && S.captions !== 'off';
      cc.classList.toggle('on', !!on);
      cc.setAttribute('aria-pressed', on ? 'true' : 'false');
      cc.title = (on ? 'Hide captions' : 'Show captions') + '  C';
    }
  }

  let lastText = '';
  function onTime() {
    const T = S.engine.T;
    const tc = hms(T, true);
    if (tc !== lastText) { $('#timecode').textContent = tc; lastText = tc; }
    $('#timecode-sub').textContent = 'of ' + hms(S.engine.duration);
    for (const c of S.cams) {
      if (!c.visible || !c.tile) continue;
      const l = T - c.start;
      const cov = l >= 0 && l <= c.duration - 0.05;
      const timeEl = $('.t-time', c.tile);
      if (timeEl) timeEl.textContent = cov ? hms(l) : '';
      c.tile.classList.toggle('out', !cov);
      if (!cov) { const e = $('.t-empty', c.tile); if (e) e.textContent = l < 0 ? `Starts in ${fmtTime(-l)}` : 'Recording ended'; }
    }
  }

  function initTransport() {
    $('#btn-play').onclick = () => S.engine.toggle();
    $('#btn-back').onclick = () => S.engine.step(-1);
    $('#btn-fwd').onclick = () => S.engine.step(1);
    $('#speed').onchange = (e) => S.engine.setRate(parseFloat(e.target.value));
    $('#vol').oninput = (e) => { S.engine.setVolume(parseFloat(e.target.value)); updateTransport(); };
    $$('#mode-seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    $('#btn-cc').onclick = toggleCaptions;
    S.engine.on('time', onTime);
    S.engine.on('time', throttle(() => CC().update(), 90));
    S.engine.on('state', updateTransport);
    S.engine.on('active', () => { layoutStage(); renderPanel(); CC().update(); });
    S.engine.on('coverage', () => { onTime(); CC().update(); });

    document.addEventListener('keydown', (e) => {
      if ($('#app').dataset.view !== 'workspace') return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' && e.target.type !== 'range') return;
      if (tag === 'select') return;
      const k = e.key;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (k === 'f' || k === 'F')) { e.preventDefault(); selectTab('transcript'); setTimeout(() => { const q = $('#tr-q'); if (q) { q.focus(); q.select(); } }, 60); return; }
      if (k === ' ') { e.preventDefault(); S.engine.toggle(); }
      else if (k === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? S.engine.seek(S.engine.T - 1, { precise: true }) : S.engine.step(-1); }
      else if (k === 'ArrowRight') { e.preventDefault(); e.shiftKey ? S.engine.seek(S.engine.T + 1, { precise: true }) : S.engine.step(1); }
      else if (k === ',') S.engine.step(-1);
      else if (k === '.') S.engine.step(1);
      else if (k === 'j' || k === 'J') S.engine.seek(S.engine.T - 10, { precise: true });
      else if (k === 'l' || k === 'L') S.engine.seek(S.engine.T + 10, { precise: true });
      else if (k === 'Home') S.engine.seek(0, { precise: true });
      else if (k === 'g' || k === 'G') setMode(S.mode === 'grid' ? 'focus' : 'grid');
      else if (!meta && (k === 'c' || k === 'C')) toggleCaptions();
      else if (k === 'Tab') { e.preventDefault(); const vis = S.cams.filter((c) => c.visible); const i = vis.findIndex((c) => c.id === S.engine.activeId); selectCam(vis[(i + (e.shiftKey ? -1 : 1) + vis.length) % vis.length].id); }
      else if (!meta && /^[1-9]$/.test(k)) { const c = S.cams[parseInt(k, 10) - 1]; if (c) selectCam(c.id); }
    });
  }

  // ---------- side panel ----------
  function selectTab(t) {
    S.tab = t;
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    renderPanel();
  }

  const renderPanel = throttle(() => {
    const p = $('#panel');
    if (!S.project) return;
    const scroll = p.scrollTop;
    ({ cameras: panelCameras, transcript: (el) => TX().panel(el), sync: panelSync, playback: panelPlayback, files: panelFiles }[S.tab])(p);
    p.scrollTop = scroll;
  }, 120);

  function trackOpts(c) {
    const usable = c.group.tracks.filter((t) => !t.silent);
    return usable.length > 1 ? usable : [];
  }

  function panelCameras(p) {
    let h = `<div class="section-label group-title">Cameras</div><div class="hint" style="margin-bottom:10px">Click a camera to hear it. Double-click a picture for a single view.</div>`;
    S.cams.forEach((c, i) => {
      const active = c.id === S.engine.activeId;
      const f = c.file;
      const sub = [c.group.officer ? c.group.unit : '', f.height ? `${f.height}p` : '', c.track ? c.track.friendly : 'no audio'].filter(Boolean).join(' · ');
      h += `<div class="cam-row ${active ? 'active' : ''}" style="--cam:${c.color}" data-id="${c.id}">
        ${ctab(c)}
        <div class="cr-main" data-act="select" title="${esc(f.name)}"><div class="cr-name"><span class="cr-t">${esc(c.shortLabel)}</span>${active ? `<span style="color:${c.color};flex:none">${I.speaker(13)}</span>` : ''}</div><div class="cr-sub">${esc(sub)}</div></div>
        <div class="cr-tools"><span class="mono" style="color:var(--text-3);margin-right:4px">${i + 1}</span><button class="icon-btn" data-act="vis" title="${c.visible ? 'Hide this camera' : 'Show this camera'}">${c.visible ? I.eye(16) : I.eyeOff(16)}</button></div>`;
      const opts = [];
      if (c.group.files.length > 1) {
        opts.push(`<span class="opt-label">Angle</span><span class="mini-seg">${c.group.files.map((x) => `<button data-act="angle" data-v="${x.angle}" class="${x.angle === c.angle ? 'on' : ''}" title="${esc(x.name)}${x.derivative ? ' (re-encoded copy)' : ''} — ${x.width}×${x.height}">${x.angle}${x.derivative ? '*' : ''}</button>`).join('')}</span>`);
      }
      const to = trackOpts(c);
      if (to.length) opts.push(`<span class="opt-label">Sound</span><span class="mini-seg">${to.map((t) => `<button data-act="track" data-v="${t.index}" class="${c.track && t.index === c.track.index ? 'on' : ''}">${esc(t.friendly)}</button>`).join('')}</span>`);
      if (opts.length) h += `<div class="cr-opts">${opts.join('')}</div>`;
      h += `</div>`;
    });
    h += `<div class="section-label group-title">Shortcuts</div><div class="keys">
      <span class="kbd">Space</span><span>Play / pause</span>
      <span class="kbd">← →</span><span>One frame back / forward</span>
      <span class="kbd">${window.BCS_KEYS.shift} ← →</span><span>One second</span>
      <span class="kbd">J  L</span><span>Ten seconds back / forward</span>
      <span class="kbd">1 – 9</span><span>Switch camera and sound</span>
      <span class="kbd">Tab</span><span>Next camera</span>
      <span class="kbd">G</span><span>Grid or single view</span></div>`;
    p.innerHTML = h;
    $$('.cam-row', p).forEach((row) => {
      const id = row.dataset.id;
      row.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        const act = b.dataset.act;
        if (act === 'select') selectCam(id);
        else if (act === 'vis') toggleVisible(id);
        else if (act === 'angle') changeAngle(id, b.dataset.v);
        else if (act === 'track') changeTrack(id, parseInt(b.dataset.v, 10));
      });
    });
  }

  function changeAngle(id, angle) {
    const c = S.cams.find((x) => x.id === id); if (!c || c.angle === angle) return;
    S.engine.setAngle(id, angle);
    S.timeline.invalidate(); renderPanel(); savePrefs();
  }
  function changeTrack(id, idx) {
    const c = S.cams.find((x) => x.id === id); if (!c) return;
    S.engine.setTrack(id, idx);
    c.env = c.track.env; c.envHop = c.track.envHop;
    S.timeline.invalidate(); renderPanel(); savePrefs();
  }

  // ---- sync tab ----
  function qualityBadge(g) {
    const q = g.syncQuality || {};
    switch (q.level) {
      case 'reference': return '<span class="badge">Reference</span>';
      case 'strong': return `<span class="badge good">${I.check(11)} Matched by sound</span>`;
      case 'moderate': return '<span class="badge warn">Matched — check</span>';
      case 'weak': return '<span class="badge bad">Weak match</span>';
      case 'estimate': return '<span class="badge bad">Estimated from filename</span>';
      default: return '';
    }
  }

  function nudgeCam(id, secs) {
    const c = S.cams.find((x) => x.id === id); if (!c) return;
    const cur = (S.project.nudges || {})[id] || 0;
    const next = Math.round((cur + secs) * 10000) / 10000;
    S.project.nudges = S.project.nudges || {};
    if (Math.abs(next) < 1e-6) delete S.project.nudges[id]; else S.project.nudges[id] = next;
    c.start = c.group.start + (S.project.nudges[id] || 0);
    S.engine.setStart(id, c.start);
    S.timeline.invalidate();
    bcs.invoke('project:setNudge', S.project.id, id, S.project.nudges[id] || 0);
    renderPanel();
  }

  function panelSync(p) {
    const sync = S.project.sync || { edges: [], residuals: [] };
    const worst = Math.max(0, ...(sync.residuals || []).map((r) => Math.abs(r.ms)));
    let h = `<div class="section-label group-title">Alignment</div>`;
    h += `<div class="card"><p>Cameras are lined up by matching what they hear. Each match is checked at many points across the recording.</p>`;
    if ((sync.residuals || []).length) h += `<div class="row"><span class="hint">Cross-check between independent matches</span><span class="mono">${worst < 1 ? '< 1' : worst.toFixed(0)} ms</span></div>`;
    h += `</div>`;
    S.cams.forEach((c) => {
      const g = c.group; const q = g.syncQuality || {};
      const nudge = (S.project.nudges || {})[c.id] || 0;
      const sel = S.syncSel === c.id;
      h += `<div class="sync-row" data-id="${c.id}" style="--cam:${c.color}">
        <div class="sr-head"><div class="sr-name">${ctab(c)}${esc(c.shortLabel)}</div>${qualityBadge(g)}</div>
        <div class="kv" style="margin-top:8px">
          <span class="k">Starts at</span><span class="v mono">${hms(c.start, true)}</span>`;
      if (q.agree != null) h += `<span class="k">Matching points</span><span class="v">${q.agree} of ${q.total}</span><span class="k">Agreement between points</span><span class="v">±${q.spreadMs} ms</span>`;
      if (q.driftPpm != null && Math.abs(q.driftPpm) > 20) h += `<span class="k">Clock drift</span><span class="v">${q.driftPpm} ppm</span>`;
      if (nudge) h += `<span class="k">Manual adjustment</span><span class="v mono">${nudge > 0 ? '+' : '−'}${Math.abs(nudge * 1000).toFixed(1)} ms</span>`;
      h += `</div>`;
      if (g.syncMethod !== 'reference') {
        h += `<div class="nudge" ${sel ? '' : 'style="display:none"'}>
          <button data-n="${-FRAME}" title="Move this camera earlier by one frame">−1 fr</button><button data-n="-0.01">−10 ms</button><button data-n="-0.001">−1 ms</button>
          <button data-n="0.001">+1 ms</button><button data-n="0.01">+10 ms</button><button data-n="${FRAME}">+1 fr</button></div>`;
        h += `<div class="row" style="margin-top:8px"><button class="btn small ghost" data-act="adj">${sel ? 'Done adjusting' : 'Adjust manually'}</button>${nudge ? '<button class="btn small ghost" data-act="reset">Reset</button>' : '<span></span>'}</div>`;
      }
      h += `</div>`;
    });
    h += `<div class="row" style="margin-top:14px"><span class="hint">Re-reads every file and recomputes the sync.</span><button class="btn small" id="reanalyze">Re-analyze</button></div>`;
    p.innerHTML = h;
    $$('.sync-row', p).forEach((row) => {
      const id = row.dataset.id;
      row.addEventListener('click', (e) => {
        const n = e.target.closest('[data-n]');
        if (n) return nudgeCam(id, parseFloat(n.dataset.n));
        const a = e.target.closest('[data-act]');
        if (!a) return;
        if (a.dataset.act === 'adj') { S.syncSel = S.syncSel === id ? null : id; renderPanel(); }
        if (a.dataset.act === 'reset') { const cur = (S.project.nudges || {})[id] || 0; nudgeCam(id, -cur); }
      });
    });
    $('#reanalyze').onclick = () => { S.engine.pause(); openFolder(S.project.selection || S.project.folder, { force: true }); };
  }

  // ---- playback tab ----
  function verdict(ms) { return ms < 250 ? ['good', 'Fast'] : ms < 800 ? ['warn', 'Slowish'] : ['bad', 'Slow']; }

  function panelPlayback(p) {
    const proxyKeys = S.cams.map((c) => `${c.id}_${c.angle}`);
    const built = S.cams.filter((c) => c.file.proxyUrl).length;
    const running = Object.values(S.proxy).some((x) => x.state === 'running' || x.state === 'queued');
    const hasSpk = !!(S.tr && Object.keys(S.tr.spk || {}).length);
    let h = `<div class="section-label group-title">Captions</div><div class="card">
      <p>Shows the transcript line being spoken over the picture, with who is speaking. Captions are drawn on screen only. Nothing is added to the video or to any file.</p>
      <div class="row"><span>Show captions</span><span class="mini-seg" id="cc-mode">${[['off', 'Off'], ['active', 'Audible camera'], ['all', 'Every camera']].map(([v, t]) => `<button data-v="${v}" class="${(S.captions || 'off') === v ? 'on' : ''}">${t}</button>`).join('')}</span></div>
      <div class="row"><span>Show who is speaking</span><button class="toggle ${S.capSpeakers ? 'on' : ''}" id="cc-spk" aria-label="Show who is speaking"></button></div>
      <div class="row"><span>Text size</span><span class="mini-seg" id="cc-size">${[['s', 'Small'], ['m', 'Medium'], ['l', 'Large']].map(([v, t]) => `<button data-v="${v}" class="${(S.capSize || 'm') === v ? 'on' : ''}">${t}</button>`).join('')}</span></div>
      <div class="hint" style="margin-top:6px">${CC().hasTranscript() ? '' : 'This case has no transcript yet. Make one in the Transcript tab and captions will appear. '}Each camera shows what its own microphone picked up, including your corrections from the Transcript tab. Timing is good to about a second. ${hasSpk || !S.capSpeakers ? '' : 'Speakers have not been detected for this case yet (Transcript tab), so no names are shown. '}A name appears only after you assign a voice to a person. Voices the computer grouped on its own show as “Speaker N” marked <b>unconfirmed</b>: a guess from the sound of the voice, not an identification. Faded words are low-confidence. Always check against the audio. Press C to turn captions on or off.</div></div>`;
    h += `<div class="section-label group-title">Seeking speed</div><div class="card">`;
    h += `<p>Measures how quickly each camera jumps to a new moment. Slow seeking usually means the source drive is slow.</p>`;
    if (S.bench) {
      for (const r of S.bench) {
        const [cls, word] = verdict(r.median);
        h += `<div class="row"><span style="display:flex;align-items:center;gap:8px">${ctab(S.cams.find((c) => c.id === r.id), true)}${esc((S.cams.find((c) => c.id === r.id) || {}).shortLabel || '')}</span><span><span class="mono">${Math.round(r.median)} ms</span> <span class="badge ${cls}">${word}</span></span></div>`;
      }
      if (S.bench.some((r) => r.proxy)) h += `<div class="hint" style="margin-top:6px">Measured on local copies.</div>`;
    }
    h += `<div class="row" style="margin-top:10px"><span class="hint">${S.bench ? 'Median of several random jumps.' : 'Not measured yet.'}</span><button class="btn small" id="bench">${S.benchRunning ? 'Measuring…' : S.bench ? 'Test again' : 'Test seeking'}</button></div></div>`;

    h += `<div class="section-label group-title">Local copies</div><div class="card">
      <p>Smaller copies kept on this computer make seeking and scrubbing instant, even if the evidence drive is slow. Your original files are never changed and stay the source of truth.</p>
      ${S.proxyPlan && S.proxyPlan.blocked && built < S.cams.filter((c) => c.visible).length ? `<p class="hint" style="color:var(--warn)">Not built automatically: copies for ${S.proxyPlan.n} cameras would use about ${bytes(S.proxyPlan.est)}, and this computer has ${bytes(S.proxyPlan.free)} free. Hide cameras you don’t need (Cameras tab) and build only for the rest.</p>` : ''}
      <div class="row"><span>Use local copies when available</span><button class="toggle ${S.useProxies ? 'on' : ''}" id="proxy-toggle" aria-label="Use local copies"></button></div>
      <div class="row"><span>Prepare them automatically</span><button class="toggle ${S.autoProxies ? 'on' : ''}" id="proxy-auto" aria-label="Prepare local copies automatically"></button></div>
      <div class="hint" style="margin:6px 0 8px">Local copies are 720p. Turn them off to view the full-resolution originals.</div>`;
    for (const c of S.cams) {
      const st = S.proxy[`${c.id}_${c.angle}`];
      const done = !!c.file.proxyUrl;
      h += `<div class="row"><span style="display:flex;align-items:center;gap:8px">${ctab(c, true)}${esc(c.shortLabel)}</span><span class="mono" style="color:var(--text-3)">${done ? 'Ready' : st && st.state === 'running' ? Math.round(st.pct * 100) + '%' : st && st.state === 'queued' ? 'Waiting' : st && st.state === 'error' ? 'Failed' : '—'}</span></div>`;
      if (st && st.state === 'running') h += `<div class="progress"><div style="width:${Math.round(st.pct * 100)}%"></div></div>`;
    }
    h += `<div class="row" style="margin-top:12px">`;
    const allBuilt = built === S.cams.length;
    h += running ? `<button class="btn small" id="proxy-cancel">Cancel</button>` : allBuilt ? '<span class="hint">All cameras have local copies.</span>' : `<button class="btn small primary" id="proxy-build">${built ? 'Build missing copies' : 'Build local copies'}</button>`;
    h += built ? `<button class="btn small ghost" id="proxy-clear">Remove copies</button>` : '<span></span>';
    h += `</div><div class="hint" style="margin-top:8px">Using ${bytes(S.project.cacheBytes || 0)} of cache on this computer.</div></div>`;
    p.innerHTML = h;
    $$('#cc-mode button').forEach((b) => { b.onclick = () => setCaptions(b.dataset.v); });
    $('#cc-spk').onclick = () => { S.capSpeakers = !S.capSpeakers; savePrefs(); CC().refresh(); renderPanel(); };
    $$('#cc-size button').forEach((b) => { b.onclick = () => { S.capSize = b.dataset.v; savePrefs(); CC().refresh(); renderPanel(); }; });
    const bench = $('#bench'); if (bench) bench.onclick = runBenchmark;
    $('#proxy-toggle').onclick = () => { S.useProxies = !S.useProxies; S.engine.setProxyMode(S.useProxies); savePrefs(); renderPanel(); };
    $('#proxy-auto').onclick = () => { S.autoProxies = !S.autoProxies; savePrefs(); renderPanel(); };
    const pb = $('#proxy-build'); if (pb) pb.onclick = buildProxies;
    const pc = $('#proxy-cancel'); if (pc) pc.onclick = () => bcs.invoke('proxy:cancel');
    const pr = $('#proxy-clear'); if (pr) pr.onclick = async () => { await bcs.invoke('proxy:remove', S.project.id); await refreshProject(); S.useProxies = false; S.engine.setProxyMode(false); renderPanel(); };
  }

  // Local copies only for the cameras being watched, never all of a large case, and never when
  // they would take a big share of the disk. (A 20-camera case needs tens of gigabytes.)
  async function buildProxies() {
    for (const c of S.cams) if (c.visible && !c.file.proxyUrl) await bcs.invoke('proxy:build', S.project.id, c.id, c.angle);
  }

  async function maybeAutoProxies() {
    if (!S.autoProxies || !S.project) return;
    const missing = S.cams.filter((c) => c.visible && !c.file.proxyUrl);
    if (!missing.length) return;
    const est = missing.reduce((a, c) => a + (c.file.duration || 0) * 5e6 / 8 * 1.15, 0);
    const { free } = await bcs.invoke('disk:free');
    S.proxyPlan = { est, free, n: missing.length, blocked: est > 8e9 || free - est < 25e9 };
    if (S.proxyPlan.blocked) {
      toast(`Local copies for ${missing.length} cameras would use about ${bytes(est)} (${bytes(free)} free), so they weren’t built automatically. See Playback.`, 10000);
      if (S.tab === 'playback') renderPanel();
      return;
    }
    buildProxies();
  }

  async function refreshProject() {
    const fresh = await bcs.invoke('project:get', S.project.id);
    if (!fresh) return;
    S.project.cacheBytes = fresh.cacheBytes;
    for (const c of S.cams) {
      const g = fresh.groups.find((x) => x.id === c.id);
      for (const f of g.files) { const mine = c.group.files.find((x) => x.angle === f.angle); if (mine) { mine.proxyUrl = f.proxyUrl; mine.hash = f.hash; } }
    }
  }

  async function runBenchmark(auto = false, count = 6) {
    if (S.benchRunning) return;
    S.benchRunning = true; renderPanel();
    const res = await S.engine.benchmarkSeeks(count);
    S.benchRunning = false; S.bench = res;
    renderPanel();
    return res;
  }
  async function autoBenchmark() {
    if (S.engine.playing || S.autoBenched) return;
    S.autoBenched = true;
    const res = await runBenchmark(true, 3);
    if (!res) return;
    const slow = res.filter((r) => r.median >= 800);
    if (slow.length && !S.useProxies) toast(`Seeking on ${slow.map((r) => r.label.split(' · ')[0]).join(', ')} is slow. Local copies would help — see Playback.`, 7000);
  }

  bcs.on('proxy:progress', async (m) => {
    if (!S.project) return;
    S.proxy[`${m.groupId}_${m.angle}`] = m;
    if (m.state === 'done') {
      await refreshProject();
      S.engine.setProxyMode(S.useProxies);
    }
    if (m.state === 'error') toast('Could not build a local copy: ' + (m.error || 'unknown error'), 6000);
    updateStatus();
    if (S.tab === 'playback') renderPanel();
  });

  // ---- files tab ----
  function panelFiles(p) {
    const hs = S.hash;
    let h = `<div class="section-label group-title">Integrity</div><div class="card">
      <p>Your originals are opened read-only. A fingerprint (SHA-256) of each file lets you show later that nothing changed.</p>`;
    if (hs.running) h += `<div class="progress"><div style="width:${Math.round(hs.overall * 100)}%"></div></div><div class="row" style="margin-top:10px"><span class="hint">${Math.round(hs.overall * 100)}% of ${bytes(S.project.groups.reduce((a, g) => a + g.files.reduce((b, f) => b + f.size, 0), 0))}</span><button class="btn small" id="hash-cancel">Stop</button></div>`;
    else h += `<div class="row"><span class="hint">Reads every file once; can take a while on a network drive.</span><button class="btn small" id="hash-start">Fingerprint originals</button></div>`;
    h += `</div>`;
    for (const g of S.project.groups) {
      const cam = S.cams.find((c) => c.id === g.id);
      h += `<div class="section-label group-title" style="display:flex;align-items:center;gap:8px">${ctab(cam, true)}${esc(cam.shortLabel)}</div>`;
      for (const f of g.files) {
        const live = hs.files[f.path];
        const hash = (live && live.sha256) || (f.hash && f.hash.sha256);
        const flags = [];
        if (f.derivative) flags.push('<span class="badge warn" title="This file was re-encoded after it left the camera system">Re-encoded copy</span>');
        if (f.variableFrameRate) flags.push('<span class="badge">Variable frame rate</span>');
        if (!f.exists) flags.push('<span class="badge bad">Missing</span>');
        h += `<div class="file" data-path="${esc(f.path)}">
          <div class="row" style="align-items:flex-start"><div class="f-name">${esc(f.name)}</div><button class="icon-btn" data-act="reveal" title="Show in Finder" style="margin:-6px -6px 0 0">${I.reveal(14)}</button></div>
          <div class="f-meta">Angle ${f.angle} · ${f.width}×${f.height} · ${esc((f.codec || '').toUpperCase())} · ${bytes(f.size)} · ${hms(f.duration)}</div>
          ${flags.length ? `<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">${flags.join('')}</div>` : ''}
          ${live && live.state === 'running' ? `<div class="progress"><div style="width:${Math.round((live.pct || 0) * 100)}%"></div></div>` : ''}
          ${hash ? `<div class="f-hash">SHA-256 ${hash}</div>` : ''}
        </div>`;
      }
    }
    p.innerHTML = h;
    const hsb = $('#hash-start'); if (hsb) hsb.onclick = () => { S.hash = { running: true, overall: 0, files: {} }; bcs.invoke('hash:start', S.project.id); renderPanel(); };
    const hcb = $('#hash-cancel'); if (hcb) hcb.onclick = () => bcs.invoke('hash:cancel');
    $$('.file [data-act=reveal]', p).forEach((b) => { b.onclick = () => bcs.invoke('shell:reveal', b.closest('.file').dataset.path); });
  }

  bcs.on('hash:progress', (m) => {
    const hs = S.hash;
    if (m.path) hs.files[m.path] = Object.assign(hs.files[m.path] || {}, m);
    if (m.overall != null) hs.overall = m.overall;
    if (m.state === 'finished' || m.state === 'cancelled') { hs.running = false; refreshProject().then(() => { if (S.tab === 'files') renderPanel(); }); }
    else hs.running = true;
    if (S.tab === 'files') renderPanel();
  });

  // ---------- boot ----------
  // Drag the bar above the timeline to make it taller or shorter (double-click: fit every camera).
  function initResizer() {
    const h = $('#tl-resizer'), col = $('.stage-col'), wrap = $('.timeline-wrap');
    if (!h || !col) return;
    const clampH = (v) => Math.max(90, Math.min(v, window.innerHeight - 44 - 300));
    const apply = (v, save) => {
      col.style.setProperty('--tl-h', Math.round(v) + 'px');
      if (save) { try { localStorage.setItem('bcs.timelineHeight', String(Math.round(v))); } catch (_) { /* ignore */ } }
    };
    try { const s = parseInt(localStorage.getItem('bcs.timelineHeight') || '0', 10); if (s) apply(clampH(s), false); } catch (_) { /* ignore */ }
    let startY = 0, startH = 0, active = false;
    h.addEventListener('pointerdown', (e) => { active = true; startY = e.clientY; startH = wrap.getBoundingClientRect().height; h.setPointerCapture(e.pointerId); h.classList.add('drag'); e.preventDefault(); });
    h.addEventListener('pointermove', (e) => { if (active) apply(clampH(startH + (startY - e.clientY)), false); });
    const end = (e) => { if (!active) return; active = false; h.classList.remove('drag'); apply(wrap.getBoundingClientRect().height, true); };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
    h.addEventListener('dblclick', () => apply(clampH(S.timeline ? S.timeline.fitHeight() : 150), true));
    window.addEventListener('resize', () => { const cur = wrap.getBoundingClientRect().height; if (cur > window.innerHeight * 0.62) apply(clampH(window.innerHeight * 0.6), false); });
  }

  function init() {
    // the timeline is drawn on a canvas, so it must be re-measured once the typefaces have loaded
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (S.timeline && S.cams.length) S.timeline.setCams(S.cams); });
    initWelcome();
    initTransport();
    initResizer();
    $$('#tabs button').forEach((b) => { b.onclick = () => selectTab(b.dataset.tab); });
    renderTitlebar();
    window.BCS.app = { S, openFolder, setMode, selectTab, selectCam, runBenchmark, hms, toast };
    window.BCS.ctx = { S, hms, toast, debounce, selectCam, renderPanel, ctab };
    if (bcs.autotest) window.BCS.autotestReady = true;
  }
  init();
})();
