'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const modelNames = { 'gpt-6-astra': 'Astra', 'gpt-6-sol': 'Sol', 'gpt-6-luna': 'Luna', 'deepseek-flash': 'DeepSeek V4.1', 'deepseek-v4-flash': 'DeepSeek V4.1' };
  const preferenceNames = { codex_quota: '省 Codex 额度', api_cost: '省 API 费用', deepseek_first: 'DeepSeek 优先' };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Map();
  const advancedOptions = $('#advanced-options');
  const advancedSummary = $('#advanced-options > summary');
  let advancedTargetOpen = advancedOptions.open;
  let advancedSequence = 0;
  let token = '';
  let saved = null;
  let draft = { strength: 70, costPreference: 'codex_quota' };
  let enabled = true;
  let initialized = false;
  let loading = false;
  let saving = false;
  let conflict = false;
  let saveFailure = false;
  let policyTimer;
  let policyController;
  let policySequence = 0;
  let lastPreview = null;
  let rangeFeedbackTimer;
  let saveConfirmationTimer;
  let saveConfirmed = false;
  let toastTimer;
  let toastSequence = 0;
  let alertAction = null;

  class ApiError extends Error {
    constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
  }

  function setText(element, value) {
    const text = String(value);
    if (element.textContent !== text) element.textContent = text;
  }

  function stopMotion(key) {
    animations.get(key)?.cancel();
    animations.delete(key);
  }

  function animate(key, element, frames, options = {}) {
    stopMotion(key);
    if (reducedMotion.matches || typeof element.animate !== 'function') return null;
    const animation = element.animate(frames, { duration: 180, easing: 'cubic-bezier(.2,.75,.25,1)', ...options });
    animations.set(key, animation);
    const release = () => { if (animations.get(key) === animation) animations.delete(key); };
    animation.finished.then(release, release);
    return animation;
  }

  function settleAdvanced(open) {
    advancedOptions.open = open;
    advancedOptions.classList.remove('is-animating');
    advancedOptions.dataset.expanded = String(open);
    advancedSummary.setAttribute('aria-expanded', String(open));
  }

  function animateAdvanced(open) {
    const from = advancedOptions.getBoundingClientRect().height;
    const sequence = ++advancedSequence;
    stopMotion('advanced');
    advancedTargetOpen = open;
    advancedOptions.dataset.expanded = String(open);
    advancedSummary.setAttribute('aria-expanded', String(open));
    if (!open && advancedOptions.contains(document.activeElement) && document.activeElement !== advancedSummary) advancedSummary.focus();
    if (reducedMotion.matches || typeof advancedOptions.animate !== 'function') { settleAdvanced(open); return; }
    advancedOptions.open = true;
    const border = parseFloat(getComputedStyle(advancedOptions).borderTopWidth) || 0;
    const to = advancedSummary.offsetHeight + (open ? $('.advanced-body').offsetHeight : 0) + border;
    if (Math.abs(from - to) < 1) { settleAdvanced(open); return; }
    advancedOptions.classList.add('is-animating');
    const animation = animate('advanced', advancedOptions, [{ height: `${from}px` }, { height: `${to}px` }], {
      duration: Math.min(260, 170 + Math.abs(to - from) * .18), fill: 'both'
    });
    animation.finished.then(() => {
      if (sequence !== advancedSequence) return;
      animation.cancel();
      settleAdvanced(open);
    }, () => {});
  }

  function resizeAdvancedMotion() {
    if (advancedTargetOpen && animations.has('advanced')) animateAdvanced(true);
  }

  function clearSaveConfirmation() {
    clearTimeout(saveConfirmationTimer);
    saveConfirmed = false;
  }

  function confirmSaved() {
    clearSaveConfirmation();
    saveConfirmed = true;
    saveConfirmationTimer = setTimeout(() => { saveConfirmed = false; updateControls(); }, 2100);
  }

  function readToken() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.has('token')) {
      token = fragment.get('token') || '';
      try { sessionStorage.setItem('subagent-control-token', token); } catch { /* The current page can use the token without storage. */ }
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      try { token = sessionStorage.getItem('subagent-control-token') || ''; } catch { token = ''; }
    }
  }

  async function api(path, { body, signal } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
      let result;
      try { result = await response.json(); } catch { throw new ApiError('本地服务返回了无法读取的响应，请重试。', response.status); }
      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? '连接凭证已失效，请从插件重新打开控制面板。'
          : response.status === 409
            ? '其他窗口已更新策略，请先加载最新版本。'
            : typeof result?.error === 'string' ? result.error : typeof result?.message === 'string' ? result.message : `请求失败（${response.status}），请重试。`;
        throw new ApiError(message, response.status);
      }
      return result;
    } catch (error) {
      if (timedOut) throw new ApiError('连接超时，请确认本地服务仍在运行。');
      if (error.name === 'AbortError' || error instanceof ApiError) throw error;
      throw new ApiError('无法连接本地服务，请确认服务仍在运行。');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  function setConnection(connected) {
    const dot = $('#connection-dot');
    dot.className = `connection-dot ${connected ? 'is-connected' : 'is-error'}`;
    dot.title = connected ? '本地服务已连接' : '连接需要检查';
    dot.setAttribute('aria-label', dot.title);
  }

  function showAlert(title, message, actionLabel, action) {
    $('#alert-title').textContent = title;
    $('#alert-message').textContent = message;
    $('#alert-action').hidden = !action;
    $('#alert-action').textContent = actionLabel || '重试';
    alertAction = action || null;
    $('#global-alert').hidden = false;
    $('.content').scrollTop = 0;
  }

  function clearAlert() { $('#global-alert').hidden = true; alertAction = null; }
  function isDirty() { return !!saved && (draft.strength !== saved.strength || draft.costPreference !== saved.costPreference); }
  function displayModel(model) { return modelNames[model] || model || '未知模型'; }
  function modelTitle(model) { return model === 'deepseek-flash' || model === 'deepseek-v4-flash' ? `DeepSeek V4.1 Flash · ${model}` : model; }

  function updateSavedTime() {
    const label = $('#last-saved');
    if (!saved?.updatedAt) { label.textContent = ''; label.removeAttribute('title'); return; }
    const date = new Date(saved.updatedAt);
    label.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    label.title = Number.isNaN(date.getTime()) ? '' : `上次保存：${date.toLocaleString('zh-CN', { hour12: false })}`;
  }

  function updateControls() {
    const disabled = !initialized || loading || saving || !enabled;
    const power = $('#plugin-enabled');
    power.disabled = !initialized || loading || saving;
    power.checked = enabled;
    setText($('#plugin-power-state'), enabled ? '已启用' : '已停用');
    const range = $('#strength-range');
    const output = $('#strength-value');
    const previousStrength = Number(output.textContent);
    range.disabled = disabled;
    range.value = draft.strength;
    range.style.setProperty('--progress', `${(draft.strength - 10) / 90 * 100}%`);
    range.setAttribute('aria-valuetext', `${draft.strength}% 综合投入`);
    setText(output, initialized ? draft.strength : '—');
    if (initialized && Number.isFinite(previousStrength) && previousStrength !== draft.strength) {
      animate('strength', output, [
        { opacity: .72 },
        { opacity: 1 }
      ]);
      clearTimeout(rangeFeedbackTimer);
      range.classList.add('is-adjusting');
      rangeFeedbackTimer = setTimeout(() => range.classList.remove('is-adjusting'), 220);
    }
    $('#decrease').disabled = disabled || draft.strength <= 10;
    $('#increase').disabled = disabled || draft.strength >= 100;
    $$('[data-strength]').forEach((button) => {
      const active = initialized && Number(button.dataset.strength) === draft.strength;
      button.disabled = disabled;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $$('input[name="costPreference"]').forEach((input) => { input.disabled = disabled; input.checked = input.value === draft.costPreference; });
    setText($('#preference-summary'), preferenceNames[draft.costPreference]);
    const dirty = isDirty();
    $('#reset-button').disabled = !dirty || disabled;
    $('#save-button').disabled = (!dirty && !!saved?.updatedAt) || disabled || conflict;
    $('#retry-policy').disabled = !token || loading || saving || !enabled;
    $('#save-button').setAttribute('aria-busy', String(saving));
    const confirmed = saveConfirmed && !dirty && !loading && !saving && !conflict;
    $('#save-button').classList.toggle('is-saving', saving);
    $('#save-button').classList.toggle('is-success', confirmed);
    setText($('#save-button-text'), saving ? '正在保存…' : confirmed ? '已保存' : '保存策略');
    $('#save-button-symbol').setAttribute('d', confirmed ? 'm5 10 3 3 7-7' : 'M4 10h12m-4-4 4 4-4 4');
    const status = $('#save-status');
    const icon = $('#save-status-icon');
    let statusText;
    let statusClass;
    if (saving) { statusText = '正在保存'; statusClass = 'is-loading'; }
    else if (loading) { statusText = '正在载入设置'; statusClass = 'is-loading'; }
    else if (!initialized) { statusText = '尚未连接'; statusClass = 'is-error'; }
    else if (conflict) { statusText = '版本冲突 · 请加载最新策略'; statusClass = 'is-error'; }
    else if (saveFailure) { statusText = '保存失败 · 更改已保留'; statusClass = 'is-error'; }
    else if (dirty) { statusText = '有未保存的更改'; statusClass = 'is-dirty'; }
    else { statusText = saved.updatedAt ? '已保存' : '默认策略 · 尚未保存'; statusClass = confirmed ? 'is-success' : saved.updatedAt ? '' : 'is-dirty'; }
    if (status.textContent !== statusText) {
      setText(status, statusText);
      animate('save-status', $('.save-status'), [{ transform: 'translateY(2px)', opacity: .8 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 160 });
    }
    icon.className = `save-status-icon ${statusClass}`;
    document.title = `${dirty ? '● ' : ''}设置`;
  }

  function policyState(state, message) {
    const pending = state === 'pending' || state === 'loading';
    const blocked = state === 'off';
    const hasPreview = !!lastPreview;
    const stale = hasPreview && pending;
    const summary = $('#model-summary');
    const details = $('.policy-details');
    const label = $('#policy-label');
    $('#policy-loading').hidden = !pending || hasPreview;
    $('#policy-error').hidden = state !== 'error' && !blocked;
    $('#retry-policy').hidden = blocked;
    $('#summary-ready').hidden = !hasPreview || state === 'error';
    summary.setAttribute('aria-busy', String(pending));
    summary.classList.toggle('is-stale', stale);
    summary.setAttribute('aria-label', stale ? '上次模型摘要，当前更改的预览尚未更新' : '当前模型摘要，常规难度');
    summary.title = stale ? `仍显示 ${lastPreview.draft.strength}% · ${preferenceNames[lastPreview.draft.costPreference]} 的模型分配；新预览完成后替换。` : '';
    details.hidden = !hasPreview || state === 'error';
    details.classList.toggle('is-stale', stale);
    details.setAttribute('aria-busy', String(pending));
    setText($('#details-context'), stale ? '旧预览 · 更新后替换' : '默认难度 3 / 5');
    label.dataset.state = state;
    if (pending) {
      setText(label, stale ? state === 'pending' ? '旧预览 · 待更新' : '旧预览 · 更新中' : initialized ? '正在计算' : '正在读取');
      setText($('#policy-loading-text'), initialized ? '正在计算模型分配' : '正在读取模型分配');
    }
    if (state === 'error') {
      setText($('#policy-error-message'), message);
      setText(label, '预览暂不可用');
    }
    if (blocked) { setText($('#policy-error-message'), '插件已停用，不计算模型分配。'); setText(label, '已停用'); }
    if (state === 'ready') setText(label, lastPreview.policy.label);
    resizeAdvancedMotion();
  }

  function validatePolicy(policy) {
    if (!policy || typeof policy.label !== 'string' || !Array.isArray(policy.roles) ||
      policy.roles.some((role) => !role || typeof role.label !== 'string' || typeof role.model !== 'string' || typeof role.reasoning !== 'string') ||
      !policy.roles.some((role) => role.role === 'implementation') || !policy.roles.some((role) => role.role === 'mechanical') ||
      !Number.isInteger(policy.maxParallel) || !Number.isInteger(policy.maxDelegations) || typeof policy.reviewDepth !== 'string') {
      throw new ApiError('策略响应不完整，请重试。');
    }
  }

  function validateState(state) {
    const settings = state?.settings;
    if (!settings || !Number.isInteger(settings.strength) || settings.strength < 10 || settings.strength > 100 || settings.strength % 5 !== 0 ||
      !Object.hasOwn(preferenceNames, settings.costPreference) || !Number.isSafeInteger(settings.revision) || settings.revision < 0) {
      throw new ApiError('服务返回的设置不完整，请重新加载。');
    }
    validatePolicy(state.policy);
  }

  function modelText(element, role) {
    const separator = document.createElement('span'); separator.textContent = '/';
    element.replaceChildren(document.createTextNode(displayModel(role.model)), separator, document.createTextNode(role.reasoning));
    element.title = `${modelTitle(role.model)} / ${role.reasoning}`;
  }

  function renderPolicy(policy, previewDraft = draft) {
    validatePolicy(policy);
    const signature = JSON.stringify(policy);
    const changed = !!lastPreview && signature !== lastPreview.signature;
    if (!lastPreview || changed) {
      modelText($('#implementation-model'), policy.roles.find((role) => role.role === 'implementation'));
      modelText($('#mechanical-model'), policy.roles.find((role) => role.role === 'mechanical'));
      setText($('#max-parallel'), policy.maxParallel);
      setText($('#max-delegations'), policy.maxDelegations);
      setText($('#review-depth'), policy.reviewDepth);
      const rows = document.createDocumentFragment();
      policy.roles.forEach((role) => {
        const row = document.createElement('div'); row.className = 'role-row';
        const task = document.createElement('span'); task.className = 'role-task'; task.textContent = role.label;
        const model = document.createElement('span'); model.className = 'role-model';
        const reasoning = document.createElement('span'); reasoning.className = 'role-reasoning'; reasoning.textContent = ` / ${role.reasoning}`;
        model.append(document.createTextNode(displayModel(role.model)), reasoning); model.title = modelTitle(role.model);
        row.append(task, model); rows.append(row);
      });
      $('#role-rows').replaceChildren(rows);
    }
    setText($('#implementation-label'), previewDraft.costPreference === 'deepseek_first' ? '明确规格实现' : '常规开发');
    lastPreview = { policy, signature, draft: { ...previewDraft } };
    policyState('ready');
    if (changed) animate('policy', $('#model-summary'), [{ backgroundColor: '#f3f3f3' }, { backgroundColor: 'transparent' }], { duration: 180 });
  }

  function renderDisabled() {
    cancelPreview();
    lastPreview = null;
    policyState('off');
  }

  function cancelPreview() {
    clearTimeout(policyTimer);
    policyController?.abort();
    ++policySequence;
  }

  function schedulePolicy(immediate = false) {
    if (!enabled) { renderDisabled(); return; }
    cancelPreview();
    const sequence = policySequence;
    const previewDraft = { ...draft };
    stopMotion('policy');
    policyState('pending');
    policyTimer = setTimeout(async () => {
      if (sequence !== policySequence) return;
      const controller = new AbortController(); policyController = controller;
      policyState('loading');
      try {
        const result = await api('/api/preview', { body: previewDraft, signal: controller.signal });
        if (sequence !== policySequence) return;
        renderPolicy(result.policy, previewDraft); setConnection(true);
      } catch (error) {
        if (error.name === 'AbortError' || sequence !== policySequence) return;
        policyState('error', error.message); setConnection(false);
      }
    }, immediate ? 0 : 160);
  }

  function changeDraft(next) {
    if (!initialized || loading || saving || !enabled) return;
    const nextDraft = { ...draft, ...next };
    if (nextDraft.strength === draft.strength && nextDraft.costPreference === draft.costPreference) return;
    draft = nextDraft;
    clearSaveConfirmation();
    saveFailure = false;
    if (!conflict) clearAlert();
    updateControls(); schedulePolicy();
  }

  async function loadState() {
    if (loading || saving) return;
    loading = true; clearAlert(); cancelPreview(); clearSaveConfirmation();
    updateControls(); policyState('loading');
    try {
      const state = await api('/api/state');
      validateState(state);
      saved = { ...state.settings };
      draft = { strength: saved.strength, costPreference: saved.costPreference };
      enabled = saved.enabled !== false;
      initialized = true; conflict = false; saveFailure = false;
      if (enabled) renderPolicy(state.policy); else renderDisabled();
      updateSavedTime(); setConnection(true);
    } catch (error) {
      showAlert('无法读取策略', error.message, '重新连接', loadState);
      policyState('error', '连接本地服务后显示模型分配。');
      setConnection(false);
    } finally { loading = false; updateControls(); }
  }

  async function saveSettings() {
    if (!initialized || loading || saving || conflict || (!isDirty() && saved.updatedAt)) return;
    saving = true; saveFailure = false; clearAlert(); clearSaveConfirmation(); updateControls();
    try {
      const state = await api('/api/settings', { body: { ...draft, expectedRevision: saved.revision } });
      validateState(state);
      cancelPreview();
      saved = { ...state.settings };
      draft = { strength: saved.strength, costPreference: saved.costPreference };
      enabled = saved.enabled !== false;
      if (enabled) renderPolicy(state.policy); else renderDisabled();
      updateSavedTime(); setConnection(true);
      confirmSaved();
      showToast('已保存，后续派发将使用新设置');
    } catch (error) {
      if (error.status === 409) {
        conflict = true;
        showAlert('策略已被其他窗口更新', '加载最新策略后可继续修改，当前未保存的更改将被替换。', '加载最新策略', loadState);
      } else {
        saveFailure = true;
        showAlert('未能确认保存', `${error.message} 当前更改已保留。`, '重试保存', saveSettings);
        if (!error.status) setConnection(false);
      }
    } finally { saving = false; updateControls(); }
  }

  async function savePluginState(next) {
    if (!initialized || loading || saving) return;
    saving = true; saveFailure = false; clearAlert(); clearSaveConfirmation(); updateControls();
    try {
      const state = await api('/api/settings', { body: { ...draft, enabled: next, expectedRevision: saved.revision } });
      validateState(state);
      saved = { ...state.settings };
      draft = { strength: saved.strength, costPreference: saved.costPreference };
      enabled = saved.enabled !== false;
      if (enabled) { renderPolicy(state.policy); } else { renderDisabled(); }
      updateSavedTime(); setConnection(true);
      showToast(enabled ? '插件已启用' : '插件已停用，不再路由或读取额度');
    } catch (error) {
      if (error.status === 409) {
        conflict = true;
        showAlert('策略已被其他窗口更新', '加载最新策略后可继续修改，当前未保存的更改将被替换。', '加载最新策略', loadState);
      } else {
        saveFailure = true;
        showAlert('开关未保存', `${error.message} 当前状态已恢复。`, '重试', () => savePluginState(next));
        if (!error.status) setConnection(false);
      }
    } finally { saving = false; updateControls(); }
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    const sequence = ++toastSequence;
    const toast = $('#toast');
    $('#toast span').textContent = message;
    toast.hidden = false;
    animate('toast', toast, [{ opacity: 0, transform: 'translate(-50%, -4px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 180 });
    toastTimer = setTimeout(() => {
      const animation = animate('toast', toast, [{ opacity: 1, transform: 'translate(-50%, 0)' }, { opacity: 0, transform: 'translate(-50%, -3px)' }], { duration: 150 });
      const hide = () => { if (sequence === toastSequence) toast.hidden = true; };
      if (animation) animation.finished.then(hide, hide);
      else hide();
    }, 2700);
  }

  async function initializeDesktop() {
    const desktop = window.desktopControl;
    if (!desktop || !['minimize', 'close'].every((name) => typeof desktop[name] === 'function')) return;
    document.documentElement.classList.add('is-desktop');
    $('#window-actions').hidden = false;
    $('#minimize-button').addEventListener('click', async () => {
      try { await desktop.minimize(); } catch { showToast('暂时无法最小化窗口'); }
    });
    $('#close-button').addEventListener('click', async () => {
      try { await desktop.close(); } catch { showToast('暂时无法关闭窗口'); }
    });
  }

  $('#strength-range').addEventListener('input', (event) => changeDraft({ strength: Number(event.target.value) }));
  $('#decrease').addEventListener('click', () => changeDraft({ strength: Math.max(10, draft.strength - 5) }));
  $('#increase').addEventListener('click', () => changeDraft({ strength: Math.min(100, draft.strength + 5) }));
  $$('[data-strength]').forEach((button) => button.addEventListener('click', () => changeDraft({ strength: Number(button.dataset.strength) })));
  $$('input[name="costPreference"]').forEach((input) => input.addEventListener('change', () => changeDraft({ costPreference: input.value })));
  $('#save-button').addEventListener('click', saveSettings);
  $('#plugin-enabled').addEventListener('change', (event) => savePluginState(event.target.checked));
  $('#reset-button').addEventListener('click', () => {
    if (!saved || loading || saving) return;
    draft = { strength: saved.strength, costPreference: saved.costPreference };
    clearSaveConfirmation();
    saveFailure = false;
    if (!conflict) clearAlert();
    updateControls(); schedulePolicy(true);
  });
  $('#retry-policy').addEventListener('click', () => initialized ? schedulePolicy(true) : loadState());
  $('#alert-action').addEventListener('click', () => alertAction?.());
  advancedSummary.addEventListener('click', (event) => { event.preventDefault(); animateAdvanced(!advancedTargetOpen); });
  advancedOptions.addEventListener('toggle', () => {
    if (animations.has('advanced')) return;
    advancedTargetOpen = advancedOptions.open;
    settleAdvanced(advancedTargetOpen);
  });
  reducedMotion.addEventListener('change', () => {
    if (!reducedMotion.matches) return;
    ++advancedSequence;
    animations.forEach((animation) => animation.cancel());
    animations.clear();
    clearTimeout(rangeFeedbackTimer);
    $('#strength-range').classList.remove('is-adjusting');
    settleAdvanced(advancedTargetOpen);
  });
  window.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveSettings(); } });
  window.addEventListener('beforeunload', (event) => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } });

  settleAdvanced(advancedTargetOpen);
  initializeDesktop();
  readToken();
  if (token) loadState();
  else {
    showAlert('请从插件打开控制面板', '当前页面没有连接凭证，请从 subagent-control 重新打开。');
    policyState('error', '连接本地服务后显示模型分配。');
    setConnection(false); updateControls();
  }
})();
