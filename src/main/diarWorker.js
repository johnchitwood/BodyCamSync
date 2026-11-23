'use strict';
// Runs in its own process so a problem in the native speaker library can never take the app down.
// Input (IPC): { wav, segModel, embModel, threshold, minClusterSec }
// Output: { segments: [{ s, e, c }], clusters: [{ c, sec, n, rms }] }  (c = -1 means "other / minor voices")
const sherpa = require('sherpa-onnx-node');
const fs = require('fs');

function readWavInt16(path) {
  const buf = fs.readFileSync(path);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const start = off + 8;
      if (start + size > buf.length || size === 0xffffffff) size = buf.length - start;
      size -= size % 2;
      return new Int16Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + size));
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

process.on('message', (job) => {
  try {
    const sd = new sherpa.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: job.segModel }, numThreads: 4, debug: false, provider: 'cpu' },
      embedding: { model: job.embModel, numThreads: 4, debug: false, provider: 'cpu' },
      clustering: { numClusters: -1, threshold: job.threshold },
      minDurationOn: 0.3,
      minDurationOff: 0.5,
    });
    // Decode the audio ourselves: the library's own wav reader hands back memory that Electron forbids.
    const pcm = readWavInt16(job.wav);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
    const wave = { samples, sampleRate: 16000 };
    let last = -1;
    const raw = sd.process(wave.samples, (done, total) => {
      const p = Math.floor((100 * done) / total);
      if (p !== last) { last = p; process.send({ progress: p / 100 }); }
      return 0;
    });

    // total speech and loudness per voice
    const sr = wave.sampleRate;
    const stats = new Map();
    for (const s of raw) {
      const st = stats.get(s.speaker) || { sec: 0, n: 0, sq: 0, cnt: 0 };
      st.sec += s.end - s.start; st.n++;
      const a = Math.max(0, Math.floor(s.start * sr)), b = Math.min(pcm.length, Math.floor(s.end * sr));
      for (let i = a; i < b; i += 5) { st.sq += pcm[i] * pcm[i]; st.cnt++; }
      stats.set(s.speaker, st);
    }
    // Minor voices (a few seconds in total) are noise more often than people: fold them into "other".
    const major = [...stats.entries()].filter(([, st]) => st.sec >= job.minClusterSec).sort((x, y) => y[1].sec - x[1].sec);
    const remap = new Map(major.map(([k], i) => [k, i]));
    const segments = raw.map((s) => ({ s: Math.round(s.start * 100) / 100, e: Math.round(s.end * 100) / 100, c: remap.has(s.speaker) ? remap.get(s.speaker) : -1 }));
    const clusters = major.map(([, st], i) => ({ c: i, sec: Math.round(st.sec), n: st.n, rms: Math.round(Math.sqrt(st.sq / Math.max(1, st.cnt))) }));
    let osec = 0, on = 0; for (const [k, st] of stats) if (!remap.has(k)) { osec += st.sec; on += st.n; }
    if (on) clusters.push({ c: -1, sec: Math.round(osec), n: on, rms: 0 });
    process.send({ done: true, segments, clusters });
  } catch (e) {
    process.send({ error: String((e && e.stack) || e) });
  }
});
