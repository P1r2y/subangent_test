// 边界测试：独立窗口偏好存储（lib/window-store.mjs）
// 只在本插件工作区的 .test-data 下创建临时目录；不读取用户密钥/生产设置，不联网，不改动实现。
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

import { createWindowStore } from '../lib/window-store.mjs';

const DEFAULT_SETTINGS = { opacity: 80, alwaysOnTop: true, revision: 0, updatedAt: null };
const OPACITY_LEVELS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(resolve(testsDirectory, '..'), '.test-data');
mkdirSync(dataRoot, { recursive: true });

const createdDirectories = [];
function newDirectory() {
  const directory = mkdtempSync(join(dataRoot, 'window-store-'));
  createdDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of createdDirectories) {
    if (!resolve(directory).startsWith(resolve(dataRoot) + sep)) throw new Error('拒绝清理测试根目录以外路径');
    rmSync(directory, { recursive: true, force: true });
  }
  // 只在本测试留下的空目录才回收，绝不动其他测试的数据
  if (existsSync(dataRoot) && readdirSync(dataRoot).length === 0) rmdirSync(dataRoot);
});

const readText = (file) => readFileSync(file, 'utf8');
const listDirectory = (directory) => readdirSync(directory).sort();

// ------------------------------------------------------------------ 默认与持久化

test('未保存时默认 opacity 80 / alwaysOnTop true，读取不创建任何文件', () => {
  const directory = newDirectory();
  const store = createWindowStore(directory);
  assert.equal(store.file, join(directory, 'window-settings.json'));
  assert.deepEqual(Object.keys(store).sort(), ['file', 'read', 'save']);

  const first = store.read();
  assert.deepEqual(first, DEFAULT_SETTINGS);
  assert.notEqual(first, DEFAULT_SETTINGS); // 必须是副本，不能是共享对象

  // 读取不得创建文件或目录
  assert.equal(existsSync(store.file), false);
  assert.deepEqual(listDirectory(directory), []);

  // 修改返回值不得污染后续读取
  first.opacity = 50;
  first.alwaysOnTop = false;
  assert.deepEqual(store.read(), DEFAULT_SETTINGS);
  assert.notEqual(store.read(), store.read());

  // 目录尚不存在时同样返回默认值，且不创建目录
  const nested = join(directory, 'not-created');
  const fresh = createWindowStore(nested);
  assert.deepEqual(fresh.read(), DEFAULT_SETTINGS);
  assert.equal(existsSync(nested), false);

  // 目录参数必须显式传入：没有默认目录可用
  assert.throws(() => createWindowStore(), /显式传入目录/);
  assert.throws(() => createWindowStore(''), /显式传入目录/);
  assert.equal(existsSync(directory), true);
  assert.deepEqual(listDirectory(directory), []);
});

test('保存后可重读：revision+1、ISO updatedAt、磁盘一致且无残留', () => {
  const directory = newDirectory();
  const store = createWindowStore(directory);

  const result = store.save({ opacity: 65, alwaysOnTop: false, expectedRevision: 0 });
  assert.deepEqual(Object.keys(result), ['settings']);
  assert.equal(result.settings.opacity, 65);
  assert.equal(result.settings.alwaysOnTop, false);
  assert.equal(result.settings.revision, 1);
  assert.equal(typeof result.settings.updatedAt, 'string');
  assert.equal(new Date(result.settings.updatedAt).toISOString(), result.settings.updatedAt);

  // 同一句柄与新建句柄都能读到同一份内容
  assert.deepEqual(store.read(), result.settings);
  assert.deepEqual(createWindowStore(directory).read(), result.settings);

  const onDisk = JSON.parse(readText(store.file));
  assert.deepEqual(onDisk, result.settings);
  assert.deepEqual(Object.keys(onDisk).sort(), ['alwaysOnTop', 'opacity', 'revision', 'updatedAt']); // 严格白名单
  assert.deepEqual(listDirectory(directory), ['window-settings.json']); // 无 .lock / .tmp 残留
  assert.equal(existsSync(store.file + '.lock'), false);

  // 连续保存只递增 revision，updatedAt 每次由服务端生成
  const second = store.save({ opacity: 100, alwaysOnTop: true, expectedRevision: 1 });
  assert.equal(second.settings.revision, 2);
  assert.equal(second.settings.opacity, 100);
  assert.equal(second.settings.alwaysOnTop, true);
  assert.deepEqual(listDirectory(directory), ['window-settings.json']);
});

test('opacity 全 11 档都能保存并重读，revision 从 0 起逐档递增', () => {
  const directory = newDirectory();
  const store = createWindowStore(directory);
  let revision = 0;
  for (const opacity of OPACITY_LEVELS) {
    const saved = store.save({ opacity, alwaysOnTop: revision % 2 === 0, expectedRevision: revision });
    revision += 1;
    assert.equal(saved.settings.revision, revision, `保存 ${opacity}% 后 revision`);
    assert.equal(saved.settings.opacity, opacity);
    assert.deepEqual(store.read(), saved.settings);
    assert.deepEqual(listDirectory(directory), ['window-settings.json']);
  }
  assert.equal(store.read().revision, OPACITY_LEVELS.length);
});

