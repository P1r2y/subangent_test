// Regression cases provided for independent review. Not executed during this repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireFileLock } from '../lib/file-lock.mjs';
import { createStore } from '../lib/store.mjs';
import { startPanel } from '../lib/http.mjs';
import { LEVELS, CATEGORIES, routeTask } from '../lib/policy.mjs';
const scratch = fileURLToPath(new URL('../.test-data/', import.meta.url));
function temporary(t) {
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'fixes-'));
  t.after(() => {
    const within = relative(resolve(scratch), resolve(directory));
    if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Invalid cleanup path');
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('DeepSeek routes always use max and every unavailable-channel fallback explains itself', () => {
  for (const strength of LEVELS) for (const costPreference of ['codex_quota', 'api_cost', 'deepseek_first']) for (const category of CATEGORIES) for (const difficulty of [1,2,3,4,5]) {
    const settings = { strength, costPreference }, input = { category, difficulty, executionSpecified: true };
    const available = routeTask(settings, input);
    if (available.transport !== 'dsh_delegate') continue;
    assert.equal(available.reasoning, 'max');
    const fallback = routeTask(settings, { ...input, dshAvailable: false });
    assert.notEqual(fallback.transport, 'dsh_delegate');
    assert.match(fallback.reason, /通道不可用/); assert.match(fallback.reason, /Codex 额度/);
  }
});

test('active owned lock is protected and release is idempotent', t => {
  const file = join(temporary(t), 'settings.json');
  const release = acquireFileLock(file);
  assert.throws(() => acquireFileLock(file), error => error.status === 409);
  assert.equal(existsSync(file + '.lock'), true);
  release(); release();
  assert.equal(existsSync(file + '.lock'), false);
  acquireFileLock(file)();
});

test('an old empty legacy lock recovers without changing the saved revision contract', t => {
  const store = createStore(temporary(t));
  writeFileSync(store.file + '.lock', '');
  const old = new Date(Date.now() - 60_000); utimesSync(store.file + '.lock', old, old);
  const result = store.save({ strength: 75, costPreference: 'codex_quota', expectedRevision: 0 });
  assert.equal(result.settings.revision, 1);
  assert.equal(existsSync(store.file + '.lock'), false);
  assert.throws(() => store.save({ strength: 80, costPreference: 'codex_quota', expectedRevision: 0 }), error => error.status === 409);
});

test('HTTP distinguishes unknown routes from wrong methods and embeds saved opacity before paint', async t => {
  const directory = temporary(t);
  writeFileSync(join(directory, 'window-settings.json'), JSON.stringify({ opacity: 75, alwaysOnTop: true, revision: 1, updatedAt: null }));
  const panel = await startPanel(createStore(directory));
  // Close explicitly before the temporary-directory teardown.
  try {
    const headers = { Authorization: 'Bearer ' + panel.token };
    for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await fetch(panel.origin + '/api/nope', { method, headers })).status, 404);
    const wrong = await fetch(panel.origin + '/api/state', { method: 'POST', headers });
    assert.equal(wrong.status, 405); assert.equal(wrong.headers.get('allow'), 'GET');
    assert.match(await (await fetch(panel.origin + '/quota.html')).text(), /--surface-alpha:0\.75/);
  } finally { await panel.close(); }
});
