'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');

const JOB_TYPES = new Set(['encode', 'decode']);
const jobs = new Map(); // job type -> { child, temps:Set, finished }

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 800,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#0e1016',
    title: 'Bin2PNG Studio',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Never navigate away or open new windows from the renderer.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function cleanupTemps(job) {
  for (const p of job.temps) fs.rm(p, { force: true }, () => {});
  job.temps.clear();
}

// ---------- IPC: dialogs & shell ----------

ipcMain.handle('dialog:pick', async (_e, mode) => {
  const props = {
    file: ['openFile'],
    files: ['openFile', 'multiSelections'],
    folder: ['openDirectory'],
    outputDir: ['openDirectory', 'createDirectory', 'promptToCreate'],
  }[mode];
  if (!props) return [];
  const filters =
    mode === 'files'
      ? [
          { name: 'PNG chunks / Google Photos ZIP', extensions: ['png', 'zip'] },
          { name: 'All files', extensions: ['*'] },
        ]
      : undefined;
  const res = await dialog.showOpenDialog(mainWindow, { properties: props, filters });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('fs:describe', async (_e, paths) => {
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    try {
      const st = await fs.promises.stat(p);
      out.push({ path: p, name: path.basename(p), dir: path.dirname(p), isDirectory: st.isDirectory(), size: st.size });
    } catch {
      /* ignore unreadable */
    }
  }
  return out;
});

ipcMain.handle('path:join', (_e, ...parts) => path.join(...parts.map(String)));

ipcMain.handle('shell:reveal', (_e, p) => {
  if (typeof p === 'string' && p) shell.showItemInFolder(p);
});

ipcMain.handle('shell:open', async (_e, p) => {
  if (typeof p === 'string' && p) return shell.openPath(p);
  return 'Invalid path';
});

// ---------- IPC: background jobs ----------

ipcMain.handle('job:start', (_e, type, options) => {
  if (!JOB_TYPES.has(type)) throw new Error(`Unknown job type: ${type}`);
  if (jobs.has(type)) throw new Error('A job of this type is already running');

  const child = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], {
    serviceName: `bin2png-${type}`,
    stdio: 'pipe',
  });
  const job = { child, temps: new Set(), finished: false, cancelled: false, stderr: '' };
  jobs.set(type, job);
  child.stdout?.on('data', (d) => process.stdout.write(d));
  child.stderr?.on('data', (d) => {
    process.stderr.write(d);
    job.stderr = (job.stderr + d.toString()).slice(-2000);
  });

  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'temp') job.temps.add(msg.path);
    else if (msg.type === 'progress') send('job:event', { type, event: 'progress', ...msg });
    else if (msg.type === 'done' || msg.type === 'error') {
      job.finished = true;
      job.temps.clear(); // the worker cleans up its own temp files on normal exit
      jobs.delete(type);
      send('job:event', msg.type === 'done' ? { type, event: 'done', result: msg.result } : { type, event: 'error', message: msg.message });
    }
  });

  child.on('exit', (code) => {
    if (job.finished) return;
    cleanupTemps(job);
    jobs.delete(type);
    send('job:event', job.cancelled
      ? { type, event: 'cancelled' }
      : {
          type,
          event: 'error',
          message: `Background worker exited unexpectedly (code ${code})${job.stderr ? `\n${job.stderr.trim()}` : ''}`,
        });
  });

  child.postMessage({ job: type, options });
  return true;
});

ipcMain.handle('job:cancel', (_e, type) => {
  const job = jobs.get(type);
  if (!job) return false;
  job.cancelled = true;
  job.child.kill();
  return true;
});

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const job of jobs.values()) {
    job.cancelled = true;
    job.child.kill();
    cleanupTemps(job);
  }
  if (process.platform !== 'darwin') app.quit();
});
