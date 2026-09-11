const test = require('node:test');
const assert = require('node:assert/strict');
const { __test__ } = require('./rejectionCheckTask.cjs');

const {
  applyRollingRejectionPatch,
  createEmptyRollingRejectionState,
  createVerifiedTypoExcerpt,
  dedupeItems,
  findVerifiedTypoPosition,
  formatBidDocumentIdList,
  formatBidDocumentsForPrompt,
  getArrayPayload,
  getBidDocumentDisplayName,
  getBidDocumentIdFromItem,
  getPackageBidDocumentId,
  limitDedupeItems,
  normalizeFindingType,
  normalizeLogicCheckFindings,
  normalizeRejectionCheckFindings,
  normalizeRollingRejectionPatch,
  normalizeSeverity,
  normalizeText,
  normalizeTypoCheckFindings,
  stripTripleQuoteWrapper,
} = __test__;

const bidDoc = (id, content = '正文内容', fileName = `${id}.md`) => ({ id, fileName, content, source: 'upload' });

test('stripTripleQuoteWrapper / normalizeText 的基础行为', () => {
  assert.equal(stripTripleQuoteWrapper("'''内容'''"), '内容');
  assert.equal(stripTripleQuoteWrapper('普通'), '普通');
  assert.equal(stripTripleQuoteWrapper(undefined), '');
  assert.equal(normalizeText('  a  '), 'a');
  assert.equal(normalizeText(undefined), '');
  // 注意：实现是 String(value || '')，数字 0 会被当成空值——沿用既有行为（用例把这层语义钉住）。
  assert.equal(normalizeText(0), '');
});

test('getBidDocumentIdFromItem 按候选字段顺序命中，单文档时兜底', () => {
  const ids = new Set(['doc-1', 'doc-2']);
  assert.equal(getBidDocumentIdFromItem({ bidDocumentId: 'doc-2' }, ids), 'doc-2');
  assert.equal(getBidDocumentIdFromItem({ bid_document_id: 'doc-1' }, ids), 'doc-1');
  assert.equal(getBidDocumentIdFromItem({ documentId: 'doc-2' }, ids), 'doc-2');
  assert.equal(getBidDocumentIdFromItem({ sourceFile: 'doc-1' }, ids), 'doc-1');
  assert.equal(getBidDocumentIdFromItem({ bidDocumentId: 'doc-2', documentId: 'doc-1' }, ids), 'doc-2', '先命中 bidDocumentId');
  assert.equal(getBidDocumentIdFromItem({}, ids), '', '多文档且没线索时不给兜底');
  assert.equal(getBidDocumentIdFromItem({}, new Set(['only'])), 'only', '单文档时兜底到唯一文档');
});

test('getArrayPayload 支持数组直传与多个别名字段', () => {
  assert.deepEqual(getArrayPayload([1, 2], ['findings']), [1, 2]);
  assert.deepEqual(getArrayPayload({ findings: [3] }, ['findings', 'items']), [3]);
  assert.deepEqual(getArrayPayload({ items: [4] }, ['findings', 'items']), [4]);
  assert.deepEqual(getArrayPayload({ other: 1 }, ['findings']), []);
  assert.deepEqual(getArrayPayload(null, ['findings']), []);
  assert.deepEqual(getArrayPayload('文本', ['findings']), []);
});

test('normalizeFindingType / normalizeSeverity 的中英文映射', () => {
  assert.equal(normalizeFindingType('invalidBid'), 'invalidBid');
  assert.equal(normalizeFindingType('无效投标'), 'invalidBid');
  assert.equal(normalizeFindingType('其他'), 'rejectionItem');
  assert.equal(normalizeFindingType(undefined), 'rejectionItem');

  assert.equal(normalizeSeverity('high'), 'high');
  assert.equal(normalizeSeverity('HIGH'), 'high');
  assert.equal(normalizeSeverity('高风险'), 'high');
  assert.equal(normalizeSeverity('低'), 'low');
  assert.equal(normalizeSeverity('medium'), 'medium');
  assert.equal(normalizeSeverity(undefined), 'medium');
});

