'use strict';
// Automatic updates from the public GitHub Releases page.
//
// The installed Windows app (the -Setup.exe version) checks GitHub a few seconds after it starts. If a newer
// regular release exists (pre-releases are skipped), it downloads the new installer in the background and then
// asks whether to restart now. If the user picks "Later", the update installs the next time the app is closed.
//
// The portable zip copy, the Mac build and `npm start` cannot update themselves: for those, "Check for
// Updates…" opens the Releases page instead.
const { app, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const RELEASES_URL = 'https://github.com/johnchitwood/BodyCamSync/releases';
const STARTUP_DELAY_MS = 8000;

let updater = null;      // electron-updater's autoUpdater, loaded only where it can work
let getWin = () => null;
let manual = false;      // the current check was started from the Help menu, so report every outcome
let checking = false;
let downloaded = null;   // version that is downloaded and ready to install

// Only an installed copy can replace itself: the NSIS installer leaves its uninstaller next to the app.
function canSelfUpdate() {
  if (!app.isPackaged || process.platform !== 'win32') return false;
  return fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`));
}

function box(opts) {
  const win = getWin();
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

function askToRestart(version) {
  box({
    type: 'info', title: 'Update Ready', buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1,
    message: `BodyCamSync ${version} is ready to install.`,
    detail: 'Restart now to finish updating. If you choose Later, the update installs the next time you close BodyCamSync.\n\nAny transcription or copy that is running will stop when the app restarts.',
  }).then(({ response }) => {
    // isSilent: install without showing the installer pages; isForceRunAfter: reopen the app afterwards
    if (response === 0) setImmediate(() => updater.quitAndInstall(true, true));
  });
}

function init(windowGetter) {
  getWin = windowGetter;
  if (!canSelfUpdate()) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) {
    console.error('updater unavailable', e);
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.logger = null;

  updater.on('update-available', (info) => {
    if (manual) box({ type: 'info', title: 'Update Available', buttons: ['OK'], message: `BodyCamSync ${info.version} is available.`, detail: 'It is downloading in the background. You will be asked to restart when it is ready.' });
  });
  updater.on('update-not-available', () => {
    if (manual) box({ type: 'info', title: 'No Updates', buttons: ['OK'], message: 'BodyCamSync is up to date.', detail: `You have version ${app.getVersion()}, the newest release.` });
    checking = false; manual = false;
  });
  updater.on('update-downloaded', (info) => {
    checking = false; manual = false;
    downloaded = info.version;
    askToRestart(info.version);
  });
  updater.on('error', (err) => {
    console.error('update check failed', err && err.message);
    if (manual) {
      box({ type: 'warning', title: 'Update Check Failed', buttons: ['Open Releases Page', 'Close'], defaultId: 1, cancelId: 1,
        message: 'BodyCamSync could not check for updates.', detail: `${(err && err.message || 'Unknown error').split('\n')[0]}\n\nYou can download the newest version from the Releases page.` })
        .then(({ response }) => { if (response === 0) shell.openExternal(RELEASES_URL); });
    }
    checking = false; manual = false;
  });

  // Quietly check once shortly after startup; failures (offline, GitHub down) are silent.
  setTimeout(() => check(false), STARTUP_DELAY_MS);
}

// Help ▸ Check for Updates…
function check(fromMenu = true) {
  if (!updater) {
    if (fromMenu) shell.openExternal(RELEASES_URL);
    return;
  }
  if (downloaded) { if (fromMenu) askToRestart(downloaded); return; }
  if (checking) {
    if (fromMenu) box({ type: 'info', title: 'Checking for Updates', buttons: ['OK'], message: 'BodyCamSync is already checking for an update.', detail: 'You will be told when it is ready.' });
    return;
  }
  checking = true; manual = fromMenu;
  updater.checkForUpdates().catch(() => { /* reported through the 'error' event */ });
}

module.exports = { init, check, canSelfUpdate };
