'use strict';
// Speaker detection ("who spoke when") per audio track, fully local.
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const store = require('./store');

const SEG_DIR = 'sherpa-onnx-pyannote-segmentation-3-0';
const SEG_TAR_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2';
const EMB_NAME = process.env.BCS_EMB || 'wespeaker_en_voxceleb_resnet34_LM.onnx';
const EMB_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/' + EMB_NAME;
const THRESHOLD = Number(process.env.BCS_SPK_THRESHOLD || 0.4);
const MIN_CLUSTER_SEC = 10;
const CACHE_VERSION = 1;

function modelsDir() { const d = path.join(store.baseDir(), 'models'); fs.mkdirSync(d, { recursive: true }); return d; }
const segModel = () => path.join(modelsDir(), SEG_DIR, 'model.onnx');
const embModel = () => path.join(modelsDir(), EMB_NAME);

function status() { return { segModel: fs.existsSync(segModel()), embModel: fs.existsSync(embModel()), ready: fs.existsSync(segModel()) && fs.existsSync(embModel()) }; }

function download(url, dest, onProgress, redirects = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'BodyCamSync' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) { res.resume(); return resolve(download(new URL(res.headers.location, url).href, dest, onProgress, redirects - 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed (HTTP ${res.statusCode})`)); }
      const total = Number(res.headers['content-length']) || 0;
      const out = fs.createWriteStream(dest + '.part');
      let n = 0, last = 0;
      res.on('data', (d) => { n += d.length; const t = Date.now(); if (total && t - last > 250) { last = t; onProgress(n / total); } });
      res.pipe(out);
      out.on('finish', () => { fs.renameSync(dest + '.part', dest); resolve(); });
      out.on('error', reject); res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function downloadModels(emit) {
  const md = modelsDir();
  try {
    if (!fs.existsSync(segModel())) {
      const tar = path.join(md, 'seg.tar.bz2');
      await download(SEG_TAR_URL, tar, (p) => emit({ state: 'downloading', pct: p * 0.2 }));
      await new Promise((res, rej) => { const c = require('child_process').spawn('tar', ['xjf', tar, '-C', md]); c.on('close', (code) => (code === 0 ? res() : rej(new Error('Could not unpack the speaker model')))); });
      fs.rmSync(tar, { force: true });
    }
    if (!fs.existsSync(embModel())) await download(EMB_URL, embModel(), (p) => emit({ state: 'downloading', pct: 0.2 + p * 0.8 }));
    emit({ state: 'ready', pct: 1 });
  } catch (e) { emit({ state: 'error', error: e.message }); }
}

// ---------- running ----------
let current = null;

function runWorker(wav, onProgress, signal) {
  return new Promise((resolve, reject) => {
    // In the packaged app the worker and the native library live outside the archive.
    const workerPath = path.join(__dirname, 'diarWorker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const child = fork(workerPath, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let err = '';
    child.stderr && child.stderr.on('data', (d) => { err += d.toString(); });
    const abort = () => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    child.on('message', (m) => {
      if (m.progress != null) onProgress(m.progress);
      else if (m.error) { reject(new Error(m.error.split('\n')[0])); child.kill(); }
      else if (m.done) { resolve(m); child.kill(); }
    });
    child.on('error', reject);
    child.on('exit', (code) => { if (signal && signal.aborted) reject(new Error('cancelled')); else if (code) reject(new Error(err.trim().split('\n').pop() || `Speaker process exited (${code})`)); });
    child.send({ wav, segModel: segModel(), embModel: embModel(), threshold: THRESHOLD, minClusterSec: MIN_CLUSTER_SEC });
  });
}

function trackList(project) {
  const out = [];
  for (const g of project.groups) for (const t of g.tracks || []) if (!t.silent && t.wav && fs.existsSync(t.wav)) out.push({ g, t });
  return out;
}
function cachePath(projectId, g, t) { const d = path.join(store.dir(projectId), 'speakers'); fs.mkdirSync(d, { recursive: true }); return path.join(d, `${g.id}_${t.index}.json`); }
function trackKey(t) { let sz = 0; try { sz = fs.statSync(t.wav).size; } catch (_) { /* ignore */ } return `${CACHE_VERSION}|${EMB_NAME}|${THRESHOLD}|${MIN_CLUSTER_SEC}|${sz}`; }

async function diarizeProject(projectId, emit) {
  if (current) return;
  const project = store.load(projectId);
  if (!project) return;
  const ac = new AbortController();
  current = { ac };
  const list = trackList(project);
  const total = list.reduce((a, { g }) => a + (g.files[0].duration || 0), 0) || 1;
  let done = 0;
  try {
    for (const { g, t } of list) {
      if (ac.signal.aborted) break;
      const dur = g.files[0].duration || 0;
      const file = cachePath(projectId, g, t);
      let cached = null;
      try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* none */ }
      if (cached && cached.key === trackKey(t)) { done += dur; emit({ groupId: g.id, track: t.index, state: 'done', overall: done / total, cached: true }); continue; }
      emit({ groupId: g.id, track: t.index, state: 'running', pct: 0, overall: done / total });
      try {
        const r = await runWorker(t.wav, (p) => emit({ groupId: g.id, track: t.index, state: 'running', pct: p, overall: (done + dur * p) / total }), ac.signal);
        fs.writeFileSync(file, JSON.stringify({ key: trackKey(t), at: Date.now(), segments: r.segments, clusters: r.clusters }));
        done += dur;
        emit({ groupId: g.id, track: t.index, state: 'done', overall: done / total });
      } catch (e) {
        if (e.message === 'cancelled') { emit({ groupId: g.id, track: t.index, state: 'cancelled' }); break; }
        emit({ groupId: g.id, track: t.index, state: 'error', error: e.message });
        break;
      }
    }
  } finally { current = null; }
  emit({ state: 'finished', overall: 1 });
}

function cancel() { if (current) current.ac.abort(); }

function getSpeakers(projectId) {
  const project = store.load(projectId);
  const out = {};
  if (!project) return out;
  for (const { g, t } of trackList(project)) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath(projectId, g, t), 'utf8'));
      if (c.key === trackKey(t)) out[`${g.id}_${t.index}`] = foldSmall(c, MIN_DISPLAY_SEC);
    } catch (_) { /* not analysed */ }
  }
  return out;
}

// Voices with only a few seconds of speech are usually noise or a stray word, not a person.
// They are shown together as "Other voices" so the list stays readable. (Display-only: nothing is lost.)
const MIN_DISPLAY_SEC = 25;
function foldSmall(sp, minSec) {
  const keep = sp.clusters.filter((c) => c.c >= 0 && c.sec >= minSec).sort((a, b) => b.sec - a.sec);
  const remap = new Map(keep.map((c, i) => [c.c, i]));
  const clusters = keep.map((c, i) => ({ ...c, c: i }));
  let sec = 0, n = 0;
  for (const c of sp.clusters) if (!remap.has(c.c)) { sec += c.sec; n += c.n; }
  if (n) clusters.push({ c: -1, sec, n, rms: 0 });
  return { segments: sp.segments.map((s) => ({ s: s.s, e: s.e, c: remap.has(s.c) ? remap.get(s.c) : -1 })), clusters };
}

module.exports = { status, downloadModels, diarizeProject, cancel, getSpeakers };
