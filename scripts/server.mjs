import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createStore } from '../lib/store.mjs';
import { buildPolicy, routeTask, CATEGORIES, DISABLED_MESSAGE } from '../lib/policy.mjs';
import { startPanel } from '../lib/http.mjs';
import { dirname } from 'node:path';
import { openFloatingWindow } from './open-desktop.mjs';
import { randomUUID } from 'node:crypto';
import { createAuditLog } from '../lib/audit-log.mjs';

const strength = { type: 'integer', minimum: 10, maximum: 100, multipleOf: 5 };
const costPreference = { type: 'string', enum: ['codex_quota', 'api_cost', 'deepseek_first'] };
const routeProperties = { category: { type: 'string', enum: CATEGORIES }, difficulty: { type: 'integer', minimum: 1, maximum: 5, default: 3 }, visualImpact: { type: 'boolean', default: false }, designSpecified: { type: 'boolean', default: false }, dshAvailable: { type: 'boolean', default: true }, stage: { type: 'string', enum: ['work', 'final_review'], default: 'work' } };
routeProperties.escalated = { type: 'boolean', default: false, description: '普通任务修复仍失败或出现关键不确定性时传 true，强制升级 Astra/max。' };
routeProperties.executionSpecified = { type: 'boolean', default: false, description: '仅当任务边界、实现规格与验收明确且无需架构决策时为 true；允许 DeepSeek 优先模式分担实现或资料整理。视觉仍另受 designSpecified 与硬路由约束。' };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const annotations = (readOnlyHint = true) => ({ readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false });
export const toolDefinitions = [
  { name: 'open_floating_window', description: '打开半透明 Windows Codex 额度浮窗，显示拖动栏和实际剩余额度，每分钟自动刷新，默认置顶；点击齿轮打开独立设置窗口，调整背景透明度、置顶、投入强度和成本偏好。右键可刷新或关闭。需要已安装桌面运行时和已登录的 Codex CLI。', inputSchema: schema(), annotations: annotations(false) },
  { name: 'open_control_panel', description: '打开子代理综合投入控制面板，返回本机 URL；用 Codex 浏览器面板打开它。支持 10–100%、每 5% 一档。视觉与高风险任务永久锁定 Astra/max。', inputSchema: schema(), annotations: annotations() },
  { name: 'get_policy', description: '读取保存的综合投入档位与模型、推理和复核策略。每次按本插件派发子代理前读取；不切换当前主模型。', inputSchema: schema(), annotations: annotations() },
  { name: 'preview_policy', description: '只预览某档位的策略，不保存、不调用模型。', inputSchema: schema({ strength, costPreference }, ['strength', 'costPreference']), annotations: annotations() },
  { name: 'set_strength', description: '保存用户选择的综合投入强度与成本偏好，用于后续派发。先 get_policy 获取 revision，再传 expectedRevision，避免覆盖其他面板的修改。', inputSchema: schema({ strength, costPreference, expectedRevision: { type: 'integer', minimum: 0 } }, ['strength', 'costPreference', 'expectedRevision']), annotations: annotations(false) },
  { name: 'route_task', description: '根据已保存档位为一个自包含子任务返回具体模型、推理档位、复核要求。视觉设计或未明确规范的视觉实现、最终视觉验收、安全隐私迁移固定 Astra/max。模型不可用时不得静默降级这些任务。本工具计算路由，不启动模型。', inputSchema: schema(routeProperties, ['category']), annotations: annotations() },
  { name: 'validate_assignment', description: '派发前核对实际选择是否符合当前保存策略；不匹配会报错。这只核验提交的模型/档位，不能拦截插件以外的调用。', inputSchema: schema({ ...routeProperties, decisionId: { type: 'string', description: '可选，原样传入 route_task 返回的 decisionId，关联本次校验与重试。' }, model: { type: 'string' }, reasoning: { type: 'string' } }, ['category', 'model', 'reasoning']), annotations: annotations() }
];

