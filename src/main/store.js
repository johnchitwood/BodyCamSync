'use strict';
// Project state lives in the app's own data folder. The evidence folder is never written to.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let BASE = null;
function init(baseDir) { BASE = path.join(baseDir, 'projects'); fs.mkdirSync(BASE, { recursive: true }); }
function baseDir() { return path.dirname(BASE); }
function idFor(folder) { return crypto.createHash('sha1').update(path.resolve(folder)).digest('hex').slice(0, 12); }
// a hand-picked set of files is its own case, identified by exactly which files were picked
function idForFiles(files) { return crypto.createHash('sha1').update('files:' + [...files].map((f) => path.resolve(f)).sort().join('\n')).digest('hex').slice(0, 12); }
function dir(id) { const d = path.join(BASE, id); fs.mkdirSync(d, { recursive: true }); return d; }
function file(id) { return path.join(dir(id), 'project.json'); }

function load(id) {
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch (_) { return null; }
}
function save(id, project) {
  project.updatedAt = Date.now();
  const tmp = file(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(project));
  fs.renameSync(tmp, file(id));
}
function recents() {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(BASE, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const p = load(e.name);
    if (p && p.folder) out.push({ id: p.id, folder: p.folder, name: p.name, updatedAt: p.updatedAt || 0, cameras: (p.groups || []).length, exists: fs.existsSync(p.folder), selection: p.selection || null, cacheBytes: dirBytes(path.join(BASE, e.name)), proxyBytes: dirBytes(path.join(BASE, e.name, 'proxies')), audioBytes: dirBytes(path.join(BASE, e.name, 'audio')) });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
}
function dirBytes(d) {
  let total = 0;
  const walk = (p) => { let ents = []; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return; } for (const e of ents) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else { try { total += fs.statSync(q).size; } catch (_) { /* ignore */ } } } };
  walk(d);
  return total;
}
function cacheBytes(id) {
  let total = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (total += fs.statSync(p).size); } };
  try { walk(dir(id)); } catch (_) { /* ignore */ }
  return total;
}

module.exports = { init, baseDir, idFor, idForFiles, dir, load, save, recents, cacheBytes };
