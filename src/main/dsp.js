'use strict';
// Audio cross-correlation used to line cameras up.
//
// Convention (same as the Python prototype): the result `lag` (seconds) satisfies
//   b(t) = a(t - lag)
// so camera B starts (lag * -1) seconds after camera A on a shared timeline.

const fs = require('fs');

// ---------- WAV ----------
function readWav(path) {
  const buf = fs.readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a wav: ' + path);
  let off = 12;
  let rate = 16000;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
    if (id === 'data') {
      const start = off + 8;
      // ffmpeg may write a placeholder size when streaming; clamp to the file.
      if (start + size > buf.length || size === 0xffffffff) size = buf.length - start;
      size -= size % 2;
      const ab = buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + size);
      return { rate, samples: new Int16Array(ab) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk: ' + path);
}

// ---------- FFT (in place, radix-2, Float32) ----------
const twCache = new Map();
function twiddles(n) {
  let t = twCache.get(n);
  if (t) return t;
  const half = n >> 1;
  const cos = new Float32Array(half);
  const sin = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    const a = (-2 * Math.PI * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
  t = { cos, sin };
  // keep the few most recent sizes (one whole-recording size and one window size per pair) to bound memory
  if (twCache.size >= 3) twCache.delete(twCache.keys().next().value);
  twCache.set(n, t);
  return t;
}

function fft(re, im) {
  const n = re.length;
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = cos[w], wi = sin[w];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// GCC-PHAT of two real signals using one packed complex FFT and one inverse.
// Returns Float32Array cc of length nfft. cc[k] (k < nfft/2) is lag +k samples,
// cc[nfft - k] is lag -k samples, with b(n) = a(n - lag).
function gccPhat(a, b, nfft) {
  const re = new Float32Array(nfft);
  const im = new Float32Array(nfft);
  re.set(a.subarray(0, Math.min(a.length, nfft)));
  im.set(b.subarray(0, Math.min(b.length, nfft)));
  fft(re, im);
  const N = nfft;
  for (let k = 0; k <= N >> 1; k++) {
    const k2 = (N - k) & (N - 1);
    const zr = re[k], zi = im[k], yr = re[k2], yi = im[k2];
    // A = (Z[k] + conj(Z[N-k])) / 2 ; B = (Z[k] - conj(Z[N-k])) / (2i)
    const ar = (zr + yr) * 0.5, ai = (zi - yi) * 0.5;
    const br = (zi + yi) * 0.5, bi = -(zr - yr) * 0.5;
    // R = B * conj(A)
    let rr = br * ar + bi * ai;
    let ri = bi * ar - br * ai;
    const mag = Math.sqrt(rr * rr + ri * ri) + 1e-12;
    rr /= mag; ri /= mag;
    re[k] = rr; im[k] = ri;
    re[k2] = rr; im[k2] = -ri; // cc is real => R[N-k] = conj(R[k])
  }
  // inverse via forward FFT of conj(R); result is real
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / N;
  for (let i = 0; i < N; i++) re[i] *= inv;
  return re;
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

function toFloat(samples, factor = 1) {
  // optional crude decimation by averaging `factor` samples (acts as a mild low-pass)
  const n = Math.floor(samples.length / factor);
  const out = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += samples[i * factor + j];
    out[i] = s / factor;
    mean += out[i];
  }
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) out[i] -= mean;
  return out;
}

// Peaks of cc over lag range. Returns [{lag (samples), value}] best-first, separated by minSep samples.
function topPeaks(cc, nfft, lo, hi, count, minSep) {
  // Candidate lags in [lo, hi]
  const peaks = [];
  const consider = (lag, v) => {
    for (const p of peaks) if (Math.abs(p.lag - lag) < minSep) {
      if (v > p.value) { p.lag = lag; p.value = v; }
      return;
    }
    peaks.push({ lag, value: v });
    peaks.sort((x, y) => y.value - x.value);
    if (peaks.length > count) peaks.length = count;
  };
  // fast pre-filter using a running threshold
  let thresh = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    const v = cc[lag >= 0 ? lag : nfft + lag];
    if (v > thresh) {
      consider(lag, v);
      if (peaks.length >= count) thresh = peaks[peaks.length - 1].value * 0.999;
    }
  }
  return peaks;
}

function median(arr) {
  const s = Array.from(arr).sort((x, y) => x - y);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : NaN;
}

function parabolic(cc, nfft, lag) {
  const at = (l) => cc[l >= 0 ? l : nfft + l];
  const y0 = at(lag - 1), y1 = at(lag), y2 = at(lag + 1);
  const d = y0 - 2 * y1 + y2;
  if (Math.abs(d) < 1e-12) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d));
}

