'use strict';
// Renders build/icon.png (1024px) using Electron's own renderer. Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<!doctype html><html><body style="margin:0;background:transparent">
<canvas id="c" width="1024" height="1024"></canvas>
<script>
const c = document.getElementById('c'), x = c.getContext('2d');
const rr = (px, py, w, h, r) => { x.beginPath(); x.roundRect(px, py, w, h, r); };
// macOS-style squircle plate
rr(100, 100, 824, 824, 190);
const g = x.createLinearGradient(0, 100, 0, 924); g.addColorStop(0, '#1b1e23'); g.addColorStop(1, '#0f1114');
x.fillStyle = g; x.fill();
x.lineWidth = 3; x.strokeStyle = 'rgba(255,255,255,0.07)'; x.stroke();
// four camera frames on one clock
const s = 262, gap = 40, ox = 512 - s - gap / 2, oy = 512 - s - gap / 2;
const cols = ['#6aa5ff', '#f0a35e', '#55c7a2', '#c58bf2'];
for (let i = 0; i < 4; i++) {
  const px = ox + (i % 2) * (s + gap), py = oy + Math.floor(i / 2) * (s + gap);
  rr(px, py, s, s, 46);
  x.fillStyle = i === 0 ? cols[0] : 'rgba(255,255,255,0.10)'; x.fill();
  // a small audio-lane bar in each camera's colour
  rr(px + 36, py + s - 66, s - 72, 20, 10);
  x.fillStyle = i === 0 ? 'rgba(10,18,32,0.35)' : cols[i] + 'cc'; x.fill();
}
// shared playhead
x.fillStyle = '#ffffff';
rr(512 - 7, 170, 14, 684, 7); x.fill();
x.beginPath(); x.moveTo(512 - 34, 160); x.lineTo(512 + 34, 160); x.lineTo(512, 206); x.closePath(); x.fill();
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.png'), img.toPNG());
  app.quit();
});