test('投标文件展示名与 id 清单', () => {
  assert.equal(getBidDocumentDisplayName({ fileName: 'a.md' }, 0), '投标文件1（a.md）');
  assert.equal(getBidDocumentDisplayName({}, 1), '投标文件2');
  assert.equal(
    formatBidDocumentIdList([bidDoc('doc-1', '', 'a.md'), { id: 'doc-2' }]),
    '- 投标文件1（a.md）：doc-1\n- 投标文件2：doc-2',
  );
  assert.equal(formatBidDocumentIdList(undefined), '');
});

test('formatBidDocumentsForPrompt 拼出带 id 与文件名的段落', () => {
  const text = formatBidDocumentsForPrompt({ bidDocuments: [bidDoc('doc-1', '甲内容'), bidDoc('doc-2', '乙内容')] });
  assert.ok(text.includes('【投标文件1｜bidDocumentId：doc-1｜文件名：doc-1.md】'));
  assert.ok(text.includes('甲内容'));
  assert.ok(text.includes('--- 投标文件分隔线 ---'));
  assert.equal(formatBidDocumentsForPrompt({}), '');
});

test('normalizeRejectionCheckFindings：补默认值、解析 id、丢弃不完整项', () => {
  const documents = [bidDoc('doc-1'), bidDoc('doc-2')];
  const findings = normalizeRejectionCheckFindings({
    findings: [
      {
        bidDocumentId: 'doc-1',
        type: '无效投标',
        severity: '高',
        title: '  未提供营业执照  ',
        evidence: '投标文件第 3 页未附营业执照',
        reason: '招标文件要求提供营业执照',
      },
      { bidDocumentId: 'doc-2', title: '缺证据', riskReason: '理由' },
      { bidDocumentId: 'doc-2', title: '缺理由', bidEvidence: '证据' },
      null,
    ],
  }, documents);

  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.bidDocumentId, 'doc-1');
  assert.equal(finding.type, 'invalidBid');
  assert.equal(finding.severity, 'high');
  assert.equal(finding.title, '未提供营业执照');
  assert.equal(finding.summary, '未提供营业执照', 'summary 缺省时回落到 title');
  assert.equal(finding.requirement, '未明确引用具体检查依据，请人工复核。');
  assert.equal(finding.suggestion, '请结合招标文件要求和投标文件原文人工复核后处理。');
  assert.ok(finding.id.startsWith('rejection_finding_'));
});

test('findVerifiedTypoPosition：整文、片段、摘录内定位与找不到', () => {
  const content = '第一段。甲方应当提供有效证明材料。第二段。';
  assert.equal(findVerifiedTypoPosition(content, '证明材料', ''), content.indexOf('证明材料'));
  assert.equal(findVerifiedTypoPosition(content, '不存在', ''), -1);

  const excerpt = '甲方应当提供有效证明材料。';
  assert.equal(
    findVerifiedTypoPosition(content, '证明', excerpt),
    content.indexOf(excerpt) + excerpt.indexOf('证明'),
    '优先按摘录定位',
  );

  const segmentStart = content.indexOf('甲方');
  const segmentEnd = content.length;
  assert.equal(
    findVerifiedTypoPosition(content, '乙方', '', { segmentStartOffset: segmentStart, segmentEndOffset: segmentEnd }),
    -1,
    '片段模式只在片段内查找',
  );
  assert.equal(
    findVerifiedTypoPosition(content, '证明', '', { segmentStartOffset: segmentStart, segmentEndOffset: segmentEnd }),
    content.indexOf('证明'),
  );
});

