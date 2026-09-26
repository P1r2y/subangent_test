// 边界测试：subagent-control 设置存储（lib/store.mjs）
// 只在本插件工作区的 tests/.tmp 下创建临时目录；不读取用户密钥/配置，不联网，不改动实现。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import { DEFAULT_SETTINGS, LEVELS } from '../lib/policy.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const tempRoot = join(testsDirectory, '.tmp');
mkdirSync(tempRoot, { recursive: true });

const createdDirectories = [];
function newDirectory() {
  const directory = mkdtempSync(join(tempRoot, 'store-'));
  createdDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of createdDirectories) {
    if (!resolve(directory).startsWith(resolve(tempRoot) + sep)) throw new Error('拒绝清理测试根目录以外路径');
    rmSync(directory, { recursive: true, force: true });
  }
  if (existsSync(tempRoot) && readdirSync(tempRoot).length === 0) rmdirSync(tempRoot);
});

const readText = (file) => readFileSync(file, 'utf8');
const listDirectory = (directory) => readdirSync(directory).sort();

// ------------------------------------------------------------------ 默认与读取

test('未保存时默认 70 档，且读取不写盘', () => {
  const directory = newDirectory();
  const store = createStore(directory);
  assert.equal(store.file, join(directory, 'settings.json'));

  const first = store.read();
  assert.deepEqual(first, DEFAULT_SETTINGS);
  assert.deepEqual(first, { strength: 70, costPreference: 'codex_quota', enabled: true, revision: 0, updatedAt: null });
  assert.notEqual(first, DEFAULT_SETTINGS); // 必须是副本，不能是共享对象

  // 读取不得创建任何文件
  assert.equal(existsSync(store.file), false);
  assert.deepEqual(listDirectory(directory), []);

  // 修改返回值不得污染默认值或后续读取
  first.strength = 10;
  assert.equal(DEFAULT_SETTINGS.strength, 70);
  assert.equal(store.read().strength, 70);
  assert.notEqual(store.read(), store.read());

  const snapshot = store.state();
  assert.deepEqual(snapshot.settings, DEFAULT_SETTINGS);
  assert.equal(snapshot.policy.strength, 70);
  assert.equal(snapshot.policy.maxDelegations, 13); // 1 + (70 - 10) / 5
  assert.deepEqual([...snapshot.levels], [...LEVELS]);

  // 目录不存在时同样返回默认值，且不创建目录
  const nested = join(directory, 'not-created');
  const fresh = createStore(nested);
  assert.deepEqual(fresh.read(), DEFAULT_SETTINGS);
  assert.equal(existsSync(nested), false);
});

test('保存后可重读：内容、revision、updatedAt 与磁盘一致且无残留', () => {
  const directory = newDirectory();
  const store = createStore(directory);

  const result = store.save({ strength: 45, costPreference: 'api_cost', expectedRevision: 0 });
  assert.equal(result.settings.strength, 45);
  assert.equal(result.settings.costPreference, 'api_cost');
  assert.equal(result.settings.revision, 1);
  assert.equal(typeof result.settings.updatedAt, 'string');
  assert.equal(new Date(result.settings.updatedAt).toISOString(), result.settings.updatedAt);
  assert.equal(result.policy.strength, 45);
  assert.equal(result.policy.maxDelegations, 8); // 1 + (45 - 10) / 5
  assert.deepEqual([...result.levels], [...LEVELS]);

  // 同一句柄与新建句柄都能读到同一份内容
  assert.deepEqual(store.read(), result.settings);
  assert.deepEqual(createStore(directory).read(), result.settings);

  const onDisk = JSON.parse(readText(store.file));
  assert.deepEqual(onDisk, result.settings);
  assert.deepEqual(Object.keys(onDisk).sort(), ['costPreference', 'enabled', 'revision', 'strength', 'updatedAt']);
  assert.deepEqual(listDirectory(directory), ['settings.json']); // 无 .lock / .tmp 残留
  assert.equal(existsSync(store.file + '.lock'), false);
});

// ------------------------------------------------------------------ revision

