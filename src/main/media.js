'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------- binaries ----------
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}
function findBin(name) {
  const env = process.env['BCS_' + name.toUpperCase()];
  if (env && fs.existsSync(env)) return env;
  try {
    const p = unpacked(name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path);
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* fall through */ }
  const dirs = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const dir of dirs) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return name; // fall back to PATH
}
const FFMPEG = findBin('ffmpeg');
const FFPROBE = findBin('ffprobe');

let encoderCache = null;
// Hardware H.264 encoders worth trying, best first. Listing an encoder is not enough (a PC without the
// matching GPU still lists it), so each one is test-encoded for a fraction of a second before it is chosen.
const HW_ENCODERS = process.platform === 'darwin' ? ['h264_videotoolbox']
  : process.platform === 'win32' ? ['h264_nvenc', 'h264_qsv', 'h264_amf'] : [];
function testEncoder(bin, codec) {
  return new Promise((resolve) => {
    execFile(bin, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30:d=0.4', '-frames:v', '6', '-c:v', codec, '-pix_fmt', 'yuv420p', '-f', 'null', '-'],
      { timeout: 15000 }, (err) => resolve(!err));
  });
}
async function proxyEncoder() {
  if (encoderCache) return encoderCache;
  const bins = [FFMPEG];
  if (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/ffmpeg')) bins.push('/opt/homebrew/bin/ffmpeg');
  for (const bin of bins) {
    for (const codec of HW_ENCODERS) {
      if (await testEncoder(bin, codec)) { encoderCache = { bin, codec }; return encoderCache; }
    }
  }
  encoderCache = { bin: FFMPEG, codec: 'libx264' };
  return encoderCache;
}

// ---------- probing ----------
function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 1 << 26 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

const FRIENDLY_AUDIO = {
  cabincamera: 'Cabin mic',
  wired1: 'Officer mic',
  wired2: 'Officer mic 2',
  front: 'Body mic',
  rear: 'Rear mic',
};
function friendlyAudio(name, idx) {
  const k = String(name || '').toLowerCase();
  return FRIENDLY_AUDIO[k] || (name ? name : `Audio ${idx + 1}`);
}

function summarize(file, stat, info, trackNames = []) {
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).filter((s) => s.codec_type === 'audio').map((s, i) => ({
    index: i,
    streamIndex: s.index,
    name: (s.tags && s.tags.name) || trackNames[i] || '',
    friendly: friendlyAudio((s.tags && s.tags.name) || trackNames[i], i),
    channels: s.channels,
    codec: s.codec_name,
    rate: Number(s.sample_rate) || 0,
  }));
  const fmt = info.format || {};
  const encoder = (fmt.tags && fmt.tags.encoder) || (v && v.tags && v.tags.encoder) || '';
  const fr = (r) => { if (!r) return 0; const [a, b] = r.split('/').map(Number); return b ? a / b : 0; };
  return {
    summaryVersion: 3,
    path: file,
    name: path.basename(file),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    duration: Number(fmt.duration) || 0,
    width: v ? v.width : 0,
    height: v ? v.height : 0,
    codec: v ? v.codec_name : '',
    fps: v ? fr(v.r_frame_rate) : 0,
    avgFps: v ? fr(v.avg_frame_rate) : 0,
    frames: v ? Number(v.nb_frames) || 0 : 0,
    variableFrameRate: !!(v && Math.abs(fr(v.r_frame_rate) - fr(v.avg_frame_rate)) > 0.01),
    audio,
    encoder,
    derivative: /handbrake/i.test(encoder),
    createdTag: (fmt.tags && fmt.tags.creation_time) || '',
  };
}

// ---------- scanning ----------
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.avi', '.mts', '.m2ts', '.wmv', '.webm']);

function listVideos(root, maxDepth = 3) {
  const out = [];
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) walk(p, depth + 1); }
      else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  walk(root, 0);
  return out.sort();
}

