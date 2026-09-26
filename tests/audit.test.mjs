// New-behaviour tests for the audit surface (service results, thrown errors and lib/audit-log.mjs).
// They are expected to fail against the pre-audit implementation. lib/audit-log.mjs is imported
// dynamically only inside the tests that exercise the writer directly, so the service tests fail on
// their own assertions instead of being masked by a missing module.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createStore } from '../lib/store.mjs';
import { routeTask } from '../lib/policy.mjs';
import { createService } from '../scripts/server.mjs';

const scratch = fileURLToPath(new URL('../.test-data/', import.meta.url));
mkdirSync(scratch, { recursive: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const DEFAULT_SNAPSHOT = { strength: 70, costPreference: 'codex_quota', revision: 0, updatedAt: null };
const ROUTE_FLAGS = { category: 'mechanical', difficulty: 3, visualImpact: false, designSpecified: false, dshAvailable: true, stage: 'work', escalated: false, executionSpecified: false };

const owned = new Set();
function temporary() {
  const directory = mkdtempSync(join(scratch, 'audit-'));
  owned.add(directory);
  return directory;
}
function removeOwned(directory) {
  const base = resolve(scratch), target = resolve(directory), within = relative(base, target);
  if (!within || within.startsWith('..') || isAbsolute(within) || dirname(target) !== base || !target.startsWith(join(base, 'audit-')))
    throw new Error('Refusing to clean up a directory this test did not create: ' + target);
  owned.delete(directory);
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
after(() => { for (const directory of [...owned]) removeOwned(directory); });

function readRecords(directory, name = 'audit.jsonl') {
  const text = readFileSync(join(directory, name), 'utf8');
  if (text.length > 0 && !text.endsWith('\n')) throw new Error(`${name} does not end with a newline (torn write?)`);
  return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line));
}
async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('Expected the call to reject, but it resolved.');
}
function withDeadline(promise, ms) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); rejectPromise(error); });
  });
}

test('audited service calls record order, snapshot, decision ids and confirmations', async t => {
  const directory = temporary();
  t.after(() => removeOwned(directory));
  const store = createStore(directory);
  const service = createService(store);

  const policy = await service.call('get_policy');
  assert.deepEqual(Object.keys(policy).sort(), ['audit', 'levels', 'policy', 'settings']);
  assert.equal('decisionId' in policy, false);
  const { audit: policyAudit, ...policyBody } = policy;
  assert.deepEqual(policyBody, store.state());
  assert.equal(policyAudit.recorded, true);
  assert.match(policyAudit.eventId, UUID);
  assert.equal(policyAudit.error, undefined);

  const route = await service.call('route_task', { category: 'mechanical' });
  assert.deepEqual(Object.keys(route).sort(), ['audit', 'decision', 'decisionId']);
  assert.equal(route.decision.model, 'deepseek-flash');
  assert.equal(route.decision.reasoning, 'max');
  assert.equal(route.audit.recorded, true);
  assert.equal(route.audit.error, undefined);
  assert.match(route.audit.eventId, UUID);
  assert.match(route.decisionId, UUID);
  assert.deepEqual(route.decision, routeTask(store.read(), { category: 'mechanical' }));

  const rejected = await rejection(service.call('validate_assignment', { category: 'mechanical', model: 'gpt-6-luna', reasoning: 'high' }));
  assert.equal(rejected.message, '派发不符合策略：需要 deepseek-flash / max。请重新读取路由。');
  assert.equal(rejected.audit.recorded, true);
  assert.match(rejected.audit.eventId, UUID);
  assert.match(rejected.decisionId, UUID);
  assert.notEqual(rejected.decisionId, route.decisionId, 'a validate without decisionId must get a new id');

  const valid = await service.call('validate_assignment', { category: 'mechanical', model: 'deepseek-flash', reasoning: 'max', decisionId: route.decisionId });
  assert.deepEqual(Object.keys(valid).sort(), ['audit', 'decision', 'decisionId', 'valid']);
  assert.equal(valid.valid, true);
  assert.equal(valid.audit.recorded, true);
  assert.equal(valid.decisionId, route.decisionId, 'a supplied decisionId must be preserved');
  assert.deepEqual(valid.decision, route.decision);

  const fresh = await service.call('validate_assignment', { category: 'mechanical', model: 'deepseek-flash', reasoning: 'max' });
  assert.equal(fresh.valid, true);
  assert.match(fresh.decisionId, UUID);
  assert.notEqual(fresh.decisionId, route.decisionId);
  assert.notEqual(fresh.decisionId, rejected.decisionId, 'every call without decisionId must get its own id');

  const records = readRecords(directory);
  assert.equal(records.length, 5);
  assert.deepEqual(records.map(r => r.action), ['get_policy', 'route_task', 'validate_assignment', 'validate_assignment', 'validate_assignment']);
  assert.deepEqual(records.map(r => r.outcome), ['success', 'success', 'rejected', 'success', 'success']);
  assert.deepEqual([policyAudit.eventId, route.audit.eventId, rejected.audit.eventId, valid.audit.eventId, fresh.audit.eventId], records.map(r => r.eventId));
  for (const record of records) {
    assert.equal(record.version, 1);
    assert.match(record.eventId, UUID);
    assert.match(record.timestamp, ISO);
    assert.ok(!Number.isNaN(Date.parse(record.timestamp)), 'timestamp must be an ISO date');
    assert.deepEqual(record.settings, DEFAULT_SNAPSHOT);
    assert.equal(record.quota, null);
    assert.equal(record.quotaStatus, 'not_observed', 'no quota confirmation may be invented');
  }
  assert.equal(records[0].decisionId, null);
  assert.equal(records[0].correlation, null);
  assert.equal(records[0].decision, null);
  assert.equal(records[0].submitted, null);
  assert.ok(records[0].input === null || (typeof records[0].input === 'object' && Object.keys(records[0].input).length === 0), 'get_policy has no route flags to record');
  assert.equal(records[1].decisionId, route.decisionId);
  assert.equal(records[1].correlation, 'new');
  assert.deepEqual(records[1].decision, route.decision);
  assert.equal(records[1].submitted, null, 'routing is not a model submission');
  assert.equal(records[2].decisionId, rejected.decisionId);
  assert.equal(records[2].correlation, 'new');
  assert.deepEqual(records[2].decision, route.decision);
  assert.deepEqual(records[2].submitted, { model: 'gpt-6-luna', reasoning: 'high' });
  assert.equal(records[3].decisionId, route.decisionId);
  assert.equal(records[3].correlation, 'caller_supplied');
  assert.deepEqual(records[3].decision, route.decision);
  assert.deepEqual(records[3].submitted, { model: 'deepseek-flash', reasoning: 'max' });
  assert.equal(records[4].decisionId, fresh.decisionId);
  assert.equal(records[4].correlation, 'new');
  for (const record of records.slice(1)) {
    assert.ok(record.input && typeof record.input === 'object', 'route/validate input must be the normalized flags');
    for (const [key, value] of Object.entries(ROUTE_FLAGS)) assert.deepEqual(record.input[key], value, `input.${key} on the ${record.action} record`);
  }
});

