import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const TTL = 15000;
function windowLabel(minutes) {
  if (minutes === 10080) return '每周';
  if (minutes === 300) return '5 小时';
  if (!Number.isFinite(minutes) || minutes <= 0) return '当前周期';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

export function normalizeUsage(response, now = Date.now()) {
  const map = response?.rateLimitsByLimitId;
  const bucket = map && Object.keys(map).length ? map.codex : response?.rateLimits;
  const windows = [bucket?.primary, bucket?.secondary].filter(Boolean).flatMap(value => {
    if (typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return [];
    const minutes = typeof value.windowDurationMins === 'number' && value.windowDurationMins > 0 ? value.windowDurationMins : null;
    return [{ label: windowLabel(minutes), remainingPercent: Math.round(Math.max(0, Math.min(100, 100 - value.usedPercent)) * 10) / 10,
      windowDurationMins: minutes, resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt : null }];
  }).sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity));
  return { status: windows.length ? 'ready' : 'unavailable', windows,
    updatedAt: new Date(now).toISOString(), stale: false,
    message: windows.length ? '账户共享额度；每分钟更新' : '当前账户未提供 Codex 额度，请确认 Codex 已登录 ChatGPT。' };
}

// Only these read-only protocol calls are sent. No thread or model turn is started.
export function createUsageClient({ executable = process.env.SUBAGENT_CONTROL_CODEX_CLI || 'codex.exe', spawnProcess = spawn, timeoutMs = 12000 } = {}) {
  let child;
  let lines;
  let ready;
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  function disconnect(error = new Error('额度连接已关闭。')) {
    const old = child;
    child = undefined;
    ready = undefined;
    lines?.close();
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
    if (old && !old.killed) old.kill();
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => disconnect(new Error('额度读取超时。')), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n'); }
      catch { disconnect(new Error('额度连接不可用。')); }
    });
  }
  async function connect() {
    if (closed) throw new Error('额度读取已停止。');
    if (ready) return ready;
    const current = spawnProcess(executable, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = current;
    // Never forward CLI diagnostics or account credentials to the renderer/log.
    current.stderr.resume();
    current.stdin.on('error', () => { if (child === current) disconnect(new Error('额度连接不可用。')); });
    current.on('error', () => { if (child === current) disconnect(new Error('无法启动 Codex 额度读取，请检查 Codex CLI。')); });
    current.on('close', () => { if (child === current) disconnect(); });
    lines = createInterface({ input: current.stdout });
    lines.on('line', line => {
      let result;
      try { result = JSON.parse(line); } catch { return; }
      if (result.method) {
        if (result.id !== undefined) current.stdin.write(JSON.stringify({ id: result.id, error: { code: -32601, message: 'Read-only quota client does not support server requests.' } }) + '\n');
        return;
      }
      const item = pending.get(result.id);
      if (!item) return;
      pending.delete(result.id); clearTimeout(item.timer);
      if (result.error) item.reject(new Error('无法获取额度，请确认 Codex 已登录且网络可用。'));
      else item.resolve(result.result);
    });
    ready = request('initialize', { clientInfo: { name: 'subagent_control_quota', title: 'Subagent Control Quota', version: '0.1.0' } })
      .then(() => { current.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'); });
    try { await ready; } catch (error) { disconnect(error); throw error; }
  }
  return { async read() { await connect(); return request('account/rateLimits/read'); }, close() { closed = true; disconnect(); } };
}

export function createUsageReader({ client = createUsageClient(), now = Date.now, ttlMs = TTL } = {}) {
  let lastAttempt = -Infinity;
  let lastGood;
  let cached;
  let flight;
  let closed = false;
  return {
    async read() {
      if (closed) return { status: 'unavailable', windows: [], updatedAt: null, stale: false, message: '额度读取已停止。' };
      if (flight) return flight;
      if (cached && now() - lastAttempt < ttlMs) return cached;
      lastAttempt = now();
      flight = (async () => {
        try {
          cached = normalizeUsage(await client.read(), now());
          lastGood = cached.status === 'ready' ? cached : undefined;
        } catch {
          const valid = lastGood?.windows.filter(item => !item.resetsAt || item.resetsAt * 1000 > now()) || [];
          cached = { status: 'error', windows: valid, updatedAt: valid.length ? lastGood.updatedAt : null,
            stale: Boolean(valid.length), message: '额度暂不可用；请检查 Codex 登录与网络，稍后自动重试。' };
        } finally { flight = undefined; }
        return cached;
      })();
      return flight;
    },
    close() { closed = true; client.close(); }
  };
}
