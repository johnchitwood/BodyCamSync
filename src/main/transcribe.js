'use strict';
// Local speech-to-text via whisper.cpp. Nothing leaves this Mac.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const store = require('./store');

const MODEL_NAME = 'ggml-large-v3-turbo-q5_0.bin';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + MODEL_NAME;
const VAD_NAME = 'ggml-silero-v5.1.2.bin';
const VAD_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/' + VAD_NAME;
const CACHE_VERSION = 3;

function modelsDir() { const d = path.join(store.baseDir(), 'models'); fs.mkdirSync(d, { recursive: true }); return d; }

function findEngine() {
  const cands = [
    process.env.BCS_WHISPER,
    process.resourcesPath && path.join(process.resourcesPath, 'bin', 'whisper-cli'),
    path.join(__dirname, '..', '..', 'resources', 'bin', 'whisper-cli'),
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }) || null;
}

function status() {
  const md = modelsDir();
  const model = path.join(md, MODEL_NAME), vad = path.join(md, VAD_NAME);
  return { engine: findEngine(), model: fs.existsSync(model) ? model : null, vad: fs.existsSync(vad) ? vad : null, modelName: MODEL_NAME, modelSizeMB: 574 };
}

// ---------- model download ----------
function download(url, dest, onProgress, signal, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'BodyCamSync' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, dest, onProgress, signal, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed (HTTP ${res.statusCode})`)); }
      const total = Number(res.headers['content-length']) || 0;
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      let n = 0, last = 0;
      res.on('data', (d) => { n += d.length; const t = Date.now(); if (total && t - last > 250) { last = t; onProgress(n / total); } });
      res.pipe(out);
      out.on('finish', () => { fs.renameSync(tmp, dest); resolve(); });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('cancelled')), { once: true });
  });
}

async function downloadModels(emit) {
  const md = modelsDir();
  const jobs = [[VAD_URL, path.join(md, VAD_NAME), 0, 0.02], [MODEL_URL, path.join(md, MODEL_NAME), 0.02, 1]];
  try {
    for (const [url, dest, a, b] of jobs) {
      if (fs.existsSync(dest)) continue;
      await download(url, dest, (p) => emit({ state: 'downloading', pct: a + (b - a) * p }));
    }
    emit({ state: 'ready', pct: 1 });
  } catch (e) { emit({ state: 'error', error: e.message }); }
}

// ---------- parsing ----------
const NOISE = [/^\[?\s*(blank[_ ]audio|silence|music|noise|inaudible)\s*\]?$/i, /^\(.*\)$/, /^\[.*\]$/, /^[♪♫\s.\-–—]+$/, /thank(s| you)( so much)? for (watching|listening)/i, /subscribe to (the|my|our)/i, /^you$/i, /^thank you\.?$/i, /^bye\.?$/i, /please (like|subscribe)/i, /amara\.org|subtitles by/i];

const MARKER = /^\[_[A-Za-z]+(?:_\d+)?_?\]$/;
const MARKER_G = /\[_[A-Za-z]+(?:_\d+)?_?\]/g;

function parseWhisperJson(json) {
  const out = [];
  for (const seg of json.transcription || []) {
    // whisper's internal markers ([_TT_1157], [_BEG_], <|...|>) are not speech
    const text = String(seg.text || '').replace(MARKER_G, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const from = seg.offsets ? seg.offsets.from / 1000 : 0;
    const to = seg.offsets ? seg.offsets.to / 1000 : from;
    // group sub-word tokens into words with their probabilities
    const words = [];
    let psum = 0, pn = 0;
    for (const tk of seg.tokens || []) {
      const t = String(tk.text || '');
      if (!t.trim() || MARKER.test(t.trim()) || /^<\|.*\|>$/.test(t.trim())) continue;
      const p = typeof tk.p === 'number' ? tk.p : 1;
      psum += p; pn++;
      if (/^\s/.test(t) || !words.length) words.push([t.trim(), p, p]);
      else { const w = words[words.length - 1]; w[0] += t; w[1] = Math.min(w[1], p); }
    }
    out.push({ s: from, e: to, text, conf: pn ? Math.round((psum / pn) * 100) / 100 : 1, w: words.map((w) => [w[0], Math.round(w[1] * 100) / 100]) });
  }
  return out;
}

// Whisper invents text over silence and noise. Drop the common signatures.
function clean(segs) {
  const out = [];
  let dropped = 0;
  for (const s of segs) {
    if (NOISE.some((re) => re.test(s.text))) { dropped++; continue; }
    const prev = out[out.length - 1];
    const prev2 = out[out.length - 2];
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (prev && norm(prev.text) === norm(s.text) && prev2 && norm(prev2.text) === norm(s.text)) { dropped++; continue; } // repetition loop
    out.push(s);
  }
  return { segments: out, dropped };
}

// ---------- running ----------
let current = null; // { ac, child }

function transcribeWav(wav, onProgress, signal) {
  const st = status();
  if (!st.engine) return Promise.reject(new Error('The transcription engine is not installed.'));
  if (!st.model) return Promise.reject(new Error('The speech model has not been downloaded yet.'));
  const tmpBase = path.join(path.dirname(wav), 'tr_' + path.basename(wav, '.wav'));
  const args = ['-m', st.model, '-f', wav, '-l', 'en', '--output-json-full', '--output-file', tmpBase, '--print-progress', '--max-context', '0', '--suppress-nst', '--max-len', '110', '--split-on-word', '-t', '6'];
  if (st.vad) args.push('--vad', '--vad-model', st.vad);
  return new Promise((resolve, reject) => {
    const child = spawn(st.engine, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const onData = (d) => {
      const s = d.toString(); err += s;
      const m = s.match(/progress\s*=\s*(\d+)%/g);
      if (m) { const last = m[m.length - 1].match(/(\d+)%/); onProgress(Number(last[1]) / 100); }
    };
    child.stderr.on('data', onData); child.stdout.on('data', onData);
    const abort = () => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal && signal.aborted) return reject(new Error('cancelled'));
      if (code !== 0) return reject(new Error((err.trim().split('\n').slice(-3).join(' ') || `Engine exited with code ${code}`)));
      try {
        const json = JSON.parse(fs.readFileSync(tmpBase + '.json', 'utf8'));
        fs.rmSync(tmpBase + '.json', { force: true });
        resolve(json);
      } catch (e) { reject(new Error('Could not read the engine output: ' + e.message)); }
    });
  });
}

function trackList(project) {
  const out = [];
  for (const g of project.groups) for (const t of g.tracks || []) if (!t.silent && t.wav && fs.existsSync(t.wav)) out.push({ g, t });
  return out;
}

function cachePath(projectId, g, t) { const d = path.join(store.dir(projectId), 'transcripts'); fs.mkdirSync(d, { recursive: true }); return path.join(d, `${g.id}_${t.index}.json`); }
function trackKey(t) { let sz = 0; try { sz = fs.statSync(t.wav).size; } catch (_) { /* ignore */ } return `${CACHE_VERSION}|${MODEL_NAME}|${sz}`; }

async function transcribeProject(projectId, emit) {
  if (current) return;
  const project = store.load(projectId);
  if (!project) return;
  const ac = new AbortController();
  current = { ac };
  const list = trackList(project);
  const totalDur = list.reduce((a, { g }) => a + (g.files[0].duration || 0), 0) || 1;
  let doneDur = 0;
  try {
    for (const { g, t } of list) {
      if (ac.signal.aborted) break;
      const file = cachePath(projectId, g, t);
      const dur = g.files[0].duration || 0;
      let cached = null;
      try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* none */ }
      if (cached && cached.key === trackKey(t)) { doneDur += dur; emit({ groupId: g.id, track: t.index, state: 'done', overall: doneDur / totalDur, cached: true }); continue; }
      emit({ groupId: g.id, track: t.index, state: 'running', pct: 0, overall: doneDur / totalDur });
      try {
        const json = await transcribeWav(t.wav, (p) => emit({ groupId: g.id, track: t.index, state: 'running', pct: p, overall: (doneDur + dur * p) / totalDur }), ac.signal);
        const { segments, dropped } = clean(parseWhisperJson(json));
        fs.writeFileSync(file, JSON.stringify({ key: trackKey(t), model: MODEL_NAME, at: Date.now(), dropped, segments }));
        doneDur += dur;
        emit({ groupId: g.id, track: t.index, state: 'done', overall: doneDur / totalDur });
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

function getTranscripts(projectId) {
  const project = store.load(projectId);
  if (!project) return { tracks: [] };
  const tracks = [];
  for (const { g, t } of trackList(project)) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath(projectId, g, t), 'utf8'));
      if (c.key === trackKey(t)) tracks.push({ groupId: g.id, track: t.index, friendly: t.friendly, key: c.key, segments: c.segments, dropped: c.dropped });
    } catch (_) { /* not transcribed yet */ }
  }
  const audioMinutes = Math.round(trackList(project).reduce((a, { g }) => a + (g.files[0].duration || 0), 0) / 60);
  return { tracks, expected: trackList(project).length, audioMinutes, running: !!current };
}

module.exports = { status, downloadModels, transcribeProject, cancel, getTranscripts };
