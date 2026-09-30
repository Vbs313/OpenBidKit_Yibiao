const fs = require('fs');
const path = require('path');
const tasks = require('../electron/services/tasks/bidAnalysisTask.cjs').getBidAnalysisTasks('full');

const catalog = {
  version: 1,
  note: '招标解析任务单源目录。运行时以本文件为准；Main 与 Renderer 均从此加载。',
  tasks: tasks.map((task) => ({
    id: task.id,
    label: task.label,
    description: task.description,
    required: Boolean(task.required),
    output: task.output,
    prompt: task.prompt(),
  })),
};

const out = path.join(__dirname, '../src/shared/prompts/bidAnalysisTasks.json');
fs.writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log('WROTE', out);
console.log('TASKS', catalog.tasks.length);
console.log('IDS', catalog.tasks.map((t) => t.id).join(','));
