'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const section = $('#window-preferences');
  if (!window.desktopControl || typeof window.desktopControl.onPreferencesChanged !== 'function') return;
  section.hidden = false;
  const opacity = $('#window-opacity');
  const alwaysOnTop = $('#window-always-on-top');
  let token = '';
  let saved = null;
  let draft = { opacity: 80, alwaysOnTop: true };
  let loading = false;
  let saving = false;
  let conflict = false;
  let failed = false;
  let stopped = false;
  let controller = null;
  let unsubscribe = null;
  let queuedSettings = null;

  class SettingsError extends Error {
    constructor(message, status = 0) { super(message); this.name = 'SettingsError'; this.status = status; }
  }

  function dirty() { return !!saved && (draft.opacity !== saved.opacity || draft.alwaysOnTop !== saved.alwaysOnTop); }

  function validate(value) {
    const settings = value?.settings || value;
    if (!settings || !Number.isInteger(settings.opacity) || settings.opacity < 50 || settings.opacity > 100 || settings.opacity % 5 !== 0 ||
        typeof settings.alwaysOnTop !== 'boolean' || !Number.isSafeInteger(settings.revision) || settings.revision < 0) {
      throw new SettingsError('浮窗设置响应不完整，请重新读取。');
    }
    return { opacity: settings.opacity, alwaysOnTop: settings.alwaysOnTop, revision: settings.revision, updatedAt: settings.updatedAt || null };
  }

  function notice(message = '', action = '') {
    $('#window-preferences-message').hidden = !message;
    $('#window-preferences-message-text').textContent = message;
    const button = $('#window-preferences-reload');
    button.hidden = !action;
    button.textContent = action || '加载最新';
  }

  function render() {
    const busy = loading || saving;
    section.setAttribute('aria-busy', String(busy));
    opacity.disabled = !saved || busy;
    alwaysOnTop.disabled = !saved || busy;
    opacity.value = draft.opacity;
    opacity.style.setProperty('--progress', `${(draft.opacity - 50) * 2}%`);
    opacity.setAttribute('aria-valuetext', `${draft.opacity}% 背景不透明度`);
    $('#window-opacity-value').textContent = saved ? `${draft.opacity}%` : '—';
    alwaysOnTop.checked = draft.alwaysOnTop;
    $('#window-preferences-reset').disabled = !dirty() || busy;
    $('#window-preferences-save').disabled = !saved || !dirty() || busy || conflict;
    $('#window-preferences-save').textContent = saving ? '正在保存' : '保存浮窗';
    $('#window-preferences-save').setAttribute('aria-busy', String(saving));
    $('#window-preferences-reload').disabled = busy;
    const status = saving ? '正在保存浮窗' : loading ? '正在读取浮窗' : conflict ? '版本已变化' : failed ? '未能保存' : !saved ? '未获取' : dirty() ? '有未保存的更改' : saved.updatedAt ? '已保存' : '默认设置';
    $('#window-preferences-status').textContent = status;
  }

  async function request(body) {
    const active = new AbortController();
    controller = active;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; active.abort(); }, 12_000);
    try {
      const response = await fetch('/api/window-settings', {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store', credentials: 'omit', signal: active.signal
      });
      if (!response.ok) {
        throw new SettingsError(response.status === 409 ? '浮窗设置已被其他窗口更新。' : response.status === 401 || response.status === 403
          ? '连接凭证已失效，请从插件重新打开设置。' : `无法读取或保存浮窗设置（${response.status}）。`, response.status);
      }
      let result;
      try { result = await response.json(); } catch { throw new SettingsError('浮窗设置响应无法读取，请重试。'); }
      return validate(result);
    } catch (error) {
      if (timedOut) throw new SettingsError('连接超时，请重试。');
      if (error instanceof SettingsError || error.name === 'AbortError') throw error;
      throw new SettingsError('无法连接本地服务，请重试。');
    } finally {
      clearTimeout(timeout);
      if (controller === active) controller = null;
    }
  }

  function receivePreferences(value) {
    let next;
    try { next = validate(value); } catch { return; }
    if (saved && next.revision <= saved.revision) return;
    if (loading || saving) {
      if (!queuedSettings || next.revision > queuedSettings.revision) queuedSettings = next;
      return;
    }
    if (dirty()) {
      conflict = true;
      notice('其他窗口已更新浮窗设置。请加载最新版本；当前草稿会保留。', '加载最新');
    } else {
      saved = next;
      draft = { opacity: next.opacity, alwaysOnTop: next.alwaysOnTop };
      conflict = false;
      failed = false;
      notice();
    }
    render();
  }

  function flushQueuedPreferences() {
    const next = queuedSettings;
    queuedSettings = null;
    if (next) receivePreferences(next);
  }

  async function load(preserveDraft = false) {
    if (stopped || loading || saving || !token) return;
    const previousDraft = preserveDraft && saved ? { ...draft } : null;
    loading = true;
    failed = false;
    render();
    try {
      const next = await request();
      if (stopped) return;
      saved = next;
      draft = previousDraft || { opacity: next.opacity, alwaysOnTop: next.alwaysOnTop };
      conflict = false;
      notice(previousDraft && dirty() ? '已加载最新版本，当前更改已保留。确认后可保存浮窗。' : '');
    } catch (error) {
      if (stopped || error.name === 'AbortError') return;
      notice(error.message, conflict ? '加载最新' : '重试读取');
    } finally {
      loading = false;
      if (!stopped) { flushQueuedPreferences(); render(); }
    }
  }

  async function save() {
    if (stopped || loading || saving || !saved || !dirty() || conflict) return;
    saving = true;
    failed = false;
    notice();
    render();
    try {
      const next = await request({ opacity: draft.opacity, alwaysOnTop: draft.alwaysOnTop, expectedRevision: saved.revision });
      if (stopped) return;
      saved = next;
      draft = { opacity: next.opacity, alwaysOnTop: next.alwaysOnTop };
      conflict = false;
      notice();
    } catch (error) {
      if (stopped || error.name === 'AbortError') return;
      if (error.status === 409) {
        conflict = true;
        notice('浮窗设置已变化。请加载最新版本；当前草稿会保留，不会自动覆盖。', '加载最新');
      } else {
        failed = true;
        notice(`${error.message} 当前更改已保留。`);
      }
    } finally {
      saving = false;
      if (!stopped) { flushQueuedPreferences(); render(); }
    }
  }

  function change() {
    if (!saved || loading || saving) return;
    draft = { opacity: Number(opacity.value), alwaysOnTop: alwaysOnTop.checked };
    failed = false;
    if (!conflict) notice();
    render();
  }

  function subscribe() {
    if (typeof window.desktopControl?.onPreferencesChanged !== 'function') return;
    try {
      const cancel = window.desktopControl.onPreferencesChanged(receivePreferences);
      if (typeof cancel === 'function') unsubscribe = cancel;
    } catch { /* A later save still checks the current revision. */ }
  }

  opacity.addEventListener('input', change);
  alwaysOnTop.addEventListener('change', change);
  $('#window-preferences-save').addEventListener('click', save);
  $('#window-preferences-reload').addEventListener('click', () => load(dirty()));
  $('#window-preferences-reset').addEventListener('click', () => {
    if (!saved || loading || saving) return;
    draft = { opacity: saved.opacity, alwaysOnTop: saved.alwaysOnTop };
    failed = false;
    if (!conflict) notice();
    render();
  });
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && section.contains(document.activeElement)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      save();
    }
  }, true);
  window.addEventListener('beforeunload', (event) => {
    if (dirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => {
    stopped = true;
    controller?.abort();
    unsubscribe?.();
    unsubscribe = null;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) { stopped = false; subscribe(); load(dirty()); }
  });

  // app.js consumes and removes the fragment after this script captures it.
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('token')) token = fragment.get('token') || '';
  else { try { token = sessionStorage.getItem('subagent-control-token') || ''; } catch { token = ''; } }
  subscribe();
  if (token) load();
  else { notice('连接凭证缺失，请从插件重新打开设置。'); render(); }
})();
