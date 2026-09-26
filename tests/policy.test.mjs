// 边界测试：subagent-control 路由策略（lib/policy.mjs）
// 仅使用 node:test 与 node:assert/strict；不联网、不启动模型、不读取用户配置、不改动实现。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEVELS,
  CATEGORIES,
  DEFAULT_SETTINGS,
  validateSettings,
  routeTask,
  buildPolicy,
} from '../lib/policy.mjs';

const ASTRA = 'gpt-6-astra';
const SOL = 'gpt-6-sol';
const LUNA = 'gpt-6-luna';
const DS = 'deepseek-flash';
const ASTRA_MAX = { model: ASTRA, reasoning: 'max' };

// 期望值独立写出（不复用实现里的生成公式），避免公式写错时测试跟着一起错。
const EXPECTED_LEVELS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
const EXPECTED_CATEGORIES = [
  'mechanical',
  'exploration',
  'implementation',
  'review',
  'visual_design',
  'security_privacy_migration',
];
const LOCKED_CATEGORIES = ['visual_design', 'security_privacy_migration'];
const COST_PREFERENCES = ['codex_quota', 'api_cost'];
const DIFFICULTIES = [1, 2, 3, 4, 5];
const STAGES = ['work', 'final_review'];

const settings = (strength, costPreference = 'codex_quota') => ({ strength, costPreference });

// ---------------------------------------------------------------- LEVELS 契约

test('LEVELS 精确为 10–100、步长 5、共 19 个值', () => {
  assert.deepEqual([...LEVELS], EXPECTED_LEVELS);
  assert.equal(LEVELS.length, 19);
  assert.equal(new Set(LEVELS).size, 19);
  assert.equal(LEVELS[0], 10);
  assert.equal(LEVELS.at(-1), 100);
  for (let i = 0; i < LEVELS.length; i += 1) {
    assert.ok(Number.isInteger(LEVELS[i]), `LEVELS[${i}] 必须为整数`);
    assert.ok(LEVELS[i] >= 10 && LEVELS[i] <= 100, `LEVELS[${i}] 必须在 10–100 内`);
    assert.equal((LEVELS[i] - 10) % 5, 0, `LEVELS[${i}] 必须落在 5 的档位上`);
    if (i > 0) assert.equal(LEVELS[i] - LEVELS[i - 1], 5, '必须每 5 一档且严格递增');
  }
  assert.ok(Object.isFrozen(LEVELS));
  assert.deepEqual([...CATEGORIES], EXPECTED_CATEGORIES);
  assert.ok(Object.isFrozen(CATEGORIES));
  assert.deepEqual({ ...DEFAULT_SETTINGS }, {
    strength: 70,
    costPreference: 'codex_quota',
    enabled: true,
    revision: 0,
    updatedAt: null,
  });
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
});

// ------------------------------------------------- 强度校验：缺失 / 浮点 / 非 5 档 / 字符串

test('validateSettings 拒绝缺失强度', () => {
  const missing = [
    undefined,
    null,
    {},
    [],
    { costPreference: 'codex_quota' },
    { strength: undefined, costPreference: 'codex_quota' },
    { strength: null, costPreference: 'api_cost' },
    'codex_quota',
    '',
    0,
    false,
  ];
  for (const input of missing) {
    assert.throws(
      () => validateSettings(input),
      /强度必须/,
      `input=${JSON.stringify(input) ?? String(input)} 缺少强度时应被拒绝`,
    );
  }
});

test('validateSettings 拒绝浮点、非 5 档与字符串强度', () => {
  const floats = [70.5, 10.0000001, 99.9, 100.5, -0.5, NaN, Infinity, -Infinity, Number.EPSILON];
  const offGrid = [5, 0, 11, 12, 13, 33, 73, 99, 101, 105, -10, 1000];
  const wrongTypes = ['70', '100', '75 ', '70.0', 'abc', true, false, 70n, [], {}, [70], { valueOf: () => 70 }];
  for (const strength of [...floats, ...offGrid, ...wrongTypes]) {
    assert.throws(
      () => validateSettings({ strength, costPreference: 'codex_quota' }),
      /强度必须/,
      `strength=${String(strength)} 应被拒绝`,
    );
  }
});

