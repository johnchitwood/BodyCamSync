'use strict';
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { pathToFileURL } = require('url');
const media = require('./media');
const store = require('./store');
const dsp = require('./dsp');
const { readSoundTrackNames } = require('./mp4names');
const playback = require('./playback');
const staging = require('./staging');
const jobs = require('./jobs');

const EXTRACT_VERSION = 2;
const SYNC_VERSION = 1;

const fileKey = (f) => `${f.path}|${f.size}|${f.mtimeMs}`;

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function projectName(folder) {
  const base = path.basename(folder);
  return /^(videos?|media|footage|bwc|discovery|files?)$/i.test(base) ? path.basename(path.dirname(folder)) : base;
}

// ---------- audio extraction ----------
function audioSource(g) {
  // Use the smallest original file that has audio to minimise reads from slow drives.
  const cands = g.files.filter((f) => f.audio.length && !f.derivative).sort((a, b) => a.size - b.size);
  return cands[0] || g.files.filter((f) => f.audio.length).sort((a, b) => a.size - b.size)[0];
}

// `stageFor`: a case id when this file should first be copied to this computer (see staging.js), else null.
async function extractGroupAudio(g, pdir, emit, label, stageFor = null) {
  const src = audioSource(g);
  if (!src) return null;
  const out = path.join(pdir, 'audio', g.id);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  let input = src.path, fingerprint = null, readShare = 0;
  if (stageFor) {
    readShare = 0.7;
    try {
      const st = await staging.stage(stageFor, g.id, src.angle, src, { onProgress: (p) => emit(label, p * readShare) });
      input = st.path;
      fingerprint = { sha256: st.sha256, size: src.size, mtimeMs: src.mtimeMs, at: Date.now() };
    } catch (_) { input = src.path; } // fall back to reading the original directly
  }
  const args = ['-i', input];
  for (const a of src.audio) {
    args.push('-map', `0:a:${a.index}`, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', path.join(out, `s${a.index}.wav`));
    // playback copy: a lossless 16-bit FLAC always; for AAC also the original track copied unchanged, which replaces
    // the FLAC if (and only if) it is verified to line up with the analysis audio along the whole recording
    args.push('-map', `0:a:${a.index}`, '-vn', '-c:a', 'flac', '-sample_fmt', 's16', '-compression_level', '4', path.join(out, `p${a.index}.flac`));
    if (playback.canCopy(a)) args.push('-map', `0:a:${a.index}`, '-vn', '-c:a', 'copy', path.join(out, `p${a.index}.m4a`));
  }
  await media.runFfmpeg(media.FFMPEG, args, { duration: src.duration, onProgress: (p) => emit(label, readShare + p * (1 - readShare)) });

  const tracks = [];
  for (const a of src.audio) {
    const wavPath = path.join(out, `s${a.index}.wav`);
    const flacPath = path.join(out, `p${a.index}.flac`);
    const m4aPath = path.join(out, `p${a.index}.m4a`);
    const { samples } = dsp.readWav(wavPath);
    const level = dsp.rms(samples);
    const silent = level < 4;
    const env = dsp.envelope(samples, 16000, 0.25);
    const pooled = [];
    for (let i = 0; i + 1 < env.length; i += 2) {
      const v = Math.max(env[i], env[i + 1]);
      pooled.push(Math.max(0, Math.min(255, Math.round((20 * Math.log10(v + 1) / 90) * 255))));
    }
    if (silent) { fs.rmSync(flacPath, { force: true }); fs.rmSync(m4aPath, { force: true }); }
    else if (fs.existsSync(m4aPath)) {
      const good = await playback.verifyM4a(m4aPath, src.duration) && await playback.alignmentOk(m4aPath, wavPath, src.duration);
      if (good) fs.rmSync(flacPath, { force: true });   // the original audio, unchanged, replaces the lossless copy
      else fs.rmSync(m4aPath, { force: true });          // keep the lossless 16-bit copy instead
    }
    tracks.push({ index: a.index, name: a.name, friendly: a.friendly, channels: a.channels, silent, rms: Math.round(level * 10) / 10, wav: wavPath, flac: null, env: pooled, envHop: 0.5 });
  }
  return { source: src.name, sourceKey: fileKey(src), tracks, duration: src.duration, fingerprint: fingerprint && { path: src.path, ...fingerprint } };
}

// ---------- pairwise sync ----------
function makePool(n) {
  const workers = [];
  const waiting = [];
  const pending = new Map();
  let seq = 0;
  for (let i = 0; i < n; i++) {
    const w = new Worker(path.join(__dirname, 'syncWorker.js'));
    w.busy = false;
    w.on('message', (m) => {
      const cb = pending.get(m.id); pending.delete(m.id);
      w.busy = false;
      if (cb) m.error ? cb.reject(new Error(m.error)) : cb.resolve(m.result);
      const nxt = waiting.shift();
      if (nxt) dispatch(w, nxt);
    });
    w.on('error', (e) => { for (const cb of pending.values()) cb.reject(e); pending.clear(); });
    workers.push(w);
  }
  function dispatch(w, job) { w.busy = true; pending.set(job.id, job.cb); w.postMessage(job.msg); }
  return {
    run(aPath, bPath) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const job = { id, msg: { id, aPath, bPath }, cb: { resolve, reject } };
        const free = workers.find((w) => !w.busy);
        free ? dispatch(free, job) : waiting.push(job);
      });
    },
    close() { workers.forEach((w) => w.terminate()); },
  };
}

