import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createStore } from '../lib/store.mjs';
import { startPanel } from '../lib/http.mjs';
import { createService } from '../scripts/server.mjs';

const scratch = fileURLToPath(new URL('../.test-data/', import.meta.url));
mkdirSync(scratch, { recursive: true });
const ownedDirectories = [];
const temporary = () => { const directory = mkdtempSync(join(scratch, 'integration-')); ownedDirectories.push(directory); return directory; };
after(() => {
  for (const directory of ownedDirectories) {
    const target = resolve(directory), within = relative(resolve(scratch), target);
    if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Refusing cleanup outside the test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

test('window preferences save independently, notify the desktop and protect against stale writes', async t => {
  const policyStore = createStore(temporary());
  const changed = [];
  const panel = await startPanel(policyStore, { onWindowSettingsChanged: settings => changed.push(settings) });
  t.after(() => panel.close());
  const endpoint = panel.origin + '/api/window-settings';
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { Authorization: 'Bearer ' + panel.token, 'Content-Type': 'application/json' };
  assert.deepEqual((await (await fetch(endpoint, { headers })).json()).settings, { opacity: 80, alwaysOnTop: true, revision: 0, updatedAt: null });
  const save = async (settings, extraHeaders = {}) => fetch(endpoint, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(settings) });
  const input = { opacity: 65, alwaysOnTop: false, expectedRevision: 0 };
  assert.equal((await save(input, { Origin: 'https://untrusted.example' })).status, 403);
  const result = await (await save(input)).json();
  assert.equal(result.settings.opacity, 65); assert.equal(result.settings.alwaysOnTop, false);
  assert.deepEqual(changed, [result.settings]);
  assert.equal((await save(input)).status, 409);
  assert.equal(changed.length, 1);
  assert.equal(policyStore.read().strength, 70);
  assert.equal(policyStore.read().revision, 0);
});

test('quota endpoint requires authorization and only returns the injected read-only snapshot', async t => {
  let calls = 0;
  const snapshot = { status: 'ready', windows: [{ label: '每周', remainingPercent: 60 }], stale: false };
  const panel = await startPanel(createStore(temporary()), { usageReader: { async read() { calls++; return snapshot; } } });
  t.after(() => panel.close());
  assert.equal((await fetch(panel.origin + '/api/usage')).status, 401);
  assert.equal(calls, 0);
  const headers = { Authorization: 'Bearer ' + panel.token };
  assert.equal((await fetch(panel.origin + '/api/usage', { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal(calls, 0);
  assert.deepEqual(await (await fetch(panel.origin + '/api/usage', { headers })).json(), snapshot);
  assert.equal(calls, 1);
  for (const path of ['/quota.html', '/quota.css', '/quota.js']) assert.equal((await fetch(panel.origin + path)).status, 200);
});

test('HTTP rejects unauthorized and cross-site mutations; saving is shared with MCP', async t => {
  const store = createStore(temporary());
  const panel = await startPanel(store);
  t.after(() => panel.close());
  const request = (path, data, extra = {}) => fetch(panel.origin + path, { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + panel.token, ...(data ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await fetch(panel.origin + '/api/state')).status, 401);
  assert.equal((await request('/api/state', null, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request('/api/settings', { strength: 100, costPreference: 'api_cost', expectedRevision: 0 }, { Origin: 'https://untrusted.example' })).status, 403);
  const spoofedHostStatus = await new Promise((resolve, reject) => { const req = httpRequest(panel.origin + '/api/state', { headers: { Host: 'untrusted.example', Authorization: 'Bearer ' + panel.token } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(spoofedHostStatus, 403);
  const initial = await (await request('/api/state')).json();
  assert.equal(initial.settings.strength, 70);
  const preview = await (await request('/api/preview', { strength: 10, costPreference: 'codex_quota' })).json();
  assert.equal(preview.policy.strength, 10);
  assert.equal(store.read().strength, 70);
  assert.equal((await request('/api/settings', { strength: 11, costPreference: 'api_cost', expectedRevision: 0 })).status, 400);
  const saved = await (await request('/api/settings', { strength: 35, costPreference: 'api_cost', expectedRevision: 0 })).json();
  assert.equal(saved.settings.revision, 1);
  assert.equal(saved.settings.strength, 35);
  assert.equal((await request('/api/settings', { strength: 90, costPreference: 'api_cost', expectedRevision: 0 })).status, 409);
  const service = createService(createStore(dirname(store.file)));
  assert.equal((await service.call('get_policy')).settings.strength, 35);
  const route = await (await request('/api/route', { strength: 10, costPreference: 'api_cost', category: 'implementation', visualImpact: true, designSpecified: false })).json();
  assert.equal(route.decision.model, 'gpt-6-astra');
  assert.equal(route.decision.reasoning, 'max');
  assert.equal(route.decision.locked, true);
  const html = await request('/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await html.text(), /<html/i);
  assert.equal((await request('/missing')).status, 404);
});

test('service validates assignment and observes settings without a restart', async () => {
  const service = createService(createStore(temporary()));
  await assert.rejects(service.call('validate_assignment', { category: 'visual_design', model: 'gpt-6-sol', reasoning: 'high' }), /禁止降级/);
  const valid = await service.call('validate_assignment', { category: 'visual_design', model: 'gpt-6-astra', reasoning: 'max' });
  assert.equal(valid.valid, true);
  await service.call('set_strength', { strength: 10, costPreference: 'codex_quota', expectedRevision: 0 });
  assert.equal((await service.call('route_task', { category: 'mechanical' })).decision.model, 'deepseek-flash');
  assert.equal((await service.call('route_task', { category: 'mechanical', dshAvailable: false })).decision.model, 'gpt-6-luna');
  const escalation = (await service.call('route_task', { category: 'mechanical', escalated: true })).decision;
  assert.equal(escalation.model, 'gpt-6-astra');
  assert.equal(escalation.reasoning, 'max');
  await assert.rejects(service.call('set_strength', { strength: 20, costPreference: 'api_cost' }), /expectedRevision/);
  await assert.rejects(service.call('get_policy', { arbitrary: true }), /未知参数/);
});

test('DeepSeek preference persists through HTTP and produces executable MCP routing', async t => {
  const store = createStore(temporary());
  const panel = await startPanel(store);
  t.after(() => panel.close());
  const saved = await fetch(panel.origin + '/api/settings', {
    method: 'POST', headers: { Authorization: 'Bearer ' + panel.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ strength: 70, costPreference: 'deepseek_first', expectedRevision: 0 })
  });
  assert.equal(saved.status, 200);
  const service = createService(createStore(dirname(store.file)));
  assert.equal((await service.call('get_policy')).settings.costPreference, 'deepseek_first');
  const args = { category: 'implementation', executionSpecified: true };
  const { decision } = await service.call('route_task', args);
  assert.equal(decision.model, 'deepseek-flash');
  assert.equal(decision.transport, 'dsh_delegate');
  assert.equal((await service.call('validate_assignment', { ...args, model: decision.model, reasoning: decision.reasoning })).valid, true);
  await assert.rejects(service.call('validate_assignment', { category: 'visual_design', executionSpecified: true, model: 'deepseek-flash', reasoning: 'medium' }), /禁止降级/);
});

test('MCP stdio lifecycle, tool errors and resource read use valid JSON-RPC', async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/server.mjs', import.meta.url))], { env: { ...process.env, SUBAGENT_CONTROL_STATE_DIR: temporary() }, windowsHide: true });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map(); let next = 0;
  lines.on('line', line => { const result = JSON.parse(line); const waiter = waiting.get(result.id); if (waiter) { clearTimeout(waiter.timer); waiting.delete(result.id); waiter.resolve(result); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => reject(new Error('MCP timeout: ' + method)), 5000); waiting.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const names = (await rpc('tools/list')).result.tools.map(t => t.name);
  assert.ok(names.includes('open_control_panel'));
  assert.ok(names.includes('route_task'));
  const route = await rpc('tools/call', { name: 'route_task', arguments: { category: 'visual_design' } });
  assert.equal(route.result.structuredContent.decision.reasoning, 'max');
  const bad = await rpc('tools/call', { name: 'set_strength', arguments: { strength: 12, costPreference: 'api_cost', expectedRevision: 0 } });
  assert.equal(bad.result.isError, true);
  const resource = await rpc('resources/read', { uri: 'subagent-control://policy' });
  assert.equal(JSON.parse(resource.result.contents[0].text).settings.strength, 70);
  const open = await rpc('tools/call', { name: 'open_control_panel' });
  assert.match(open.result.structuredContent.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/);
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0, stderr);
});