test('validateSettings 接受全部 19 档，且只返回规范化字段', () => {
  for (const strength of LEVELS) {
    for (const costPreference of COST_PREFERENCES) {
      const result = validateSettings({ strength, costPreference, extra: 'drop-me', revision: 3, expectedRevision: 9 });
      assert.deepEqual(result, { strength, costPreference });
      assert.deepEqual(Object.keys(result).sort(), ['costPreference', 'strength']);
    }
  }
});

test('validateSettings 拒绝缺失或非法 costPreference', () => {
  const bad = [undefined, null, '', 'free', 'API_COST', 'CODEX_QUOTA', 'codex_quota ', 0, 1, true, {}, []];
  for (const costPreference of bad) {
    assert.throws(
      () => validateSettings({ strength: 70, costPreference }),
      /成本偏好必须/,
      `costPreference=${String(costPreference)} 应被拒绝`,
    );
  }
});

// ------------------------------------------------------------ routeTask 输入边界

test('routeTask 拒绝越界输入，并先校验设置', () => {
  const base = settings(70);
  for (const category of [undefined, null, '', 'Mechanical', 'visual', 'security', 0]) {
    assert.throws(() => routeTask(base, { category }), /未知任务类别/, `category=${String(category)}`);
  }
  for (const difficulty of [0, 6, -1, 2.5, '3', null, NaN, true, Infinity]) {
    assert.throws(
      () => routeTask(base, { category: 'implementation', difficulty }),
      /任务难度必须/,
      `difficulty=${String(difficulty)}`,
    );
  }
  for (const visualImpact of ['yes', 1, 0, null, {}]) {
    assert.throws(
      () => routeTask(base, { category: 'implementation', visualImpact }),
      /视觉标记必须/,
      `visualImpact=${String(visualImpact)}`,
    );
  }
  for (const designSpecified of ['true', 1, 0, null]) {
    assert.throws(
      () => routeTask(base, { category: 'implementation', designSpecified }),
      /视觉标记必须/,
      `designSpecified=${String(designSpecified)}`,
    );
  }
  for (const stage of ['plan', 'FINAL_REVIEW', 'Work', '', null, 1]) {
    assert.throws(() => routeTask(base, { category: 'implementation', stage }), /阶段必须/, `stage=${String(stage)}`);
  }
  // 非法设置优先于非法输入被拒绝
  assert.throws(() => routeTask(settings(73), { category: 'nope' }), /强度必须/);
  assert.throws(() => routeTask({ strength: 70 }, { category: 'implementation' }), /成本偏好必须/);
});

test('routeTask 返回字段固定并回显输入', () => {
  const result = routeTask(settings(85, 'api_cost'), {
    category: 'review',
    difficulty: 4,
    stage: 'final_review',
    visualImpact: false,
    designSpecified: false,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'category', 'costPreference', 'designSpecified', 'finalReviewer', 'locked', 'maxDelegations',
    'model', 'reason', 'reasoning', 'reviewPlan', 'stage', 'strength', 'transport', 'visualImpact',
  ]);
  assert.equal(result.category, 'review');
  assert.equal(result.stage, 'final_review');
  assert.equal(result.strength, 85);
  assert.equal(result.costPreference, 'api_cost');
  assert.equal(result.visualImpact, false);
  assert.equal(result.designSpecified, false);
  assert.equal(result.maxDelegations, 16); // 1 + (85 - 10) / 5
  // review 类别（85 分线）在 85 + 难度 4 的 97 分达到 Astra / xhigh
  assert.equal(result.model, ASTRA);
  assert.equal(result.reasoning, 'xhigh');
  assert.equal(result.transport, 'native_subagent');
  assert.equal(result.finalReviewer, null);
  // 缺省值：difficulty=3、stage=work、视觉标记为 false
  const defaults = routeTask(settings(70), { category: 'exploration' });
  assert.equal(defaults.stage, 'work');
  assert.equal(defaults.visualImpact, false);
  assert.equal(defaults.designSpecified, false);
  assert.equal(defaults.model, SOL); // 70 分达到 exploration 的 60 分线
  assert.equal(defaults.reasoning, 'high');
});

