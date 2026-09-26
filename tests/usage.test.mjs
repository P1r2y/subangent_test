// 契约测试：subagent-control 额度读取（lib/usage.mjs）
// 全部使用注入的 mock client 与手动时钟：不联网、不启动 Codex、不读取用户凭据，也不改动实现。
// 只覆盖 normalizeUsage 与 createUsageReader 的既有契约；不涉及 createUsageClient 与任何鉴权/安全行为。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUsageReader, normalizeUsage } from '../lib/usage.mjs';

// 手动时钟基准（毫秒）；协议里的 resetsAt 是「秒」，两者换算关系是契约的一部分。
const BASE = Date.UTC(2024, 5, 1, 12, 0, 0);
const toSeconds = (ms) => Math.floor(ms / 1000);

function codexReply(...windows) {
  const [primary, secondary] = windows;
  return {
    accountId: 'acct-must-not-leak',
    rateLimitsByLimitId: {
      codex: {
        ...(primary === undefined ? {} : { primary }),
        ...(secondary === undefined ? {} : { secondary }),
      },
    },
  };
}

function makeClock(start = BASE) {
  let value = start;
  return {
    now: () => value,
    advance(ms) { value += ms; },
  };
}

// 按脚本顺序响应；步数用尽后再被调用即报错，避免测试悄悄多调用一次。
function mockClient(steps) {
  const calls = { read: 0, close: 0 };
  const client = {
    async read() {
      const step = steps[calls.read];
      calls.read += 1;
      if (step === undefined) throw new Error('mock client 被额外调用（超出测试脚本步骤）');
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step() : step;
    },
    close() { calls.close += 1; },
  };
  return { client, calls };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ------------------------------------------------------- normalizeUsage：来源与白名单

test('normalizeUsage：优先 rateLimitsByLimitId.codex，而不是 legacy rateLimits', () => {
  const result = normalizeUsage({
    accountId: 'acct-must-not-leak',
    rateLimits: {
      primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: toSeconds(BASE + 600000) },
      secondary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: toSeconds(BASE + 600000) },
    },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: toSeconds(BASE + 600000) },
        secondary: { usedPercent: 50, windowDurationMins: 300, resetsAt: toSeconds(BASE + 300000) },
      },
    },
  }, BASE);

  assert.equal(result.status, 'ready');
  assert.deepEqual(result.windows.map(item => [item.label, item.remainingPercent]), [['5 小时', 50], ['每周', 75]]);
  // legacy 的 10 / 5 剩余不得出现
  assert.deepEqual(result.windows.map(item => item.remainingPercent), [50, 75]);
});

test('normalizeUsage：rateLimitsByLimitId 只有其他 bucket 时不显示错误 quota', () => {
  const result = normalizeUsage({
    rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
    rateLimitsByLimitId: {
      codex_other_account: { primary: { usedPercent: 1, windowDurationMins: 10080 } },
    },
  }, BASE);

  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.windows, []);
});

test('normalizeUsage：rateLimitsByLimitId 为空对象时才回退 legacy rateLimits', () => {
  const result = normalizeUsage({
    rateLimitsByLimitId: {},
    rateLimits: { primary: { usedPercent: 40, windowDurationMins: 1440 } },
  }, BASE);

  assert.equal(result.status, 'ready');
  assert.deepEqual(result.windows.map(item => [item.label, item.remainingPercent]), [['1 天', 60]]);
});

test('normalizeUsage：结果只保留白名单字段，不泄漏 accountId', () => {
  const result = normalizeUsage({
    accountId: 'acct-must-not-leak',
    account: { email: 'user@example.invalid', token: 'SECRET-TOKEN' },
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: toSeconds(BASE + 60000) } },
    },
  }, BASE);

  assert.deepEqual(Object.keys(result).sort(), ['message', 'stale', 'status', 'updatedAt', 'windows']);
  assert.deepEqual(Object.keys(result.windows[0]).sort(), ['label', 'remainingPercent', 'resetsAt', 'windowDurationMins']);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('acct-must-not-leak'), false);
  assert.equal(serialized.includes('SECRET-TOKEN'), false);
  assert.equal(serialized.includes('user@example.invalid'), false);
  assert.equal(result.updatedAt, new Date(BASE).toISOString());
  assert.equal(result.stale, false);
});

