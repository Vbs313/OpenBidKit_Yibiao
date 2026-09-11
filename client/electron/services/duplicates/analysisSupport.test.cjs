const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('./analysisSupport.cjs');

const sentence = (over = {}) => ({ sentence: '正文', normalized: '正文', file_ids: ['F1'], first_order: 0, ...over });

test('buildDuplicateSentences 只保留跨文件重复并排序编号', () => {
  const global = new Map([
    ['a', sentence({ file_ids: ['F1'], sentence: '只在一个文件' })],
    ['b', sentence({ file_ids: ['F1', 'F2'], sentence: '短句' })],
    ['c', sentence({ file_ids: ['F1', 'F2', 'F3'], sentence: '出现在三个文件' })],
  ]);
  const result = A.buildDuplicateSentences(global);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'S000001');
  assert.equal(result[0].sentence, '出现在三个文件');
  assert.equal(result[1].id, 'S000002');
});

test('buildDuplicateImages 按文件数与出现次数排序并编号', () => {
  const global = new Map([
    ['a', { file_ids: ['F1'], occurrences: {} }],
    ['b', { file_ids: ['F1', 'F2'], occurrences: { F1: 1, F2: 1 } }],
    ['c', { file_ids: ['F1', 'F2'], occurrences: { F1: 5, F2: 5 } }],
  ]);
  const result = A.buildDuplicateImages(global);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'I000001');
  assert.deepEqual(result[0].occurrences, { F1: 5, F2: 5 });
  assert.equal(result[1].id, 'I000002');
});

test('createInitialAnalysis 按投标文件数初始化阶段', () => {
  const empty = A.createInitialAnalysis('sig', []);
  assert.equal(empty.status, 'running');
  assert.equal(empty.metadataExtraction.status, 'success');
  assert.equal(empty.metadataExtraction.total, 0);
  const withFiles = A.createInitialAnalysis('sig', [{}, {}]);
  assert.equal(withFiles.metadataExtraction.status, 'running');
  assert.equal(withFiles.metadataExtraction.total, 2);
  assert.equal(withFiles.signature, 'sig');
  assert.ok(withFiles.started_at);
});

test('createInitialOutlineAnalysis 等待元数据完成', () => {
  const pending = A.createInitialOutlineAnalysis('sig', [{}]);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.extraction.status, 'pending');
  assert.equal(pending.extraction.total, 1);
  const empty = A.createInitialOutlineAnalysis('sig', []);
  assert.equal(empty.extraction.status, 'success');
});

test('createInitialContentAnalysis 与 createInitialImageAnalysis 形状完整', () => {
  const content = A.createInitialContentAnalysis('sig', [{}]);
  assert.equal(content.signature, 'sig');
  assert.deepEqual(content.duplicateSentences, []);
  assert.equal(content.extraction.status, 'pending');
  assert.equal(content.totalSentenceCount, 0);
  const image = A.createInitialImageAnalysis('sig', [{}]);
  assert.equal(image.status, 'pending');
  assert.equal(image.extraction.status, 'pending');
  assert.deepEqual(image.files, []);
  assert.deepEqual(image.duplicateImages, []);
});

test('summarizeResultStatus 统计成功与失败', () => {
  assert.deepEqual(A.summarizeResultStatus([{ status: 'success' }, { status: 'error' }, { status: 'success' }]), {
    total: 3,
    success_count: 2,
    error_count: 1,
  });
  assert.deepEqual(A.summarizeResultStatus(), { total: 0, success_count: 0, error_count: 0 });
});

test('summarizeContentExtractionResults 累计正文字符数', () => {
  const summary = A.summarizeContentExtractionResults([
    { status: 'success', content_length: 100 },
    { status: 'error', content_length: 0 },
    { status: 'success', content_length: 50 },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.success_count, 2);
  assert.equal(summary.error_count, 1);
  assert.equal(summary.total_content_chars, 150);
  assert.equal(summary.max_content_chars, 100);
});

test('summarizeDuplicateFileForLog 归一化文件摘要', () => {
  assert.equal(A.summarizeDuplicateFileForLog(null, 'bid'), null);
  const summary = A.summarizeDuplicateFileForLog({
    id: 'F1',
    file_name: '技术标.docx',
    file_path: 'D:/x/技术标.docx',
    size: 123,
    modified_at: '2026-01-01',
  }, 'bid');
  assert.equal(summary.role, 'bid');
  assert.equal(summary.file_id, 'F1');
  assert.equal(summary.file_name, '技术标.docx');
  assert.equal(summary.extension, '.docx');
  assert.equal(summary.size, 123);
  const fallback = A.summarizeDuplicateFileForLog({ file_path: 'D:/x/a.pdf' }, 'tender');
  assert.equal(fallback.file_name, 'a.pdf');
  assert.equal(fallback.extension, '.pdf');
  assert.equal(fallback.size, null);
});
