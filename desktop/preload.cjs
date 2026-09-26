'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopControl', Object.freeze({
  platform: process.platform,
  openSettings: () => ipcRenderer.invoke('desktop:open-settings'),
  onPreferencesChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('回调必须是函数。');
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('desktop:preferences-changed', listener);
    return () => ipcRenderer.removeListener('desktop:preferences-changed', listener);
  },
  getAlwaysOnTop: () => ipcRenderer.invoke('desktop:get-topmost'),
  setAlwaysOnTop: value => ipcRenderer.invoke('desktop:set-topmost', value),
  minimize: () => ipcRenderer.invoke('desktop:minimize'),
  close: () => ipcRenderer.invoke('desktop:close')
}));
