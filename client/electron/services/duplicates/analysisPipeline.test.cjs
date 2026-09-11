const test = require('node:test');
const assert = require('node:assert/strict');

const { createAnalysisPipeline } = require('./analysisPipeline.cjs');

function makePipeline(workspace = {}) {
  const workspaceStore = {
    loadDuplicateCheck: () => workspace.current || null,
    updateDuplicateCheckWithoutReload: () => {},
  };
  return createAnalysisPipeline({ app: {}, configStore: { load: () => ({}) }, workspaceStore });
}

const stage = (progress, status = 'running', message = '') => ({ progress, status, message });

test('overallProgress 取四个阶段的平均并按上下限裁剪', () => {
  const { overallProgress } = makePipeline();
  assert.equal(overallProgress({}), 0);
  assert.equal(overallProgress({
    metadataAnalysis: stage(100, 'success'),
    outlineAnalysis: stage(50),
    contentAnalysis: stage(0),
    imageAnalysis: stage(0),
  }), 38);
  assert.equal(overallProgress({
    metadataAnalysis: stage(40),
    outlineAnalysis: stage(40),
    contentAnalysis: stage(40),
    imageAnalysis: stage(999),
  }), 55); // 运行中的进度会被裁到 99，四段平均后取整
});

test('latestAnalysisMessage 按图片→正文→目录→元数据优先级取消息', () => {
  const { latestAnalysisMessage } = makePipeline();
  assert.equal(latestAnalysisMessage({}), '标书查重分析运行中。');
  assert.equal(latestAnalysisMessage({
    metadataAnalysis: stage(0, 'running', '元数据中'),
    outlineAnalysis: stage(0, 'running', '目录中'),
  }), '目录中');
  assert.equal(latestAnalysisMessage({
    metadataAnalysis: stage(0, 'running', '元数据中'),
    imageAnalysis: stage(0, 'running', '图片中'),
  }), '图片中');
});

test('isCurrentDuplicateCheckSignature 对空签名一律放行', () => {
  const { isCurrentDuplicateCheckSignature } = makePipeline({ current: { tenderFiles: [], bidFiles: [] } });
  assert.equal(isCurrentDuplicateCheckSignature(''), true);
  assert.equal(isCurrentDuplicateCheckSignature(undefined), true);
});

test('isCurrentDuplicateCheckSignature 比对当前工作区签名', () => {
  const { isCurrentDuplicateCheckSignature } = makePipeline({
    current: { tenderFiles: [{ file_path: 'a.pdf', size: 1, modified_at: 't' }], bidFiles: [] },
  });
  const { createSignature } = require('./fileSignature.cjs');
  const matched = createSignature({ tenderFiles: [{ file_path: 'a.pdf', size: 1, modified_at: 't' }], bidFiles: [] });
  assert.equal(isCurrentDuplicateCheckSignature(matched), true);
  assert.equal(isCurrentDuplicateCheckSignature('不匹配的签名'), false);
});
