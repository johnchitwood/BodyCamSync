'use strict';
const { parentPort } = require('worker_threads');
const dsp = require('./dsp');

parentPort.on('message', (job) => {
  try {
    const a = dsp.readWav(job.aPath).samples;
    const b = dsp.readWav(job.bPath).samples;
    const r = dsp.correlatePair(a, b);
    parentPort.postMessage({ id: job.id, result: r });
  } catch (e) {
    parentPort.postMessage({ id: job.id, error: String(e && e.stack || e) });
  }
});
