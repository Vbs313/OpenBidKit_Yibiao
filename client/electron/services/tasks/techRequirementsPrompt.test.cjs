const test = require('node:test');
const assert = require('node:assert/strict');
const { getBidAnalysisTaskById } = require('./bidAnalysisTask.cjs');

test('techRequirements prompt requires 技术评分项 section and covers 评审办法', () => {
  const task = getBidAnalysisTaskById('techRequirements');
  const prompt = task.prompt();
  assert.match(prompt, /## 技术评分项/);
  assert.match(prompt, /## 技术评分要求/);
  assert.match(prompt, /评审办法|综合评分法/);
  assert.match(prompt, /竞争性谈判|竞争性磋商/);
  assert.match(prompt, /表格/);
});