function isStrong(r) { return r && r.ok && r.agree >= 10 && r.spreadMs <= 12; }

// How many camera pairs to match at once. Each one needs roughly 18 bytes of memory per sample of the longer
// recording (about 0.5 GB for 30 minutes) and one processor core; leave some of both for the rest of the app.
function syncWorkers(groups) {
  const os = require('os');
  const longest = Math.max(1, ...groups.map((g) => g.duration || 0));
  const perPair = longest * 16000 * 18 + 64e6;
  const byMem = Math.floor((os.freemem() * 0.6) / perPair);
  const byCpu = (os.cpus() || []).length - 2;
  return Math.max(1, Math.min(8, byCpu, byMem, (groups.length * (groups.length - 1)) / 2));
}

async function syncGroups(groups, emit) {
  const n = syncWorkers(groups);
  const wp = makePool(n);
  const pairs = [];
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) pairs.push([i, j]);
  let done = 0;
  const edges = [];
  try {
    await pool(pairs, n, async ([i, j]) => {
      const A = groups[i].tracks.filter((t) => !t.silent);
      const B = groups[j].tracks.filter((t) => !t.silent);
      let best = null;
      outer: for (const ta of A) {
        for (const tb of B) {
          let r;
          try { r = await wp.run(ta.wav, tb.wav); } catch (e) { r = { ok: false, error: String(e) }; }
          if (r.ok && (!best || r.score > best.r.score)) best = { r, ta, tb };
          if (isStrong(r)) break outer;
        }
      }
      done++;
      emit(`${groups[i].label} ↔ ${groups[j].label}`, done / pairs.length);
      if (best) {
        const r = best.r;
        edges.push({ a: groups[i].id, b: groups[j].id, aTrack: best.ta.index, bTrack: best.tb.index, lag: r.lag, delta: -r.lag, spreadMs: r.spreadMs, agree: r.agree, good: r.good, total: r.total, score: r.score, driftPpm: r.driftPpm });
      }
    });
  } finally { wp.close(); }
  return edges;
}

function solve(groups, edges) {
  const idx = new Map(groups.map((g, i) => [g.id, i]));
  const starts = new Array(groups.length).fill(null);
  const via = new Array(groups.length).fill(null);
  const used = new Set();
  starts[0] = 0;
  const inTree = () => starts.map((s, i) => (s !== null ? i : -1)).filter((i) => i >= 0);
  for (;;) {
    let best = null;
    for (const e of edges) {
      const ia = idx.get(e.a), ib = idx.get(e.b);
      const ha = starts[ia] !== null, hb = starts[ib] !== null;
      if (ha === hb) continue;
      if (!best || e.score > best.e.score) best = { e, ia, ib, ha };
    }
    if (!best) break;
    const { e, ia, ib, ha } = best;
    if (ha) { starts[ib] = starts[ia] + e.delta; via[ib] = e; } else { starts[ia] = starts[ib] - e.delta; via[ia] = e; }
    used.add(e);
  }
  // anything unreachable falls back to the timestamp in the filename (approximate)
  const ref = groups[0];
  for (let i = 0; i < groups.length; i++) {
    if (starts[i] !== null) continue;
    const g = groups[i];
    starts[i] = ref.nominalStart && g.nominalStart ? g.nominalStart - ref.nominalStart : 0;
    via[i] = { estimate: true };
  }
  const min = Math.min(...starts);
  const residuals = [];
  for (const e of edges) {
    if (used.has(e)) continue;
    const r = (starts[idx.get(e.b)] - starts[idx.get(e.a)]) - e.delta;
    residuals.push({ a: e.a, b: e.b, ms: Math.round(r * 1000 * 10) / 10 });
  }
  groups.forEach((g, i) => {
    g.start = starts[i] - min;
    const v = via[i];
    if (i === 0 && !v) { g.syncMethod = 'reference'; g.syncQuality = { level: 'reference' }; }
    else if (v && v.estimate) { g.syncMethod = 'filename'; g.syncQuality = { level: 'estimate' }; }
    else {
      g.syncMethod = 'audio';
      const lvl = v.agree >= 8 && v.spreadMs <= 15 ? 'strong' : v.agree >= 3 ? 'moderate' : 'weak';
      g.syncQuality = { level: lvl, agree: v.agree, good: v.good, total: v.total, spreadMs: Math.round(v.spreadMs * 10) / 10, driftPpm: Math.round(v.driftPpm * 10) / 10 };
    }
  });
  // If the first group's own offset isn't zero after normalisation, mark it as audio-anchored.
  return residuals;
}

