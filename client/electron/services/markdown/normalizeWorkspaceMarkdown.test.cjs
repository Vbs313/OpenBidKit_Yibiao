const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeWorkspaceMarkdown,
  convertHtmlTablesToGfm,
  dropPageMarkerLines,
  countGfmTableRows,
  countHtmlTableMarkers,
} = require('./normalizeWorkspaceMarkdown.cjs');

test('HTML table becomes GFM pipe table', () => {
  const input = [
    'intro',
    '',
    '<table><tr><th>factor</th><th>score</th></tr><tr><td>tech</td><td>55</td></tr></table>',
    '',
    'outro',
  ].join('\n');
  const { markdown, metrics } = normalizeWorkspaceMarkdown(input);
  assert.match(markdown, /\|factor\|score\|/);
  assert.match(markdown, /\|---\|---\|/);
  assert.match(markdown, /\|tech\|55\|/);
  assert.equal(metrics.htmlTableMarkers, 0);
  assert.ok(metrics.gfmTableRows >= 3);
  assert.ok(markdown.includes('intro'));
  assert.ok(markdown.includes('outro'));
});

test('cell br entities pipe and colspan', () => {
  const input = '<table><tr><td colspan="2">A<br>B &amp; C</td><td>D|E</td></tr></table>';
  const gfm = convertHtmlTablesToGfm(input);
  assert.match(gfm, /\|A B & C\|/);
  assert.match(gfm, /D\\|E/);
});

test('strip control chars and page markers keep tab newline', () => {
  const withCnMarkers = [
    `title${String.fromCharCode(1)}left`,
    '##### 第 12 页',
    '第 3 页 / 共 40 页',
    'body\tcol',
  ].join('\n');
  const { markdown, metrics } = normalizeWorkspaceMarkdown(withCnMarkers);
  assert.ok(!markdown.includes(String.fromCharCode(1)));
  assert.ok(!markdown.includes('page 12'.replace('page', '第 ').replace(' 12', ' 12 页').slice(0, 0) + '第 12 页'));
  assert.ok(!markdown.includes('第 3 页'));
  assert.ok(markdown.includes('title left'));
  assert.ok(markdown.includes('body\tcol'));
  assert.equal(metrics.controlCharsReplaced, 1);
  assert.equal(metrics.pageMarkersRemoved, 2);
});

test('mineru style GFM tables stay intact', () => {
  const input = [
    '# project',
    '',
    '| item | value |',
    '| --- | --- |',
    '| days | 90 |',
  ].join('\n');
  const { markdown } = normalizeWorkspaceMarkdown(input);
  assert.ok(markdown.includes('| item | value |'));
  assert.ok(markdown.includes('| days | 90 |'));
  assert.equal(countHtmlTableMarkers(markdown), 0);
  assert.equal(countGfmTableRows(markdown), 3);
});

test('empty and blank input', () => {
  assert.equal(normalizeWorkspaceMarkdown('').markdown, '');
  assert.equal(normalizeWorkspaceMarkdown(null).markdown, '');
});

test('collapse extra blank lines', () => {
  const { markdown } = normalizeWorkspaceMarkdown('A\n\n\n\nB');
  assert.equal(markdown.trim(), 'A\n\nB');
});

test('dropPageMarkerLines only removes matching lines', () => {
  const text = dropPageMarkerLines('page1\nkeep\n### 第 2 页/共 9 页\nend');
  assert.equal(text, 'page1\nkeep\nend');
});
