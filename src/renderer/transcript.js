'use strict';
// Transcript tab: merged speech from every camera, speaker labels, search, and the reviewer's edit layer.
//
// Integrity model: the machine transcript (and the machine speaker detection) are never modified.
// Everything the reviewer does -- renaming voices, reassigning speakers, correcting words, splitting or
// deleting lines -- is stored separately (review.json) with a history, and can be reverted line by line.
(function () {
  const bcs = window.bcs;
  const C = () => window.BCS.ctx;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PALETTE = ['#ff9f7a', '#7ad1ff', '#b6e36b', '#ffcf5c', '#d99bff', '#6ee7c8', '#ff8fb1', '#9aa7ff', '#e0b48a', '#8fd6a8'];
  const emptyReview = () => ({ version: 1, people: [], clusters: {}, lines: {}, log: [], base: {}, dismissed: [] });
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

  const TR = {
    status: null, spkStatus: null, data: { tracks: [] }, spk: {}, review: emptyReview(), stale: new Set(),
    lines: [], vis: [], q: '', hideRepeats: true, off: new Set(), follow: true, showDeleted: false, peopleOpen: false,
    running: false, progress: {}, overall: 0, model: null, error: '',
    spkRun: { running: false, overall: 0, progress: {} }, spkModel: null, spkError: '',
    editing: null, _now: -1, lastScroll: 0, matchCount: 0, sel: new Set(), lastSelIdx: null, _batch: null,
  };

  // ---------- helpers ----------
  const gkey = (gid, track) => `${gid}_${track}`;
  const lineT = (l) => l.cam.start + l.local;
  const markRe = (q) => new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  const personById = (id) => TR.review.people.find((p) => p.id === id) || null;
  const virtuals = new Map();
  function virtualPerson(gk, c) {
    const id = `auto:${gk}:${c}`;
    let v = virtuals.get(id);
    if (!v) { v = { id, auto: true, gk, c, name: '', label: c < 0 ? 'Other voices' : `Speaker ${c + 1}`, color: c < 0 ? '#6b737e' : PALETTE[(hash(gk) + c) % PALETTE.length] }; virtuals.set(id, v); }
    return v;
  }
  const displayName = (p) => (p ? (p.name || p.label || 'Speaker') : 'Unassigned');

  function resolvePerson(l) {
    if (l.override !== undefined) return l.override === null ? null : (personById(l.override) || null);
    if (l.cluster == null) return null;
    const map = TR.review.clusters[l.gk] || {};
    if (Object.prototype.hasOwnProperty.call(map, l.cluster)) {
      const m = map[l.cluster];
      if (m === null) return null;
      return personById(m) || virtualPerson(l.gk, l.cluster);
    }
    return virtualPerson(l.gk, l.cluster);
  }

  const STOP = new Set('the a an and or of to in on is it that this was for with as at be you i we he she they are not but if so do did have has had your my me can will just um uh'.split(' '));
  const toks = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
  function similar(a, b) {
    if (!a.size || !b.size) return false;
    let inter = 0; for (const x of a) if (b.has(x)) inter++;
    return inter / Math.min(a.size, b.size) >= 0.6 && inter >= 2;
  }

  // which detected voice overlaps a transcript segment the most
  function clusterFor(sp, s, e) {
    if (!sp || !sp.segments) return null;
    const acc = new Map();
    for (const d of sp.segments) {
      if (d.e <= s) continue;
      if (d.s >= e) break;
      const ov = Math.min(e, d.e) - Math.max(s, d.s);
      if (ov > 0) acc.set(d.c, (acc.get(d.c) || 0) + ov);
    }
    let best = null, bv = 0;
    for (const [c, v] of acc) if (v > bv) { bv = v; best = c; }
    return bv >= Math.min(0.5, (e - s) * 0.3) ? best : null;
  }

  // ---------- review persistence ----------
  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { const S = C().S; if (S.project) bcs.invoke('review:save', S.project.id, TR.review); }, 300);
  }
  function stamp(key) { const gk = key.replace(/_\d+$/, ''); const t = TR.data.tracks.find((x) => gkey(x.groupId, x.track) === gk); if (t && t.key) TR.review.base[gk] = t.key; }

  // ---------- loading ----------
  function reset() {
    const S = C().S;
    TR.sel.clear(); TR.lastSelIdx = null;
    TR.off.clear(); TR.q = ''; TR.progress = {}; TR.running = false; TR.error = ''; TR.editing = null; TR._now = -1;
    TR.spkRun = { running: false, overall: 0, progress: {} }; TR.spkError = ''; TR.review = emptyReview(); TR.spk = {}; TR.stale.clear();
    virtuals.clear(); closeMenu();
    S.tr = TR;
  }

  async function load() {
    const S = C().S;
    if (!S.project) return;
    TR.status = await bcs.invoke('transcript:status');
    TR.data = await bcs.invoke('transcript:get', S.project.id);
    TR.spkStatus = await bcs.invoke('speakers:status');
    TR.spk = await bcs.invoke('speakers:get', S.project.id);
    TR.review = Object.assign(emptyReview(), await bcs.invoke('review:get', S.project.id));
    TR.running = !!TR.data.running || TR.running;
    TR.stale.clear();
    for (const t of TR.data.tracks) { const gk = gkey(t.groupId, t.track); const b = TR.review.base[gk]; if (b && t.key && b !== t.key) TR.stale.add(gk); }
    buildLines();
  }

  // ---------- building the visible list ----------
  function buildLines() {
    const S = C().S;
    const lines = [];
    for (const tr of TR.data.tracks || []) {
      const cam = S.cams.find((c) => c.id === tr.groupId); if (!cam) continue;
      const tk = cam.group.tracks.find((t) => t.index === tr.track);
      const gk = gkey(tr.groupId, tr.track);
      const sp = TR.spk[gk];
      const stale = TR.stale.has(gk);
      tr.segments.forEach((s, idx) => {
        const key = `${gk}_${idx}`;
        const ed = stale ? null : (TR.review.lines[key] || null);
        const cluster = clusterFor(sp, s.s, s.e);
        const base = { key, seg: idx, camId: cam.id, track: tr.track, mic: tk ? tk.friendly : '', cam, gk, cluster, conf: s.conf, machine: s.text, ed };
        if (ed && ed.parts) {
          ed.parts.forEach((p, pi) => {
            if (p.deleted && !TR.showDeleted) return;
            const t0 = p.t0 || 0;
            const next = ed.parts.slice(pi + 1).find((q) => !q.deleted);
            const t1 = next ? next.t0 : 1;
            lines.push({ ...base, part: pi, split: true, local: s.s + (s.e - s.s) * t0, len: (s.e - s.s) * (t1 - t0), text: p.text, w: null, edited: true, deleted: !!p.deleted, override: p.person, noMerge: true });
          });
          return;
        }
        if (ed && ed.deleted && !TR.showDeleted) return;
        const edited = !!(ed && ed.text != null && ed.text !== s.text);
        lines.push({ ...base, local: s.s, len: s.e - s.s, text: edited ? ed.text : s.text, w: edited ? null : s.w, edited, deleted: !!(ed && ed.deleted), override: ed && ed.person !== undefined ? ed.person : undefined, noMerge: edited || !!(ed && (ed.deleted || ed.person !== undefined)) });
      });
    }
    for (const l of lines) { l.person = resolvePerson(l); l.alts = []; l.toks = toks(l.text); }
    lines.sort((a, b) => lineT(a) - lineT(b));
    TR.allLines = lines; // every line, before repeats are folded (used to match voices across cameras)

    // fold the same utterance heard on several microphones into one line (best-heard version shown)
    const groups = [];
    for (const l of lines) {
      let home = null;
      if (TR.hideRepeats && !l.noMerge) {
        for (let i = groups.length - 1; i >= 0 && lineT(l) - lineT(groups[i][0]) < 6; i--) {
          const g = groups[i], k = g[0];
          if (k.noMerge) continue;
          if (g.some((x) => x.camId === l.camId && x.track === l.track)) continue;
          if (similar(k.toks, l.toks)) { home = g; break; }
        }
      }
      if (home) home.push(l); else groups.push([l]);
    }
    const kept = [];
    for (const g of groups) {
      let rep = g[0];
      for (const x of g) if (x.conf * x.text.length > rep.conf * rep.text.length * 1.15) rep = x;
      rep.alts = g.filter((x) => x !== rep);
      kept.push(rep);
    }
    kept.sort((a, b) => lineT(a) - lineT(b));
    kept.forEach((l, k) => { l.n = k + 1; }); // running line numbers, like a pleading page
    TR.lines = kept;
    if (window.BCS.captions) setTimeout(() => window.BCS.captions.update(), 0); // on-screen captions follow edits
  }

  // ---------- one line ----------
  const LINES_PER_PAGE = 25;
  const pageOf = (l) => Math.ceil(l.n / LINES_PER_PAGE);
  const lineOnPage = (l) => ((l.n - 1) % LINES_PER_PAGE) + 1;

  function lineHtml(l, i) {
    const editing = TR.editing === l.key + (l.part != null ? '#' + l.part : '');
    let body;
    if (editing) {
      body = `<textarea class="tl-edit" rows="3" spellcheck="true">${esc(l.text)}</textarea>
        <div class="tl-edit-bar"><button class="btn small primary" data-act="save">Save</button><button class="btn small ghost" data-act="cancel">Cancel</button><span class="grow"></span>
        <button class="btn small ghost" data-act="split" title="Split into two lines at the cursor">Split here</button>
        <button class="btn small ghost" data-act="delete">${l.deleted ? 'Restore' : 'Delete'}</button>
        ${l.edited && !l.split ? '<button class="btn small ghost" data-act="revert" title="Go back to the machine text">Revert</button>' : ''}${l.split ? '<button class="btn small ghost" data-act="unsplit" title="Rejoin the split line">Unsplit</button>' : ''}</div>`;
    } else {
      const words = (l.w && l.w.length ? l.w : [[l.text, 1]]).map(([w, p]) => {
        let h = esc(w);
        if (TR.q) h = h.replace(markRe(esc(TR.q)), '<mark>$1</mark>');
        return p < 0.45 ? `<span class="lowc" title="Low confidence">${h}</span>` : h;
      }).join(' ');
      body = `<div class="tl-text" title="Double-click to edit">${words}</div>`;
    }
    const p = l.person;
    const chipLabel = p ? displayName(p) : (l.cluster == null && !Object.keys(TR.spk).length ? '' : 'Unassigned');
    const chip = (chipLabel || Object.keys(TR.spk).length)
      ? `<button class="spk-chip ${p ? '' : 'none'} ${p && p.auto ? 'auto' : ''}" style="--sp:${p ? p.color : '#6b737e'}" data-act="speaker" title="${p && p.auto ? 'Detected voice, not named yet. Click to name or change' : 'Change speaker'}"><i></i>${esc(chipLabel)}<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m2 3.8 3 3 3-3"/></svg></button>` : '';
    const alts = l.alts.length ? `<span class="alts" title="Also picked up by: ${esc(l.alts.map((a) => a.cam.shortLabel + (a.mic ? ' (' + a.mic + ')' : '')).join(', '))}">+${l.alts.length}</span>` : '';
    const tag = l.deleted ? '<span class="edtag del">Deleted</span>' : l.edited ? `<span class="edtag" title="Machine text: ${esc(l.machine)}">Edited</span>` : '';
    return `<div class="tl ${l.deleted ? 'deleted' : ''} ${editing ? 'editing' : ''} ${TR.sel.has(editKeyOf(l)) ? 'sel' : ''}" data-i="${i}">
      <span class="tl-num" title="Page ${pageOf(l)}, line ${lineOnPage(l)}">${l.n}</span>
      <button class="tl-time mono" title="Jump here">${C().hms(Math.max(0, lineT(l)))}</button>
      <div class="tl-meta">${chip}<span class="cam">${C().ctab(l.cam, true)}${esc(l.cam.shortLabel)}${l.mic ? ` <em>${esc(l.mic)}</em>` : ''}</span>${tag}${alts}${editing ? '' : '<button class="pen" data-act="edit" title="Edit this line">✎</button>'}</div>
      ${body}</div>`;
  }

  function visibleLines() {
    const q = TR.q.trim().toLowerCase();
    return TR.lines.filter((l) => !TR.off.has(l.camId) && (!q || l.text.toLowerCase().includes(q) || displayName(l.person).toLowerCase().includes(q)));
  }

  function fillList() {
    const box = $('#tr-list'); if (!box) return;
    const S = C().S;
    const vis = visibleLines();
    TR.vis = vis; TR.matchCount = vis.length;
    if (!TR.lines.length) { box.innerHTML = ''; S.timeline && S.timeline.setMarks([]); return; }
    let lastPage = 0;
    box.innerHTML = vis.length ? vis.map((l, i) => { const pg = pageOf(l); const mark = pg !== lastPage ? `<div class="tl-page">Page ${pg}</div>` : ''; lastPage = pg; return mark + lineHtml(l, i); }).join('') : `<div class="hint" style="padding:18px 2px 18px 58px">No matches.</div>`;
    const cnt = $('#tr-count'); if (cnt) cnt.textContent = TR.q ? `${vis.length} match${vis.length === 1 ? '' : 'es'}` : `${vis.length} lines`;
    S.timeline && S.timeline.setMarks(TR.q ? vis.map(lineT) : []);
    TR._now = -2; markNow(true);
    const ta = $('.tl-edit', box); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); autosize(ta); }
  }
  const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px'; };

  function markNow(scroll) {
    const box = $('#tr-list'); if (!box || !TR.vis) return;
    const S = C().S;
    const T = S.engine.T + 0.15;
    let lo = 0, hi = TR.vis.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (lineT(TR.vis[mid]) <= T) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx >= 0 && T - lineT(TR.vis[idx]) > Math.max(4, TR.vis[idx].len + 2)) idx = -1;
    if (TR._now === idx && !scroll) return;
    const prev = box.querySelector('.tl.now'); if (prev) prev.classList.remove('now');
    TR._now = idx;
    if (idx < 0) return;
    const el = box.querySelector(`.tl[data-i="${idx}"]`);
    if (!el) return;
    el.classList.add('now');
    if (TR.follow && S.tab === 'transcript' && !TR.editing && Date.now() - TR.lastScroll > 4000) {
      const p = $('#panel'); const r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
      if (r.top < pr.top + 120 || r.bottom > pr.bottom - 40) p.scrollTop += r.top - pr.top - 150;
    }
  }

  function jumpTo(l) {
    const S = C().S;
    // Speech-to-text timestamps are good to about a second; start a little early so no words are missed.
    S.engine.seek(Math.max(0, lineT(l) - 1.0), { precise: true });
    C().selectCam(l.camId);
  }

  // ---------- editing ----------
  function snapshot(key) { return TR.review.lines[key] ? JSON.parse(JSON.stringify(TR.review.lines[key])) : null; }

  function logEdit(l, kind, from, to, prev) {
    TR.review.log.push({ at: Date.now(), key: l.key, kind, t: Math.round(lineT(l) * 10) / 10, cam: l.cam.shortLabel, from: from == null ? '' : String(from), to: to == null ? '' : String(to), prev, batch: TR._batch || undefined });
    if (TR.review.log.length > 3000) TR.review.log.splice(0, TR.review.log.length - 3000);
  }

  // Apply a change to the target of a line (the whole segment, or one part of a split segment).
  function mutate(l, kind, from, to, fn, defer = false) {
    const prev = snapshot(l.key);
    stamp(l.key);
    let ed = TR.review.lines[l.key] ? { ...TR.review.lines[l.key] } : {};
    if (ed.parts) ed.parts = ed.parts.map((p) => ({ ...p }));
    const target = l.part != null ? ed.parts[l.part] : ed;
    fn(target, ed);
    const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; };
    clean(ed); if (ed.parts) ed.parts.forEach(clean);
    if (!Object.keys(ed).length) delete TR.review.lines[l.key]; else TR.review.lines[l.key] = ed;
    logEdit(l, kind, from, to, prev);
    if (!defer) { persist(); afterChange(); }
  }

  function afterChange() { buildLines(); fillList(); fillPeople(); }

  function saveText(l, text) {
    text = text.replace(/\s+/g, ' ').trim();
    if (text === l.text) return;
    if (!text) return mutate(l, 'delete', l.text, '', (t) => { t.deleted = true; });
    mutate(l, 'text', l.text, text, (t, ed) => {
      if (l.part != null) t.text = text;
      else if (text === l.machine) delete t.text; else t.text = text;
    });
  }
  function setPerson(l, personId) { // personId: string | null (unassigned) | undefined (back to detected voice)
    const was = displayName(l.person);
    mutate(l, 'speaker', was, personId === undefined ? '(detected voice)' : displayName(personId === null ? null : personById(personId)), (t) => { t.person = personId; });
  }
  function setCluster(gk, c, personId, line) {
    const prev = JSON.stringify(TR.review.clusters[gk] || {});
    TR.review.clusters[gk] = { ...(TR.review.clusters[gk] || {}), [c]: personId };
    TR.review.log.push({ at: Date.now(), key: gk + '*', kind: 'voice', t: line ? Math.round(lineT(line) * 10) / 10 : 0, cam: line ? line.cam.shortLabel : '', from: '', to: personId ? displayName(personById(personId)) : 'Unassigned', prevClusters: prev, gk, batch: TR._batch || undefined });
    persist(); afterChange();
  }
  function splitLine(l, text, cursor) {
    const a = text.slice(0, cursor).trim(), b = text.slice(cursor).trim();
    if (!a || !b) { C().toast('Put the cursor between two words to split.'); return false; }
    const frac = Math.min(0.95, Math.max(0.05, cursor / Math.max(1, text.length)));
    mutate(l, 'split', l.text, `${a} | ${b}`, (t, ed) => {
      const personId = l.override !== undefined ? l.override : (l.person && !l.person.auto ? l.person.id : undefined);
      if (l.part != null) {
        const cur = ed.parts[l.part];
        const t0 = cur.t0 || 0;
        const next = ed.parts.slice(l.part + 1).find((q) => !q.deleted);
        const t1 = next ? next.t0 : 1;
        const mid = t0 + (t1 - t0) * frac;
        cur.text = a;
        ed.parts.splice(l.part + 1, 0, { text: b, t0: mid, person: cur.person });
      } else {
        delete ed.text; delete ed.person; delete ed.deleted;
        ed.parts = [{ text: a, t0: 0, person: personId }, { text: b, t0: frac, person: personId }];
      }
    });
    return true;
  }
  function revertLine(l) { mutate(l, 'revert', l.text, l.machine, (t) => { delete t.text; }); }
  function unsplit(l) {
    const prev = snapshot(l.key);
    delete TR.review.lines[l.key];
    logEdit(l, 'unsplit', '', '', prev);
    persist(); afterChange();
  }
  function deleteLine(l) { mutate(l, l.deleted ? 'restore' : 'delete', l.text, '', (t) => { t.deleted = l.deleted ? undefined : true; }); }

  // With a target (the entry a notice's Undo button belongs to), only that change is undone; if newer
  // changes have been made since, or another case is open, say so instead of undoing something else.
  function undoLast(target) {
    const log = TR.review.log;
    const undoable = (x) => x.kind === 'voice' || x.kind === 'merge' && x.snap || (x.prev !== undefined && x.key);
    let i = log.length - 1;
    while (i >= 0 && !undoable(log[i])) i--;
    if (i < 0) { C().toast('Nothing to undo'); return false; }
    if (target && target.kind !== undefined && log[i] !== target && !(target.batch && log[i].batch === target.batch)) {
      C().toast('You have made newer changes since. Use Undo in the transcript panel to step back one change at a time.', 6000);
      return false;
    }
    // a bulk change (many lines, or a matched pair of voices) is undone as one step
    const e = log[i];
    const group = e.batch ? log.filter((x) => x.batch === e.batch && undoable(x)) : [e];
    for (let j = group.length - 1; j >= 0; j--) {
      const x = group[j];
      log.splice(log.indexOf(x), 1);
      if (x.kind === 'merge') {
        const sn = x.snap;
        if (!TR.review.people.some((p) => p.id === sn.person.id)) TR.review.people.splice(Math.min(sn.at, TR.review.people.length), 0, sn.person);
        for (const [gk, c] of sn.clusters) if (TR.review.clusters[gk]) TR.review.clusters[gk][c] = sn.person.id;
        for (const [key, ed] of sn.lines) TR.review.lines[key] = ed;
      } else if (x.kind === 'voice') TR.review.clusters[x.gk] = JSON.parse(x.prevClusters);
      else if (x.prev === null) delete TR.review.lines[x.key];
      else TR.review.lines[x.key] = x.prev;
    }
    prunePeople(group.map((x) => x.createdPerson).filter(Boolean));
    persist(); afterChange();
    C().toast(group.length > 1 ? `Undid the last change (${group.length} items)` : 'Undid the last change');
    return true;
  }

  // people the app created for a match ("Unnamed person N") disappear again if nothing uses them
  function prunePeople(createdIds = []) {
    const used = new Set();
    for (const m of Object.values(TR.review.clusters)) for (const v of Object.values(m)) if (v) used.add(v);
    for (const ed of Object.values(TR.review.lines)) { if (ed.person) used.add(ed.person); (ed.parts || []).forEach((p) => { if (p.person) used.add(p.person); }); }
    TR.review.people = TR.review.people.filter((p) => used.has(p.id) || !(createdIds.includes(p.id) || /^Unnamed person \d+$/.test(p.name)));
  }

  // ---------- selecting several lines ----------
  const editKeyOf = (l) => l.key + (l.part != null ? '#' + l.part : '');
  function selectedLines() { return TR.lines.filter((l) => TR.sel.has(editKeyOf(l))); }
  function refreshSel() {
    $$('#tr-list .tl').forEach((row) => { const l = TR.vis[parseInt(row.dataset.i, 10)]; row.classList.toggle('sel', !!l && TR.sel.has(editKeyOf(l))); });
    const bar = $('#tr-selbar'); if (!bar) return;
    const n = selectedLines().length;
    bar.hidden = n === 0;
    const c = $('#tr-selcount', bar); if (c) c.textContent = `${n} line${n === 1 ? '' : 's'} selected`;
  }
  function toggleSel(l, i) { const k = editKeyOf(l); if (TR.sel.has(k)) TR.sel.delete(k); else TR.sel.add(k); TR.lastSelIdx = i; refreshSel(); }
  function rangeSel(i) {
    const a = Math.min(TR.lastSelIdx, i), b = Math.max(TR.lastSelIdx, i);
    for (let j = a; j <= b; j++) if (TR.vis[j]) TR.sel.add(editKeyOf(TR.vis[j]));
    TR.lastSelIdx = i; refreshSel();
  }
  function clearSel() { TR.sel.clear(); TR.lastSelIdx = null; refreshSel(); }
  function bulk(kind, perLine) {
    const lines = selectedLines(); if (!lines.length) return;
    TR._batch = 'b' + Date.now().toString(36);
    for (const l of lines) perLine(l);
    TR._batch = null;
    TR.sel.clear(); TR.lastSelIdx = null;
    persist(); afterChange(); refreshSel();
    C().toast(`${kind} ${lines.length} line${lines.length === 1 ? '' : 's'} · ${window.BCS_KEYS.mod}Z to undo`);
  }
  function bulkAssign(personId) {
    bulk('Reassigned', (l) => mutate(l, 'speaker', displayName(l.person), personId === undefined ? '(detected voice)' : displayName(personId === null ? null : personById(personId)), (t) => { t.person = personId; }, true));
  }
  function bulkDelete() { bulk('Deleted', (l) => { if (!l.deleted) mutate(l, 'delete', l.text, '', (t) => { t.deleted = true; }, true); }); }

  // ---------- speaker menu ----------
  function closeMenu() { const m = $('#spk-menu'); if (m) m.remove(); document.removeEventListener('mousedown', onDocDown, true); }
  function onDocDown(e) { const m = $('#spk-menu'); if (m && !m.contains(e.target)) closeMenu(); }

  function openMenu(l, anchor, bulkMode = false) {
    closeMenu();
    const m = document.createElement('div');
    m.id = 'spk-menu'; m.className = 'menu';
    const canVoice = !bulkMode && l.cluster != null;
    const counts = new Map();
    for (const x of TR.lines) if (x.person) counts.set(x.person.id, (counts.get(x.person.id) || 0) + 1);
    const items = TR.review.people.map((p) => `<button class="mi" data-pid="${p.id}"><i style="background:${p.color}"></i><span>${esc(p.name)}</span><em>${counts.get(p.id) || 0}</em></button>`).join('');
    m.innerHTML = `<div class="mh">${bulkMode ? `Assign ${selectedLines().length} lines to…` : 'Who is speaking?'}</div>${items ? `<div class="ml">${items}</div>` : ''}
      <button class="mi" data-pid="__none"><i style="background:#6b737e"></i><span>Unassigned</span></button>
      <div class="mnew"><input id="mnew" placeholder="Name a new person…" spellcheck="false"><button class="btn small" data-new>Add</button></div>
      ${canVoice ? `<label class="mchk"><input type="checkbox" id="mall"> <span>Apply to every line from this voice on ${esc(l.cam.shortLabel)}</span></label>` : ''}
      ${bulkMode ? '<button class="mi sub" data-pid="__detected">Use the detected voices again</button>' : (l.override !== undefined && canVoice ? '<button class="mi sub" data-pid="__detected">Use the detected voice again</button>' : '')}`;
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const mw = 260;
    m.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.left)) + 'px';
    const below = r.bottom + 6, mh = m.offsetHeight;
    m.style.top = (below + mh > window.innerHeight - 8 ? Math.max(8, r.top - mh - 6) : below) + 'px';
    const choose = (pid) => {
      const all = $('#mall') && $('#mall').checked;
      closeMenu();
      const target = pid === '__none' ? null : pid;
      if (bulkMode) return bulkAssign(pid === '__detected' ? undefined : target);
      if (pid === '__detected') return setPerson(l, undefined);
      if (all && l.cluster != null) { if (l.override !== undefined) setPerson(l, undefined); setCluster(l.gk, l.cluster, target, l); }
      else setPerson(l, target);
    };
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pid]'); if (b) return choose(b.dataset.pid);
      if (e.target.closest('[data-new]')) addFromInput();
    });
    const addFromInput = () => {
      const v = $('#mnew', m).value.trim(); if (!v) return;
      let p = TR.review.people.find((x) => x.name.toLowerCase() === v.toLowerCase());
      if (!p) { p = { id: newId(), name: v, color: PALETTE[TR.review.people.length % PALETTE.length] }; TR.review.people.push(p); persist(); }
      choose(p.id);
    };
    $('#mnew', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFromInput(); } if (e.key === 'Escape') closeMenu(); e.stopPropagation(); });
    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
    setTimeout(() => $('#mnew', m) && $('#mnew', m).focus(), 30);
  }

  // ---------- people panel ----------
  function voiceRows() {
    const S = C().S;
    const rows = [];
    for (const [gk, sp] of Object.entries(TR.spk)) {
      const [gid, track] = [gk.slice(0, gk.lastIndexOf('_')), Number(gk.slice(gk.lastIndexOf('_') + 1))];
      const cam = S.cams.find((c) => c.id === gid); if (!cam) continue;
      const tk = cam.group.tracks.find((t) => t.index === track);
      const loudest = sp.clusters.filter((c) => c.c >= 0).sort((a, b) => b.rms - a.rms)[0];
      for (const cl of sp.clusters) {
        const person = (() => { const map = TR.review.clusters[gk] || {}; if (Object.prototype.hasOwnProperty.call(map, cl.c)) return map[cl.c] === null ? null : (personById(map[cl.c]) || virtualPerson(gk, cl.c)); return virtualPerson(gk, cl.c); })();
        const lineCount = TR.lines.filter((x) => x.gk === gk && x.cluster === cl.c).length;
        if (!lineCount && cl.c < 0) continue;
        const wearer = cam.group.kind === 'bwc' || (tk && /officer/i.test(tk.friendly));
        rows.push({ gk, cam, tk, cl, person, lineCount });
      }
    }
    // the voices that talk the most first; "other voices" last
    rows.sort((a, b) => ((a.cl.c < 0) - (b.cl.c < 0)) || (b.cl.sec - a.cl.sec));
    return rows;
  }

  // ---------- matching voices across cameras ----------
  // The same sentence heard on two cameras at the same moment was almost certainly said by one person,
  // so the voice that said it on each camera is probably the same. This uses the synchronized timeline.
  const parseNode = (n) => { const i = n.lastIndexOf(':'); return [n.slice(0, i), Number(n.slice(i + 1))]; };
  function realPersonOf(gk, c) { const m = TR.review.clusters[gk] || {}; return Object.prototype.hasOwnProperty.call(m, c) && m[c] ? personById(m[c]) : null; }
  function nodeLabel(n) {
    const S = C().S;
    const [gk, c] = parseNode(n);
    const gid = gk.slice(0, gk.lastIndexOf('_')), track = Number(gk.slice(gk.lastIndexOf('_') + 1));
    const cam = S.cams.find((x) => x.id === gid);
    const tk = cam && cam.group.tracks.find((t) => t.index === track);
    const who = realPersonOf(gk, c);
    return { text: who ? who.name : 'Speaker ' + (c + 1), cam: cam ? cam.shortLabel + (tk && track > 0 ? ' · ' + tk.friendly : '') : '', color: who ? who.color : virtualPerson(gk, c).color };
  }

  function matchSuggestions() {
    const L = TR.allLines || [];
    const key = (l) => `${l.gk}:${l.cluster}`;
    const ev = new Map(), example = new Map(), heard = new Set();
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      if (a.cluster == null || a.cluster < 0 || a.deleted) continue;
      for (let j = i + 1; j < L.length && lineT(L[j]) - lineT(a) < 6; j++) {
        const b = L[j];
        if (b.gk === a.gk || b.cluster == null || b.cluster < 0 || b.deleted) continue;
        if (!similar(a.toks, b.toks)) continue;
        const k = [key(a), key(b)].sort().join('|');
        ev.set(k, (ev.get(k) || 0) + 1);
        if (!example.has(k)) example.set(k, a);
        heard.add(a); heard.add(b);
      }
    }
    const linked = new Map();
    for (const l of heard) linked.set(key(l), (linked.get(key(l)) || 0) + 1);
    const partnerCounts = (n) => [...ev.entries()].filter(([k]) => k.split('|').includes(n)).map(([, v]) => v).sort((x, y) => y - x);
    const out = [];
    for (const [k, c] of ev) {
      if (c < 3 || TR.review.dismissed.includes(k)) continue;
      const [a, b] = k.split('|');
      const support = c / Math.min(linked.get(a), linked.get(b));
      if (support < 0.35) continue;
      const [ga, ca] = parseNode(a), [gb, cb] = parseNode(b);
      const pa = realPersonOf(ga, ca), pb = realPersonOf(gb, cb);
      if (pa && pb && pa.id === pb.id) continue; // already matched
      // a voice with two or more equally strong partners is probably several people lumped together
      const mixed = [a, b].some((n) => partnerCounts(n).filter((v) => v >= 0.6 * c && v >= 3).length > 1);
      out.push({ k, a, b, n: c, support, mixed, strong: c >= 8 && support >= 0.6 && !mixed, example: example.get(k) });
    }
    out.sort((x, y) => (y.strong - x.strong) || (y.n - x.n));
    return out;
  }

  function acceptMatch(s, name) {
    const [ga, ca] = parseNode(s.a), [gb, cb] = parseNode(s.b);
    const pa = realPersonOf(ga, ca), pb = realPersonOf(gb, cb);
    // merging two named people is reversible (Undo in the notice), so no confirmation
    TR._batch = 'm' + Date.now().toString(36);
    try {
      if (pa && pb) { if (pa.id !== pb.id) mergePeople(pb.id, pa.id); }
      else if (pa) setCluster(gb, cb, pa.id);
      else if (pb) setCluster(ga, ca, pb.id);
      else {
        const nm = String(name || '').trim() || `Unnamed person ${TR.review.people.filter((p) => /^Unnamed person \d+$/.test(p.name)).length + 1}`;
        let p = TR.review.people.find((x) => x.name.toLowerCase() === nm.toLowerCase());
        const created = !p;
        if (!p) { p = { id: newId(), name: nm, color: PALETTE[TR.review.people.length % PALETTE.length] }; TR.review.people.push(p); }
        setCluster(ga, ca, p.id); setCluster(gb, cb, p.id);
        // remember that this match created the person, so undoing the match removes them again
        if (created) { const mine = TR.review.log.filter((x) => x.batch === TR._batch); if (mine[0]) mine[0].createdPerson = p.id; }
      }
    } finally { TR._batch = null; }
    const mark = TR.review.log[TR.review.log.length - 1];
    C().toast(pa && pb && pa.id !== pb.id ? `Merged “${pb.name}” into “${pa.name}”` : 'Matched', 8000, mark ? { label: 'Undo', fn: () => undoLast(mark) } : undefined);
  }
  function dismissMatch(s) { TR.review.dismissed.push(s.k); persist(); fillPeople(); }
  function hearMatch(s) {
    const S = C().S, l = s.example; if (!l) return;
    S.engine.seek(Math.max(0, lineT(l) - 1), { precise: true });
    C().selectCam(l.camId);
    S.engine.play();
  }

  function fillPeople() {
    const box = $('#tr-people'); if (!box) return;
    const rows = voiceRows();
    const named = TR.review.people;
    const ms = matchSuggestions();
    const head = $('#tr-people-sum');
    if (head) head.textContent = rows.length ? `${named.length} named · ${rows.filter((r) => r.person && r.person.auto).length} unnamed${ms.length ? ` · ${ms.length} to match` : ''}` : 'No voices yet';
    box.hidden = !TR.peopleOpen;
    if (!TR.peopleOpen) return;
    const personOpts = (selfId) => named.filter((p) => p.id !== selfId).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    let h = '';
    if (ms.length) {
      h += '<div class="pp-title">Possibly the same person</div><div class="hint" style="margin:-2px 0 8px">These voices were heard saying the same words on two cameras at the same moment.</div>';
      for (const s of ms.slice(0, TR.showAllMatches ? 60 : 6)) {
        const A = nodeLabel(s.a), B = nodeLabel(s.b);
        const [ga, ca] = parseNode(s.a), [gb, cb] = parseNode(s.b);
        const neither = !realPersonOf(ga, ca) && !realPersonOf(gb, cb);
        h += `<div class="ms" data-k="${esc(s.k)}">
          <div class="ms-pair"><span class="ms-v"><i style="background:${A.color}"></i><b>${esc(A.text)}</b><em>${esc(A.cam)}</em></span><span class="ms-eq">=</span><span class="ms-v"><i style="background:${B.color}"></i><b>${esc(B.text)}</b><em>${esc(B.cam)}</em></span></div>
          <div class="ms-meta"><span class="badge ${s.strong ? 'good' : 'warn'}">${s.strong ? 'Strong' : 'Possible'}</span><span>heard together on ${s.n} lines${s.mixed ? ' · may be a mix of people' : ''}</span></div>
          <div class="ms-tools">${neither ? '<input class="ms-name" placeholder="Name (optional)" spellcheck="false">' : ''}<button class="btn small primary" data-ms="yes">Same person</button><button class="btn small ghost" data-ms="no">Not the same</button><button class="btn small ghost" data-ms="hear">Hear</button></div></div>`;
      }
      if (ms.length > 6 && !TR.showAllMatches) h += `<button class="linkbtn" id="ms-more" style="margin:4px 0 6px">Show ${ms.length - 6} more</button>`;
    }
    if (named.length) {
      h += '<div class="pp-title">People</div>';
      for (const p of named) {
        const n = TR.lines.filter((x) => x.person && x.person.id === p.id).length;
        h += `<div class="pp" data-pid="${p.id}"><i style="background:${p.color}"></i><input class="pp-name" value="${esc(p.name)}" spellcheck="false" aria-label="Name"><span class="pp-n">${n} line${n === 1 ? '' : 's'}</span>
          ${named.length > 1 ? `<select class="pp-merge" title="Same person as…"><option value="">Merge…</option>${personOpts(p.id)}</select>` : ''}<button class="icon-btn pp-del" title="Remove this person (their lines become unassigned)">×</button></div>`;
      }
    }
    h += '<div class="pp-title">Detected voices</div>';
    if (!rows.length) h += '<div class="hint">Run “Identify speakers” to detect who is talking on each camera.</div>';
    for (const r of rows) {
      const p = r.person;
      const mins = r.cl.sec >= 90 ? Math.round(r.cl.sec / 60) + ' min' : r.cl.sec + ' s';
      h += `<div class="pv" data-gk="${r.gk}" data-c="${r.cl.c}">
        <div class="pv-top"><i style="background:${p ? p.color : '#6b737e'}"></i><span class="pv-name">${esc(p ? displayName(p) : 'Unassigned')}</span><span class="pv-n">${r.lineCount} line${r.lineCount === 1 ? '' : 's'} · ${mins}</span></div>
        <div class="pv-sub">${esc(r.cam.shortLabel)}${r.tk ? ' · ' + esc(r.tk.friendly) : ''}</div>
        <div class="pv-tools">
          <input class="pv-input" placeholder="${p && !p.auto ? esc(p.name) : 'Name this voice'}" spellcheck="false">
          <select class="pv-same" title="Same person as…"><option value="">Same as…</option>${named.map((x) => `<option value="${x.id}" ${p && p.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="__none">Unassigned</option></select>
          <button class="btn small ghost pv-hear" title="Jump to where this voice talks">Hear</button></div>
      </div>`;
    }
    box.innerHTML = h;

    $$('.ms', box).forEach((row) => {
      const s = ms.find((x) => x.k === row.dataset.k); if (!s) return;
      row.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ms]'); if (!b) return;
        const a = b.dataset.ms;
        if (a === 'yes') { const nm = $('.ms-name', row); acceptMatch(s, nm ? nm.value : ''); }
        else if (a === 'no') dismissMatch(s);
        else if (a === 'hear') hearMatch(s);
      });
      const nm = $('.ms-name', row); if (nm) nm.onkeydown = (e) => { if (e.key === 'Enter') acceptMatch(s, nm.value); e.stopPropagation(); };
    });
    const more = $('#ms-more', box); if (more) more.onclick = () => { TR.showAllMatches = true; fillPeople(); };

    $$('.pp', box).forEach((row) => {
      const id = row.dataset.pid;
      const inp = $('.pp-name', row);
      const commit = () => { const p = personById(id); const v = inp.value.trim(); if (p && v && v !== p.name) { p.name = v; persist(); afterChange(); } };
      inp.onchange = commit; inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); };
      const mg = $('.pp-merge', row);
      if (mg) mg.onchange = () => { if (mg.value) mergePeople(id, mg.value); };
      $('.pp-del', row).onclick = () => removePerson(id);
    });
    $$('.pv', box).forEach((row) => {
      const gk = row.dataset.gk, c = Number(row.dataset.c);
      const inp = $('.pv-input', row);
      inp.onkeydown = (e) => { if (e.key === 'Enter') { nameVoice(gk, c, inp.value); } e.stopPropagation(); };
      inp.onchange = () => nameVoice(gk, c, inp.value);
      $('.pv-same', row).onchange = (e) => { const v = e.target.value; if (!v) return; setCluster(gk, c, v === '__none' ? null : v); };
      $('.pv-hear', row).onclick = () => hearVoice(gk, c);
    });
  }

  function nameVoice(gk, c, name) {
    name = String(name || '').trim(); if (!name) return;
    let p = TR.review.people.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!p) { p = { id: newId(), name, color: PALETTE[TR.review.people.length % PALETTE.length] }; TR.review.people.push(p); }
    setCluster(gk, c, p.id);
  }
  function mergePeople(fromId, intoId) {
    const from = personById(fromId), into = personById(intoId); if (!from || !into || fromId === intoId) return;
    const snap = { person: JSON.parse(JSON.stringify(from)), at: TR.review.people.findIndex((p) => p.id === fromId), clusters: [], lines: [] };
    for (const gk of Object.keys(TR.review.clusters)) for (const c of Object.keys(TR.review.clusters[gk])) if (TR.review.clusters[gk][c] === fromId) { snap.clusters.push([gk, c]); TR.review.clusters[gk][c] = intoId; }
    for (const [key, ed] of Object.entries(TR.review.lines)) {
      if (ed.person === fromId || (ed.parts && ed.parts.some((p) => p.person === fromId))) snap.lines.push([key, JSON.parse(JSON.stringify(ed))]);
      if (ed.person === fromId) ed.person = intoId; if (ed.parts) ed.parts.forEach((p) => { if (p.person === fromId) p.person = intoId; });
    }
    TR.review.people = TR.review.people.filter((p) => p.id !== fromId);
    const entry = { at: Date.now(), kind: 'merge', key: '', t: 0, cam: '', from: from.name, to: into.name, snap, batch: TR._batch || undefined };
    TR.review.log.push(entry);
    persist(); afterChange();
    if (!TR._batch) C().toast(`Merged “${from.name}” into “${into.name}”`, 8000, { label: 'Undo', fn: () => undoLast(entry) });
  }
  function removePerson(id) {
    const p = personById(id); if (!p) return;
    for (const gk of Object.keys(TR.review.clusters)) for (const c of Object.keys(TR.review.clusters[gk])) if (TR.review.clusters[gk][c] === id) delete TR.review.clusters[gk][c];
    for (const ed of Object.values(TR.review.lines)) { if (ed.person === id) delete ed.person; if (ed.parts) ed.parts.forEach((q) => { if (q.person === id) delete q.person; }); }
    TR.review.people = TR.review.people.filter((x) => x.id !== id);
    persist(); afterChange();
  }
  function hearVoice(gk, c) {
    const S = C().S;
    const sp = TR.spk[gk]; if (!sp) return;
    const gid = gk.slice(0, gk.lastIndexOf('_'));
    const cam = S.cams.find((x) => x.id === gid); if (!cam) return;
    const segs = sp.segments.filter((s) => s.c === c).sort((a, b) => (b.e - b.s) - (a.e - a.s));
    const seg = segs[0]; if (!seg) return;
    S.engine.seek(Math.max(0, cam.start + seg.s - 0.3), { precise: true });
    C().selectCam(cam.id);
    S.engine.play();
  }

  // ---------- status cards ----------
  function fillStatus() {
    const el = $('#tr-status'); if (!el) return;
    const st = TR.status || {};
    const expected = TR.data.expected || 0, have = (TR.data.tracks || []).length;
    let h = '';
    if (!st.engine) {
      h = `<div class="card"><h4>Transcription isn’t set up yet</h4><p class="hint">The local speech engine isn’t installed on this computer. Nothing is sent anywhere — recognition runs entirely on this computer once it is.</p></div>`;
    } else if (!st.model) {
      const m = TR.model;
      h = `<div class="card"><h4>Download the speech model</h4><p class="hint">One-time download (about ${st.modelSizeMB} MB). After that, transcription works offline and nothing leaves this computer.</p>
        ${m && m.state === 'downloading' ? `<div class="progress"><div style="width:${Math.round(m.pct * 100)}%"></div></div><div class="hint" style="margin-top:8px">${Math.round(m.pct * 100)}%</div>` : `<button class="btn small primary" id="tr-dl">Download model</button>`}
        ${m && m.state === 'error' ? `<p class="hint" style="color:var(--bad);margin-top:8px">${esc(m.error)}</p>` : ''}</div>`;
    } else if (TR.running) {
      const S = C().S;
      const names = Object.values(TR.progress).filter((p) => p.state === 'running').map((p) => { const c = S.cams.find((x) => x.id === p.groupId); return c ? c.shortLabel : ''; }).join(', ');
      h = `<div class="card"><h4>Transcribing…</h4><div class="progress"><div style="width:${Math.round(TR.overall * 100)}%"></div></div>
        <div class="row" style="margin-top:10px"><span class="hint">${Math.round(TR.overall * 100)}% · ${esc(names || 'starting')}${(() => { const d = Object.values(TR.progress).filter((p) => p.state === 'running' && p.device).map((p) => p.device)[0]; return d ? ' · on the ' + esc(d.starting ? d.name : d.gpu ? 'graphics card' : 'processor') : ''; })()}</span><button class="btn small" id="tr-cancel">Stop</button></div>
        <p class="hint" style="margin:8px 0 0">You can keep watching. Finished cameras appear below as they complete.</p></div>`;
    } else if (have < expected) {
      const mins = TR.data.audioMinutes || 0;
      h = `<div class="card"><h4>${have ? 'Finish the transcript' : 'Create a transcript'}</h4><p class="hint">Turns what each camera heard into searchable text on the shared timeline, and works out who is speaking. About ${mins} minutes of audio; ${(() => { const mac = bcs.platform === 'darwin'; const lo = Math.max(2, Math.round(mins / (mac ? 40 : 6))), hi = Math.max(5, Math.round(mins / (mac ? 14 : 2))); return mac ? `usually ${lo}–${hi} minutes on this computer` : st.gpu ? `roughly ${lo}–${hi} minutes on the processor alone, usually less when the graphics card can be used (a rough guess for this computer, not measured)` : `roughly ${lo}–${hi} minutes, depending on your processor (a rough guess for this computer, not measured)`; })()}. Runs locally.</p>
        ${st.gpuFailed ? `<p class="hint" style="margin:0 0 10px">The graphics card could not be used for transcription, so the processor is being used instead.</p>` : ''}
        <button class="btn small primary" id="tr-go">${have ? 'Continue' : 'Generate transcript'}</button>${TR.error ? `<p class="hint" style="color:var(--bad);margin:8px 0 0">${esc(TR.error)}</p>` : ''}</div>`;
    }
    // speaker detection card
    const spkHave = Object.keys(TR.spk).length;
    if (!TR.running && have >= expected && expected > 0 && spkHave < expected) {
      const ss = TR.spkStatus || {};
      if (TR.spkRun.running) {
        h += `<div class="card"><h4>Identifying speakers…</h4><div class="progress"><div style="width:${Math.round(TR.spkRun.overall * 100)}%"></div></div>
          <div class="row" style="margin-top:10px"><span class="hint">${Math.round(TR.spkRun.overall * 100)}%</span><button class="btn small" id="spk-cancel">Stop</button></div></div>`;
      } else if (TR.spkModel && TR.spkModel.state === 'downloading') {
        h += `<div class="card"><h4>Downloading speaker models…</h4><div class="progress"><div style="width:${Math.round(TR.spkModel.pct * 100)}%"></div></div></div>`;
      } else {
        h += `<div class="card"><h4>Identify who is speaking</h4><p class="hint">Detects the different voices on each camera so lines can be labeled by speaker. ${ss.ready ? '' : 'One-time download of two small models (about 70 MB). '}Runs locally. You can name the voices and correct any line afterwards.</p>
          <button class="btn small primary" id="spk-go">${ss.ready ? 'Identify speakers' : 'Download and identify'}</button>${TR.spkError ? `<p class="hint" style="color:var(--bad);margin:8px 0 0">${esc(TR.spkError)}</p>` : ''}</div>`;
      }
    }
    if (TR.stale.size) h += `<div class="card"><h4>Edits not applied</h4><p class="hint">The transcript for ${TR.stale.size} source${TR.stale.size === 1 ? '' : 's'} was regenerated after you edited it, so those edits can’t be matched to the new lines and are hidden. They are still saved.</p></div>`;
    el.innerHTML = h;
    const bind = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    bind('#tr-dl', () => { TR.model = { state: 'downloading', pct: 0 }; bcs.invoke('transcript:downloadModel'); fillStatus(); });
    bind('#tr-go', () => { TR.error = ''; TR.running = true; TR.progress = {}; TR.overall = 0; bcs.invoke('transcript:start', C().S.project.id); fillStatus(); });
    bind('#tr-cancel', () => bcs.invoke('transcript:cancel'));
    bind('#spk-go', startSpeakers);
    bind('#spk-cancel', () => bcs.invoke('speakers:cancel'));
  }

  function startSpeakers() {
    TR.spkError = '';
    const run = () => { TR.spkRun = { running: true, overall: 0, progress: {} }; bcs.invoke('speakers:start', C().S.project.id); fillStatus(); };
    if (TR.spkStatus && TR.spkStatus.ready) return run();
    TR.spkModel = { state: 'downloading', pct: 0 };
    bcs.invoke('speakers:downloadModels');
    TR._afterSpkModel = run;
    fillStatus();
  }

  // ---------- export ----------
  function exportText() {
    const S = C().S, hms = C().hms;
    const out = [];
    const edited = TR.lines.filter((l) => l.edited || l.deleted);
    out.push('TRANSCRIPT — MACHINE-GENERATED, THEN REVIEWED BY A PERSON. Verify every passage against the recording before relying on it.');
    out.push(`Case folder: ${S.project.name}`);
    out.push(`Generated: ${new Date().toLocaleString()}   Model: ${(TR.status && TR.status.modelName) || ''}`);
    out.push('Citations are page:line, 25 lines to a page, numbered in the order shown when repeated lines are combined. Times are on the shared timeline (hh:mm:ss from the start of the earliest camera); each line also gives the camera and its own file time.');
    out.push('Cameras: ' + S.cams.map((c) => `${c.letter} = ${c.shortLabel} (${c.file.name})`).join('; '));
    out.push('Speaker labels come from automatic voice detection and the reviewer’s naming; they are not verified identifications.');
    if (TR.review.people.length) out.push('People named by the reviewer: ' + TR.review.people.map((p) => p.name).join('; '));
    out.push(`Lines edited by the reviewer: ${edited.filter((l) => l.edited).length}; deleted: ${edited.filter((l) => l.deleted).length}. Original machine text for each is listed at the end.`);
    out.push('');
    for (const l of TR.lines) {
      if (l.deleted) continue;
      const also = l.alts.length ? `  [also heard on: ${l.alts.map((a) => a.cam.shortLabel).join(', ')}]` : '';
      const who = l.person ? displayName(l.person) + (l.person.auto ? ' (unnamed voice)' : '') : (Object.keys(TR.spk).length ? 'Unassigned' : '');
      out.push(`${pageOf(l)}:${String(lineOnPage(l)).padStart(2)}  [${hms(Math.max(0, lineT(l)))}] ${who ? who + ' — ' : ''}Camera ${l.cam.letter}, ${l.cam.shortLabel}${l.mic ? ' (' + l.mic + ')' : ''} @ file ${hms(l.local)}: ${l.text}${l.edited ? '  (edited)' : ''}${also}`);
    }
    if (edited.length) {
      out.push(''); out.push('--- REVIEWER EDITS: ORIGINAL MACHINE TEXT ---');
      for (const l of edited) out.push(`${pageOf(l)}:${String(lineOnPage(l)).padStart(2)}  [${hms(Math.max(0, lineT(l)))}] Camera ${l.cam.letter}: ${l.machine}${l.deleted ? '  → DELETED' : l.split ? '  → SPLIT' : ''}`);
    }
    return out.join('\n') + '\n';
  }

  // ---------- history ----------
  function historyHtml() {
    const log = TR.review.log.filter((e) => e.kind !== 'person').slice(-60).reverse();
    if (!log.length) return '<div class="hint">No edits yet.</div>';
    const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const label = { text: 'Edited text', speaker: 'Changed speaker', voice: 'Named a voice', delete: 'Deleted line', restore: 'Restored line', split: 'Split line', unsplit: 'Rejoined line', revert: 'Reverted to machine text', merge: 'Merged people' };
    return log.map((e) => `<div class="hl"><div class="hl-top"><b>${label[e.kind] || e.kind}</b><span>${when(e.at)}</span></div>${e.t ? `<div class="hint">${C().hms(e.t)} · ${esc(e.cam)}</div>` : ''}${e.from || e.to ? `<div class="hl-diff">${e.from ? `<s>${esc(e.from).slice(0, 140)}</s>` : ''}${e.to ? `<span>${esc(e.to).slice(0, 140)}</span>` : ''}</div>` : ''}</div>`).join('');
  }

  // ---------- the panel ----------
  function panel(p) {
    const S = C().S;
    S.tr = TR;
    p.innerHTML = `<div class="tr-head"><div class="section-label">Transcript</div><div class="tr-tools"><label class="follow"><button class="toggle ${TR.follow ? 'on' : ''}" id="tr-follow" aria-label="Follow playback"></button><span>Follow</span></label><button class="btn small ghost" id="tr-undo" title="Undo the last edit (${window.BCS_KEYS.mod}Z)">Undo</button><button class="btn small ghost" id="tr-export" ${TR.lines.length ? '' : 'disabled'}>Export…</button></div></div>
      <div id="tr-status"></div>
      <div class="tr-controls" ${TR.lines.length ? '' : 'hidden'}>
        <input id="tr-q" class="search" type="search" placeholder="Search words or speakers" value="${esc(TR.q)}" spellcheck="false">
        <div class="tr-chips">${S.cams.filter((c) => (TR.data.tracks || []).some((t) => t.groupId === c.id)).map((c) => `<button class="chipbtn ${TR.off.has(c.id) ? '' : 'on'}" data-cam="${c.id}" style="--cam:${c.color}">${C().ctab(c, true)}${esc(c.shortLabel)}</button>`).join('')}</div>
        <div class="row"><span class="hint" id="tr-count"></span><label class="follow"><button class="toggle ${TR.hideRepeats ? 'on' : ''}" id="tr-rep" aria-label="Combine repeats"></button><span>Combine repeats</span></label></div>
        <button class="people-bar" id="tr-people-btn"><span>People</span><span class="hint" id="tr-people-sum"></span><span class="chev ${TR.peopleOpen ? 'open' : ''}">›</span></button>
        <div id="tr-people" class="people" hidden></div>
      </div>
      <div id="tr-list" class="tr-list"></div>
      <div id="tr-selbar" class="selbar" hidden><span id="tr-selcount"></span><span class="grow"></span><button class="btn small" id="sel-assign">Assign speaker…</button><button class="btn small ghost" id="sel-delete">Delete</button><button class="btn small ghost" id="sel-clear">Clear</button></div>
      ${TR.lines.length ? `<div class="tr-foot"><div class="row"><label class="follow"><button class="toggle ${TR.showDeleted ? 'on' : ''}" id="tr-deleted" aria-label="Show deleted lines"></button><span>Show deleted lines</span></label><button class="linkbtn" id="tr-hist">Edit history</button></div>
        <div id="tr-history" class="history" hidden></div>
        <div class="hint" style="margin-top:10px">Machine-generated and imperfect, especially in noise. Faded words are low-confidence. Double-click any line to correct it. ${window.BCS_KEYS.mod === '⌘' ? '⌘' : 'Ctrl'}-click or Shift-click lines to select several, then reassign them together. Your corrections are kept separately and the original text is never overwritten. Always check against the audio.</div></div>` : ''}`;
    fillStatus(); fillList(); fillPeople(); refreshSel();
    $('#sel-assign').onclick = (e) => openMenu(null, e.currentTarget, true);
    $('#sel-delete').onclick = bulkDelete;
    $('#sel-clear').onclick = clearSel;
    $('#tr-follow').onclick = () => { TR.follow = !TR.follow; $('#tr-follow').classList.toggle('on', TR.follow); markNow(true); };
    $('#tr-undo').onclick = () => undoLast();
    $('#tr-export').onclick = async () => { const f = await bcs.invoke('transcript:export', `Transcript - ${S.project.name}.txt`, exportText()); if (f) C().toast('Transcript saved'); };
    const q = $('#tr-q'); if (q) q.oninput = C().debounce(() => { TR.q = q.value; fillList(); }, 160);
    $$('.chipbtn', p).forEach((b) => { b.onclick = () => { const id = b.dataset.cam; TR.off.has(id) ? TR.off.delete(id) : TR.off.add(id); b.classList.toggle('on', !TR.off.has(id)); fillList(); }; });
    $('#tr-rep').onclick = () => { TR.hideRepeats = !TR.hideRepeats; $('#tr-rep').classList.toggle('on', TR.hideRepeats); buildLines(); fillList(); };
    const pb = $('#tr-people-btn'); if (pb) pb.onclick = () => { TR.peopleOpen = !TR.peopleOpen; $('.chev', pb).classList.toggle('open', TR.peopleOpen); fillPeople(); };
    const dl = $('#tr-deleted'); if (dl) dl.onclick = () => { TR.showDeleted = !TR.showDeleted; dl.classList.toggle('on', TR.showDeleted); buildLines(); fillList(); };
    const hb = $('#tr-hist'); if (hb) hb.onclick = () => { const h = $('#tr-history'); h.hidden = !h.hidden; if (!h.hidden) h.innerHTML = historyHtml(); };

    const list = $('#tr-list');
    list.onclick = (e) => {
      const row = e.target.closest('.tl'); if (!row) return;
      const l = TR.vis[parseInt(row.dataset.i, 10)]; if (!l) return;
      const act = e.target.closest('[data-act]');
      const idx = parseInt(row.dataset.i, 10);
      if (!act && !TR.editing && !e.target.closest('.tl-edit')) {
        if (e.metaKey || e.ctrlKey) { toggleSel(l, idx); return; }
        if (e.shiftKey) { if (TR.lastSelIdx == null) toggleSel(l, idx); else rangeSel(idx); return; }
      }
      if (act) {
        const a = act.dataset.act;
        if (a === 'speaker') return openMenu(l, act);
        if (a === 'edit') return startEdit(l);
        const ta = $('.tl-edit', row);
        if (a === 'save') { finishEdit(l, ta.value); return; }
        if (a === 'cancel') { cancelEdit(); return; }
        if (a === 'split') { const idx = ta.selectionStart; const text = ta.value; if (splitLine(l, text, idx)) TR.editing = null; return; }
        if (a === 'delete') { TR.editing = null; deleteLine(l); return; }
        if (a === 'revert') { TR.editing = null; revertLine(l); return; }
        if (a === 'unsplit') { TR.editing = null; unsplit(l); return; }
        return;
      }
      if (e.target.closest('.tl-edit')) return;
      if (TR.editing) return;
      jumpTo(l);
    };
    list.ondblclick = (e) => { const t = e.target.closest('.tl-text'); if (!t) return; const row = t.closest('.tl'); const l = TR.vis[parseInt(row.dataset.i, 10)]; if (l) startEdit(l); };
    list.onkeydown = (e) => {
      const ta = e.target.closest('.tl-edit'); if (!ta) return;
      const row = ta.closest('.tl'); const l = TR.vis[parseInt(row.dataset.i, 10)];
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(l, ta.value); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
      e.stopPropagation();
    };
    list.oninput = (e) => { if (e.target.classList.contains('tl-edit')) autosize(e.target); };
    $('#panel').onwheel = () => { TR.lastScroll = Date.now(); };
  }

  function startEdit(l) { TR.editing = editKeyOf(l); const keep = TR.q; fillList(); TR.q = keep; }
  function cancelEdit() { TR.editing = null; fillList(); }
  function finishEdit(l, text) { TR.editing = null; const before = TR.review.log.length; saveText(l, text); if (TR.review.log.length === before) fillList(); }

  // ---------- events ----------
  bcs.on('transcript:progress', async (m) => {
    const S = C().S; if (!S.project) return;
    if (m.groupId != null) TR.progress[`${m.groupId}_${m.track}`] = m;
    if (m.overall != null) TR.overall = m.overall;
    if (m.state === 'error') { TR.error = m.error; TR.running = false; C().toast('Transcription stopped: ' + m.error, 8000); }
    if (m.state === 'done') { await load(); if (S.tab === 'transcript' && !TR.editing) C().renderPanel(); }
    if (m.state === 'finished' || m.state === 'cancelled') {
      TR.running = false; await load();
      if (S.tab === 'transcript') C().renderPanel();
      const expected = TR.data.expected || 0;
      if (m.state === 'finished' && expected && (TR.data.tracks || []).length >= expected && Object.keys(TR.spk).length < expected && !TR.error) startSpeakers();
      return;
    }
    if (S.tab === 'transcript') fillStatus();
  });
  bcs.on('transcript:model', async (m) => { TR.model = m; if (m.state === 'ready') TR.status = await bcs.invoke('transcript:status'); if (C().S.tab === 'transcript') fillStatus(); });

  bcs.on('speakers:progress', async (m) => {
    const S = C().S; if (!S.project) return;
    if (m.overall != null) TR.spkRun.overall = m.overall;
    if (m.state === 'error') { TR.spkError = m.error; TR.spkRun.running = false; C().toast('Speaker detection stopped: ' + m.error, 8000); }
    if (m.state === 'done') { TR.spk = await bcs.invoke('speakers:get', S.project.id); buildLines(); if (S.tab === 'transcript' && !TR.editing) { fillList(); fillPeople(); } }
    if (m.state === 'finished' || m.state === 'cancelled') { TR.spkRun.running = false; await load(); if (S.tab === 'transcript') C().renderPanel(); return; }
    if (S.tab === 'transcript') fillStatus();
  });
  bcs.on('speakers:model', async (m) => {
    TR.spkModel = m;
    if (m.state === 'ready') { TR.spkStatus = await bcs.invoke('speakers:status'); const f = TR._afterSpkModel; TR._afterSpkModel = null; if (f) f(); }
    if (m.state === 'error') TR.spkError = m.error;
    if (C().S.tab === 'transcript') fillStatus();
  });

  // ⌘Z inside the transcript tab
  document.addEventListener('keydown', (e) => {
    const S = C() && C().S; if (!S || S.tab !== 'transcript') return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') return; // let text fields undo typing
      e.preventDefault(); undoLast();
    }
  });

  window.BCS = window.BCS || {};
  window.BCS.transcript = { reset, load, panel, markNow, TR, buildLines, exportText, mergePeople, undoLast };
})();
