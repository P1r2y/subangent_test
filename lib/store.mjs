import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, validateSettings, buildPolicy, LEVELS } from './policy.mjs';
import { acquireFileLock } from './file-lock.mjs';

export function createStore(directory = process.env.SUBAGENT_CONTROL_STATE_DIR || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'subagent-control')) {
  const file = join(directory, 'settings.json');
  function read() {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      validateSettings(value);
      if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('invalid revision');
      if (value.enabled === undefined) value.enabled = true;
      return value;
    } catch (e) {
      if (e.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
      throw new Error('设置文件无法读取或格式错误；未覆盖原文件。', { cause: e });
    }
  }
  function state() {
    const settings = read();
    return { settings, policy: buildPolicy(settings), levels: LEVELS };
  }
  function save(input) {
    const validated = validateSettings(input);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('保存需要有效的 expectedRevision。');
    const release = acquireFileLock(file);
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const current = read();
      if (input.expectedRevision !== current.revision) { const err = new Error('设置已被另一个面板修改，请刷新后再保存。'); err.status = 409; throw err; }
      // 停用期间唯一的合法写入是把开关重新打开；强度与偏好保持不变。
      if (current.enabled === false && input.enabled !== true) { const err = new Error('插件已停用；开启后才能修改设置。'); err.status = 400; throw err; }
      const next = { strength: validated.strength, costPreference: validated.costPreference, enabled: input.enabled === undefined ? current.enabled : validated.enabled, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
      return state();
    } finally {
      try { unlinkSync(temporary); } catch { /* Cleanup must not prevent releasing the lock. */ }
      release();
    }
  }
  return { read, state, save, file };
}