// ------------------------------------------------- 不可降级：两类高危任务 + 视觉

test('全部 19 档：visual_design 与 security_privacy_migration 始终 locked / Astra / max', () => {
  for (const strength of LEVELS) {
    for (const category of LOCKED_CATEGORIES) {
      for (const costPreference of COST_PREFERENCES) {
        for (const stage of STAGES) {
          for (const difficulty of DIFFICULTIES) {
            const result = routeTask(settings(strength, costPreference), { category, difficulty, stage });
            const label = `${category} @ ${strength}% / 难度 ${difficulty} / ${stage} / ${costPreference}`;
            assert.equal(result.locked, true, label);
            assert.equal(result.model, ASTRA, label);
            assert.equal(result.reasoning, 'max', label);
            assert.match(result.reason, /不可降级/, label);
            assert.deepEqual(result.finalReviewer, ASTRA_MAX, label);
            assert.match(result.reviewPlan, /Astra \/ max/, label);
          }
        }
      }
    }
  }
});

test('visualImpact 未明确规范视觉实现时 locked（任意阶段、任意类别）', () => {
  for (const strength of LEVELS) {
    for (const category of EXPECTED_CATEGORIES) {
      for (const stage of STAGES) {
        const explicit = routeTask(settings(strength, 'api_cost'), {
          category,
          stage,
          difficulty: 1,
          visualImpact: true,
          designSpecified: false,
        });
        const label = `${category} @ ${strength}% / ${stage}`;
        assert.equal(explicit.locked, true, label);
        assert.equal(explicit.model, ASTRA, label);
        assert.equal(explicit.reasoning, 'max', label);
        assert.deepEqual(explicit.finalReviewer, ASTRA_MAX, label);
        // 省略 designSpecified 等价于 false，同样锁定
        const implicit = routeTask(settings(strength, 'api_cost'), { category, stage, difficulty: 1, visualImpact: true });
        assert.deepEqual(implicit, explicit, `${label}：缺省 designSpecified 应等价于 false`);
      }
    }
  }
});

test('visualImpact + final_review 即使规范明确也必须 locked', () => {
  for (const strength of LEVELS) {
    for (const category of EXPECTED_CATEGORIES) {
      const result = routeTask(settings(strength, 'codex_quota'), {
        category,
        stage: 'final_review',
        difficulty: 3,
        visualImpact: true,
        designSpecified: true,
      });
      const label = `${category} @ ${strength}% / final_review`;
      assert.equal(result.locked, true, label);
      assert.equal(result.model, ASTRA, label);
      assert.equal(result.reasoning, 'max', label);
      assert.deepEqual(result.finalReviewer, ASTRA_MAX, label);
      assert.match(result.reviewPlan, /最终视觉验收固定 Astra \/ max/, label);
    }
  }
});

