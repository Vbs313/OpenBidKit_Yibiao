const test = require('node:test');
const assert = require('node:assert');
const {
  getBidAnalysisTasks,
  getBidAnalysisTaskById,
  getCatalogTaskPrompt,
  catalog,
} = require('./bidAnalysisCatalog.cjs');
const taskModule = require('./bidAnalysisTask.cjs');

test('招标解析任务目录单源：Main 与 JSON 目录 id/必填/输出一致', () => {
  const fromCatalog = getBidAnalysisTasks('full');
  const ids = fromCatalog.map((task) => task.id);
  assert.ok(ids.includes('techRequirements'));
  assert.equal(fromCatalog.length, catalog.tasks.length);
  assert.deepEqual(
    fromCatalog.map((task) => `${task.id}:${task.required}:${task.output}`),
    catalog.tasks.map((task) => `${task.id}:${Boolean(task.required)}:${task.output}`),
  );
  assert.deepEqual(
    taskModule.getBidAnalysisTasks('full').map((task) => task.id),
    ids,
  );
});

test('techRequirements 运行时提示词以 JSON 目录为准', () => {
  const runtime = taskModule.getBidAnalysisTaskById('techRequirements');
  const prompt = runtime.prompt();
  assert.match(prompt, /## 技术评分项/);
  assert.match(prompt, /## 技术评分要求/);
  assert.equal(prompt, getCatalogTaskPrompt('techRequirements'));
  assert.equal(prompt, getBidAnalysisTaskById('techRequirements').prompt());
});

test('discardedBids 提示词与目录一致，并保留双段结构', () => {
  const prompt = taskModule.buildInvalidBidAndRejectionItemsPrompt();
  assert.equal(prompt, getCatalogTaskPrompt('discardedBids'));
  assert.match(prompt, /无效投标/);
  assert.match(prompt, /废标项/);
});

test('key 模式只返回 required 任务', () => {
  const keyTasks = getBidAnalysisTasks('key');
  assert.ok(keyTasks.length > 0);
  assert.ok(keyTasks.every((task) => task.required));
});