// ------------------------------------------------------------------ 冲突

test('过期 revision 与并发锁：409 冲突、文件不变、不删别人的锁', () => {
  const directory = newDirectory();
  const store = createWindowStore(directory);
  const first = store.save({ opacity: 80, alwaysOnTop: true, expectedRevision: 0 });
  assert.equal(first.settings.revision, 1);
  const before = readText(store.file);

  const stale = () => store.save({ opacity: 85, alwaysOnTop: false, expectedRevision: 0 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(stale, (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /已被另一个窗口修改/);
      return true;
    });
    // 字节级不变：旧 revision 的提交既不落盘也不改 updatedAt
    assert.equal(readText(store.file), before);
    assert.deepEqual(store.read(), first.settings);
    assert.deepEqual(listDirectory(directory), ['window-settings.json']); // 失败后不遗留锁或临时文件
  }

  const second = store.save({ opacity: 85, alwaysOnTop: false, expectedRevision: 1 });
  assert.equal(second.settings.revision, 2);
  assert.equal(second.settings.opacity, 85);
  assert.notEqual(readText(store.file), before);

  // 两个独立句柄共享同一状态文件：落后的一方必须冲突
  const shared = newDirectory();
  const a = createWindowStore(shared);
  const b = createWindowStore(shared);
  a.save({ opacity: 60, alwaysOnTop: true, expectedRevision: 0 });
  assert.throws(
    () => b.save({ opacity: 95, alwaysOnTop: false, expectedRevision: 0 }),
    (error) => error.status === 409,
  );
  assert.equal(b.read().opacity, 60);
  assert.equal(b.read().revision, 1);
  assert.equal(b.save({ opacity: 95, alwaysOnTop: false, expectedRevision: 1 }).settings.revision, 2);

  // 并发锁：已存在别人的锁时 409，且必须保留别人的锁（内容也不能被删改）
  const lockedDirectory = newDirectory();
  const lockedStore = createWindowStore(lockedDirectory);
  lockedStore.save({ opacity: 70, alwaysOnTop: true, expectedRevision: 0 });
  const lockedBefore = readText(lockedStore.file);
  const foreignLock = lockedStore.file + '.lock';
  writeFileSync(foreignLock, 'other-window', 'utf8');

  assert.throws(() => lockedStore.save({ opacity: 75, alwaysOnTop: true, expectedRevision: 1 }), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /另一个窗口正在保存/);
    return true;
  });
  assert.equal(existsSync(foreignLock), true, '不得删除别人的锁');
  assert.equal(readText(foreignLock), 'other-window', '不得改动别人的锁');
  assert.equal(readText(lockedStore.file), lockedBefore);
  assert.equal(lockedStore.read().opacity, 70);
  assert.equal(lockedStore.read().revision, 1);
  assert.deepEqual(listDirectory(lockedDirectory), ['window-settings.json', 'window-settings.json.lock']);

  // 锁释放后可以正常保存，且不遗留临时文件
  rmSync(foreignLock, { force: true });
  const recovered = lockedStore.save({ opacity: 75, alwaysOnTop: true, expectedRevision: 1 });
  assert.equal(recovered.settings.revision, 2);
  assert.equal(recovered.settings.opacity, 75);
  assert.deepEqual(listDirectory(lockedDirectory), ['window-settings.json']);
  assert.equal(existsSync(foreignLock), false);
});

// ------------------------------------------------------------------ 非法输入

test('非法步值 / 非严格 boolean / 非白名单字段：落盘前失败且不创建文件', () => {
  const directory = newDirectory();
  const nested = join(directory, 'state'); // 目标目录尚不存在
  const store = createWindowStore(nested);
  assert.equal(existsSync(nested), false);

  for (const opacity of [49, 51, 0, 5, 45, 55.5, 100.5, 105, '80', '', null, undefined, NaN, Infinity, -Infinity, true, {}, []]) {
    assert.throws(
      () => store.save({ opacity, alwaysOnTop: true, expectedRevision: 0 }),
      /不透明度必须/,
      `opacity=${String(opacity)}`,
    );
  }
  for (const alwaysOnTop of ['true', 'false', 1, 0, null, undefined, NaN, {}, []]) {
    assert.throws(
      () => store.save({ opacity: 80, alwaysOnTop, expectedRevision: 0 }),
      /alwaysOnTop 必须/,
      `alwaysOnTop=${String(alwaysOnTop)}`,
    );
  }
  for (const expectedRevision of [undefined, null, -1, 1.5, '0', '', NaN, Infinity, true, {}]) {
    assert.throws(
      () => store.save({ opacity: 80, alwaysOnTop: true, expectedRevision }),
      /expectedRevision/,
      `expectedRevision=${String(expectedRevision)}`,
    );
  }
  // 严格字段白名单：缺字段与多字段都在落盘前拒绝
  assert.throws(() => store.save({ alwaysOnTop: true, expectedRevision: 0 }), /不透明度必须/);
  assert.throws(() => store.save({ opacity: 80, expectedRevision: 0 }), /alwaysOnTop 必须/);
  assert.throws(() => store.save({ opacity: 80, alwaysOnTop: true }), /expectedRevision/);
  assert.throws(() => store.save({ opacity: 80, alwaysOnTop: true, expectedRevision: 0, revision: 5 }), /只允许/);
  assert.throws(() => store.save({ opacity: 80, alwaysOnTop: true, expectedRevision: 0, updatedAt: null }), /只允许/);
  assert.throws(() => store.save({ opacity: 80, alwaysOnTop: true, expectedRevision: 0, extra: 1 }), /只允许/);
  assert.throws(() => store.save(null), /必须是对象/);
  assert.throws(() => store.save('80'), /必须是对象/);
  assert.throws(() => store.save([]), /必须是对象/);
  assert.equal(existsSync(nested), false, '失败时不应创建目录或文件');
  assert.deepEqual(listDirectory(directory), []);

  // 只有合法输入才创建目录并落盘
  const saved = store.save({ opacity: 80, alwaysOnTop: true, expectedRevision: 0 });
  assert.equal(saved.settings.revision, 1);
  assert.deepEqual(listDirectory(nested), ['window-settings.json']);
  assert.deepEqual(listDirectory(directory), ['state']);
});

