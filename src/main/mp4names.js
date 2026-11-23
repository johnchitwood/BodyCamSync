'use strict';
// Reads per-track "name" atoms (e.g. cabinCamera, wired1, front) straight from the MP4 structure.
// Older ffprobe builds don't surface these, and they tell us which microphone a track is.
const fsp = require('fs/promises');

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'udta']);

function walk(buf, start, end, cb, depth = 0) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); hdr = 16; }
    else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) break;
    cb(type, pos + hdr, pos + size, depth);
    if (CONTAINERS.has(type)) walk(buf, pos + hdr, pos + size, cb, depth + 1);
    pos += size;
  }
}

async function readSoundTrackNames(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    let pos = 0;
    let moov = null;
    while (pos + 8 <= size) {
      await fh.read(head, 0, 16, pos);
      let sz = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let hdr = 8;
      if (sz === 1) { sz = Number(head.readBigUInt64BE(8)); hdr = 16; }
      else if (sz === 0) sz = size - pos;
      if (sz < 8) break;
      if (type === 'moov') { moov = { pos: pos + hdr, len: sz - hdr }; break; }
      pos += sz;
    }
    if (!moov || moov.len > 64 << 20) return [];
    const buf = Buffer.alloc(moov.len);
    await fh.read(buf, 0, moov.len, moov.pos);

    const tracks = [];
    let cur = null;
    walk(buf, 0, buf.length, (type, s, e, depth) => {
      if (type === 'trak') { cur = { handler: '', name: '' }; tracks.push(cur); }
      else if (cur && type === 'hdlr' && e - s >= 12) cur.handler = buf.toString('latin1', s + 8, s + 12);
      else if (cur && type === 'name') cur.name = buf.toString('utf8', s, e).replace(/[\u0000-\u001f]/g, '').trim();
    });
    return tracks.filter((t) => t.handler === 'soun').map((t) => t.name);
  } catch (_) {
    return [];
  } finally {
    if (fh) await fh.close();
  }
}

module.exports = { readSoundTrackNames };
