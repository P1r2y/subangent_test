'use strict';
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { registerWindowControls } = require('./window-controls.cjs');

function startDesktop({
  electron = require('electron'), fileSystem = require('node:fs'),
  importModule = specifier => import(specifier), environment = process.env, io = process,
  repeat = setInterval, cancelRepeat = clearInterval, now = Date.now
} = {}) {
  const { app, BrowserWindow, ipcMain, dialog, screen, Menu } = electron;
  const { mkdirSync, writeFileSync, readFileSync, unlinkSync, watchFile, unwatchFile } = fileSystem;
  const stateRoot = environment.SUBAGENT_CONTROL_STATE_DIR || join(environment.CODEX_HOME || join(homedir(), '.codex'), 'subagent-control');
  mkdirSync(join(stateRoot, 'desktop'), { recursive: true });
  app.setName('Subagent Control');
  app.setPath('userData', join(stateRoot, 'desktop'));
  app.setAppUserModelId('local.subagent-control');
  let window;
  let panel;
  let usageReader;
  let settingsWindow;
  let windowStore;
  let watchPreferences;
  let closeAfterSettings = false;
  let stopping = false;
  let ready = false;
  const pendingActivations = new Set();
  const activationId = randomUUID();
  const activationFile = id => join(stateRoot, 'desktop', 'activation-' + id + '.json');
  const report = (event, extra = {}) => io.stdout.write(JSON.stringify({ event, ...extra }) + '\n');
  io.stdout.on('error', () => {});
  io.stderr.on('error', () => {});

  if (!app.requestSingleInstanceLock({ activationId })) {
    const deadline = now() + 10000;
    const check = repeat(() => {
      try {
        const acknowledgement = JSON.parse(readFileSync(activationFile(activationId), 'utf8'));
        if (acknowledgement.activationId === activationId && acknowledgement.ready) {
          unlinkSync(activationFile(activationId));
          cancelRepeat(check);
          report('activated');
          app.quit();
          return;
        }
      } catch { /* Wait for the original instance to acknowledge this request. */ }
      if (now() >= deadline) {
        cancelRepeat(check);
        io.stderr.write('现有浮窗没有确认打开，请关闭残留实例后重试。\n');
        app.exit(1);
      }
    }, 100);
  } else {
    const activate = id => {
      if (ready && window && !window.isDestroyed() && !stopping) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        writeFileSync(activationFile(id), JSON.stringify({ activationId: id, ready: true }), { mode: 0o600 });
        return true;
      }
      return false;
    };
    app.on('second-instance', (_event, _argv, _cwd, data) => {
      if (!/^[a-f0-9-]{36}$/.test(data?.activationId || '')) return;
      if (!activate(data.activationId) && pendingActivations.size < 32) pendingActivations.add(data.activationId);
    });
    app.on('window-all-closed', () => app.quit());
    app.on('will-quit', event => {
      if (windowStore && watchPreferences) unwatchFile(windowStore.file, watchPreferences);
      usageReader?.close();
      if (panel && !stopping) {
        event.preventDefault();
        stopping = true;
        panel.close().finally(() => app.quit());
      }
    });

    return app.whenReady().then(async () => {
      const { createStore } = await importModule('../lib/store.mjs');
      const { startPanel } = await importModule('../lib/http.mjs');
      const { createUsageClient, createUsageReader } = await importModule('../lib/usage.mjs');
      const { createWindowStore } = await importModule('../lib/window-store.mjs');
      windowStore = createWindowStore(stateRoot);
      const preferences = windowStore.read();
      const applyPreferences = settings => {
        if (window && !window.isDestroyed()) window.setAlwaysOnTop(settings.alwaysOnTop);
        for (const target of [window, settingsWindow]) if (target && !target.isDestroyed()) target.webContents.send('desktop:preferences-changed', settings);
      };
      let runtime = {};
      try { runtime = JSON.parse(readFileSync(join(__dirname, 'local-runtime.json'), 'utf8')); } catch { /* CLI on PATH remains available. */ }
      usageReader = createUsageReader({ client: createUsageClient({ executable: environment.SUBAGENT_CONTROL_CODEX_CLI || runtime.codexExecutable || 'codex.exe' }) });
      panel = await startPanel(createStore(stateRoot), { usageReader, windowStore, onWindowSettingsChanged: applyPreferences });
      const area = screen.getPrimaryDisplay().workArea;
      window = new BrowserWindow({
        title: 'Codex 剩余额度', width: 280, height: 112, useContentSize: true,
        resizable: false, transparent: true, hasShadow: false,
        x: Math.max(area.x, area.x + area.width - 304), y: area.y + Math.min(40, Math.max(0, area.height - 112)),
        frame: false, show: false, alwaysOnTop: preferences.alwaysOnTop, maximizable: false,
        backgroundColor: '#00000000', autoHideMenuBar: true,
        webPreferences: {
          preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
          nodeIntegration: false, webSecurity: true, devTools: false,
          partition: 'subagent-control-desktop'
        }
      });
      window.setMenu(null);
      window.on('close', event => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          event.preventDefault();
          closeAfterSettings = true;
          settingsWindow.close();
        }
      });
      const contents = window.webContents;
      let controls;
      const openSettings = async () => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          if (settingsWindow.isMinimized()) settingsWindow.restore();
          settingsWindow.show(); settingsWindow.focus();
          return { opened: true, reused: true };
        }
        const target = new BrowserWindow({
          title: 'Subagent Control · 设置', width: 420, height: 640, useContentSize: true,
          minWidth: 380, minHeight: 540, frame: false, show: false,
          backgroundColor: '#f5f5f5', autoHideMenuBar: true,
          webPreferences: {
            preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
            nodeIntegration: false, webSecurity: true, devTools: false,
            partition: 'subagent-control-desktop'
          }
        });
        settingsWindow = target;
        target.setMenu(null);
        controls.addWindow(target);
        target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        for (const name of ['will-attach-webview', 'will-navigate', 'will-redirect']) target.webContents.on(name, event => event.preventDefault());
        target.webContents.on('will-prevent-unload', event => {
          const choice = dialog.showMessageBoxSync(target, {
            type: 'question', title: '设置尚未保存', message: '关闭设置并放弃未保存的更改？',
            buttons: ['继续编辑', '放弃更改并关闭'], defaultId: 0, cancelId: 0, noLink: true
          });
          if (choice === 1) event.preventDefault();
          else closeAfterSettings = false;
        });
        target.on('closed', () => {
          if (settingsWindow === target) settingsWindow = undefined;
          if (closeAfterSettings && window && !window.isDestroyed()) { closeAfterSettings = false; window.close(); }
        });
        try { await target.loadURL(panel.url); }
        catch (error) { target.destroy(); throw new Error('设置面板打开失败。', { cause: error }); }
        if (!target.isDestroyed()) { target.show(); target.focus(); }
        return { opened: !target.isDestroyed() };
      };
      contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      contents.session.setPermissionCheckHandler(() => false);
      contents.session.webRequest.onBeforeRequest((details, callback) => {
        let allowed = false;
        try { allowed = new URL(details.url).origin === panel.origin; } catch { /* Reject malformed URLs. */ }
        callback({ cancel: !allowed });
      });
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('context-menu', () => Menu.buildFromTemplate([
        { label: '设置…', click: () => openSettings().catch(error => dialog.showErrorBox('无法打开设置', error.message)) },
        { label: '刷新额度', click: () => contents.reload() },
        { label: '始终置顶', type: 'checkbox', checked: window.isAlwaysOnTop(), click: item => {
          try {
            const current = windowStore.read();
            const result = windowStore.save({ opacity: current.opacity, expectedRevision: current.revision, alwaysOnTop: item.checked });
            applyPreferences(result.settings);
          } catch (error) { dialog.showErrorBox('设置未保存', error.message); }
        } },
        { type: 'separator' },
        { label: '关闭浮窗', click: () => window.close() }
      ]).popup({ window }));
      contents.on('will-attach-webview', event => event.preventDefault());
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('will-redirect', event => event.preventDefault());
      controls = registerWindowControls(ipcMain, window, panel.origin, { openSettings });
      watchPreferences = () => { try { applyPreferences(windowStore.read()); } catch { /* Keep the last good appearance if a file is being repaired. */ } };
      watchFile(windowStore.file, { interval: 1000, persistent: false }, watchPreferences);
      await window.loadURL(panel.origin + '/quota.html#token=' + panel.token);
      window.show();
      ready = true;
      for (const id of pendingActivations) activate(id);
      pendingActivations.clear();
      report('ready', { alwaysOnTop: window.isAlwaysOnTop(), transparent: true, view: 'quota', bounds: window.getContentBounds() });
    }).catch(error => {
      io.stderr.write('浮窗启动失败：' + error.message + '\n');
      app.quit();
    });
  }
}

module.exports = { startDesktop };
// Electron 直跑入口脚本时 require.main 指向 Electron 自带的启动模块而不是本文件
// （Electron 44.4.3 实测 require.main === module 为 false），只靠它会永远不启动浮窗；
// 因此再比对一次入口脚本路径：直跑时 argv[1] 就是本文件，被 require 时是调用方。
const entryScript = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
if (require.main === module || (entryScript && entryScript === __filename.toLowerCase())) startDesktop();