// ------------------------------------------------------------------ 坏文件

test('损坏或非法文件：read 明确报错、save 拒绝，且原文件一个字节都不被覆盖', () => {
  const stored = (overrides) => `${JSON.stringify({ ...DEFAULT_SETTINGS, ...overrides })}\n`;
  const cases = [
    { name: '截断 JSON', content: '{ "opacity": 80, ' },
    { name: '空文件', content: '' },
    { name: '非对象 JSON', content: '42\n' },
    { name: '数组 JSON', content: '[]\n' },
    { name: 'JSON null', content: 'null\n' },
    { name: '非 5 档透明度', content: stored({ opacity: 53 }) },
    { name: '透明度越界', content: stored({ opacity: 105 }) },
    { name: '透明度为字符串', content: stored({ opacity: '80' }) },
    { name: 'alwaysOnTop 非布尔', content: stored({ alwaysOnTop: 'true' }) },
    { name: 'alwaysOnTop 为数字', content: stored({ alwaysOnTop: 1 }) },
    { name: '缺失 alwaysOnTop', content: `${JSON.stringify({ opacity: 80, revision: 0, updatedAt: null })}\n` },
    { name: '缺失 revision', content: `${JSON.stringify({ opacity: 80, alwaysOnTop: true, updatedAt: null })}\n` },
    { name: 'revision 为字符串', content: stored({ revision: '3' }) },
    { name: 'revision 为负', content: stored({ revision: -1 }) },
    { name: 'revision 为浮点', content: stored({ revision: 1.5 }) },
    { name: 'revision 超出安全整数', content: stored({ revision: Number.MAX_SAFE_INTEGER + 1 }) },
    { name: '多余字段', content: stored({ extra: 1 }) },
    { name: '缺失 updatedAt', content: `${JSON.stringify({ opacity: 80, alwaysOnTop: true, revision: 0 })}\n` },
    { name: 'updatedAt 非法字符串', content: stored({ updatedAt: 'yesterday' }) },
    { name: 'updatedAt 为数字', content: stored({ updatedAt: 0 }) },
  ];

  for (const { name, content } of cases) {
    const directory = newDirectory();
    const store = createWindowStore(directory);
    writeFileSync(store.file, content, 'utf8');
    const before = readFileSync(store.file);

    assert.throws(() => store.read(), (error) => {
      assert.match(error.message, /窗口设置文件无法读取或格式错误；未覆盖原文件。/, name);
      assert.ok(error.cause, `${name}：应保留 cause`);
      return true;
    }, name);
    assert.throws(
      () => store.save({ opacity: 90, alwaysOnTop: true, expectedRevision: 0 }),
      /无法读取或格式错误/,
      name,
    );

    // 原文件一个字节都不能变，也不能悄悄写回默认值；不留锁或临时文件
    assert.deepEqual(readFileSync(store.file), before, name);
    assert.deepEqual(listDirectory(directory), ['window-settings.json'], name);
  }

  // 坏文件失败后锁已清理干净：手工修复即可继续保存
  const recoverDirectory = newDirectory();
  const recover = createWindowStore(recoverDirectory);
  writeFileSync(recover.file, 'not json at all', 'utf8');
  assert.throws(() => recover.save({ opacity: 80, alwaysOnTop: true, expectedRevision: 0 }), /无法读取或格式错误/);
  assert.deepEqual(listDirectory(recoverDirectory), ['window-settings.json']);
  writeFileSync(recover.file, stored({ revision: 0, updatedAt: null }), 'utf8');
  const fixed = recover.save({ opacity: 90, alwaysOnTop: false, expectedRevision: 0 });
  assert.equal(fixed.settings.revision, 1);
  assert.equal(fixed.settings.opacity, 90);
  assert.equal(fixed.settings.alwaysOnTop, false);
  assert.deepEqual(listDirectory(recoverDirectory), ['window-settings.json']);
});