test('视觉规范明确时允许低价辅助，但 finalReviewer 仍为 Astra / max', () => {
  const quota = routeTask(settings(10, 'codex_quota'), {
    category: 'mechanical', difficulty: 3, stage: 'work', visualImpact: true, designSpecified: true,
  });
  assert.equal(quota.locked, false);
  assert.equal(quota.model, DS);
  assert.equal(quota.transport, 'dsh_delegate');
  assert.deepEqual(quota.finalReviewer, ASTRA_MAX);

  const api = routeTask(settings(10, 'api_cost'), {
    category: 'mechanical', difficulty: 3, stage: 'work', visualImpact: true, designSpecified: true,
  });
  assert.equal(api.locked, false);
  assert.equal(api.model, LUNA);
  assert.notEqual(api.reasoning, 'max');
  assert.deepEqual(api.finalReviewer, ASTRA_MAX);

  const impl = routeTask(settings(10), {
    category: 'implementation', difficulty: 3, stage: 'work', visualImpact: true, designSpecified: true,
  });
  assert.equal(impl.locked, false);
  assert.equal(impl.model, SOL);
  assert.notEqual(impl.reasoning, 'max');
  assert.deepEqual(impl.finalReviewer, ASTRA_MAX);

  // 只要存在视觉影响，任何档位/类别/阶段都必须保留 Astra / max 最终复核
  for (const strength of LEVELS) {
    for (const category of EXPECTED_CATEGORIES) {
      for (const stage of STAGES) {
        const result = routeTask(settings(strength), {
          category, stage, difficulty: 2, visualImpact: true, designSpecified: true,
        });
        assert.deepEqual(result.finalReviewer, ASTRA_MAX, `${category} @ ${strength}% / ${stage}`);
      }
    }
  }
});

// ------------------------------------------------------------- 100 档与难度 5

test('100 档：全部类别 Astra / max', () => {
  for (const category of EXPECTED_CATEGORIES) {
    for (const costPreference of COST_PREFERENCES) {
      for (const difficulty of DIFFICULTIES) {
        const result = routeTask(settings(100, costPreference), { category, difficulty });
        const label = `${category} / 难度 ${difficulty} / ${costPreference}`;
        assert.equal(result.strength, 100, label);
        assert.equal(result.model, ASTRA, label);
        assert.equal(result.reasoning, 'max', label);
        assert.ok(/100%|不可降级|最高难度/.test(result.reason), label);
        assert.deepEqual(result.finalReviewer, ASTRA_MAX, label);
      }
    }
  }
  // 机械任务在 100 档并非“命中锁定”，Astra / max 来自档位本身
  const mechanical = routeTask(settings(100), { category: 'mechanical', difficulty: 1 });
  assert.equal(mechanical.locked, false);
  assert.equal(mechanical.model, ASTRA);
  assert.equal(mechanical.reasoning, 'max');
  assert.match(mechanical.reason, /100%/);
});

test('难度 5：所有类别、所有档位、两种成本偏好至少 Astra', () => {
  for (const strength of LEVELS) {
    for (const category of EXPECTED_CATEGORIES) {
      for (const costPreference of COST_PREFERENCES) {
        const result = routeTask(settings(strength, costPreference), { category, difficulty: 5 });
        const label = `${category} @ ${strength}% / 难度 5 / ${costPreference}`;
        assert.equal(result.model, ASTRA, label);
        assert.ok(['high', 'xhigh', 'max'].includes(result.reasoning), `${label}：reasoning=${result.reasoning}`);
        if (LOCKED_CATEGORIES.includes(category)) assert.match(result.reason, /不可降级/, label);
        else assert.match(result.reason, /最高难度/, label);
        assert.equal(result.locked, LOCKED_CATEGORIES.includes(category), label);
      }
    }
  }
  // 难度 5 时档位只影响推理投入，不影响 Astra 下限
  const low = routeTask(settings(10), { category: 'mechanical', difficulty: 5 });
  assert.equal(low.model, ASTRA);
  assert.equal(low.reasoning, 'high'); // score = 34
  assert.equal(routeTask(settings(70), { category: 'mechanical', difficulty: 5 }).reasoning, 'high'); // 94
  assert.equal(routeTask(settings(75), { category: 'mechanical', difficulty: 5 }).reasoning, 'xhigh'); // 99
  assert.equal(routeTask(settings(90), { category: 'mechanical', difficulty: 5 }).reasoning, 'max'); // 114
});

// ------------------------------------------- mechanical 的 quota / api_cost 分流

