// Exercises the actual desktop entry through injected host dependencies. No Electron or model launches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const { startDesktop } = createRequire(import.meta.url)('../desktop/main.cjs');

function host({ primary = true } = {}) {
  const windows = [], handlers = new Map(), files = new Map(), messages = [], timers = [];
  const state = { preferences: { opacity: 75, alwaysOnTop: true, revision: 1 }, choice: 0, panelClosed: 0, usageClosed: 0, unwatch: 0, clock: 0, quit: 0 };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.top = !!options.alwaysOnTop;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: 'http://127.0.0.1:12345/' }, sent: [],
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } },
        setWindowOpenHandler() {}, send(...args) { this.sent.push(args); }, reload() {}
      });
      windows.push(this);
    }
    setMenu() {} isDestroyed() { return this.destroyed; } isMinimized() { return false; }
    show() { this.shown = true; } focus() {} restore() {} minimize() {}
    setAlwaysOnTop(value) { this.top = value; } isAlwaysOnTop() { return this.top; }
    async loadURL(url) { this.url = url; }
    getContentBounds() { return { width: this.options.width, height: this.options.height }; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (prevented) return;
      if (this.dirty) {
        let allow = false;
        this.webContents.emit('will-prevent-unload', { preventDefault() { allow = true; } });
        if (!allow) return;
      }
      this.destroy();
    }
  }
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setPath() {}, setAppUserModelId() {}, whenReady: async () => {},
    requestSingleInstanceLock(data) { state.activation = data.activationId; return primary; },
    quit() { state.quit++; this.emit('will-quit', { preventDefault() {} }); },
    exit(code) { state.exitCode = code; }
  });
  const stream = () => Object.assign(new EventEmitter(), { write(text) { messages.push(text); } });
  const root = join(process.cwd(), 'virtual-desktop-state');
  const dependencies = {
    electron: { app, BrowserWindow: Window, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: { showMessageBoxSync: () => state.choice, showErrorBox() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, Menu: { buildFromTemplate: () => ({ popup() {} }) } },
    fileSystem: {
      mkdirSync() {}, writeFileSync: (file, text) => files.set(file, text), unlinkSync: file => files.delete(file),
      readFileSync(file) { if (files.has(file)) return files.get(file); throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
      watchFile(_file, _options, callback) { state.watch = callback; }, unwatchFile() { state.unwatch++; }
    },
    environment: { SUBAGENT_CONTROL_STATE_DIR: root }, io: { stdout: stream(), stderr: stream() },
    repeat(callback) { timers.push(callback); return timers.length; }, cancelRepeat(id) { timers[id - 1] = null; }, now: () => state.clock,
    async importModule(specifier) {
      if (specifier.endsWith('/store.mjs')) return { createStore: () => ({ file: join(root, 'settings.json') }) };
      if (specifier.endsWith('/window-store.mjs')) return { createWindowStore: () => ({ file: join(root, 'window-settings.json'), read: () => state.preferences, save: input => ({ settings: { ...input, revision: 2 } }) }) };
      if (specifier.endsWith('/usage.mjs')) return { createUsageClient: () => ({}), createUsageReader: () => ({ close() { state.usageClosed++; } }) };
      if (specifier.endsWith('/http.mjs')) return { startPanel: async () => ({ origin: 'http://127.0.0.1:12345', token: 'test', url: 'http://127.0.0.1:12345/#token=test', async close() { state.panelClosed++; } }) };
      throw new Error(specifier);
    }
  };
  const openSettings = () => handlers.get('desktop:open-settings')({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame });
  return { dependencies, state, app, windows, files, root, timers, messages, openSettings };
}

test('desktop initializes quota, acknowledges queued activation and syncs saved appearance', async () => {
  const h = host();
  const startup = startDesktop(h.dependencies);
  const activation = '00000000-0000-4000-8000-000000000000';
  h.app.emit('second-instance', {}, [], '', { activationId: activation });
  await startup;
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].shown, true);
  assert.match(h.windows[0].url, /quota.html#token=test/);
  assert.equal(JSON.parse(h.files.get(join(h.root, 'desktop', `activation-${activation}.json`))).ready, true);
  assert.equal(h.windows[0].webContents.listenerCount('will-prevent-unload'), 0);
  h.state.preferences = { opacity: 60, alwaysOnTop: false, revision: 2 };
  h.state.watch();
  assert.equal(h.windows[0].top, false);
  assert.deepEqual(h.windows[0].webContents.sent.at(-1), ['desktop:preferences-changed', h.state.preferences]);
});

test('cancel closing dirty settings retains both windows; discarding closes them in order', async () => {
  const h = host(); await startDesktop(h.dependencies); await h.openSettings();
  const [quota, settings] = h.windows; settings.dirty = true;
  h.state.choice = 0; quota.close();
  assert.equal(quota.destroyed, false); assert.equal(settings.destroyed, false);
  h.state.choice = 1; quota.close();
  assert.equal(settings.destroyed, true); assert.equal(quota.destroyed, true);
});

test('desktop shutdown closes the HTTP panel once and detaches its watcher', async () => {
  const h = host(); await startDesktop(h.dependencies);
  h.app.quit(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.state.panelClosed, 1);
  assert.ok(h.state.usageClosed >= 1); assert.ok(h.state.unwatch >= 1);
  assert.equal(h.state.quit, 2);
});

test('secondary instance waits for matching acknowledgement or exits on timeout', () => {
  const h = host({ primary: false }); startDesktop(h.dependencies);
  const file = join(h.root, 'desktop', `activation-${h.state.activation}.json`);
  h.files.set(file, JSON.stringify({ activationId: h.state.activation, ready: true }));
  h.timers[0]();
  assert.equal(h.files.has(file), false); assert.equal(h.state.quit, 1);
  assert.ok(h.messages.some(text => text.includes('activated')));
  const late = host({ primary: false }); startDesktop(late.dependencies);
  late.state.clock = 10001; late.timers[0]();
  assert.equal(late.state.exitCode, 1);
});