test('revision 从 0 起逐档递增，全 19 档都能保存并重读', () => {
  const directory = newDirectory();
  const store = createStore(directory);
  let revision = 0;
  for (const strength of LEVELS) {
    const saved = store.save({ strength, costPreference: 'codex_quota', expectedRevision: revision });
    revision += 1;
    assert.equal(saved.settings.revision, revision, `保存 ${strength}% 后 revision`);
    assert.equal(saved.settings.strength, strength);
    assert.deepEqual(store.read(), saved.settings);
    assert.equal(JSON.parse(readText(store.file)).revision, revision);
    assert.deepEqual(listDirectory(directory), ['settings.json']);
  }
  assert.equal(store.read().revision, LEVELS.length);

  // 连续三次保存：0 → 1 → 2 → 3
  const ladder = createStore(newDirectory());
  for (const [index, strength] of [30, 55, 90].entries()) {
    const saved = ladder.save({ strength, costPreference: 'codex_quota', expectedRevision: index });
    assert.equal(saved.settings.revision, index + 1);
    assert.equal(saved.settings.strength, strength);
  }
  assert.equal(ladder.read().revision, 3);
});

test('旧 revision 冲突：报 409、不覆盖文件、可用正确 revision 恢复', () => {
  const directory = newDirectory();
  const store = createStore(directory);
  const first = store.save({ strength: 60, costPreference: 'codex_quota', expectedRevision: 0 });
  assert.equal(first.settings.revision, 1);
  const before = readText(store.file);

  const stale = () => store.save({ strength: 65, costPreference: 'api_cost', expectedRevision: 0 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(stale, (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /已被另一个面板修改/);
      return true;
    });
    // 文件字节级不变：旧 revision 的提交既不落盘也不改 updatedAt
    assert.equal(readText(store.file), before);
    assert.deepEqual(store.read(), first.settings);
    assert.deepEqual(listDirectory(directory), ['settings.json']); // 失败后不遗留锁或临时文件
  }

  const second = store.save({ strength: 65, costPreference: 'api_cost', expectedRevision: 1 });
  assert.equal(second.settings.revision, 2);
  assert.equal(second.settings.strength, 65);
  assert.equal(second.settings.costPreference, 'api_cost');
  assert.notEqual(readText(store.file), before);

  // 两个独立句柄共享同一状态文件：落后的一方必须冲突
  const shared = newDirectory();
  const a = createStore(shared);
  const b = createStore(shared);
  a.save({ strength: 40, costPreference: 'codex_quota', expectedRevision: 0 });
  assert.throws(
    () => b.save({ strength: 45, costPreference: 'codex_quota', expectedRevision: 0 }),
    (error) => error.status === 409,
  );
  assert.equal(b.read().strength, 40);
  assert.equal(b.save({ strength: 45, costPreference: 'codex_quota', expectedRevision: 1 }).settings.revision, 2);
});

// ------------------------------------------------------------------ 坏文件

test('坏 JSON / 非法内容：抛错且不被默认值静默覆盖', () => {
  const cases = [
    { name: '截断 JSON', content: '{ "strength": 70, ' },
    { name: '空文件', content: '' },
    { name: '非对象 JSON', content: '42\n' },
    { name: '非 5 档强度', content: `${JSON.stringify({ strength: 33, costPreference: 'codex_quota', revision: 0, updatedAt: null })}\n` },
    { name: '缺失 revision', content: `${JSON.stringify({ strength: 70, costPreference: 'codex_quota', updatedAt: null })}\n` },
    { name: 'revision 为字符串', content: `${JSON.stringify({ strength: 70, costPreference: 'codex_quota', revision: '3', updatedAt: null })}\n` },
    { name: 'revision 为负', content: `${JSON.stringify({ strength: 70, costPreference: 'codex_quota', revision: -1, updatedAt: null })}\n` },
    { name: 'revision 为浮点', content: `${JSON.stringify({ strength: 70, costPreference: 'codex_quota', revision: 1.5, updatedAt: null })}\n` },
    { name: '非法 costPreference', content: `${JSON.stringify({ strength: 70, costPreference: 'free', revision: 0, updatedAt: null })}\n` },
  ];

  for (const { name, content } of cases) {
    const directory = newDirectory();
    const store = createStore(directory);
    writeFileSync(store.file, content, 'utf8');
    const before = readFileSync(store.file);

    assert.throws(() => store.read(), (error) => {
      assert.match(error.message, /设置文件无法读取或格式错误；未覆盖原文件。/, name);
      assert.ok(error.cause, `${name}：应保留 cause`);
      return true;
    }, name);
    assert.throws(() => store.state(), /无法读取或格式错误/, name);
    assert.throws(
      () => store.save({ strength: 70, costPreference: 'codex_quota', expectedRevision: 0 }),
      /无法读取或格式错误/,
      name,
    );

    // 原文件一个字节都不能变，也不能悄悄写回默认值
    assert.deepEqual(readFileSync(store.file), before, name);
    assert.deepEqual(listDirectory(directory), ['settings.json'], name);
  }

  // revision 非法时 cause 保留底层原因
  const revisionDirectory = newDirectory();
  const revisionStore = createStore(revisionDirectory);
  writeFileSync(revisionStore.file, `${JSON.stringify({ strength: 70, costPreference: 'codex_quota', revision: 1.5, updatedAt: null })}\n`, 'utf8');
  assert.throws(() => revisionStore.read(), (error) => error.cause?.message === 'invalid revision');

  // 坏文件失败后锁与临时文件都清理干净：手工修复即可继续保存
  const recoverDirectory = newDirectory();
  const recover = createStore(recoverDirectory);
  writeFileSync(recover.file, 'not json at all', 'utf8');
  assert.throws(() => recover.save({ strength: 70, costPreference: 'codex_quota', expectedRevision: 0 }), /无法读取或格式错误/);
  assert.deepEqual(listDirectory(recoverDirectory), ['settings.json']);
  writeFileSync(recover.file, `${JSON.stringify({ strength: 70, costPreference: 'codex_quota', revision: 0, updatedAt: null })}\n`, 'utf8');
  const fixed = recover.save({ strength: 80, costPreference: 'api_cost', expectedRevision: 0 });
  assert.equal(fixed.settings.revision, 1);
  assert.equal(fixed.settings.strength, 80);
  assert.deepEqual(listDirectory(recoverDirectory), ['settings.json']);
});

