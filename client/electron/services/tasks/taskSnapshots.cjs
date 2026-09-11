// 任务快照：把某个领域的持久化状态裁剪成推给渲染进程的补丁。
//
// 该组原本是 createTaskService 内部的闭包，只做纯视图组装（不读 store、不发事件）；
// 「该读哪个 store」的派发仍留在 taskService 的 getSnapshotForTask。

function createTaskSnapshots(deps) {
  const { copyPatchFields, hasOwn, isActiveTaskStatus, getTaskField } = deps;

  function buildTechnicalPlanSnapshot(task, state = {}, eventPatch = {}) {
    const patch = { ...(eventPatch.technicalPlanPatch || {}) };
    const taskField = getTaskField(task.type);
    if (taskField) {
      patch[taskField] = task || state?.[taskField];
    }

    if (task.type === 'bid-analysis') {
      copyPatchFields(patch, state, ['bidAnalysisMode', 'bidAnalysisProgress', 'projectOverview', 'techRequirements', 'bidAnalysisTasks']);
      if (state.outlineData === null) {
        copyPatchFields(patch, state, [
          'outlineData',
          'outlineWordControlSnapshot',
          'outlineGenerationTask',
          'globalFactsTask',
          'globalFactsAdjustmentTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationOptions',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'bid-section-extraction') {
      copyPatchFields(patch, state, [
        'bidSectionMode',
        'bidSections',
        'bidSectionExtractionStatus',
        'bidSectionExtractionError',
        'tenderFile',
        'bidAnalysisTask',
        'bidAnalysisTasks',
        'bidAnalysisProgress',
        'projectOverview',
        'techRequirements',
        'outlineData',
        'outlineWordControlSnapshot',
        'outlineGenerationTask',
        'referenceKnowledgeDocumentIds',
        'globalFactsTask',
        'globalFactsAdjustmentTask',
        'globalFacts',
        'contentGenerationTask',
        'contentGenerationOptions',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentIllustrationPlan',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'outline-generation') {
      copyPatchFields(patch, state, [
        'outlineMode',
        'outlineExpansionMode',
        'outlineWordControlOptions',
        'outlineWordControlSnapshot',
        'referenceKnowledgeDocumentIds',
        'globalFactsTask',
        'globalFactsAdjustmentTask',
        'globalFacts',
        'bidTemplateExists',
      ]);
      if (task.status === 'success' || state.outlineData === null || hasOwn(eventPatch, 'outlineData')) {
        copyPatchFields(patch, state, [
          'outlineData',
          'globalFactsTask',
          'globalFactsAdjustmentTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'global-facts-generation') {
      copyPatchFields(patch, state, ['globalFacts', 'globalFactsAdjustmentTask']);
      copyPatchFields(patch, state, [
        'contentGenerationTask',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentIllustrationPlan',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'global-facts-adjustment') {
      copyPatchFields(patch, state, ['globalFacts']);
      copyPatchFields(patch, state, [
        'contentGenerationTask',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentIllustrationPlan',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'content-generation') {
      copyPatchFields(patch, state, ['outlineWordControlSnapshot', 'contentIllustrationPlan', 'contentGenerationRuntime']);
      if (!isActiveTaskStatus(task.status)) {
        copyPatchFields(patch, state, [
          'outlineData',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (hasOwn(eventPatch, 'outlineData')) {
      patch.outlineData = eventPatch.outlineData;
    }
    if (hasOwn(eventPatch, 'contentRuntime')) {
      patch.contentGenerationRuntime = eventPatch.contentRuntime;
    }

    const event = { technicalPlanPatch: patch };
    if (hasOwn(eventPatch, 'bidItem')) event.bidItem = eventPatch.bidItem;
    if (hasOwn(eventPatch, 'outlineData')) event.outlineData = eventPatch.outlineData;
    if (hasOwn(eventPatch, 'contentSection')) event.contentSection = eventPatch.contentSection;
    if (hasOwn(eventPatch, 'contentPlan')) event.contentPlan = eventPatch.contentPlan;
    if (hasOwn(eventPatch, 'contentRuntime')) event.contentRuntime = eventPatch.contentRuntime;
    return event;
  }

function buildFeasibilityReportSnapshot(task, state = {}) {
    const patch = {};
    const taskField = getTaskField(task.type);
    if (taskField) {
      patch[taskField] = state?.[taskField] || task;
    }
    copyPatchFields(patch, state, [
      'step',
      'projectInfo',
      'sourceFiles',
      'analysisMarkdown',
      'outlineTemplate',
      'targetWords',
      'referenceDocumentIds',
      'keyParametersMarkdown',
      'outlineData',
      'analysisTask',
      'outlineTask',
      'outlineAdjustmentTask',
      'parametersTask',
      'contentTask',
      'humanWritingTask',
    ]);
    return { feasibilityReportPatch: patch };
  }

function buildSnapshot(definition, state, task, eventPatch) {
    if (definition.stateKey === 'technicalPlan') {
      return buildTechnicalPlanSnapshot(task, state, eventPatch);
    }
    if (definition.stateKey === 'rejectionCheck') {
      return { rejectionCheckPatch: state };
    }
    if (definition.stateKey === 'duplicateCheck') {
      return { duplicateCheckPatch: state };
    }
    if (definition.stateKey === 'feasibilityReport') {
      return buildFeasibilityReportSnapshot(task, state, eventPatch);
    }
    if (definition.stateKey === 'complianceCheck') {
      return { complianceCheckPatch: state };
    }
    return {};
  }
  return {
    buildTechnicalPlanSnapshot,
    buildFeasibilityReportSnapshot,
    buildSnapshot,
  };
}

module.exports = { createTaskSnapshots };