// A selection can mix files and folders; folders contribute the videos inside them.
function expandPaths(paths) {
  const out = new Set();
  for (const p of paths) {
    let st; try { st = fs.statSync(p); } catch (_) { continue; }
    if (st.isDirectory()) listVideos(p).forEach((v) => out.add(v));
    else if (VIDEO_EXT.has(path.extname(p).toLowerCase()) && !path.basename(p).startsWith('.')) out.add(p);
  }
  return [...out].sort();
}
function commonDir(paths) {
  if (!paths.length) return '';
  const parts = paths.map((p) => path.dirname(path.resolve(p)).split(path.sep));
  let n = Math.min(...parts.map((x) => x.length)), i = 0;
  while (i < n && parts.every((x) => x[i] === parts[0][i])) i++;
  let common = parts[0].slice(0, i).join(path.sep) || path.sep;
  if (/^[A-Za-z]:$/.test(common)) common += path.sep; // a bare "C:" means "the current folder on C:", not its root
  return common;
}

// ---------- naming / grouping ----------
function prettyName(raw) {
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
}

// "EvanDavick_202505262200_CG71-1-2.mp4" -> officer, minute stamp, unit
function parseName(file) {
  const base = path.basename(file, path.extname(file));
  const m = base.match(/^(.+?)_(\d{12})_(.+)$/);
  if (!m) return { officer: '', stamp: null, rest: base, unit: base, suffix: '' };
  const rest = m[3];
  const unit = rest.replace(/(-\d+)+$/, '');
  const suffix = rest.slice(unit.length).replace(/^-/, '');
  const s = m[2];
  const epoch = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)) / 1000;
  return { officer: m[1], stamp: s, epoch, rest, unit, suffix };
}

function kindOf(unit) {
  if (/^BWC/i.test(unit) || /body/i.test(unit)) return 'bwc';
  if (/^(CG|ICV|CAR|VEH)/i.test(unit)) return 'incar';
  return 'other';
}

function groupFiles(files) {
  const map = new Map();
  for (const f of files) {
    const pn = parseName(f.path);
    const key = pn.stamp ? `${pn.officer}|${pn.stamp}|${pn.unit}` : `file|${f.name}`;
    if (!map.has(key)) map.set(key, { key, pn, files: [] });
    map.get(key).files.push({ ...f, suffix: pn.suffix });
  }
  const groups = [];
  for (const g of map.values()) {
    const kind = g.pn.stamp ? kindOf(g.pn.unit) : 'other';
    // order: originals first, then by resolution, then name
    g.files.sort((a, b) => (a.derivative - b.derivative) || ((b.width * b.height) - (a.width * a.height)) || a.name.localeCompare(b.name));
    g.files.forEach((f, i) => { f.angle = String.fromCharCode(65 + i); });
    const durations = g.files.map((f) => f.duration);
    groups.push({
      id: require('crypto').createHash('sha1').update(g.key).digest('hex').slice(0, 10),
      key: g.key,
      officer: g.pn.officer ? prettyName(g.pn.officer) : '',
      unit: g.pn.unit,
      kind,
      nominalStart: g.pn.epoch || null,
      duration: Math.max(...durations),
      files: g.files,
    });
  }
  // stable order: officer, kind (in-car first), unit
  groups.sort((a, b) => a.officer.localeCompare(b.officer) || (a.kind === 'incar' ? -1 : 1) - (b.kind === 'incar' ? -1 : 1) || a.unit.localeCompare(b.unit));
  // labels
  for (const g of groups) {
    const last = g.officer ? g.officer.split(' ').slice(-1)[0] : '';
    const kindLabel = g.kind === 'incar' ? 'In-car' : g.kind === 'bwc' ? 'Body camera' : '';
    g.label = [last, kindLabel].filter(Boolean).join(' · ') || g.files[0].name;
    g.sub = g.unit;
  }
  return groups;
}

// ---------- ffmpeg runner with progress ----------
function runFfmpeg(bin, args, { duration, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-nostdin', '-hide_banner', '-v', 'error', '-progress', 'pipe:1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    p.stderr.on('data', (d) => { err += d.toString(); });
    const onAbort = () => { try { p.kill('SIGKILL'); } catch (_) { /* ignore */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    p.on('error', reject);
    p.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(new Error('cancelled'));
      code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}

module.exports = { FFMPEG, FFPROBE, probe, summarize, listVideos, expandPaths, commonDir, groupFiles, runFfmpeg, proxyEncoder, parseName };
