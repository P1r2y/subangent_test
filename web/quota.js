'use strict';

(() => {
  const card = document.querySelector('#quota-card');
  const content = document.querySelector('#quota-content');
  const announcement = document.querySelector('#quota-announcement');
  const refreshInterval = 60_000;
  const requestTimeout = 15_000;
  const percentFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  let token = '';
  let current = { status: 'loading', windows: [], updatedAt: null, stale: false, message: '正在读取 Codex 剩余额度。' };
  let lastKnown = null;
  let controller = null;
  let refreshTimer = null;
  let stopped = false;
  let renderedSignature = '';
  let preferencesController = null;
  let preferencesTimer = null;
  let preferencesRevision = -1;
  let unsubscribePreferences = null;

  function readToken() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.has('token')) {
      token = fragment.get('token') || '';
      try { sessionStorage.setItem('subagent-control-token', token); } catch { /* This page can still use the token. */ }
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      try { token = sessionStorage.getItem('subagent-control-token') || ''; } catch { token = ''; }
    }
  }

  function timestamp(value) {
    if (typeof value !== 'string' || !value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function normalizeUsage(value) {
    if (!value || !['ready', 'unavailable', 'error', 'disabled'].includes(value.status) || !Array.isArray(value.windows)) {
      throw new Error('本地服务返回的额度数据无法读取。');
    }
    const windows = value.windows.slice(0, 2).map((entry) => {
      if (!entry || typeof entry.label !== 'string' || !entry.label.trim() ||
          typeof entry.remainingPercent !== 'number' || !Number.isFinite(entry.remainingPercent) ||
          entry.remainingPercent < 0 || entry.remainingPercent > 100) {
        throw new Error('本地服务返回的额度数据不完整。');
      }
      return {
        label: entry.label.trim(),
        remainingPercent: entry.remainingPercent,
        windowDurationMins: typeof entry.windowDurationMins === 'number' && Number.isFinite(entry.windowDurationMins) && entry.windowDurationMins > 0 ? entry.windowDurationMins : null,
        resetsAt: typeof entry.resetsAt === 'number' && Number.isFinite(entry.resetsAt) && entry.resetsAt > 0 && !Number.isNaN(new Date(entry.resetsAt * 1000).getTime()) ? entry.resetsAt : null
      };
    });
    return {
      status: value.status,
      windows,
      updatedAt: timestamp(value.updatedAt),
      stale: value.stale === true || value.status !== 'ready',
      message: typeof value.message === 'string' ? value.message : ''
    };
  }

  function formatTime(value) {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  }

  function tooltip(entry) {
    const lines = [];
    if (entry) lines.push(`${entry.label}剩余 ${percentFormat.format(entry.remainingPercent)}%`);
    if (current.stale && current.windows.length) lines.push('旧数据 · 本次未能取得最新额度');
    if (current.updatedAt) lines.push(`数据更新时间：${formatTime(current.updatedAt)}`);
    else if (current.windows.length) lines.push('数据更新时间：未提供');
    if (entry?.resetsAt) lines.push(`重置时间：${formatTime(entry.resetsAt * 1000)}`);
    if (current.message) lines.push(current.message);
    lines.push('Ctrl+R 刷新 · 每分钟自动更新');
    return lines.join('\n');
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function render() {
    const hasWindows = current.windows.length > 0;
    const status = hasWindows ? current.stale ? 'stale' : 'ready' : current.status === 'loading' ? 'loading' : current.status === 'disabled' ? 'disabled' : 'unavailable';
    card.dataset.status = status;
    content.dataset.count = String(current.windows.length);
    content.title = tooltip();
    const signature = JSON.stringify({ status, windows: current.windows.map(({ label, remainingPercent }) => ({ label, remainingPercent })) });
    if (signature !== renderedSignature) {
      renderedSignature = signature;
      const fragment = document.createDocumentFragment();
      if (!hasWindows) {
        const empty = makeElement('div', 'quota-empty');
        empty.append(makeElement('span', 'empty-label', '剩余额度'));
        empty.append(makeElement('span', `empty-value${status === 'loading' ? ' is-loading' : ''}`, status === 'loading' ? '读取中' : status === 'disabled' ? '已停用' : '未获取'));
        fragment.append(empty);
      } else {
        for (const entry of current.windows) {
          const windowElement = makeElement('section', 'quota-window');
          windowElement.setAttribute('role', 'meter');
          windowElement.setAttribute('aria-label', `${entry.label}剩余额度${current.stale ? '，旧数据' : ''}`);
          windowElement.setAttribute('aria-valuemin', '0');
          windowElement.setAttribute('aria-valuemax', '100');
          windowElement.setAttribute('aria-valuenow', String(entry.remainingPercent));
          windowElement.setAttribute('aria-valuetext', `${percentFormat.format(entry.remainingPercent)}%${current.stale ? '，旧数据' : ''}`);
          const meta = makeElement('div', 'quota-meta');
          meta.append(makeElement('span', 'quota-label', `${entry.label}剩余`));
          if (current.stale) meta.append(makeElement('span', 'quota-stale', '旧数据'));
          const readout = makeElement('div', 'quota-readout');
          readout.append(makeElement('span', 'quota-number', percentFormat.format(entry.remainingPercent)), makeElement('span', 'quota-percent', '%'));
          const track = makeElement('div', 'quota-track');
          track.setAttribute('aria-hidden', 'true');
          const fill = makeElement('span', 'quota-track-fill');
          fill.style.width = `${entry.remainingPercent}%`;
          track.append(fill);
          windowElement.append(meta, readout, track);
          fragment.append(windowElement);
        }
      }
      content.replaceChildren(fragment);
    }
    [...content.querySelectorAll('.quota-window')].forEach((element, index) => { element.title = tooltip(current.windows[index]); });
    const summary = hasWindows
      ? `Codex ${current.windows.map((entry) => `${entry.label}剩余 ${percentFormat.format(entry.remainingPercent)}%`).join('，')}${current.stale ? '，旧数据' : ''}。`
      : status === 'loading' ? '正在读取 Codex 剩余额度。' : `Codex 剩余额度未获取。${current.message}`;
    if (announcement.textContent !== summary) announcement.textContent = summary;
  }

  function acceptUsage(result) {
    current = result;
    lastKnown = result.windows.length ? { windows: result.windows, updatedAt: result.updatedAt } : null;
    render();
  }

  function applyPreferences(value) {
    const settings = value?.settings || value;
    if (!settings || !Number.isInteger(settings.opacity) || settings.opacity < 50 || settings.opacity > 100 || settings.opacity % 5 !== 0 ||
        !Number.isSafeInteger(settings.revision) || settings.revision < 0 || settings.revision < preferencesRevision) return;
    preferencesRevision = settings.revision;
    if (unsubscribePreferences) clearTimeout(preferencesTimer);
    document.documentElement.style.setProperty('--surface-alpha', String(settings.opacity / 100));
  }

  async function refreshPreferences() {
    if (stopped || preferencesController || !token) return;
    clearTimeout(preferencesTimer);
    const active = new AbortController();
    preferencesController = active;
    const timeout = setTimeout(() => active.abort(), requestTimeout);
    try {
      const response = await fetch('/api/window-settings', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', signal: active.signal });
      if (!response.ok) return;
      const value = await response.json();
      if (!stopped) applyPreferences(value);
    } catch { /* Retain the last confirmed background setting until the next update. */ }
    finally {
      clearTimeout(timeout);
      if (preferencesController === active) preferencesController = null;
      if (!stopped && (!unsubscribePreferences || preferencesRevision < 0)) preferencesTimer = setTimeout(refreshPreferences, 15_000);
    }
  }

  function initializePreferences() {
    if (typeof window.desktopControl?.onPreferencesChanged === 'function') {
      try {
        const cancel = window.desktopControl.onPreferencesChanged(applyPreferences);
        if (typeof cancel === 'function') unsubscribePreferences = cancel;
      } catch { /* Browser fallback polls the same local endpoint. */ }
    }
    refreshPreferences();
  }

  async function openSettings() {
    const button = document.querySelector('#open-settings');
    if (typeof window.desktopControl?.openSettings === 'function') {
      button.disabled = true;
      try { await window.desktopControl.openSettings(); button.title = '设置'; }
      catch { button.title = '设置暂时无法打开，请重试'; announcement.textContent = button.title; }
      finally { button.disabled = false; }
      return;
    }
    const target = new URL('/index.html', location.origin);
    if (token) target.hash = new URLSearchParams({ token }).toString();
    location.assign(target.href);
  }

  async function refresh() {
    if (stopped || controller) return;
    clearTimeout(refreshTimer);
    if (!token) {
      current = { status: 'unavailable', windows: [], updatedAt: null, stale: false, message: '连接凭证缺失，请从插件重新打开额度浮窗。' };
      content.setAttribute('aria-busy', 'false');
      render();
      return;
    }
    const requestController = new AbortController();
    controller = requestController;
    let timedOut = false;
    let allowPrevious = true;
    const timeout = setTimeout(() => { timedOut = true; requestController.abort(); }, requestTimeout);
    content.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/usage', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        cache: 'no-store',
        signal: requestController.signal
      });
      if (!response.ok) {
        allowPrevious = response.status !== 401 && response.status !== 403;
        throw new Error(response.status === 401 || response.status === 403
          ? '连接凭证已失效，请从插件重新打开额度浮窗。'
          : `本次未能获取额度（${response.status}）。`);
      }
      let value;
      try { value = await response.json(); } catch { throw new Error('本地服务返回的额度数据无法读取。'); }
      const result = normalizeUsage(value);
      if (!stopped) acceptUsage(result);
    } catch (error) {
      if (stopped || (error.name === 'AbortError' && !timedOut)) return;
      const previousWindows = allowPrevious && lastKnown
        ? lastKnown.windows.filter((entry) => entry.resetsAt === null || entry.resetsAt * 1000 > Date.now())
        : [];
      acceptUsage({
        status: 'error', windows: previousWindows, updatedAt: previousWindows.length ? lastKnown.updatedAt : null, stale: previousWindows.length > 0,
        message: timedOut ? '额度读取超时，将在下次刷新时重试。' : error instanceof TypeError ? '暂时无法连接本地服务。' : error.message || '本次未能获取额度。'
      });
    } finally {
      clearTimeout(timeout);
      if (controller === requestController) controller = null;
      if (!stopped) {
        content.setAttribute('aria-busy', 'false');
        refreshTimer = setTimeout(refresh, refreshInterval);
      }
    }
  }

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      refresh();
      refreshPreferences();
    }
  });
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(refreshTimer);
    clearTimeout(preferencesTimer);
    controller?.abort();
    preferencesController?.abort();
    unsubscribePreferences?.();
    unsubscribePreferences = null;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      stopped = false;
      refresh();
      initializePreferences();
    }
  });

  readToken();
  document.querySelector('#open-settings').addEventListener('click', openSettings);
  initializePreferences();
  refresh();
})();