test('mechanical：codex_quota 走 deepseek-flash，api_cost 走 gpt-6-luna', () => {
  // 难度 3 时 score = strength；75 分以下两条成本线分别落到 DS / LUNA
  for (let strength = 10; strength <= 70; strength += 5) {
    const quota = routeTask(settings(strength, 'codex_quota'), { category: 'mechanical', difficulty: 3, stage: 'work' });
    assert.equal(quota.model, DS, `quota @ ${strength}%`);
    assert.equal(quota.transport, 'dsh_delegate', `quota @ ${strength}%`);
    assert.equal(quota.reasoning, 'max', `quota @ ${strength}%`);
    assert.equal(quota.locked, false, `quota @ ${strength}%`);
    assert.equal(quota.finalReviewer, null, `quota @ ${strength}%`);

    const api = routeTask(settings(strength, 'api_cost'), { category: 'mechanical', difficulty: 3, stage: 'work' });
    assert.equal(api.model, LUNA, `api_cost @ ${strength}%`);
    assert.equal(api.transport, 'native_subagent', `api_cost @ ${strength}%`);
    assert.equal(api.reasoning, strength >= 40 ? 'high' : 'low', `api_cost @ ${strength}%`);
    assert.equal(api.locked, false, `api_cost @ ${strength}%`);
  }

  // 75 分是便宜模型与 SOL 的分界
  for (const costPreference of COST_PREFERENCES) {
    const at75 = routeTask(settings(75, costPreference), { category: 'mechanical', difficulty: 3 });
    assert.equal(at75.model, SOL, `75 分 @ ${costPreference}`);
    assert.equal(at75.reasoning, 'high', `75 分 @ ${costPreference}`);
  }

  // 难度改变 score：85% / 难度 2 = 73 → 仍走便宜线；90% / 难度 2 = 78 → SOL
  assert.equal(routeTask(settings(85, 'codex_quota'), { category: 'mechanical', difficulty: 2 }).model, DS);
  assert.equal(routeTask(settings(85, 'api_cost'), { category: 'mechanical', difficulty: 2 }).model, LUNA);
  assert.equal(routeTask(settings(90, 'codex_quota'), { category: 'mechanical', difficulty: 2 }).model, SOL);

  // 60% / 难度 4 = 72 → 便宜线；65% / 难度 4 = 77 → SOL
  assert.equal(routeTask(settings(60, 'codex_quota'), { category: 'mechanical', difficulty: 4 }).model, DS);
  assert.equal(routeTask(settings(60, 'api_cost'), { category: 'mechanical', difficulty: 4 }).model, LUNA);
  assert.equal(routeTask(settings(65, 'api_cost'), { category: 'mechanical', difficulty: 4 }).model, SOL);

  // 100 分以上 → Astra；110 分以上 → max
  assert.equal(routeTask(settings(95, 'codex_quota'), { category: 'mechanical', difficulty: 4 }).model, ASTRA);
  assert.equal(routeTask(settings(95, 'codex_quota'), { category: 'mechanical', difficulty: 4 }).reasoning, 'xhigh'); // 107
  assert.equal(routeTask(settings(95, 'codex_quota'), { category: 'mechanical', difficulty: 5 }).reasoning, 'max'); // 119
  assert.equal(routeTask(settings(100, 'codex_quota'), { category: 'mechanical', difficulty: 1 }).model, ASTRA);
});

// --------------------------------------------- implementation / review 与复核分界