test('createVerifiedTypoExcerpt 取上下文并避免截断 HTML 标签', () => {
  const content = '甲'.repeat(20) + '错字' + '乙'.repeat(20);
  const excerpt = createVerifiedTypoExcerpt(content, 20, '错字');
  assert.ok(excerpt.includes('错字'));
  assert.ok(excerpt.length <= 20);

  const html = '<p>前缀文本标签包裹的错误词后缀</p>';
  const wrongIndex = html.indexOf('错误词');
  const htmlExcerpt = createVerifiedTypoExcerpt(html, wrongIndex, '错误词');
  assert.ok(htmlExcerpt.includes('错误词'));
  assert.ok(!/<[^>]*$/.test(htmlExcerpt), '不要把开标签切一半');
});

test('normalizeTypoCheckFindings：同位置同词去重、错别字与正确词相同则丢弃', () => {
  const document = bidDoc('doc-1', '本公司提供建筑工程施工总承包一级资质。');
  const findings = normalizeTypoCheckFindings({
    typos: [
      { bidDocumentId: 'doc-1', wrongText: '施工总承包', correctText: '施工总承包壹级', reason: '资质写法' },
      { bidDocumentId: 'doc-1', wrongText: '施工总承包', correctText: '施工总承包壹级', reason: '资质写法' },
      { bidDocumentId: 'doc-1', wrongText: '一样', correctText: '一样' },
      { bidDocumentId: 'doc-1', wrongText: '找不到', correctText: '找不到二' },
    ],
  }, [document]);

  // wrongText 与 correctText 相同、以及原文找不到的都会被丢弃；剩下的那条是有效项且会去重。
  assert.equal(findings.length, 1);
  assert.equal(findings[0].wrongText, '施工总承包');

  const verified = normalizeTypoCheckFindings({
    findings: [{ bidDocumentId: 'doc-1', wrongText: '建筑工成', correctText: '建筑工程', reason: '别字' }],
  }, [bidDoc('doc-1', '本公司提供建筑工成施工总承包一级资质。')]);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].bidDocumentId, 'doc-1');
  assert.ok(verified[0].position >= 0);
  assert.ok(verified[0].locationHint.includes('行'));
});

test('normalizeLogicCheckFindings：缺关键字段丢弃，重复项合并', () => {
  const documents = [bidDoc('doc-1')];
  const findings = normalizeLogicCheckFindings({
    issues: [
      { bidDocumentId: 'doc-1', title: '工期前后矛盾', fallacyReason: '正文写 30 天，承诺函写 45 天' },
      { bidDocumentId: 'doc-1', title: '工期前后矛盾', fallacyReason: '正文写 30 天，承诺函写 45 天' },
      { bidDocumentId: 'doc-1', title: '缺理由' },
    ],
  }, documents);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, '工期前后矛盾');
  assert.equal(findings[0].originalText, '未提供明确原文摘录，请结合位置线索复核。');
  assert.equal(findings[0].locationHint, '未明确具体位置，请结合原文摘录复核。');
  assert.equal(findings[0].suggestion, '请结合投标文件上下文人工复核后修改。');
});

test('limitDedupeItems / dedupeItems 去重并保序', () => {
  const items = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'a', v: 3 }, null];
  assert.deepEqual(dedupeItems(items, (item) => item.id).map((item) => item.v), [1, 2]);
  assert.deepEqual(limitDedupeItems(items, 1, (item) => item.id).map((item) => item.v), [1]);
});

test('normalizeRollingRejectionPatch 认别名字段并过滤空项', () => {
  const documents = [bidDoc('doc-1')];
  const patch = normalizeRollingRejectionPatch({
    evidence_adds: [{ bid_document_id: 'doc-1', name: '营业执照', evidence: '附有营业执照扫描件' }, {}],
    pending_risk_adds: [{ bidDocumentId: 'doc-1', title: '资质过期' }, { bidDocumentId: 'doc-1' }],
    pending_risk_resolves: [{ id: 'risk_1', title: '已澄清', reason: '后续片段说明' }, {}],
    confirmed_risk_adds: [{
      bidDocumentId: 'doc-1',
      title: '未提供安全生产许可证',
      bidEvidence: '未见许可证',
      riskReason: '招标文件要求提供',
    }],
  }, documents);

  assert.equal(patch.evidenceAdds.length, 1);
  assert.equal(patch.evidenceAdds[0].bidDocumentId, 'doc-1');
  assert.equal(patch.pendingRiskAdds.length, 1);
  assert.equal(patch.pendingRiskAdds[0].title, '资质过期');
  assert.equal(patch.pendingRiskResolves.length, 1);
  assert.equal(patch.pendingRiskResolves[0].id, 'risk_1');
  assert.equal(patch.confirmedRiskAdds.length, 1);
  assert.equal(patch.confirmedRiskAdds[0].severity, 'medium', '未给等级时默认 medium');
});

