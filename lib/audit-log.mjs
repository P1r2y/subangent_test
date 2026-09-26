import { readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireFileLock } from './file-lock.mjs';

export function createAuditLog(directory, { maxBytes = 256 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new Error('Invalid audit limit');
  const file = join(directory, 'audit.jsonl');
  const archive = join(directory, 'audit.1.jsonl');
  const temporary = file + '.tmp';
  function inspect(path) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new Error('invalid_log_file');
      if (stat.size > maxBytes) throw new Error('log_too_large');
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return {
    file, archive, maxBytes,
    async append(record) {
      const eventId = randomUUID();
      let release, ownsTemporary = false;
      try {
        const line = Buffer.from(JSON.stringify({ ...record, eventId, timestamp: new Date().toISOString() }) + '\n');
        if (line.length > maxBytes) return { eventId, recorded: false, error: 'record_too_large' };
        for (let attempt = 0; ; attempt++) {
          try { release = acquireFileLock(file); break; }
          catch (error) {
            if (error.status !== 409 || attempt === 100) throw error;
            await delay(10);
          }
        }
        const previous = inspect(file) ? readFileSync(file) : Buffer.alloc(0);
        if (previous.length && previous.at(-1) !== 10) throw new Error('invalid_log_tail');
        const rotate = previous.length + line.length > maxBytes;
        if (rotate) inspect(archive);
        // One bounded temporary file; recover an interrupted writer only while holding its lock.
        if (inspect(temporary)) unlinkSync(temporary);
        writeFileSync(temporary, rotate ? line : Buffer.concat([previous, line]), { flag: 'wx', mode: 0o600 });
        ownsTemporary = true;
        if (rotate) renameSync(file, archive);
        renameSync(temporary, file);
        return { eventId, recorded: true };
      } catch (error) {
        const known = ['invalid_log_file', 'log_too_large', 'invalid_log_tail'];
        return { eventId, recorded: false, error: error.status === 409 ? 'lock_busy' : known.includes(error.message) ? error.message : 'write_failed' };
      } finally {
        if (ownsTemporary) { try { unlinkSync(temporary); } catch { /* The committed file is never removed. */ } }
        release?.();
      }
    }
  };
}
