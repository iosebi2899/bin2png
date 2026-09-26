'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bin2png', {
  /** mode: 'file' | 'files' | 'folder' | 'outputDir' -> string[] */
  pick: (mode) => ipcRenderer.invoke('dialog:pick', mode),
  /** Absolute path of a File from a drag-and-drop event. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  describe: (paths) => ipcRenderer.invoke('fs:describe', paths),
  join: (...parts) => ipcRenderer.invoke('path:join', ...parts),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  startJob: (type, options) => ipcRenderer.invoke('job:start', type, options),
  cancelJob: (type) => ipcRenderer.invoke('job:cancel', type),
  onJobEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('job:event', listener);
    return () => ipcRenderer.removeListener('job:event', listener);
  },
  platform: process.platform,
});
