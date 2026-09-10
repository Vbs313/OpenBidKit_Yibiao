// 持久 Agent 任务标识：技术方案与可研报告两条业务线共用一份，避免每个任务一个单常量文件。
const GLOBAL_FACTS_AGENT_TASK_KEY = 'technical-plan-global-facts';
const OUTLINE_AGENT_TASK_KEY = 'technical-plan-outline-generation';
const TEMPLATE_EXTRACTION_AGENT_TASK_KEY = 'technical-plan-template-extraction';
const FEASIBILITY_OUTLINE_AGENT_TASK_KEY = 'feasibility-report-outline-generation';

module.exports = {
  GLOBAL_FACTS_AGENT_TASK_KEY,
  OUTLINE_AGENT_TASK_KEY,
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
  FEASIBILITY_OUTLINE_AGENT_TASK_KEY,
};
