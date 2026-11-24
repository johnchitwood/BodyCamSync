'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('BodyCamSync');

const store = require('./store');
const analyzer = require('./analyze');
const media = require('./media');
const compact = require('./compact');
const jobs = require('./jobs');
const transcribe = require('./transcribe');
const speakers = require('./speakers');
const review = require('./review');

let win = null;
const DEBUG = !!process.env.BCS_DEBUG;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const IS_MAC = process.platform === 'darwin';
// Windows/Linux draw the system window buttons over the right end of our title bar. That title bar is
// always paper on these systems, with near-black button symbols, so the buttons never land on navy.
// (Recolouring the buttons at runtime with setTitleBarOverlay is unreliable on Windows: the symbols
// could stay dark on the navy bar until hovered, which made minimize and maximize invisible.)
const PAPER = { color: '#f6f7f5', symbolColor: '#0b1118', height: 44 };

function createWindow() {
  win = new BrowserWindow({
    width: 1520,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d0e10',
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 17 } }
      // Windows/Linux: our own title bar, with the system window buttons drawn over its right end
      : { titleBarStyle: 'hidden', titleBarOverlay: PAPER, autoHideMenuBar: true }),
    title: 'BodyCamSync',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: [`--bcs-platform=${process.platform}`, `--bcs-debug=${DEBUG ? 1 : 0}`, `--bcs-autotest=${process.env.BCS_AUTOTEST || ''}`],
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (DEBUG && process.env.BCS_AUTOTEST) {
    win.webContents.once('did-finish-load', () => {
      const code = fs.readFileSync(process.env.BCS_AUTOTEST, 'utf8');
      win.webContents.executeJavaScript(code).catch((e) => { console.error('AUTOTEST ERROR', e); app.exit(1); });
    });
  }
  if (process.env.BCS_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  const template = [
    ...(IS_MAC ? [{ label: 'BodyCamSync', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open') },
      { label: 'Open Files…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('menu:openFiles') },
      { type: 'separator' }, IS_MAC ? { role: 'close' } : { role: 'quit', label: 'Exit' },
    ] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { type: 'separator' }, { role: 'toggleDevTools' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, ...(IS_MAC ? [{ role: 'zoom' }] : [])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { jobs.cancelProxies(); jobs.cancelHash(); app.quit(); });

// ---------- IPC ----------
ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder of videos', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('recents:list', () => store.recents().map((r) => ({ ...r, shrinkBytes: compact.estimate(r.id) })));
ipcMain.handle('compact:start', (_e, ids) => {
  const valid = (Array.isArray(ids) ? ids : []).filter((id) => /^[a-f0-9]{8,16}$/.test(String(id)));
  compact.compactAll(valid, (m) => send('compact:progress', m));
  return true;
});
ipcMain.handle('compact:cancel', () => { compact.cancel(); return true; });

ipcMain.handle('dialog:openFiles', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose video files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'avi', 'mts', 'm2ts', 'wmv', 'webm'] }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths;
});

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };

// `target` is a folder path, a single file path, or a list of files/folders.
ipcMain.handle('project:open', async (_e, target, opts = {}) => {
  try {
    const list = Array.isArray(target) ? target : [target];
    let folder, files = null;
    if (list.length === 1 && isDir(list[0])) folder = list[0];
    else {
      files = media.expandPaths(list);
      if (!files.length) throw new Error('No video files found in the selection.');
      folder = media.commonDir(files);
    }
    const project = await analyzer.analyze(folder, { emit: (m) => send('analysis:progress', m), force: !!opts.force, files });
    return { ok: true, project: analyzer.decorate(project) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Remove files the app made on this computer. Never touches originals, transcripts, speaker data or edits.
ipcMain.handle('cache:clear', (_e, id, kinds = {}) => {
  if (!/^[a-f0-9]{8,16}$/.test(String(id))) return false;
  const d = store.dir(id);
  if (kinds.proxies) fs.rmSync(path.join(d, 'proxies'), { recursive: true, force: true });
  if (kinds.audio) fs.rmSync(path.join(d, 'audio'), { recursive: true, force: true });
  return true;
});
ipcMain.handle('project:get', (_e, id) => { const p = store.load(id); return p ? analyzer.decorate(p) : null; });
ipcMain.handle('project:setNudge', (_e, id, groupId, seconds) => {
  const p = store.load(id); if (!p) return false;
  p.nudges = p.nudges || {};
  if (!seconds) delete p.nudges[groupId]; else p.nudges[groupId] = seconds;
  store.save(id, p); return true;
});
ipcMain.handle('project:setPrefs', (_e, id, prefs) => {
  const p = store.load(id); if (!p) return false;
  p.prefs = prefs; store.save(id, p); return true;
});
ipcMain.handle('proxy:build', (_e, id, groupId, angle) => { jobs.buildProxy(id, groupId, angle, (m) => send('proxy:progress', m)); return true; });
ipcMain.handle('proxy:cancel', () => { jobs.cancelProxies(); return true; });
ipcMain.handle('proxy:remove', (_e, id) => { jobs.removeProxies(id); return true; });
ipcMain.handle('disk:free', () => ({ free: jobs.freeBytes() }));
ipcMain.handle('hash:start', (_e, id) => { jobs.hashFiles(id, (m) => send('hash:progress', m)); return true; });
ipcMain.handle('hash:cancel', () => { jobs.cancelHash(); return true; });
ipcMain.handle('transcript:status', () => transcribe.status());
ipcMain.handle('transcript:get', (_e, id) => transcribe.getTranscripts(id));
ipcMain.handle('transcript:start', (_e, id) => { transcribe.transcribeProject(id, (m) => send('transcript:progress', m)); return true; });
ipcMain.handle('transcript:cancel', () => { transcribe.cancel(); return true; });
ipcMain.handle('transcript:downloadModel', () => { transcribe.downloadModels((m) => send('transcript:model', m)); return true; });
ipcMain.handle('review:get', (_e, id) => review.load(id));
ipcMain.handle('review:save', (_e, id, data) => review.save(id, data));
ipcMain.handle('speakers:status', () => speakers.status());
ipcMain.handle('speakers:get', (_e, id) => speakers.getSpeakers(id));
ipcMain.handle('speakers:start', (_e, id) => { speakers.diarizeProject(id, (m) => send('speakers:progress', m)); return true; });
ipcMain.handle('speakers:cancel', () => { speakers.cancel(); return true; });
ipcMain.handle('speakers:downloadModels', () => { speakers.downloadModels((m) => send('speakers:model', m)); return true; });
ipcMain.handle('transcript:export', async (_e, suggested, text) => {
  const r = await dialog.showSaveDialog(win, { title: 'Export transcript', defaultPath: path.join(app.getPath('documents'), suggested), filters: [{ name: 'Text', extensions: ['txt'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, 'utf8');
  return r.filePath;
});
// Kept for older renderers; the window buttons now keep one fixed, high-contrast colour.
ipcMain.handle('ui:chrome', () => true);
ipcMain.handle('shell:reveal', (_e, p) => { shell.showItemInFolder(p); return true; });

// ---------- debug / automation (only with BCS_DEBUG=1) ----------
if (DEBUG) {
  ipcMain.handle('debug:capture', async (_e, file) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    return file;
  });
  ipcMain.handle('debug:write', (_e, file, text) => { fs.writeFileSync(file, text); return true; });
  ipcMain.handle('debug:readB64', (_e, file) => fs.readFileSync(file).toString('base64'));
  ipcMain.handle('debug:quit', () => { app.quit(); return true; });
  ipcMain.handle('debug:resize', (_e, w, h) => { win.setSize(w, h); return true; });
}
