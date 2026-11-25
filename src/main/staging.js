'use strict';
// Read each original from its drive only once.
//
// Making the analysis audio and making the local video copy each used to read the whole original, so on a network
// drive every file crossed the network twice (three times with fingerprints). Now, when a local video copy is going to
// be made, the original is copied once to a temporary file on this computer while the audio is being prepared, and
// its SHA-256 fingerprint is taken from that same read. The audio and the local video copy are both made from the
// temporary file, which is deleted as soon as the video copy is finished, cancelled, or turns out not to be needed.
// The original is only ever opened for reading.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline, Transform } = require('stream');
const store = require('./store');

const dirFor = (projectId) => path.join(store.dir(projectId), 'staging');
const pathFor = (projectId, groupId, angle, file) => path.join(dirFor(projectId), `${groupId}_${angle}${path.extname(file.path).toLowerCase()}`);

// The temporary copy for this camera file, if there is a complete one.
function find(projectId, groupId, angle, file) {
  const p = pathFor(projectId, groupId, angle, file);
  try { return fs.statSync(p).size === file.size ? p : null; } catch (_) { return null; }
}

// Copy `file` (a file summary: path, size, mtimeMs) into the staging folder. Resolves { path, sha256 }.
// The fingerprint is only returned if the original did not change while it was being read.
function stage(projectId, groupId, angle, file, { onProgress, signal } = {}) {
  const out = pathFor(projectId, groupId, angle, file);
  const part = out + '.part';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let n = 0, last = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        h.update(chunk); n += chunk.length;
        const now = Date.now();
        if (onProgress && file.size && now - last > 200) { last = now; onProgress(Math.min(1, n / file.size)); }
        cb(null, chunk);
      },
    });
    const rs = fs.createReadStream(file.path, { highWaterMark: 8 << 20 });
    const ws = fs.createWriteStream(part, { highWaterMark: 8 << 20 });
    const onAbort = () => rs.destroy(new Error('cancelled'));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    pipeline(rs, tap, ws, (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) { fs.rmSync(part, { force: true }); return reject(err); }
      let st;
      try { st = fs.statSync(file.path); } catch (e) { fs.rmSync(part, { force: true }); return reject(e); }
      const unchanged = st.size === file.size && Math.round(st.mtimeMs) === file.mtimeMs && n === file.size;
      if (!unchanged) { fs.rmSync(part, { force: true }); return reject(new Error('The original changed while it was being read.')); }
      fs.renameSync(part, out);
      if (onProgress) onProgress(1);
      resolve({ path: out, sha256: h.digest('hex') });
    });
  });
}

function remove(projectId, groupId, angle, file) {
  try { fs.rmSync(pathFor(projectId, groupId, angle, file), { force: true }); } catch (_) { /* in use; swept later */ }
}

// Delete temporary copies: for every case, or every case except `keepId`.
function sweep(keepId = null) {
  const base = path.join(store.baseDir(), 'projects');
  let ents = [];
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (!e.isDirectory() || e.name === keepId) continue;
    try { fs.rmSync(path.join(base, e.name, 'staging'), { recursive: true, force: true }); } catch (_) { /* in use */ }
  }
}

// Delete this case's temporary copies that no local-copy job has claimed. `claimed(groupId, angle)` says whether a
// job is queued or running for that camera file.
function sweepUnclaimed(projectId, claimed) {
  const d = dirFor(projectId);
  let names = [];
  try { names = fs.readdirSync(d); } catch (_) { return; }
  for (const name of names) {
    const m = name.match(/^([0-9a-f]+)_([A-Z])\./);
    if (m && !name.endsWith('.part') && claimed(m[1], m[2])) continue;
    try { fs.rmSync(path.join(d, name), { force: true }); } catch (_) { /* in use */ }
  }
}

module.exports = { find, stage, remove, sweep, sweepUnclaimed };