test('set_strength outcomes are audited without changing results, errors or older snapshots', async t => {
  const directory = temporary();
  t.after(() => removeOwned(directory));
  const store = createStore(directory);
  const service = createService(store);

  const initialRoute = await service.call('route_task', { category: 'mechanical' });
  const initialRecords = readRecords(directory);
  assert.equal(initialRecords.length, 1);
  assert.deepEqual(initialRecords[0].settings, DEFAULT_SNAPSHOT);

  const saved = await service.call('set_strength', { strength: 100, costPreference: 'api_cost', expectedRevision: 0 });
  const { audit: savedAudit, ...savedBody } = saved;
  assert.deepEqual(Object.keys(saved).sort(), ['audit', 'levels', 'policy', 'settings']);
  assert.equal('decisionId' in saved, false);
  assert.deepEqual(savedBody, store.state());
  assert.equal(savedAudit.recorded, true);
  assert.match(savedAudit.eventId, UUID);
  assert.equal(savedAudit.error, undefined);
  const updatedAt = store.state().settings.updatedAt;
  assert.match(updatedAt, ISO);
  const updatedSnapshot = { strength: 100, costPreference: 'api_cost', revision: 1, updatedAt };

  const stale = await rejection(service.call('set_strength', { strength: 20, costPreference: 'api_cost', expectedRevision: 0 }));
  assert.equal(stale.message, '设置已被另一个面板修改，请刷新后再保存。');
  assert.equal('decisionId' in stale, false);
  assert.equal(stale.audit.recorded, true);
  assert.match(stale.audit.eventId, UUID);

  const unknown = await rejection(service.call('set_strength', { strength: 30, costPreference: 'api_cost', expectedRevision: 1, bogus: 'do-not-log-this-payload' }));
  assert.equal(unknown.message, '未知参数：bogus');
  assert.equal('decisionId' in unknown, false);
  assert.equal(unknown.audit.recorded, true);
  assert.match(unknown.audit.eventId, UUID);

  assert.equal(store.read().strength, 100);
  assert.equal(store.read().revision, 1);

  const afterFailures = readRecords(directory);
  const initialRecord = afterFailures.find(record => record.eventId === initialRoute.audit.eventId);
  assert.ok(initialRecord, 'the first route record must survive later writes');
  assert.deepEqual(initialRecord, initialRecords[0], 'an older route record must keep its snapshot after the policy changes');
  assert.deepEqual(initialRecord.settings, DEFAULT_SNAPSHOT);

  const setRecords = afterFailures.filter(record => record.action === 'set_strength');
  assert.equal(setRecords.length, 3);
  assert.deepEqual(setRecords.map(r => r.outcome), ['success', 'rejected', 'error']);
  for (const record of setRecords) {
    assert.equal(record.decisionId, null);
    assert.equal(record.correlation, null);
    assert.equal(record.decision, null);
    assert.equal(record.submitted, null);
    assert.equal(record.quota, null);
    assert.equal(record.quotaStatus, 'not_observed');
  }
  assert.deepEqual(setRecords[0].settings, updatedSnapshot, 'a successful save records the returned effective settings');
  assert.equal(setRecords[0].settingsSource, 'operation');
  assert.equal(setRecords[1].settingsSource, 'after_error');
  assert.equal(readFileSync(join(directory, 'audit.jsonl'), 'utf8').includes('do-not-log-this-payload'), false);
  assert.deepEqual(setRecords[1].settings, updatedSnapshot);
  assert.deepEqual(setRecords[2].settings, updatedSnapshot);
  assert.equal(setRecords[0].input.strength, 100);
  assert.equal(setRecords[0].input.costPreference, 'api_cost');
  assert.equal(setRecords[0].input.expectedRevision, 0);
  assert.equal(setRecords[1].input.strength, 20);
  assert.equal(setRecords[2].input.strength, 30);

  const updatedRoute = await service.call('route_task', { category: 'mechanical' });
  assert.equal(updatedRoute.decision.model, 'gpt-6-astra');
  assert.equal(updatedRoute.decision.reasoning, 'max');
  const finalRecords = readRecords(directory);
  const lastRecord = finalRecords[finalRecords.length - 1];
  assert.equal(lastRecord.action, 'route_task');
  assert.equal(lastRecord.eventId, updatedRoute.audit.eventId);
  assert.deepEqual(lastRecord.settings, updatedSnapshot);

  const mismatch = await rejection(service.call('validate_assignment', { category: 'mechanical', model: 'gpt-6-luna', reasoning: 'low' }));
  assert.equal(mismatch.message, '派发不符合策略：需要 gpt-6-astra / max。请重新读取路由。');
  assert.equal(mismatch.audit.recorded, true);
  assert.match(mismatch.decisionId, UUID);
  assert.notEqual(mismatch.decisionId, updatedRoute.decisionId);

  const accepted = await service.call('validate_assignment', { category: 'mechanical', model: 'gpt-6-astra', reasoning: 'max', decisionId: updatedRoute.decisionId });
  assert.equal(accepted.valid, true);
  assert.equal(accepted.decisionId, updatedRoute.decisionId);
  assert.deepEqual(accepted.decision, updatedRoute.decision);

  const newPolicyRecords = readRecords(directory).slice(finalRecords.length);
  assert.deepEqual(newPolicyRecords.map(r => r.action), ['validate_assignment', 'validate_assignment']);
  assert.deepEqual(newPolicyRecords.map(r => r.outcome), ['rejected', 'success']);
  assert.equal(newPolicyRecords[1].correlation, 'caller_supplied');
  for (const record of newPolicyRecords) assert.deepEqual(record.settings, updatedSnapshot);
  const drift = await service.call('validate_assignment', { category: 'mechanical', model: 'gpt-6-astra', reasoning: 'max', decisionId: initialRoute.decisionId });
  assert.equal(drift.decisionId, initialRoute.decisionId);
  assert.deepEqual(drift.decision, updatedRoute.decision, 'correlation never restores an old policy');
});