test('implementation / review 分界、90 档复核升级与 reviewPlan 档位', () => {
  assert.equal(routeTask(settings(85), { category: 'implementation', difficulty: 3 }).model, SOL);
  assert.equal(routeTask(settings(90), { category: 'implementation', difficulty: 3 }).model, ASTRA);
  assert.equal(routeTask(settings(80), { category: 'review', difficulty: 3 }).model, SOL);
  assert.equal(routeTask(settings(85), { category: 'review', difficulty: 3 }).model, ASTRA);

  const at90 = routeTask(settings(90), { category: 'implementation', difficulty: 3 });
  assert.equal(at90.locked, false);
  assert.deepEqual(at90.finalReviewer, ASTRA_MAX);
  assert.match(at90.reviewPlan, /Astra \/ max/);
  const at85 = routeTask(settings(85), { category: 'implementation', difficulty: 3 });
  assert.equal(at85.finalReviewer, null);
  assert.match(at85.reviewPlan, /独立审查关键路径/);
  const at50 = routeTask(settings(50), { category: 'implementation', difficulty: 3 });
  assert.equal(at50.finalReviewer, null);
  assert.match(at50.reviewPlan, /运行必要验收检查/);
  assert.equal(routeTask(settings(55), { category: 'implementation', difficulty: 3 }).reviewPlan.includes('按需独立审查'), true);
  assert.equal(routeTask(settings(65), { category: 'implementation', difficulty: 3 }).reviewPlan.includes('Astra'), false);
});

// ------------------------------------------------------- 派生值：派发数 / 策略

test('派发上限与档位对应，不暴露没有消费方的升级阈值', () => {
  for (const strength of LEVELS) {
    const expectedDelegations = 1 + (strength - 10) / 5;
    const routed = routeTask(settings(strength), { category: 'implementation' });
    assert.equal(routed.maxDelegations, expectedDelegations, `${strength}%`);
    assert.ok(Number.isInteger(routed.maxDelegations), `${strength}%`);
    assert.ok(routed.maxDelegations >= 1 && routed.maxDelegations <= 19, `${strength}%`);
    const policy = buildPolicy(settings(strength));
    assert.equal(policy.strength, strength);
    assert.equal(policy.maxDelegations, expectedDelegations);
    assert.equal(Object.hasOwn(policy, 'escalationThreshold'), false);
  }
  const labelAt = (strength) => buildPolicy(settings(strength)).label;
  assert.equal(labelAt(10), '精简投入');
  assert.equal(labelAt(25), '精简投入');
  assert.equal(labelAt(30), '经济协作');
  assert.equal(labelAt(45), '经济协作');
  assert.equal(labelAt(50), '均衡协作');
  assert.equal(labelAt(65), '均衡协作');
  assert.equal(labelAt(70), '质量优先');
  assert.equal(labelAt(85), '质量优先');
  assert.equal(labelAt(90), '深度复核');
  assert.equal(labelAt(95), '深度复核');
  assert.equal(labelAt(100), '最高投入');

  const parallelAt = (strength) => buildPolicy(settings(strength)).maxParallel;
  assert.equal(parallelAt(25), 1);
  assert.equal(parallelAt(30), 2);
  assert.equal(parallelAt(55), 2);
  assert.equal(parallelAt(60), 3);
  assert.equal(parallelAt(100), 3);
});

test('buildPolicy 暴露硬路由、角色与成本说明', () => {
  for (const strength of LEVELS) {
    const policy = buildPolicy(settings(strength, 'codex_quota'));
    assert.deepEqual(policy.hardRoutes.map((route) => ({
      category: route.category,
      model: route.model,
      reasoning: route.reasoning,
    })), [
      { category: 'visual_design', model: ASTRA, reasoning: 'max' },
      { category: 'security_privacy_migration', model: ASTRA, reasoning: 'max' },
    ]);
    assert.deepEqual(policy.roles.map((role) => role.role), ['mechanical', 'exploration', 'implementation', 'review']);
    for (const role of policy.roles) {
      assert.equal(typeof role.label, 'string', `${strength}% / ${role.role}`);
      assert.ok(role.label.length > 0, `${strength}% / ${role.role}`);
      assert.equal(
        role.model,
        routeTask(settings(strength, 'codex_quota'), { category: role.role }).model,
        `${strength}% / ${role.role}`,
      );
    }
    assert.equal(
      policy.reviewDepth,
      routeTask(settings(strength, 'codex_quota'), { category: 'implementation' }).reviewPlan,
    );
  }
  const quota = buildPolicy(settings(70, 'codex_quota'));
  const api = buildPolicy(settings(70, 'api_cost'));
  assert.equal(quota.notes.length, 4);
  assert.equal(api.notes.length, 4);
  assert.equal(quota.roles.find(role => role.role === 'mechanical').transport, 'dsh_delegate');
  assert.match(api.notes[3], /Luna/);
  assert.notEqual(quota.notes[3], api.notes[3]);
  assert.match(quota.description, /不表示准确率/);
  assert.match(quota.notes[0], /难度 3\/5/);
});

