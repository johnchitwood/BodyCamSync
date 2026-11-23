'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const media = require('./media');
const store = require('./store');

// ---------- local proxies (derived copies; originals are never touched) ----------
const proxyJobs = new Map(); // key -> AbortController
const DISK_RESERVE = 15e9; // always leave at least this much free
function freeBytes() { try { const s = fs.statfsSync(store.baseDir()); return Number(s.bavail) * Number(s.bsize); } catch (_) { return Infinity; } }
// At most two encodes at once: enough to keep the drive busy without starving playback of bandwidth.
let active = 0;
const waiters = [];
const acquire = () => new Promise((res) => { if (active < 2) { active++; res(); } else waiters.push(res); });
const release = () => { active--; const n = waiters.shift(); if (n) { active++; n(); } };

async function buildProxy(projectId, groupId, angle, emit) {
  const project = store.load(projectId);
  const g = project && project.groups.find((x) => x.id === groupId);
  const f = g && g.files.find((x) => x.angle === angle);
  if (!f) throw new Error('Unknown camera angle');
  const dir = path.join(store.dir(projectId), 'proxies');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${groupId}_${angle}.mp4`);
  const tmp = out.replace(/\.mp4$/, '.part.mp4');
  const key = `${groupId}_${angle}`;
  if (proxyJobs.has(key)) return;
  if (fs.existsSync(out)) { emit({ groupId, angle, state: 'done', pct: 1 }); return; }
  const ac = new AbortController();
  proxyJobs.set(key, ac);
  let held = false;
  try {
    emit({ groupId, angle, state: 'queued', pct: 0 });
    await acquire();
    held = true;
    if (ac.signal.aborted) throw new Error('cancelled');
    // Never fill the disk: keep a generous reserve free (checked again before every copy).
    const need = Math.round((f.duration || 0) * 5e6 / 8 * 1.15);
    const free = freeBytes();
    if (free - need < DISK_RESERVE) throw new Error(`Not enough free disk space for local copies (${(free / 1e9).toFixed(0)} GB free; keeping ${(DISK_RESERVE / 1e9).toFixed(0)} GB in reserve).`);
    const enc = await media.proxyEncoder();
    const scale = f.height > 720 ? 'scale=1280:-2:flags=bicubic' : 'scale=iw:ih';
    // Short keyframe interval (-g 15) and no B-frames keep seeking instant. Hardware encoders are rate-controlled.
    const hw = (name, extra = []) => ['-c:v', name, '-b:v', '5M', '-maxrate', '8M', '-g', '15', '-bf', '0', ...extra];
    const codecArgsFor = (codec) => codec === 'h264_videotoolbox' ? hw(codec, ['-profile:v', 'high'])
      : codec === 'h264_nvenc' ? hw(codec, ['-profile:v', 'high', '-preset', 'p4'])
      : codec === 'h264_qsv' ? hw(codec, ['-profile:v', 'high'])
      : codec === 'h264_amf' ? hw(codec, ['-usage', 'transcoding'])
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-g', '15', '-bf', '0'];
    const argsFor = (codec) => ['-i', f.path, '-map', '0:v:0', '-an', '-vf', scale, ...codecArgsFor(codec), '-pix_fmt', 'yuv420p', '-fps_mode', 'cfr', '-r', '30', '-movflags', '+faststart', '-f', 'mp4', tmp];
    emit({ groupId, angle, state: 'running', pct: 0 });
    const opts = { duration: f.duration, signal: ac.signal, onProgress: (p) => emit({ groupId, angle, state: 'running', pct: p }) };
    try {
      await media.runFfmpeg(enc.bin, argsFor(enc.codec), opts);
    } catch (e) {
      // a hardware encoder can pass the quick test and still fail on a real file: fall back to software once
      if (enc.codec === 'libx264' || ac.signal.aborted) throw e;
      fs.rmSync(tmp, { force: true });
      await media.runFfmpeg(media.FFMPEG, argsFor('libx264'), opts);
    }
    fs.renameSync(tmp, out);
    emit({ groupId, angle, state: 'done', pct: 1 });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    emit({ groupId, angle, state: e.message === 'cancelled' ? 'cancelled' : 'error', pct: 0, error: e.message });
  } finally { if (held) release(); proxyJobs.delete(key); }
}
function cancelProxies() { for (const ac of proxyJobs.values()) ac.abort(); }
function removeProxies(projectId) { fs.rmSync(path.join(store.dir(projectId), 'proxies'), { recursive: true, force: true }); }

// ---------- SHA-256 fingerprints ----------
let hashAbort = null;

async function hashFiles(projectId, emit) {
  const project = store.load(projectId);
  if (!project) return;
  if (hashAbort) hashAbort.abort();
  const ac = new AbortController();
  hashAbort = ac;
  const files = project.groups.flatMap((g) => g.files);
  const total = files.reduce((p, f) => p + f.size, 0);
  let doneBytes = 0;
  project.hashes = project.hashes || {};
  for (const f of files) {
    if (ac.signal.aborted) break;
    const cur = project.hashes[f.path];
    if (cur && cur.size === f.size && cur.mtimeMs === f.mtimeMs) { doneBytes += f.size; emit({ path: f.path, state: 'cached', overall: doneBytes / total }); continue; }
    emit({ path: f.path, state: 'running', pct: 0, overall: doneBytes / total });
    try {
      const sha = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const rs = fs.createReadStream(f.path, { highWaterMark: 4 << 20 });
        let n = 0, last = 0;
        const abort = () => { rs.destroy(new Error('cancelled')); };
        ac.signal.addEventListener('abort', abort, { once: true });
        rs.on('data', (d) => {
          h.update(d); n += d.length;
          const now = Date.now();
          if (now - last > 250) { last = now; emit({ path: f.path, state: 'running', pct: n / f.size, overall: (doneBytes + n) / total }); }
        });
        rs.on('error', reject);
        rs.on('end', () => resolve(h.digest('hex')));
      });
      doneBytes += f.size;
      project.hashes[f.path] = { sha256: sha, size: f.size, mtimeMs: f.mtimeMs, at: Date.now() };
      store.save(projectId, project);
      emit({ path: f.path, state: 'done', sha256: sha, overall: doneBytes / total });
    } catch (e) {
      emit({ path: f.path, state: e.message === 'cancelled' ? 'cancelled' : 'error', error: e.message });
      if (e.message === 'cancelled') break;
    }
  }
  if (hashAbort === ac) hashAbort = null;
  emit({ state: 'finished', overall: 1 });
}
function cancelHash() { if (hashAbort) hashAbort.abort(); }

module.exports = { freeBytes, buildProxy, cancelProxies, removeProxies, hashFiles, cancelHash };