export function createService(store = createStore()) {
  let panelPromise;
  const auditLog = createAuditLog(dirname(store.file));
  const sessionId = randomUUID();
  const audited = new Set(['get_policy', 'set_strength', 'route_task', 'validate_assignment']);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const safe = value => typeof value === 'string' ? value.length > 128 ? value.slice(0, 128) + '[truncated]' : value
    : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
  async function execute(name, args, context) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象。');
    const tool = toolDefinitions.find(t => t.name === name);
    if (!tool) throw new Error('未知工具。');
    for (const key of Object.keys(args)) if (!(key in tool.inputSchema.properties)) throw new Error('未知参数：' + key);
    for (const key of tool.inputSchema.required) if (!(key in args)) throw new Error('缺少参数：' + key);
    if (name === 'open_floating_window') return openFloatingWindow({ stateDirectory: dirname(store.file) });
    if (name === 'get_policy') { const value = store.state(); context.settings = value.settings; return value; }
    if (name === 'preview_policy') return { policy: buildPolicy(args) };
    if (name === 'set_strength') { const value = store.save(args); context.settings = value.settings; return value; }
    if (name === 'route_task' || name === 'validate_assignment') {
      if (name === 'validate_assignment' && args.decisionId !== undefined && (typeof args.decisionId !== 'string' || !uuid.test(args.decisionId))) throw new Error('decisionId 必须是路由返回的 UUID。');
      context.settings = store.read();
      const decision = routeTask(context.settings, args);
      context.decision = decision;
      if (name === 'validate_assignment' && (args.model !== decision.model || args.reasoning !== decision.reasoning)) throw new Error(`派发不符合策略：需要 ${decision.model} / ${decision.reasoning}。${decision.locked ? '此任务禁止降级。' : '请重新读取路由。'}`);
      return { decision, ...(name === 'validate_assignment' ? { valid: true } : {}) };
    }
    if (!panelPromise) panelPromise = startPanel(store).catch(e => { panelPromise = null; throw e; });
    const panel = await panelPromise;
    return { url: panel.url, message: '用 open_in_codex 的 browser 目标打开此 URL。保存后下次派发生效；不会更换当前主模型。' };
  }
  function enabledNow() { try { return store.read().enabled !== false; } catch { return true; } }
  async function call(name, args = {}) {
    // 停用即无副作用：拒绝一切影响，连审计记录也不写。设置面板是唯一保留的入口。
    if (name !== 'open_control_panel' && toolDefinitions.some(t => t.name === name) && !enabledNow()) throw new Error(DISABLED_MESSAGE);
    if (!audited.has(name)) return execute(name, args, {});
    const context = { settings: null, decision: null };
    const startedAt = new Date().toISOString();
    const isRoute = name === 'route_task' || name === 'validate_assignment';
    const supplied = name === 'validate_assignment' && typeof args?.decisionId === 'string' && uuid.test(args.decisionId);
    const decisionId = isRoute ? supplied ? args.decisionId : randomUUID() : null;
    const input = {};
    const keys = isRoute ? Object.keys(routeProperties) : name === 'set_strength' ? ['strength', 'costPreference', 'expectedRevision'] : [];
    for (const key of keys) {
      const value = args?.[key] === undefined ? (isRoute ? routeProperties[key].default : undefined) : args[key];
      if (value !== undefined) input[key] = safe(value);
    }
    let value, failure;
    try { value = await execute(name, args, context); } catch (error) { failure = error; }
    let settingsSource = context.settings ? 'operation' : 'unavailable';
    if (!context.settings && failure) {
      try { context.settings = store.read(); settingsSource = 'after_error'; } catch { /* Do not replace the original failure. */ }
    }
    const settings = context.settings ? Object.fromEntries(['strength', 'costPreference', 'revision', 'updatedAt'].map(key => [key, safe(context.settings[key])])) : null;
    const audit = await auditLog.append({ version: 1, sessionId, startedAt, action: name, decisionId,
      correlation: isRoute ? supplied ? 'caller_supplied' : 'new' : null,
      settings, settingsSource, input, decision: context.decision,
      submitted: name === 'validate_assignment' ? { model: safe(args?.model), reasoning: safe(args?.reasoning) } : null,
      outcome: failure ? failure.status === 409 || (name === 'validate_assignment' && context.decision) ? 'rejected' : 'error' : 'success',
      error: failure ? { code: failure.status || 'tool_error' } : null,
      quota: null, quotaStatus: 'not_observed' });
    if (failure) { failure.audit = audit; if (isRoute) failure.decisionId = decisionId; throw failure; }
    return { ...value, audit, ...(isRoute ? { decisionId } : {}) };
  }
  return { call, store, close: async () => { if (panelPromise) await (await panelPromise).close(); } };
}

export async function runStdio(service = createService()) {
  const write = value => process.stdout.write(JSON.stringify(value) + '\n');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  async function handle(line) {
    if (!line.trim()) return;
    let msg;
    try { if (line.length > 1024 * 1024) throw new Error('too large'); msg = JSON.parse(line); }
    catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') { write({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }); return; }
    if (msg.id === undefined) return;
    const result = value => write({ jsonrpc: '2.0', id: msg.id, result: value });
    try {
      if (msg.method === 'initialize') return result({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'subagent-control', version: '0.1.0' }, instructions: '用户启用本插件路由时，先 get_policy，再为每项子任务 route_task；严格遵守视觉和高风险 Astra/max 规则。' });
      if (msg.method === 'ping') return result({});
      if (msg.method === 'tools/list') return result({ tools: toolDefinitions });
      if (msg.method === 'resources/list') return result({ resources: [{ uri: 'subagent-control://policy', name: '当前子代理策略', mimeType: 'application/json' }] });
      if (msg.method === 'resources/templates/list') return result({ resourceTemplates: [] });
      if (msg.method === 'resources/read') {
        if (msg.params?.uri !== 'subagent-control://policy') throw new Error('Unknown resource');
        if (service.store.read().enabled === false) throw new Error(DISABLED_MESSAGE);
        return result({ contents: [{ uri: 'subagent-control://policy', mimeType: 'application/json', text: JSON.stringify(service.store.state()) }] });
      }
      if (msg.method === 'tools/call') {
        try { const value = await service.call(msg.params?.name, msg.params?.arguments ?? {}); return result({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }); }
        catch (e) { return result({ isError: true, content: [{ type: 'text', text: e.message }], ...(e.audit ? { structuredContent: { audit: e.audit, ...(e.decisionId ? { decisionId: e.decisionId } : {}) } } : {}) }); }
      }
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    } catch (e) { write({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: e.message } }); }
  }
  rl.on('line', line => { queue = queue.then(() => handle(line)).catch(e => process.stderr.write(e.message + '\n')); });
  rl.on('close', () => { queue.finally(() => service.close()); });
  const stop = async () => { rl.close(); await queue; await service.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--standalone')) {
    const panel = await startPanel(createStore(), { port: Number(process.env.SUBAGENT_CONTROL_PORT || 0) });
    process.stdout.write(JSON.stringify({ url: panel.url }) + '\n');
    const stop = async () => { await panel.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else await runStdio();
}
