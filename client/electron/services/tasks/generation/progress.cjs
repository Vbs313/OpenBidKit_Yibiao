// 正文生成进度：把子阶段计数换算成插件与 Renderer 直接消费的进度明细，
// 纯函数与常量表，不接触任务状态、模型或文件系统，可单独测试。

function progressFor(leaves, sections) {
  if (!leaves.length) {
    return 0;
  }

  const done = leaves.filter(({ item }) => ['success', 'error', 'ignored'].includes(sections[item.id]?.status)).length;
  return Math.round((done / leaves.length) * 100);
}

const CONTENT_PHASE_LABELS = {
  planning: '正文编排',
  restoring: '原方案还原',
  generating: '正文生成',
  'section-word-adjusting': '小节字数调整',
  'original-auditing': '原方案覆盖检查',
  auditing: '全文一致性检查',
  'table-cleaning': '表格清理',
  'final-section-word-adjusting': '最终小节复核',
  'total-word-adjusting': '全文字数调整',
  'illustration-planning': '全文图片编排',
  'illustration-generating': '全文图片生成',
  done: '已完成',
};

const CONTENT_PROGRESS_PROFILES = {
  full: {
    planning: [0, 12],
    restoring: [12, 18],
    generating: [18, 58],
    'section-word-adjusting': [58, 66],
    'original-auditing': [66, 73],
    auditing: [73, 81],
    'table-cleaning': [81, 85],
    'final-section-word-adjusting': [85, 90],
    'total-word-adjusting': [90, 95],
    'illustration-planning': [95, 98],
    'illustration-generating': [98, 99],
    done: [100, 100],
  },
  single: {
    planning: [0, 15],
    restoring: [15, 25],
    generating: [25, 65],
    'original-auditing': [65, 75],
    auditing: [75, 85],
    'table-cleaning': [85, 90],
    'section-word-adjusting': [90, 99],
    done: [100, 100],
  },
  correction: {
    'original-auditing': [0, 18],
    auditing: [18, 42],
    'table-cleaning': [42, 50],
    'final-section-word-adjusting': [50, 68],
    'total-word-adjusting': [68, 85],
    'illustration-planning': [85, 94],
    'illustration-generating': [94, 99],
    done: [100, 100],
  },
  illustration: {
    'illustration-planning': [0, 65],
    'illustration-generating': [65, 99],
    done: [100, 100],
  },
  'illustration-generation': {
    'illustration-generating': [0, 99],
    done: [100, 100],
  },
};

