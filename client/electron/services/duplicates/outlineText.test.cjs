const test = require('node:test');
const assert = require('node:assert/strict');

const O = require('./outlineText.cjs');

test('cleanOutlineTitle 去掉标题记号、目录点和页码', () => {
  assert.equal(O.cleanOutlineTitle('# 项目概述'), '项目概述');
  assert.equal(O.cleanOutlineTitle('## 1.1 项目概述 .......... 12'), '1.1 项目概述');
  assert.equal(O.cleanOutlineTitle('- 服务承诺'), '服务承诺');
  assert.equal(O.cleanOutlineTitle('   '), '');
});

test('parseOutlineMarker 识别数字与中文编号', () => {
  const numbered = O.parseOutlineMarker('1.1 项目概述');
  assert.deepEqual(numbered, { number: '1.1', title: '项目概述', level: 2 });
  const chapter = O.parseOutlineMarker('第一章 总则');
  assert.equal(chapter.number, '第一章');
  assert.equal(chapter.title, '总则');
  // 带圈编号在清理阶段会被归一成阿拉伯数字
  const circled = O.parseOutlineMarker('① 需求理解');
  assert.equal(circled.number, '1');
  assert.equal(circled.title, '需求理解');
  const cnList = O.parseOutlineMarker('三、技术路线');
  assert.equal(cnList.number, '三、');
  assert.equal(cnList.title, '技术路线');
});

test('parseOutlineMarker 对无编号正文返回 null', () => {
  assert.equal(O.parseOutlineMarker('本项目采用先进技术方案，确保按期交付。'), null);
  assert.equal(O.parseOutlineMarker(''), null);
});

test('splitContentSentences 切成可比较句子并去掉条目', () => {
  const sentences = O.splitContentSentences([
    '# 标题',
    '',
    '第一句说明系统总体架构与部署方式。',
    '',
    '第二句说明项目实施周期与验收标准。',
  ].join('\n'));
  assert.ok(sentences.length >= 2);
  assert.ok(sentences.every((entry) => typeof entry.sentence === 'string' && typeof entry.normalized === 'string'));
  assert.ok(sentences.some((entry) => entry.normalized.includes('总体架构')));
  assert.ok(sentences.some((entry) => entry.normalized.includes('验收标准')));
});

test('splitContentSentences 忽略空内容', () => {
  assert.deepEqual(O.splitContentSentences(''), []);
  assert.deepEqual(O.splitContentSentences('\n\n  \n'), []);
});

test('buildRows 汇总各文件元数据并标出重复值', () => {
  const rows = O.buildRows([
    {
      file_id: 'F1',
      metadata: [
        { key: 'author', label: '作者', value: '张三', comparable: true, normalized: '张三', date_comparable: false },
        { key: 'created_at', label: '创建时间', value: '2026-01-01T00:00:00Z', normalized: '2026-01-01', comparable: true, date_comparable: true, date_day: '2026-01-01' },
      ],
    },
    {
      file_id: 'F2',
      metadata: [
        { key: 'author', label: '作者', value: '张三', comparable: true, normalized: '张三', date_comparable: false },
        { key: 'created_at', label: '创建时间', value: '2026-01-01T08:00:00Z', normalized: '2026-01-01', comparable: true, date_comparable: true, date_day: '2026-01-01' },
      ],
    },
  ]);
  const author = rows.find((row) => row.key === 'author');
  assert.deepEqual(author.values, { F1: '张三', F2: '张三' });
  assert.deepEqual(author.duplicate_file_ids.sort(), ['F1', 'F2']);
  assert.deepEqual(author.same_day_file_ids, []);
  const created = rows.find((row) => row.key === 'created_at');
  assert.deepEqual(created.same_day_file_ids.sort(), ['F1', 'F2']);
  assert.deepEqual(created.duplicate_file_ids, []);
});

test('buildRows 不把单一文件的取值算作重复', () => {
  const rows = O.buildRows([
    { file_id: 'F1', metadata: [{ key: 'title', label: '标题', value: '方案', comparable: true, normalized: '方案' }] },
  ]);
  assert.deepEqual(rows[0].duplicate_file_ids, []);
});
