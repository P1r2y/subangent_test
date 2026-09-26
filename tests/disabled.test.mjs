// 边界测试：subagent-control 插件开关（lib/policy.mjs、lib/store.mjs、lib/http.mjs、scripts/server.mjs）
// 停用语义：不路由、不校验、不读额度、不写审计记录；设置面板是唯一保留的入口。
// 只在插件工作区的 .test-data 下建临时目录，不联网、不启动模型、不动真实状态目录。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

import { createStore } from '../lib/store.mjs';
import { startPanel } from '../lib/http.mjs';
import { createService } from '../scripts/server.mjs';
import { DEFAULT_SETTINGS, DISABLED_MESSAGE, isEnabled, validateSettings } from '../lib/policy.mjs';

const scratch = fileURLToPath(new URL('../.test-data/', import.meta.url));
mkdirSync(scratch, { recursive: true });
const ownedDirectories = [];
const temporary = () => { const directory = mkdtempSync(join(scratch, 'disabled-')); ownedDirectories.push(directory); return directory; };
after(() => {
  for (const directory of ownedDirectories) {
    const target = resolve(directory), within = relative(resolve(scratch), target);
    if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Refusing cleanup outside the test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

const off = (directory, strength = 70, costPreference = 'codex_quota') => {
  const store = createStore(directory);
  store.save({ strength, costPreference, enabled: false, expectedRevision: 0 });
  return store;
};

// ---------------------------------------------------------------- 契约与默认值

test('开关只接受布尔值，缺省视为启用', () => {
  for (const value of ['true', 1, 0, null, {}]) {
    assert.throws(() => validateSettings({ strength: 70, costPreference: 'codex_quota', enabled: value }), /启用状态必须为布尔值。/, String(value));
  }
  assert.equal(validateSettings({ strength: 70, costPreference: 'codex_quota' }).enabled, undefined);
  assert.equal(validateSettings({ strength: 70, costPreference: 'codex_quota', enabled: false }).enabled, false);
  assert.equal(DEFAULT_SETTINGS.enabled, true);
  assert.equal(isEnabled({ strength: 70, costPreference: 'codex_quota' }), true);
  assert.equal(isEnabled(DEFAULT_SETTINGS), true);
  assert.equal(isEnabled({ enabled: false }), false);
});

test('未写入开关的旧设置按启用读取，之后保存不会丢开关', () => {
  const directory = temporary();
  const store = createStore(directory);
  writeFileSync(store.file, JSON.stringify({ strength: 55, costPreference: 'api_cost', revision: 3, updatedAt: '2026-09-24T10:00:00.000Z' }, null, 2) + '\n', 'utf8');

  const read = store.read();
  assert.equal(read.enabled, true);
  assert.equal(store.state().settings.enabled, true);
  assert.equal(store.state().policy.strength, 55);

  const saved = store.save({ strength: 60, costPreference: 'api_cost', expectedRevision: 3 });
  assert.equal(saved.settings.enabled, true);
  assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).enabled, true);
});

// ---------------------------------------------------------------- 存储层拦截

test('停用后拒绝不带开关的写入；带 enabled:true 的写入可以开回', () => {
  const directory = temporary();
  const store = off(directory);
  const before = readFileSync(store.file, 'utf8');

  assert.throws(() => store.save({ strength: 75, costPreference: 'codex_quota', expectedRevision: 1 }), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /插件已停用/);
    return true;
  });
  assert.equal(readFileSync(store.file, 'utf8'), before, '被拒绝的写入必须字节级不变');
  assert.equal(store.read().revision, 1);
  assert.equal(store.read().strength, 70);

  const back = store.save({ strength: 75, costPreference: 'api_cost', enabled: true, expectedRevision: 1 });
  assert.equal(back.settings.enabled, true);
  assert.equal(back.settings.strength, 75);
  assert.equal(back.settings.revision, 2);

  const again = store.save({ strength: 80, costPreference: 'api_cost', expectedRevision: 2 });
  assert.equal(again.settings.enabled, true, '重新启用后不带开关的写入必须保持启用');
  assert.equal(again.settings.strength, 80);
});

// ---------------------------------------------------------------- MCP 工具面