function clampPercentage(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function percentageFor(completed, total) {
  const normalizedTotal = Math.max(0, Number(total) || 0);
  if (!normalizedTotal) return 0;
  return clampPercentage((Math.max(0, Number(completed) || 0) / normalizedTotal) * 100);
}

function buildContentPhaseProgress(contentStats, latestLog = '', progressMode = 'full') {
  const stats = contentStats || {};
  const phase = stats.phase || 'planning';
  const phaseLabel = CONTENT_PHASE_LABELS[phase] || '正文生成';
  let step = phase;
  let stepLabel = latestLog || phaseLabel;
  let completed = 0;
  let total = 0;
  let phaseProgress = 0;

  if (phase === 'planning') {
    completed = stats.planning_completed;
    total = stats.planning_total;
    phaseProgress = percentageFor(completed, total);
  } else if (phase === 'restoring') {
    completed = stats.restoration_completed;
    total = stats.restoration_total;
    phaseProgress = percentageFor(completed, total);
  } else if (phase === 'generating') {
    completed = stats.generation_completed;
    total = stats.generation_total;
    phaseProgress = percentageFor(completed, total);
  } else if (phase === 'section-word-adjusting' || phase === 'final-section-word-adjusting') {
    completed = Math.max(0, Number(stats.section_adjustment_completed) || 0);
    total = Math.max(0, Number(stats.section_adjustment_total) || 0);
    const activeCount = Math.min(Math.max(0, total - completed), Math.max(0, Number(stats.section_adjustment_active_count) || 0));
    const roundProgress = percentageFor(stats.section_adjustment_round, stats.section_adjustment_round_total) / 100;
    phaseProgress = total ? percentageFor(completed + activeCount * roundProgress, total) : 0;
    step = 'adjusting';
  } else if (phase === 'original-auditing' || phase === 'auditing') {
    const agentTotal = Math.max(0, Number(stats.audit_agent_step_total) || 0);
    const fixTotal = Math.max(0, Number(stats.audit_fix_total) || 0);
    if (stats.audit_step === 'done') {
      completed = 1;
      total = 1;
      phaseProgress = 100;
      step = 'done';
    } else if (agentTotal || stats.audit_step === 'agent') {
      completed = stats.audit_agent_step_completed;
      total = agentTotal;
      phaseProgress = percentageFor(completed, total);
      step = 'agent';
      stepLabel = stats.audit_agent_step_label || stepLabel;
    } else if (stats.audit_step === 'fixing') {
      completed = stats.audit_fix_completed;
      total = fixTotal;
      phaseProgress = fixTotal ? clampPercentage(45 + percentageFor(completed, total) * 0.55) : 100;
      step = 'fixing';
    } else {
      completed = stats.audit_group_completed;
      total = stats.audit_group_total;
      phaseProgress = clampPercentage(percentageFor(completed, total) * 0.45);
      step = 'checking';
    }
  } else if (phase === 'table-cleaning') {
    completed = stats.table_cleanup_completed;
    total = stats.table_cleanup_total;
    phaseProgress = percentageFor(completed, total);
    step = 'cleaning';
  } else if (phase === 'total-word-adjusting') {
    if (stats.total_adjustment_mode === 'expand') {
      const minimumWords = Math.max(0, Number(stats.minimum_words) || 0);
      const currentWords = Math.max(0, Number(stats.current_words) || 0);
      completed = Math.min(currentWords, minimumWords);
      total = minimumWords;
      phaseProgress = percentageFor(completed, total);
    } else {
      const round = Math.max(1, Number(stats.total_adjustment_round) || 1);
      const roundTotal = Math.max(1, Number(stats.total_adjustment_round_total) || 1);
      completed = stats.total_adjustment_batch_completed;
      total = stats.total_adjustment_batch_total;
      const batchProgress = total ? Math.max(0, Number(completed) || 0) / Math.max(1, Number(total) || 1) : 0;
      phaseProgress = clampPercentage((((round - 1) + batchProgress) / roundTotal) * 100);
    }
    step = 'adjusting';
  } else if (phase === 'illustration-planning') {
    completed = stats.illustration_planning_step_completed;
    total = stats.illustration_planning_step_total;
    phaseProgress = percentageFor(completed, total);
    step = 'planning';
    stepLabel = stats.illustration_planning_step_label || stepLabel;
  } else if (phase === 'illustration-generating') {
    completed = stats.illustration_generation_completed;
    total = stats.illustration_generation_total;
    phaseProgress = percentageFor(completed, total);
    step = 'generating';
    stepLabel = stats.illustration_generation_step_label || stepLabel;
  } else if (phase === 'done') {
    completed = 1;
    total = 1;
    phaseProgress = 100;
    step = 'done';
  }

  return {
    mode: progressMode,
    phase,
    phase_label: phaseLabel,
    phase_progress: phaseProgress,
    completed: Math.max(0, Number(completed) || 0),
    total: Math.max(0, Number(total) || 0),
    step,
    step_label: stepLabel,
  };
}

function buildContentOverallProgress(progressMode, detail, status) {
  if (status === 'success' || detail.phase === 'done') return 100;
  const profile = CONTENT_PROGRESS_PROFILES[progressMode] || CONTENT_PROGRESS_PROFILES.full;
  const range = profile[detail.phase];
  if (!range) return 0;
  const [start, end] = range;
  return Math.min(99, Math.round(start + ((end - start) * detail.phase_progress) / 100));
}

function taskStatusFor(leaves, sections) {
  if (leaves.some(({ item }) => isUnresolvedContentSection(sections[item.id]))) {
    return 'error';
  }

  return 'success';
}

function isUnresolvedContentSection(section) {
  return section?.status !== 'success' && section?.status !== 'ignored';
}

module.exports = {
  CONTENT_PHASE_LABELS,
  CONTENT_PROGRESS_PROFILES,
  progressFor,
  clampPercentage,
  percentageFor,
  buildContentPhaseProgress,
  buildContentOverallProgress,
  taskStatusFor,
  isUnresolvedContentSection,
};
