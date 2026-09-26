import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const { registerWindowControls } = createRequire(import.meta.url)('../desktop/window-controls.cjs');

test('settings controls operate on their own trusted window and forget closed windows', async () => {
  const handlers = new Map();
  const makeWindow = () => Object.assign(new EventEmitter(), {
    webContents: { mainFrame: { url: 'http://127.0.0.1:12345/' } },
    isDestroyed: () => false, isAlwaysOnTop: () => false,
    closed: false, minimized: false,
    close() { this.closed = true; this.emit('closed'); },
    minimize() { this.minimized = true; }
  });
  const quota = makeWindow(); const settings = makeWindow();
  let opened = 0;
  const controls = registerWindowControls({ handle: (name, fn) => handlers.set(name, fn) }, quota, 'http://127.0.0.1:12345', { openSettings: () => { opened++; return { opened: true }; } });
  controls.addWindow(settings);
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  assert.deepEqual(await handlers.get('desktop:open-settings')(event(quota)), { opened: true });
  assert.equal(opened, 1);
  handlers.get('desktop:minimize')(event(settings));
  assert.equal(settings.minimized, true); assert.equal(quota.minimized, false);
  handlers.get('desktop:close')(event(settings));
  assert.equal(settings.closed, true); assert.equal(quota.closed, false);
  assert.throws(() => handlers.get('desktop:open-settings')(event(settings)), /不允许/);
});

test('desktop controls reject unknown senders, child frames and changed origins', () => {
  const handlers = new Map();
  const frame = { url: 'http://127.0.0.1:12345/' };
  const contents = { mainFrame: frame };
  let topmost = true;
  let closed = false;
  let minimized = false;
  let destroyed = false;
  const window = {
    webContents: contents, isDestroyed: () => destroyed,
    isAlwaysOnTop: () => topmost, setAlwaysOnTop: value => { topmost = value; },
    close: () => { closed = true; }, minimize: () => { minimized = true; }
  };
  registerWindowControls({ handle: (name, fn) => handlers.set(name, fn) }, window, 'http://127.0.0.1:12345');
  const event = { sender: contents, senderFrame: frame };
  for (const handler of handlers.values()) {
    assert.throws(() => handler({ sender: {}, senderFrame: frame }, false), /不允许/);
    assert.throws(() => handler({ sender: contents, senderFrame: { ...frame } }, false), /不允许/);
    frame.url = 'https://example.com/';
    assert.throws(() => handler(event, false), /不允许/);
    frame.url = 'http://127.0.0.1:12345/';
  }
  assert.equal(topmost, true);
  assert.equal(closed, false);
  assert.equal(minimized, false);
  assert.throws(() => handlers.get('desktop:set-topmost')(event, 'false'), /布尔值/);
  assert.equal(handlers.get('desktop:set-topmost')(event, false), false);
  assert.equal(handlers.get('desktop:get-topmost')(event), false);
  assert.equal(handlers.get('desktop:set-topmost')(event, true), true);
  handlers.get('desktop:minimize')(event);
  handlers.get('desktop:close')(event);
  assert.equal(minimized, true);
  assert.equal(closed, true);
  destroyed = true;
  assert.throws(() => handlers.get('desktop:get-topmost')(event), /不允许/);
});
