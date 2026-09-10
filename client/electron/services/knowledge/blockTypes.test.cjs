const test = require('node:test');
const assert = require('node:assert/strict');

const B = require('./blockTypes.cjs');

test('isPageNumberBlock 识别页码/第N页/N-M/Page N 写法', () => {
  assert.equal(B.isPageNumberBlock('- 12 -'), true);
  assert.equal(B.isPageNumberBlock('第3页'), true);
  assert.equal(B.isPageNumberBlock('第 3 页 共 10 页'), true);
  assert.equal(B.isPageNumberBlock('3/10'), true);
  assert.equal(B.isPageNumberBlock('Page 2 of 5'), true);
  assert.equal(B.isPageNumberBlock('正文内容'), false);
});

test('isCatalogBlock 认标题词，也认 60% 行带点线页码的正文', () => {
  assert.equal(B.isCatalogBlock('目录'), true);
  assert.equal(B.isCatalogBlock('## 目次'), true);
  assert.equal(B.isCatalogBlock('Contents'), true);
  assert.equal(B.isCatalogBlock('第一章 总则 .......... 1\n第二章 投标人 ....... 5\n第三章 评标办法 ..... 9\n正文开始'), true);
  assert.equal(B.isCatalogBlock('第一章 总则\n第二章 投标人\n第三章 评标办法'), false);
  assert.equal(B.isCatalogBlock('普通段落'), false);
});

test('isCoverBlock 只认前 13 个块、有封面标记且无长句', () => {
  assert.equal(B.isCoverBlock('投标文件\n项目名称：某项目', 0), true);
  assert.equal(B.isCoverBlock('投标文件\n项目名称：某项目', 20), false);
  assert.equal(B.isCoverBlock('投标文件。' + '正文内容'.repeat(30) + '。', 0), false);
  assert.equal(B.isCoverBlock('这是一段普通正文。', 0), false);
});

test('isSignatureBlock 认签章类短块，排除签字确认与长句', () => {
  assert.equal(B.isSignatureBlock('投标人（盖章）：'), true);
  assert.equal(B.isSignatureBlock('法定代表人（签字）：'), true);
  assert.equal(B.isSignatureBlock('用户签字确认'), false);
  assert.equal(B.isSignatureBlock('盖章。' + '后续说明内容'.repeat(10) + '。'), false);
});

test('isTableBlock 只认 HTML 表格块', () => {
  assert.equal(B.isTableBlock({ content: '<table><tr><td>a</td></tr></table>' }), true);
  assert.equal(B.isTableBlock({ content: '| a | b |' }), false);
  assert.equal(B.isTableBlock({}), false);
});
