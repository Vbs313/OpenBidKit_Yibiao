// 技术标下游清理：切换工作流或改动上游（招标/分节/原方案）后，清掉已经失效的下游数据。
//
// 这些原本是 createTechnicalPlanStore 工厂里的闭包函数；跨子系统的删除动作全部显式注入，
// 让「改上游要清哪些下游」这件事在接线处一目了然。

const fs = require('node:fs');

function createDownstreamCleanup(deps) {
  const {
    deleteOutlineAgentTask,
    deleteGlobalFactsAgentTask,
    notifyAgentWorkspaceChange,
    originalPlanMarkdownPath,
    clearTechnicalPlanMermaidCache,
    clearBidTemplate,
    assertNoTechnicalPlanTaskRunning,
    originalPlanDownstreamTaskTypes,
    normalizeWorkflowKind,
    db,
    clearContentIllustrationPlan,
    clearOriginalOutlineRuntime,
    updateMeta,
    ensureMetaRow,
    resolveMarkdownPath,
  } = deps;

  function clearDownstreamFromTender() {
    deleteOutlineAgentTask();
    deleteGlobalFactsAgentTask();
    db.prepare('DELETE FROM technical_plan_tasks').run();
    db.prepare('DELETE FROM technical_plan_bid_items').run();
    db.prepare('DELETE FROM technical_plan_reference_docs').run();
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    clearContentIllustrationPlan();
    clearOriginalOutlineRuntime();
    clearTechnicalPlanMermaidCache();
    updateMeta({
      step: 'document-analysis',
      bid_analysis_mode: 'key',
      bid_analysis_selected_task_ids_json: null,
      outline_mode: 'aligned',
      outline_expansion_mode: 'ai-complement',
      outline_word_control_snapshot_json: null,
      outline_project_name: null,
      outline_project_overview: null,
      global_facts_mode: 'fabricate',
      content_generation_options_json: null,
      content_generation_runtime_json: null,
      pending_tender_markdown_path: null,
      pending_tender_file_name: null,
      pending_tender_parser_label: null,
      pending_tender_sections_json: null,
      pending_tender_total_declared: null,
      pending_tender_created_at: null,
      bid_section_mode: 'single',
      bid_sections_json: null,
      bid_section_extraction_status: 'idle',
      bid_section_extraction_error: null,
      selected_section_id: null,
      selected_section_title: null,
    });
    notifyAgentWorkspaceChange({ force: true });
  }

  function clearDownstreamFromBidSectionChange() {
    clearBidTemplate();
    deleteOutlineAgentTask();
    deleteGlobalFactsAgentTask();
    db.prepare('DELETE FROM technical_plan_tasks').run();
    db.prepare('DELETE FROM technical_plan_bid_items').run();
    db.prepare('DELETE FROM technical_plan_reference_docs').run();
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    clearContentIllustrationPlan();
    clearOriginalOutlineRuntime();
    clearTechnicalPlanMermaidCache();
    updateMeta({
      step: 'bid-analysis',
      content_generation_options_json: null,
      content_generation_runtime_json: null,
      outline_word_control_snapshot_json: null,
      outline_project_name: null,
      outline_project_overview: null,
    });
    notifyAgentWorkspaceChange({ force: true });
  }

  function clearDownstreamFromOriginalPlan() {
    deleteOutlineAgentTask();
    deleteGlobalFactsAgentTask();
    db.prepare(`DELETE FROM technical_plan_tasks WHERE type IN (${originalPlanDownstreamTaskTypes.map(() => '?').join(', ')})`).run(...originalPlanDownstreamTaskTypes);
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();
    clearContentIllustrationPlan();
    clearOriginalOutlineRuntime();
    clearTechnicalPlanMermaidCache();
    updateMeta({
      step: 'document-analysis',
      outline_project_name: null,
      outline_project_overview: null,
      content_generation_runtime_json: null,
      outline_word_control_snapshot_json: null,
    });
    notifyAgentWorkspaceChange({ force: true });
  }

  function clearWorkflowSpecificState(workflowKind) {
    deleteOutlineAgentTask();
    deleteGlobalFactsAgentTask();
    db.prepare(`DELETE FROM technical_plan_tasks WHERE type IN (${originalPlanDownstreamTaskTypes.map(() => '?').join(', ')})`).run(...originalPlanDownstreamTaskTypes);
    db.prepare('DELETE FROM technical_plan_content_sections').run();
    db.prepare('DELETE FROM technical_plan_content_plans').run();
    db.prepare('DELETE FROM technical_plan_outline_nodes').run();
    db.prepare('DELETE FROM technical_plan_global_fact_groups').run();
    clearContentIllustrationPlan();
    clearOriginalOutlineRuntime();
    clearTechnicalPlanMermaidCache();
    updateMeta({
      workflow_kind: normalizeWorkflowKind(workflowKind),
      step: 'document-analysis',
      outline_expansion_mode: 'ai-complement',
      global_facts_mode: 'fabricate',
      original_plan_file_name: null,
      original_plan_markdown_path: null,
      original_plan_markdown_hash: null,
      original_plan_markdown_chars: 0,
      original_plan_parser_label: null,
      original_plan_imported_at: null,
      outline_project_name: null,
      outline_project_overview: null,
      outline_word_control_options_json: null,
      outline_word_control_snapshot_json: null,
      content_generation_options_json: null,
      content_generation_runtime_json: null,
    });
    notifyAgentWorkspaceChange({ force: true });
  }

  function switchWorkflowKind(workflowKind) {
    const nextWorkflowKind = normalizeWorkflowKind(workflowKind);
    const meta = ensureMetaRow();
    if (normalizeWorkflowKind(meta.workflow_kind) === nextWorkflowKind) {
      return;
    }

    const originalPlanFilePath = meta.original_plan_markdown_path
      ? resolveMarkdownPath(meta.original_plan_markdown_path)
      : originalPlanMarkdownPath;
    const transaction = db.transaction(() => {
      assertNoTechnicalPlanTaskRunning();
      clearWorkflowSpecificState(nextWorkflowKind);
    });
    transaction();
    if (fs.existsSync(originalPlanFilePath)) {
      fs.rmSync(originalPlanFilePath, { force: true });
    }
  }

  return {
    clearDownstreamFromTender,
    clearDownstreamFromBidSectionChange,
    clearDownstreamFromOriginalPlan,
    clearWorkflowSpecificState,
    switchWorkflowKind,
  };
}

module.exports = { createDownstreamCleanup };