test('停用后 MCP 工具全部拒绝且不写审计，控制面板保持可用', async t => {
  const directory = temporary();
  const store = off(directory);
  const audit = join(directory, 'audit.jsonl');
  const service = createService(store);
  t.after(() => service.close());

  const refused = [
    ['get_policy', {}],
    ['preview_policy', { strength: 70, costPreference: 'codex_quota' }],
    ['route_task', { category: 'mechanical' }],
    ['validate_assignment', { category: 'mechanical', model: 'deepseek-flash', reasoning: 'max' }],
    ['set_strength', { strength: 40, costPreference: 'codex_quota', expectedRevision: 1 }],
    ['open_floating_window', {}],
  ];
  for (const [name, args] of refused) {
    await assert.rejects(service.call(name, args), (error) => {
      assert.equal(error.message, DISABLED_MESSAGE, name);
      return true;
    }, name);
  }
  assert.equal(existsSync(audit), false, '停用期间不得写审计记录');
  assert.equal(store.read().enabled, false);
  assert.equal(store.read().revision, 1);

  const panel = await service.call('open_control_panel');
  assert.match(panel.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/);
  assert.equal(existsSync(audit), false);
});

// ---------------------------------------------------------------- HTTP 面

test('停用后面板仍可读状态，策略与额度接口被拦截，开关可原地开回', async t => {
  const directory = temporary();
  const store = off(directory);
  const snapshot = { status: 'ready', windows: [{ label: '每周', remainingPercent: 60 }], updatedAt: null, stale: false, message: '' };
  let reads = 0;
  const panel = await startPanel(store, { usageReader: { async read() { reads += 1; return snapshot; } } });
  t.after(() => panel.close());
  const headers = { Authorization: 'Bearer ' + panel.token, 'Content-Type': 'application/json' };

  const state = await (await fetch(panel.origin + '/api/state', { headers })).json();
  assert.equal(state.settings.enabled, false);
  assert.equal(state.policy.strength, 70, '策略仍需可读，否则面板无法渲染停用状态');

  const preview = await fetch(panel.origin + '/api/preview', { method: 'POST', headers, body: JSON.stringify({ strength: 70, costPreference: 'codex_quota' }) });
  assert.equal(preview.status, 400);
  assert.match((await preview.json()).error, /插件已停用/);
  const route = await fetch(panel.origin + '/api/route', { method: 'POST', headers, body: JSON.stringify({ strength: 70, costPreference: 'codex_quota', category: 'mechanical' }) });
  assert.equal(route.status, 400);

  const usage = await (await fetch(panel.origin + '/api/usage', { headers })).json();
  assert.equal(usage.status, 'disabled');
  assert.deepEqual(usage.windows, []);
  assert.equal(reads, 0, '停用期间不得触碰 Codex CLI 读取额度');

  const blocked = await fetch(panel.origin + '/api/settings', { method: 'POST', headers, body: JSON.stringify({ strength: 40, costPreference: 'api_cost', expectedRevision: 1 }) });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /插件已停用/);

  const back = await (await fetch(panel.origin + '/api/settings', { method: 'POST', headers, body: JSON.stringify({ strength: 70, costPreference: 'codex_quota', enabled: true, expectedRevision: 1 }) })).json();
  assert.equal(back.settings.enabled, true);
  assert.deepEqual(await (await fetch(panel.origin + '/api/usage', { headers })).json(), snapshot, '开回后额度读取恢复正常');
  assert.equal(reads, 1);
});

// ---------------------------------------------------------------- MCP stdio 真实面

test('停用后 stdio 只返回拒绝，策略资源也不可用', async t => {
  const directory = temporary();
  off(directory);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/server.mjs', import.meta.url))], { env: { ...process.env, SUBAGENT_CONTROL_STATE_DIR: directory }, windowsHide: true });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map(); let next = 0;
  lines.on('line', (line) => { const message = JSON.parse(line); const waiter = waiting.get(message.id); if (waiter) { clearTimeout(waiter.timer); waiting.delete(message.id); waiter.resolve(message); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => reject(new Error('MCP timeout: ' + method)), 5000); waiting.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

  await rpc('initialize', { protocolVersion: '2025-06-18' });
  const call = await rpc('tools/call', { name: 'get_policy', arguments: {} });
  assert.equal(call.result.isError, true);
  assert.equal(call.result.content[0].text, DISABLED_MESSAGE);
  const route = await rpc('tools/call', { name: 'route_task', arguments: { category: 'mechanical' } });
  assert.equal(route.result.isError, true);
  assert.equal(route.result.content[0].text, DISABLED_MESSAGE);
  const resource = await rpc('resources/read', { uri: 'subagent-control://policy' });
  assert.equal(resource.error.message, DISABLED_MESSAGE);
  assert.equal(existsSync(join(directory, 'audit.jsonl')), false);

  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0, stderr);
});
