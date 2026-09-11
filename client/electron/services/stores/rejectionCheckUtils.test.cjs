const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  appendImportFailureParts,
  createDocumentSignature,
  createRejectionCheckInputSignature,
  getTechnicalPlanDiscardedBids,
  normalizeCheckOptions,
  normalizeCheckResultTab,
  normalizeDocumentRole,
  normalizeDocumentTab,
  normalizeResultTab,
  normalizeStatus,
  normalizeStep,
  stableHash,
  stripTripleQuoteWrapper,
} = require('./rejectionCheckUtils.cjs');

test('stableHash 是稳定的 sha256', () => {
  assert.equal(stableHash('abc'), crypto.createHash('sha256').update('abc', 'utf8').digest('hex'));
  assert.equal(stableHash('abc'), stableHash('abc'));
  assert.notEqual(stableHash('abc'), stableHash('abd'));
  assert.equal(stableHash(''), crypto.createHash('sha256').update('', 'utf8').digest('hex'));
  assert.equal(stableHash(undefined), stableHash(''));
});

test('normalizeStatus 只放行白名单', () => {
  assert.equal(normalizeStatus('running', ['running', 'success'], 'error'), 'running');
  assert.equal(normalizeStatus('paused', ['running', 'success'], 'error'), 'error');
  assert.equal(normalizeStatus(undefined, ['running'], 'running'), 'running');
});

test('分页 / 角色 / 结果页归一化回退到默认值', () => {
  assert.equal(normalizeStep('items'), 'items');
  assert.equal(normalizeStep('results'), 'results');
  assert.equal(normalizeStep('whatever'), 'documents');

  assert.equal(normalizeDocumentRole('bid'), 'bid');
  assert.equal(normalizeDocumentRole('tender'), 'tender');
  assert.equal(normalizeDocumentRole('x'), 'tender');

  assert.equal(normalizeDocumentTab(' doc-1 '), 'doc-1');
  assert.equal(normalizeDocumentTab(''), 'tender');
  assert.equal(normalizeDocumentTab(undefined), 'tender');

  assert.equal(normalizeResultTab('custom'), 'custom');
  assert.equal(normalizeResultTab('analysis'), 'analysis');
  assert.equal(normalizeResultTab('x'), 'analysis');

  assert.equal(normalizeCheckResultTab('typo'), 'typo');
  assert.equal(normalizeCheckResultTab('logic'), 'logic');
  assert.equal(normalizeCheckResultTab('x'), 'rejection');
});

test('normalizeCheckOptions：废标项恒开，另外两项只有显式 false 才关', () => {
  assert.deepEqual(normalizeCheckOptions(undefined), { rejectionCheck: true, typoCheck: true, logicCheck: true });
  assert.deepEqual(normalizeCheckOptions({}), { rejectionCheck: true, typoCheck: true, logicCheck: true });
  assert.deepEqual(normalizeCheckOptions({ typoCheck: false, logicCheck: false }), { rejectionCheck: true, typoCheck: false, logicCheck: false });
  assert.deepEqual(normalizeCheckOptions({ rejectionCheck: false }), { rejectionCheck: true, typoCheck: true, logicCheck: true });
});

test('stripTripleQuoteWrapper 只剥外层三引号', () => {
  assert.equal(stripTripleQuoteWrapper("'''内容'''"), '内容');
  assert.equal(stripTripleQuoteWrapper("'''  内容  '''"), '内容');
  assert.equal(stripTripleQuoteWrapper('普通内容'), '普通内容');
  assert.equal(stripTripleQuoteWrapper("'''只有开头"), "'''只有开头");
  assert.equal(stripTripleQuoteWrapper(undefined), '');
});

test('createDocumentSignature：空文档返回空串，bid-1 有特殊签名 id', () => {
  assert.equal(createDocumentSignature(null), '');
  assert.equal(createDocumentSignature(undefined), '');

  const signature = createDocumentSignature({
    id: 'doc-9',
    role: 'bid',
    source: 'upload',
    fileName: '投标.md',
    content: 'x'.repeat(2000),
  });
  const parts = signature.split('\n---yibiao-rejection-signature---\n');
  assert.equal(parts[0], 'doc-9');
  assert.equal(parts[1], 'upload');
  assert.equal(parts[2], '投标.md');
  assert.equal(parts[3], '2000');
  assert.equal(parts[4], 'x'.repeat(800));
  assert.equal(parts[5], 'x'.repeat(800));

  const legacy = createDocumentSignature({ id: 'bid-1', role: 'bid', content: 'a' });
  assert.equal(legacy.split('\n---yibiao-rejection-signature---\n')[0], 'bid');
});

test('createRejectionCheckInputSignature：缺投标文件或缺解析结果时为空', () => {
  const doc = { id: 'bid-1', role: 'bid', source: 'upload', fileName: 'a.md', content: '正文' };
  assert.equal(createRejectionCheckInputSignature([], '解析结果', ''), '');
  assert.equal(createRejectionCheckInputSignature([doc], '', ''), '');
  assert.equal(createRejectionCheckInputSignature([], '', ''), '');

  // 分隔符只在「多份投标文件」时出现。
  const signature = createRejectionCheckInputSignature([doc, { ...doc, id: 'bid-2' }], '解析结果', '自定义项');
  assert.ok(signature.includes('---yibiao-rejection-bid-document---'));
  assert.ok(signature.includes('---yibiao-rejection-check-input---'));

  const single = createRejectionCheckInputSignature(doc, '解析结果', '');
  assert.equal(single, createRejectionCheckInputSignature([doc], '解析结果', ''));
});

test('getTechnicalPlanDiscardedBids 只在成功且有内容时取值，并剥三引号', () => {
  const plan = (status, content) => ({ bidAnalysisTasks: { discardedBids: { status, content } } });
  assert.equal(getTechnicalPlanDiscardedBids(plan('success', "'''废标内容'''")), '废标内容');
  assert.equal(getTechnicalPlanDiscardedBids(plan('success', '   ')), '');
  assert.equal(getTechnicalPlanDiscardedBids(plan('running', '内容')), '');
  assert.equal(getTechnicalPlanDiscardedBids(undefined), '');
});

test('appendImportFailureParts 只在有失败项时追加信息', () => {
  const none = [];
  appendImportFailureParts(none, []);
  assert.deepEqual(none, []);
  appendImportFailureParts(none, ['  ', null]);
  assert.deepEqual(none, []);

  const parts = [];
  appendImportFailureParts(parts, ['文件A损坏', '文件B损坏']);
  assert.deepEqual(parts, ['失败 2 份', '文件A损坏；文件B损坏']);
});
