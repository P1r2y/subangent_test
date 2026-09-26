// 窗口偏好存储：原子写 + revision 防冲突，模式与 lib/store.mjs 保持一致。
// directory 必须由调用方显式传入；这里不读 homedir，也没有任何默认目录。
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireFileLock } from './file-lock.mjs';

const OPACITY_LEVELS = Object.freeze(Array.from({ length: 11 }, (_, i) => 50 + i * 5)); // 50–100，步进 5
const SETTINGS_KEYS = Object.freeze(['alwaysOnTop', 'opacity', 'revision', 'updatedAt']); // 严格白名单
const SAVE_KEYS = Object.freeze(['alwaysOnTop', 'expectedRevision', 'opacity']); // 严格白名单
const DEFAULT_SETTINGS = Object.freeze({ opacity: 80, alwaysOnTop: true, revision: 0, updatedAt: null });

// 只拒绝白名单以外的字段；缺失字段交给各自的取值校验报错，错误信息更精确。
function assertAllowedKeys(value, allowed, message) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(message);
}

function validateOpacity(value) {
  if (!Number.isInteger(value) || !OPACITY_LEVELS.includes(value)) throw new Error('不透明度必须为 50–100 之间的整数，且每档相差 5。');
  return value;
}

function validateAlwaysOnTop(value) {
  if (typeof value !== 'boolean') throw new Error('alwaysOnTop 必须为 true 或 false。');
  return value;
}

function validateRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('revision 必须为非负安全整数。');
  return value;
}

function validateUpdatedAt(value) {
  if (value === null) return null;
  const parsed = typeof value === 'string' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error('updatedAt 必须为 ISO 字符串或 null。');
  return value;
}

function validateStored(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('窗口设置必须是对象。');
  assertAllowedKeys(value, SETTINGS_KEYS, '窗口设置字段不合法。');
  return {
    opacity: validateOpacity(value.opacity),
    alwaysOnTop: validateAlwaysOnTop(value.alwaysOnTop),
    revision: validateRevision(value.revision),
    updatedAt: validateUpdatedAt(value.updatedAt),
  };
}

function validateSaveInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('保存内容必须是对象。');
  assertAllowedKeys(input, SAVE_KEYS, '保存内容只允许 opacity、alwaysOnTop、expectedRevision 三个字段。');
  const opacity = validateOpacity(input.opacity);
  const alwaysOnTop = validateAlwaysOnTop(input.alwaysOnTop);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('保存需要有效的 expectedRevision。');
  return { opacity, alwaysOnTop, expectedRevision: input.expectedRevision };
}

export function createWindowStore(directory) {
  if (typeof directory !== 'string' || directory.length === 0) throw new Error('createWindowStore 需要显式传入目录，不使用默认目录。');
  const file = join(directory, 'window-settings.json');

  function read() {
    try {
      return validateStored(JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
      if (e.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
      throw new Error('窗口设置文件无法读取或格式错误；未覆盖原文件。', { cause: e });
    }
  }

  function save(input) {
    // 校验先于任何磁盘操作：非法输入不创建目录、不创建锁。
    const validated = validateSaveInput(input);
    const release = acquireFileLock(file);
    const temporary = file + '.' + randomUUID() + '.tmp'; // 与目标同目录，保证 rename 原子
    try {
      const current = read();
      if (validated.expectedRevision !== current.revision) { const err = new Error('窗口设置已被另一个窗口修改，请刷新后再保存。'); err.status = 409; throw err; }
      const next = { opacity: validated.opacity, alwaysOnTop: validated.alwaysOnTop, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
      return { settings: read() };
    } finally {
      // 清理只属于自己的资源；清理失败不得覆盖正在抛出的 409/校验错误。
      try { unlinkSync(temporary); } catch { /* 已随 rename 消失 */ }
      release();
    }
  }

  return { file, read, save };
}
