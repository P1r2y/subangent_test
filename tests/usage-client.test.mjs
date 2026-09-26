import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createUsageClient } from '../lib/usage.mjs';

function fakeCodex({ respond = true } = {}) {
  const messages = [];
  const processes = [];
  return { messages, processes, spawnProcess(executable, args, options) {
    assert.equal(executable, 'test-codex');
    assert.deepEqual(args, ['app-server']);
    assert.equal(options.windowsHide, true);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString()); messages.push(message);
      if (respond && message.method && message.id) queueMicrotask(() => {
        if (message.method === 'account/rateLimits/read') {
          child.stdout.write(JSON.stringify({ id: message.id, method: 'unsupported/serverRequest' }) + '\n');
          child.stdout.write(JSON.stringify({ id: message.id, result: { rateLimits: { primary: { usedPercent: 40 } } } }) + '\n');
        } else child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
      });
      done();
    } });
    child.kill = () => { child.killed = true; child.stdout.end(); child.stderr.end(); child.emit('close', 0); };
    processes.push(child);
    return child;
  } };
}

test('quota client shares initialization, uses only quota read, and rejects unsolicited server requests', async () => {
  const fake = fakeCodex();
  const client = createUsageClient({ executable: 'test-codex', spawnProcess: fake.spawnProcess });
  try {
    const values = await Promise.all([client.read(), client.read()]);
    assert.equal(fake.processes.length, 1);
    assert.deepEqual(fake.messages.filter(m => m.method).map(m => m.method), ['initialize', 'initialized', 'account/rateLimits/read', 'account/rateLimits/read']);
    assert.equal(values[0].rateLimits.primary.usedPercent, 40);
    assert.equal(values[1].rateLimits.primary.usedPercent, 40);
    assert.equal(fake.messages.filter(m => m.error?.code === -32601).length, 2);
  } finally { client.close(); }
  assert.equal(fake.processes[0].killed, true);
  await assert.rejects(client.read(), /停止/);
});

test('hung initialization times out, releases its process and can reconnect', async () => {
  const fake = fakeCodex({ respond: false });
  const client = createUsageClient({ executable: 'test-codex', spawnProcess: fake.spawnProcess, timeoutMs: 20 });
  try {
    await assert.rejects(client.read(), /超时/);
    assert.equal(fake.processes[0].killed, true);
    await assert.rejects(client.read(), /超时/);
    assert.equal(fake.processes.length, 2);
    assert.equal(fake.processes[1].killed, true);
  } finally { client.close(); }
});