test('audit log failures only flip audit.recorded and never change tool results', async t => {
  const directory = temporary();
  t.after(() => removeOwned(directory));
  mkdirSync(join(directory, 'audit.jsonl')); // a directory at the log path makes every append fail
  const store = createStore(directory);
  const service = createService(store);

  const policy = await service.call('get_policy');
  const { audit: policyAudit, ...policyBody } = policy;
  assert.deepEqual(policyBody, store.state());
  assert.equal(policyAudit.recorded, false);
  assert.match(policyAudit.eventId, UUID);
  assert.equal(typeof policyAudit.error, 'string');
  assert.ok(policyAudit.error.length > 0);

  const rejected = await rejection(service.call('validate_assignment', { category: 'visual_design', model: 'gpt-6-sol', reasoning: 'high' }));
  assert.equal(rejected.message, '派发不符合策略：需要 gpt-6-astra / max。此任务禁止降级。');
  assert.equal(rejected.audit.recorded, false);
  assert.equal(typeof rejected.audit.error, 'string');
  assert.match(rejected.decisionId, UUID);

  const valid = await service.call('validate_assignment', { category: 'visual_design', model: 'gpt-6-astra', reasoning: 'max' });
  assert.equal(valid.valid, true);
  assert.equal(valid.decision.model, 'gpt-6-astra');
  assert.equal(valid.decision.reasoning, 'max');
  assert.equal(valid.decision.locked, true);
  assert.equal(valid.audit.recorded, false);

  const route = await service.call('route_task', { category: 'mechanical' });
  assert.equal(route.decision.model, 'deepseek-flash');
  assert.equal(route.audit.recorded, false);

  const saved = await service.call('set_strength', { strength: 10, costPreference: 'codex_quota', expectedRevision: 0 });
  const { audit: savedAudit, ...savedBody } = saved;
  assert.deepEqual(savedBody, store.state());
  assert.equal(savedAudit.recorded, false);
  assert.equal(store.read().strength, 10);
  assert.equal(statSync(join(directory, 'audit.jsonl')).isDirectory(), true, 'a broken log must not be replaced');
});