test('normalizeUsage：无响应或空响应时返回 unavailable，updatedAt 仍是 ISO 时间', () => {
  for (const response of [undefined, null, {}, { rateLimitsByLimitId: null }]) {
    const result = normalizeUsage(response, BASE);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.windows, []);
    assert.equal(result.updatedAt, new Date(BASE).toISOString());
    assert.equal(result.stale, false);
    assert.equal(typeof result.message, 'string');
    assert.equal(result.message.length > 0, true);
  }
  assert.equal(Number.isFinite(Date.parse(normalizeUsage({}).updatedAt)), true);
});

// ------------------------------------------------------- normalizeUsage：窗口标签与排序

test('normalizeUsage：primary 10080 标“每周”（不假定 5 小时），secondary 300 标“5 小时”，并按实际时长排序', () => {
  const result = normalizeUsage(codexReply(
    { usedPercent: 20, windowDurationMins: 10080, resetsAt: toSeconds(BASE + 600000) },
    { usedPercent: 30, windowDurationMins: 300, resetsAt: toSeconds(BASE + 60000) },
  ), BASE);

  assert.equal(result.status, 'ready');
  assert.deepEqual(result.windows.map(item => item.label), ['5 小时', '每周']);
  assert.deepEqual(result.windows.map(item => item.windowDurationMins), [300, 10080]);
  assert.deepEqual(result.windows.map(item => item.remainingPercent), [70, 80]);
});

test('normalizeUsage：标签跟随实际时长，而不是 primary/secondary 槽位', () => {
  const result = normalizeUsage(codexReply(
    { usedPercent: 20, windowDurationMins: 300 },
    { usedPercent: 20, windowDurationMins: 10080 },
  ), BASE);

  assert.deepEqual(result.windows.map(item => [item.label, item.windowDurationMins]), [['5 小时', 300], ['每周', 10080]]);
});

test('normalizeUsage：其他时长标签正确，缺失/非正时长的窗口标“当前周期”并排在最后', () => {
  const days = normalizeUsage(codexReply(
    { usedPercent: 10, windowDurationMins: 90 },
    { usedPercent: 20, windowDurationMins: 1440 },
  ), BASE);
  assert.deepEqual(days.windows.map(item => [item.label, item.windowDurationMins]), [['90 分钟', 90], ['1 天', 1440]]);

  const hours = normalizeUsage(codexReply({ usedPercent: 10, windowDurationMins: 60 }), BASE);
  assert.deepEqual(hours.windows.map(item => item.label), ['1 小时']);

  const missing = normalizeUsage(codexReply(
    { usedPercent: 10 },
    { usedPercent: 20, windowDurationMins: 0 },
  ), BASE);
  assert.deepEqual(missing.windows.map(item => [item.label, item.windowDurationMins]), [['当前周期', null], ['当前周期', null]]);
  assert.deepEqual(missing.windows.map(item => item.remainingPercent), [90, 80]);

  const negative = normalizeUsage(codexReply({ usedPercent: 10, windowDurationMins: -5 }), BASE);
  assert.deepEqual(negative.windows.map(item => [item.label, item.windowDurationMins]), [['当前周期', null]]);
});

// ------------------------------------------------------- normalizeUsage：usedPercent 有效性与 clamp

