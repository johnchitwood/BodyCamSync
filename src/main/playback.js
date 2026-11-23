'use strict';
// The audio you listen to during playback.
//
// Preferred: the ORIGINAL audio track copied out of the video unchanged (AAC in an .m4a). It is exactly what the
// camera recorded and tiny (~15 MB for 40 minutes). But a plain copy is only trusted if it lines up with the
// timeline used for sync and transcripts over the WHOLE recording: some cameras' audio clocks run a few ppm
// off their video timestamps, and decoding corrects that while a copy would not (measured: 12 ms by the end of
// a car recording). Anything that fails the check keeps a lossless 16-bit FLAC copy instead.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const media = require('./media');

const COPY_CODECS = new Set(['aac']);
const canCopy = (audioInfo) => !!audioInfo && COPY_CODECS.has(audioInfo.codec);
const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };

function playbackPath(t) {
  if (!t || !t.wav) return null;
  const dir = path.dirname(t.wav);
  for (const ext of ['m4a', 'flac']) {
    const p = path.join(dir, `p${t.index}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function durationOf(file) {
  try { return Number(((await media.probe(file)).format || {}).duration) || 0; } catch (_) { return 0; }
}

// A copied track must start at time zero, have the right length, and decode cleanly.
async function verifyM4a(p, expectedDur) {
  try {
    const info = await media.probe(p);
    const a = (info.streams || []).find((s) => s.codec_type === 'audio');
    if (!a) return false;
    if (Math.abs(Number(a.start_time) || 0) > 0.001) return false;
    const d = Number((info.format || {}).duration) || 0;
    if (expectedDur && Math.abs(d - expectedDur) > 0.5) return false;
    await media.runFfmpeg(media.FFMPEG, ['-i', p, '-f', 'null', '-'], {});
    return true;
  } catch (_) { return false; }
}

function pcm8k(file, start, secs) {
  return new Promise((resolve) => {
    execFile(media.FFMPEG, ['-v', 'error', '-ss', String(Math.max(0, start)), '-t', String(secs), '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 }, (err, out) => {
      if (err || !out) return resolve(null);
      resolve(new Int16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length - (out.length % 2))));
    });
  });
}

// Does `copy` line up with `ref` (the analysis/lossless audio) along the whole recording?
//  1. Lengths agree to within 3 ms (a clock mismatch stretches one of them).
//  2. Loud stretches near the start and near the end match to within 1 ms.
async function alignmentOk(copy, ref, dur) {
  const [dc, dr] = await Promise.all([durationOf(copy), durationOf(ref)]);
  if (!dc || !dr || Math.abs(dc - dr) > 0.003) return false;
  let compared = 0;
  for (const frac of [0.9, 0.25, 0.6, 0.45, 0.75]) {
    const t = Math.max(1, Math.min(dur - 13, dur * frac));
    const [a, b] = await Promise.all([pcm8k(copy, t - 1, 12), pcm8k(ref, t, 10)]);
    if (!a || !b) return false;
    const n = Math.min(b.length, 8000 * 10) - 100;
    if (n < 4000 || a.length < 8000 + n + 200) return false;
    let e = 0; for (let i = 50; i < n; i += 4) e += b[i] * b[i];
    if (e / (n / 4) < 300) continue; // too quiet to tell
    let nb = 0; for (let i = 50; i < n; i += 2) nb += b[i] * b[i];
    let best = -Infinity, bl = 0, bna = 0;
    for (let lag = -160; lag <= 160; lag++) {
      let s = 0, na = 0;
      for (let i = 50; i < n; i += 2) { const x = a[i + 8000 + lag]; s += x * b[i]; na += x * x; }
      if (s > best) { best = s; bl = lag; bna = na; }
    }
    const corr = best / Math.sqrt((bna * nb) || 1);
    if (Math.abs(bl) > 8 || corr < 0.9) return false; // 8 samples at 8 kHz = 1 ms
    if (++compared >= 2) return true;
  }
  return true;
}

// 24-bit FLAC copies are about a third larger than they need to be for audio that began as AAC.
// Re-encode as 16-bit FLAC (same samples, same length); returns bytes saved.
async function flacTo16(flac) {
  try {
    const info = await media.probe(flac);
    const a = (info.streams || []).find((s) => s.codec_type === 'audio');
    if (!a || a.codec_name !== 'flac') return 0;
    const bits = Number(a.bits_per_raw_sample) || (a.sample_fmt === 's16' ? 16 : 24);
    if (bits <= 16) return 0;
    const tmp = flac + '.tmp16.flac';
    await media.runFfmpeg(media.FFMPEG, ['-y', '-i', flac, '-vn', '-c:a', 'flac', '-sample_fmt', 's16', '-compression_level', '4', tmp], {});
    const [d1, d2] = await Promise.all([durationOf(flac), durationOf(tmp)]);
    if (!d1 || Math.abs(d1 - d2) > 0.001) { fs.rmSync(tmp, { force: true }); return 0; }
    const before = size(flac);
    fs.renameSync(tmp, flac);
    return Math.max(0, before - size(flac));
  } catch (_) { return 0; }
}

module.exports = { canCopy, playbackPath, durationOf, verifyM4a, alignmentOk, flacTo16 };