// Refine/validate a candidate lag with many short windows at full 16 kHz.
function validateCandidate(a16, b16, sr, lagSec, opts) {
  const winLen = Math.floor(opts.winSec * sr);
  const margin = Math.floor(opts.marginSec * sr);
  const lagS = Math.round(lagSec * sr);
  const nfft = nextPow2(winLen + winLen + 2 * margin);
  // A window starts s must satisfy: B segment [s+lag-margin, s+lag+win+margin] within B, and s within A.
  const sMin = Math.max(0, margin - lagS);
  const sMax = Math.min(a16.length - winLen, b16.length - winLen - margin - lagS);
  if (sMax <= sMin) return { windows: [], good: [] };
  const n = opts.windows;
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = Math.floor(sMin + ((sMax - sMin) * (i + 0.5)) / n);
    const bs = s + lagS - margin;
    if (bs < 0) continue;
    const aw = a16.subarray(s, s + winLen);
    const bw = b16.subarray(bs, Math.min(b16.length, bs + winLen + 2 * margin));
    // skip near-silent windows
    let e = 0;
    for (let k = 0; k < aw.length; k += 16) e += aw[k] * aw[k];
    if (e / (aw.length / 16) < 25) { out.push({ t: s / sr, ok: false, why: 'quiet' }); continue; }
    const cc = gccPhat(aw, bw, nfft);
    // valid local lags: global lag within +-margin of candidate => local tau in [-2*margin, 0]+? compute directly
    // b(n) = a(n - tau_local) over segment; global lag = tau_local + (bs - s)
    const base = bs - s;
    const centerLocal = lagS - base; // expected tau_local
    let best = -Infinity, bestL = 0, sum = 0, sum2 = 0, cnt = 0;
    for (let L = centerLocal - margin; L <= centerLocal + margin; L++) {
      const v = cc[L >= 0 ? L : nfft + L];
      sum += v; sum2 += v * v; cnt++;
      if (v > best) { best = v; bestL = L; }
    }
    const mean = sum / cnt;
    const sd = Math.sqrt(Math.max(1e-18, sum2 / cnt - mean * mean));
    const z = (best - mean) / sd;
    const frac = parabolic(cc, nfft, bestL);
    const lag = (bestL + frac + base) / sr;
    out.push({ t: s / sr, ok: true, lag, z });
  }
  return { windows: out };
}

function evaluate(windows, zMin, agreeSec) {
  const good = windows.filter((w) => w.ok && w.z >= zMin);
  if (!good.length) return { good: 0, agree: 0, lag: NaN, spreadMs: NaN, total: windows.filter((w) => w.ok).length, used: [] };
  const med = median(good.map((w) => w.lag));
  const used = good.filter((w) => Math.abs(w.lag - med) <= agreeSec);
  const lag = median(used.map((w) => w.lag));
  const mad = median(used.map((w) => Math.abs(w.lag - lag)));
  return { good: good.length, agree: used.length, lag, spreadMs: mad * 1.4826 * 1000, total: windows.filter((w) => w.ok).length, used };
}