test('normalizeUsage：缺失/null/字符串/NaN 的 usedPercent 不得被当成 0 或 100', () => {
  const invalid = [
    ['缺失', {}],
    ['undefined', { usedPercent: undefined }],
    ['null', { usedPercent: null }],
    ['字符串 "0"', { usedPercent: '0' }],
    ['字符串 "100"', { usedPercent: '100' }],
    ['NaN', { usedPercent: Number.NaN }],
    ['Infinity', { usedPercent: Number.POSITIVE_INFINITY }],
    ['布尔 true', { usedPercent: true }],
  ];

  for (const [name, primary] of invalid) {
    const result = normalizeUsage(codexReply({ ...primary, windowDurationMins: 300 }), BASE);
    assert.deepEqual(result.windows, [], `usedPercent ${name} 不应产生窗口（不得默认成 0 或 100）`);
    assert.equal(result.status, 'unavailable', `usedPercent ${name} 时状态应为 unavailable`);
  }
});

test('normalizeUsage：非法 usedPercent 的窗口被丢弃，合法窗口按真实数值保留', () => {
  const result = normalizeUsage(codexReply(
    { usedPercent: '50', windowDurationMins: 10080 },
    { usedPercent: 40, windowDurationMins: 300 },
  ), BASE);

  assert.equal(result.status, 'ready');
  assert.deepEqual(result.windows.map(item => [item.label, item.remainingPercent]), [['5 小时', 60]]);
});

test('normalizeUsage：真正的 0% 已用显示 100 剩余，100% 已用显示 0 剩余', () => {
  const zero = normalizeUsage(codexReply({ usedPercent: 0, windowDurationMins: 10080 }), BASE);
  assert.equal(zero.status, 'ready');
  assert.deepEqual(zero.windows.map(item => item.remainingPercent), [100]);

  const full = normalizeUsage(codexReply({ usedPercent: 100, windowDurationMins: 300 }), BASE);
  assert.equal(full.status, 'ready');
  assert.deepEqual(full.windows.map(item => item.remainingPercent), [0]);
});

test('normalizeUsage：usedPercent 超出 0..100 时 clamp 剩余百分比', () => {
  const over = normalizeUsage(codexReply({ usedPercent: 137.5, windowDurationMins: 10080 }), BASE);
  assert.deepEqual(over.windows.map(item => item.remainingPercent), [0]);

  const under = normalizeUsage(codexReply({ usedPercent: -20, windowDurationMins: 300 }), BASE);
  assert.deepEqual(under.windows.map(item => item.remainingPercent), [100]);

  const far = normalizeUsage(codexReply({ usedPercent: 1e9, windowDurationMins: 10080 }), BASE);
  assert.deepEqual(far.windows.map(item => item.remainingPercent), [0]);
});

test('normalizeUsage：剩余百分比四舍五入到一位小数', () => {
  const first = normalizeUsage(codexReply({ usedPercent: 33.33, windowDurationMins: 10080 }), BASE);
  assert.deepEqual(first.windows.map(item => item.remainingPercent), [66.7]);

  const second = normalizeUsage(codexReply({ usedPercent: 12.34, windowDurationMins: 300 }), BASE);
  assert.deepEqual(second.windows.map(item => item.remainingPercent), [87.7]);
});

test('normalizeUsage：resetsAt 仅在有限数值时保留，否则为 null', () => {
  const mixed = normalizeUsage(codexReply(
    { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1735689600 },
    { usedPercent: 20, windowDurationMins: 300, resetsAt: Number.NaN },
  ), BASE);
  assert.deepEqual(mixed.windows.map(item => item.resetsAt), [null, 1735689600]);

  const missing = normalizeUsage(codexReply(
    { usedPercent: 10, windowDurationMins: 300 },
    { usedPercent: 20, windowDurationMins: 10080, resetsAt: '1735689600' },
  ), BASE);
  assert.deepEqual(missing.windows.map(item => item.resetsAt), [null, null]);
});