test('applyRollingRejectionPatch：去重入队、按 id 更新、解析把风险移到已排除', () => {
  let state = createEmptyRollingRejectionState();
  state = applyRollingRejectionPatch(state, {
    evidenceAdds: [{ bidDocumentId: 'doc-1', name: '营业执照', evidence: '附有营业执照' }],
    pendingRiskAdds: [{
      bidDocumentId: 'doc-1',
      type: 'rejectionItem',
      severity: 'high',
      title: '资质过期',
      requirement: '招标文件要求资质在有效期内',
    }],
  });

  assert.equal(state.submittedEvidence.length, 1);
  assert.ok(state.submittedEvidence[0].id.startsWith('evidence_'));
  assert.equal(state.pendingRisks.length, 1);
  const riskId = state.pendingRisks[0].id;
  assert.ok(riskId.startsWith('risk_'));

  // 同一份证据与同一条风险重复提交不入队。
  state = applyRollingRejectionPatch(state, {
    evidenceAdds: [{ bidDocumentId: 'doc-1', name: '营业执照', evidence: '附有营业执照' }],
    pendingRiskAdds: [{
      bidDocumentId: 'doc-1',
      type: 'rejectionItem',
      severity: 'high',
      title: '资质过期',
      requirement: '招标文件要求资质在有效期内',
    }],
  });
  assert.equal(state.submittedEvidence.length, 1);
  assert.equal(state.pendingRisks.length, 1);

  // 更新：只覆盖给出的字段。
  state = applyRollingRejectionPatch(state, {
    pendingRiskUpdates: [{ id: riskId, severity: 'low', summary: '补充说明' }],
  });
  assert.equal(state.pendingRisks[0].severity, 'low');
  assert.equal(state.pendingRisks[0].summary, '补充说明');
  assert.equal(state.pendingRisks[0].title, '资质过期');

  // 解析：从待确认移到已排除。
  state = applyRollingRejectionPatch(state, {
    pendingRiskResolves: [{ id: riskId, title: '资质在附页', reason: '后续片段给出有效期' }],
  });
  assert.equal(state.pendingRisks.length, 0);
  assert.equal(state.resolvedRisks.length, 1);
  assert.equal(state.resolvedRisks[0].riskId, riskId);
  assert.equal(state.resolvedRisks[0].title, '资质在附页');

  // 确认风险：进 confirmedRisks 并同样带 id。
  state = applyRollingRejectionPatch(state, {
    confirmedRiskAdds: [{
      bidDocumentId: 'doc-1',
      type: 'rejectionItem',
      severity: 'high',
      title: '未提供安全生产许可证',
      bidEvidence: '未见许可证',
      riskReason: '招标文件要求提供',
    }],
  });
  assert.equal(state.confirmedRisks.length, 1);
  assert.ok(state.confirmedRisks[0].id.startsWith('risk_'));
});

test('getPackageBidDocumentId 优先用条目线索，其次用兜底文档', () => {
  const documents = [bidDoc('doc-1'), bidDoc('doc-2')];
  assert.equal(getPackageBidDocumentId({ bidDocumentId: 'doc-2' }, documents), 'doc-2');
  assert.equal(getPackageBidDocumentId({}, documents, 'doc-1'), 'doc-1');
  assert.equal(getPackageBidDocumentId({}, documents, '不存在'), '');
});
