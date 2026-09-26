export const LEVELS = Object.freeze(Array.from({ length: 19 }, (_, i) => 10 + i * 5));
export const CATEGORIES = Object.freeze(['mechanical', 'exploration', 'implementation', 'review', 'visual_design', 'security_privacy_migration']);
export const DEFAULT_SETTINGS = Object.freeze({ strength: 70, costPreference: 'codex_quota', enabled: true, revision: 0, updatedAt: null });
export const DISABLED_MESSAGE = '插件已停用；请在设置面板开启后再试。';
const ASTRA = 'gpt-6-astra';
const SOL = 'gpt-6-sol';
const LUNA = 'gpt-6-luna';
const DS = 'deepseek-flash';

export function validateSettings(input) {
  if (!input || !Number.isInteger(input.strength) || !LEVELS.includes(input.strength)) throw new Error('强度必须为 10–100 之间的整数，且每档相差 5。');
  if (!['codex_quota', 'api_cost', 'deepseek_first'].includes(input.costPreference)) throw new Error('成本偏好必须为 codex_quota、api_cost 或 deepseek_first。');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('启用状态必须为布尔值。');
  return { strength: input.strength, costPreference: input.costPreference, ...(input.enabled === undefined ? {} : { enabled: input.enabled }) };
}

// 开关只拦截副作用；路由计算保持可用，面板才能在停用状态渲染设置。
export function isEnabled(settings) { return settings?.enabled !== false; }

export function routeTask(settings, input = {}) {
  const { strength, costPreference } = validateSettings(settings);
  const { category, difficulty = 3, visualImpact = false, designSpecified = false, executionSpecified = false, dshAvailable = true, escalated = false, stage = 'work' } = input;
  if (!CATEGORIES.includes(category)) throw new Error('未知任务类别。');
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) throw new Error('任务难度必须为 1–5。');
  if (![visualImpact, designSpecified, executionSpecified, dshAvailable, escalated].every(v => typeof v === 'boolean')) throw new Error('能力与视觉标记必须为布尔值。');
  if (!['work', 'final_review'].includes(stage)) throw new Error('阶段必须为 work 或 final_review。');
  const locked = category === 'visual_design' || category === 'security_privacy_migration' || (visualImpact && (stage === 'final_review' || !designSpecified));
  const score = strength + (difficulty - 3) * 12;
  const fullFinalReview = stage === 'final_review' && strength >= 90;
  const deepseekPreferred = costPreference === 'deepseek_first' && strength < 90 && difficulty <= 3 && stage === 'work'
    && (category === 'mechanical' || (executionSpecified && ['implementation', 'exploration'].includes(category)));
  let model;
  if (locked || escalated || fullFinalReview || strength === 100 || difficulty === 5) model = ASTRA;
  else if (costPreference === 'deepseek_first' && strength < 90 && difficulty <= 3 && (stage === 'final_review' || category === 'review')) model = SOL;
  else if (stage === 'final_review') model = score >= 85 ? ASTRA : SOL;
  else if (deepseekPreferred) model = DS;
  else if (category === 'mechanical') model = score >= 100 ? ASTRA : score >= 75 || costPreference === 'deepseek_first' ? SOL : costPreference === 'codex_quota' ? DS : LUNA;
  else if (category === 'exploration') model = score >= 100 ? ASTRA : score >= 60 ? SOL : LUNA;
  else model = score >= (category === 'review' ? 85 : 90) ? ASTRA : SOL;
  const dshFallback = model === DS && !dshAvailable;
  if (dshFallback) model = costPreference === 'deepseek_first' ? SOL : LUNA;
  const reasoning = locked || escalated || fullFinalReview || strength === 100 ? 'max'
    : model === ASTRA ? (score >= 110 ? 'max' : score >= 95 ? 'xhigh' : 'high')
    : model === SOL ? (score >= 65 || (costPreference === 'deepseek_first' && (stage === 'final_review' || category === 'review')) ? 'high' : score >= 35 ? 'medium' : 'low')
    : model === LUNA ? (score >= 40 ? 'high' : 'low')
    : 'max'; // DeepSeek always uses max; strength only changes routing and review.
  const needsVisualReview = visualImpact || category === 'visual_design';
  const reviewPlan = needsVisualReview ? '检查实际渲染与关键状态；最终视觉验收固定 Astra / max。'
    : category === 'security_privacy_migration' ? 'Astra / max 主做与验收，检查风险、回归和恢复路径。'
    : model === DS && costPreference === 'deepseek_first' ? 'DeepSeek V4.1 Flash 执行明确规格；Sol / high 独立检查实现与验收结果，关键问题升级 Astra。'
    : strength >= 90 ? '独立复核关键假设与回归；Astra / max 最终检查。'
    : strength >= 75 ? '独立审查关键路径、回归及边界；重要争议交 Astra。'
    : strength >= 55 ? '按需独立审查；运行与改动相符的验收检查。'
    : '运行必要验收检查；失败或存在关键不确定性时升级。';
  const reason = locked ? '命中不可降级规则，综合投入档位不能覆盖此路由。'
    : escalated ? '触发必要升级，直接交 Astra / max，不受投入档位限制。'
    : difficulty === 5 ? '最高难度直接交 Astra；强度不限制必要升级。'
    : strength === 100 ? '100% 档统一使用 Astra / max。'
    : dshFallback ? `DeepSeek 调用通道不可用，已回退 ${model === SOL ? 'Sol' : 'Luna'}；没有发起 DeepSeek 调用，后续执行将消耗 Codex 额度。`
    : model === DS && costPreference === 'deepseek_first' ? 'DeepSeek 优先：将规格明确、难度适中的执行任务交给 V4.1 Flash；设计与最终复核保持独立。'
    : `根据 ${strength}% 投入、难度 ${difficulty}/5 和任务类别选择；失败一次修复后仍未通过则升级。`;
  return { category, stage, model, reasoning, locked, reason, reviewPlan,
    maxDelegations: Math.max(costPreference === 'deepseek_first' ? 2 : 1, 1 + (strength - 10) / 5),
    finalReviewer: needsVisualReview || category === 'security_privacy_migration' || strength >= 90 ? { model: ASTRA, reasoning: 'max' } : model === DS && costPreference === 'deepseek_first' ? { model: SOL, reasoning: 'high' } : null,
    transport: model === DS ? 'dsh_delegate' : 'native_subagent',
    strength, costPreference, visualImpact, designSpecified };
}