test('normalizeUsage：credits 不构造成额度窗口', () => {
  const noWindows = normalizeUsage({
    accountId: 'acct-must-not-leak',
    credits: { hasCredits: true, unlimited: true, balance: '42' },
    rateLimitsByLimitId: {
      codex: { credits: { hasCredits: true, unlimited: false, balance: '42' }, primary: null, secondary: null },
    },
  }, BASE);
  assert.equal(noWindows.status, 'unavailable');
  assert.deepEqual(noWindows.windows, []);

  const withWindows = normalizeUsage({
    credits: { hasCredits: true, unlimited: true },
    rateLimitsByLimitId: {
      codex: { credits: { hasCredits: true }, primary: { usedPercent: 10, windowDurationMins: 10080 } },
    },
  }, BASE);
  assert.deepEqual(withWindows.windows.map(item => item.remainingPercent), [90]);
  assert.deepEqual(Object.keys(withWindows).sort(), ['message', 'stale', 'status', 'updatedAt', 'windows']);
});

// ------------------------------------------------------- createUsageReader：并发、缓存、失败回退、close

test('createUsageReader：同一时刻并发读取只调用一次 client.read', async () => {
  const clock = makeClock();
  const gate = deferred();
  const { client, calls } = mockClient([() => gate.promise]);
  const reader = createUsageReader({ client, now: clock.now });

  const first = reader.read();
  const second = reader.read();
  const third = reader.read();
  assert.equal(calls.read, 1, '并发发起时只应产生一次调用');

  gate.resolve(codexReply({ usedPercent: 20, windowDurationMins: 10080, resetsAt: toSeconds(BASE + 600000) }));
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.equal(calls.read, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(a.status, 'ready');

  const cached = await reader.read();
  assert.equal(calls.read, 1);
  assert.equal(cached, a);
  assert.equal(cached.updatedAt, new Date(BASE).toISOString(), '应使用注入的时钟');
});

test('createUsageReader：默认 15 秒缓存内不重复调用，满 15 秒后刷新', async () => {
  const clock = makeClock();
  const { client, calls } = mockClient([
    codexReply({ usedPercent: 20, windowDurationMins: 10080, resetsAt: toSeconds(BASE + 900000) }),
    codexReply({ usedPercent: 60, windowDurationMins: 10080, resetsAt: toSeconds(BASE + 900000) }),
  ]);
  const reader = createUsageReader({ client, now: clock.now });

  const first = await reader.read();
  assert.equal(calls.read, 1);
  assert.deepEqual(first.windows.map(item => item.remainingPercent), [80]);

  clock.advance(14999);
  const cached = await reader.read();
  assert.equal(calls.read, 1);
  assert.equal(cached, first);

  clock.advance(1);
  const refreshed = await reader.read();
  assert.equal(calls.read, 2);
  assert.deepEqual(refreshed.windows.map(item => item.remainingPercent), [40]);
  assert.equal(refreshed.stale, false);
});

test('createUsageReader：失败时保留未过重置时间的旧值并标记 stale', async () => {
  const clock = makeClock();
  const { client, calls } = mockClient([
    codexReply(
      { usedPercent: 25, windowDurationMins: 10080, resetsAt: toSeconds(BASE + 3600000) },
      { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
    ),
    new Error('mock 读取失败'),
  ]);
  const reader = createUsageReader({ client, now: clock.now });

  const good = await reader.read();
  assert.equal(good.status, 'ready');

  clock.advance(15000);
  const failed = await reader.read();
  assert.equal(calls.read, 2);
  assert.equal(failed.status, 'error');
  assert.equal(failed.stale, true);
  assert.deepEqual(failed.windows, good.windows);
  assert.equal(failed.updatedAt, good.updatedAt);
  assert.equal(typeof failed.message, 'string');
});

test('createUsageReader：失败时丢弃已过重置时间的旧窗口，只保留仍然有效的窗口', async () => {
  const clock = makeClock();
  const { client } = mockClient([
    codexReply(
      { usedPercent: 25, windowDurationMins: 10080, resetsAt: toSeconds(BASE - 1000) },
      { usedPercent: 40, windowDurationMins: 300, resetsAt: toSeconds(BASE + 60000) },
    ),
    new Error('mock 读取失败'),
  ]);
  const reader = createUsageReader({ client, now: clock.now });

  const good = await reader.read();
  assert.deepEqual(good.windows.map(item => item.label), ['5 小时', '每周']);

  clock.advance(15000);
  const failed = await reader.read();
  assert.equal(failed.status, 'error');
  assert.equal(failed.stale, true);
  assert.deepEqual(failed.windows.map(item => [item.label, item.remainingPercent]), [['5 小时', 60]]);
  assert.equal(failed.windows.some(item => item.windowDurationMins === 10080), false);
});

test('createUsageReader：旧值全部过了重置时间后失败不再显示旧值', async () => {
  const clock = makeClock();
  const { client } = mockClient([
    codexReply({ usedPercent: 25, windowDurationMins: 10080, resetsAt: toSeconds(BASE + 1000) }),
    new Error('mock 读取失败'),
  ]);
  const reader = createUsageReader({ client, now: clock.now });

  const good = await reader.read();
  assert.equal(good.status, 'ready');

  clock.advance(15000); // now 已越过 resetsAt
  const failed = await reader.read();
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.windows, []);
  assert.equal(failed.stale, false);
  assert.equal(failed.updatedAt, null);
});

test('createUsageReader：有效但无额度的结果清除旧账户缓存，之后失败不再回退旧值', async () => {
  const clock = makeClock();
  const { client, calls } = mockClient([
    codexReply({ usedPercent: 30, windowDurationMins: 10080, resetsAt: toSeconds(BASE + 3600000) }),
    {},
    new Error('mock 读取失败'),
  ]);
  const reader = createUsageReader({ client, now: clock.now });

  const good = await reader.read();
  assert.equal(good.status, 'ready');
  assert.deepEqual(good.windows.map(item => item.remainingPercent), [70]);

  clock.advance(15000);
  const empty = await reader.read();
  assert.equal(empty.status, 'unavailable');
  assert.deepEqual(empty.windows, []);
  assert.equal(empty.stale, false);

  clock.advance(15000);
  const failed = await reader.read();
  assert.equal(calls.read, 3);
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.windows, [], '旧账户的窗口必须已被清除');
  assert.equal(failed.stale, false);
  assert.equal(failed.updatedAt, null);
});

