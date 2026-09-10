const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('./agentRestore.cjs');
const { textHash } = require('./textEdits.cjs');

test('splitOriginalPlanSegments 按 Markdown 标题切段并带标题路径', () => {
  const segments = A.splitOriginalPlanSegments('# 第一章\n正文A\n## 第一节\n正文B');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].id, 'P001');
  assert.deepEqual(segments[0].title_path, ['第一章']);
  assert.equal(segments[0].content, '# 第一章\n正文A');
  assert.equal(segments[0].chars, 9);
  assert.equal(segments[0].hash, textHash('# 第一章\n正文A'));
  assert.equal(segments[1].id, 'P002');
  assert.deepEqual(segments[1].title_path, ['第一章', '第一节']);
  assert.equal(segments[1].content, '## 第一节\n正文B');
});

test('splitOriginalPlanSegments 对无标题文本退化成单段', () => {
  const segments = A.splitOriginalPlanSegments('只有一段没有标题的原文。');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].id, 'P001');
  assert.deepEqual(segments[0].title_path, []);
  assert.equal(segments[0].content, '只有一段没有标题的原文。');
});

test('splitOriginalPlanSegments 把超长原方案按 6000 字上限拆开', () => {
  const big = Array.from({ length: 400 }, (_, i) => ('第' + i + '段 ' + '技术描述'.repeat(20))).join('\n\n');
  const segments = A.splitOriginalPlanSegments(big);
  assert.ok(segments.length > 1, '超长原文应拆成多段，实际 ' + segments.length);
  assert.equal(segments[0].id, 'P001');
  assert.equal(segments[1].id, 'P002');
  for (const segment of segments) {
    assert.ok(segment.chars <= 6000, '每段应不超过 6000 字，实际 ' + segment.chars);
    assert.ok(segment.chars > 0);
    assert.equal(segment.hash, textHash(segment.content));
  }
});

test('splitOriginalPlanSegments 丢弃纯空白内容', () => {
  assert.deepEqual(A.splitOriginalPlanSegments('   \n\n  '), []);
  assert.deepEqual(A.splitOriginalPlanSegments(''), []);
});

test('buildAgentOriginalMaterialRestorePrompt 指向唯一输出文件与 assignments 结构', () => {
  const prompt = A.buildAgentOriginalMaterialRestorePrompt();
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.includes('original-restore-result.json'));
  assert.ok(prompt.includes('"assignments"'));
  assert.ok(prompt.includes('restore-targets.md'));
  assert.ok(prompt.includes('original-segments.md'));
  assert.ok(prompt.includes('严禁改写'));
});

test('buildAgentOriginalMaterialRestoreFiles 产出三份 workspace 文件', () => {
  const files = A.buildAgentOriginalMaterialRestoreFiles({
    targets: [{ item: { id: '1.1', title: 'T' }, parentChapters: [{ id: '1', title: 'P' }], siblingChapters: [] }],
    originalSegments: [{ id: 'P001', content: 'X', chars: 1 }],
    projectOverview: 'OV',
    bidAnalysisFactsText: 'FACTS',
    globalFactTitlesText: 'TITLES',
  });
  assert.deepEqual(files.map((f) => f.path), ['context.md', 'restore-targets.md', 'original-segments.md']);
  assert.ok(files[0].content.includes('OV'));
  assert.ok(files[0].content.includes('FACTS'));
  assert.ok(files[0].content.includes('TITLES'));
  assert.ok(files[1].content.includes('node_id: 1.1'));
  assert.ok(files[2].content.includes('id="P001"'));
  assert.ok(files[2].content.includes('X'));
});

test('buildAgentOriginalMaterialRestoreFiles 在标题清单缺失时给占位', () => {
  const files = A.buildAgentOriginalMaterialRestoreFiles({ targets: [], originalSegments: [], projectOverview: '', bidAnalysisFactsText: '' });
  assert.ok(files[0].content.includes('未提供'));
  assert.ok(files[1].content.includes('无'));
});

test('buildAgentRestoredChapterContentPrompt 按全局事实模式追加补全规则', () => {
  const omit = A.buildAgentRestoredChapterContentPrompt('omit');
  assert.ok(omit.includes('optimized-section.md'));
  assert.ok(omit.includes('事实补全规则（别招欠模式）'));
  const placeholder = A.buildAgentRestoredChapterContentPrompt('placeholder');
  assert.ok(placeholder.includes('事实补全规则（放着我来模式）'));
  const none = A.buildAgentRestoredChapterContentPrompt();
  assert.ok(!none.includes('事实补全规则'));
});