test('createAuditLog rotates at maxBytes and keeps every retained line intact', async t => {
  const directory = temporary();
  t.after(() => removeOwned(directory));
  const { createAuditLog } = await import('../lib/audit-log.mjs');
  const log = createAuditLog(directory, { maxBytes: 512 });
  const confirmations = [];
  for (let index = 0; index < 8; index++) {
    confirmations.push(await log.append({ version: 1, action: 'rotation_probe', sessionId: 'rotation-session', input: { index, padding: 'x'.repeat(24) }, outcome: 'success' }));
  }
  assert.equal(confirmations.length, 8);
  for (const confirmation of confirmations) {
    assert.equal(confirmation.recorded, true, JSON.stringify(confirmation));
    assert.match(confirmation.eventId, UUID);
  }
  const active = join(directory, 'audit.jsonl');
  const archive = join(directory, 'audit.1.jsonl');
  assert.ok(existsSync(active), 'the active log must exist');
  assert.ok(existsSync(archive), 'a rotation must have produced audit.1.jsonl');
  assert.ok(statSync(active).size <= 512, `active log is ${statSync(active).size} bytes`);
  assert.ok(statSync(archive).size <= 512, `archive log is ${statSync(archive).size} bytes`);
  const activeRecords = readRecords(directory);
  const archiveRecords = readRecords(directory, 'audit.1.jsonl');
  assert.ok(archiveRecords.length >= 1, 'the archive must hold the rotated records');
  const retained = [...archiveRecords, ...activeRecords];
  assert.ok(retained.length < 8, 'only the active log and one archive may be kept');
  for (const record of retained) {
    assert.equal(record.version, 1);
    assert.match(record.eventId, UUID);
    assert.match(record.timestamp, ISO);
  }
  const last = confirmations[confirmations.length - 1];
  assert.ok(retained.some(record => record.eventId === last.eventId), 'the newest record must be retained');
});

