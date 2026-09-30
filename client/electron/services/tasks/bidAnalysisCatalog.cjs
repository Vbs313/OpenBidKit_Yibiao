const catalog = require('../../../src/shared/prompts/bidAnalysisTasks.json');

function toRuntimeTask(def) {
  return {
    id: def.id,
    label: def.label,
    description: def.description,
    required: Boolean(def.required),
    output: def.output,
    prompt: () => String(def.prompt || ''),
  };
}

function listCatalogTasks() {
  return Array.isArray(catalog.tasks) ? catalog.tasks : [];
}

function getBidAnalysisTasks(mode) {
  const tasks = listCatalogTasks().map(toRuntimeTask);
  return mode === 'full' ? tasks : tasks.filter((task) => task.required);
}

function getBidAnalysisTaskById(taskId) {
  return listCatalogTasks().map(toRuntimeTask).find((task) => task.id === taskId);
}

function getCatalogTaskPrompt(taskId) {
  const def = listCatalogTasks().find((task) => task.id === taskId);
  return def ? String(def.prompt || '') : '';
}

module.exports = {
  catalog,
  getBidAnalysisTasks,
  getBidAnalysisTaskById,
  getCatalogTaskPrompt,
  toRuntimeTask,
};