export function buildPolicy(settings) {
  const { strength, costPreference } = validateSettings(settings);
  const label = strength < 30 ? '精简投入' : strength < 50 ? '经济协作' : strength < 70 ? '均衡协作' : strength < 90 ? '质量优先' : strength < 100 ? '深度复核' : '最高投入';
  const labels = { mechanical: '机械执行', exploration: '调查与检索', implementation: '开发实现', review: '工程审查' };
  return { strength, label, description: '强度控制模型选择、推理与复核投入，不表示准确率或能力百分比。',
    maxParallel: strength < 30 ? 1 : strength < 60 ? 2 : 3,
    maxDelegations: Math.max(costPreference === 'deepseek_first' ? 2 : 1, 1 + (strength - 10) / 5),
    reviewDepth: routeTask(settings, { category: 'implementation', executionSpecified: true }).reviewPlan,
    roles: Object.entries(labels).map(([role, label]) => ({ role, label, ...routeTask(settings, { category: role, executionSpecified: true }) })),
    hardRoutes: [{ category: 'visual_design', label: '视觉设计与最终视觉验收', model: ASTRA, reasoning: 'max' }, { category: 'security_privacy_migration', label: '安全、隐私与数据迁移', model: ASTRA, reasoning: 'max' }],
    notes: ['表中是规格明确、难度 3/5 的执行任务示例；实际任务按类别、难度与视觉要求单独计算。', '并行数和派发数是上限，不要求用满；必要升级不受预算比例限制。', '设置用于后续子任务派发，不会切换当前对话或正在运行的代理。', costPreference === 'deepseek_first' ? '10–85% 时优先使用 DeepSeek V4.1 Flash 执行明确规格的任务，Sol 独立复核；架构、视觉、高风险与最终审查不下放。' : costPreference === 'codex_quota' ? '机械任务优先 DeepSeek V4.1 Flash，以分担 Codex 额度；父代理派发与复核仍有消耗。' : '机械任务优先 Luna；API 实际费用还取决于缓存、输出和重试。'] };
}
