'use strict';

function registerWindowControls(ipcMain, initialWindow, origin, { openSettings } = {}) {
  const windows = new Map();
  const addWindow = window => {
    const contents = window.webContents;
    windows.set(contents, window);
    window.once?.('closed', () => windows.delete(contents));
  };
  addWindow(initialWindow);
  const trusted = event => {
    const window = windows.get(event.sender);
    const contents = window?.webContents;
    let sameOrigin = false;
    try { sameOrigin = new URL(event.senderFrame?.url).origin === origin; } catch { /* Fail closed. */ }
    if (!window || window.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame || !sameOrigin) throw new Error('不允许的窗口请求。');
    return window;
  };
  ipcMain.handle('desktop:get-topmost', event => trusted(event).isAlwaysOnTop());
  ipcMain.handle('desktop:set-topmost', (event, value) => {
    const window = trusted(event);
    if (typeof value !== 'boolean') throw new TypeError('置顶状态必须为布尔值。');
    window.setAlwaysOnTop(value);
    return window.isAlwaysOnTop();
  });
  ipcMain.handle('desktop:minimize', event => trusted(event).minimize());
  ipcMain.handle('desktop:close', event => trusted(event).close());
  ipcMain.handle('desktop:open-settings', event => {
    trusted(event);
    if (!openSettings) throw new Error('设置面板暂不可用。');
    return openSettings();
  });
  return { addWindow };
}
module.exports = { registerWindowControls };