function slope(used) {
  // robust-ish slope in parts per million (lag change per second of A time)
  if (used.length < 4) return 0;
  const xs = used.map((w) => w.t), ys = used.map((w) => w.lag);
  const mx = xs.reduce((p, c) => p + c, 0) / xs.length, my = ys.reduce((p, c) => p + c, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? (num / den) * 1e6 : 0;
}

// Main entry: samples are Int16Array at 16 kHz.
// The whole-recording search only has to land within the validation margin (1 s), so it runs at 1 kHz; the result
// is then measured at full 16 kHz in 36 windows exactly as before. If that doesn't give a clear match, the search is
// repeated at 4 kHz (the earlier setting) and the better of the two is kept, so a hard pair gets at least the same
// effort as before.
function correlatePair(a16i, b16i, opts = {}) {
  if (opts.coarseFactor) return correlateAt(a16i, b16i, opts);
  const fast = correlateAt(a16i, b16i, { ...opts, coarseFactor: 16 });
  if (fast.ok && fast.agree >= 8 && fast.agree / Math.max(1, fast.good) >= 0.8) return fast;
  const slow = correlateAt(a16i, b16i, { ...opts, coarseFactor: 4 });
  if (!fast.ok) return slow;
  if (!slow.ok) return fast;
  return slow.score > fast.score ? slow : fast;
}

function correlateAt(a16i, b16i, opts = {}) {
  const sr = 16000;
  const cfg = Object.assign({ winSec: 15, marginSec: 1.0, windows: 36, zMin: 7, agreeSec: 0.03, minAgree: 3, minFrac: 0.5, coarseFactor: 16, candidates: 4 }, opts);
  const factor = cfg.coarseFactor;
  const csr = sr / factor;
  const aC = toFloat(a16i, factor), bC = toFloat(b16i, factor);
  const nfft = nextPow2(aC.length + bC.length);
  const cc = gccPhat(aC, bC, nfft);
  const peaks = topPeaks(cc, nfft, -(aC.length - 1), bC.length - 1, cfg.candidates, Math.floor(0.5 * csr));
  const a16 = toFloat(a16i, 1), b16 = toFloat(b16i, 1);
  let best = null;
  const tried = [];
  for (const p of peaks) {
    const lagSec = p.lag / csr;
    const { windows } = validateCandidate(a16, b16, sr, lagSec, cfg);
    const ev = evaluate(windows, cfg.zMin, cfg.agreeSec);
    tried.push({ coarseLag: lagSec, good: ev.good, agree: ev.agree, total: ev.total, lag: ev.lag });
    if (ev.agree >= cfg.minAgree && (!best || ev.agree > best.ev.agree)) best = { ev, coarse: lagSec, windows };
    if (best && best.ev.agree >= cfg.minAgree && best.ev.agree / Math.max(1, best.ev.good) >= 0.8 && best.ev.agree >= 8) break;
  }
  if (!best) return { ok: false, tried, aDur: a16i.length / sr, bDur: b16i.length / sr };
  const ev = best.ev;
  const frac = ev.agree / Math.max(1, ev.total);
  const score = ev.agree * Math.min(1, ev.good ? ev.agree / ev.good : 0);
  return {
    ok: ev.agree / Math.max(1, ev.good) >= cfg.minFrac,
    lag: ev.lag, // seconds, b(t) = a(t - lag)
    spreadMs: ev.spreadMs,
    agree: ev.agree, good: ev.good, total: ev.total, fracOfWindows: frac, score,
    driftPpm: slope(ev.used),
    coarse: best.coarse, coarseFactor: factor, tried,
    aDur: a16i.length / sr, bDur: b16i.length / sr,
    points: ev.used.map((w) => ({ t: w.t, lag: w.lag })),
  };
}

// Loudness envelope for the timeline: RMS per `hop` seconds, quantised to 0..255.
function envelope(a16i, sr = 16000, hop = 0.25) {
  const h = Math.floor(sr * hop);
  const n = Math.floor(a16i.length / h);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * h;
    for (let j = 0; j < h; j += 4) { const v = a16i[o + j]; s += v * v; }
    out[i] = Math.sqrt(s / (h / 4));
  }
  return out;
}

function rms(a16i) {
  let s = 0, c = 0;
  for (let i = 0; i < a16i.length; i += 7) { s += a16i[i] * a16i[i]; c++; }
  return Math.sqrt(s / Math.max(1, c));
}

module.exports = { readWav, correlatePair, envelope, rms };
