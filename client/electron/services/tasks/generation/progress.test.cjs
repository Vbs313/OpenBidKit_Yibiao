const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('./progress.cjs');

test('clampPercentage 把任意数值收进 0-100 的整数区间', () => {
  assert.equal(P.clampPercentage(50.4), 50);
  assert.equal(P.clampPercentage(50.5), 51);
  assert.equal(P.clampPercentage(-5), 0);
  assert.equal(P.clampPercentage(150), 100);
  assert.equal(P.clampPercentage('abc'), 0);
  assert.equal(P.clampPercentage(null), 0);
});

test('percentageFor 处理零分母与超额完成', () => {
  assert.equal(P.percentageFor(1, 4), 25);
  assert.equal(P.percentageFor(3, 4), 75);
  assert.equal(P.percentageFor(0, 0), 0);
  assert.equal(P.percentageFor(5, 0), 0);
  assert.equal(P.percentageFor(10, 3), 100);
  assert.equal(P.percentageFor(-2, 10), 0);
});

test('progressFor 按 success/error/ignored 统计完成度', () => {
  assert.equal(P.progressFor([], {}), 0);
  const leaves = [{ item: { id: 'a' } }, { item: { id: 'b' } }, { item: { id: 'c' } }, { item: { id: 'd' } }];
  const sections = { a: { status: 'success' }, b: { status: 'error' }, c: { status: 'ignored' }, d: { status: 'idle' } };
  assert.equal(P.progressFor(leaves, sections), 75);
  assert.equal(P.progressFor(leaves, {}), 0);
  assert.equal(P.progressFor(leaves.slice(0, 1), { a: { status: 'success' } }), 100);
});

test('isUnresolvedContentSection 只放行 success 与 ignored', () => {
  assert.equal(P.isUnresolvedContentSection({ status: 'success' }), false);
  assert.equal(P.isUnresolvedContentSection({ status: 'ignored' }), false);
  assert.equal(P.isUnresolvedContentSection({ status: 'idle' }), true);
  assert.equal(P.isUnresolvedContentSection({ status: 'error' }), true);
  assert.equal(P.isUnresolvedContentSection(undefined), true);
});

test('taskStatusFor 有未决小节即 error，否则 success', () => {
  const leaves = [{ item: { id: 'a' } }, { item: { id: 'b' } }];
  assert.equal(P.taskStatusFor(leaves, { a: { status: 'success' }, b: { status: 'ignored' } }), 'success');
  assert.equal(P.taskStatusFor(leaves, { a: { status: 'success' }, b: { status: 'idle' } }), 'error');
});

test('buildContentPhaseProgress 覆盖各阶段的计数口径', () => {
  const planning = P.buildContentPhaseProgress({ phase: 'planning', planning_completed: 6, planning_total: 12 });
  assert.equal(planning.phase_label, '正文编排');
  assert.equal(planning.phase_progress, 50);
  assert.equal(planning.step, 'planning');
  assert.equal(planning.completed, 6);
  assert.equal(planning.total, 12);

  const adjusting = P.buildContentPhaseProgress({
    phase: 'section-word-adjusting',
    section_adjustment_completed: 1,
    section_adjustment_total: 2,
    section_adjustment_active_count: 1,
    section_adjustment_round: 1,
    section_adjustment_round_total: 2,
  });
  assert.equal(adjusting.phase_progress, 75);
  assert.equal(adjusting.step, 'adjusting');

  const auditGroup = P.buildContentPhaseProgress({ phase: 'auditing', audit_group_completed: 1, audit_group_total: 2 });
  assert.equal(auditGroup.step, 'checking');
  assert.equal(auditGroup.phase_progress, 23);

  const auditFix = P.buildContentPhaseProgress({ phase: 'auditing', audit_step: 'fixing', audit_fix_completed: 2, audit_fix_total: 4 });
  assert.equal(auditFix.step, 'fixing');
  assert.equal(auditFix.phase_progress, 73);

  const auditDone = P.buildContentPhaseProgress({ phase: 'original-auditing', audit_step: 'done' });
  assert.equal(auditDone.step, 'done');
  assert.equal(auditDone.phase_progress, 100);

  const cleaning = P.buildContentPhaseProgress({ phase: 'table-cleaning', table_cleanup_completed: 1, table_cleanup_total: 4 });
  assert.equal(cleaning.step, 'cleaning');
  assert.equal(cleaning.phase_progress, 25);

  const done = P.buildContentPhaseProgress({ phase: 'done' });
  assert.equal(done.step, 'done');
  assert.equal(done.phase_progress, 100);
  assert.equal(done.phase_label, '已完成');
});

test('buildContentPhaseProgress 缺省进入 planning 且不抛错', () => {
  const detail = P.buildContentPhaseProgress();
  assert.equal(detail.phase, 'planning');
  assert.equal(detail.mode, 'full');
  assert.equal(detail.phase_progress, 0);
});

test('buildContentOverallProgress 把阶段进度映射到 0-99 累计值', () => {
  assert.equal(P.buildContentOverallProgress('full', { phase: 'planning', phase_progress: 50 }, 'running'), 6);
  assert.equal(P.buildContentOverallProgress('full', { phase: 'generating', phase_progress: 50 }, 'running'), 38);
  assert.equal(P.buildContentOverallProgress('full', { phase: 'planning', phase_progress: 100 }, 'running'), 12);
  assert.equal(P.buildContentOverallProgress('full', { phase: 'unknown', phase_progress: 10 }, 'running'), 0);
  assert.equal(P.buildContentOverallProgress('unknown-mode', { phase: 'planning', phase_progress: 50 }, 'running'), 6);
  assert.equal(P.buildContentOverallProgress('full', { phase: 'generating', phase_progress: 10 }, 'success'), 100);
  assert.equal(P.buildContentOverallProgress('full', { phase: 'done', phase_progress: 100 }, 'running'), 100);
});

test('进度常量表含全部阶段且 full 轮廓收口在 100', () => {
  assert.equal(P.CONTENT_PHASE_LABELS.done, '已完成');
  assert.equal(P.CONTENT_PHASE_LABELS['table-cleaning'], '表格清理');
  assert.deepEqual(P.CONTENT_PROGRESS_PROFILES.full.done, [100, 100]);
  assert.deepEqual(P.CONTENT_PROGRESS_PROFILES.single.done, [100, 100]);
  assert.deepEqual(P.CONTENT_PROGRESS_PROFILES.correction.done, [100, 100]);
  assert.deepEqual(P.CONTENT_PROGRESS_PROFILES.illustration.done, [100, 100]);
  assert.deepEqual(P.CONTENT_PROGRESS_PROFILES['illustration-generation'].done, [100, 100]);
});