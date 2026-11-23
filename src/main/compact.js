'use strict';
// Shrinks the prepared-audio cache of existing cases: replaces large lossless FLAC playback copies with the original
// audio track copied unchanged (see playback.js). A FLAC is removed only after its replacement has been verified.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const media = require('./media');
const store = require('./store');
const playback = require('./playback');

const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };

function plan(project) {
  const out = [];
  for (const g of project.groups || []) {
    const src = (g.files || []).find((f) => f.name === g.audioSource);
    if (!src) continue;
    const jobs = [];
    for (const t of g.tracks || []) {
      if (t.silent || !t.wav) continue;
      const dir = path.dirname(t.wav);
      const flac = path.join(dir, `p${t.index}.flac`), m4a = path.join(dir, `p${t.index}.m4a`);
      if (fs.existsSync(flac) && !fs.existsSync(m4a) && playback.canCopy(src.audio[t.index])) jobs.push({ t, flac, m4a });
    }
    if (jobs.length) out.push({ g, src, jobs });
  }
  return out;
}

function estimate(id) {
  const project = store.load(id);
  if (!project) return 0;
  let n = 0;
  for (const { src, jobs } of plan(project)) for (const j of jobs) n += Math.max(0, size(j.flac) - (src.duration || 0) * 6000);
  return Math.round(n);
}

// Decode 20 seconds from the middle of both copies and make sure they line up sample for sample.
function pcm(file, start) {
  return new Promise((resolve) => {
    execFile(media.FFMPEG, ['-v', 'error', '-ss', String(start), '-t', '20', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 }, (err, out) => {
      if (err || !out) return resolve(null);
      resolve(new Int16Array(out.buffer, out.byteOffset, Math.floor(out.length / 2)));
    });
  });
}
async function contentMatches(m4a, flac, dur) {
  // Compare a few 20-second stretches. Seeking lands within a sample or two (at 16 kHz, ~0.1 ms) of the same
  // place in each file, so a tiny wobble is expected; a real misalignment of even 1 ms would collapse the match.
  // Silent stretches can't be compared and are skipped (the start-time and length checks still apply).
  let compared = 0;
  for (const frac of [0.5, 0.25, 0.75]) {
    const t = Math.max(0, Math.min(dur - 25, dur * frac));
    const [a, b] = await Promise.all([pcm(m4a, t), pcm(flac, t)]);
    if (!a || !b) return false;
    const n = Math.min(a.length, b.length, 16000 * 18) - 200;
    let e = 0; for (let i = 100; i < 100 + n; i += 4) e += b[i] * b[i];
    if (e / (n / 4) < 400) continue; // too quiet to tell
    let best = -Infinity, bl = 0, na = 0, nb = 0;
    for (let i = 100; i < 100 + n; i += 2) { na += a[i] * a[i]; nb += b[i] * b[i]; }
    for (let lag = -48; lag <= 48; lag++) { let s = 0; for (let i = 100; i < 100 + n; i += 2) s += a[i + lag] * b[i]; if (s > best) { best = s; bl = lag; } }
    const corr = best / Math.sqrt((na * nb) || 1);
    if (Math.abs(bl) > 3 || corr < 0.85) return false;
    if (++compared >= 2) return true;
  }
  return true;
}

async function compactProject(id, emit, signal, tick) {
  const project = store.load(id);
  if (!project) return { freed: 0, skipped: [] };
  const plans = plan(project);
  let freed = 0;
  const skipped = [];
  for (const { g, src, jobs } of plans) {
    if (signal.aborted) throw new Error('cancelled');
    if (!fs.existsSync(src.path)) { skipped.push(`${g.label}: the original video isn’t reachable (is the drive connected?)`); tick(); continue; }
    const parts = jobs.map((j) => j.m4a + '.part.m4a');
    const args = ['-y', '-i', src.path];
    jobs.forEach((j, i) => args.push('-map', `0:a:${j.t.index}`, '-vn', '-c:a', 'copy', parts[i]));
    try {
      await media.runFfmpeg(media.FFMPEG, args, { duration: src.duration, signal, onProgress: (p) => emit({ state: 'running', label: `${project.name} · ${g.label}`, within: p }) });
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        const dur = src.duration || 0;
        const ok = await playback.verifyM4a(parts[i], dur) && await playback.alignmentOk(parts[i], j.flac, dur);
        if (ok) {
          fs.renameSync(parts[i], j.m4a);
          const before = size(j.flac);
          fs.rmSync(j.flac, { force: true });
          freed += Math.max(0, before - size(j.m4a));
        } else {
          fs.rmSync(parts[i], { force: true });
          // typical for car cameras: their audio clock differs slightly from the video timestamps, so a plain copy
          // would drift against the other cameras. The lossless copy is kept (and made smaller below).
          skipped.push(`${g.label}: kept a lossless copy of one track (a plain copy of the original would drift out of sync)`);
        }
      }
    } catch (e) {
      parts.forEach((p) => fs.rmSync(p, { force: true }));
      if (e.message === 'cancelled') throw e;
      skipped.push(`${g.label}: ${e.message}`);
    }
    tick();
  }
  // Remaining lossless copies: store as 16-bit (same samples and length, about a third smaller).
  for (const g of project.groups || []) {
    for (const t of g.tracks || []) {
      if (signal.aborted) throw new Error('cancelled');
      const p = t.silent ? null : playback.playbackPath(t);
      if (p && p.endsWith('.flac')) { emit({ state: 'running', label: `${project.name} · ${g.label} (making a lossless copy smaller)`, within: 1 }); freed += await playback.flacTo16(p); }
    }
  }
  return { freed, skipped };
}

let current = null;

async function compactAll(ids, emit) {
  if (current) return;
  const ac = new AbortController();
  current = ac;
  let totalG = 0;
  for (const id of ids) { const p = store.load(id); if (p) totalG += plan(p).length; }
  totalG = Math.max(1, totalG);
  let doneG = 0, freed = 0;
  const skipped = [];
  try {
    for (const id of ids) {
      const base = () => doneG / totalG;
      const r = await compactProject(id, (m) => emit({ ...m, overall: Math.min(0.999, (doneG + (m.within || 0)) / totalG) }), ac.signal, () => { doneG++; emit({ state: 'running', overall: Math.min(0.999, base()), label: '' }); });
      freed += r.freed; skipped.push(...r.skipped);
    }
    emit({ state: 'finished', overall: 1, freed, skipped });
  } catch (e) {
    emit(e.message === 'cancelled' ? { state: 'cancelled', freed, skipped } : { state: 'error', error: e.message, freed, skipped });
  } finally { current = null; }
}

function cancel() { if (current) current.abort(); }
const busy = () => !!current;

module.exports = { estimate, compactAll, cancel, busy };