test('createUsageReader：失败结果在 15 秒内被缓存，满 15 秒后才重试并可恢复', async () => {
  const clock = makeClock();
  const { client, calls } = mockClient([
    new Error('mock 读取失败'),
    codexReply({ usedPercent: 10, windowDurationMins: 300, resetsAt: toSeconds(BASE + 3600000) }),
  ]);
  const reader = createUsageReader({ client, now: clock.now });

  const failed = await reader.read();
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.windows, []);
  assert.equal(failed.stale, false);

  clock.advance(14999);
  const cached = await reader.read();
  assert.equal(calls.read, 1);
  assert.equal(cached, failed);

  clock.advance(1);
  const recovered = await reader.read();
  assert.equal(calls.read, 2);
  assert.equal(recovered.status, 'ready');
  assert.deepEqual(recovered.windows.map(item => item.remainingPercent), [90]);
  assert.equal(recovered.stale, false);
});

test('createUsageReader：close 调用 client.close，之后读取返回停止状态且不再调用 client', async () => {
  const clock = makeClock();
  const { client, calls } = mockClient([codexReply({ usedPercent: 10, windowDurationMins: 300 })]);
  const reader = createUsageReader({ client, now: clock.now });

  reader.close();
  assert.equal(calls.close, 1);
  assert.equal(calls.read, 0);

  const result = await reader.read();
  assert.equal(calls.read, 0, 'close 后不得再调用 client.read');
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.windows, []);
  assert.equal(result.updatedAt, null);
  assert.equal(result.stale, false);
  assert.equal(typeof result.message, 'string');
  assert.equal(result.message.length > 0, true);
  assert.deepEqual(Object.keys(result).sort(), ['message', 'stale', 'status', 'updatedAt', 'windows']);
});
