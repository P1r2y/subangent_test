import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, lstatSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const LEGACY_STALE_MS = 30_000;
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // Access denied is not evidence of death.
}
function removeFile(file) { try { unlinkSync(file); } catch { /* Never mask the save result. */ } }
function removeEmpty(directory) { try { rmdirSync(directory); } catch { /* A new owner's nonempty directory is protected. */ } }
/** True when the lock slot holds something other than a directory lock: a legacy
 *  lock file, a foreign tool's file, or a symlink. */
function blocked(lock) {
  try { return !lstatSync(lock).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function recover(lock) {
  let info;
  try { info = lstatSync(lock); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (info.isSymbolicLink()) return false;
  if (info.isFile()) {
    // Migration only: old releases created an empty file without ownership data.
    if (info.size !== 0 || Date.now() - info.mtimeMs < LEGACY_STALE_MS) return false;
    try {
      const current = lstatSync(lock);
      if (!current.isFile() || current.ino !== info.ino || current.mtimeMs !== info.mtimeMs || current.size !== 0) return false;
      unlinkSync(lock);
      return true;
    } catch (error) { if (error.code === 'ENOENT') return true; return false; }
  }
  if (!info.isDirectory()) return false;
  let entries;
  try { entries = readdirSync(lock); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (entries.length === 0) { removeEmpty(lock); return true; }
  if (entries.length !== 1 || !/^\d+-[a-f0-9-]{36}\.json$/.test(entries[0])) return false;
  const ownerFile = join(lock, entries[0]);
  let owner;
  try { owner = JSON.parse(readFileSync(ownerFile, 'utf8')); }
  catch (error) { return error.code === 'ENOENT'; }
  if (!owner || typeof owner !== 'object' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || entries[0] !== `${owner.pid}-${owner.token}.json` || alive(owner.pid)) return false;
  // Unique owner names avoid deleting a replacement lock when two processes recover concurrently.
  removeFile(ownerFile);
  removeEmpty(lock);
  return true;
}

export function acquireFileLock(file) {
  const lock = file + '.lock';
  mkdirSync(dirname(file), { recursive: true });
  const token = randomUUID();
  const ownerName = `${process.pid}-${token}.json`;
  const claim = mkdtempSync(lock + '.claim-');
  let acquired = false;
  try {
    writeFileSync(join(claim, ownerName), JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    for (let attempt = 0; attempt < 4; attempt++) {
      // Windows replaces an existing FILE with the renamed directory instead of
      // failing (POSIX reports ENOTDIR), so the catch below never fires for a legacy
      // or foreign lock file and its guard would be bypassed silently. Probe the slot
      // first: recover() keeps a fresh or non-empty file, and we report 409.
      if (blocked(lock) && !recover(lock)) break;
      try { renameSync(claim, lock); acquired = true; break; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        if (!recover(lock)) break;
      }
    }
    if (!acquired) { const error = new Error('另一个窗口正在保存，请稍后重试。'); error.status = 409; throw error; }
  } finally {
    if (!acquired) { removeFile(join(claim, ownerName)); removeEmpty(claim); }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    removeFile(join(lock, ownerName));
    removeEmpty(lock);
  };
}