test('DeepSeek 优先只分派明确规格执行，保留独立复核、升级与硬路由', () => {
  const selected = { strength: 70, costPreference: 'deepseek_first' };
  for (const category of ['implementation', 'exploration']) {
    assert.notEqual(routeTask(selected, { category }).model, DS, '未明确规格不下放');
    const decision = routeTask(selected, { category, executionSpecified: true });
    assert.equal(decision.model, DS);
    assert.equal(decision.transport, 'dsh_delegate');
    assert.deepEqual(decision.finalReviewer, { model: SOL, reasoning: 'high' });
    const review = routeTask(selected, { category, executionSpecified: true, stage: 'final_review' });
    assert.equal(review.model, SOL);
    assert.equal(review.reasoning, 'high');
    assert.equal(routeTask(selected, { category, executionSpecified: true, dshAvailable: false }).model, SOL);
    assert.equal(routeTask(selected, { category, executionSpecified: true, escalated: true }).model, ASTRA);
    assert.notEqual(routeTask(selected, { category, executionSpecified: true, difficulty: 4 }).model, DS);
  }
  for (const strength of LEVELS) {
    const settings = { ...selected, strength };
    if (strength < 90) {
      const work = routeTask(settings, { category: 'implementation', executionSpecified: true });
      const review = routeTask(settings, { category: 'review', stage: 'final_review' });
      assert.deepEqual({ model: review.model, reasoning: review.reasoning }, work.finalReviewer);
      assert.ok(buildPolicy(settings).maxDelegations >= 2, '必须为执行和独立复核留出委派预算');
    }
    for (const category of LOCKED_CATEGORIES) {
      const decision = routeTask(settings, { category, executionSpecified: true, dshAvailable: true });
      assert.equal(decision.model, ASTRA);
      assert.equal(decision.reasoning, 'max');
    }
    const visual = routeTask(settings, { category: 'implementation', executionSpecified: true, visualImpact: true });
    assert.equal(visual.model, ASTRA);
    const visualFinal = routeTask(settings, { category: 'implementation', executionSpecified: true, visualImpact: true, designSpecified: true, stage: 'final_review' });
    assert.equal(visualFinal.model, ASTRA);
    if (strength >= 90) for (const category of ['mechanical', 'implementation', 'exploration']) {
      assert.notEqual(routeTask(settings, { category, executionSpecified: true }).model, DS);
    }
  }
  assert.equal(routeTask({ ...selected, strength: 100 }, { category: 'mechanical' }).reasoning, 'max');
  assert.throws(() => routeTask(selected, { category: 'implementation', executionSpecified: 'true' }), /布尔值/);
});

test('90–100% 最终复核兑现 Astra/max，低难度也不削减复核投入', () => {
  for (const strength of [90, 95, 100]) {
    for (const costPreference of [...COST_PREFERENCES, 'deepseek_first']) {
      for (const difficulty of DIFFICULTIES) {
        const prefs = { strength, costPreference };
        const work = routeTask(prefs, { category: 'implementation', difficulty, executionSpecified: true });
        const review = routeTask(prefs, { category: 'review', difficulty, stage: 'final_review' });
        assert.deepEqual({ model: review.model, reasoning: review.reasoning }, work.finalReviewer);
        assert.deepEqual(work.finalReviewer, ASTRA_MAX);
      }
    }
  }
});