// ---------- main entry ----------
// `files` (optional): a hand-picked list of video files, used instead of scanning a whole folder.
async function analyze(folder, { emit, force = false, files: selected = null }) {
  const id = selected ? store.idForFiles(selected) : store.idFor(folder);
  const pdir = store.dir(id);
  const prev = force ? null : store.load(id);
  const send = (phase, label, pct, detail) => emit({ phase, label, pct, detail });

  send('scan', selected ? 'Reading files' : 'Reading folder', 0);
  const paths = selected ? selected.filter((p) => fs.existsSync(p)).sort() : media.listVideos(folder);
  if (!paths.length) throw new Error(selected ? 'None of the selected files could be found.' : 'No video files found in that folder.');

  const prevFiles = new Map();
  if (prev) for (const g of prev.groups) for (const f of g.files) prevFiles.set(fileKey(f), f);
  let scanned = 0;
  const summaries = await pool(paths, 4, async (p) => {
    const st = fs.statSync(p);
    const k = `${p}|${st.size}|${Math.round(st.mtimeMs)}`;
    let s = prevFiles.get(k);
    if (s && s.summaryVersion !== 3) s = null;
    if (!s) {
      try { s = media.summarize(p, st, await media.probe(p), await readSoundTrackNames(p)); } catch (e) { s = null; }
    }
    scanned++;
    send('scan', 'Reading folder', (scanned / paths.length) * 0.05, path.basename(p));
    return s;
  });
  const files = summaries.filter(Boolean);
  const groups = media.groupFiles(files);

  // reuse prior audio analysis where the source file is unchanged
  const prevGroups = new Map(prev ? prev.groups.map((g) => [g.id, g]) : []);
  const todo = [];
  for (const g of groups) {
    const pg = prevGroups.get(g.id);
    const src = audioSource(g);
    const reusable = pg && pg.extractVersion === EXTRACT_VERSION && src && pg.sourceKey === fileKey(src) && pg.tracks && pg.tracks.every((t) => fs.existsSync(t.wav) && (t.silent || playback.playbackPath(t)));
    if (reusable) {
      // refresh display names from the (possibly newer) file summary
      pg.tracks.forEach((t) => { const a = src.audio[t.index]; if (a) { t.name = a.name; t.friendly = a.friendly; } });
      g.tracks = pg.tracks; g.audioSource = pg.audioSource; g.sourceKey = pg.sourceKey; g.extractVersion = EXTRACT_VERSION; }
    else todo.push(g);
  }

  let finished = 0;
  const frac = new Map();
  const reportAudio = () => {
    const sum = todo.reduce((p, g) => p + (frac.get(g.id) || 0), 0);
    send('audio', 'Preparing audio', 0.05 + 0.55 * (sum / Math.max(1, todo.length)), [...frac.entries()].filter(([, v]) => v < 1).map(([k]) => groups.find((x) => x.id === k).label).join(', '));
  };
  // Which files to copy to this computer first, so the local video copy made next doesn't read the drive again:
  // only where that copy will be made automatically (same rules as the Playback tab), and only with room to spare.
  const prefs = (prev && prev.prefs) || {};
  const toStage = new Set();
  if (prefs.autoProxies !== false && process.env.BCS_NO_STAGING !== '1') {
    const watched = groups.filter((g) => !(prefs.visible && prefs.visible[g.id] === false));
    const est = watched.reduce((a, g) => a + (g.duration || 0) * 5e6 / 8 * 1.15, 0);
    let room = jobs.freeBytes() - est - 25e9;
    if (est <= 8e9) {
      for (const g of todo) {
        if (!watched.includes(g)) continue;
        const src = audioSource(g);
        const shown = (prefs.angle && prefs.angle[g.id]) || (g.files[0] && g.files[0].angle);
        if (!src || src.angle !== shown) continue;
        if (fs.existsSync(path.join(pdir, 'proxies', `${g.id}_${src.angle}.mp4`))) continue;
        if (room - src.size < 0) continue;
        room -= src.size;
        toStage.add(g.id);
      }
    }
  }
  const fingerprints = [];
  if (todo.length) {
    await pool(todo, 2, async (g) => {
      const r = await extractGroupAudio(g, pdir, (_, p) => { frac.set(g.id, p); reportAudio(); }, g.label, toStage.has(g.id) ? id : null);
      if (r && r.fingerprint) fingerprints.push(r.fingerprint);
      if (!r) { g.tracks = []; g.audioSource = null; g.extractVersion = EXTRACT_VERSION; frac.set(g.id, 1); return; }
      g.tracks = r.tracks; g.audioSource = r.source; g.sourceKey = r.sourceKey; g.extractVersion = EXTRACT_VERSION;
      frac.set(g.id, 1); finished++; reportAudio();
    });
  }

  // sync
  const syncKey = SYNC_VERSION + '|' + groups.map((g) => g.id + ':' + g.sourceKey).join(',');
  let sync;
  const reuseSync = prev && prev.sync && prev.sync.key === syncKey;
  if (reuseSync) {
    sync = prev.sync;
    for (const g of groups) { const pg = prevGroups.get(g.id); g.start = pg.start; g.syncMethod = pg.syncMethod; g.syncQuality = pg.syncQuality; }
  } else if (groups.length > 1) {
    send('sync', 'Matching audio between cameras', 0.6, '');
    const edges = await syncGroups(groups, (label, p) => send('sync', 'Matching audio between cameras', 0.6 + 0.38 * p, label));
    const residuals = solve(groups, edges);
    sync = { key: syncKey, edges, residuals, solvedAt: Date.now() };
  } else {
    groups[0].start = 0; groups[0].syncMethod = 'reference'; groups[0].syncQuality = { level: 'reference' };
    sync = { key: syncKey, edges: [], residuals: [], solvedAt: Date.now() };
  }

  const project = {
    id, folder: path.resolve(folder), version: 1,
    name: selected ? `${projectName(path.resolve(folder))} · ${paths.length} file${paths.length === 1 ? '' : 's'}` : projectName(path.resolve(folder)),
    selection: selected ? [...paths] : null,
    groups, sync,
    nudges: (prev && prev.nudges) || {},
    prefs: (prev && prev.prefs) || {},
    hashes: (prev && prev.hashes) || {},
  };
  // Fingerprints taken while copying (the same bytes the Files tab would read), so those files needn't be read again.
  for (const fp of fingerprints) { const { path: p, ...rest } = fp; project.hashes[p] = rest; }
  store.save(id, project);
  // Temporary copies that no local-copy job picks up within a minute (copies turned off, not enough room, another
  // case opened) are deleted, as are any left from other cases.
  staging.sweep(id);
  if (toStage.size) setTimeout(() => staging.sweepUnclaimed(id, jobs.proxyClaimed), 60000).unref();
  send('done', 'Ready', 1);
  return project;
}

// Add file:// URLs for the renderer (kept out of the saved JSON).
function decorate(project) {
  const p = JSON.parse(JSON.stringify(project));
  const pdir = store.dir(p.id);
  for (const g of p.groups) {
    for (const f of g.files) {
      f.url = pathToFileURL(f.path).href;
      const prox = path.join(pdir, 'proxies', `${g.id}_${f.angle}.mp4`);
      f.proxyUrl = fs.existsSync(prox) ? pathToFileURL(prox).href : null;
      f.exists = fs.existsSync(f.path);
      f.hash = (p.hashes && p.hashes[f.path]) || null;
    }
    for (const t of g.tracks || []) { const pp = t.silent ? null : playback.playbackPath(t); t.url = pp ? pathToFileURL(pp).href : null; }
  }
  p.cacheBytes = store.cacheBytes(p.id);
  return p;
}

module.exports = { analyze, decorate };
