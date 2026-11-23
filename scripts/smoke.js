'use strict';
// Platform smoke test (also run by the Windows build): ffmpeg/ffprobe run, the audio sync engine finds a
// known offset to the millisecond, the speech engine and the speaker-detection library load.
//   node scripts/smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const media = require('../src/main/media');
const dsp = require('../src/main/dsp');

let failed = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failed++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcs-smoke-'));
try {
  const ff = (args) => execFileSync(media.FFMPEG, ['-v', 'error', '-y', ...args], { stdio: 'pipe' });
  ok('ffmpeg runs', /ffmpeg version/.test(execFileSync(media.FFMPEG, ['-version']).toString()));
  ok('ffprobe runs', /ffprobe version/.test(execFileSync(media.FFPROBE, ['-version']).toString()));

  // Two recordings of the same 200 s of sound; the second starts 7.35 s later into it.
  const ref = path.join(tmp, 'ref.wav'), a = path.join(tmp, 'a.wav'), b = path.join(tmp, 'b.wav');
  ff(['-f', 'lavfi', '-i', 'anoisesrc=d=200:c=pink:r=16000:a=0.3:seed=7', '-ac', '1', '-c:a', 'pcm_s16le', ref]);
  ff(['-i', ref, '-t', '150', '-c:a', 'pcm_s16le', a]);
  ff(['-ss', '7.35', '-i', ref, '-t', '150', '-c:a', 'pcm_s16le', b]);
  const A = dsp.readWav(a), B = dsp.readWav(b);
  const r = dsp.correlatePair(A.samples || A, B.samples || B);
  ok('sync engine finds the offset', r.ok && Math.abs(Math.abs(r.lag) - 7.35) < 0.002, `lag=${r.lag && r.lag.toFixed(4)} s (expected ±7.35)`);

  // A path with spaces and non-ASCII characters (common on PCs)
  const odd = path.join(tmp, 'Reed, Rosemary é', 'Videos'); fs.mkdirSync(odd, { recursive: true });
  fs.copyFileSync(a, path.join(odd, 'clip a.wav'));
  ff(['-i', path.join(odd, 'clip a.wav'), '-t', '1', '-f', 'null', '-']);
  ok('ffmpeg reads paths with spaces and accents', true);
  const common = media.commonDir([path.join(odd, 'x.mp4'), path.join(odd, 'y.mp4')]);
  ok('commonDir', common === odd, common);
  if (process.platform === 'win32') ok('commonDir keeps a drive root', media.commonDir(['C:\\a.mp4', 'C:\\b.mp4']) === 'C:\\');

  // Speech engine
  require('../src/main/store').init(path.join(tmp, 'userdata')); // the app normally does this at start-up
  const t = require('../src/main/transcribe');
  const st = t.status();
  ok('speech engine (whisper) found', !!st.engine, st.engine || '');
  if (st.engine) {
    try { execFileSync(st.engine, ['-h'], { stdio: 'pipe' }); ok('speech engine starts', true); }
    catch (e) { ok('speech engine starts', /usage/i.test(String((e.stdout || '') + (e.stderr || ''))), 'exit ' + e.status); }
  }

  // Speaker detection library
  let sherpaOk = true, why = '';
  try { require('sherpa-onnx-node'); } catch (e) { sherpaOk = false; why = e.message.split('\n')[0]; }
  ok('speaker-detection library loads', sherpaOk, why);
} catch (e) {
  console.log('FAIL  ' + (e && e.message)); failed++;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