test('buildAgentRestoredChapterContentFiles 产出章节上下文、底稿与素材三件套', () => {
  const wordControl = { sectionWords: 3000, strictSectionWords: false, sectionMinimumWords: 2000, sectionMaximumWords: 4000 };
  const files = A.buildAgentRestoredChapterContentFiles({
    chapter: { id: '2.1', title: '标题' },
    projectOverview: 'OV',
    selectedFactsText: 'SF',
    regenerateRequirement: '',
    contentPlan: null,
    knowledgeContents: [],
    restoredContent: '底稿',
    wordControl,
    generationTarget: 0,
  });
  assert.deepEqual(files.map((f) => f.path), ['chapter-context.md', 'restored-content.md', 'knowledge-contents.md']);
  assert.ok(files[0].content.includes('章节ID: 2.1'));
  assert.ok(files[0].content.includes('章节标题: 标题'));
  assert.ok(files[0].content.includes('OV'));
  assert.ok(files[0].content.includes('SF'));
  assert.ok(files[0].content.includes('本小节建议字数 2000 至 4000 字'));
  assert.equal(files[1].content, '底稿');
  assert.equal(files[2].content, '无');
});

test('buildAgentRestoredChapterContentFiles 关掉字数控制时不输出字数目标', () => {
  const files = A.buildAgentRestoredChapterContentFiles({ chapter: { id: '2.2' }, wordControl: { sectionWords: 0 }, knowledgeContents: [] });
  assert.ok(files[0].content.includes('不控制小节字数'));
  assert.equal(files[2].content, '无');
});

test('parseAgentJsonContent 依次尝试裸 JSON、围栏 JSON 与文中 JSON', () => {
  assert.deepEqual(A.parseAgentJsonContent('{"a":1}'), { a: 1 });
  assert.deepEqual(A.parseAgentJsonContent('\uFEFF{"c":3}'), { c: 3 });
  assert.deepEqual(A.parseAgentJsonContent('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(A.parseAgentJsonContent('前言\n{"b":2}\n后记'), { b: 2 });
  assert.throws(() => A.parseAgentJsonContent('not json'), /未返回可解析的 JSON/);
  assert.throws(() => A.parseAgentJsonContent(''), /未返回可解析的 JSON/);
});

test('escapeSectionAttribute 转义小节标记属性', () => {
  assert.equal(A.escapeSectionAttribute('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  assert.equal(A.escapeSectionAttribute(null), '');
  assert.equal(A.escapeSectionAttribute(123), '123');
});

test('parseAgentSectionMarkdown 解析小节标记并保留正文', () => {
  const markdown = '<!-- yibiao-section-start id="1.1" -->\n正文\n<!-- yibiao-section-end id="1.1" -->';
  const sections = A.parseAgentSectionMarkdown(markdown);
  assert.equal(sections.size, 1);
  assert.equal(sections.get('1.1'), '正文');
});

test('parseAgentSectionMarkdown 支持多小节并忽略标记之外的内容', () => {
  const markdown = [
    '前言（应被忽略）',
    '<!-- yibiao-section-start id="a" -->',
    'A 正文',
    '<!-- yibiao-section-end id="a" -->',
    '中间',
    '<!-- yibiao-section-start id="b" -->',
    'B 正文',
    '<!-- yibiao-section-end id="b" -->',
  ].join('\n');
  const sections = A.parseAgentSectionMarkdown(markdown);
  assert.deepEqual([...sections.keys()], ['a', 'b']);
  assert.equal(sections.get('a'), 'A 正文');
  assert.equal(sections.get('b'), 'B 正文');
});

test('parseAgentSectionMarkdown 对嵌套、未配对、不匹配、重复与未闭合报错', () => {
  assert.throws(() => A.parseAgentSectionMarkdown('<!-- yibiao-section-start id="a" -->\n<!-- yibiao-section-start id="b" -->'), /嵌套/);
  assert.throws(() => A.parseAgentSectionMarkdown('<!-- yibiao-section-end id="a" -->'), /未配对/);
  assert.throws(() => A.parseAgentSectionMarkdown('<!-- yibiao-section-start id="a" -->\n<!-- yibiao-section-end id="b" -->'), /不匹配/);
  assert.throws(
    () => A.parseAgentSectionMarkdown('<!-- yibiao-section-start id="a" -->\n<!-- yibiao-section-end id="a" -->\n<!-- yibiao-section-start id="a" -->\n<!-- yibiao-section-end id="a" -->'),
    /重复小节/,
  );
  assert.throws(() => A.parseAgentSectionMarkdown('<!-- yibiao-section-start id="a" -->\n正文'), /未闭合/);
});