// ------------------------------------------------------------------ save 校验

test('save 参数校验失败时不写入任何文件', () => {
  const directory = newDirectory();
  const nested = join(directory, 'state'); // 目标目录尚不存在
  const store = createStore(nested);
  assert.equal(existsSync(nested), false);

  for (const expectedRevision of [undefined, null, -1, 1.5, '0', NaN, Infinity, true, {}]) {
    assert.throws(
      () => store.save({ strength: 70, costPreference: 'codex_quota', expectedRevision }),
      /expectedRevision/,
      `expectedRevision=${String(expectedRevision)}`,
    );
  }
  // 强度/偏好非法同样在落盘前失败
  assert.throws(() => store.save({ strength: 33, costPreference: 'codex_quota', expectedRevision: 0 }), /强度必须/);
  assert.throws(() => store.save({ strength: '70', costPreference: 'codex_quota', expectedRevision: 0 }), /强度必须/);
  assert.throws(() => store.save({ strength: 70, costPreference: 'free', expectedRevision: 0 }), /成本偏好必须/);
  assert.throws(() => store.save({ strength: 70, expectedRevision: 0 }), /成本偏好必须/);
  assert.equal(existsSync(nested), false, '失败时不应创建目录或文件');

  // 只有合法输入才创建目录并落盘
  const saved = store.save({ strength: 70, costPreference: 'codex_quota', expectedRevision: 0 });
  assert.equal(saved.settings.revision, 1);
  assert.deepEqual(listDirectory(nested), ['settings.json']);
  assert.deepEqual(listDirectory(directory), ['state']);
});

test('并发锁：已存在 lock 文件时返回 409 且不改动设置', () => {
  const directory = newDirectory();
  const store = createStore(directory);
  store.save({ strength: 50, costPreference: 'codex_quota', expectedRevision: 0 });
  const before = readText(store.file);

  const lock = store.file + '.lock';
  writeFileSync(lock, '', 'utf8');
  assert.throws(() => store.save({ strength: 55, costPreference: 'codex_quota', expectedRevision: 1 }), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /另一个窗口正在保存/);
    return true;
  });
  assert.equal(readText(store.file), before);
  assert.equal(store.read().strength, 50);
  assert.equal(store.read().revision, 1);

  // 锁释放后可以正常保存，且不遗留临时文件
  rmSync(lock, { force: true });
  const recovered = store.save({ strength: 55, costPreference: 'codex_quota', expectedRevision: 1 });
  assert.equal(recovered.settings.revision, 2);
  assert.equal(recovered.settings.strength, 55);
  assert.deepEqual(listDirectory(directory), ['settings.json']);
  assert.equal(existsSync(lock), false);
});