test('three concurrent child processes append 18 records without mixing lines', async t => {
  const directory = temporary();
  const auditUrl = new URL('../lib/audit-log.mjs', import.meta.url).href; // absolute file URL for the children
  const children = new Set();
  const closed = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await withDeadline(Promise.allSettled([...closed]), 5000).catch(() => {});
    removeOwned(directory);
  });

  const runChild = childIndex => {
    const identifiers = Array.from({ length: 6 }, (_, index) => `probe-${childIndex}-${index}`);
    const code = [
      '(async () => {',
      `  const { createAuditLog } = await import(${JSON.stringify(auditUrl)});`,
      `  const log = createAuditLog(${JSON.stringify(directory)});`,
      `  const identifiers = ${JSON.stringify(identifiers)};`,
      '  const confirmations = [];',
      '  for (const sessionId of identifiers) confirmations.push(await log.append({ version: 1, action: \'child_append\', sessionId, outcome: \'success\', quota: null, quotaStatus: \'not_observed\' }));',
      '  process.stdout.write(JSON.stringify(confirmations));',
      '})().catch(error => { process.stderr.write(String((error && error.stack) || error)); process.exit(1); });'
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    closed.push(once(child, 'close').catch(() => {}));
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise);
      child.once('close', exitCode => {
        if (exitCode !== 0) { rejectPromise(new Error(`child ${childIndex} exited with ${exitCode}: ${stderr}`)); return; }
        try { resolvePromise({ childIndex, confirmations: JSON.parse(stdout) }); }
        catch (error) { rejectPromise(new Error(`child ${childIndex} produced invalid JSON: ${stdout} (${error.message})`)); }
      });
    });
  };

  const settled = await withDeadline(Promise.all([0, 1, 2].map(runChild)), 20000);
  const confirmations = settled.flatMap(entry => entry.confirmations.map((confirmation, index) => ({ ...confirmation, sessionId: `probe-${entry.childIndex}-${index}` })));
  assert.equal(confirmations.length, 18);
  for (const confirmation of confirmations) assert.equal(confirmation.recorded, true, JSON.stringify(confirmation));

  const records = readRecords(directory);
  assert.equal(records.length, 18, 'every append must add exactly one line');
  assert.equal(new Set(records.map(record => record.eventId)).size, 18);
  assert.equal(new Set(confirmations.map(confirmation => confirmation.eventId)).size, 18);
  const bySession = new Map(records.map(record => [record.sessionId, record]));
  assert.equal(bySession.size, 18, 'no two appends may share a session payload');
  for (const confirmation of confirmations) {
    const record = bySession.get(confirmation.sessionId);
    assert.ok(record, 'missing record for ' + confirmation.sessionId);
    assert.equal(record.eventId, confirmation.eventId, 'payload must map back to its own append');
    assert.equal(record.version, 1);
    assert.match(record.timestamp, ISO);
    assert.equal(record.quota, null);
    assert.equal(record.quotaStatus, 'not_observed');
  }
});

test('records larger than maxBytes are rejected without touching the existing log', async t => {
  const directory = temporary();
  t.after(() => removeOwned(directory));
  const { createAuditLog } = await import('../lib/audit-log.mjs');
  const log = createAuditLog(directory, { maxBytes: 512 });
  const kept = await log.append({ action: 'small_probe', sessionId: 'keep-me', outcome: 'success' });
  assert.equal(kept.recorded, true);
  assert.match(kept.eventId, UUID);
  const file = join(directory, 'audit.jsonl');
  const before = readFileSync(file, 'utf8');
  assert.ok(before.length > 0 && before.endsWith('\n'));

  const oversized = { action: 'oversize_probe', sessionId: 'drop-me', input: { padding: '界'.repeat(180) }, outcome: 'success' };
  assert.ok(JSON.stringify(oversized).length < 512, 'the payload must fit a character counter but not a UTF-8 byte counter');
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 512);

  const tooLarge = await log.append(oversized);
  assert.equal(tooLarge.recorded, false);
  assert.equal(tooLarge.error, 'record_too_large');
  assert.equal(readFileSync(file, 'utf8'), before, 'a rejected record must not touch the log');
  const records = readRecords(directory);
  assert.equal(records.length, 1);
  assert.equal(records[0].eventId, kept.eventId);
  assert.equal(records[0].action, 'small_probe');
});

test('MCP rejection keeps its original text and exposes recorded correlation metadata', async t => {
  const directory = temporary();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/server.mjs', import.meta.url))], {
    env: { ...process.env, SUBAGENT_CONTROL_STATE_DIR: directory }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await withDeadline(closed, 5000).catch(() => {});
    removeOwned(directory);
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id); });
  let next = 0;
  const call = (name, args) => withDeadline(new Promise(resolvePromise => {
    const id = ++next; pending.set(id, resolvePromise);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  }), 5000);
  const route = (await call('route_task', { category: 'visual_design' })).result.structuredContent;
  const result = (await call('validate_assignment', { category: 'visual_design', model: 'gpt-6-sol', reasoning: 'high', decisionId: route.decisionId })).result;
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: '派发不符合策略：需要 gpt-6-astra / max。此任务禁止降级。' }]);
  assert.equal(result.structuredContent.decisionId, route.decisionId);
  assert.equal(result.structuredContent.audit.recorded, true);
  const records = readRecords(directory);
  assert.equal(records.length, 2);
  assert.equal(records[1].decisionId, route.decisionId);
  assert.equal(records[1].eventId, result.structuredContent.audit.eventId);
  assert.equal(records[1].outcome, 'rejected');
  child.stdin.end();
  assert.equal((await withDeadline(closed, 5000))[0], 0);
});
