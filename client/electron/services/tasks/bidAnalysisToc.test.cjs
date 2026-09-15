const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTenderToc, buildTaskExcerpt } = require('./bidAnalysisToc.cjs');

function buildFakeTender() {
  const chapters = [
    ['第一章 招标公告', '项目名称：数据平台建设。项目编号：CG-2026-001。预算 580 万元。地址本市。'.repeat(120)],
    ['第二章 投标人须知', '投标人应仔细阅读本须知前附表与正文。'.repeat(120)],
    ['第三章 评标办法', '技术评分因素包括实施方案、服务保障、人员配置。评分标准详见下表。技术部分评审 55 分。技术要求响应程度。'.repeat(120)],
    ['第四章 合同条款', '中标人应在公示后 30 日内签订合同。违约责任与争议解决适用中国法律。'.repeat(120)],
    ['第五章 投标文件格式', '投标文件应包含商务文件、技术文件、资格证明、报价文件。签字盖章与密封要求如下。'.repeat(120)],
    ['第六章 采购需求与技术要求', '采购清单包含设备与服务。技术参数、规格要求、验收标准、质保期 3 年。售后响应 2 小时。'.repeat(120)],
    ['第七章 无效投标与废标', '未按规定密封、逾期送达、资格不符的投标无效。有效投标人不足三家应废标。否决投标情形包括重大偏差。'.repeat(120)],
  ];
  const parts = ['# 招标文件', '', '目录', ''];
  for (const [title, body] of chapters) {
    parts.push(`## ${title}`, '', body, '');
  }
  return parts.join('\n');
}

test('parseTenderToc finds numbered/atx chapters', () => {
  const toc = parseTenderToc(buildFakeTender());
  assert.ok(toc.length >= 6);
  assert.ok(toc.some((c) => c.title.includes('评标办法')));
});

test('techRequirements routes to scoring chapters not full doc', () => {
  const md = buildFakeTender();
  const result = buildTaskExcerpt(md, 'techRequirements');
  assert.equal(result.directed, true, result.reason);
  assert.ok(result.selectedTitles.some((t) => t.includes('评标') || t.includes('技术')));
  assert.ok(result.selectedTitles.length < result.chapterCount);
  assert.ok(result.content.length < md.length * 0.9);
});

test('discardedBids prefers invalid-bid chapter', () => {
  const md = buildFakeTender();
  const result = buildTaskExcerpt(md, 'discardedBids');
  assert.equal(result.directed, true, result.reason);
  assert.ok(result.selectedTitles.some((t) => t.includes('无效') || t.includes('废标')));
  assert.ok(result.selectedTitles.length <= 3);
});

test('weak TOC falls back to full document', () => {
  const md = '短文档无章节结构\n'.repeat(100);
  const result = buildTaskExcerpt(md, 'techRequirements');
  assert.equal(result.directed, false);
  assert.equal(result.reason, 'toc_too_weak');
  assert.equal(result.content, md);
});

test('no keyword hit falls back to full', () => {
  const md = buildFakeTender().replace(/保证金/g, '担保金');
  const result = buildTaskExcerpt(md, 'marginInfo');
  assert.equal(result.directed, false);
  assert.equal(result.reason, 'no_hit');
});
